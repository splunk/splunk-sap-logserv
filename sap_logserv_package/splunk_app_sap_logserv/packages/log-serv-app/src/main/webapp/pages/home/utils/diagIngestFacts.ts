/**
 * diagIngestFacts — operator-supplied ingest evidence (design §15 + §15.8a,
 * checks 27–29, session 099 / build 314).
 *
 * The search head cannot read the Data TA's ingest filters (include/exclude +
 * days_in_past run on the HF/indexer tier), which is the product's historical
 * #1 cause of "I see zero events". This module closes that boundary the only
 * honest way available: the operator runs a printed command, pastes the
 * output, and the diagnostic parses it into a CHECKED FACT — always badged
 * "Recorded as supplied by <user>", never "Observed".
 *
 * GATE-SAFE: no @splunk imports, no module-level window/document, fetch
 * injectable — exercised by bin/check-diagnostics.js under node.
 *
 * WORLD-WRITABLE COLLECTION: any authenticated user can overwrite the facts
 * row, so everything read back is UNTRUSTED — `looksLikeIngestFacts`
 * validates every field a consumer dereferences AND applies domain clamps
 * (§15.8a-24): a hand-POSTed far-future cutoff or out-of-range days value is
 * nulled so it can never steer a confirmed verdict.
 *
 * EVALUATOR SEMANTICS MIRROR THE GENERATOR, NOT FNMATCH FOLKLORE (§15.8a-14,
 * review blocker B2): the Data TA's `fnmatch_patterns_to_combined_regex`
 * SKIPS any pattern without a '/' — a bare `*` inside a mixed include list is
 * inert, and `exclude = *` excludes NOTHING. Pass-all holds iff the effective
 * (slash-bearing) include list is empty or contains a match-everything
 * pattern. Matching is CASE-SENSITIVE (the generated PCRE does not fold;
 * python fnmatch's Windows case-folding is deliberately NOT ported —
 * §15.8a-18).
 *
 * KNOWN APPROXIMATION (§15.8a-20): the generated PCRE is pathologically MORE
 * permissive than per-segment fnmatch for suffix/infix wildcards (a `.*`
 * inside `"clz_dir"\s*:\s*".*x"` can cross the value's closing quote and
 * match later raw content). Byte-equivalence with the PCRE is not achievable
 * from here; per-segment fnmatch is the documented approximation and is
 * exact for the controlled clz vocabulary.
 *
 * TOOL-TRANSPORT NOTE (sessions 051/074/079/092/095): regex-bearing strings
 * in this file are byte-verified after every edit — this exact feature area
 * has been bitten by escape-sequence mangling before.
 */

// ---------------------------------------------------------------------------
// Constants (exported + literal-pinned in diagIngestFacts.consistency-test.ts)
// ---------------------------------------------------------------------------

/** Paste input cap — matches MAX_MODEL_JSON_CHARS by design (§3.4). */
export const MAX_INGEST_PASTE_CHARS = 200000;

/** Supplied facts older than this get the staleness caveat AND the
 *  suppliedConfidenceCap drops to 'likely' (§15.8a-8). */
export const INGEST_FACTS_STALE_SECONDS = 7 * 86400;

/** Check 28's margin between the window end and the cutoff before a
 *  CONFIRMED claim. Snap suffixes only move a bound EARLIER, so approxEpoch's
 *  snap-ignoring approximation OVER-estimates winEnd and the computed margin
 *  under-estimates the true one — the safe direction. The one-day floor
 *  covers ISO-date/timezone parse skew (§15.8a-10). */
export const INGEST_CUTOFF_MIN_MARGIN_SECONDS = 86400;

/** How much of the scrubbed paste leaves this module: `fetchIngestFacts`
 *  truncates to this before anything is threaded into evidence or reports
 *  (§15.8a-23) — the full scrubbed raw exists only in the KV row. */
export const INGEST_RAW_EXCERPT_CHARS = 2000;

/** Domain clamps for the world-writable row (§15.8a-24). */
export const INGEST_MAX_DAYS_IN_PAST = 3650;
export const INGEST_MAX_PATTERNS = 64;
export const INGEST_MAX_PATTERN_CHARS = 128;

/** §19.8a-12 — grace on check 29's INDEX-TIME contradiction comparator
 *  (`recentSeen > suppliedAt + SKEW`). Index time for a live feed is by
 *  definition ≈ now, and `suppliedAt` is the BROWSER clock, so without a
 *  grace ordinary browser-vs-indexer clock skew (plus an in-flight DS-push
 *  index write) would manufacture a contradiction that suppresses a correct
 *  exclusion verdict. Five minutes; the FUTURE_TS_GUARD_SECONDS shape. */
export const INGEST_RECENT_SKEW_SECONDS = 300;

export const DIAG_INGEST_FACTS_COLLECTION = 'logserv_diag_ingest_facts';

/** The one row this app ever writes. Junk rows under other keys are invisible
 *  to the fixed-key reader (deliberate — see the collections.conf comment). */
export const INGEST_FACTS_KEY = 'latest';

/** KV row STORAGE field manifest — drift-checked against collections.conf by
 *  bin/check-diagnostics.js (there is deliberately NO transforms.conf stanza
 *  and NO retention search for this collection; the gate asserts the
 *  absence). Pattern lists are JSON-encoded single string fields (§15.8a-25);
 *  booleans are 0/1; null numbers are OMITTED. */
export const DIAG_INGEST_FACT_FIELDS: string[] = [
    '_key',
    'supplied_at',
    'supplied_at_iso',
    'supplied_by',
    'source_host',
    'input_shape',
    'parse_status',
    'parse_note',
    'filter_enabled',
    'days_in_past',
    'cutoff_epoch',
    'include_filters_json',
    'exclude_filters_json',
    'filters_approximate',
    'cloud_provider_stamp',
    'scrubbed_raw',
    'app_build',
];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type IngestInputShape =
    | 'rest-json'
    | 'rest-xml'
    | 'transforms-conf'
    | 'settings-conf'
    | 'unknown';

export type IngestParseStatus = 'parsed' | 'partial' | 'unparsed';

/** §19.4 — the Data TA's Cloud Provider dropdown value, recovered ONLY from
 *  explicit stanzas (§19.8a-8: NO absence-inference — a truncated paste is
 *  not evidence). `not_set` is reachable ONLY via a settings-conf paste,
 *  which can carry the literal. */
export type CloudProviderStamp = 'aws' | 'azure' | 'gcp' | 'not_set';

const STAMP_VALUES: CloudProviderStamp[] = ['aws', 'azure', 'gcp', 'not_set'];

export interface IngestFacts {
    /** Epoch seconds (browser clock at save time). */
    suppliedAt: number;
    /** Splunk username of the paster — RECORDED, not attested (the row is
     *  world-writable; §15.8a-13). */
    suppliedBy: string;
    /** Host string recovered from the paste ('' when none). */
    sourceHost: string;
    inputShape: IngestInputShape;
    parseStatus: IngestParseStatus;
    /** Parser hint for odd pastes (e.g. "looks like default/transforms.conf"). */
    parseNote: string;
    /** null = not recoverable from this shape. */
    filterEnabled: boolean | null;
    /** As configured; null when unknown. */
    daysInPast: number | null;
    /** The load-bearing number for check 28; null when no time filter. */
    cutoffEpoch: number | null;
    /** Patterns AS SUPPLIED (display fidelity); the evaluator applies the
     *  generator's effective semantics (§15.8a-14). */
    includeFilters: string[];
    excludeFilters: string[];
    /** true when recovered from generated transforms.conf regexes — caps
     *  check 29 at 'likely' (§15.8a-17). Also set on READ when the stored
     *  pattern lists were clamped (§19.8a-7): a clamped list can never carry
     *  an exact-shape confidence. */
    filtersApproximate: boolean;
    /** §19.4 — the Data TA's cloud-provider stamp, from explicit stanzas
     *  only. null = unknown (incl. every REST shape — the endpoint's output
     *  genuinely does not carry it). */
    cloudProviderStamp: CloudProviderStamp | null;
    /** Scrubbed paste. Stored ONLY for partial/unparsed (§15.8a-22); always
     *  excerpt-truncated by fetchIngestFacts before threading (§15.8a-23). */
    scrubbedRaw: string;
}

/** Parse result BEFORE provenance is attached (the caller adds who/when). */
export interface IngestParseResult {
    inputShape: IngestInputShape;
    parseStatus: IngestParseStatus;
    parseNote: string;
    filterEnabled: boolean | null;
    daysInPast: number | null;
    cutoffEpoch: number | null;
    includeFilters: string[];
    excludeFilters: string[];
    filtersApproximate: boolean;
    cloudProviderStamp: CloudProviderStamp | null;
    sourceHost: string;
}

/** Minimal fetch shape so the consistency test can inject a fake. */
export type FetchLike = (
    url: string,
    init?: {
        method?: string;
        credentials?: 'same-origin';
        headers?: Record<string, string>;
        body?: string;
    },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

const defaultFetch: FetchLike = (url, init) => (fetch as unknown as FetchLike)(url, init);

// ---------------------------------------------------------------------------
// The sourcetype -> clz_dir/clz_subdir map (check 29's reverse routing table)
// ---------------------------------------------------------------------------

/**
 * Derived from the Data TA's `default/transforms.conf` `@logserv_filter`
 * annotations + `FORMAT = sourcetype::…` routing lines. The SH webapp cannot
 * read that file at runtime, so the map ships as a constant —
 * bin/check-diagnostics.js re-derives it from the Data TA source at build
 * time and fails on drift IN BOTH DIRECTIONS (hard-fail when the Data TA
 * source sibling is missing: it is a build-time requirement of the App
 * workspace from build 314 on — §15.8a-31).
 *
 * OR-semantics: a sourcetype survives ingest if ANY of its clz paths
 * survives. The fallback sourcetype `sap_logserv_logs` is deliberately
 * absent (the unrouted residual has no clz identity).
 */
export const SOURCETYPE_CLZ_MAP: Record<string, string[]> = {
    'sap:hana:audit': ['hana/hanaaudit'],
    'sap:hana:tracelogs': ['hana/tracelogs'],
    'sap:webdispatcher:access': ['webdispatcher/accesslog'],
    linux_messages_syslog: ['linux/messages', 'linux/localmessages'],
    'linux:cron': ['linux/cron'],
    'linux:warn': ['linux/warn'],
    'linux:sudolog': ['linux/sudolog'],
    'linux:slapd': ['linux/slapd'],
    linux_secure: ['linux/linux_secure'],
    lastlog: ['linux/linux_secure'],
    who: ['linux/linux_secure'],
    'isc:bind:query': ['dns/binddns'],
    'isc:bind:lameserver': ['dns/binddns'],
    'isc:bind:network': ['dns/binddns'],
    'isc:bind:transfer': ['dns/binddns'],
    'squid:access': ['proxy/squid'],
    XmlWinEventLog: [
        'windows/WinEventLog:Application',
        'windows/WinEventLog:Powershell',
        'windows/WinEventLog:Security',
        'windows/WinEventLog:System',
    ],
    'sap:abap:audit': ['abap/audit'],
    'sap:abap:dispatcher': ['abap/dispatcher'],
    'sap:abap:enqueueserver': ['abap/enqueueserver'],
    'sap:abap:event': ['abap/event'],
    'sap:abap:gateway': ['abap/gateway'],
    'sap:abap:icm': ['abap/icm'],
    'sap:abap:messageserver': ['abap/messageserver'],
    'sap:abap:sapstartsrv': ['abap/sapstartsrv'],
    'sap:abap:workprocess': ['abap/workprocess'],
    'sap:scc:audit': ['scc/audit'],
    'sap:scc:http_access': ['scc/tracelogs'],
    'sap:sapstartsrv': ['sap/sapstartsrv'],
    'sap:saphostexec': ['sap/saphostexec'],
    'sap:saprouter': ['sap/saprouter'],
};

/** Tag-scoped panels carry no sourcetype (DNS scopes by `tag=dns`) — this
 *  one-entry map keeps check 29 reachable there (§15.8a-5): a single
 *  `exclude = dns/binddns` blanks three dashboards and must be nameable. */
export const TAG_CLZ_MAP: Record<string, string[]> = {
    dns: ['dns/binddns'],
};

/** The sourcetypes whose clz paths a TAG implies (for evaluation the tag is
 *  treated as one pseudo-type with those paths). */
export const tagClzPaths = (tags: string[]): string[] => {
    const out: string[] = [];
    for (const t of tags) {
        for (const p of TAG_CLZ_MAP[t] || []) {
            if (out.indexOf(p) === -1) out.push(p);
        }
    }
    return out;
};

// ---------------------------------------------------------------------------
// Scrubber (§15.8a-21 — over-redaction is the accepted direction)
// ---------------------------------------------------------------------------

const REDACTED = '<redacted>';

export const scrubPaste = (input: string): string => {
    let text = input;
    // curl -u / --user: spaced, =, attached (-uadmin:pw), quoted
    text = text.replace(
        /(-u|--user)([ \t]+|=|)((["'])[^"']*\4|[^ \t\r\n]+)/gi,
        (_m, flag: string, sep: string) => `${flag}${sep || ' '}${REDACTED}`,
    );
    // Splunk CLI -auth user:pass
    text = text.replace(
        /(-auth)([ \t]+|=)((["'])[^"']*\4|[^ \t\r\n]+)/gi,
        (_m, flag: string, sep: string) => `${flag}${sep}${REDACTED}`,
    );
    // URL-embedded credentials: scheme://user:pass@host
    text = text.replace(/(https?:\/\/)([^/\s:@]+):([^/\s@]+)@/gi, `$1${REDACTED}@`);
    // Authorization headers (Basic/Bearer/Splunk <token>), quoted or not
    text = text.replace(
        /(authorization["']?\s*[:=]\s*)((["'])[^"']*\3|[^\r\n]+)/gi,
        `$1${REDACTED}`,
    );
    // Catch-all secret-ish key=value / key: value (incl. SPLUNK_PASS=..., api_key: ...)
    text = text.replace(
        /\b(\w*(?:pass|pwd|secret|token|key)\w*["']?\s*[:=]\s*)((["'])[^"']*\3|[^\s&",;]+)/gi,
        `$1${REDACTED}`,
    );
    // splunkd/splunkweb session cookies
    text = text.replace(
        /((?:splunkd_\d+|splunkweb_csrf_token_\d+|splunkweb_uid|session_id_\d+)=)[^;\s]+/gi,
        `$1${REDACTED}`,
    );
    // SS16.8a-29 — raw-event-corpus credential shapes (build 315; the raw
    // sample path reuses this scrubber, and over-redaction stays the accepted
    // direction for the paste path too):
    // prefix-less high-signal secrets — AWS access keys, sk- API keys, JWTs
    text = text.replace(/\bAKIA[0-9A-Z]{16}\b/g, REDACTED);
    text = text.replace(/\bsk-[A-Za-z0-9_-]{20,}\b/g, REDACTED);
    text = text.replace(/\beyJ[A-Za-z0-9_-]{10,}(?:\.[A-Za-z0-9_-]+){1,2}\b/g, REDACTED);
    // bare Bearer tokens (no Authorization: prefix)
    text = text.replace(/\b(bearer[ \t]+)[A-Za-z0-9._~+/-]{8,}=*/gi, `$1${REDACTED}`);
    // space-delimited CLI secret flags: -Password x / -Pwd x / -Secret x
    text = text.replace(
        /(\s-(?:password|pwd|secret)[ \t]+)((["'])[^"']*\3|[^ \t\r\n]+)/gi,
        `$1${REDACTED}`,
    );
    // §20.8a-15 — space-delimited SQL and short-flag secret shapes (the
    // review's probe strings: `CREATE USER x PASSWORD "y"`, `ALTER USER x
    // PASSWORD 'y'`, `CONNECT x IDENTIFIED BY y`, `sqlcmd … -P y`,
    // `mysql -u root -py`). Full-length raw samples put HANA/SQL DDL bodies
    // in a vendor-bound PDF, and the compliance rollup exists precisely to
    // classify `ALTER USER … PASSWORD` events — so these shapes are KNOWN
    // to be in the corpus. Over-redaction (a port after `-p`, the word after
    // a prose "password") stays the declared accepted direction (§15.8a-21).
    text = text.replace(
        /\b(PASSWORD|IDENTIFIED[ \t]+BY)([ \t]+)((["'])[^"']*\4|[^ \t\r\n]+)/gi,
        `$1$2${REDACTED}`,
    );
    // Short `-p`/`-P`: the SPACED form always redacts (`-P Hunter2`; a port
    // after `-p` over-redacts, accepted). The ATTACHED form (`-pHunter2`,
    // `-p$6$…`) redacts only when the value does not start with a lowercase
    // letter, so prose/flag words (`-parameter`, `-primary`) survive.
    text = text.replace(
        /(\s-[pP])[ \t]+((["'])[^"']*\3|[^ \t\r\n]+)/g,
        `$1 ${REDACTED}`,
    );
    text = text.replace(/(\s-[pP])(?![ \t])([^ \t\r\na-z][^ \t\r\n]*)/g, `$1${REDACTED}`);
    text = text.replace(
        /(\s--pass(?:word)?[ \t=]+)((["'])[^"']*\3|[^ \t\r\n]+)/gi,
        `$1${REDACTED}`,
    );
    if (text.length > MAX_INGEST_PASTE_CHARS) {
        text =
            text.slice(0, MAX_INGEST_PASTE_CHARS) +
            '\n[truncated by the diagnostic at 200000 characters]';
    }
    return text;
};

// ---------------------------------------------------------------------------
// Pattern semantics — the generator's, exactly (§15.8a-14)
// ---------------------------------------------------------------------------

/** The Data TA's parse_comma_patterns: split on ',', trim, drop empties. */
export const parseCommaPatterns = (value: string): string[] =>
    value
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);

/** The generator SKIPS any pattern without a '/' — those contribute nothing
 *  to either list at runtime. */
export const effectivePatterns = (patterns: string[]): string[] =>
    patterns.filter((p) => p.indexOf('/') !== -1);

/** Case-sensitive per-segment fnmatch with `*` and `?` only. */
export const fnmatchLite = (value: string, pattern: string): boolean => {
    let rx = '';
    for (const ch of pattern) {
        if (ch === '*') rx += '.*';
        else if (ch === '?') rx += '.';
        else rx += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
    try {
        return new RegExp('^' + rx + '$').test(value);
    } catch (_e) {
        return false;
    }
};

/** Does `dir/subdir` match the pattern per the generator's segment rules?
 *  Multi-slash patterns split at the FIRST '/' (subdir pattern `b/c` matches
 *  nothing, since subdir values never contain '/'). */
const clzPathMatches = (path: string, pattern: string): boolean => {
    const pi = pattern.indexOf('/');
    const vi = path.indexOf('/');
    if (pi === -1 || vi === -1) return false;
    const pd = pattern.slice(0, pi);
    const ps = pattern.slice(pi + 1);
    const vd = path.slice(0, vi);
    const vs = path.slice(vi + 1);
    return fnmatchLite(vd, pd) && fnmatchLite(vs, ps);
};

/** Pass-all include per the GENERATOR: the effective (slash-bearing) list is
 *  empty (nothing generated an include gate), or contains a pattern whose
 *  both segments match everything. */
export const isPassAllInclude = (patterns: string[]): boolean => {
    const eff = effectivePatterns(patterns);
    if (eff.length === 0) return true;
    return eff.some((p) => {
        const i = p.indexOf('/');
        const d = p.slice(0, i);
        const s = p.slice(i + 1);
        return /^\*+$/.test(d) && /^\*+$/.test(s);
    });
};

/** Would an event with this clz path survive the supplied filters?
 *  (Time filter excluded — that is check 28's dimension.) */
export const clzPathSurvives = (path: string, facts: IngestFacts): boolean => {
    if (facts.filterEnabled !== true) return true;
    const included =
        isPassAllInclude(facts.includeFilters) ||
        effectivePatterns(facts.includeFilters).some((p) => clzPathMatches(path, p));
    if (!included) return false;
    return !effectivePatterns(facts.excludeFilters).some((p) => clzPathMatches(path, p));
};

export type TypeDropStatus = 'dropped' | 'partial' | 'kept' | 'unknown';

/** Check 29's per-type evaluation over a set of clz paths. */
export const pathsDropStatus = (paths: string[], facts: IngestFacts): TypeDropStatus => {
    if (paths.length === 0) return 'unknown';
    if (facts.filterEnabled !== true) return 'kept';
    const dropped = paths.filter((p) => !clzPathSurvives(p, facts));
    if (dropped.length === 0) return 'kept';
    if (dropped.length === paths.length) return 'dropped';
    return 'partial';
};

/** A TYPE is dropped iff EVERY one of its clz paths is dropped. Unknown for
 *  unmapped types (incl. the fallback sourcetype). */
export const typeDropStatus = (sourcetype: string, facts: IngestFacts): TypeDropStatus =>
    pathsDropStatus(SOURCETYPE_CLZ_MAP[sourcetype] || [], facts);

/** The clz paths of a type that the supplied filters drop (for wording). */
export const droppedClzPaths = (sourcetype: string, facts: IngestFacts): string[] => {
    const paths = SOURCETYPE_CLZ_MAP[sourcetype] || [];
    return paths.filter((p) => !clzPathSurvives(p, facts));
};

/** Which rule to name in the verdict: the matching EFFECTIVE exclude pattern,
 *  or the include list that fails to cover the path. */
export const namedRuleFor = (paths: string[], facts: IngestFacts): string => {
    for (const path of paths) {
        const exc = effectivePatterns(facts.excludeFilters).find((p) => clzPathMatches(path, p));
        if (exc) return 'excluded by the configured filter rule `' + exc + '`';
    }
    return (
        'not covered by the configured include list `' +
        (facts.includeFilters.join(', ') || '*/*') +
        '`'
    );
};

// ---------------------------------------------------------------------------
// Cutoff recovery — self-validating round-trip (§15.8a-16)
// ---------------------------------------------------------------------------

/** TS port of the Data TA's generate_epoch_less_than_regex (UTILS:352–397):
 *  for each digit position with digit d>0, emit prefix + charclass + run,
 *  where charclass is `0` when d===1 else `[0-(d-1)]`, and the run `\d{n}`
 *  is omitted when no digits remain. */
export const generateEpochLessThanRegex = (cutoff: number): string => {
    const s = String(cutoff);
    const alts: string[] = [];
    for (let i = 0; i < s.length; i += 1) {
        const d = s.charCodeAt(i) - 48;
        if (d <= 0) continue;
        const prefix = s.slice(0, i);
        const cls = d === 1 ? '0' : '[0-' + String(d - 1) + ']';
        const remaining = s.length - i - 1;
        const run = remaining > 0 ? '\\d{' + String(remaining) + '}' : '';
        alts.push(prefix + cls + run);
    }
    return alts.join('|');
};

/**
 * Recover the cutoff from a pasted `[logserv_filter_time_drop]` REGEX line.
 * SELF-VALIDATING before returning non-null: every alternative must parse,
 * reconstructed bounds must strictly increase, the ROUND-TRIP through
 * generateEpochLessThanRegex must reproduce the pasted alternation exactly,
 * and the result must be plausible (within the TA's configurable range of
 * now). A hand-edited or foreign-vintage regex yields null — check 28 then
 * stays silent rather than fabricating arithmetic (§15.8a-16).
 */
export const recoverCutoffFromRegex = (regexText: string, nowSec: number): number | null => {
    const altStart = regexText.indexOf('(?:');
    if (altStart === -1) return null;
    const end = regexText.indexOf(')', altStart);
    if (end === -1) return null;
    const body = regexText.slice(altStart + 3, end);
    const alternatives = body.split('|').map((a) => a.trim());
    if (alternatives.length === 0) return null;
    // built from parts to survive tool transport: matches
    //   <digits>[0-<K>]\d{<n>}   |   <digits>0\d{<n>}   (run optional in both)
    const CLASS_ALT = new RegExp('^(\\d*)\\[0-(\\d)\\](?:\\\\d\\{(\\d+)\\})?$');
    const ZERO_ALT = new RegExp('^(\\d*?)0(?:\\\\d\\{(\\d+)\\})?$');
    let bestPrefixLen = -1;
    let cutoff: number | null = null;
    let prevBound = -1;
    for (const a of alternatives) {
        let prefix = '';
        let upper = -1;
        let remaining = 0;
        const m1 = CLASS_ALT.exec(a);
        if (m1) {
            prefix = m1[1];
            upper = parseInt(m1[2], 10);
            remaining = m1[3] ? parseInt(m1[3], 10) : 0;
        } else {
            const m2 = ZERO_ALT.exec(a);
            if (!m2) return null; // every alternative must parse (§15.8a-16)
            prefix = m2[1];
            upper = 0;
            remaining = m2[2] ? parseInt(m2[2], 10) : 0;
        }
        const bound = Number(prefix + String(upper + 1) + '0'.repeat(remaining));
        if (!Number.isFinite(bound)) return null;
        if (bound <= prevBound) return null; // bounds must strictly increase
        prevBound = bound;
        if (prefix.length > bestPrefixLen) {
            bestPrefixLen = prefix.length;
            cutoff = bound;
        }
    }
    if (cutoff === null) return null;
    // Round-trip: the pasted alternation must be exactly what the shipped
    // generator emits for this cutoff.
    if (generateEpochLessThanRegex(cutoff) !== body) return null;
    // Plausibility clamp: within the TA's configurable range of now.
    const min = nowSec - INGEST_MAX_DAYS_IN_PAST * 86400 - 7 * 86400;
    const max = nowSec + 86400;
    if (cutoff < min || cutoff > max) return null;
    return cutoff;
};

// ---------------------------------------------------------------------------
// The parser — four shapes, sniffed in order, degrades to 'unparsed'
// ---------------------------------------------------------------------------

/** The TA's own cutoff formula (UTILS epoch_cutoff_from_days):
 *  midnight-today-UTC − days*86400. */
export const cutoffFromDays = (days: number, nowSec: number): number => {
    const midnight = nowSec - (nowSec % 86400);
    return midnight - days * 86400;
};

const emptyParse = (): IngestParseResult => ({
    inputShape: 'unknown',
    parseStatus: 'unparsed',
    parseNote: '',
    filterEnabled: null,
    daysInPast: null,
    cutoffEpoch: null,
    includeFilters: [],
    excludeFilters: [],
    filtersApproximate: false,
    cloudProviderStamp: null,
    sourceHost: '',
});

const finishFromSettings = (
    r: IngestParseResult,
    fields: Partial<
        Record<'filter_enabled' | 'include_filters' | 'exclude_filters' | 'days_in_past', string>
    >,
    nowSec: number,
): IngestParseResult => {
    const seen = Object.keys(fields).filter(
        (k) => typeof fields[k as keyof typeof fields] === 'string',
    ).length;
    if (seen === 0) {
        r.parseStatus = 'unparsed';
        return r;
    }
    if (typeof fields.filter_enabled === 'string') {
        r.filterEnabled = fields.filter_enabled.trim() === '1';
    }
    if (typeof fields.include_filters === 'string') {
        r.includeFilters = parseCommaPatterns(fields.include_filters);
    }
    if (typeof fields.exclude_filters === 'string') {
        r.excludeFilters = parseCommaPatterns(fields.exclude_filters);
    }
    if (typeof fields.days_in_past === 'string') {
        const n = parseInt(fields.days_in_past.trim() || '0', 10);
        r.daysInPast = Number.isFinite(n) && n >= 0 ? n : null;
    }
    if (r.filterEnabled === true && r.daysInPast !== null && r.daysInPast > 0) {
        r.cutoffEpoch = cutoffFromDays(r.daysInPast, nowSec);
    }
    r.parseStatus =
        r.filterEnabled !== null && (r.filterEnabled === false || seen >= 4)
            ? 'parsed'
            : 'partial';
    return r;
};

const parseRestJson = (text: string, nowSec: number): IngestParseResult | null => {
    let doc: unknown;
    try {
        doc = JSON.parse(text);
    } catch (_e) {
        return null;
    }
    if (typeof doc !== 'object' || doc === null) return null;
    const d = doc as Record<string, unknown>;
    const r = emptyParse();
    r.inputShape = 'rest-json';
    let content: Record<string, unknown> | null = null;
    if (Array.isArray(d.entry)) {
        const entries = d.entry as Array<Record<string, unknown>>;
        // Pick the filter_settings entry by NAME — a parent-endpoint paste
        // carries cloud_provider_settings too (§15.8a-19).
        const fs =
            entries.find((e) => e && e.name === 'filter_settings') ||
            (entries.length === 1 ? entries[0] : undefined);
        if (fs && typeof fs.content === 'object' && fs.content !== null) {
            content = fs.content as Record<string, unknown>;
        }
        const idUrl =
            (fs && typeof fs.id === 'string' && fs.id) ||
            (typeof d.origin === 'string' && d.origin) ||
            '';
        const hm = /https?:\/\/([^/:]+)/.exec(idUrl);
        if (hm) r.sourceHost = hm[1];
    } else if (
        typeof d.days_in_past === 'string' ||
        typeof d.include_filters === 'string' ||
        typeof d.filter_enabled === 'string'
    ) {
        content = d; // a bare content object pasted on its own
    }
    if (!content) {
        r.parseStatus = 'unparsed';
        return r;
    }
    const pick = (k: string): string | undefined =>
        typeof content![k] === 'string' ? (content![k] as string) : undefined;
    return finishFromSettings(
        r,
        {
            filter_enabled: pick('filter_enabled'),
            include_filters: pick('include_filters'),
            exclude_filters: pick('exclude_filters'),
            days_in_past: pick('days_in_past'),
        },
        nowSec,
    );
};

const parseRestXml = (text: string, nowSec: number): IngestParseResult | null => {
    if (text.indexOf('<s:key') === -1) return null;
    const r = emptyParse();
    r.inputShape = 'rest-xml';
    // Scope to the filter_settings entry when multiple entries are present.
    let scope = text;
    const entries = text.split(/<entry[\s>]/).slice(1);
    if (entries.length > 0) {
        const fs = entries.find((e) => /<title>filter_settings<\/title>/.test(e));
        if (fs) scope = fs;
        else if (entries.length >= 1) {
            r.parseStatus = 'unparsed';
            r.parseNote =
                'The pasted XML has no filter_settings entry (a cloud_provider_settings-only paste?).';
            return r;
        }
    }
    const key = (name: string): string | undefined => {
        const m = new RegExp('<s:key name="' + name + '">([^<]*)</s:key>').exec(scope);
        return m ? m[1] : undefined;
    };
    const idm =
        /<id>\s*https?:\/\/([^/:]+)/.exec(scope) || /<id>\s*https?:\/\/([^/:]+)/.exec(text);
    if (idm) r.sourceHost = idm[1];
    return finishFromSettings(
        r,
        {
            filter_enabled: key('filter_enabled'),
            include_filters: key('include_filters'),
            exclude_filters: key('exclude_filters'),
            days_in_past: key('days_in_past'),
        },
        nowSec,
    );
};

/**
 * Pull `dir/subdir` pattern pairs out of a generated include/exclude REGEX.
 * Inverse of the fnmatch fragments: the generator (`fnmatch.translate`) maps
 * `*` -> `.*`, `?` -> `.`, and every LITERAL char through `re.escape` — which
 * backslash-escapes far more than the dot (a hyphen becomes an escaped
 * hyphen; older Pythons escape colon too). §19.8a-6 (review blocker B6): the
 * inverse must therefore be the GENERIC un-escape — backslash + any char ->
 * that char — not a dot-only special case; the previous dot-only form copied
 * `\-` through verbatim, the residue class did not reject the backslash, and
 * the mis-recovered pattern then fed `fnmatchLite` a literal backslash that
 * matches no real value. Backslash itself is now also in the residue class as
 * a backstop (a trailing lone backslash cannot be inverted). Any OTHER regex
 * residue (e.g. Python 3.13's atomic groups) makes the pattern UNRECOVERABLE
 * — the caller degrades parseStatus to 'partial'.
 */
const unmapFragment = (frag: string): string | null => {
    let out = '';
    let i = 0;
    const BACKSLASH = String.fromCharCode(92);
    while (i < frag.length) {
        const ch = frag[i];
        if (ch === BACKSLASH && i + 1 < frag.length) {
            out += frag[i + 1]; // generic re.escape inverse (§19.8a-6)
            i += 2;
        } else if (ch === '.' && frag[i + 1] === '*') {
            out += '*'; // fnmatch *
            i += 2;
        } else if (ch === '.') {
            out += '?'; // fnmatch ?
            i += 1;
        } else {
            out += ch;
            i += 1;
        }
    }
    // residue check: any remaining regex metachar (or a stray backslash)
    // means we cannot faithfully reconstruct the operator's pattern
    if (/[\\()[\]{}^$+|]/.test(out)) return null;
    return out;
};

const clzPairsFromRegex = (
    regexText: string,
): { pairs: string[]; unrecoverable: boolean } => {
    const out: string[] = [];
    let unrecoverable = false;
    const PAIR = new RegExp(
        '"clz_dir"' +
            '\\\\s\\*:\\\\s\\*' +
            '"([^"]*)"' +
            '[\\s\\S]*?' +
            '"clz_subdir"' +
            '\\\\s\\*:\\\\s\\*' +
            '"([^"]*)"',
        'g',
    );
    let m = PAIR.exec(regexText);
    while (m) {
        const dir = unmapFragment(m[1]);
        const sub = unmapFragment(m[2]);
        if (dir === null || sub === null) {
            unrecoverable = true;
        } else {
            const pair = dir + '/' + sub;
            if (out.indexOf(pair) === -1) out.push(pair);
        }
        m = PAIR.exec(regexText);
    }
    return { pairs: out, unrecoverable };
};

const stanzaBody = (text: string, stanza: string): string | null => {
    const at = text.indexOf('[' + stanza + ']');
    if (at === -1) return null;
    const rest = text.slice(at + stanza.length + 2);
    const next = rest.search(/\n\s*\[/);
    return next === -1 ? rest : rest.slice(0, next);
};

const FILTER_MARKER_START = '### BEGIN LOGSERV FILTER CONFIG';
const FILTER_MARKER_END = '### END LOGSERV FILTER CONFIG ###';
const CLOUD_MARKER_START = '### BEGIN LOGSERV CLOUD_PROVIDER CONFIG';
const CLOUD_MARKER_END = '### END LOGSERV CLOUD_PROVIDER CONFIG ###';

const parseTransformsConf = (text: string, nowSec: number): IngestParseResult | null => {
    const hasFilterStart = text.indexOf(FILTER_MARKER_START) !== -1;
    const hasCloudStart = text.indexOf(CLOUD_MARKER_START) !== -1;
    const hasStanza = text.indexOf('[logserv_filter_') !== -1;
    const hasPropsLine = text.indexOf('TRANSFORMS-00-filter') !== -1;
    // Wrong-file discriminators (§15.8a-15): the Data TA's DEFAULT
    // transforms.conf (routing stanzas) is recognizably a conf paste too —
    // it must classify here and get the hint, never fall through to
    // "unparsed" with no explanation (or worse, to a disabled conclusion).
    const looksLikeDefaultConf =
        text.indexOf('@logserv_filter') !== -1 ||
        text.indexOf('[set_srctype_') !== -1 ||
        text.indexOf('[extract_clz]') !== -1 ||
        text.indexOf('MetaData:Sourcetype') !== -1;
    if (!hasFilterStart && !hasCloudStart && !hasStanza && !hasPropsLine && !looksLikeDefaultConf) {
        return null;
    }
    const r = emptyParse();
    r.inputShape = 'transforms-conf';
    r.filtersApproximate = true;
    if (looksLikeDefaultConf) {
        r.parseStatus = 'unparsed';
        r.parseNote =
            'This looks like the Data TA’s shipped default/transforms.conf (routing rules), not the generated local/transforms.conf — paste the local file.';
        r.filtersApproximate = false;
        return r;
    }
    /* §19.4/§19.8a-8 — the cloud-provider stamp, from the EXPLICIT stanza
     * ONLY (positioned before the !hasStanza branch so it is recovered on
     * both the enabled and disabled paths). NO inference from absence: a
     * truncated or partially-copied paste proves nothing (review blocker
     * B1), so a missing stanza leaves the stamp null — never 'not_set'. The
     * generator's exact shape (rh_filter_settings.py, gate-pinned):
     *   [logserv_set_cloud_provider]
     *   REGEX = .
     *   FORMAT = cloud_provider::<aws|azure|gcp>
     *   WRITE_META = true */
    {
        const cloudBody = stanzaBody(text, 'logserv_set_cloud_provider');
        if (cloudBody) {
            const fm = /FORMAT\s*=\s*cloud_provider::([A-Za-z_]+)/.exec(cloudBody);
            if (fm && (fm[1] === 'aws' || fm[1] === 'azure' || fm[1] === 'gcp')) {
                r.cloudProviderStamp = fm[1];
            } else if (fm) {
                r.parseNote =
                    (r.parseNote ? r.parseNote + ' ' : '') +
                    `The cloud-provider stamp value "${fm[1].slice(0, 32)}" is not a known provider — it was ignored.`;
            }
        }
    }
    if (!hasStanza) {
        if (hasPropsLine) {
            // A props.conf paste: the TRANSFORMS-00-filter line proves the
            // filters are ACTIVE but carries no patterns or cutoff.
            r.filterEnabled = true;
            r.parseStatus = 'partial';
            r.parseNote =
                'A props.conf paste proves the filters are active but carries no patterns — paste local/transforms.conf.';
            return r;
        }
        // A "disabled" conclusion needs POSITIVE generated-file signatures
        // (§15.8a-15): a complete marker PAIR, not mere absence.
        const filterPairComplete =
            hasFilterStart && text.indexOf(FILTER_MARKER_END) !== -1;
        const cloudPairComplete = hasCloudStart && text.indexOf(CLOUD_MARKER_END) !== -1;
        if (filterPairComplete || cloudPairComplete) {
            r.filterEnabled = false;
            r.parseStatus = 'parsed';
            r.filtersApproximate = false;
            return r;
        }
        r.parseStatus = 'partial';
        r.parseNote =
            'The paste has a marker line but no complete marker pair — it may be cut off; re-paste the whole file.';
        return r;
    }
    r.filterEnabled = true;
    let anyUnrecoverable = false;
    const timeBody = stanzaBody(text, 'logserv_filter_time_drop');
    if (timeBody) {
        const rm = /REGEX\s*=\s*([^\n\r]+)/.exec(timeBody);
        if (rm) {
            r.cutoffEpoch = recoverCutoffFromRegex(rm[1], nowSec);
            if (r.cutoffEpoch === null) anyUnrecoverable = true;
        }
    }
    const incBody = stanzaBody(text, 'logserv_filter_include_allow');
    if (incBody) {
        const rm = /REGEX\s*=\s*([^\n\r]+)/.exec(incBody);
        if (rm) {
            const rec = clzPairsFromRegex(rm[1]);
            r.includeFilters = rec.pairs;
            if (rec.unrecoverable) anyUnrecoverable = true;
        }
    } else {
        r.includeFilters = []; // no include gate generated = pass-all
    }
    const excBody = stanzaBody(text, 'logserv_filter_exclude');
    if (excBody) {
        const rm = /REGEX\s*=\s*([^\n\r]+)/.exec(excBody);
        if (rm) {
            const rec = clzPairsFromRegex(rm[1]);
            r.excludeFilters = rec.pairs;
            if (rec.unrecoverable) anyUnrecoverable = true;
        }
    }
    r.parseStatus = anyUnrecoverable ? 'partial' : 'parsed';
    if (anyUnrecoverable) {
        r.parseNote =
            'Some generated filter expressions could not be faithfully reconstructed (hand-edited or from a different version?) — the recovered fields are incomplete.';
    }
    return r;
};

const parseSettingsConf = (text: string, nowSec: number): IngestParseResult | null => {
    if (text.indexOf('[filter_settings]') === -1) return null;
    const body = stanzaBody(text, 'filter_settings');
    if (body === null) return null;
    const r = emptyParse();
    r.inputShape = 'settings-conf';
    /* §19.4 — an optional [cloud_provider_settings] stanza alongside. The
     * settings conf is the ONE shape that can carry the literal `not_set`
     * (the generated transforms file REMOVES the stamp block for Not-set —
     * absence there is not evidence; an explicit value here is). */
    {
        const cloudBody = stanzaBody(text, 'cloud_provider_settings');
        if (cloudBody) {
            const cm = /^\s*cloud_provider\s*=\s*([A-Za-z_]+)\s*$/m.exec(cloudBody);
            if (cm && STAMP_VALUES.indexOf(cm[1] as CloudProviderStamp) !== -1) {
                r.cloudProviderStamp = cm[1] as CloudProviderStamp;
            }
        }
    }
    const key = (name: string): string | undefined => {
        const m = new RegExp('^\\s*' + name + '\\s*=([^\\n\\r]*)$', 'm').exec(body);
        return m ? m[1].trim() : undefined;
    };
    return finishFromSettings(
        r,
        {
            filter_enabled: key('filter_enabled'),
            include_filters: key('include_filters'),
            exclude_filters: key('exclude_filters'),
            days_in_past: key('days_in_past'),
        },
        nowSec,
    );
};

/**
 * Parse a SCRUBBED paste. Never throws; never returns null — unparseable
 * input comes back `{parseStatus: 'unparsed'}` and is still stored verbatim
 * (scrubbed), per §3.4. CRLF/CR are normalized before sniffing (§15.8a-19).
 */
export const parseIngestPaste = (scrubbed: string, nowSec: number): IngestParseResult => {
    const text = scrubbed.replace(/\r\n?/g, '\n').trim();
    if (text.length === 0) return emptyParse();
    return (
        parseRestJson(text, nowSec) ||
        parseRestXml(text, nowSec) ||
        parseTransformsConf(text, nowSec) ||
        parseSettingsConf(text, nowSec) ||
        emptyParse()
    );
};

// ---------------------------------------------------------------------------
// Fingerprints + confidence discipline (§15.8a-8/12)
// ---------------------------------------------------------------------------

/**
 * The SHIPPED-DEFAULTS fingerprint (§15.8a-12): `filter_enabled=0`,
 * the pass-all include default, no excludes, `days_in_past=7` on a REST/settings shape is
 * byte-indistinguishable from what a DS-managed Heavy Forwarder's endpoint
 * returns REGARDLESS of the pushed configuration (and from an unconfigured
 * install). Every surface that renders the disabled elimination must hedge
 * when this is set, and the boundary line keeps the ask.
 */
export const isDefaultsShape = (facts: IngestFacts): boolean =>
    (facts.inputShape === 'rest-json' ||
        facts.inputShape === 'rest-xml' ||
        facts.inputShape === 'settings-conf') &&
    facts.filterEnabled === false &&
    facts.daysInPast === 7 &&
    facts.excludeFilters.length === 0 &&
    facts.includeFilters.length === 1 &&
    facts.includeFilters[0] === '*/*';

export type SuppliedConfidence = 'confirmed' | 'likely' | 'possible';

/**
 * The shared confidence ceiling for verdicts built on supplied facts
 * (§15.8a-8): parsed + fresh + exact -> confirmed; stale or approximate ->
 * likely; partial -> possible. A caveat line is not a confidence model.
 */
export const suppliedConfidenceCap = (facts: IngestFacts, nowSec: number): SuppliedConfidence => {
    if (facts.parseStatus === 'partial') return 'possible';
    if (facts.filtersApproximate) return 'likely';
    if (nowSec - facts.suppliedAt > INGEST_FACTS_STALE_SECONDS) return 'likely';
    return 'confirmed';
};

export const minConfidence = (
    a: SuppliedConfidence,
    b: SuppliedConfidence,
): SuppliedConfidence => {
    const order: SuppliedConfidence[] = ['possible', 'likely', 'confirmed'];
    return order[Math.min(order.indexOf(a), order.indexOf(b))];
};

// ---------------------------------------------------------------------------
// KV storage — fixed-key create-or-overwrite + sanitize-on-read
// ---------------------------------------------------------------------------

const APP_NAMESPACE = 'splunk_app_sap_logserv';
const KV_BASE =
    `/en-US/splunkd/__raw/servicesNS/nobody/${APP_NAMESPACE}` +
    `/storage/collections/data/${DIAG_INGEST_FACTS_COLLECTION}`;

const readCsrfToken = (): string => {
    if (typeof document === 'undefined') return '';
    const m = `; ${document.cookie}`.match(/; splunkweb_csrf_token_\d+=([^;]+)/);
    return m ? decodeURIComponent(m[1]) : '';
};

const mutatingHeaders = (): Record<string, string> => ({
    'X-Requested-With': 'XMLHttpRequest',
    'Content-Type': 'application/json',
    'X-Splunk-Form-Key': readCsrfToken(),
});

/** The stored row (§15.8a-25): pattern lists JSON-encoded; booleans 0/1;
 *  null numbers OMITTED; the scrubbed raw stored ONLY for partial/unparsed
 *  (§15.8a-22 — for a parsed paste the fields carry the value and the raw
 *  adds only exposure). */
export const factsToRecord = (facts: IngestFacts, appBuild: string): Record<string, unknown> => {
    const rec: Record<string, unknown> = {
        _key: INGEST_FACTS_KEY,
        supplied_at: Math.floor(facts.suppliedAt),
        supplied_at_iso: new Date(facts.suppliedAt * 1000).toISOString(),
        supplied_by: facts.suppliedBy,
        source_host: facts.sourceHost,
        input_shape: facts.inputShape,
        parse_status: facts.parseStatus,
        parse_note: facts.parseNote,
        include_filters_json: JSON.stringify(facts.includeFilters),
        exclude_filters_json: JSON.stringify(facts.excludeFilters),
        filters_approximate: facts.filtersApproximate ? 1 : 0,
        scrubbed_raw: facts.parseStatus === 'parsed' ? '' : facts.scrubbedRaw,
        app_build: appBuild,
    };
    if (facts.filterEnabled !== null) rec.filter_enabled = facts.filterEnabled ? 1 : 0;
    if (facts.daysInPast !== null) rec.days_in_past = facts.daysInPast;
    if (facts.cutoffEpoch !== null) rec.cutoff_epoch = facts.cutoffEpoch;
    // §19.8a-9 — OMIT when null (the numeric convention): a stored empty
    // string must never read back as a value.
    if (facts.cloudProviderStamp !== null) rec.cloud_provider_stamp = facts.cloudProviderStamp;
    return rec;
};

const SHAPES: IngestInputShape[] = [
    'rest-json',
    'rest-xml',
    'transforms-conf',
    'settings-conf',
    'unknown',
];
const STATUSES: IngestParseStatus[] = ['parsed', 'partial', 'unparsed'];

/** The TA's per-segment pattern grammar — read-side clamp (§15.8a-24). */
const SEGMENT_OK = /^[a-zA-Z0-9*?._:-]+$/;
const patternOk = (p: string): boolean => {
    if (p.length === 0 || p.length > INGEST_MAX_PATTERN_CHARS) return false;
    const i = p.indexOf('/');
    if (i === -1) return SEGMENT_OK.test(p); // slashless (inert but displayable)
    return SEGMENT_OK.test(p.slice(0, i)) && SEGMENT_OK.test(p.slice(i + 1));
};

/** §19.8a-7 (H17) — the read-side clamp is NOT silent: `clamped` is true
 *  whenever the returned list differs from what the row stored (entries
 *  dropped by the grammar clamp, the count cap, or an unreadable encoding),
 *  and `looksLikeIngestFacts` folds it into `filtersApproximate` so a
 *  clamped list can never carry an exact-shape confidence. */
const readPatternList = (v: unknown): { list: string[]; clamped: boolean } => {
    if (typeof v !== 'string' || v.length === 0) return { list: [], clamped: false };
    try {
        const arr = JSON.parse(v);
        if (!Array.isArray(arr)) return { list: [], clamped: true };
        const list = arr
            .filter((p): p is string => typeof p === 'string')
            .filter(patternOk)
            .slice(0, INGEST_MAX_PATTERNS);
        return { list, clamped: list.length !== arr.length };
    } catch (_e) {
        return { list: [], clamped: true };
    }
};

/** Sanitize-on-read: the collection is world-writable, so every field a
 *  consumer dereferences is validated, and domain-invalid values are NULLED
 *  so they cannot steer a verdict (§15.8a-24). Off-shape rows read as null
 *  (as if never supplied). */
export const looksLikeIngestFacts = (row: unknown, nowSec: number): IngestFacts | null => {
    if (typeof row !== 'object' || row === null) return null;
    const r = row as Record<string, unknown>;
    const at = typeof r.supplied_at === 'number' ? r.supplied_at : NaN;
    if (!Number.isFinite(at) || at <= 0 || at > nowSec + 86400) return null;
    const str = (v: unknown): string => (typeof v === 'string' ? v : '');
    const shape = str(r.input_shape) as IngestInputShape;
    const status = str(r.parse_status) as IngestParseStatus;
    if (SHAPES.indexOf(shape) === -1 || STATUSES.indexOf(status) === -1) return null;
    const numOrNull = (v: unknown): number | null =>
        typeof v === 'number' && Number.isFinite(v) ? v : null;
    const bool01 = (v: unknown): boolean | null =>
        v === 1 || v === '1' || v === true
            ? true
            : v === 0 || v === '0' || v === false
              ? false
              : null;
    const scrubbed = str(r.scrubbed_raw);
    if (scrubbed.length > MAX_INGEST_PASTE_CHARS + 100) return null;
    const daysRaw = numOrNull(r.days_in_past);
    const cutoffRaw = numOrNull(r.cutoff_epoch);
    const inc = readPatternList(r.include_filters_json);
    const exc = readPatternList(r.exclude_filters_json);
    // §19.8a-9 — sanitize-on-read allowlist: absent, empty and any other
    // value all read as null (the row is world-writable).
    const stampRaw = str(r.cloud_provider_stamp);
    const stamp: CloudProviderStamp | null =
        STAMP_VALUES.indexOf(stampRaw as CloudProviderStamp) !== -1
            ? (stampRaw as CloudProviderStamp)
            : null;
    return {
        suppliedAt: at,
        suppliedBy: str(r.supplied_by).slice(0, 128),
        sourceHost: str(r.source_host).slice(0, 256),
        inputShape: shape,
        parseStatus: status,
        parseNote: str(r.parse_note).slice(0, 512),
        filterEnabled: bool01(r.filter_enabled),
        // Domain clamps (§15.8a-24): out-of-range values are NULLED, not trusted.
        daysInPast:
            daysRaw !== null && daysRaw >= 0 && daysRaw <= INGEST_MAX_DAYS_IN_PAST
                ? daysRaw
                : null,
        cutoffEpoch:
            cutoffRaw !== null && cutoffRaw > 1000000000 && cutoffRaw <= nowSec + 86400
                ? cutoffRaw
                : null,
        includeFilters: inc.list,
        excludeFilters: exc.list,
        // §19.8a-7 — a read-side clamp makes the shape inexact.
        filtersApproximate: bool01(r.filters_approximate) === true || inc.clamped || exc.clamped,
        cloudProviderStamp: stamp,
        scrubbedRaw: scrubbed,
    };
};

/** Best-effort write; never throws. Fixed-key create-or-overwrite: POST to
 *  /latest replaces; 404 means no row yet -> POST the record to the base;
 *  a 409 there (two concurrent first pastes) retries /latest once
 *  (§15.8a-26). */
export const writeIngestFacts = async (
    facts: IngestFacts,
    appBuild: string,
    fetchImpl?: FetchLike,
): Promise<{ ok: boolean; reason: string }> => {
    const f = fetchImpl || defaultFetch;
    try {
        const record = factsToRecord(facts, appBuild);
        const body = JSON.stringify(record);
        const post = (url: string) =>
            f(url, {
                method: 'POST',
                credentials: 'same-origin',
                headers: mutatingHeaders(),
                body,
            });
        const upd = await post(`${KV_BASE}/${INGEST_FACTS_KEY}`);
        if (upd.ok) return { ok: true, reason: '' };
        if (upd.status !== 404)
            return { ok: false, reason: `KV Store write failed: HTTP ${upd.status}` };
        const ins = await post(KV_BASE);
        if (ins.ok) return { ok: true, reason: '' };
        if (ins.status === 409) {
            const retry = await post(`${KV_BASE}/${INGEST_FACTS_KEY}`);
            if (retry.ok) return { ok: true, reason: '' };
            return { ok: false, reason: `KV Store write failed: HTTP ${retry.status}` };
        }
        return { ok: false, reason: `KV Store insert failed: HTTP ${ins.status}` };
    } catch (e) {
        return { ok: false, reason: e instanceof Error ? e.message : String(e) };
    }
};

/** Sanitize a raw KV row into threaded facts: shape gate + domain clamps +
 *  the excerpt truncation that keeps the full raw out of evidence/reports
 *  (§15.8a-23). Shared by `fetchIngestFacts` and the ProbeRunner path. */
export const sanitizeFetchedFactsRow = (row: unknown, nowSec: number): IngestFacts | null => {
    const facts = looksLikeIngestFacts(row, nowSec);
    if (facts && facts.scrubbedRaw.length > INGEST_RAW_EXCERPT_CHARS) {
        facts.scrubbedRaw =
            facts.scrubbedRaw.slice(0, INGEST_RAW_EXCERPT_CHARS) +
            '\n[excerpt — the full scrubbed paste is stored in the diagnostic collection]';
    }
    return facts;
};

/** Read the latest supplied facts; facts=null with error=null means "not
 *  supplied". The returned scrubbedRaw is ALREADY truncated to the excerpt
 *  cap — the full raw never leaves the collection (§15.8a-23). */
export const fetchIngestFacts = async (
    fetchImpl?: FetchLike,
    nowSec?: number,
): Promise<{ facts: IngestFacts | null; error: string | null }> => {
    const f = fetchImpl || defaultFetch;
    const now = typeof nowSec === 'number' ? nowSec : Math.floor(Date.now() / 1000);
    try {
        const resp = await f(`${KV_BASE}/${INGEST_FACTS_KEY}`, {
            credentials: 'same-origin',
            headers: { 'X-Requested-With': 'XMLHttpRequest' },
        });
        if (resp.status === 404) return { facts: null, error: null };
        if (!resp.ok) return { facts: null, error: `HTTP ${resp.status}` };
        const row = await resp.json();
        return { facts: sanitizeFetchedFactsRow(row, now), error: null };
    } catch (e) {
        return { facts: null, error: e instanceof Error ? e.message : String(e) };
    }
};

// ---------------------------------------------------------------------------
// Shared wording helpers (used by diagReport + the page + the cascade)
// ---------------------------------------------------------------------------

const fmtUtc = (epochSeconds: number): string =>
    new Date(epochSeconds * 1000).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';

/** The provenance line every §15 surface carries — "recorded as", never an
 *  attestation (§15.8a-13). */
export const provenanceLine = (facts: IngestFacts): string => {
    const host = facts.sourceHost ? `, from host ${facts.sourceHost}` : '';
    return `Recorded as supplied by ${facts.suppliedBy || 'an unknown user'}, ${fmtUtc(facts.suppliedAt)}${host}. Operator-supplied, not observed from this search head.`;
};

export const factsAreStale = (facts: IngestFacts, nowSec: number): boolean =>
    nowSec - facts.suppliedAt > INGEST_FACTS_STALE_SECONDS;

export const staleCaveatLine = (facts: IngestFacts, nowSec: number): string | null =>
    factsAreStale(facts, nowSec)
        ? `The supplied configuration is ${Math.round((nowSec - facts.suppliedAt) / 86400)} days old — the Data TA's filters may have changed since; re-supply it to be sure.`
        : null;

/** The hedge every disabled-elimination surface appends when the paste
 *  matches the shipped defaults (§15.8a-12). */
export const DEFAULTS_SHAPE_HEDGE =
    'Note: this is also exactly what a heavy forwarder’s endpoint reports regardless of the ' +
    'pushed configuration, and what an unconfigured install reports — if this output came ' +
    'from a heavy forwarder, re-supply using the HF’s local/transforms.conf file paste.';

/** §19.8a-9 — the stamp clause every `ingestFactsSummary` return path
 *  appends when the stamp is known (M10: it is orthogonal to whether
 *  filtering is enabled, so the disabled and unknown-enabled branches carry
 *  it too). '' when unknown. Undefined-safe by membership test — older
 *  fixtures/rows carry no stamp field at all (§12.3 discipline). */
export const knownStamp = (facts: IngestFacts | null | undefined): CloudProviderStamp | null => {
    const s = facts ? facts.cloudProviderStamp : null;
    return s === 'aws' || s === 'azure' || s === 'gcp' || s === 'not_set' ? s : null;
};

const stampClause = (facts: IngestFacts): string => {
    const s = knownStamp(facts);
    if (s === null) return '';
    return s === 'not_set' ? ' Cloud-provider stamp: not set.' : ` Cloud-provider stamp: ${s}.`;
};

/** One-sentence summary of what was supplied (the boundary-line replacement
 *  and the page display). The elimination is supplied-config-relative, never
 *  absolute (§15.8a-12). */
export const ingestFactsSummary = (facts: IngestFacts): string => {
    if (facts.parseStatus === 'unparsed') {
        return (
            'The supplied text could not be parsed as a filter configuration (it is stored verbatim for support).' +
            (facts.parseNote ? ' ' + facts.parseNote : '') +
            stampClause(facts)
        );
    }
    if (facts.filterEnabled === false) {
        const base = `The supplied configuration (recorded as supplied by ${facts.suppliedBy || 'an unknown user'}) reports ingest filtering DISABLED.`;
        return (isDefaultsShape(facts) ? `${base} ${DEFAULTS_SHAPE_HEDGE}` : base) + stampClause(facts);
    }
    if (facts.filterEnabled === null) {
        return (
            'Whether ingest filtering is enabled could not be determined from the supplied text.' +
            stampClause(facts)
        );
    }
    const parts: string[] = ['The supplied configuration reports ingest filtering ENABLED'];
    if (facts.cutoffEpoch !== null) {
        parts.push(
            `events older than ${fmtUtc(facts.cutoffEpoch)} are dropped` +
                (facts.daysInPast !== null ? ` (days-in-past: ${facts.daysInPast})` : ''),
        );
    } else {
        parts.push('no time cutoff recovered');
    }
    parts.push(
        isPassAllInclude(facts.includeFilters)
            ? 'include: all log types'
            : `include: ${facts.includeFilters.join(', ')}`,
    );
    parts.push(
        facts.excludeFilters.length > 0
            ? `exclude: ${facts.excludeFilters.join(', ')}`
            : 'no excludes',
    );
    return parts.join('; ') + '.' + stampClause(facts);
};

/**
 * §19.8a-18 — the shared boundary predicate: do the supplied facts actually
 * ANSWER the ingest-filter boundary question? Drives BOTH the report's
 * `cannotCheckLines` (keep vs drop the ask) and the drawer's §19.5 pointer,
 * so the two surfaces cannot drift. Unusable: nothing supplied, an unparsed
 * paste, a parse that could not determine whether filtering is enabled, or
 * the shipped-defaults fingerprint (an HF's endpoint reports that regardless
 * of the pushed configuration — §15.8a-12, the ask must survive).
 */
export const factsUsableForBoundary = (facts: IngestFacts | null | undefined): boolean =>
    !!facts &&
    facts.parseStatus !== 'unparsed' &&
    facts.filterEnabled !== null &&
    !isDefaultsShape(facts);

/**
 * §19.8a-4 — the facts+window half of checks 28 and item 3's context line,
 * shared so gather and cascade cannot drift. Lives HERE (the only cycle-free
 * home: both diagCascade and diagEvidence import this module). Takes a
 * PRE-COMPUTED `winEnd` — window parsing stays with each caller. The
 * `indexRowsInWindow` / visibility conditions stay explicit at the call
 * sites (H18).
 *
 * The daysInPast recompute (H10) is a consistency belt for the
 * world-writable row: a hand-POSTed `cutoff_epoch` far in the past alongside
 * a small `days_in_past` would otherwise pass the recorded-cutoff comparison
 * alone. For honestly-supplied facts the recomputed cutoff only slides
 * FORWARD from the recorded one, so the conjunction never suppresses a true
 * case.
 */
export const ingestCutoffApplicable = (
    fx: IngestFacts | null | undefined,
    winEnd: number | null,
    nowSec: number,
): boolean => {
    if (!fx) return false;
    if (fx.parseStatus === 'unparsed') return false;
    if (fx.filterEnabled !== true) return false;
    if (typeof fx.cutoffEpoch !== 'number' || !Number.isFinite(fx.cutoffEpoch)) return false;
    if (winEnd === null) return false; // unparseable bound: skip, never guess
    if (winEnd >= fx.cutoffEpoch) return false; // straddling/after: not this story
    if (fx.daysInPast !== null && winEnd >= cutoffFromDays(fx.daysInPast, nowSec)) return false;
    return true;
};

/** The report/page excerpt of the scrubbed paste ('' when none retained). */
export const scrubbedExcerpt = (facts: IngestFacts): string => {
    const raw = facts.scrubbedRaw || '';
    if (raw.length <= INGEST_RAW_EXCERPT_CHARS) return raw;
    return (
        raw.slice(0, INGEST_RAW_EXCERPT_CHARS) +
        '\n[excerpt — the full scrubbed paste is stored on the Diagnostics page]'
    );
};
