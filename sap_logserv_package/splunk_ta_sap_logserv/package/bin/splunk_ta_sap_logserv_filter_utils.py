r"""
SAP LogServ TA - Filter Utility Functions

Shared utilities for:
- Discovering supported log types from @logserv_filter annotations in transforms.conf
- Validating the Filters-tab patterns: folder patterns (Include Filters /
  Exclude Filters, ``dir/subdir``) and source patterns (Include Sources /
  Exclude Sources: a pattern over the envelope's whole ``source`` value,
  optionally limited to one folder as ``dir/subdir=pattern``)
- Translating both kinds of pattern into index-time REGEX text with a
  hand-written translator whose output does not depend on the Python version
  (fnmatch.translate is never used: its output changed in Python 3.13 and its
  Python 3.14 output cannot be unwrapped)
- Comparing supported types against user include patterns to find uncovered types
- Generating transforms.conf and props.conf filter stanzas

These utilities are used by the REST handler (rh_filter_settings.py), the
daily time-filter refresh (logserv_filter_time_refresh.py), the upgrade check
(logserv_filter_upgrade_check.py) and, for APP_NAME and the deployment
helpers, the Deploy to Forwarders and S3 Direct REST handlers.  Nothing here
compiles a generated REGEX: it is text written to a conf file and run by
Splunk's PCRE (its possessive quantifiers and atomic groups need Python
3.11+ ``re``).

Generated REGEX shape (every generated filter stanza also sets
LOOKAHEAD = 100000, the TRUNCATE of default/props.conf, so the whole line is
searched, not only its first 4096 characters):

    SKIP          = (?:^|"_raw"\s*:\s*"(?:[^"\\]++|\\.)*+")
    LA(key, frag) = (?=(?:(?!"_raw")[^\n])*?"key"\s*:\s*"frag")
    f(p)          : split p on runs of * into segments S0 .. Sk (** is one *)
                    k = 0  -> seg(S0)
                    k >= 1 -> seg(S0) + (?>[^"]*?seg(Si)) for each MIDDLE
                              segment S1 .. S(k-1) + [^"]* + seg(Sk)
    seg(S)        : per character - ? -> [^"]   [A-Za-z0-9_] -> itself
                    any other allowed character c -> backslash + c
    folder   d/s    -> LA(clz_dir, f(d)) LA(clz_subdir, f(s))
    source   p      -> LA(source, f(p))
    combined d/s=p  -> LA(clz_dir, f(d)) LA(clz_subdir, f(s)) LA(source, f(p))
    REGEX of a chunk = SKIP + "(?:" + entries joined by "|" + ")"

The search starts at the line start (Azure and GCP envelopes put the metadata
keys before "_raw") or right after the "_raw" value (AWS envelopes put them
after it), and no lookahead may run past a "_raw" key, so text inside the
event itself is never matched.  Each middle segment of a pattern is matched
at its leftmost occurrence inside an atomic group, so only the last [^"]*
backtracks: the work grows linearly with the value's length however many *
the pattern has, which stays far inside PCRE's match limit on real source
values (see filter_pattern_fragment).  Example - Include Filters
linux/linux_secure:

    (?:^|"_raw"\s*:\s*"(?:[^"\\]++|\\.)*+")(?:(?=(?:(?!"_raw")[^\n])*?"clz_dir"\s*:\s*"linux")(?=(?:(?!"_raw")[^\n])*?"clz_subdir"\s*:\s*"linux_secure"))

Example - Exclude Sources /usr/sap/*/trace/*:

    (?:^|"_raw"\s*:\s*"(?:[^"\\]++|\\.)*+")(?:(?=(?:(?!"_raw")[^\n])*?"source"\s*:\s*"\/usr\/sap\/(?>[^"]*?\/trace\/)[^"]*"))
"""

import os
import re
import shutil
import logging
from fnmatch import fnmatchcase

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

# Markers for the Cloud Provider attribution override (separate feature, own
# marked block so it coexists with the filter block in the same local/ conf
# file — the section-aware writer only touches its own marker pair, and the
# daily time-filter refresh preserves any block outside the FILTER markers).
CLOUD_PROVIDER_MARKER_START = '### BEGIN LOGSERV CLOUD_PROVIDER CONFIG - DO NOT EDIT MANUALLY ###'
CLOUD_PROVIDER_MARKER_END = '### END LOGSERV CLOUD_PROVIDER CONFIG ###'

# ---------------------------------------------------------------------------
# Generated filter REGEX building blocks.  Byte-exact: the App's Data Doctor
# parses generated transforms.conf back into patterns and its build gate pins
# this shape - change these only together with that inverse.
# ---------------------------------------------------------------------------

# Where a filter REGEX starts looking: the line start, or just past the
# "_raw" value (possessive, as [set_raw_only] - the plain (?:[^"\\]|\\.)*
# nests one PCRE frame per character and exceeds DEPTH_LIMIT on long lines).
FILTER_REGEX_SKIP = r'(?:^|"_raw"\s*:\s*"(?:[^"\\]++|\\.)*+")'
# What a lookahead may cross before its key: anything on the line except a
# "_raw" key, so the event text is never searched for envelope keys.
FILTER_REGEX_GAP = r'(?:(?!"_raw")[^\n])*?'
# LOOKAHEAD of every generated filter stanza (= TRUNCATE in default/props.conf).
FILTER_LOOKAHEAD = 100000
# A list whose REGEX would pass this many characters is split into numbered
# stanzas (Splunk's PCRE compiled 80 combined entries = 12,765 characters;
# 16 K characters failed with "regular expression is too large").
FILTER_REGEX_MAX_CHARS = 8000

# Source patterns (Include Sources / Exclude Sources).
SOURCE_PATTERN_MAX_LEN = 512
SOURCE_FIELD_MAX_LEN = 4096
# The characters the two source fields accept in Splunk Web (the regex
# validator in globalConfig.json); the full grammar is checked server-side.
SOURCE_FIELD_UI_PATTERN = r'^[A-Za-z0-9/._:*?=,+@~ -]*$'


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
    A pass-all include list (see :func:`is_pass_all_include`) covers every
    type.  Matching is case-sensitive, as the generated REGEX is
    (``fnmatchcase``; ``fnmatch`` would fold case on Windows).  Include
    Sources are not considered: they keep some files of a folder, not a
    whole log type.

    Args:
        supported_types: Set of clz_dir/clz_subdir strings from annotations.
        include_patterns: List of folder pattern strings from user config.

    Returns:
        set[str]: Supported types that are not matched by any include pattern.
    """
    if is_pass_all_include(include_patterns):
        return set()

    uncovered = set()
    for log_type in supported_types:
        if not any(fnmatchcase(log_type, pat) for pat in include_patterns):
            uncovered.add(log_type)

    return uncovered


def parse_comma_patterns(pattern_string):
    """
    Parse a comma-separated string of folder patterns into a list.

    Used for Include Filters and Exclude Filters (the source fields use
    :func:`parse_source_patterns`, which keeps empty entries so they can be
    rejected).

    Args:
        pattern_string: Comma-separated patterns (e.g. ``'linux/*,hana/hanaaudit'``).

    Returns:
        list[str]: List of stripped, non-empty pattern strings.
    """
    if not pattern_string:
        return []
    return [p.strip() for p in pattern_string.split(',') if p.strip()]


def parse_source_patterns(value):
    """
    Split an Include Sources / Exclude Sources value into its entries.

    Only spaces around an entry are stripped; any other character (a tab, a
    newline, a control character) stays in the entry so that validation
    rejects it.  Empty entries are KEPT (as ``''``) so that a doubled,
    leading or trailing comma is rejected rather than silently dropped.  An
    empty value, or one of spaces only, means "no entries".

    Args:
        value: The field value as stored or submitted (``None`` = empty).

    Returns:
        list[str]: The entries in their original order (not de-duplicated).
    """
    if value is None:
        return []
    if not isinstance(value, str):
        value = str(value)
    if value.strip(' ') == '':
        return []
    return [entry.strip(' ') for entry in value.split(',')]


# ---------------------------------------------------------------------------
# Pattern validation
# ---------------------------------------------------------------------------

# Valid characters for dir/subdir segments: alphanumeric, wildcards, and . - : _
# (checked with fullmatch, so a trailing newline is rejected too).
VALID_SEGMENT_PATTERN = re.compile(r'^[a-zA-Z0-9*?._:\-]+$')

# Characters a source pattern may contain (the part after "=" in a combined
# entry, or the whole entry).  ASCII only; checked with fullmatch.
VALID_SOURCE_PATTERN = re.compile(r'[A-Za-z0-9/._:*?+@~\-]+')

# Characters a source entry may contain at all ("=" separates a folder).
_SOURCE_ENTRY_CHARS = frozenset(
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789/._:*?+@~-='
)


def validate_single_pattern(pattern):
    """
    Validate a single filter pattern.

    A valid pattern is either:
    - ``*`` (standalone wildcard: in Include Filters it makes the list
      pass-all, see :func:`is_pass_all_include`; in Exclude Filters it
      excludes nothing)
    - ``<dir>/<subdir>`` where dir and subdir contain only valid characters
      (alphanumeric, ``*``, ``?``, ``.``, ``-``, ``:``, ``_``)

    Segments are checked with fullmatch, so a trailing newline is rejected.

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

    if not VALID_SEGMENT_PATTERN.fullmatch(dir_part):
        return False, (
            f'Pattern "{pattern}" contains invalid characters in the '
            f'directory portion "{dir_part}". Allowed: letters, numbers, '
            f'* ? . - : _'
        )

    if not VALID_SEGMENT_PATTERN.fullmatch(subdir_part):
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


def _show(value, limit=80):
    """
    Render a submitted entry for an error message: printable ASCII as is,
    anything else as a backslash escape (``\\n``, ``\\x00``, ``\\xe9``),
    long values shortened.
    """
    shown = ''.join(ch if ' ' <= ch <= '~' else ascii(ch)[1:-1] for ch in value)
    if len(shown) > limit:
        shown = shown[:limit] + '...'
    return shown


def _source_entry_bad_character(entry):
    """Describe the first character a source entry may not contain, or None."""
    for ch in entry:
        code = ord(ch)
        if code < 32 or code == 127:
            return f'a control character ({ascii(ch)[1:-1]})'
        if code > 127:
            return f'a non-ASCII character ({ascii(ch)[1:-1]})'
        if ch == ' ':
            return 'a space'
        if ch not in _SOURCE_ENTRY_CHARS:
            return f'the character {ch}'
    return None


def validate_source_entry(entry):
    """
    Validate one Include Sources / Exclude Sources entry.

    Grammar (both fields)::

        entry   := srcpat | folder "=" srcpat
        folder  := dir "/" subdir      (as Include/Exclude Filters; no bare *)
        srcpat  := 1..512 of [A-Za-z0-9/._:*?+@~-], with at least one
                   character that is not * ? or /

    ``*`` matches any run of characters (including ``/``) and ``?`` one
    character, over the WHOLE source value, case-sensitively.  A pattern of
    only ``*``, ``?`` and ``/`` (``*``, ``**``, ``/*``, ``*/*``) would match
    every source and is rejected.  Quotes, backslashes, brackets, spaces,
    control characters and non-ASCII characters are rejected - the value is
    written into a conf file and into a REGEX.

    Args:
        entry: One entry (already split on commas, spaces stripped).

    Returns:
        tuple: (is_valid: bool, error_message: str or None).
    """
    if not isinstance(entry, str):
        return False, 'Entries must be text.'
    if entry == '':
        return False, (
            'Empty entry - remove the doubled, leading or trailing comma.'
        )
    bad = _source_entry_bad_character(entry)
    if bad:
        return False, (
            f'Entry "{_show(entry)}" contains {bad}. Allowed: letters, '
            f'numbers and / . _ : * ? + @ ~ - (plus one = after a folder, '
            f'as in linux/linux_secure=/var/log/zypper.log).'
        )
    if entry.count('=') > 1:
        return False, (
            f'Entry "{entry}" contains more than one "=". Use '
            f'dir/subdir=pattern, e.g. linux/linux_secure=/var/log/zypper.log.'
        )
    if '=' in entry:
        folder, pattern = entry.split('=', 1)
        if not folder:
            return False, (
                f'Entry "{entry}" has nothing before "=". Use '
                f'dir/subdir=pattern, or the source pattern alone.'
            )
        if folder == '*':
            return False, (
                f'Entry "{entry}": the folder before "=" must be dir/subdir '
                f'(e.g. linux/linux_secure or sap/*), not a bare *.'
            )
        is_valid, error = validate_single_pattern(folder)
        if not is_valid:
            return False, (
                f'Entry "{entry}": the folder before "=" is invalid. {error}'
            )
        if not pattern:
            return False, (
                f'Entry "{entry}" has nothing after "=". Add the source '
                f'pattern, e.g. {folder}=/var/log/messages.'
            )
    else:
        pattern = entry
    if len(pattern) > SOURCE_PATTERN_MAX_LEN:
        return False, (
            f'Entry "{_show(entry)}" has a source pattern longer than '
            f'{SOURCE_PATTERN_MAX_LEN} characters.'
        )
    if not VALID_SOURCE_PATTERN.fullmatch(pattern):
        return False, (
            f'Entry "{_show(entry)}" contains characters a source pattern '
            f'may not contain. Allowed: letters, numbers and / . _ : * ? + @ ~ -'
        )
    if all(ch in '*?/' for ch in pattern):
        return False, (
            f'Entry "{entry}" would match every source. Leave the field '
            f'empty, or use Include Filters / Exclude Filters (or turn '
            f'filtering off) instead.'
        )
    return True, None


def validate_source_patterns(patterns, field_name='Source pattern'):
    """
    Validate a list of source entries (from :func:`parse_source_patterns`).

    Args:
        patterns: List of entry strings.
        field_name: Human-readable field name for error messages
            (``'Include Sources'`` or ``'Exclude Sources'``).

    Returns:
        tuple: (is_valid: bool, error_message: str or None).
            If invalid, error_message names the field and the first invalid
            entry.
    """
    if not patterns:
        return True, None

    for pattern in patterns:
        is_valid, error = validate_source_entry(pattern)
        if not is_valid:
            return False, f'{field_name}: {error}'

    return True, None


def validate_source_field(value, field_name='Source pattern'):
    """
    Validate a whole Include Sources / Exclude Sources value as submitted or
    stored: its length, then every entry (:func:`validate_source_patterns`).
    An empty value is valid (no source rules).

    Returns:
        tuple: (is_valid: bool, error_message: str or None).
    """
    if value is None:
        return True, None
    if not isinstance(value, str):
        return False, f'{field_name}: the value must be text.'
    if len(value) > SOURCE_FIELD_MAX_LEN:
        return False, (
            f'{field_name}: the value must be at most '
            f'{SOURCE_FIELD_MAX_LEN} characters.'
        )
    return validate_source_patterns(parse_source_patterns(value), field_name)


# ---------------------------------------------------------------------------
# Pattern-to-regex translation for transforms.conf (hand-written; the output
# is the same on every Python version - see the module docstring for the shape)
# ---------------------------------------------------------------------------

_FRAGMENT_WORD_CHARS = frozenset(
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_'
)
# Every other character a folder or source pattern may contain; each is
# emitted backslash-escaped (a backslash before a non-alphanumeric character
# is always a literal in PCRE and in Python re).
_FRAGMENT_ESCAPED_CHARS = frozenset('/.-:+@~')

_LOOKAHEAD_KEYS = ('clz_dir', 'clz_subdir', 'source')


def _star_segments(pattern):
    """
    Split a pattern on runs of ``*`` into its segments S0 .. Sk, k being the
    number of runs (``**`` counts as one ``*``):
    ``'/usr/sap/*/trace/*'`` -> ``['/usr/sap/', '/trace/', '']``.
    Only the first and the last segment can be empty.
    """
    segments = [[]]
    in_run = False
    for ch in pattern:
        if ch == '*':
            if not in_run:
                segments.append([])
            in_run = True
        else:
            segments[-1].append(ch)
            in_run = False
    return [''.join(segment) for segment in segments]


def _fragment_segment(segment, pattern):
    """
    Translate one segment without ``*`` (design seg(S)), per character:
    ``?`` -> ``[^"]``, ``[A-Za-z0-9_]`` -> itself, ``/ . - : + @ ~`` ->
    backslash + character.

    Raises:
        ValueError: on any other character (the message names the whole
            ``pattern``).
    """
    out = []
    for ch in segment:
        if ch == '?':
            out.append('[^"]')
        elif ch in _FRAGMENT_WORD_CHARS:
            out.append(ch)
        elif ch in _FRAGMENT_ESCAPED_CHARS:
            out.append('\\' + ch)
        else:
            raise ValueError(
                f'cannot translate the character {ascii(ch)} in pattern '
                f'"{_show(pattern)}"'
            )
    return ''.join(out)


def filter_pattern_fragment(pattern):
    """
    Translate one folder segment or source pattern into the REGEX fragment
    that must match a JSON string value exactly (design f(p), with the
    linear ``*`` translation of design section 5b).

    The pattern is split on runs of ``*`` into segments S0 .. Sk
    (:func:`_star_segments`), each translated by :func:`_fragment_segment`.
    Without ``*`` the fragment is seg(S0); otherwise it is::

        seg(S0) (?>[^"]*?seg(S1)) ... (?>[^"]*?seg(S(k-1))) [^"]* seg(Sk)

    Each MIDDLE segment is matched at its leftmost occurrence inside an
    atomic group and never revisited, so only the last ``[^"]*`` backtracks
    and the match time grows linearly with the value's length however many
    ``*`` the pattern holds.  (One ``[^"]*`` per ``*`` backtracks about n^k
    steps on a value of length n that does not match, and Splunk's PCRE
    stops at its match limit.  At index time such a REGEX is expected to
    count as no match - not yet measured - so an Exclude rule would keep
    the event and an Include rule drop it.)  Leftmost placement is safe
    because every segment has a fixed length (``?`` included), so the
    matches are the glob's.  A pattern with no ``*`` or a single ``*`` gives
    the same text as one ``[^"]*`` per ``*``; a run such as ``**`` gives one
    ``[^"]*``.
    The wildcards never cross the closing quote of the value, so a match
    cannot run into the next key or into the event text.  Atomic groups
    need Python 3.11+ ``re``; nothing here compiles the result.

    Raises:
        ValueError: on an empty pattern or any character outside the
            grammar (callers validate first; this is the last line of
            defence).
    """
    if not isinstance(pattern, str) or not pattern:
        raise ValueError('cannot translate an empty pattern')
    segments = _star_segments(pattern)
    if len(segments) == 1:
        return _fragment_segment(pattern, pattern)
    out = [_fragment_segment(segments[0], pattern)]
    for middle in segments[1:-1]:
        out.append('(?>[^"]*?' + _fragment_segment(middle, pattern) + ')')
    out.append('[^"]*')
    out.append(_fragment_segment(segments[-1], pattern))
    return ''.join(out)


def filter_lookahead(key, fragment):
    """
    One condition of a generated REGEX: the JSON key ``key`` with a value
    matching ``fragment`` (from :func:`filter_pattern_fragment`), found
    without crossing a ``"_raw"`` key.
    """
    if key not in _LOOKAHEAD_KEYS:
        raise ValueError(f'unknown envelope key {key!r}')
    return '(?=' + FILTER_REGEX_GAP + '"' + key + '"\\s*:\\s*"' + fragment + '")'


def _folder_alternative(pattern):
    """The REGEX alternative of a validated ``dir/subdir`` folder pattern."""
    dir_part, subdir_part = pattern.split('/')
    return (filter_lookahead('clz_dir', filter_pattern_fragment(dir_part))
            + filter_lookahead('clz_subdir', filter_pattern_fragment(subdir_part)))


def _source_alternative(entry):
    """The REGEX alternative of a validated source entry (plain or combined)."""
    if '=' in entry:
        folder, pattern = entry.split('=', 1)
        return (_folder_alternative(folder)
                + filter_lookahead('source', filter_pattern_fragment(pattern)))
    return filter_lookahead('source', filter_pattern_fragment(entry))


def _as_folder_list(patterns):
    """Accept a list (the normal case) or a raw comma-separated string."""
    if patterns is None:
        return []
    if isinstance(patterns, str):
        return parse_comma_patterns(patterns)
    return list(patterns)


def _as_source_list(entries):
    """Accept a list (the normal case) or a raw field value."""
    if entries is None:
        return []
    if isinstance(entries, str):
        return parse_source_patterns(entries)
    return list(entries)


def _folder_alternatives(patterns, field_name):
    """
    Re-validate a folder pattern list and translate it.  A bare ``*`` adds no
    alternative (in Include Filters it makes the list pass-all, in Exclude
    Filters it excludes nothing).

    Returns:
        list[tuple[str, str]]: (pattern, REGEX alternative) pairs.

    Raises:
        ValueError: naming the field, on the first invalid pattern.
    """
    out = []
    for pattern in _as_folder_list(patterns):
        is_valid, error = validate_single_pattern(pattern)
        if not is_valid:
            raise ValueError(f'{field_name}: {error}')
        if pattern == '*':
            continue
        out.append((pattern, _folder_alternative(pattern)))
    return out


def _source_alternatives(entries, field_name):
    """
    Re-validate a source entry list and translate it.

    Returns:
        list[tuple[str, str]]: (entry, REGEX alternative) pairs.

    Raises:
        ValueError: naming the field, on the first invalid entry.
    """
    out = []
    for entry in _as_source_list(entries):
        is_valid, error = validate_source_entry(entry)
        if not is_valid:
            raise ValueError(f'{field_name}: {error}')
        out.append((entry, _source_alternative(entry)))
    return out


def _chunk_regexes(alternatives, field_name):
    """
    De-duplicate alternatives (first occurrence kept, order preserved) and
    join them into REGEX chunks of at most FILTER_REGEX_MAX_CHARS characters:
    a new chunk starts when adding an entry would take the REGEX past the
    limit.

    Raises:
        ValueError: if a single entry alone would pass the limit.
    """
    head = FILTER_REGEX_SKIP + '(?:'
    tail = ')'
    chunks = []
    current = []
    length = 0
    seen = set()
    for entry, alternative in alternatives:
        if alternative in seen:
            continue
        seen.add(alternative)
        alone = len(head) + len(alternative) + len(tail)
        if alone > FILTER_REGEX_MAX_CHARS:
            raise ValueError(
                f'{field_name}: entry "{_show(entry)}" is too long or has too '
                f'many wildcards (its rule would be {alone} characters; the '
                f'limit is {FILTER_REGEX_MAX_CHARS}). Shorten it.'
            )
        if current and length + 1 + len(alternative) <= FILTER_REGEX_MAX_CHARS:
            current.append(alternative)
            length += 1 + len(alternative)
        else:
            if current:
                chunks.append(current)
            current = [alternative]
            length = alone
    if current:
        chunks.append(current)
    return [head + '|'.join(chunk) + tail for chunk in chunks]


def fnmatch_patterns_to_combined_regex(patterns):
    """
    Compatibility helper (kept for existing importers): the REGEX matching
    any of the given folder patterns, as ONE string (no chunking), in the
    shape the generator uses.

    Args:
        patterns: List of ``dir/subdir`` folder pattern strings.

    Returns:
        str: The REGEX, or ``None`` if the list holds no ``dir/subdir`` pattern.

    Raises:
        ValueError: on an invalid pattern.
    """
    unique = []
    for _pattern, alternative in _folder_alternatives(patterns, 'Pattern'):
        if alternative not in unique:
            unique.append(alternative)
    if not unique:
        return None
    return FILTER_REGEX_SKIP + '(?:' + '|'.join(unique) + ')'


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

def is_pass_all_include(include_patterns):
    """
    Whether an Include Filters list keeps every event (no include gate).

    Pass-all when the list is empty or contains ANY ``*/*`` or bare ``*``
    entry (or a ``dir/subdir`` entry whose two segments are only ``*``
    characters, e.g. ``**/*``, which matches the same).  Another entry next
    to it does not narrow it: ``*/*, linux/cron`` and ``*, linux/cron`` keep
    everything, including events that carry no folder fields.  This is the
    Data Doctor's model.

    Args:
        include_patterns: List of folder pattern strings.

    Returns:
        bool: True if no include gate is generated.
    """
    if not include_patterns:
        return True
    for pattern in include_patterns:
        if not isinstance(pattern, str):
            continue
        if pattern == '*':
            return True
        parts = pattern.split('/')
        if (len(parts) == 2 and parts[0] and parts[1]
                and set(parts[0]) == {'*'} and set(parts[1]) == {'*'}):
            return True
    return False


# Kept for existing importers; same rule as is_pass_all_include.
_is_wildcard_include = is_pass_all_include


def parse_days_in_past(days_in_past):
    """
    Days in the Past as an int, read the same way by the REST handler (at
    save) and the daily refresh: ``None`` / ``''`` = 0, a whole number in
    any form the settings field accepts (``'7'``, ``'7.0'``, ``'1e1'``) =
    that number.  A value of 0 or less means no time filter.

    Raises:
        ValueError: naming Days in the Past, for anything that is not a
            finite whole number (``'7.5'``, ``'abc'``, ``'nan'``, ``'inf'``,
            a boolean).
    """
    if days_in_past is None or days_in_past == '':
        return 0
    if isinstance(days_in_past, bool):
        raise ValueError('Days in the Past must be a whole number.')
    try:
        return int(days_in_past)
    except (TypeError, ValueError, OverflowError):
        pass
    try:
        as_float = float(days_in_past)
    except (TypeError, ValueError):
        as_float = None
    if as_float is None or not math.isfinite(as_float) or as_float != int(as_float):
        raise ValueError(
            f'Days in the Past must be a whole number, not '
            f'"{_show(str(days_in_past))}".'
        )
    return int(as_float)


# Kept for existing callers; same function.
_days_value = parse_days_in_past


def _filter_plan(include_patterns, exclude_patterns, days_in_past,
                 include_sources, exclude_sources, warn=False):
    """
    The ordered list of generated filter stanzas, shared by both generators
    so props.conf references exactly the stanzas transforms.conf defines.

    Every entry of every list is re-validated first; nothing is built from
    an invalid value.

    Returns:
        list[tuple[str, str, str]]: (stanza name, REGEX, FORMAT) in
        ``TRANSFORMS-00-filter`` order.

    Raises:
        ValueError: naming the field and entry, on any invalid value.
    """
    include_patterns = _as_folder_list(include_patterns)
    include_alts = _folder_alternatives(include_patterns, 'Include Filters')
    exclude_alts = _folder_alternatives(exclude_patterns, 'Exclude Filters')
    include_source_alts = _source_alternatives(include_sources, 'Include Sources')
    exclude_source_alts = _source_alternatives(exclude_sources, 'Exclude Sources')
    days = parse_days_in_past(days_in_past)

    plan = []

    def add_chunks(name, alternatives, fmt, field_name):
        for number, regex in enumerate(_chunk_regexes(alternatives, field_name), 1):
            plan.append((name if number == 1 else f'{name}_{number}', regex, fmt))

    # Stages 1-3: the include gate - drop everything, then allow back the
    # included folders and the included sources.
    if not is_pass_all_include(include_patterns):
        plan.append(('logserv_filter_include_drop', '.', 'nullQueue'))
        add_chunks('logserv_filter_include_allow', include_alts,
                   'indexQueue', 'Include Filters')
        if include_source_alts:
            add_chunks('logserv_filter_include_sources', include_source_alts,
                       'indexQueue', 'Include Sources')
    elif include_source_alts and warn:
        logger.warning(
            'Include Sources is set but Include Filters keeps every log type '
            '(*/* or *), so there is no include gate: the Include Sources rule '
            'has no effect and was not generated.'
        )

    # Stage 4: time filter (overrides the allows for old events).
    if days > 0:
        cutoff = epoch_cutoff_from_days(days)
        if cutoff < 0:
            # (the epoch regex cannot express a cutoff before 1970)
            raise ValueError(
                f'Days in the Past is too large ({days}): the cutoff would '
                f'fall before 1970. Use a value between 0 and 3650.'
            )
        epoch_regex = generate_epoch_less_than_regex(cutoff)
        if epoch_regex:
            # Match "_time": VALUE in the raw JSON where VALUE < cutoff.
            # The JSON may quote the value or not:  "_time":1735689600.123
            # or "_time":"1735689600.123".  We anchor on the field name
            # and match the integer epoch portion.
            full_regex = f'"_time"\\s*:\\s*"?(?:{epoch_regex})(?:\\.\\d+)?'
            plan.append(('logserv_filter_time_drop', full_regex, 'nullQueue'))

    # Stages 5-6: excludes (always win over the allows).
    if exclude_alts:
        add_chunks('logserv_filter_exclude', exclude_alts,
                   'nullQueue', 'Exclude Filters')
    if exclude_source_alts:
        add_chunks('logserv_filter_exclude_sources', exclude_source_alts,
                   'nullQueue', 'Exclude Sources')

    # Last line of defence: every REGEX is one printable-ASCII conf line that
    # does not end in a backslash (a conf line continuation).
    for name, regex, _fmt in plan:
        if (not regex or regex.endswith('\\')
                or any(ord(ch) < 32 or ord(ch) > 126 for ch in regex)):
            raise ValueError(f'generated REGEX for [{name}] is not a single conf line')

    return plan


def generate_transforms_stanzas(include_patterns, exclude_patterns, days_in_past=0,
                                include_sources=None, exclude_sources=None):
    """
    Generate transforms.conf stanzas for the include, source, time and
    exclude filters.

    The include filter is an **active gate**: when Include Filters is not
    pass-all (:func:`is_pass_all_include`), every event is dropped to
    ``nullQueue`` and then allowed back if its folder matches an Include
    Filters pattern or its source matches an Include Sources entry.  The
    stanzas, in the order the last match wins::

        logserv_filter_include_drop     REGEX = .                 nullQueue   (include gate)
        logserv_filter_include_allow    REGEX = <folder includes> indexQueue  (include gate)
        logserv_filter_include_sources  REGEX = <source includes> indexQueue  (include gate + Include Sources)
        logserv_filter_time_drop        REGEX = <epoch < cutoff>  nullQueue   (days_in_past > 0)
        logserv_filter_exclude          REGEX = <folder excludes> nullQueue   (Exclude Filters)
        logserv_filter_exclude_sources  REGEX = <source excludes> nullQueue   (Exclude Sources)

    Each stanza is generated only when its condition holds.  A list whose
    REGEX would pass FILTER_REGEX_MAX_CHARS is split into chunks: the first
    keeps the plain name, chunk n >= 2 is ``<name>_<n>``.  Every stanza
    carries ``LOOKAHEAD = 100000`` so the whole line is searched.  Include
    Sources while Include Filters is pass-all is not generated (a WARNING is
    logged).  A bare ``*`` in Exclude Filters excludes nothing.

    Time-based filtering matches the ``"_time"`` epoch value in the raw JSON
    and routes old events to ``nullQueue`` in the TRANSFORMS phase, avoiding
    INGEST_EVAL (which requires a server-wide ``limits.conf`` setting that
    may not be available on Splunk Cloud).

    Args:
        include_patterns: List of Include Filters folder patterns.
        exclude_patterns: List of Exclude Filters folder patterns.
        days_in_past: Number of days; events older than this are dropped.
        include_sources: List of Include Sources entries (default none).
        exclude_sources: List of Exclude Sources entries (default none).

    Returns:
        str: transforms.conf stanza text, or empty string if nothing to generate.

    Raises:
        ValueError: if any entry of any list (or days_in_past) is invalid -
            the message names the field and the entry.  Nothing is generated
            from unvalidated input.
    """
    plan = _filter_plan(include_patterns, exclude_patterns, days_in_past,
                        include_sources, exclude_sources, warn=True)
    stanzas = []
    for name, regex, fmt in plan:
        stanzas.append(
            f'[{name}]\n'
            f'REGEX = {regex}\n'
            f'FORMAT = {fmt}\n'
            f'DEST_KEY = queue\n'
            f'LOOKAHEAD = {FILTER_LOOKAHEAD}\n'
        )
    return '\n'.join(stanzas)


def generate_props_filter_lines(include_patterns, exclude_patterns, days_in_past, filter_enabled,
                                include_sources=None, exclude_sources=None):
    """
    Generate the ``[sap_logserv_logs]`` props.conf stanza that references
    the filter transforms.

    All filtering (include/exclude gate, sources AND time-based) is done via
    TRANSFORMS, which run in the same pipeline phase as sourcetype routing.
    This avoids INGEST_EVAL (which requires ``allow_ingest_eval = true``
    in ``limits.conf`` — a server-wide setting unavailable on Splunk Cloud).

    All queue-setting transforms MUST be in a single ``TRANSFORMS-00-filter``
    line because Splunk does not reliably carry ``DEST_KEY = queue`` changes
    across separate ``TRANSFORMS-xx`` directives.  Within a single line,
    "last match wins" is guaranteed.

    The transform order within the line is::

        logserv_filter_include_drop     (default deny → nullQueue)
        logserv_filter_include_allow    (allow matching folders → indexQueue)
        logserv_filter_include_sources  (allow matching sources → indexQueue)
        logserv_filter_time_drop        (drop old events → nullQueue, overrides the allows)
        logserv_filter_exclude          (drop excluded folders → nullQueue, overrides the allows)
        logserv_filter_exclude_sources  (drop excluded sources → nullQueue, overrides the allows)

    Each name is present only when its stanza is generated (see
    :func:`generate_transforms_stanzas`; chunks ``<name>_<n>`` follow their
    first stanza).

    Args:
        include_patterns: List of Include Filters folder patterns.
        exclude_patterns: List of Exclude Filters folder patterns.
        days_in_past: Number of days; events older than this are dropped.
        filter_enabled: Whether filtering is enabled at all.
        include_sources: List of Include Sources entries (default none).
        exclude_sources: List of Exclude Sources entries (default none).

    Returns:
        str: props.conf ``[sap_logserv_logs]`` stanza content, or empty string.

    Raises:
        ValueError: as :func:`generate_transforms_stanzas`, when filtering
            is enabled.
    """
    if not filter_enabled:
        return ''

    plan = _filter_plan(include_patterns, exclude_patterns, days_in_past,
                        include_sources, exclude_sources)
    if not plan:
        return ''

    transform_refs = [name for name, _regex, _fmt in plan]
    lines = [
        '[sap_logserv_logs]',
        f'TRANSFORMS-00-filter = {", ".join(transform_refs)}',
    ]
    return '\n'.join(lines) + '\n'


def write_local_conf_section(app_path, conf_name, content,
                             marker_start=FILTER_MARKER_START,
                             marker_end=FILTER_MARKER_END):
    """
    Write generated content into a marked section of a local/ conf file.

    Content is wrapped in the given marker comments so it can be identified
    and replaced on subsequent saves without disturbing other local/
    customisations — including OTHER marked sections written by a different
    feature (e.g. the Cloud Provider override coexists with the filter
    block because each uses its own marker pair).

    If ``content`` is empty, any existing section for THIS marker pair is
    removed; sections written under other marker pairs are preserved.

    Args:
        app_path: Path to the app directory.
        conf_name: Conf file name without extension (e.g. ``'transforms'``).
        content: The stanza text to write, or empty string to clear.
        marker_start: Section-begin marker comment.
        marker_end: Section-end marker comment.

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

    # Remove any previous section for THIS marker pair only
    marker_pattern = re.compile(
        re.escape(marker_start) + r'.*?' + re.escape(marker_end),
        re.DOTALL,
    )
    cleaned = marker_pattern.sub('', existing).strip()

    # Build new file content
    parts = []
    if cleaned:
        parts.append(cleaned)

    if content:
        marked_content = (
            f'{marker_start}\n'
            f'{content}\n'
            f'{marker_end}'
        )
        parts.append(marked_content)

    final = '\n\n'.join(parts) + '\n' if parts else ''

    with open(conf_path, 'w') as f:
        f.write(final)

    logger.info(f'Wrote conf section to {conf_path} (marker={marker_start[:40]}...)')
    return conf_path


def write_local_conf(app_path, conf_name, content):
    """
    Backward-compatible wrapper that writes the FILTER marked section.

    Existing callers (filter REST handler + daily time refresh) use this
    signature and expect the FILTER markers — preserved exactly.

    Args:
        app_path: Path to the app directory.
        conf_name: Conf file name without extension (e.g. ``'transforms'``).
        content: The stanza text to write, or empty string to clear.

    Returns:
        str: Path to the written file.
    """
    return write_local_conf_section(
        app_path, conf_name, content,
        FILTER_MARKER_START, FILTER_MARKER_END,
    )


def update_local_stanza(app_path, conf_name, stanza, kv):
    """Set key/value pairs under [stanza] in local/<conf_name>.conf via a
    plain FILESYSTEM write, preserving every other stanza.

    This is the filesystem fallback used when splunktaucclib's REST-based
    settings persist is forbidden (Splunk Cloud Victoria sc_subadmin lacks
    admin_all_objects for configs/conf-* writes). A filesystem write by the
    splunkd handler process is not subject to that REST capability gate.

    Keys present in ``kv`` are replaced in-place (or appended if new);
    existing keys not in ``kv`` are left untouched; other stanzas are
    preserved verbatim.

    Args:
        app_path: Path to the app directory.
        conf_name: Conf file name without extension (e.g. the settings conf).
        stanza: Stanza name (without brackets), e.g. 'filter_settings'.
        kv: dict of {key: value} to write under the stanza.

    Returns:
        str: Path to the written conf file.
    """
    local_dir = os.path.join(app_path, 'local')
    os.makedirs(local_dir, exist_ok=True)
    conf_path = os.path.join(local_dir, f'{conf_name}.conf')

    lines = []
    if os.path.isfile(conf_path):
        with open(conf_path, 'r') as f:
            lines = f.readlines()

    target = f'[{stanza}]'
    remaining = dict(kv)
    out = []
    i = 0
    n = len(lines)
    found = False
    while i < n:
        line = lines[i]
        if line.strip() == target:
            found = True
            out.append(line)
            i += 1
            # Walk the stanza body (until the next stanza header or EOF).
            while i < n and not lines[i].lstrip().startswith('['):
                body_line = lines[i]
                if '=' in body_line and not body_line.lstrip().startswith('#'):
                    key = body_line.split('=', 1)[0].strip()
                    if key in remaining:
                        out.append(f'{key} = {remaining.pop(key)}\n')
                    else:
                        out.append(body_line)
                else:
                    out.append(body_line)
                i += 1
            # Append any keys that weren't already present in the stanza.
            for k, v in remaining.items():
                out.append(f'{k} = {v}\n')
            remaining = {}
        else:
            out.append(line)
            i += 1

    if not found:
        if out and out[-1].strip() != '':
            out.append('\n')
        out.append(f'{target}\n')
        for k, v in kv.items():
            out.append(f'{k} = {v}\n')

    with open(conf_path, 'w') as f:
        f.writelines(out)

    logger.info(f'Updated local stanza [{stanza}] in {conf_path} (filesystem)')
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
