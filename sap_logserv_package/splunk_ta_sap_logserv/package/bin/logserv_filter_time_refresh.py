"""
SAP LogServ TA - Time Filter Cutoff Refresh (Scripted Input)

The time-based filter uses a pre-computed epoch regex in transforms.conf to
drop events older than N days.  Because the cutoff is a static regex (not a
dynamic expression like INGEST_EVAL), it must be refreshed periodically to
keep the rolling window accurate.

This scripted input runs once per day.  On each run it:

1. Reads the current filter settings (filter_enabled, include_filters,
   exclude_filters, include_sources, exclude_sources, days_in_past) from the
   TA's settings conf.  Every one of them must be passed on: the refresh
   rewrites the WHOLE generated filter block, so a setting it did not read
   would silently disappear from the configuration within a day.
2. If time-based filtering is active (days_in_past > 0), regenerates
   local/transforms.conf and local/props.conf with an updated epoch cutoff.
   Days in the Past is read with the same parser the Filters save uses
   (parse_days_in_past: '7', '7.0' and '1e1' are whole numbers), so every
   value a save turned into a time filter is refreshed here too.
   If a stored value is invalid (for example a hand-edited conf), the
   generators refuse it: an ERROR naming the field is logged and the local
   confs are NOT rewritten - the last good block stays in place.
3. On a deployment server, mirrors the regenerated files to deployment-apps/
   and reloads the SAP_LogServ_HeavyForwarders server class, so its
   forwarders download the new cutoff (reload_serverclass).  The reload is
   sent in the namespace of the app that owns the class - its acl.app, read
   first - then in /servicesNS/nobody/search and /services if that fails;
   the path that worked is logged at INFO, or a WARNING lists every path
   tried.
4. Reloads the conf files so changes take effect without a restart.

If the cutoff is NOT refreshed - this input did not run, or the forwarders
did not get the new files - the filter keeps an OLDER cutoff and becomes
LESS restrictive: an event older than the configured N days but newer than
the stale cutoff is indexed instead of dropped, one extra day of old data for
each missed day.  Nothing that should be kept is dropped; the drop of old
data falls behind until the next successful refresh.

Designed for use in inputs.conf:
    [script://./bin/logserv_filter_time_refresh.py]
    interval = 86400
    sourcetype = splunk_ta_sap_logserv:filter_time_refresh
    index = _internal
    disabled = 0
    passAuth = splunk-system-user
"""

import os
import re
import sys
import json
import logging

# Add the app's bin/ directory to sys.path so shared utilities can be imported.
sys.path.insert(
    0,
    os.path.join(os.path.dirname(os.path.abspath(__file__)))
)

from splunk_ta_sap_logserv_filter_utils import (
    APP_NAME,
    SERVERCLASS_NAME,
    SETTINGS_CONF,
    FILTER_STANZA,
    generate_transforms_stanzas,
    generate_props_filter_lines,
    write_local_conf,
    parse_comma_patterns,
    parse_source_patterns,
    parse_days_in_past,
    get_app_path,
    is_deployment_server,
    ensure_deployment_app_synced,
    mirror_to_deployment_apps,
)

# The scoped deployment reload (reload_serverclass): an owning-app name read
# from the server class's ACL goes into a REST path only when it is a plain
# app name made of these characters (and not only dots).
SERVERCLASS_APP_NAME = re.compile(r'[A-Za-z0-9_.-]+')
# Tried, in this order, after the owning app's namespace.
SERVERCLASS_RELOAD_FALLBACK_PREFIXES = ('/servicesNS/nobody/search', '/services')


class _BelowLevel(logging.Filter):
    """Pass only records below ``level`` (the stdout handler's share)."""

    def __init__(self, level):
        super().__init__()
        self.level = level

    def filter(self, record):
        return record.levelno < self.level


def setup_logging():
    """
    Configure logging for this scripted input.

    INFO goes to stdout, which Splunk indexes as this input's own events
    (index=_internal sourcetype=splunk_ta_sap_logserv:filter_time_refresh,
    from inputs.conf). WARNING and above go to stderr, which splunkd writes to
    splunkd.log (component ExecProcessor) as an ERROR line whatever the
    level - so only real warnings and errors go there. Builds of 2026-10-13
    and earlier sent every line to stderr: the daily INFO lines (for example
    the deployment client's "Skipping refresh") read as ERRORs in splunkd.log.
    """
    formatter = logging.Formatter('%(asctime)s level=%(levelname)s %(message)s')
    out = logging.StreamHandler(sys.stdout)
    out.addFilter(_BelowLevel(logging.WARNING))
    out.setFormatter(formatter)
    err = logging.StreamHandler(sys.stderr)
    err.setLevel(logging.WARNING)
    err.setFormatter(formatter)
    root = logging.getLogger()
    root.addHandler(out)
    root.addHandler(err)
    root.setLevel(logging.INFO)
    return logging.getLogger('logserv_filter_time_refresh')


def get_session_key():
    """
    Read the session key from stdin.

    Splunk passes the session key via stdin when launching scripted inputs
    with ``passAuth`` configured.
    """
    try:
        session_key = sys.stdin.readline().strip()
        if session_key.startswith('sessionKey='):
            return session_key[len('sessionKey='):]
        return session_key
    except Exception:
        return None


def get_filter_settings(session_key):
    """
    Read the user's saved filter settings from the settings conf via REST.

    Returns:
        dict: Keys: filter_enabled (bool), include_patterns (list),
              exclude_patterns (list), include_sources (list),
              exclude_sources (list), days_in_past (int, or None when the
              stored value is not a whole number) and days_error (None, or
              the message naming Days in the Past when it is not).  A key
              missing from the stored stanza (e.g. a conf written before the
              source fields existed) reads as empty.
              Returns None if settings cannot be read.
    """
    import splunk.rest as rest_api

    try:
        response, content = rest_api.simpleRequest(
            f'/servicesNS/nobody/{APP_NAME}/configs/conf-{SETTINGS_CONF}/{FILTER_STANZA}',
            sessionKey=session_key,
            getargs={'output_mode': 'json'},
        )
        data = json.loads(content)
        entries = data.get('entry', [])
        if entries:
            c = entries[0].get('content', {})
            settings = {
                'filter_enabled': c.get('filter_enabled', '0') == '1',
                'include_patterns': parse_comma_patterns(c.get('include_filters', '*/*')),
                'exclude_patterns': parse_comma_patterns(c.get('exclude_filters', '')),
                'include_sources': parse_source_patterns(c.get('include_sources', '')),
                'exclude_sources': parse_source_patterns(c.get('exclude_sources', '')),
                'days_in_past': None,
                'days_error': None,
            }
            # The Filters save reads Days in the Past with this same parser,
            # so a value it accepted ('7.0') is refreshed, never frozen.
            try:
                settings['days_in_past'] = parse_days_in_past(c.get('days_in_past', '0'))
            except ValueError as e:
                settings['days_error'] = str(e)
            return settings
    except Exception as e:
        logging.getLogger().info(
            f'Could not read filter settings (may not be configured yet): {e}'
        )

    return None


def reload_confs(session_key):
    """Reload transforms.conf and props.conf without a restart."""
    import splunk.rest as rest_api

    for conf_type in ('transforms', 'props'):
        try:
            rest_api.simpleRequest(
                f'/servicesNS/nobody/{APP_NAME}/configs/conf-{conf_type}/_reload',
                sessionKey=session_key,
                method='GET',
            )
        except Exception as e:
            logging.getLogger().warning(f'Could not reload {conf_type}.conf: {e}')


def serverclass_owning_app(session_key, log):
    """
    The app that owns the server class, read (GET only) from its ACL.

    GET /servicesNS/-/-/deployment/server/serverclasses/<SERVERCLASS_NAME>
    and return entry[0].acl.app: the app whose local/serverclass.conf defines
    the class (``search`` on the reference deployment server, owner nobody).
    Returns None when the class cannot be read, or when the name is not a
    plain app name (SERVERCLASS_APP_NAME, not only dots), so nothing unchecked
    is ever put in a REST path.
    """
    import splunk.rest as rest_api

    try:
        response, content = rest_api.simpleRequest(
            f'/servicesNS/-/-/deployment/server/serverclasses/{SERVERCLASS_NAME}',
            sessionKey=session_key,
            getargs={'output_mode': 'json'},
            method='GET',
        )
        if int(response.status) != 200:
            log.info(
                f'Could not read the owning app of server class '
                f'"{SERVERCLASS_NAME}": HTTP {response.status}'
            )
            return None
        app = json.loads(content)['entry'][0]['acl']['app']
    except Exception as e:
        log.info(
            f'Could not read the owning app of server class '
            f'"{SERVERCLASS_NAME}": {type(e).__name__}: {e}'
        )
        return None
    if (not isinstance(app, str) or not SERVERCLASS_APP_NAME.fullmatch(app)
            or not app.strip('.')):
        log.warning(
            f'Server class "{SERVERCLASS_NAME}" reports the owning app '
            f'{app!a}, which is not a plain app name - it is not used in a '
            f'REST path.'
        )
        return None
    return app


def reload_serverclass(session_key, log):
    """
    Trigger the scoped deployment reload of SERVERCLASS_NAME.  Never raises.

    Only the SAP_LogServ_HeavyForwarders clients receive the update; a global
    reload could push pending changes of unrelated server classes.  The POST
    belongs in the namespace of the app that owns the class (a reload in the
    system namespace was refused with a sourceApp / callerApp mismatch while
    the class lived in the search app), so the paths are tried in this order,
    stopping at the first HTTP 200 or 201:

      1. /servicesNS/nobody/<owning app>/... - the app read from the class's
         ACL (serverclass_owning_app; skipped when it cannot be read);
      2. /servicesNS/nobody/search/...       - where the class is defined on
         the reference deployment server, and the form proven to work there;
      3. /services/...                       - this user's default namespace.

    A path already tried is not tried again.  Returns the path that worked
    (logged at INFO), or None after a WARNING that lists every path tried and
    its result.
    """
    suffix = f'/deployment/server/serverclasses/{SERVERCLASS_NAME}/reload'
    tried = []
    try:
        import splunk.rest as rest_api

        prefixes = []
        try:
            app = serverclass_owning_app(session_key, log)
        except Exception:
            app = None
        if app:
            prefixes.append(f'/servicesNS/nobody/{app}')
        for prefix in SERVERCLASS_RELOAD_FALLBACK_PREFIXES:
            if prefix not in prefixes:
                prefixes.append(prefix)

        for prefix in prefixes:
            path = prefix + suffix
            try:
                response, _content = rest_api.simpleRequest(
                    path,
                    sessionKey=session_key,
                    method='POST',
                )
                status = int(response.status)
            except Exception as e:
                status = f'{type(e).__name__}: {e}'
            tried.append(f'{path} -> {status}')
            if status in (200, 201):
                log.info(
                    f'Deployment reload triggered for server class '
                    f'"{SERVERCLASS_NAME}" via {path} - updated time filter '
                    f'configs will be distributed to forwarders on next '
                    f'phone-home.'
                )
                return path
    except Exception as e:
        tried.append(f'{type(e).__name__}: {e}')

    log.warning(
        f'Deployment reload for server class "{SERVERCLASS_NAME}" did not '
        f'succeed (tried: {"; ".join(tried) or "nothing"}) - forwarders keep '
        f'their previous time cutoff, which is LESS restrictive (older events '
        f'pass), until the class is reloaded: Deploy to Forwarders, or a '
        f'manual reload of the server class.'
    )
    return None


def log_not_refreshed(log, problem):
    """Log, at ERROR, that an invalid stored setting stopped the refresh."""
    log.error(
        f'Stored filter settings are invalid - {problem} The filter '
        f'configuration was NOT refreshed: local/transforms.conf and '
        f'local/props.conf keep their last good filter block until the '
        f'settings are corrected and saved in Configuration > Filters.'
    )


def data_ta_delivered_by_deployment_server(log):
    """Whether a deployment server delivered this app to this instance.

    The deployment client keeps its record of what it was sent in
    $SPLUNK_HOME/var/run/serverclass.xml (<serverClass><app name=...>).
    True when that record lists this app; False when it lists other apps but
    not this one - the Data TA was installed on this instance directly, for
    example on a search head that is a deployment client for other apps
    (2026-10-20); None when there is no record, it cannot be read or it lists
    no app at all. Of these, main() refreshes only on False: on a forwarder
    the deployment server manages, a local refresh would rebuild the filter
    from local settings that can be stale and overwrite the filter chain the
    deployment server pushed. (An error reading the server's roles, before
    this is asked, still lets the refresh run, as it always has.)
    """
    # Imported here: at import time the scripts load only a few stdlib
    # modules and the filter utils.
    import xml.etree.ElementTree as ElementTree

    home = os.environ.get('SPLUNK_HOME', '')
    if not home:
        return None
    path = os.path.join(home, 'var', 'run', 'serverclass.xml')
    try:
        root = ElementTree.parse(path).getroot()
    except FileNotFoundError:
        return None
    except Exception as e:  # unreadable or malformed: undetermined
        log.warning(f'Could not read {path}: {e}')
        return None
    # Matched by local name, so a namespaced record reads the same way.
    apps = [el for el in root.iter()
            if isinstance(el.tag, str) and el.tag.rsplit('}', 1)[-1] == 'app']
    if not apps:
        return None
    return any(app.get('name') == APP_NAME for app in apps)


def main():
    log = setup_logging()
    session_key = get_session_key()
    if not session_key:
        log.error('No session key available — cannot refresh time filter')
        return

    # If this instance is a deployment client (HF) but NOT a deployment
    # server, and its deployment server delivered this app, the DS manages
    # filter configs — do not overwrite locally. A deployment client that
    # holds the Data TA directly (a search head managed by a DS for other
    # apps) refreshes its own filter (2026-10-20); when that cannot be told,
    # it skips, as every deployment client did before.
    if not is_deployment_server(session_key):
        try:
            import splunk.rest as rest_api
            response, content = rest_api.simpleRequest(
                '/services/server/info',
                sessionKey=session_key,
                getargs={'output_mode': 'json'},
                method='GET',
            )
            import json as _json
            info = _json.loads(content)
            roles = info.get('entry', [{}])[0].get('content', {}).get(
                'server_roles', []
            )
            if 'deployment_client' in roles:
                delivered = data_ta_delivered_by_deployment_server(log)
                if delivered is False:
                    log.info(
                        'This instance is a deployment client, but no deployment '
                        'server delivered this app to it (it is not in '
                        'serverclass.xml) — refreshing the filter here.'
                    )
                elif delivered:
                    log.info(
                        'This instance is a deployment client and its deployment '
                        'server delivered this app — filter configs are managed by '
                        'the deployment server. Skipping refresh.'
                    )
                    return
                else:
                    log.warning(
                        'This instance is a deployment client, and whether its '
                        'deployment server delivered this app cannot be told '
                        '(serverclass.xml is missing, unreadable or lists no app). '
                        'Skipping refresh: the Days in the Past cutoff in '
                        'local/transforms.conf stays where it is.'
                    )
                    return
        except Exception:
            pass  # If we can't determine, continue with refresh

    settings = get_filter_settings(session_key)
    if settings is None:
        log.info('No filter settings found — nothing to refresh')
        return

    if not settings['filter_enabled']:
        log.info('Filtering is disabled — skipping refresh')
        return

    if settings['days_error']:
        log_not_refreshed(log, settings['days_error'])
        return

    if settings['days_in_past'] <= 0:
        log.info('No time-based filter configured — skipping refresh')
        return

    app_path = get_app_path()

    # Regenerate transforms.conf with the updated epoch cutoff, and props.conf
    # (references stay the same, but write for consistency).  Both are
    # generated before either is written: the generators re-validate every
    # stored value and raise ValueError (naming the field) on an invalid one,
    # in which case the last good block is kept as it is.
    try:
        transforms_content = generate_transforms_stanzas(
            settings['include_patterns'],
            settings['exclude_patterns'],
            settings['days_in_past'],
            include_sources=settings['include_sources'],
            exclude_sources=settings['exclude_sources'],
        )
        props_content = generate_props_filter_lines(
            settings['include_patterns'],
            settings['exclude_patterns'],
            settings['days_in_past'],
            settings['filter_enabled'],
            include_sources=settings['include_sources'],
            exclude_sources=settings['exclude_sources'],
        )
    except ValueError as e:
        log_not_refreshed(log, e)
        return

    write_local_conf(app_path, 'transforms', transforms_content)
    write_local_conf(app_path, 'props', props_content)

    log.info(
        f'Refreshed time filter cutoff: days_in_past={settings["days_in_past"]}'
    )

    # Mirror to deployment server if applicable, then trigger a deployment
    # reload so heavy forwarders receive the updated time cutoff regex on
    # their next phone-home interval without manual intervention.
    try:
        if is_deployment_server(session_key):
            ensure_deployment_app_synced(app_path)
            mirror_to_deployment_apps(app_path)
            log.info('Mirrored updated configs to deployment-apps/')

            # Server-class-scoped deployment reload, in the namespace of the
            # app that owns the class (never raises; logs the outcome).
            reload_serverclass(session_key, log)
    except Exception as e:
        log.warning(f'Could not mirror to deployment-apps: {e}')

    # Reload confs so changes take effect
    reload_confs(session_key)
    log.info('Time filter refresh complete')


if __name__ == '__main__':
    main()
