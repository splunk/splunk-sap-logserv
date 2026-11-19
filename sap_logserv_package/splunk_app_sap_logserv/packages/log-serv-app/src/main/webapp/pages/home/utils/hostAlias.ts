/**
 * Host names (aliases) - the customer's own names for hosts (App build 400).
 *
 * An admin keeps a table, Settings > Host Names, that maps a raw host value (a
 * fully qualified name, a short name or an IP address) to a name of their own.
 * The dashboards show that name ON SCREEN ONLY: tables, host lists and the Host
 * filter list show it next to the raw value; the per-host charts, the two
 * Sourcetype Mapping link graphs and the Host filter button with one host
 * picked show it alone (aliasDisplayNames adds a short raw form only where two
 * names would collide). Every search, filter, sort, row click, Open in Search,
 * panel CSV download and click-through search keeps the raw value, and no alias
 * is ever written into SPL, a rollup or anything sent to the AI Assistant's
 * vendor. So an alias edit needs no Clear or Backfill.
 *
 * Storage: the KV collection logserv_host_aliases (utils/hostAliasApi.ts), one
 * row per match value, `_key` = keyForMatchValue(match_value). Admin-tier write,
 * read by every role (metadata/default.meta). Rows are sanitized on read.
 *
 * Matching (resolveAlias), after normalizeHostValue, the first rule that applies
 * wins:
 *   (a) an IP address matches only the entry for that address (IPv4, or IPv6 in
 *       its canonical form; an IPv4-mapped IPv6 address is its IPv4 address).
 *       An IP is never folded to a short name: 192.0.2.10 never matches "192".
 *   (b) an exact match on the whole value (case and one trailing dot ignored);
 *   (c) a dotted host name: its first DNS label matches an entry entered
 *       WITHOUT a dot (an entry "app01" covers "app01.example.com");
 *   (d) a short name: the entry entered without a dot (rule b), else the alias
 *       of the entries entered as a dotted name whose first label it is, when
 *       they all carry ONE alias; different aliases there mean no alias
 *       (suppress over guess, as topology/enrichment.ts does);
 *   (e) values that are not host names or IP addresses get none: empty, "-",
 *       "(none)", "unknown", "N/A" and the like, URLs, host:port, values with
 *       spaces or "/".
 * No wildcards and no CIDR ranges.
 *
 * GATE-SAFE MODULE: no @splunk or React imports, nothing executes at import
 * time - utils/hostAlias.consistency-test.ts loads it directly. The character
 * checks compare code points on purpose (decoded from the UTF-16 units, no
 * regular expression property classes): no control characters in this source.
 */

/** One row of the host name table. */
export interface HostAliasRow {
    /** keyForMatchValue(match_value): one alias per normalized value. */
    _key: string;
    /** The host value as entered (trimmed): a host name, a short name or an IP address. */
    match_value: string;
    /** The customer's name for it. */
    alias: string;
    description?: string;
    /** Epoch seconds of the last write. */
    updated_at?: number;
    /** The Splunk user who wrote the row last. */
    updated_by?: string;
    /** Set by sanitizeAliasRow only when the stored row's `_key` is not the key its
     *  match value derives (a row written outside the App, or by a build that
     *  normalized differently). `_key` is always the derived key, so matching and
     *  upserts use it; a delete must use `stored_key ?? _key`, the row's real key. */
    stored_key?: string;
}

/** The most rows the App reads, imports or writes in one call. */
export const MAX_ROWS = 5000;
export const MAX_MATCH_LEN = 255;
export const MAX_ALIAS_LEN = 64;
export const MAX_DESC_LEN = 256;
/** updated_by: a Splunk user name. */
const MAX_USER_LEN = 256;
/** A stored `_key` longer than this is not one the App could have written. */
const MAX_KEY_LEN = 1024;

/* ------------------------------------------------------------------ */
/* Characters                                                          */
/* ------------------------------------------------------------------ */

/** Characters (code points) none of an alias, a description or a match value may
 *  hold:
 *  - C0 and C1 controls and DEL;
 *  - the Unicode direction marks and embeddings (U+061C, U+200E, U+200F,
 *    U+202A-U+202E, U+2066-U+2069) and the line and paragraph separators
 *    (U+2028, U+2029): a direction override can make a name read as another one;
 *  - every format character (general category Cf, Unicode 16) and every other
 *    default-ignorable code point except the grapheme joiner U+034F and the
 *    variation selectors U+FE00-U+FE0F (marks isBlankAlone lists, which a name
 *    may hold after a character that shows): they draw nothing, a blank or a
 *    sign over the next characters, so "Pay" + U+200B + "roll" or "Pay" +
 *    U+E0020 + "roll" would look like "Payroll", a name of them
 *    alone would look empty, and the tag characters can carry hidden text. They
 *    are the soft hyphen U+00AD, the Arabic and Syriac signs U+0600-U+0605,
 *    U+06DD, U+070F, U+0890, U+0891 and U+08E2, the Hangul fillers U+115F,
 *    U+1160, U+3164 and U+FFA0, the Khmer inherent vowels U+17B4 and U+17B5,
 *    the Mongolian variation selectors and vowel separator U+180B-U+180F, the
 *    zero-width space, non-joiner and joiner (U+200B-U+200D), the rest of the
 *    U+2060-U+206F block (the word joiner, the invisible operators and the
 *    deprecated format controls), U+FEFF anywhere (trim() removes it only at
 *    the ends), U+FFF0-U+FFFB (the interlinear annotation controls among them),
 *    the Kaithi number signs U+110BD and U+110CD, the Egyptian hieroglyph format
 *    controls U+13430-U+1343F, the shorthand format controls U+1BCA0-U+1BCA3,
 *    the musical format characters U+1D173-U+1D17A and the whole block
 *    U+E0000-U+E0FFF (the tag characters and the variation selectors
 *    supplement among them).
 *  The checks below read the text by code point, so a character outside the
 *  Basic Multilingual Plane (two UTF-16 units) is checked as itself. */
const isForbiddenCode = (c: number): boolean =>
    c < 0x20 ||
    (c >= 0x7f && c <= 0x9f) ||
    c === 0x00ad ||
    (c >= 0x0600 && c <= 0x0605) ||
    c === 0x061c ||
    c === 0x06dd ||
    c === 0x070f ||
    c === 0x0890 ||
    c === 0x0891 ||
    c === 0x08e2 ||
    c === 0x115f ||
    c === 0x1160 ||
    c === 0x17b4 ||
    c === 0x17b5 ||
    (c >= 0x180b && c <= 0x180f) ||
    (c >= 0x200b && c <= 0x200f) ||
    (c >= 0x202a && c <= 0x202e) ||
    (c >= 0x2060 && c <= 0x206f) ||
    c === 0x2028 ||
    c === 0x2029 ||
    c === 0x3164 ||
    c === 0xfeff ||
    c === 0xffa0 ||
    (c >= 0xfff0 && c <= 0xfffb) ||
    c === 0x110bd ||
    c === 0x110cd ||
    (c >= 0x13430 && c <= 0x1343f) ||
    (c >= 0x1bca0 && c <= 0x1bca3) ||
    (c >= 0x1d173 && c <= 0x1d17a) ||
    (c >= 0xe0000 && c <= 0xe0fff);

/** The code point that starts at UTF-16 index `i` of `s`: a surrogate pair as the
 *  one character it encodes, a lone surrogate as itself. */
const codePointAt = (s: string, i: number): number => {
    const hi = s.charCodeAt(i);
    if (hi >= 0xd800 && hi <= 0xdbff && i + 1 < s.length) {
        const lo = s.charCodeAt(i + 1);
        if (lo >= 0xdc00 && lo <= 0xdfff) {
            return (hi - 0xd800) * 0x400 + (lo - 0xdc00) + 0x10000;
        }
    }
    return hi;
};

/** The UTF-16 length of code point `c`: 2 outside the Basic Multilingual Plane. */
const unitsOf = (c: number): number => (c > 0xffff ? 2 : 1);

/** True when `s` holds a character isForbiddenCode refuses (read by code point). */
export const hasForbiddenChars = (s: string): boolean => {
    for (let i = 0; i < s.length; ) {
        const c = codePointAt(s, i);
        if (isForbiddenCode(c)) {
            return true;
        }
        i += unitsOf(c);
    }
    return false;
};

/** Marks that draw nothing on their own, though they may follow a character that
 *  shows: the combining diacritics (U+0300-U+036F, the grapheme joiner U+034F
 *  among them), every variation selector (U+FE00-U+FE0F; the Mongolian ones,
 *  U+180B-U+180D and U+180F, and the supplement, U+E0100-U+E01EF) and the blank
 *  Braille pattern (U+2800). hasVisibleChar asks isForbiddenCode first, and
 *  isForbiddenCode refuses the Mongolian selectors and the supplement anywhere in
 *  a name today (owner decision), so their entries below are reached only if
 *  isForbiddenCode is ever eased. */
const isBlankAlone = (c: number): boolean =>
    (c >= 0x0300 && c <= 0x036f) ||
    // U+180B-U+180D and U+180F: reached only if isForbiddenCode is ever eased (it refuses them anywhere in a name
    // today, by owner decision).
    (c >= 0x180b && c <= 0x180d) ||
    c === 0x180f ||
    (c >= 0xfe00 && c <= 0xfe0f) ||
    // U+E0100-U+E01EF: reached only if isForbiddenCode is ever eased (it refuses the whole block U+E0000-U+E0FFF
    // anywhere in a name today, by owner decision).
    (c >= 0xe0100 && c <= 0xe01ef) ||
    c === 0x2800;

/** True when `s` holds a character that shows (read by code point): not
 *  whitespace, not one isForbiddenCode refuses and not a mark that draws nothing
 *  alone. An alias needs one, so a name never shows as a blank in front of the
 *  raw value. */
export const hasVisibleChar = (s: string): boolean => {
    for (let i = 0; i < s.length; ) {
        const c = codePointAt(s, i);
        const units = unitsOf(c);
        if (!isForbiddenCode(c) && !isBlankAlone(c) && !(units === 1 && /\s/.test(s.charAt(i)))) {
            return true;
        }
        i += units;
    }
    return false;
};

/** Text an alias, a description or updated_by may hold: 1..maxLen characters,
 *  no forbidden character and no angle bracket (React escapes markup anyway;
 *  the bracket check is belt and braces, as in topology/enrichment.ts). */
const isCleanText = (s: string, maxLen: number): boolean =>
    s.length > 0 && s.length <= maxLen && !hasForbiddenChars(s) && s.indexOf('<') === -1 && s.indexOf('>') === -1;

/* ------------------------------------------------------------------ */
/* Normalizing and parsing                                             */
/* ------------------------------------------------------------------ */

/** A string or a finite number as text; anything else (null, a multivalue
 *  array, an object) as ''. */
const asText = (v: unknown): string => {
    if (typeof v === 'string') {
        return v;
    }
    return typeof v === 'number' && Number.isFinite(v) ? String(v) : '';
};

/** Trimmed, lower case, ONE trailing dot removed ("App01.Example.com." ->
 *  "app01.example.com"). Not a string or a number: ''. */
export const normalizeHostValue = (v: unknown): string => {
    const t = asText(v).trim().toLowerCase();
    return t.charAt(t.length - 1) === '.' ? t.slice(0, -1) : t;
};

/** Four decimal octets of 1-3 digits, each at most 255. Leading zeros are read
 *  as decimal ("010" is 10), never octal. */
const parseIpv4Octets = (s: string): number[] | null => {
    const parts = s.split('.');
    if (parts.length !== 4) {
        return null;
    }
    const out: number[] = [];
    for (let i = 0; i < parts.length; i += 1) {
        if (!/^[0-9]{1,3}$/.test(parts[i])) {
            return null;
        }
        const n = Number(parts[i]);
        if (n > 255) {
            return null;
        }
        out.push(n);
    }
    return out;
};

/** The eight 16-bit groups of an RFC 4291 text form: one "::" at most, an
 *  optional dotted IPv4 tail, lower-case hex only (the caller lower-cases). A
 *  zone id ("%eth0"), brackets, a prefix length ("/64") or a port are refused. */
const parseIpv6Groups = (s: string): number[] | null => {
    if (s.length < 2 || s.length > 45 || !/^[0-9a-f:.]+$/.test(s)) {
        return null;
    }
    let text = s;
    const lastColon = text.lastIndexOf(':');
    if (lastColon === -1) {
        return null;
    }
    const tail = text.slice(lastColon + 1);
    if (tail.indexOf('.') !== -1) {
        const v4 = parseIpv4Octets(tail);
        if (!v4) {
            return null;
        }
        const hi = (v4[0] * 256 + v4[1]).toString(16);
        const lo = (v4[2] * 256 + v4[3]).toString(16);
        text = `${text.slice(0, lastColon + 1)}${hi}:${lo}`;
    }
    if (text.indexOf('.') !== -1) {
        return null;
    }
    const gap = text.indexOf('::');
    if (gap !== -1 && text.indexOf('::', gap + 1) !== -1) {
        return null;
    }
    let parts: string[];
    if (gap === -1) {
        parts = text.split(':');
        if (parts.length !== 8) {
            return null;
        }
    } else {
        const left = text.slice(0, gap);
        const right = text.slice(gap + 2);
        const l = left === '' ? [] : left.split(':');
        const r = right === '' ? [] : right.split(':');
        if (l.length + r.length > 7) {
            return null;
        }
        const zeros: string[] = [];
        for (let i = l.length + r.length; i < 8; i += 1) {
            zeros.push('0');
        }
        parts = l.concat(zeros, r);
    }
    const groups: number[] = [];
    for (let i = 0; i < parts.length; i += 1) {
        if (!/^[0-9a-f]{1,4}$/.test(parts[i])) {
            return null;
        }
        groups.push(parseInt(parts[i], 16));
    }
    return groups;
};

/** RFC 5952: lower-case hex without leading zeros, the longest run of two or
 *  more zero groups (the first on a tie) written "::". */
const formatIpv6 = (groups: number[]): string => {
    let bestStart = -1;
    let bestLen = 0;
    let runStart = -1;
    for (let i = 0; i <= groups.length; i += 1) {
        if (i < groups.length && groups[i] === 0) {
            if (runStart === -1) {
                runStart = i;
            }
        } else if (runStart !== -1) {
            const len = i - runStart;
            if (len > bestLen && len >= 2) {
                bestStart = runStart;
                bestLen = len;
            }
            runStart = -1;
        }
    }
    const hex = groups.map((g) => g.toString(16));
    if (bestStart === -1) {
        return hex.join(':');
    }
    const head = hex.slice(0, bestStart).join(':');
    const rest = hex.slice(bestStart + bestLen).join(':');
    return `${head}::${rest}`;
};

/**
 * The canonical text of an IP address, or null when `v` is not one.
 *
 * Strict: the value is trimmed and lower-cased, nothing more. IPv4 is four
 * decimal octets (0-255, written without leading zeros in the result); IPv6 is
 * any RFC 4291 text form, written in the RFC 5952 form. An IPv4-mapped IPv6
 * address (::ffff:192.0.2.10, ::ffff:c000:20a) is its IPv4 address. A URL,
 * host:port, a value with "/" or a space, a zone id or brackets is not an IP.
 */
export const parseIp = (v: unknown): string | null => {
    const s = asText(v).trim().toLowerCase();
    if (s.length === 0) {
        return null;
    }
    const v4 = parseIpv4Octets(s);
    if (v4) {
        return v4.join('.');
    }
    if (s.indexOf(':') === -1) {
        return null;
    }
    const g = parseIpv6Groups(s);
    if (!g) {
        return null;
    }
    const mapped = g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0xffff;
    if (mapped) {
        return [Math.floor(g[6] / 256), g[6] % 256, Math.floor(g[7] / 256), g[7] % 256].join('.');
    }
    return formatIpv6(g);
};

/** Values that stand for "no host". Compared after normalizeHostValue; "(none)",
 *  "N/A" and "-" fail the host name pattern anyway. */
const PLACEHOLDERS: ReadonlyArray<string> = ['unknown', 'none', 'null', 'nil', 'undefined'];

/** A host name after normalizing: letters, digits, '.', '_' and '-', starting
 *  with a letter, a digit or '_' (so no CSV cell of one needs a formula guard). */
const HOSTNAME_RE = /^[a-z0-9_][a-z0-9._-]*$/;

/**
 * True when `v` can carry an alias: an IP address (parseIp), or a host name made
 * only of [A-Za-z0-9._-], at most MAX_MATCH_LEN characters, whose labels are all
 * non-empty and hold a letter or a digit. Never: empty, a placeholder, a value
 * of digits and dots that is not an IPv4 address ("1.2.3.256", "10"), a URL,
 * host:port, or a value with a space.
 */
export const isAliasableValue = (v: unknown): boolean => {
    const n = normalizeHostValue(v);
    if (n.length === 0 || n.length > MAX_MATCH_LEN) {
        return false;
    }
    if (parseIp(n) !== null) {
        return true;
    }
    if (PLACEHOLDERS.indexOf(n) !== -1 || !HOSTNAME_RE.test(n) || /^[0-9.]+$/.test(n)) {
        return false;
    }
    return n.split('.').every((label) => /[a-z0-9]/.test(label));
};

/** The row key for a match value: the normalized value, for an IP address its
 *  canonical text. null when the value cannot carry an alias. */
export const keyForMatchValue = (v: unknown): string | null => {
    if (!isAliasableValue(v)) {
        return null;
    }
    const n = normalizeHostValue(v);
    const ip = parseIp(n);
    return ip === null ? n : ip;
};

/**
 * True when `key` may be sent as a row key in a DELETE. An empty key would
 * address the collection itself, and "." or ".." are resolved by the browser's
 * URL parser to the collection or its parent, so a DELETE with one would
 * delete EVERY row. Refused:
 *  - an empty key, and a key of dots and blanks only;
 *  - a key holding a slash, a backslash, a percent sign, a question mark, a
 *    number sign or a semicolon. The key is sent encoded ("x/.." as "x%2F..",
 *    "?" as "%3F"), but if a proxy between the browser and the KV Store decoded
 *    it before routing, "x/.." would address the collection, "a%2Fb" decoded
 *    twice would be "a/b", and a "?", "#" or ";" would end the path there (the
 *    rest read as a query, a fragment or path parameters), leaving the
 *    collection URL. Splunk Web's own proxy encodes them again; this guard does
 *    not rely on it;
 *  - a key any of whose path segments (split on slashes and backslashes) is
 *    dots and blanks only, so this rule holds even if the one above is eased;
 *  - a key with a forbidden character (a control, direction or invisible
 *    character: hasForbiddenChars) or longer than any the App writes (1,024
 *    characters).
 * A key the App derives never holds any of these, so only a row written outside
 * the App can be refused; the editor shows such a row as one it cannot delete.
 */
export const isDeletableKey = (key: unknown): boolean =>
    typeof key === 'string' &&
    key.length <= MAX_KEY_LEN &&
    !/[/\\%?#;]/.test(key) &&
    key.split(/[/\\]/).every((segment) => !/^[.\s]*$/.test(segment)) &&
    !hasForbiddenChars(key);

/* ------------------------------------------------------------------ */
/* Sanitize on read                                                    */
/* ------------------------------------------------------------------ */

/** The latest epoch second a JavaScript Date can hold (8.64e15 milliseconds, in
 *  the year 275760). A larger updated_at (one written in microseconds or
 *  nanoseconds outside the App, say) is no time a Date can format. */
const MAX_EPOCH_SECONDS = 8.64e12;

/** updated_at as epoch seconds: a positive finite number, or a string of one, at
 *  most MAX_EPOCH_SECONDS; null otherwise. */
const epochOf = (v: unknown): number | null => {
    let n = NaN;
    if (typeof v === 'number') {
        n = v;
    } else if (typeof v === 'string' && v.trim() !== '') {
        n = Number(v);
    }
    return Number.isFinite(n) && n > 0 && n <= MAX_EPOCH_SECONDS ? n : null;
};

/**
 * An epoch in seconds (updated_at) as ISO 8601 text for a title, such as
 * "2024-11-15T19:46:40.000Z", or null when it is no valid time: not a positive
 * number (or a string of one), above MAX_EPOCH_SECONDS, or a Date that does not
 * hold it. Never throws (Date.prototype.toISOString throws on an invalid date).
 */
export const isoOfEpoch = (epoch: unknown): string | null => {
    const sec = epochOf(epoch);
    if (sec === null) {
        return null;
    }
    const d = new Date(sec * 1000);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

/**
 * A row as the App may use it, or null.
 *
 * Refused (null): not an object; match_value missing, empty, longer than
 * MAX_MATCH_LEN, holding a forbidden character, or not a host name or an IP
 * address (isAliasableValue); alias missing, empty, longer than MAX_ALIAS_LEN,
 * holding a forbidden character or '<' / '>', or with no character that shows
 * (hasVisibleChar); a description that is not a
 * string, is longer than MAX_DESC_LEN or holds those characters. Text fields are
 * trimmed. updated_at (a positive number of epoch seconds, at most
 * MAX_EPOCH_SECONDS, so a Date can format it) and updated_by (clean text) are
 * kept when valid and dropped otherwise; they never refuse a row.
 *
 * `_key` is always DERIVED from match_value (keyForMatchValue). A stored `_key`
 * that disagrees is not trusted for matching: the row keeps the derived key, and
 * the stored one is returned as `stored_key` so the editor can still delete it.
 */
export const sanitizeAliasRow = (raw: unknown): HostAliasRow | null => {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
        return null;
    }
    const r = raw as Record<string, unknown>;
    if (typeof r.match_value !== 'string' || typeof r.alias !== 'string') {
        return null;
    }
    const matchValue = r.match_value.trim();
    if (matchValue.length === 0 || matchValue.length > MAX_MATCH_LEN || hasForbiddenChars(matchValue)) {
        return null;
    }
    const key = keyForMatchValue(matchValue);
    if (key === null) {
        return null;
    }
    const alias = r.alias.trim();
    if (!isCleanText(alias, MAX_ALIAS_LEN) || !hasVisibleChar(alias)) {
        return null;
    }
    const row: HostAliasRow = { _key: key, match_value: matchValue, alias };
    if (r.description !== undefined && r.description !== null) {
        if (typeof r.description !== 'string') {
            return null;
        }
        const description = r.description.trim();
        if (description.length > 0) {
            if (!isCleanText(description, MAX_DESC_LEN)) {
                return null;
            }
            row.description = description;
        }
    }
    const at = epochOf(r.updated_at);
    if (at !== null) {
        row.updated_at = at;
    }
    if (typeof r.updated_by === 'string' && isCleanText(r.updated_by.trim(), MAX_USER_LEN)) {
        row.updated_by = r.updated_by.trim();
    }
    const { _key: stored } = r;
    if (typeof stored === 'string' && stored.length > 0 && stored !== key) {
        row.stored_key = stored;
    }
    return row;
};

/* ------------------------------------------------------------------ */
/* The index and the match rules                                       */
/* ------------------------------------------------------------------ */

/** What resolveAlias reads. Build it once per load with buildAliasIndex. */
export interface HostAliasIndex {
    /** key -> alias: every key with one alias. */
    readonly exact: ReadonlyMap<string, string>;
    /** Entries entered without a dot (host names, not IPs): key -> alias. */
    readonly short: ReadonlyMap<string, string>;
    /** Entries entered as a dotted host name: first label -> their aliases. */
    readonly byFirstLabel: ReadonlyMap<string, ReadonlyArray<string>>;
    /** Number of keys with an alias. */
    readonly size: number;
}

export const EMPTY_ALIAS_INDEX: HostAliasIndex = {
    exact: new Map<string, string>(),
    short: new Map<string, string>(),
    byFirstLabel: new Map<string, ReadonlyArray<string>>(),
    size: 0,
};

interface Candidate {
    alias: string;
    /** 1 for a row stored under its derived key, 0 for one that is not. */
    canonical: number;
    at: number;
    conflict: boolean;
}

/**
 * The index of a set of rows. Every row is sanitized again (invalid rows are
 * skipped). Two rows with one key (a row stored under a foreign key, see
 * sanitizeAliasRow) are settled in this order: the row stored under its
 * derived key wins, then the later updated_at; two equal rows with different
 * aliases give that key NO alias.
 */
export const buildAliasIndex = (rows: ReadonlyArray<unknown>): HostAliasIndex => {
    const best = new Map<string, Candidate>();
    rows.forEach((input) => {
        const row = sanitizeAliasRow(input);
        if (row === null) {
            return;
        }
        const foreign =
            row.stored_key !== undefined ||
            (typeof input === 'object' && input !== null && typeof (input as HostAliasRow).stored_key === 'string');
        const next: Candidate = { alias: row.alias, canonical: foreign ? 0 : 1, at: row.updated_at || 0, conflict: false };
        const { _key: key } = row;
        const prev = best.get(key);
        if (prev === undefined) {
            best.set(key, next);
            return;
        }
        const order = next.canonical - prev.canonical || next.at - prev.at;
        if (order > 0) {
            best.set(key, next);
        } else if (order === 0 && next.alias !== prev.alias) {
            prev.conflict = true;
        }
    });
    const exact = new Map<string, string>();
    const short = new Map<string, string>();
    const byFirstLabel = new Map<string, string[]>();
    best.forEach((c, key) => {
        if (c.conflict) {
            return;
        }
        exact.set(key, c.alias);
        if (parseIp(key) !== null) {
            return;
        }
        const dot = key.indexOf('.');
        if (dot === -1) {
            short.set(key, c.alias);
            return;
        }
        const first = key.slice(0, dot);
        const list = byFirstLabel.get(first) || [];
        if (list.indexOf(c.alias) === -1) {
            list.push(c.alias);
        }
        byFirstLabel.set(first, list);
    });
    return { exact, short, byFirstLabel, size: exact.size };
};

/** The alias of a raw host value under the rules (a)-(e) above, or null. */
export const resolveAlias = (index: HostAliasIndex, raw: unknown): string | null => {
    if (index.size === 0 || !isAliasableValue(raw)) {
        return null;
    }
    const n = normalizeHostValue(raw);
    const ip = parseIp(n);
    if (ip !== null) {
        return index.exact.get(ip) ?? null;
    }
    const exact = index.exact.get(n);
    if (exact !== undefined) {
        return exact;
    }
    const dot = n.indexOf('.');
    if (dot !== -1) {
        return index.short.get(n.slice(0, dot)) ?? null;
    }
    const aliases = index.byFirstLabel.get(n);
    return aliases !== undefined && aliases.length === 1 ? aliases[0] : null;
};

/* ------------------------------------------------------------------ */
/* CSV import and export                                               */
/* ------------------------------------------------------------------ */

export interface AliasCsvMessage {
    /** The physical line (1-based) the record starts on. */
    line: number;
    message: string;
}

export interface AliasCsvResult {
    /** The rows that passed, in file order, `_key` derived; no updated_at / updated_by. */
    rows: HostAliasRow[];
    /** Rows (or the whole file) refused, and why. */
    errors: AliasCsvMessage[];
    /** Not refusals: columns other than host, alias and description, ignored. */
    warnings: AliasCsvMessage[];
}

/** A cell a spreadsheet would read as a formula: =, +, -, @, a tab or a CR first,
 *  after any number of single quotes (so the guard below round-trips). */
const FORMULA_START = /^'*[=+\-@\t\r]/;

/** toAliasCsv prefixes such a cell with one single quote. */
const guardCell = (v: string): string => (FORMULA_START.test(v) ? `'${v}` : v);

/** parseAliasCsv removes that one quote again: a cell of a single quote followed by
 *  a guarded value. So parseAliasCsv(toAliasCsv(rows)) gives back the same values;
 *  a hand-written cell such as '-old also loses its first quote. */
const unguardCell = (v: string): string => (v.charAt(0) === "'" && FORMULA_START.test(v.slice(1)) ? v.slice(1) : v);

const quoteCell = (v: string): string => (/[",\r\n]/.test(v) || v !== v.trim() ? `"${v.replace(/"/g, '""')}"` : v);

interface CsvRecord {
    line: number;
    fields: string[];
    error: string | null;
}

/** RFC 4180 records: quoted fields with doubled quotes, commas and line breaks
 *  inside quotes, CRLF, LF or a lone CR between records. A quote that opens a
 *  field after other text in it is kept as text. */
const readCsvRecords = (text: string): CsvRecord[] => {
    const records: CsvRecord[] = [];
    const n = text.length;
    let i = 0;
    let line = 1;
    while (i < n) {
        const rec: CsvRecord = { line, fields: [], error: null };
        let field = '';
        let quoted = false;
        let closed = false;
        let started = false;
        let ended = false;
        while (i < n && !ended) {
            const c = text.charAt(i);
            if (quoted && !closed) {
                if (c === '"' && text.charAt(i + 1) === '"') {
                    field += '"';
                    i += 2;
                } else if (c === '"') {
                    closed = true;
                    i += 1;
                } else {
                    if (c === '\n' || (c === '\r' && text.charAt(i + 1) !== '\n')) {
                        line += 1;
                    }
                    field += c;
                    i += 1;
                }
            } else if (c === ',') {
                rec.fields.push(field);
                field = '';
                quoted = false;
                closed = false;
                started = false;
                i += 1;
            } else if (c === '\n' || c === '\r') {
                i += c === '\r' && text.charAt(i + 1) === '\n' ? 2 : 1;
                line += 1;
                ended = true;
            } else if (c === '"' && !started) {
                quoted = true;
                started = true;
                i += 1;
            } else {
                if (closed && rec.error === null) {
                    rec.error = 'text follows a closing quote';
                }
                field += c;
                started = true;
                i += 1;
            }
        }
        if (quoted && !closed) {
            rec.error = 'a quoted field is not closed';
        }
        rec.fields.push(field);
        records.push(rec);
    }
    return records;
};

const isBlankRecord = (r: CsvRecord): boolean => r.error === null && r.fields.every((f) => f.trim() === '');

/** True when `s` holds U+FFFD, the character a decoder puts in place of bytes it
 *  could not read: a file saved in a legacy code page (Excel's "CSV (Comma
 *  delimited)" on Windows) and read as UTF-8 has one for each non-ASCII letter. */
const hasReplacementChar = (s: string): boolean => {
    for (let i = 0; i < s.length; i += 1) {
        if (s.charCodeAt(i) === 0xfffd) {
            return true;
        }
    }
    return false;
};

/** What to do about a file not saved as UTF-8. */
const SAVE_AS_UTF8_TEXT = 'save the file as CSV UTF-8 (in Excel: Save As > CSV UTF-8 (Comma delimited))';

/** The error of a line any cell of which holds U+FFFD (hasReplacementChar). */
export const UNREADABLE_LINE_TEXT = `this line holds a character that could not be read; ${SAVE_AS_UTF8_TEXT}`;

/** Added to a header error when the header line holds U+FFFD or a NUL: a file saved
 *  in a legacy code page (U+FFFD in place of each byte the decoder could not read),
 *  or BOM-less UTF-16 (a NUL after each ASCII letter), read as UTF-8. A UTF-16 file
 *  WITH a byte order mark is not one of them: FileReader.readAsText decodes it
 *  correctly, so it imports when it is comma-separated, and Excel's "Unicode Text"
 *  (UTF-16 with a byte order mark, tab-separated) gets the separator hint instead.
 *  It replaces the separator hint: a CSV UTF-8 file is comma-delimited. */
export const HEADER_UNREADABLE_TEXT = `the header holds a character that could not be read; ${SAVE_AS_UTF8_TEXT}`;

/** Added to the header error when the header line has no comma but a semicolon or
 *  a tab (a spreadsheet's export in a locale whose list separator is not a comma). */
export const SEPARATOR_HINT_TEXT = 'separate the columns with commas, not semicolons or tabs';

/** True when `line` holds a comma outside double quotes. */
const hasUnquotedComma = (line: string): boolean => {
    let quoted = false;
    for (let i = 0; i < line.length; i += 1) {
        const c = line.charAt(i);
        if (c === '"') {
            quoted = !quoted;
        } else if (c === ',' && !quoted) {
            return true;
        }
    }
    return false;
};

const describeTextProblem = (name: string, v: string, maxLen: number): string | null => {
    if (v.length > maxLen) {
        return `${name} is longer than ${maxLen} characters`;
    }
    if (hasForbiddenChars(v)) {
        return `${name} holds a control character, a line break, a direction mark or an invisible character`;
    }
    if (v.indexOf('<') !== -1 || v.indexOf('>') !== -1) {
        return `${name} holds < or >`;
    }
    return null;
};

/**
 * Parse an import file: a header line naming host and alias (description is
 * optional), in any order and any letter case, then one row per host value.
 * RFC 4180 quoting; a UTF-8 byte order mark, CRLF or LF and blank lines are
 * fine. Other columns are ignored, with one warning.
 *
 * Refused (errors, nothing of the file imported): a header line that is not
 * valid CSV or names no host and alias, a header naming a column twice, or more
 * than MAX_ROWS rows. A header error adds a hint: when the header line holds
 * U+FFFD or a NUL (a file not saved as UTF-8), to save the file as CSV UTF-8;
 * otherwise, when it has a semicolon or a tab and no comma (outside quotes, for
 * a header that is not valid CSV, such as "host";"alias"), to separate the
 * columns with commas. Refused rows (an error each; the editor imports nothing
 * while any error is left): an unclosed quote or text after a closing quote, a
 * cell holding U+FFFD (a file not saved as UTF-8), more fields than the header,
 * an empty host or alias, a host that is not a host name or an IP address, a
 * value too long or holding a control character, a direction mark, an
 * invisible character or < >, an alias with no character that shows
 * (hasVisibleChar), and a host given two DIFFERENT aliases (letter case counts:
 * "Payroll" and "payroll" differ) or two different non-empty descriptions:
 * every line naming it is refused, since which one is meant cannot be told.
 *
 * Skipped with a WARNING (not an error): an exact repeat - a host already given
 * on an earlier line with the same alias and the same description (after trim),
 * or with no description on one of the two lines, in either order. The earlier
 * line is imported, with the description whichever line gave it. When a later
 * line of that host conflicts, every repeat skipped before it is refused with
 * the host's other lines, and its warning is dropped.
 *
 * Hosts compare as keys: "APP01", "app01." and "app01" are one host, and so are
 * ::ffff:192.0.2.10 and 192.0.2.10.
 */
export const parseAliasCsv = (text: string): AliasCsvResult => {
    const errors: AliasCsvMessage[] = [];
    const warnings: AliasCsvMessage[] = [];
    const body = typeof text === 'string' && text.charCodeAt(0) === 0xfeff ? text.slice(1) : String(text || '');
    const records = readCsvRecords(body).filter((r) => !isBlankRecord(r));
    if (records.length === 0) {
        errors.push({ line: 1, message: 'The file is empty: the first line must be the header host,alias,description' });
        return { rows: [], errors, warnings };
    }
    const [header, ...data] = records;
    /** The header's first line as written. */
    const headerRaw = (): string => body.split(/\r\n|\n|\r/)[header.line - 1] || '';
    /** The hint of a header error: save as CSV UTF-8 when the header's first line
     *  holds U+FFFD or a NUL, else the separator hint when `separator` is true. */
    const headerHint = (separator: boolean): string => {
        const raw = headerRaw();
        if (raw.indexOf('\ufffd') !== -1 || raw.indexOf('\u0000') !== -1) {
            return `; ${HEADER_UNREADABLE_TEXT}`;
        }
        return separator ? `; ${SEPARATOR_HINT_TEXT}` : '';
    };
    if (header.error !== null) {
        // A quoted header in another separator ("host";"alias", as PowerShell's Export-Csv
        // -Delimiter ';' writes it) is not valid CSV here, so its line as written is read.
        const raw = headerRaw();
        const separator = /[;\t]/.test(raw) && !hasUnquotedComma(raw);
        errors.push({
            line: header.line,
            message: `The header line is not valid CSV: ${header.error}${headerHint(separator)}`,
        });
        return { rows: [], errors, warnings };
    }
    const names = header.fields.map((f) => f.trim().toLowerCase());
    const twice = names.filter((nm, i) => nm !== '' && names.indexOf(nm) !== i);
    if (twice.length > 0) {
        errors.push({
            line: header.line,
            message: `The header names a column twice: ${twice.join(', ')}${headerHint(false)}`,
        });
        return { rows: [], errors, warnings };
    }
    const hostCol = names.indexOf('host');
    const aliasCol = names.indexOf('alias');
    const descCol = names.indexOf('description');
    if (hostCol === -1 || aliasCol === -1) {
        const only = header.fields.length === 1 ? header.fields[0] : '';
        const hint = headerHint(only.indexOf(',') === -1 && /[;\t]/.test(only));
        errors.push({
            line: header.line,
            message: `The first line must be the header host,alias,description (description is optional)${hint}`,
        });
        return { rows: [], errors, warnings };
    }
    const unknown = names.filter((nm) => nm !== '' && ['host', 'alias', 'description'].indexOf(nm) === -1);
    if (unknown.length > 0) {
        warnings.push({ line: header.line, message: `Columns ignored: ${unknown.join(', ')}` });
    }
    if (data.length > MAX_ROWS) {
        errors.push({
            line: data[MAX_ROWS].line,
            message: `The file has ${data.length} rows; at most ${MAX_ROWS} can be imported at once`,
        });
        return { rows: [], errors, warnings };
    }

    const cell = (r: CsvRecord, col: number): string =>
        col >= 0 && col < r.fields.length ? unguardCell(r.fields[col].trim()) : '';
    const accepted: { key: string; row: HostAliasRow }[] = [];
    /** The first accepted line of each key, its alias, the description in effect
     *  (the first non-empty one of its lines, or '') and the line that gave it, its
     *  entry in `accepted`, and the exact repeats skipped so far (refused with the
     *  rest if a later line conflicts). */
    const firstLine = new Map<
        string,
        {
            line: number;
            alias: string;
            description: string;
            descLine: number;
            entry: { key: string; row: HostAliasRow };
            repeatLines: number[];
        }
    >();
    /** Keys whose lines disagree: the two lines that differ, then every later one,
     *  and what they disagree on (named in the messages). */
    const conflicted = new Map<string, { lines: number[]; what: 'alias' | 'description' }>();
    const plural = (what: 'alias' | 'description'): string => (what === 'alias' ? 'aliases' : 'descriptions');
    data.forEach((r) => {
        const problems: string[] = [];
        if (r.error !== null) {
            problems.push(r.error);
        } else {
            if (r.fields.some((f) => hasReplacementChar(f))) {
                problems.push(UNREADABLE_LINE_TEXT);
            }
            if (r.fields.slice(names.length).some((f) => f.trim() !== '')) {
                problems.push('the line has more fields than the header');
            }
            const host = cell(r, hostCol);
            const alias = cell(r, aliasCol);
            const description = cell(r, descCol);
            if (host === '') {
                problems.push('host is empty');
            } else if (host.length > MAX_MATCH_LEN) {
                problems.push(`host is longer than ${MAX_MATCH_LEN} characters`);
            } else if (hasForbiddenChars(host) || keyForMatchValue(host) === null) {
                problems.push('host is not a host name or an IP address');
            }
            if (alias === '') {
                problems.push('alias is empty');
            } else {
                const p = describeTextProblem('alias', alias, MAX_ALIAS_LEN);
                if (p !== null) {
                    problems.push(p);
                } else if (!hasVisibleChar(alias)) {
                    problems.push('alias has no character that shows');
                }
            }
            const pd = describeTextProblem('description', description, MAX_DESC_LEN);
            if (description !== '' && pd !== null) {
                problems.push(pd);
            }
            const row = problems.length === 0 ? sanitizeAliasRow({ match_value: host, alias, description }) : null;
            if (problems.length === 0 && row === null) {
                problems.push('the row is not valid');
            }
            if (row !== null) {
                const { _key: key } = row;
                const rowDesc = row.description || '';
                const prev = firstLine.get(key);
                const clash = conflicted.get(key);
                if (clash !== undefined) {
                    clash.lines.push(r.line);
                    problems.push(
                        `this host is on lines ${clash.lines[0]} and ${clash.lines[1]} with different ` +
                            `${plural(clash.what)}; none of its lines is imported`,
                    );
                } else if (
                    prev !== undefined &&
                    prev.alias === row.alias &&
                    (rowDesc === '' || prev.description === '' || rowDesc === prev.description)
                ) {
                    // An exact repeat: the same alias (letter case counts), and the same description or none on
                    // one of the two lines, in either order. The accepted row keeps the description.
                    prev.repeatLines.push(r.line);
                    if (rowDesc !== '' && prev.description === '') {
                        prev.description = rowDesc;
                        prev.descLine = r.line;
                        prev.entry.row = { ...prev.entry.row, description: rowDesc };
                        warnings.push({
                            line: r.line,
                            message:
                                `this host is already on line ${prev.line} with the same alias and no description; ` +
                                'this line is skipped and its description used',
                        });
                    } else {
                        warnings.push({
                            line: r.line,
                            message: `this host is already on line ${prev.line} with the same alias; this line is skipped`,
                        });
                    }
                } else if (prev !== undefined) {
                    const what = prev.alias !== row.alias ? 'alias' : 'description';
                    // The line it differs from: the first line for an alias, the line that gave the
                    // description in effect for a description.
                    const other = what === 'alias' ? prev.line : prev.descLine;
                    conflicted.set(key, { lines: [other, r.line], what });
                    problems.push(`this host has another ${what} on line ${other}; none of its lines is imported`);
                } else {
                    const entry = { key, row };
                    firstLine.set(key, {
                        line: r.line,
                        alias: row.alias,
                        description: rowDesc,
                        descLine: r.line,
                        entry,
                        repeatLines: [],
                    });
                    accepted.push(entry);
                }
            }
        }
        if (problems.length > 0) {
            errors.push({ line: r.line, message: problems.join('; ') });
        }
    });
    conflicted.forEach((c, key) => {
        const first = firstLine.get(key);
        if (first !== undefined) {
            // The first line and every exact repeat skipped before the conflict (each skipped with a
            // warning, now refused with the rest); the line that gave the description in effect is
            // one of these.
            [first.line].concat(first.repeatLines).forEach((line) => {
                errors.push({
                    line,
                    message: `this host has another ${c.what} on line ${c.lines[1]}; none of its lines is imported`,
                });
            });
        }
    });
    errors.sort((a, b) => a.line - b.line);
    const rows = accepted.filter((a) => !conflicted.has(a.key)).map((a) => a.row);
    // A refused line keeps its error only (a skipped repeat refused with its host loses its warning).
    const refusedLines = new Set(errors.map((e) => e.line));
    return { rows, errors, warnings: warnings.filter((w) => !refusedLines.has(w.line)) };
};

const compareText = (a: string, b: string): number => {
    if (a < b) {
        return -1;
    }
    return a > b ? 1 : 0;
};

/**
 * The export file: the header host,alias,description, then one line per row,
 * sorted by alias and then host (case-insensitive, then exact), so an unchanged
 * table exports byte for byte the same. RFC 4180 quoting, CRLF line ends. A cell
 * a spreadsheet would read as a formula gets a leading single quote, which
 * parseAliasCsv removes, so an exported file imports back unchanged.
 */
export const toAliasCsv = (rows: ReadonlyArray<HostAliasRow>): string => {
    const sorted = rows
        .slice()
        .sort(
            (x, y) =>
                compareText(x.alias.toLowerCase(), y.alias.toLowerCase()) ||
                compareText(x.alias, y.alias) ||
                compareText(x.match_value.toLowerCase(), y.match_value.toLowerCase()) ||
                compareText(x.match_value, y.match_value),
        );
    const lines = ['host,alias,description'].concat(
        sorted.map((r) => [r.match_value, r.alias, r.description || ''].map((v) => quoteCell(guardCell(v))).join(',')),
    );
    return `${lines.join('\r\n')}\r\n`;
};

/* ------------------------------------------------------------------ */
/* Display                                                             */
/* ------------------------------------------------------------------ */

/** The short form shown after a shared alias: an IP address as written, a host
 *  name's first label. */
const shortFormOf = (raw: string): string => {
    const t = raw.trim();
    if (parseIp(t) !== null) {
        return t;
    }
    const dot = t.indexOf('.');
    return dot > 0 ? t.slice(0, dot) : t;
};

const duplicatesIn = (names: string[]): Set<string> => {
    const seen = new Set<string>();
    const dup = new Set<string>();
    names.forEach((nm) => {
        if (seen.has(nm)) {
            dup.add(nm);
        }
        seen.add(nm);
    });
    return dup;
};

/**
 * Names for a list of raw values that are shown side by side (chart series,
 * graph nodes): the alias where there is one, the raw value where there is
 * none. Where an aliased value's name would be shared with another entry, it
 * becomes "alias (short form)" (an IP address, or a host name's first label);
 * still shared, "alias (raw value)"; still shared, the raw value. Unaliased
 * values always keep their raw value. Distinct raw values always give distinct
 * names, so two series or nodes never merge (failing every step above, the raw
 * values are returned as they are).
 */
export const aliasDisplayNames = (
    rawValues: ReadonlyArray<string>,
    // eslint-disable-next-line no-unused-vars -- a parameter name in a function type (the base rule is not TypeScript-aware)
    resolve: (raw: string) => string | null,
): string[] => {
    const aliases = rawValues.map((r) => resolve(r));
    if (aliases.every((a) => a === null)) {
        return rawValues.slice();
    }
    const withShortForm = (alias: string, raw: string): string => `${alias} (${shortFormOf(raw)})`;
    const withRaw = (alias: string, raw: string): string => `${alias} (${raw})`;
    const rawOnly = (_alias: string, raw: string): string => raw;
    const steps = [withShortForm, withRaw, rawOnly];
    let names = rawValues.map((r, i) => {
        const a = aliases[i];
        return a === null ? r : a;
    });
    steps.forEach((step) => {
        const dup = duplicatesIn(names);
        if (dup.size === 0) {
            return;
        }
        names = names.map((nm, i) => {
            const a = aliases[i];
            return a !== null && dup.has(nm) ? step(a, rawValues[i]) : nm;
        });
    });
    return duplicatesIn(names).size === 0 ? names : rawValues.slice();
};

/**
 * A column of raw host values with one entry per row, hosts repeating (a link
 * graph's host column), under display names. The names are taken over the
 * DISTINCT values, so a host that repeats across rows is not a collision and
 * every row of one host gets the same name; distinct raw values keep distinct
 * names, so graph nodes keyed by their text never merge. Should the names not
 * come back one per distinct value and distinct, the raw column is returned.
 * `displayNames` is useHostAlias().displayNames (aliasDisplayNames over the
 * provider's resolve).
 */
export const aliasHostColumn = (
    hostCol: ReadonlyArray<string>,
    // eslint-disable-next-line no-unused-vars -- a parameter name in a function type (the base rule is not TypeScript-aware)
    displayNames: (raws: string[]) => string[],
): string[] => {
    const distinct = Array.from(new Set(hostCol));
    const names = displayNames(distinct);
    if (names.length !== distinct.length || new Set(names).size !== names.length) {
        return hostCol.slice();
    }
    const nameOf = new Map<string, string>();
    distinct.forEach((h, i) => {
        nameOf.set(h, names[i]);
    });
    return hostCol.map((h) => nameOf.get(h) ?? h);
};

/** A one-line label for compact lists (dropdown options): "alias (raw)", or the
 *  raw value alone when there is no alias. */
export const formatAliasLabel = (alias: string | null, raw: string): string => (alias ? `${alias} (${raw})` : raw);
