/**
 * diagIngestFacts — operator-supplied ingest evidence (design §15 + §15.8a,
 * checks 27–29, session 099 / build 314).
 *
 * The search head cannot read the Data TA's ingest filters (include/exclude +
 * days_in_past run on the HF/indexer tier), which is the product's historical
 * #1 cause of "I see zero events". This module closes that boundary the only
 * honest way available: the operator runs a printed command, pastes the
 * output, and the diagnostic parses it into a CHECKED FACT — always badged
 * "Recorded as supplied by <user> (name not verified)", never "Observed".
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
 * review blocker B2): the Data TA's generator SKIPS any folder pattern without
 * a '/' — `exclude = *` excludes NOTHING. Pass-all (session 154, the Data TA's
 * fix 4d): the include list keeps everything iff its effective (slash-bearing)
 * part is empty, or ANY entry matches everything — star/star or a bare `*`
 * (before fix 4d a bare `*` inside a mixed list was inert; a paste from an
 * older Data TA with such a list is now read as pass-all, the conservative
 * direction: no exclusion is claimed). Matching is CASE-SENSITIVE (the
 * generated PCRE does not fold; python fnmatch's Windows case-folding is
 * deliberately NOT ported — §15.8a-18).
 *
 * TWO GENERATED SHAPES are inverted (session 154): the old
 * `^(?=.*"clz_dir"…)(?=.*"clz_subdir"…)` alternation of fnmatch.translate
 * fragments, and the current shape (design s154 §5a) — a skip anchor
 * (`TA_FILTER_REGEX_SKIP`) followed by `(?:entry|entry|…)`, each entry a run
 * of lookaheads that may not cross a `"_raw"` key, with hand-written value
 * fragments (`*` -> `[^"]*`, `?` -> `[^"]`, other non-word characters
 * backslash-escaped). Long lists are split over chunk stanzas `<name>_2`,
 * `<name>_3`, … which are merged in order. Since design s154 §5b the
 * generator translates `*` LINEARLY: the pattern is split on runs of `*`,
 * each MIDDLE segment is written as an atomic group `(?>[^"]*?SEG)` and only
 * the last `*` stays `[^"]*`; the inverse reads both value forms (§5a and
 * §5b) and nothing else. A run such as `**` is ONE `*` in the generated
 * text, so a pattern read back from transforms.conf is shown in that
 * collapsed form (`/var/log/**` + `/x.log` reads back as `/var/log/*` +
 * `/x.log` — the same matches); the settings shapes show the text as typed.
 *
 * KNOWN APPROXIMATION (§15.8a-20): the OLD generated PCRE is pathologically
 * MORE permissive than per-segment fnmatch for suffix/infix wildcards (a `.*`
 * inside `"clz_dir"\s*:\s*".*x"` can cross the value's closing quote and
 * match later raw content). Byte-equivalence with the PCRE is not achievable
 * from here; per-segment fnmatch is the documented approximation and is
 * exact for the controlled clz vocabulary (and for the current shape, whose
 * wildcards stay inside the quoted value).
 *
 * SOURCE RULES (Include Sources / Exclude Sources, session 154) match the
 * envelope's `source` value — a file path this module cannot map to a clz
 * folder. They may keep (include) or drop (exclude) SOME files of a folder,
 * so every per-type verdict stays folder-based and is marked approximate
 * when any source rule is in effect (`hasSourceRules`).
 *
 * NO-FOLDER ROUTES (session 155): the Data TA can also route a type by the
 * envelope's `source` path when the event carries NO folder fields
 * (`SOURCETYPE_NOFOLDER_SOURCES` - today the HANA trace files SAP delivers
 * under undefined/undefined). Folder filters cannot reach those events, so
 * `noFolderStatus` judges them from the include gate and the plain (folder-
 * less) source rules alone; check 29 caps every verdict that part changes at
 * `possible`, because the paste does not say whether the forwarders run such
 * a route, and adds a claim from it only on a panel that reads such types
 * alone (a HANA Trace panel) - there as a lead that never pre-empts an
 * observed verdict.
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
/** Session 154 — the source-rule lists (Include / Exclude Sources): an entry
 *  is `srcpat` (1..512 characters) or `dir/subdir=srcpat`. The Data TA field
 *  holds at most 4096 characters (one entry can never be longer), so these
 *  caps only bite on hand-POSTed rows. */
export const INGEST_MAX_SOURCE_PATTERNS = 256;
export const INGEST_MAX_SOURCE_ENTRY_CHARS = 4096;
export const INGEST_MAX_SOURCE_PATTERN_CHARS = 512;
/** A stored JSON list longer than this is not even parsed (world-writable row). */
export const INGEST_MAX_LIST_JSON_CHARS = 300000;

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
    // session 154 — the source-rule lists (JSON, like the folder lists);
    // rows written before them carry neither field and read as empty.
    'include_sources_json',
    'exclude_sources_json',
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
    /** Session 154 — Include / Exclude Sources AS SUPPLIED: entries `srcpat`
     *  or `dir/subdir=srcpat`, matched by the Data TA against the event's
     *  `source` value. Older rows and fixtures carry no field — read them
     *  through `includeSourcesOf` / `excludeSourcesOf` (undefined-safe). */
    includeSources: string[];
    excludeSources: string[];
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
    includeSources: string[];
    excludeSources: string[];
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
    linux_messages_syslog: ['linux/messages', 'linux/localmessages', 'linux/proxy'],
    'linux:cron': ['linux/cron'],
    'linux:warn': ['linux/warn'],
    'linux:sudolog': ['linux/sudolog'],
    'linux:slapd': ['linux/slapd', 'linux/pacemaker'],
    linux_secure: ['linux/linux_secure'],
    lastlog: ['linux/linux_secure'],
    who: ['linux/linux_secure'],
    'isc:bind:query': ['dns/binddns'],
    'isc:bind:lameserver': ['dns/binddns'],
    'isc:bind:network': ['dns/binddns'],
    'isc:bind:transfer': ['dns/binddns'],
    'squid:access': ['proxy/squid', 'linux/proxy'],
    'squid:cache': ['proxy/squid', 'linux/proxy'],
    'squid:store': ['proxy/squid', 'linux/proxy'],
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

/**
 * Session 155 - sourcetypes the Data TA can ALSO route WITHOUT folder fields,
 * by the envelope's `source` path, through a routing stanza that carries no
 * `@logserv_filter` annotation on purpose (it declares no folder). Today one:
 * `[set_srctype_hana_tracelogs_by_source]` routes the HANA trace files SAP
 * delivers under undefined/undefined (no clz_dir / clz_subdir key) into
 * `sap:hana:tracelogs`. Folder filters cannot reach those events: Exclude
 * Filters never drop them, a folder include gate drops them unless a plain
 * Include Sources entry lets them back in, and a plain Exclude Sources entry
 * can drop them (a `dir/subdir=pattern` entry needs the folder fields, so it
 * never matches them).
 *
 * The value is the Include Sources entry that keeps them - wording for the
 * operator, never evaluated here. bin/check-diagnostics.js derives the keys
 * from the Data TA's un-annotated, source-keyed routing stanzas and fails on
 * drift in both directions; every key needs its `NOFOLDER_LINES` entry.
 */
export const SOURCETYPE_NOFOLDER_SOURCES: Record<string, string[]> = {
    'sap:hana:tracelogs': ['/usr/sap/*/HDB??/*/trace/*'],
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

/** Does one include entry match every event? Exactly the generator's
 *  is_pass_all_include test: a bare `*`, or a `dir/subdir` pattern whose two
 *  segments are star runs (`**` alone is not a valid pattern — the Data TA
 *  refuses it — so it is not treated as one). */
const isMatchAllEntry = (p: string): boolean => {
    if (p === '*') return true;
    const parts = p.split('/');
    return parts.length === 2 && /^\*+$/.test(parts[0]) && /^\*+$/.test(parts[1]);
};

/** Pass-all include per the GENERATOR (session 154, the Data TA's fix 4d):
 *  the effective (slash-bearing) list is empty (nothing generated an include
 *  gate), or ANY entry matches everything — `*` + `/` + `*` or a bare `*`. */
export const isPassAllInclude = (patterns: string[]): boolean => {
    if (patterns.some(isMatchAllEntry)) return true;
    return effectivePatterns(patterns).length === 0;
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
// Source rules — Include / Exclude Sources (session 154)
// ---------------------------------------------------------------------------

/** The short note every surface carries when a source rule is in effect. */
export const SOURCE_RULES_NOTE = 'source rules may drop or keep some files of a folder';

const stringList = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : [];

/** Include Sources, undefined-safe (rows/fixtures from before session 154
 *  carry no field and read as empty). */
export const includeSourcesOf = (facts: IngestFacts | null | undefined): string[] =>
    facts ? stringList((facts as { includeSources?: unknown }).includeSources) : [];

/** Exclude Sources, undefined-safe. */
export const excludeSourcesOf = (facts: IngestFacts | null | undefined): string[] =>
    facts ? stringList((facts as { excludeSources?: unknown }).excludeSources) : [];

/** `dir/subdir=srcpat` -> folder + source pattern; a plain entry has no folder. */
export const splitSourceEntry = (entry: string): { folder: string | null; src: string } => {
    const eq = entry.indexOf('=');
    return eq === -1
        ? { folder: null, src: entry }
        : { folder: entry.slice(0, eq), src: entry.slice(eq + 1) };
};

/** Is any source rule IN EFFECT? None while the paste reports filtering
 *  DISABLED — the Data TA then generates no filter stanza at all, and the S3
 *  Direct preview shows no source note (an unknown state stays conservative).
 *  Exclude Sources always act; Include Sources act only behind an include
 *  gate — with a pass-all include list the Data TA refuses them at save and
 *  ignores them at generation. */
export const hasSourceRules = (facts: IngestFacts): boolean =>
    facts.filterEnabled !== false &&
    (excludeSourcesOf(facts).length > 0 ||
        (includeSourcesOf(facts).length > 0 && !isPassAllInclude(facts.includeFilters)));

/** Could Include Sources keep SOME events of these clz paths that the folder
 *  include gate drops? A plain entry may match a file in any folder; a
 *  `dir/subdir=srcpat` entry only in its own folder. Folder excludes run after
 *  the include stages and still win, so an excluded path is never rescued. */
export const includeSourcesMayKeep = (paths: string[], facts: IngestFacts): boolean => {
    if (facts.filterEnabled !== true) return false;
    const inc = includeSourcesOf(facts);
    if (inc.length === 0 || isPassAllInclude(facts.includeFilters)) return false;
    const effInc = effectivePatterns(facts.includeFilters);
    const effExc = effectivePatterns(facts.excludeFilters);
    return paths.some((path) => {
        if (effInc.some((p) => clzPathMatches(path, p))) return false;
        if (effExc.some((p) => clzPathMatches(path, p))) return false;
        return inc.some((e) => {
            const folder = splitSourceEntry(e).folder;
            return folder === null || clzPathMatches(path, folder);
        });
    });
};

/** Session 155 - how the supplied filters treat the events of a type that
 *  arrive WITHOUT folder fields (`SOURCETYPE_NOFOLDER_SOURCES`):
 *   - 'none'    the type has no no-folder route;
 *   - 'kept'    filtering is not reported enabled, or nothing the paste
 *               shows can drop them (no include gate, no plain Exclude
 *               Sources entry);
 *   - 'dropped' the folder include gate drops them and no plain Include
 *               Sources entry could let them back in;
 *   - 'may'     a plain source rule may keep them (behind the gate) or drop
 *               them - source paths are not evaluated here.
 *  Folder rules never reach these events, and a `dir/subdir=pattern` source
 *  entry needs the folder fields, so it never matches them either. The time
 *  filter is check 28's dimension. */
export type NoFolderStatus = 'kept' | 'dropped' | 'may' | 'none';

export const noFolderStatus = (sourcetype: string, facts: IngestFacts): NoFolderStatus => {
    if (!Object.prototype.hasOwnProperty.call(SOURCETYPE_NOFOLDER_SOURCES, sourcetype)) return 'none';
    if (facts.filterEnabled !== true) return 'kept';
    const plain = (list: string[]): string[] => list.filter((e) => splitSourceEntry(e).folder === null);
    const plainInc = plain(includeSourcesOf(facts));
    const plainExc = plain(excludeSourcesOf(facts));
    const gateDrops = !isPassAllInclude(facts.includeFilters);
    if (gateDrops && plainInc.length === 0) return 'dropped';
    if (gateDrops || plainExc.length > 0) return 'may';
    return 'kept';
};

/** The evidence line check 29 adds to a verdict about `sap:hana:tracelogs`
 *  (user decision U41: only when filtering is on - check 29's own
 *  precondition - and only on a HANA Trace panel, one that reads no-folder
 *  types alone; a panel that also reads other types never gets it). */
export const NOFOLDER_LINE =
    '`sap:hana:tracelogs` can also arrive without folder fields (HANA trace files SAP delivers under ' +
    'undefined/undefined, routed by their source path when the Data TA does so): folder filters do not ' +
    'reach them — Exclude Filters never drop them, an Include Filters allow-list drops them unless an ' +
    'Include Sources entry without a folder, such as /usr/sap/*/HDB??/*/trace/*, keeps them, and Exclude ' +
    'Sources can drop them.';

/** One evidence line per no-folder type (keys = SOURCETYPE_NOFOLDER_SOURCES,
 *  pinned by the consistency test). */
export const NOFOLDER_LINES: Record<string, string> = {
    'sap:hana:tracelogs': NOFOLDER_LINE,
};

/** A bounded display form of a pattern list (reports, evidence lines). */
export const patternListForDisplay = (list: string[], max = 10): string => {
    if (list.length <= max) return list.join(', ');
    return list.slice(0, max).join(', ') + `, … (+${list.length - max} more)`;
};

/** The evidence line a folder verdict carries when source rules are in effect
 *  (null when none are). */
export const sourceRulesLine = (facts: IngestFacts): string | null => {
    if (!hasSourceRules(facts)) return null;
    const parts: string[] = [];
    const inc = includeSourcesOf(facts);
    const exc = excludeSourcesOf(facts);
    if (inc.length > 0 && !isPassAllInclude(facts.includeFilters)) {
        parts.push(`include sources: ${patternListForDisplay(inc)}`);
    }
    if (exc.length > 0) parts.push(`exclude sources: ${patternListForDisplay(exc)}`);
    return (
        `The supplied configuration also has source rules (${parts.join('; ')}). They match file ` +
        `paths, which this check cannot map to folders: ${SOURCE_RULES_NOTE}, so this verdict is ` +
        'approximate.'
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
    includeSources: [],
    excludeSources: [],
    filtersApproximate: false,
    cloudProviderStamp: null,
    sourceHost: '',
});

/** The settings keys every settings-shaped paste is read through. The two
 *  source keys (session 154) are OPTIONAL: an older Data TA has no source
 *  rules, and a local conf omits keys left at their empty default — so an
 *  absent source key reads as an empty list and never makes a paste partial. */
type SettingsKey =
    | 'filter_enabled'
    | 'include_filters'
    | 'exclude_filters'
    | 'days_in_past'
    | 'include_sources'
    | 'exclude_sources';

const CORE_SETTINGS_KEYS: SettingsKey[] = [
    'filter_enabled',
    'include_filters',
    'exclude_filters',
    'days_in_past',
];

const finishFromSettings = (
    r: IngestParseResult,
    fields: Partial<Record<SettingsKey, string>>,
    nowSec: number,
): IngestParseResult => {
    const seen = Object.keys(fields).filter(
        (k) => typeof fields[k as keyof typeof fields] === 'string',
    ).length;
    if (seen === 0) {
        r.parseStatus = 'unparsed';
        return r;
    }
    const seenCore = CORE_SETTINGS_KEYS.filter((k) => typeof fields[k] === 'string').length;
    if (typeof fields.filter_enabled === 'string') {
        r.filterEnabled = fields.filter_enabled.trim() === '1';
    }
    if (typeof fields.include_filters === 'string') {
        r.includeFilters = parseCommaPatterns(fields.include_filters);
    }
    if (typeof fields.exclude_filters === 'string') {
        r.excludeFilters = parseCommaPatterns(fields.exclude_filters);
    }
    if (typeof fields.include_sources === 'string') {
        r.includeSources = parseCommaPatterns(fields.include_sources);
    }
    if (typeof fields.exclude_sources === 'string') {
        r.excludeSources = parseCommaPatterns(fields.exclude_sources);
    }
    if (typeof fields.days_in_past === 'string') {
        const n = parseInt(fields.days_in_past.trim() || '0', 10);
        r.daysInPast = Number.isFinite(n) && n >= 0 ? n : null;
    }
    if (r.filterEnabled === true && r.daysInPast !== null && r.daysInPast > 0) {
        r.cutoffEpoch = cutoffFromDays(r.daysInPast, nowSec);
    }
    r.parseStatus =
        r.filterEnabled !== null &&
        (r.filterEnabled === false || seenCore >= CORE_SETTINGS_KEYS.length)
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
        typeof d.filter_enabled === 'string' ||
        typeof d.include_sources === 'string' ||
        typeof d.exclude_sources === 'string'
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
            include_sources: pick('include_sources'),
            exclude_sources: pick('exclude_sources'),
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
            include_sources: key('include_sources'),
            exclude_sources: key('exclude_sources'),
        },
        nowSec,
    );
};

/**
 * OLD SHAPE (Data TA builds before session 154).
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

// ---------------------------------------------------------------------------
// CURRENT SHAPE (session 154, design s154 §5a) — the exact text the Data
// TA's filter_utils.py generates, built from parts here so tool transport
// cannot halve a backslash. bin/check-diagnostics.js pins these two constants
// against FILTER_REGEX_SKIP / FILTER_REGEX_GAP in the Data TA source, and the
// consistency test pins them against the design's golden strings:
//   SKIP          = (?:^|"_raw"\s*:\s*"(?:[^"\\]++|\\.)*+")
//   LA(key, frag) = (?=(?:(?!"_raw")[^\n])*?"key"\s*:\s*"frag")
//   chunk REGEX   = SKIP + "(?:" + entries joined by "|" + ")"
//   folder d/s -> LA(clz_dir,f(d)) LA(clz_subdir,f(s)); source p ->
//   LA(source,f(p)); combined d/s=p -> all three, in that order.
//   f(p) (§5b, linear '*'): split p on runs of '*' into S0 .. Sk;
//     k = 0  -> seg(S0)
//     k >= 1 -> seg(S0) + (?>[^"]*?seg(Si)) per MIDDLE segment + [^"]* + seg(Sk)
//   seg(S): '?' -> [^"], [A-Za-z0-9_] as is, any other allowed character
//   backslash-escaped. With at most one '*' this is the §5a text; a run
//   such as '**' gives one [^"]* where §5a wrote one per '*' (runs
//   included) — both forms are read here.
//   bin/check-diagnostics.js pins the TA_FILTER_FRAG_* constants below
//   against the literals filter_utils.py writes them with.
// ---------------------------------------------------------------------------

const BSL = String.fromCharCode(92);

/** The anchor every chunk REGEX starts with: the line start, or just past the
 *  `_raw` value (AWS envelopes carry `_raw` first). */
export const TA_FILTER_REGEX_SKIP =
    '(?:^|"_raw"' +
    BSL +
    's*:' +
    BSL +
    's*"(?:[^"' +
    BSL +
    BSL +
    ']++|' +
    BSL +
    BSL +
    '.)*+")';

/** The gap inside each lookahead: any characters on the line, never across a
 *  `"_raw"` key. */
export const TA_FILTER_REGEX_GAP = '(?:(?!"_raw")[^' + BSL + 'n])*?';

const LA_OPEN = '(?=' + TA_FILTER_REGEX_GAP + '"';
const KEY_SEP = '"' + BSL + 's*:' + BSL + 's*"';
const LA_CLOSE = '")';

/** The value fragments the generator writes (design s154 §5a / §5b):
 *  `[^"]*` for a `*` (§5b: only the `*` before the LAST segment), `[^"]` for
 *  a `?`, and `(?>[^"]*?` + seg + `)` for a `*` followed by a MIDDLE
 *  segment. bin/check-diagnostics.js pins all four against the literals in
 *  filter_utils.py. */
export const TA_FILTER_FRAG_STAR = '[^"]*';
export const TA_FILTER_FRAG_ONE = '[^"]';
export const TA_FILTER_FRAG_ATOM_OPEN = '(?>' + TA_FILTER_FRAG_STAR + '?';
export const TA_FILTER_FRAG_ATOM_CLOSE = ')';

const FRAG_STAR = TA_FILTER_FRAG_STAR;
const FRAG_ONE = TA_FILTER_FRAG_ONE;
const ATOM_OPEN = TA_FILTER_FRAG_ATOM_OPEN;
const ATOM_CLOSE = TA_FILTER_FRAG_ATOM_CLOSE;
const WORD_CHAR = /^[A-Za-z0-9_]$/;

type ShapeKind = 'folder' | 'source' | 'combined';

/** One fixed-length segment token at `i`: `[^"]` -> `?`, a backslash +
 *  printable non-word character -> that character, a word character as
 *  itself. Anything else -> null — including `[^"]*` (a wildcard, never part
 *  of a segment) and an escaped `*` or `?` (the generator writes those only
 *  as wildcards, so a literal one cannot be read back as a pattern). */
const readSegmentToken = (t: string, i: number): { out: string; next: number } | null => {
    if (t.slice(i, i + FRAG_STAR.length) === FRAG_STAR) return null;
    if (t.slice(i, i + FRAG_ONE.length) === FRAG_ONE) return { out: '?', next: i + FRAG_ONE.length };
    const ch = t.charAt(i);
    if (ch === BSL) {
        const c = t.charAt(i + 1);
        // the generator escapes only printable NON-word characters; a
        // backslash before a word character is a regex class (\s, \d ...)
        if (c === '' || WORD_CHAR.test(c) || c < ' ' || c > '~' || c === '*' || c === '?') return null;
        return { out: c, next: i + 2 };
    }
    if (ch !== '' && WORD_CHAR.test(ch)) return { out: ch, next: i + 1 };
    return null;
};

/** One atomic middle segment `(?>[^"]*?SEG)` at `i` (§5b): a NON-empty run of
 *  segment tokens, then the group's close. Anything else -> null. */
const readAtomicSegment = (t: string, i: number): { out: string; next: number } | null => {
    if (t.slice(i, i + ATOM_OPEN.length) !== ATOM_OPEN) return null;
    let j = i + ATOM_OPEN.length;
    let seg = '';
    for (;;) {
        if (t.slice(j, j + ATOM_CLOSE.length) === ATOM_CLOSE) {
            return seg === '' ? null : { out: '*' + seg, next: j + ATOM_CLOSE.length };
        }
        const tok = readSegmentToken(t, j);
        if (!tok) return null;
        seg += tok.out;
        j = tok.next;
    }
};

/**
 * One lookahead at `at`: its key and its value with the fragment inverted.
 * The value must be one the generator writes, in either version:
 *   §5a — any sequence of `[^"]*` (-> `*`) and segment tokens, no atomic
 *         group (one `[^"]*` per `*`, so a `**` reads back as `**`);
 *   §5b — seg(S0), one or more `(?>[^"]*?SEG)` (-> `*SEG`), then the single
 *         `[^"]*` and the last segment (the §5b text of k >= 2 star runs;
 *         k = 1 is the §5a text when the run is one `*`, and a single
 *         `[^"]*` for a longer run such as `**`, where §5a wrote one per `*`).
 * An atomic group therefore may only follow the first segment or another
 * atomic group, and must be followed by another one or by that `[^"]*`:
 * leftmost placement of a segment equals the glob only when a `*` comes
 * next, so `(?>[^"]*?a)b` (a literal after the group), an atomic group last
 * in the value or after a `[^"]*`, an empty or nested group or one holding
 * a `[^"]*` are all residue. Anything else -> null.
 */
const readLookahead = (
    t: string,
    at: number,
): { key: string; value: string; next: number } | null => {
    if (t.slice(at, at + LA_OPEN.length) !== LA_OPEN) return null;
    let i = at + LA_OPEN.length;
    const keyEnd = t.indexOf('"', i);
    if (keyEnd === -1) return null;
    const key = t.slice(i, keyEnd);
    if (key !== 'clz_dir' && key !== 'clz_subdir' && key !== 'source') return null;
    i = keyEnd;
    if (t.slice(i, i + KEY_SEP.length) !== KEY_SEP) return null;
    i += KEY_SEP.length;
    // first: in seg(S0); atoms: after >= 1 atomic group; last: after the
    // §5b [^"]* (the last segment); plain: after a [^"]* with no atomic
    // group (§5a, any further [^"]* allowed)
    let state: 'first' | 'atoms' | 'last' | 'plain' = 'first';
    let value = '';
    while (i < t.length) {
        if (t.slice(i, i + LA_CLOSE.length) === LA_CLOSE) {
            if (state === 'atoms') return null; // an atomic group last in the value
            return { key, value, next: i + LA_CLOSE.length };
        }
        if (t.slice(i, i + ATOM_OPEN.length) === ATOM_OPEN) {
            if (state !== 'first' && state !== 'atoms') return null;
            const atom = readAtomicSegment(t, i);
            if (!atom) return null;
            value += atom.out;
            i = atom.next;
            state = 'atoms';
            continue;
        }
        if (t.slice(i, i + FRAG_STAR.length) === FRAG_STAR) {
            if (state === 'last') return null; // §5b has one [^"]* after the groups
            value += '*';
            i += FRAG_STAR.length;
            state = state === 'atoms' ? 'last' : state === 'first' ? 'plain' : state;
            continue;
        }
        if (state === 'atoms') return null; // only a group or [^"]* may follow a group
        const tok = readSegmentToken(t, i);
        if (!tok) return null;
        value += tok.out;
        i = tok.next;
    }
    return null;
};

/**
 * Invert one current-shape chunk REGEX into its entries, in order. Every
 * entry must be a complete run of lookaheads in one of the three key orders
 * the generator writes, ending at a `|` or at the end of the group, and its
 * recovered values must pass the Data TA's grammar; anything else marks the
 * REGEX unrecoverable (the caller degrades parseStatus to 'partial') and the
 * scan resynchronizes at the next `|` + lookahead.
 */
const recoverShapeEntries = (
    regexText: string,
): { entries: Array<{ kind: ShapeKind; pattern: string }>; unrecoverable: boolean } => {
    const entries: Array<{ kind: ShapeKind; pattern: string }> = [];
    const t = regexText.trim();
    if (t.slice(0, TA_FILTER_REGEX_SKIP.length) !== TA_FILTER_REGEX_SKIP) {
        return { entries, unrecoverable: true };
    }
    const rest = t.slice(TA_FILTER_REGEX_SKIP.length);
    if (rest.slice(0, 3) !== '(?:' || rest.charAt(rest.length - 1) !== ')') {
        return { entries, unrecoverable: true };
    }
    const body = rest.slice(3, rest.length - 1);
    let unrecoverable = false;
    let i = 0;
    for (;;) {
        const keys: string[] = [];
        const vals: string[] = [];
        let la = readLookahead(body, i);
        while (la) {
            keys.push(la.key);
            vals.push(la.value);
            i = la.next;
            la = readLookahead(body, i);
        }
        const terminated = i === body.length || body.charAt(i) === '|';
        const sig = keys.join(',');
        let rec: { kind: ShapeKind; pattern: string } | null = null;
        if (terminated) {
            if (sig === 'clz_dir,clz_subdir' && SEGMENT_OK.test(vals[0]) && SEGMENT_OK.test(vals[1])) {
                rec = { kind: 'folder', pattern: vals[0] + '/' + vals[1] };
            } else if (sig === 'source' && srcpatOk(vals[0])) {
                rec = { kind: 'source', pattern: vals[0] };
            } else if (
                sig === 'clz_dir,clz_subdir,source' &&
                SEGMENT_OK.test(vals[0]) &&
                SEGMENT_OK.test(vals[1]) &&
                srcpatOk(vals[2])
            ) {
                rec = { kind: 'combined', pattern: vals[0] + '/' + vals[1] + '=' + vals[2] };
            }
        }
        if (rec) entries.push(rec);
        else unrecoverable = true;
        if (i === body.length) break;
        if (terminated) {
            i += 1; // past the '|'
            if (i === body.length) {
                unrecoverable = true; // an empty last alternative matches every event
                break;
            }
            continue;
        }
        const nxt = body.indexOf('|' + LA_OPEN, i);
        if (nxt === -1) break;
        i = nxt + 1;
    }
    return { entries, unrecoverable };
};

const pushUnique = (list: string[], v: string): void => {
    if (list.indexOf(v) === -1) list.push(v);
};

/** A folder list (include_allow / exclude) from one REGEX of EITHER shape. */
const recoverFolderList = (regexText: string): { list: string[]; unrecoverable: boolean } => {
    const t = regexText.trim();
    if (t.slice(0, TA_FILTER_REGEX_SKIP.length) === TA_FILTER_REGEX_SKIP) {
        const rec = recoverShapeEntries(t);
        const list: string[] = [];
        let unrecoverable = rec.unrecoverable;
        for (const e of rec.entries) {
            if (e.kind === 'folder') pushUnique(list, e.pattern);
            else unrecoverable = true; // a source entry in a folder stanza
        }
        return { list, unrecoverable: unrecoverable || list.length === 0 };
    }
    const old = clzPairsFromRegex(t);
    // the generator never writes a stanza without a pattern: nothing
    // recovered means a foreign REGEX, never an empty (= pass-all) list
    return { list: old.pairs, unrecoverable: old.unrecoverable || old.pairs.length === 0 };
};

/** A source list (include_sources / exclude_sources) — current shape only
 *  (older Data TA builds never wrote these stanzas). */
const recoverSourceList = (regexText: string): { list: string[]; unrecoverable: boolean } => {
    const rec = recoverShapeEntries(regexText);
    const list: string[] = [];
    let unrecoverable = rec.unrecoverable;
    for (const e of rec.entries) {
        if (e.kind === 'folder') unrecoverable = true; // a folder entry in a source stanza
        else pushUnique(list, e.pattern);
    }
    return { list, unrecoverable: unrecoverable || list.length === 0 };
};

/** The generated filter stanzas: two singles and four LIST stanzas, whose
 *  chunk n >= 2 is named `<name>_<n>`. */
const FILTER_SINGLE_STANZAS = ['logserv_filter_include_drop', 'logserv_filter_time_drop'];
const FILTER_LIST_STANZA_RE =
    /^(logserv_filter_(?:include_allow|include_sources|exclude_sources|exclude))(?:_([1-9][0-9]*))?$/;

/** Every `[logserv_filter_…]` header in the paste, in order (duplicates kept).
 *  Any header text up to the closing bracket counts (session 154 review): a
 *  chunk header of another shape (`[logserv_filter_exclude-2]`) must surface
 *  as an UNKNOWN stanza, never be skipped while the list reads as whole. */
const filterStanzaNames = (text: string): string[] => {
    const out: string[] = [];
    const re = /\[(logserv_filter_[^\]\r\n]*)\]/g;
    let m = re.exec(text);
    while (m) {
        out.push(m[1]);
        m = re.exec(text);
    }
    return out;
};

/** Is this a stanza name the current or the older generator writes? */
const knownFilterStanza = (name: string): boolean => {
    if (FILTER_SINGLE_STANZAS.indexOf(name) !== -1) return true;
    const m = FILTER_LIST_STANZA_RE.exec(name);
    return !!m && (m[2] === undefined || parseInt(m[2], 10) >= 2);
};

/**
 * The REGEX lines of one list stanza and its chunks, in chunk order. `broken`
 * when a chunk is missing (chunk 1 is the plain name; chunks must run 1..n
 * without a gap), duplicated, or carries no REGEX line — a paste cut in the
 * middle of a list can never read as the whole list.
 */
const listStanzaRegexes = (
    text: string,
    base: string,
    names: string[],
): { present: boolean; regexes: string[]; broken: boolean } => {
    const nums: number[] = [];
    for (const n of names) {
        const m = FILTER_LIST_STANZA_RE.exec(n);
        if (!m || m[1] !== base) continue;
        nums.push(m[2] === undefined ? 1 : parseInt(m[2], 10));
    }
    if (nums.length === 0) return { present: false, regexes: [], broken: false };
    const sorted = nums.slice().sort((a, b) => a - b);
    let broken = false;
    for (let k = 0; k < sorted.length; k += 1) {
        if (sorted[k] !== k + 1) broken = true; // gap, duplicate, or no chunk 1
    }
    const regexes: string[] = [];
    for (let k = 1; k <= sorted.length; k += 1) {
        if (sorted.indexOf(k) === -1) continue;
        const body = stanzaBody(text, k === 1 ? base : base + '_' + String(k));
        const rm = body === null ? null : /REGEX\s*=\s*([^\n\r]+)/.exec(body);
        if (rm) regexes.push(rm[1]);
        else broken = true;
    }
    return { present: true, regexes, broken };
};

/** Exact-name stanza lookup: `[name]` with its closing bracket, so
 *  `logserv_filter_exclude` never matches `[logserv_filter_exclude_sources]`
 *  or `[logserv_filter_exclude_2]`. */
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
    const notes: string[] = [];
    /* Session 154 — the generated block now has six stanza families and
     * chunked lists. Every `[logserv_filter_…]` header must be one the
     * generator writes; a header-looking text that yields no well-formed
     * name (e.g. a paste collapsed onto one line) cannot be read either. */
    const names = filterStanzaNames(text);
    const unknownNames = names.filter((n) => !knownFilterStanza(n));
    if (names.length === 0) anyUnrecoverable = true;
    if (unknownNames.length > 0) {
        anyUnrecoverable = true;
        notes.push(
            `Unrecognized filter stanza(s): ${unknownNames
                .slice(0, 5)
                // a header may now hold any text: show only its leading
                // identifier characters, an ellipsis for the rest
                .map((n) => {
                    const shown = (/^[A-Za-z0-9_.:-]*/.exec(n.slice(0, 64)) || [''])[0];
                    return '[' + shown + (shown.length < n.length ? '…' : '') + ']';
                })
                .join(', ')}.`,
        );
    }
    const timeBody = stanzaBody(text, 'logserv_filter_time_drop');
    if (timeBody !== null) {
        const rm = /REGEX\s*=\s*([^\n\r]+)/.exec(timeBody);
        if (rm) {
            r.cutoffEpoch = recoverCutoffFromRegex(rm[1], nowSec);
            if (r.cutoffEpoch === null) anyUnrecoverable = true;
        } else {
            anyUnrecoverable = true;
        }
    }
    const readList = (
        base: string,
        recover: (regexText: string) => { list: string[]; unrecoverable: boolean },
    ): { present: boolean; list: string[] } => {
        const st = listStanzaRegexes(text, base, names);
        if (st.broken) anyUnrecoverable = true;
        const list: string[] = [];
        for (const rx of st.regexes) {
            const rec = recover(rx);
            if (rec.unrecoverable) anyUnrecoverable = true;
            for (const p of rec.list) pushUnique(list, p);
        }
        return { present: st.present, list };
    };
    // The include gate: [logserv_filter_include_drop] (REGEX = .) and the
    // allow list are generated TOGETHER; no gate = pass-all.
    const hasDrop = names.indexOf('logserv_filter_include_drop') !== -1;
    const allow = readList('logserv_filter_include_allow', recoverFolderList);
    r.includeFilters = allow.list;
    if (hasDrop !== allow.present) {
        anyUnrecoverable = true; // half a gate: either reading would be a guess
    }
    const exc = readList('logserv_filter_exclude', recoverFolderList);
    r.excludeFilters = exc.list;
    const incSrc = readList('logserv_filter_include_sources', recoverSourceList);
    r.includeSources = incSrc.list;
    if (incSrc.present && !allow.present) {
        anyUnrecoverable = true; // include sources exist only behind an include gate
    }
    const excSrc = readList('logserv_filter_exclude_sources', recoverSourceList);
    r.excludeSources = excSrc.list;
    if (anyUnrecoverable) {
        notes.unshift(
            'Some generated filter expressions could not be faithfully reconstructed (hand-edited, cut off, or from a different version?) — the recovered fields are incomplete.',
        );
    }
    /* A paste that holds ONLY source-rule stanzas (no complete marker pair,
     * no folder or time stanza) proves filtering is enabled, but its absent
     * folder stanzas are not evidence of pass-all — they may simply not have
     * been copied (understand_critic "Missed places" 5). */
    const hasFilterEnd = text.indexOf(FILTER_MARKER_END) !== -1;
    const blockComplete = hasFilterStart && hasFilterEnd;
    const folderEvidence =
        blockComplete || hasDrop || allow.present || exc.present || timeBody !== null;
    if (!folderEvidence) {
        notes.push(
            'The paste carries only source-rule stanzas — the include/exclude folder filters and the time cutoff are not in it; paste the whole local/transforms.conf.',
        );
    }
    /* Session 154 review — the generator always writes BOTH marker lines,
     * so one without the other means the paste was cut. The stanzas written
     * last (the excludes, Exclude Sources, the last chunks) are what a
     * bottom cut loses, so such a paste must never read as whole. */
    const cutOff = hasFilterStart !== hasFilterEnd;
    if (cutOff) {
        notes.push(
            'The paste has only one of the two filter-block marker lines — it looks cut off; re-paste the whole local/transforms.conf.',
        );
    }
    r.parseStatus = anyUnrecoverable || !folderEvidence || cutOff ? 'partial' : 'parsed';
    if (notes.length > 0) {
        r.parseNote = (r.parseNote ? r.parseNote + ' ' : '') + notes.join(' ');
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
            include_sources: key('include_sources'),
            exclude_sources: key('exclude_sources'),
        },
        nowSec,
    );
};

/**
 * Parse a paste. Never throws; never returns null — unparseable input comes
 * back `{parseStatus: 'unparsed'}` and is still stored verbatim (scrubbed),
 * per §3.4. CRLF/CR are normalized before sniffing (§15.8a-19). The page
 * calls it through `prepareIngestPaste` (raw structure, scrubbed storage).
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

/** The context-free, high-signal secret shapes of `scrubPaste` (URL
 *  credentials, AWS access keys, sk- API keys, JWTs) — the only rules that
 *  still apply to a filter value that passes the Data TA's grammar. */
const scrubHighSignal = (v: string): string =>
    v
        .replace(/(https?:\/\/)([^/\s:@]+):([^/\s@]+)@/gi, `$1${REDACTED}@`)
        .replace(/\bAKIA[0-9A-Z]{16}\b/g, REDACTED)
        .replace(/\bsk-[A-Za-z0-9_-]{20,}\b/g, REDACTED)
        .replace(/\beyJ[A-Za-z0-9_-]{10,}(?:\.[A-Za-z0-9_-]+){1,2}\b/g, REDACTED);

/**
 * The page's save path (session 154 review): read the STRUCTURE from the raw
 * paste, store only SCRUBBED text. `scrubPaste` over-redacts by design
 * (§15.8a-21), and its flag and key=value rules fire inside legal filter
 * values — the escaped hyphen-u of `/var/log/unattended-upgrades/*` in a
 * generated REGEX, `sshkey=` in a `dir/subdir=srcpat` entry, `token:` in a
 * source pattern — which turned a legal configuration into a partial or
 * unparsed paste, or a redacted entry, and could flip a Data Doctor verdict.
 * So the paste is parsed raw (capped like the scrubber) and every parsed
 * string that is stored or displayed is scrubbed:
 *  - a list entry that passes the Data TA's grammar (a value the TA accepts:
 *    no whitespace, quotes or separators) is kept, with only the high-signal
 *    secret shapes above still redacted in it;
 *  - any other entry, the host string and the parse note go through the full
 *    scrubber (a scrubbed entry fails the grammar, so the read side clamps
 *    it as before).
 * `scrubbed` is what is stored (`scrubbedRaw`); the raw text never is.
 */
export const prepareIngestPaste = (
    raw: string,
    nowSec: number,
): { scrubbed: string; parsed: IngestParseResult } => {
    const scrubbed = scrubPaste(raw);
    const capped =
        raw.length > MAX_INGEST_PASTE_CHARS ? raw.slice(0, MAX_INGEST_PASTE_CHARS) : raw;
    const p = parseIngestPaste(capped, nowSec);
    const clean = (list: string[], itemOk: (e: string) => boolean): string[] =>
        list.map((e) => (itemOk(e) ? scrubHighSignal(e) : scrubPaste(e)));
    return {
        scrubbed,
        parsed: {
            ...p,
            parseNote: scrubPaste(p.parseNote),
            sourceHost: scrubPaste(p.sourceHost),
            includeFilters: clean(p.includeFilters, patternOk),
            excludeFilters: clean(p.excludeFilters, patternOk),
            includeSources: clean(p.includeSources, sourceEntryOk),
            excludeSources: clean(p.excludeSources, sourceEntryOk),
        },
    };
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
 * when this is set, and the boundary line keeps the ask. The source-rule
 * lists default to empty too (session 154), so a paste carrying one is not
 * the defaults shape.
 */
export const isDefaultsShape = (facts: IngestFacts): boolean =>
    (facts.inputShape === 'rest-json' ||
        facts.inputShape === 'rest-xml' ||
        facts.inputShape === 'settings-conf') &&
    facts.filterEnabled === false &&
    facts.daysInPast === 7 &&
    facts.excludeFilters.length === 0 &&
    facts.includeFilters.length === 1 &&
    facts.includeFilters[0] === '*/*' &&
    includeSourcesOf(facts).length === 0 &&
    excludeSourcesOf(facts).length === 0;

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

/** The ceiling for PER-TYPE (folder) verdicts — check 29: the supplied cap,
 *  and at most 'likely' while a source rule is in effect, because source
 *  rules may drop or keep some files of a folder (session 154). The time
 *  cutoff (check 28) is unaffected by source rules and keeps the plain cap. */
export const folderVerdictCap = (facts: IngestFacts, nowSec: number): SuppliedConfidence => {
    const cap = suppliedConfidenceCap(facts, nowSec);
    return hasSourceRules(facts) ? minConfidence(cap, 'likely') : cap;
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
        include_sources_json: JSON.stringify(includeSourcesOf(facts)),
        exclude_sources_json: JSON.stringify(excludeSourcesOf(facts)),
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

/** Session 154 — the Data TA's source-pattern grammar (design s154 §4):
 *  1..512 of [A-Za-z0-9/._:*?+@~-] with at least one character that is not
 *  `*`, `?` or `/` (a match-everything source pattern is refused at save). */
const SRCPAT_CHARS_OK = new RegExp('^[A-Za-z0-9/._:*?+@~-]+$');
const SRCPAT_HAS_LITERAL = new RegExp('[^*?/]');
const srcpatOk = (p: string): boolean =>
    p.length > 0 &&
    p.length <= INGEST_MAX_SOURCE_PATTERN_CHARS &&
    SRCPAT_CHARS_OK.test(p) &&
    SRCPAT_HAS_LITERAL.test(p);

/** One Include/Exclude Sources entry: `srcpat`, or `dir/subdir=srcpat` whose
 *  folder follows the folder-filter segment grammar (exactly one '/'). */
export const sourceEntryOk = (e: string): boolean => {
    if (e.length === 0 || e.length > INGEST_MAX_SOURCE_ENTRY_CHARS) return false;
    const { folder, src } = splitSourceEntry(e);
    if (folder === null) return srcpatOk(src);
    const i = folder.indexOf('/');
    if (i === -1) return false;
    return (
        SEGMENT_OK.test(folder.slice(0, i)) &&
        SEGMENT_OK.test(folder.slice(i + 1)) &&
        srcpatOk(src)
    );
};

/** §19.8a-7 (H17) — the read-side clamp is NOT silent: `clamped` is true
 *  whenever the returned list differs from what the row stored (entries
 *  dropped by the grammar clamp, the count cap, or an unreadable encoding),
 *  and `looksLikeIngestFacts` folds it into `filtersApproximate` so a
 *  clamped list can never carry an exact-shape confidence. Shared by the
 *  folder lists and (session 154) the source lists, each with its own
 *  grammar and count cap; an over-long stored string is not even parsed. */
const readPatternList = (
    v: unknown,
    itemOk: (p: string) => boolean = patternOk,
    maxItems: number = INGEST_MAX_PATTERNS,
): { list: string[]; clamped: boolean } => {
    if (typeof v !== 'string' || v.length === 0) return { list: [], clamped: false };
    if (v.length > INGEST_MAX_LIST_JSON_CHARS) return { list: [], clamped: true };
    try {
        const arr = JSON.parse(v);
        if (!Array.isArray(arr)) return { list: [], clamped: true };
        const list = arr
            .filter((p): p is string => typeof p === 'string')
            .filter(itemOk)
            .slice(0, maxItems);
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
    // Session 154 — the source lists: rows written before them carry
    // neither field (absent -> empty, not clamped); a non-string value is
    // unreadable (clamped -> approximate), never trusted.
    const srcList = (v: unknown): { list: string[]; clamped: boolean } =>
        v === undefined || v === null
            ? { list: [], clamped: false }
            : typeof v !== 'string'
              ? { list: [], clamped: true }
              : readPatternList(v, sourceEntryOk, INGEST_MAX_SOURCE_PATTERNS);
    const incSrc = srcList(r.include_sources_json);
    const excSrc = srcList(r.exclude_sources_json);
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
        includeSources: incSrc.list,
        excludeSources: excSrc.list,
        // §19.8a-7 — a read-side clamp makes the shape inexact.
        filtersApproximate:
            bool01(r.filters_approximate) === true ||
            inc.clamped ||
            exc.clamped ||
            incSrc.clamped ||
            excSrc.clamped,
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

/** Build 384 (F3 of the KV-ACL review): the supplier name is the one the browser sent with the paste - the
 *  collection is writable by every role - so every surface shows it as not verified. */
export const suppliedByText = (name: string): string => `${name || 'an unknown user'} (name not verified)`;

/** The provenance line every §15 surface carries — "recorded as", never an
 *  attestation (§15.8a-13). */
export const provenanceLine = (facts: IngestFacts): string => {
    const host = facts.sourceHost ? `, from host ${facts.sourceHost}` : '';
    return `Recorded as supplied by ${suppliedByText(facts.suppliedBy)}, ${fmtUtc(facts.suppliedAt)}${host}. Operator-supplied, not observed from this search head.`;
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
        const base = `The supplied configuration (recorded as supplied by ${suppliedByText(facts.suppliedBy)}) reports ingest filtering DISABLED.`;
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
    // Session 154 — the source lists, only when supplied (older rows and
    // pastes have none, and their wording stays as it was).
    const incSrc = includeSourcesOf(facts);
    const excSrc = excludeSourcesOf(facts);
    if (incSrc.length > 0) {
        parts.push(
            `include sources: ${patternListForDisplay(incSrc)}` +
                (isPassAllInclude(facts.includeFilters)
                    ? ' (no effect: every log type is already included)'
                    : ''),
        );
    }
    if (excSrc.length > 0) parts.push(`exclude sources: ${patternListForDisplay(excSrc)}`);
    if (hasSourceRules(facts)) {
        parts.push(`${SOURCE_RULES_NOTE}, so the per-type verdicts are approximate`);
    }
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
