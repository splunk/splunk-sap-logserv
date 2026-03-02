"""
SAP LogServ TA - Filter Upgrade Check (Scripted Input)

This scripted input runs on a 10-minute interval to detect when the TA has
been upgraded to a new version.  On version change, it compares the user's
saved include filter patterns against the @logserv_filter annotations in the
new version's default/transforms.conf.

If the user's include patterns do not cover log types that are newly supported
in the upgraded version, a Splunk system message banner is created to alert
the user across all Splunk Web pages.

The version check is very lightweight (~2ms) on subsequent runs where the
version has not changed.  The full comparison logic only runs once per version
change.

State is persisted to a JSON file in:
    $SPLUNK_HOME/var/lib/splunk/modinputs/splunk_ta_sap_logserv/filter_check_state.json

Designed for use in inputs.conf:
    [script://./bin/logserv_filter_upgrade_check.py]
    interval = 600
    sourcetype = splunk_ta_sap_logserv:filter_check
    index = _internal
    disabled = 0
"""

import os
import sys
import json
import logging
import logging.handlers

# Add the app's bin/ directory to sys.path so shared utilities can be imported.
sys.path.insert(
    0,
    os.path.join(os.path.dirname(os.path.abspath(__file__)))
)

from splunk_ta_sap_logserv_filter_utils import (
    APP_NAME,
    SETTINGS_CONF,
    FILTER_STANZA,
    SYSTEM_MESSAGE_NAME,
    discover_supported_types,
    find_uncovered_types,
    parse_comma_patterns,
    get_app_path,
    get_ta_version,
)


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

STATE_DIR = os.path.join(
    os.environ.get('SPLUNK_HOME', ''),
    'var', 'lib', 'splunk', 'modinputs', APP_NAME,
)
STATE_FILE = os.path.join(STATE_DIR, 'filter_check_state.json')


def setup_logging():
    """Configure logging to stdout (captured by Splunk as script output)."""
    handler = logging.StreamHandler(sys.stderr)
    handler.setFormatter(logging.Formatter(
        '%(asctime)s level=%(levelname)s %(message)s'
    ))
    root = logging.getLogger()
    root.addHandler(handler)
    root.setLevel(logging.INFO)
    return logging.getLogger('logserv_filter_upgrade_check')


def get_last_checked_version():
    """Read the last-checked version from the state file."""
    try:
        with open(STATE_FILE, 'r') as f:
            state = json.load(f)
            return state.get('last_checked_version', '')
    except (FileNotFoundError, json.JSONDecodeError, PermissionError):
        return ''


def save_checked_version(version):
    """Persist the current version to the state file."""
    try:
        os.makedirs(STATE_DIR, exist_ok=True)
        with open(STATE_FILE, 'w') as f:
            json.dump({'last_checked_version': version}, f)
    except Exception as e:
        logging.getLogger().warning(f'Could not save state file: {e}')


def get_session_key():
    """
    Read the session key from stdin.

    Splunk passes the session key via stdin when launching scripted inputs.
    Format: ``sessionKey=<key>``
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
    Read the user's saved filter settings from the settings conf file
    via the Splunk REST API.

    Returns:
        tuple: (filter_enabled: str, include_patterns: list[str])
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
            entry_content = entries[0].get('content', {})
            enabled = entry_content.get('filter_enabled', '0')
            include = entry_content.get('include_filters', '*/*')
            return enabled, parse_comma_patterns(include)
    except Exception as e:
        logging.getLogger().info(
            f'Could not read filter settings (may not be configured yet): {e}'
        )

    return '0', ['*/*']


def create_system_message(session_key, uncovered, version):
    """Create a persistent Splunk system message banner."""
    import splunk.rest as rest_api

    type_list = ', '.join(sorted(uncovered))
    message = (
        f'SAP LogServ TA v{version}: Your include filter patterns '
        f'do not cover {len(uncovered)} supported log type(s): '
        f'{type_list}. Open Configuration \u2192 Filters in the SAP LogServ '
        f'TA to update your include patterns, or these log types will '
        f'be dropped before indexing.'
    )

    # Remove any previous message first
    clear_system_message(session_key)

    try:
        rest_api.simpleRequest(
            '/services/messages',
            sessionKey=session_key,
            method='POST',
            postargs={
                'name': SYSTEM_MESSAGE_NAME,
                'value': message,
                'severity': 'warn',
            },
        )
    except Exception as e:
        logging.getLogger().warning(f'Could not create system message: {e}')


def clear_system_message(session_key):
    """Remove any previously created system message banner."""
    import splunk.rest as rest_api

    try:
        rest_api.simpleRequest(
            f'/services/messages/{SYSTEM_MESSAGE_NAME}',
            sessionKey=session_key,
            method='DELETE',
        )
    except Exception:
        pass  # Message may not exist


def run():
    """Main entry point for the scripted input."""
    log = setup_logging()

    session_key = get_session_key()
    if not session_key:
        log.warning('No session key provided; exiting')
        return

    app_path = get_app_path()
    current_version = get_ta_version(app_path)
    last_version = get_last_checked_version()

    # Quick exit if version hasn't changed (the common case)
    if current_version == last_version:
        return

    log.info(
        f'Version change detected: {last_version or "(none)"} -> {current_version}. '
        f'Running filter coverage check.'
    )

    # Version changed — run the full comparison
    enabled, include_patterns = get_filter_settings(session_key)

    # If filtering is disabled or include is wildcard, no warning needed
    if enabled != '1' or not include_patterns or include_patterns == ['*/*']:
        clear_system_message(session_key)
        save_checked_version(current_version)
        log.info(
            'Filtering is disabled or include is wildcard (*/*); '
            'no coverage warning needed.'
        )
        return

    # Discover supported types from annotations
    supported = discover_supported_types(app_path)
    if not supported:
        log.info('No @logserv_filter annotations found in default/transforms.conf')
        save_checked_version(current_version)
        return

    # Find types not covered by include patterns
    uncovered = find_uncovered_types(supported, include_patterns)

    if uncovered:
        type_list = ', '.join(sorted(uncovered))
        log.warning(
            f'Include patterns do not cover {len(uncovered)} supported '
            f'type(s): {type_list}'
        )
        create_system_message(session_key, uncovered, current_version)
    else:
        log.info('All supported types are covered by include patterns.')
        clear_system_message(session_key)

    save_checked_version(current_version)
    log.info('Filter coverage check complete.')


if __name__ == '__main__':
    run()
