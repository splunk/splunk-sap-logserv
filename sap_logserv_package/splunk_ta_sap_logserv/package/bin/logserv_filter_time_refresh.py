"""
SAP LogServ TA - Time Filter Cutoff Refresh (Scripted Input)

The time-based filter uses a pre-computed epoch regex in transforms.conf to
drop events older than N days.  Because the cutoff is a static regex (not a
dynamic expression like INGEST_EVAL), it must be refreshed periodically to
keep the rolling window accurate.

This scripted input runs once per day.  On each run it:

1. Reads the current filter settings (filter_enabled, include_filters,
   exclude_filters, days_in_past) from the TA's settings conf.
2. If time-based filtering is active (days_in_past > 0), regenerates
   local/transforms.conf and local/props.conf with an updated epoch cutoff.
3. Reloads the conf files so changes take effect without a restart.

If the cutoff is NOT refreshed for a day or two, the impact is minor:
the regex becomes slightly more restrictive (filtering one extra day of
data), which is the safer failure mode.

Designed for use in inputs.conf:
    [script://./bin/logserv_filter_time_refresh.py]
    interval = 86400
    sourcetype = splunk_ta_sap_logserv:filter_time_refresh
    index = _internal
    disabled = 0
    passAuth = splunk-system-user
"""

import os
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
    SETTINGS_CONF,
    FILTER_STANZA,
    generate_transforms_stanzas,
    generate_props_filter_lines,
    write_local_conf,
    parse_comma_patterns,
    get_app_path,
    is_deployment_server,
    ensure_deployment_app_synced,
    mirror_to_deployment_apps,
)


def setup_logging():
    """Configure logging to stderr (captured by Splunk as script output)."""
    handler = logging.StreamHandler(sys.stderr)
    handler.setFormatter(logging.Formatter(
        '%(asctime)s level=%(levelname)s %(message)s'
    ))
    root = logging.getLogger()
    root.addHandler(handler)
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
              exclude_patterns (list), days_in_past (int).
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
            return {
                'filter_enabled': c.get('filter_enabled', '0') == '1',
                'include_patterns': parse_comma_patterns(c.get('include_filters', '*/*')),
                'exclude_patterns': parse_comma_patterns(c.get('exclude_filters', '')),
                'days_in_past': int(c.get('days_in_past', '0') or '0'),
            }
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


def main():
    log = setup_logging()
    session_key = get_session_key()
    if not session_key:
        log.error('No session key available — cannot refresh time filter')
        return

    # If this instance is a deployment client (HF) but NOT a deployment
    # server, the DS manages filter configs — do not overwrite locally.
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
                log.info(
                    'This instance is a deployment client — filter configs '
                    'are managed by the deployment server. Skipping refresh.'
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

    if settings['days_in_past'] <= 0:
        log.info('No time-based filter configured — skipping refresh')
        return

    app_path = get_app_path()

    # Regenerate transforms.conf with updated epoch cutoff
    transforms_content = generate_transforms_stanzas(
        settings['include_patterns'],
        settings['exclude_patterns'],
        settings['days_in_past'],
    )
    write_local_conf(app_path, 'transforms', transforms_content)

    # Regenerate props.conf (references stay the same, but write for consistency)
    props_content = generate_props_filter_lines(
        settings['include_patterns'],
        settings['exclude_patterns'],
        settings['days_in_past'],
        settings['filter_enabled'],
    )
    write_local_conf(app_path, 'props', props_content)

    log.info(
        f'Refreshed time filter cutoff: days_in_past={settings["days_in_past"]}'
    )

    # Mirror to deployment server if applicable
    try:
        if is_deployment_server(session_key):
            ensure_deployment_app_synced(app_path)
            mirror_to_deployment_apps(app_path)
            log.info('Mirrored updated configs to deployment-apps/')
    except Exception as e:
        log.warning(f'Could not mirror to deployment-apps: {e}')

    # Reload confs so changes take effect
    reload_confs(session_key)
    log.info('Time filter refresh complete')


if __name__ == '__main__':
    main()
