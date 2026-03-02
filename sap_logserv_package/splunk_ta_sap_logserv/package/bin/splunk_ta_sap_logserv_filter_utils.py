"""
SAP LogServ TA - Filter Utility Functions

Shared utilities for:
- Discovering supported log types from @logserv_filter annotations in transforms.conf
- Converting fnmatch patterns to Splunk-compatible regex for transforms.conf
- Comparing supported types against user include patterns to find uncovered types
- Generating transforms.conf and props.conf filter stanzas

These utilities are used by both the REST handler (rh_filter_settings.py) and
the upgrade check scripted input (logserv_filter_upgrade_check.py).
"""

import os
import re
import shutil
import logging
from fnmatch import fnmatch, translate as fnmatch_translate

logger = logging.getLogger(__name__)

APP_NAME = 'splunk_ta_sap_logserv'
SETTINGS_CONF = f'{APP_NAME}_settings'
FILTER_STANZA = 'filter_settings'
ANNOTATION_PATTERN = re.compile(r'#\s*@logserv_filter:\s*(.+)')
SYSTEM_MESSAGE_NAME = 'logserv_filter_upgrade_warning'

# Markers used to identify generated filter content in local/ conf files.
# The REST handler writes content between these markers; manual edits outside
# these markers are preserved.
FILTER_MARKER_START = '### BEGIN LOGSERV FILTER CONFIG - DO NOT EDIT MANUALLY ###'
FILTER_MARKER_END = '### END LOGSERV FILTER CONFIG ###'


def get_app_path():
    """
    Determine the app installation path.

    Works in both standalone and clustered environments by checking
    SPLUNK_HOME/etc/apps/ and falling back to the directory structure
    relative to this file's location.

    Returns:
        str: Absolute path to the app directory.
    """
    splunk_home = os.environ.get('SPLUNK_HOME', '')
    app_path = os.path.join(splunk_home, 'etc', 'apps', APP_NAME)
    if os.path.isdir(app_path):
        return app_path
    # Fallback: derive from this file's location (bin/ is inside the app)
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def discover_supported_types(app_path=None):
    """
    Scan default/transforms.conf for @logserv_filter annotations.

    Annotations are structured comments placed above sourcetype routing
    transforms that declare which clz_dir/clz_subdir values that transform
    handles.  Format example::

        # @logserv_filter: linux/messages, linux/localmessages
        [set_srctype_for_linux_messages_syslog]
        ...

    Args:
        app_path: Path to the app directory.  Defaults to auto-detected path.

    Returns:
        set[str]: Set of clz_dir/clz_subdir strings (e.g. ``{'linux/messages', 'hana/hanaaudit'}``).
    """
    if app_path is None:
        app_path = get_app_path()

    transforms_path = os.path.join(app_path, 'default', 'transforms.conf')
    supported_types = set()

    try:
        with open(transforms_path, 'r') as f:
            for line in f:
                match = ANNOTATION_PATTERN.match(line.strip())
                if match:
                    for pattern in match.group(1).split(','):
                        pattern = pattern.strip()
                        if pattern:
                            supported_types.add(pattern)
    except FileNotFoundError:
        logger.warning(f'Could not find {transforms_path} for annotation scan')
    except Exception as e:
        logger.error(f'Error scanning annotations from {transforms_path}: {e}')

    return supported_types


def find_uncovered_types(supported_types, include_patterns):
    """
    Compare the TA's supported log types against the user's include patterns.

    A supported type is "uncovered" if it does not match *any* include pattern,
    meaning events of that type will be dropped by the filter before indexing.

    Args:
        supported_types: Set of clz_dir/clz_subdir strings from annotations.
        include_patterns: List of fnmatch pattern strings from user config.

    Returns:
        set[str]: Supported types that are not matched by any include pattern.
    """
    if not include_patterns or include_patterns == ['*/*']:
        return set()

    uncovered = set()
    for log_type in supported_types:
        if not any(fnmatch(log_type, pat) for pat in include_patterns):
            uncovered.add(log_type)

    return uncovered


def parse_comma_patterns(pattern_string):
    """
    Parse a comma-separated string of fnmatch patterns into a list.

    Args:
        pattern_string: Comma-separated patterns (e.g. ``'linux/*,hana/hanaaudit'``).

    Returns:
        list[str]: List of stripped, non-empty pattern strings.
    """
    if not pattern_string:
        return []
    return [p.strip() for p in pattern_string.split(',') if p.strip()]


# ---------------------------------------------------------------------------
# Pattern validation
# ---------------------------------------------------------------------------

# Valid characters for dir/subdir segments: alphanumeric, wildcards, and . - : _
VALID_SEGMENT_PATTERN = re.compile(r'^[a-zA-Z0-9*?._:\-]+$')


def validate_single_pattern(pattern):
    """
    Validate a single filter pattern.

    A valid pattern is either:
    - ``*`` (standalone wildcard matching everything)
    - ``<dir>/<subdir>`` where dir and subdir contain only valid characters
      (alphanumeric, ``*``, ``?``, ``.``, ``-``, ``:``, ``_``)

    Args:
        pattern: A single pattern string (already stripped).

    Returns:
        tuple: (is_valid: bool, error_message: str or None)
    """
    if not pattern:
        return False, 'Empty pattern is not allowed.'

    # Standalone wildcard
    if pattern == '*':
        return True, None

    # Must contain exactly one /
    if '/' not in pattern:
        return False, (
            f'Pattern "{pattern}" must contain a "/" separator '
            f'(e.g., "linux/cron" or "hana/*").'
        )

    parts = pattern.split('/')
    if len(parts) != 2:
        return False, (
            f'Pattern "{pattern}" contains multiple "/" characters. '
            f'Use the format "dir/subdir" (e.g., "linux/cron").'
        )

    dir_part, subdir_part = parts

    if not dir_part:
        return False, (
            f'Pattern "{pattern}" has an empty directory portion. '
            f'Use "*" for wildcard (e.g., "*/cron").'
        )

    if not subdir_part:
        return False, (
            f'Pattern "{pattern}" has an empty subdirectory portion. '
            f'Use "*" for wildcard (e.g., "linux/*").'
        )

    if not VALID_SEGMENT_PATTERN.match(dir_part):
        return False, (
            f'Pattern "{pattern}" contains invalid characters in the '
            f'directory portion "{dir_part}". Allowed: letters, numbers, '
            f'* ? . - : _'
        )

    if not VALID_SEGMENT_PATTERN.match(subdir_part):
        return False, (
            f'Pattern "{pattern}" contains invalid characters in the '
            f'subdirectory portion "{subdir_part}". Allowed: letters, '
            f'numbers, * ? . - : _'
        )

    return True, None


def validate_patterns(patterns, field_name='Pattern'):
    """
    Validate a list of filter patterns.

    Args:
        patterns: List of pattern strings (from :func:`parse_comma_patterns`).
        field_name: Human-readable field name for error messages
            (e.g. ``'Include Filters'``).

    Returns:
        tuple: (is_valid: bool, error_message: str or None).
            If invalid, error_message describes the first invalid pattern.
    """
    if not patterns:
        return True, None

    for pattern in patterns:
        is_valid, error = validate_single_pattern(pattern)
        if not is_valid:
            return False, f'{field_name}: {error}'

    return True, None


# ---------------------------------------------------------------------------
# Pattern-to-regex conversion for transforms.conf
# ---------------------------------------------------------------------------

def _fnmatch_to_clz_regex(pattern):
    """
    Convert a single fnmatch pattern like ``linux/*`` into a regex that
    matches against the raw NDJSON event containing ``"clz_dir"`` and
    ``"clz_subdir"`` JSON keys.

    The generated regex is designed to match the raw JSON text of the event
    *before* any field extraction occurs, which is how TRANSFORMS operates
    at index time.

    Supports patterns in the form ``<clz_dir_pattern>/<clz_subdir_pattern>``.
    Both the dir and subdir portions can contain fnmatch wildcards (``*``, ``?``).

    Args:
        pattern: An fnmatch pattern (e.g. ``'linux/*'``, ``'hana/hanaaudit'``).

    Returns:
        str: A regex string suitable for use in transforms.conf REGEX.
    """
    parts = pattern.split('/', 1)
    if len(parts) != 2:
        logger.warning(f'Pattern "{pattern}" does not contain a "/" separator, skipping')
        return None

    dir_part, subdir_part = parts

    # Convert fnmatch patterns to regex fragments for the field values only.
    # fnmatch.translate() produces a full-match regex like (?s:...\Z) — we
    # strip the wrapper to get the inner pattern.
    def _fnmatch_fragment(pat):
        raw = fnmatch_translate(pat)
        # Remove the anchoring wrapper that fnmatch.translate adds.
        # Python 3.x produces  (?s:<pattern>\Z)  or  (?s:<pattern>)\Z
        raw = re.sub(r'^\(\?s:', '', raw)
        raw = re.sub(r'\\Z\)$', '', raw)
        raw = re.sub(r'\)\\Z$', '', raw)
        return raw

    dir_regex = _fnmatch_fragment(dir_part)
    subdir_regex = _fnmatch_fragment(subdir_part)

    # Build a regex that matches both clz_dir and clz_subdir in either order
    # within the raw JSON line.  SAP LogServ NDJSON always includes both keys.
    # We use a two-lookahead approach so key order doesn't matter.
    regex = (
        f'^(?=.*"clz_dir"\\s*:\\s*"{dir_regex}")'
        f'(?=.*"clz_subdir"\\s*:\\s*"{subdir_regex}")'
    )

    return regex


def fnmatch_patterns_to_combined_regex(patterns):
    """
    Convert a list of fnmatch patterns into a single combined regex string
    using alternation (``|``).

    Args:
        patterns: List of fnmatch pattern strings.

    Returns:
        str: Combined regex string, or ``None`` if no valid patterns.
    """
    regexes = []
    for pattern in patterns:
        regex = _fnmatch_to_clz_regex(pattern)
        if regex:
            regexes.append(regex)

    if not regexes:
        return None

    if len(regexes) == 1:
        return regexes[0]

    # Wrap each in a non-capturing group and join with alternation
    return '|'.join(f'(?:{r})' for r in regexes)


# ---------------------------------------------------------------------------
# Time-based filtering via TRANSFORMS (epoch regex approach)
# ---------------------------------------------------------------------------

import time
import math


def epoch_cutoff_from_days(days_in_past):
    """
    Compute the epoch timestamp for midnight N days ago (UTC).

    This is the cutoff: events with ``_time`` less than this value should
    be dropped.

    Args:
        days_in_past: Number of days in the past.

    Returns:
        int: Epoch seconds at midnight UTC, N days ago.
    """
    now = time.time()
    # Round down to midnight UTC (start of day)
    midnight_today = int(now) - (int(now) % 86400)
    cutoff = midnight_today - (int(days_in_past) * 86400)
    return cutoff


def generate_epoch_less_than_regex(cutoff_epoch):
    """
    Generate a regex that matches integer epoch values **less than** the
    given cutoff.

    Uses a digit-by-digit alternation algorithm.  For example, cutoff
    ``1768780800`` produces alternatives like::

        0\\d{9}|1[0-6]\\d{8}|17[0-5]\\d{7}|176[0-7]\\d{6}|...

    The resulting regex is designed to be embedded in a larger REGEX that
    anchors it to the ``"_time"`` JSON field.

    Args:
        cutoff_epoch: Integer epoch timestamp (the exclusive upper bound).

    Returns:
        str: Regex alternation string matching epochs < cutoff_epoch.
    """
    digits = str(int(cutoff_epoch))
    alternatives = []
    prefix = ''

    for i, d in enumerate(digits):
        d_int = int(d)
        remaining = len(digits) - i - 1

        if d_int > 0:
            # Character class for digits less than d at this position
            if d_int == 1:
                char_class = '0'
            else:
                char_class = f'[0-{d_int - 1}]'

            if remaining > 0:
                alternatives.append(f'{prefix}{char_class}\\d{{{remaining}}}')
            else:
                alternatives.append(f'{prefix}{char_class}')

        prefix += d

    if not alternatives:
        # cutoff_epoch is 0 or all zeros — nothing is less than 0
        return None

    return '|'.join(alternatives)


# ---------------------------------------------------------------------------
# Filter conf generation
# ---------------------------------------------------------------------------

def _is_wildcard_include(include_patterns):
    """
    Check whether the include patterns are effectively a wildcard pass-all.

    Args:
        include_patterns: List of fnmatch pattern strings.

    Returns:
        bool: True if include patterns are absent, empty, or ``['*/*']``.
    """
    if not include_patterns:
        return True
    return include_patterns == ['*/*']


def generate_transforms_stanzas(include_patterns, exclude_patterns, days_in_past=0):
    """
    Generate transforms.conf stanzas for the include, exclude, and time filters.

    The include filter is an **active gate**: events whose ``clz_dir/clz_subdir``
    does not match any include pattern are dropped to ``nullQueue`` before
    indexing.  This is implemented as a three-transform chain where the last
    matching transform wins::

        logserv_filter_include_drop  →  REGEX = .           →  queue=nullQueue
        logserv_filter_include_allow →  REGEX = <includes>  →  queue=indexQueue
        logserv_filter_exclude       →  REGEX = <excludes>  →  queue=nullQueue

    Pipeline logic:
    1. Drop everything (default deny)
    2. Allow back events matching include patterns
    3. Re-drop events matching exclude patterns (exclude wins over include)

    When include is ``*/*`` (the default), the include drop/allow transforms
    are omitted entirely — everything passes, and only the exclude transform
    (if any) is generated.

    Time-based filtering is implemented as an additional transform that matches
    the ``"_time"`` epoch value in the raw JSON and routes old events to
    ``nullQueue``.  This runs in the TRANSFORMS phase alongside the other
    filters, avoiding the need for INGEST_EVAL (which requires a server-wide
    ``limits.conf`` setting that may not be available on Splunk Cloud).

    Args:
        include_patterns: List of fnmatch include pattern strings.
        exclude_patterns: List of fnmatch exclude pattern strings.
        days_in_past: Number of days; events older than this are dropped.

    Returns:
        str: transforms.conf stanza text, or empty string if nothing to generate.
    """
    stanzas = []
    wildcard_include = _is_wildcard_include(include_patterns)

    # --- Include transforms (only when include is not wildcard) ---
    if not wildcard_include:
        include_regex = fnmatch_patterns_to_combined_regex(include_patterns)
        if include_regex:
            # Transform 1: Default-drop all events
            stanzas.append(
                '[logserv_filter_include_drop]\n'
                'REGEX = .\n'
                'FORMAT = nullQueue\n'
                'DEST_KEY = queue\n'
            )
            # Transform 2: Allow back events matching include patterns
            stanzas.append(
                f'[logserv_filter_include_allow]\n'
                f'REGEX = {include_regex}\n'
                f'FORMAT = indexQueue\n'
                f'DEST_KEY = queue\n'
            )

    # --- Exclude transform ---
    if exclude_patterns:
        exclude_regex = fnmatch_patterns_to_combined_regex(exclude_patterns)
        if exclude_regex:
            stanzas.append(
                f'[logserv_filter_exclude]\n'
                f'REGEX = {exclude_regex}\n'
                f'FORMAT = nullQueue\n'
                f'DEST_KEY = queue\n'
            )

    # --- Time-based filter transform ---
    if days_in_past and int(days_in_past) > 0:
        cutoff = epoch_cutoff_from_days(int(days_in_past))
        epoch_regex = generate_epoch_less_than_regex(cutoff)
        if epoch_regex:
            # Match "_time": VALUE in the raw JSON where VALUE < cutoff.
            # The JSON may quote the value or not:  "_time":1735689600.123
            # or "_time":"1735689600.123".  We anchor on the field name
            # and match the integer epoch portion.
            full_regex = f'"_time"\\s*:\\s*"?(?:{epoch_regex})(?:\\.\\d+)?'
            stanzas.append(
                f'[logserv_filter_time_drop]\n'
                f'REGEX = {full_regex}\n'
                f'FORMAT = nullQueue\n'
                f'DEST_KEY = queue\n'
            )

    return '\n'.join(stanzas)


def generate_props_filter_lines(include_patterns, exclude_patterns, days_in_past, filter_enabled):
    """
    Generate the ``[sap_logserv_logs]`` props.conf stanza that references
    the filter transforms.

    All filtering (include/exclude gate AND time-based) is done via
    TRANSFORMS, which run in the same pipeline phase as sourcetype routing.
    This avoids INGEST_EVAL (which requires ``allow_ingest_eval = true``
    in ``limits.conf`` — a server-wide setting unavailable on Splunk Cloud).

    All queue-setting transforms MUST be in a single ``TRANSFORMS-00-filter``
    line because Splunk does not reliably carry ``DEST_KEY = queue`` changes
    across separate ``TRANSFORMS-xx`` directives.  Within a single line,
    "last match wins" is guaranteed.

    The transform order within the line is::

        logserv_filter_include_drop   (default deny → nullQueue)
        logserv_filter_include_allow  (allow matching types → indexQueue)
        logserv_filter_time_drop      (drop old events → nullQueue, overrides allow)
        logserv_filter_exclude        (drop excluded types → nullQueue, overrides allow)

    When include is ``*/*``, include transforms are omitted.
    When exclude is empty, the exclude transform is omitted.
    When days_in_past is 0 or empty, the time transform is omitted.

    Args:
        include_patterns: List of fnmatch include pattern strings.
        exclude_patterns: List of fnmatch exclude pattern strings.
        days_in_past: Number of days; events older than this are dropped.
        filter_enabled: Whether filtering is enabled at all.

    Returns:
        str: props.conf ``[sap_logserv_logs]`` stanza content, or empty string.
    """
    if not filter_enabled:
        return ''

    lines = ['[sap_logserv_logs]']
    wildcard_include = _is_wildcard_include(include_patterns)

    # Build a single TRANSFORMS-00-filter line with all queue transforms.
    # Order matters: last match wins within the line.
    transform_refs = []

    # Stage 1 & 2: Include gate (drop all, then allow matching)
    if not wildcard_include:
        include_regex = fnmatch_patterns_to_combined_regex(include_patterns)
        if include_regex:
            transform_refs.append('logserv_filter_include_drop')
            transform_refs.append('logserv_filter_include_allow')

    # Stage 3: Time filter (overrides include_allow for old events)
    if days_in_past and int(days_in_past) > 0:
        transform_refs.append('logserv_filter_time_drop')

    # Stage 4: Exclude filter (overrides include_allow for excluded types)
    if exclude_patterns:
        exclude_regex = fnmatch_patterns_to_combined_regex(exclude_patterns)
        if exclude_regex:
            transform_refs.append('logserv_filter_exclude')

    if transform_refs:
        lines.append(f'TRANSFORMS-00-filter = {", ".join(transform_refs)}')

    if len(lines) <= 1:
        return ''

    return '\n'.join(lines) + '\n'


def write_local_conf(app_path, conf_name, content):
    """
    Write generated filter content to a local/ conf file.

    Content is wrapped in marker comments so it can be identified and replaced
    on subsequent saves without disturbing other local/ customisations.

    If ``content`` is empty, any existing marked section is removed.

    Args:
        app_path: Path to the app directory.
        conf_name: Conf file name without extension (e.g. ``'transforms'``).
        content: The stanza text to write, or empty string to clear.

    Returns:
        str: Path to the written file.
    """
    local_dir = os.path.join(app_path, 'local')
    os.makedirs(local_dir, exist_ok=True)
    conf_path = os.path.join(local_dir, f'{conf_name}.conf')

    # Read existing content if file exists
    existing = ''
    if os.path.isfile(conf_path):
        with open(conf_path, 'r') as f:
            existing = f.read()

    # Remove any previous marked section
    marker_pattern = re.compile(
        re.escape(FILTER_MARKER_START) + r'.*?' + re.escape(FILTER_MARKER_END),
        re.DOTALL,
    )
    cleaned = marker_pattern.sub('', existing).strip()

    # Build new file content
    parts = []
    if cleaned:
        parts.append(cleaned)

    if content:
        marked_content = (
            f'{FILTER_MARKER_START}\n'
            f'{content}\n'
            f'{FILTER_MARKER_END}'
        )
        parts.append(marked_content)

    final = '\n\n'.join(parts) + '\n' if parts else ''

    with open(conf_path, 'w') as f:
        f.write(final)

    logger.info(f'Wrote filter config to {conf_path}')
    return conf_path


def get_ta_version(app_path=None):
    """
    Read the TA version from ``default/app.conf``.

    Falls back to reading ``app.manifest`` JSON if ``app.conf`` is not present
    (which can happen before the UCC build step).

    Args:
        app_path: Path to the app directory.

    Returns:
        str: Version string (e.g. ``'0.0.2'``), or ``'unknown'``.
    """
    if app_path is None:
        app_path = get_app_path()

    # Try app.conf first (present in built app)
    app_conf_path = os.path.join(app_path, 'default', 'app.conf')
    if os.path.isfile(app_conf_path):
        try:
            import configparser
            conf = configparser.ConfigParser()
            conf.read(app_conf_path)
            version = conf.get('launcher', 'version', fallback=None)
            if version:
                return version
        except Exception as e:
            logger.warning(f'Error reading app.conf: {e}')

    # Fallback: try app.manifest (present in source)
    manifest_path = os.path.join(app_path, 'app.manifest')
    if os.path.isfile(manifest_path):
        try:
            import json
            with open(manifest_path, 'r') as f:
                manifest = json.load(f)
            return manifest.get('info', {}).get('id', {}).get('version', 'unknown')
        except Exception as e:
            logger.warning(f'Error reading app.manifest: {e}')

    return 'unknown'


# ---------------------------------------------------------------------------
# Deployment server detection and deployment-apps mirroring
# ---------------------------------------------------------------------------

def get_server_roles(session_key):
    """
    Query the current Splunk instance's server roles.

    Args:
        session_key: Splunk session key for authentication.

    Returns:
        list[str]: List of server role strings, or empty list on failure.
    """
    try:
        import splunk.rest as rest
        response, content = rest.simpleRequest(
            '/services/server/info',
            sessionKey=session_key,
            getargs={'output_mode': 'json'},
            method='GET',
        )
        if response.status == 200:
            import json
            info = json.loads(content)
            return info.get('entry', [{}])[0].get('content', {}).get('server_roles', [])
    except Exception as e:
        logger.warning(f'Could not determine server roles: {e}')

    return []


def is_deployment_server(session_key):
    """
    Check whether the current Splunk instance is a deployment server.

    Uses a two-step detection:

    1. **Fast path** – queries ``/services/server/info`` and checks for the
       ``deployment_server`` role.  This role is present when at least one
       server class is defined.
    2. **Fallback** – if the role is absent, queries
       ``/services/deployment/server/clients`` to check whether any
       deployment clients (forwarders) are connected.  Clients phone home
       to the DS regardless of whether server classes exist, so this
       detects a DS even when no ``serverclass.conf`` is present.

    Args:
        session_key: Splunk session key for authentication.

    Returns:
        bool: True if this instance is a deployment server.
    """
    # Fast path: check server roles
    roles = get_server_roles(session_key)
    if 'deployment_server' in roles:
        return True

    # Fallback: check if any deployment clients are connected
    try:
        import splunk.rest as rest
        import json

        response, content = rest.simpleRequest(
            '/services/deployment/server/clients',
            sessionKey=session_key,
            getargs={'output_mode': 'json', 'count': '1'},
            method='GET',
        )
        if response.status == 200:
            data = json.loads(content)
            if data.get('entry', []):
                logger.debug(
                    'deployment_server role not in server_roles but '
                    'deployment clients are connected — '
                    'treating as deployment server.'
                )
                return True
    except Exception:
        pass

    return False


def get_deployment_apps_path():
    """
    Return the path to the TA directory under ``etc/deployment-apps/``.

    This is where app content must reside for distribution to deployment
    clients (heavy forwarders) via the deployment server.

    Returns:
        str: Absolute path to ``etc/deployment-apps/<APP_NAME>``.
        The directory may not exist yet.
    """
    splunk_home = os.environ.get('SPLUNK_HOME', '')
    return os.path.join(splunk_home, 'etc', 'deployment-apps', APP_NAME)


def ensure_deployment_app_synced(app_path):
    """
    Ensure the ``deployment-apps/`` copy of the TA exists and matches the
    version installed in ``etc/apps/``.

    Handles two cases:

    1. **Initial install**: If the TA has never been copied to
       ``deployment-apps/``, perform a full copy from ``etc/apps/``.
    2. **Version upgrade**: If the version in ``etc/apps/`` differs from
       the ``deployment-apps/`` copy, replace the ``deployment-apps/`` copy
       with a fresh copy from ``etc/apps/``.

    In both cases, the full app directory is copied (default configs, bin
    scripts, lookups, etc.) so that forwarders receive the complete,
    correct package on the next deploy.

    This function should only be called after confirming the instance is a
    deployment server via :func:`is_deployment_server`.

    Args:
        app_path: Path to the app directory (``etc/apps/<APP_NAME>``).

    Returns:
        tuple: ``(synced, message)`` where *synced* is ``True`` if a copy
        was performed and *message* describes what happened.
    """
    deploy_app_path = get_deployment_apps_path()

    # --- Case 1: Initial copy (deployment-apps dir does not exist) ---
    if not os.path.isdir(deploy_app_path):
        try:
            shutil.copytree(app_path, deploy_app_path)
            version = get_ta_version(app_path)
            msg = (
                f'Initial copy of {APP_NAME} v{version} to '
                f'deployment-apps/ completed.'
            )
            logger.info(msg)
            return True, msg
        except Exception as e:
            logger.error(
                f'Failed initial copy to deployment-apps: {e}',
                exc_info=True,
            )
            return False, str(e)

    # --- Case 2: Check for version mismatch ---
    apps_version = get_ta_version(app_path)
    deploy_version = get_ta_version(deploy_app_path)

    if apps_version == deploy_version:
        # Already in sync — nothing to do
        return False, None

    # Version mismatch — full re-copy
    try:
        shutil.rmtree(deploy_app_path)
        shutil.copytree(app_path, deploy_app_path)
        msg = (
            f'Upgraded {APP_NAME} in deployment-apps/ from '
            f'v{deploy_version} to v{apps_version}.'
        )
        logger.info(msg)
        return True, msg
    except Exception as e:
        logger.error(
            f'Failed to upgrade TA in deployment-apps: {e}',
            exc_info=True,
        )
        return False, str(e)


def mirror_to_deployment_apps(app_path):
    """
    Copy generated filter configs from ``local/`` to the corresponding
    ``deployment-apps/`` directory so they are included in the next
    deployment server push to forwarder clients.

    Only the filter-related conf files (transforms.conf, props.conf) are
    copied.  The ``deployment-apps/`` local directory is created if needed.

    This function should only be called after confirming the instance is a
    deployment server via :func:`is_deployment_server`.

    Args:
        app_path: Path to the app directory (``etc/apps/<APP_NAME>``).

    Returns:
        str: Path to the deployment-apps local directory, or None on failure.
    """
    deploy_app_path = get_deployment_apps_path()
    deploy_local = os.path.join(deploy_app_path, 'local')
    source_local = os.path.join(app_path, 'local')

    try:
        os.makedirs(deploy_local, exist_ok=True)

        for conf_name in ('transforms.conf', 'props.conf'):
            src = os.path.join(source_local, conf_name)
            dst = os.path.join(deploy_local, conf_name)

            if os.path.isfile(src):
                shutil.copy2(src, dst)
                logger.info(f'Mirrored {conf_name} to {dst}')
            elif os.path.isfile(dst):
                # Source was cleared (filtering disabled) — remove from
                # deployment-apps too so the next push cleans up.
                os.remove(dst)
                logger.info(f'Removed {conf_name} from {dst} (filtering disabled)')

        return deploy_local

    except Exception as e:
        logger.error(f'Failed to mirror configs to deployment-apps: {e}', exc_info=True)
        return None


# ---------------------------------------------------------------------------
# Server class management
# ---------------------------------------------------------------------------

SERVERCLASS_NAME = 'SAP_LogServ_HeavyForwarders'


def ensure_serverclass(session_key):
    """
    Ensure a deployment server class exists for distributing the TA to
    heavy forwarders.

    Creates a **disabled** server class named
    ``SAP_LogServ_HeavyForwarders`` with the TA mapped as an app. The
    server class is created with ``disabled = true`` so that no deployment
    occurs until the admin configures client targeting (whitelist /
    machineTypesFilter) and enables it in Forwarder Management.

    This function is idempotent — if the server class already exists, no
    changes are made.

    This function should only be called after confirming the instance is a
    deployment server via :func:`is_deployment_server`.

    Args:
        session_key: Splunk session key for authentication.

    Returns:
        tuple: ``(created, message)`` where *created* is ``True`` if a new
        server class was created and *message* describes the outcome.
    """
    import splunk.rest as rest
    import json

    sc_endpoint = '/services/deployment/server/serverclasses'

    # --- Check if server class already exists ---
    try:
        response, content = rest.simpleRequest(
            f'{sc_endpoint}/{SERVERCLASS_NAME}',
            sessionKey=session_key,
            method='GET',
            getargs={'output_mode': 'json'},
        )
        if response.status == 200:
            logger.debug(
                f'Server class "{SERVERCLASS_NAME}" already exists — '
                f'no action needed.'
            )
            return False, 'Server class already exists.'
    except Exception:
        # 404 or other error means it doesn't exist — proceed to create
        pass

    # --- Create the server class ---
    try:
        response, content = rest.simpleRequest(
            sc_endpoint,
            sessionKey=session_key,
            method='POST',
            postargs={
                'name': SERVERCLASS_NAME,
                'output_mode': 'json',
            },
        )

        if response.status not in (200, 201):
            error_msg = f'HTTP {response.status}: {content}'
            logger.error(f'Failed to create server class: {error_msg}')
            return False, error_msg

        logger.info(
            f'Created server class "{SERVERCLASS_NAME}".'
        )
    except Exception as e:
        logger.error(f'Failed to create server class: {e}', exc_info=True)
        return False, str(e)

    # --- Disable the server class ---
    try:
        response, content = rest.simpleRequest(
            f'{sc_endpoint}/{SERVERCLASS_NAME}',
            sessionKey=session_key,
            method='POST',
            postargs={
                'disabled': 'true',
                'output_mode': 'json',
            },
        )
        if response.status not in (200, 201):
            logger.warning(
                f'Created server class but could not disable it: '
                f'HTTP {response.status}'
            )
    except Exception as e:
        logger.warning(f'Created server class but could not disable it: {e}')

    # --- Map the TA app to the server class ---
    # The REST API does not support creating app mappings via URL path,
    # so we append the stanza directly to the serverclass.conf file that
    # the REST API just created/updated.
    try:
        import glob

        app_stanza = (
            f'\n[serverClass:{SERVERCLASS_NAME}:app:{APP_NAME}]\n'
            f'restartSplunkd = true\n'
            f'stateOnClient = enabled\n'
        )

        # Find the serverclass.conf that the REST call created
        splunk_home = os.environ.get('SPLUNK_HOME', '')
        candidates = (
            glob.glob(
                os.path.join(splunk_home, 'etc', 'system', 'local', 'serverclass.conf')
            )
            + glob.glob(
                os.path.join(splunk_home, 'etc', 'apps', '*', 'local', 'serverclass.conf')
            )
        )

        sc_file = None
        for path in candidates:
            if os.path.isfile(path):
                with open(path, 'r') as f:
                    if SERVERCLASS_NAME in f.read():
                        sc_file = path
                        break

        if sc_file:
            # Only append if the app mapping doesn't already exist
            with open(sc_file, 'r') as f:
                existing = f.read()
            if f'app:{APP_NAME}' not in existing:
                with open(sc_file, 'a') as f:
                    f.write(app_stanza)
                logger.info(
                    f'Mapped {APP_NAME} to server class "{SERVERCLASS_NAME}" '
                    f'in {sc_file} (restartSplunkd=true, stateOnClient=enabled).'
                )
            else:
                logger.info(f'App mapping for {APP_NAME} already exists in {sc_file}.')
        else:
            logger.error('Could not find serverclass.conf with our server class.')
            return True, 'Server class created but could not find conf file for app mapping.'

    except Exception as e:
        logger.error(f'Failed to map app to server class: {e}', exc_info=True)
        return True, f'Server class created but app mapping failed: {e}'

    msg = (
        f'Created server class "{SERVERCLASS_NAME}" with '
        f'{APP_NAME} mapped. To deploy, open Forwarder Management, '
        f'add client targeting (e.g., whitelist), and enable the '
        f'server class.'
    )
    logger.info(msg)
    return True, msg
