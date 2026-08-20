/**
 * splProbe — classify a DISPATCHED SPL string (session 093, Phase 1 of the
 * Missing-Data Diagnostic / "LogServ Data Doctor").
 *
 * WHY A PARSER AND NOT A MANIFEST
 * -------------------------------
 * The diagnostic needs to know, for any panel that came back empty, what that
 * panel actually depends on: which read tier it used (KV-Store rollup vs
 * tstats vs a raw event scan), which collection + metric arm, which
 * sourcetypes, and whether the global cloud / host filters were spliced in.
 *
 * A hand-authored per-panel dependency manifest would be ~330 entries and
 * would drift the moment a dashboard is edited. It also *cannot* describe the
 * many panels whose SPL is built at runtime — `buildQueries(HOST)`,
 * `roleRead(metric, field)`, `trendChart(cat)`, `buildStmapRawQuery(...)`,
 * dynamic-span memos, and every `useHybridSearch` pair (which dispatches one
 * of two different shapes depending on the time range).
 *
 * So we classify **what actually ran**. The input is the exact string
 * `useSearch` handed to `SearchJob.create({ search })`, which means the probe
 * sees the fully-resolved query including every interpolated constant and
 * every filter splice. It cannot drift, by construction.
 *
 * GROUNDED, NOT GUESSED
 * ---------------------
 * The shapes below were inventoried across all 21 data dashboards (session
 * 093 discovery). The complete corpus of ~600 dispatchable strings uses only
 * FOUR leading forms:
 *
 *   | inputlookup <coll> [where metric="<m>"] | addinfo | where <t>_ts>=…   (rollup)
 *   | tstats <aggs> WHERE `sap_logserv_idx_macro` …                          (tstats)
 *   `sap_logserv_idx_macro` <predicates> | …                                 (raw)
 *   (anything else)                                                          (unknown)
 *
 * No `| makeresults`, `| rest`, `| savedsearch`, `| union`, `| datamodel`,
 * `| metadata`, `| eventcount`, `| from`, `| mstats` or `| loadjob` appears in
 * any dashboard panel.
 *
 * TRAPS THE DISCOVERY SURFACED (each is handled below — do not "simplify" them
 * away without re-reading the census):
 *
 *  1. `where metric=` is OPTIONAL. `logserv_stmap_rollup`,
 *     `logserv_beaconing_rollup`, `logserv_webdisp_slowtrace_rollup` and the
 *     three topology graph collections are read whole.
 *  2. TWO bucket fields: `bucket_ts` (hourly, 26 collections) and `day_ts`
 *     (daily, the two beaconing collections). `logserv_topology_inventory` is
 *     flat and has neither.
 *  3. `| search sourcetype="x"` AFTER an inputlookup filters a KV **grain
 *     dimension** that happens to be named `sourcetype` — it is NOT an index
 *     predicate. Same for `| search host=…` and `| search cloud_provider=…`.
 *     Sourcetype extraction therefore runs ONLY on the base clause of a raw
 *     search or the WHERE clause of a tstats.
 *  4. A single query can contain the index macro TWICE (a Top-N host
 *     subsearch embeds `[search `sap_logserv_idx_macro` | top limit=N host …]`)
 *     and can contain TWO `inputlookup`s (an AbapSecurity `join` subsearch).
 *  5. A query can contain two `| where` clauses — the bucket range filter plus
 *     a real predicate. Never assume the first `| where` bounds the query.
 *  6. Regex literals contain `|`, `[`, `]`, `{`, `}` and escaped quotes, so
 *     pipe-splitting MUST be quote- and bracket-aware.
 *  7. Empty filter splices leave double spaces; leading/trailing-space
 *     asymmetry is normal. Never anchor on exact whitespace.
 *  8. MultiCloudOverview chains a second macro:
 *     `` `sap_logserv_idx_macro` | `sap_logserv_cloud_provider_default_macro` | … ``
 *
 * DEGRADE, NEVER GUESS. Anything the probe cannot account for lands in
 * `tier: 'unknown'` and/or `notes[]`, and the caller runs only tier-agnostic
 * checks. This module must never become a second source of truth about panel
 * dependencies — it only reports what it can literally see in the string.
 */

/** Which read tier the dispatched query used. */
export type SplTier = 'cached' | 'tstats' | 'raw' | 'unknown';

/** Time grain of the KV-Store rollup range filter, when there is one. */
export type BucketGrain = 'hourly' | 'daily' | 'none';

/** Static predicate defects mined from this product's own shipped-and-fixed
 *  bugs. See `SPL_LINT_RULES` below for the provenance of each. */
export type SplLintCode = 'match-in-base' | 'bare-boolean-in-where' | 'numeric-vs-string-boolean';

export interface SplLintFinding {
    code: SplLintCode;
    /** The offending pipeline segment, trimmed for display. */
    fragment: string;
    /** One sentence a technical reader can act on. */
    explanation: string;
}

export interface HostFilter {
    /** How the host constraint was expressed. */
    form: 'eq' | 'in' | 'or' | 'topn';
    /** Literal host values, when the form carries them (empty for 'topn'). */
    hosts: string[];
    /** The N of a Top-N subsearch, when form === 'topn'. */
    topN?: number;
}

export interface CloudFilter {
    /** 'rollup' = the `| search cloud_provider="x"` pipe spliced after the
     *  range filter; 'raw' = the term spliced after the index macro. */
    form: 'rollup' | 'raw';
    provider: string;
}

/**
 * A top-level field predicate extracted from a raw panel's base clause (or a
 * pre-transform `| search`/`| where`), for checks 22 (field existence/value)
 * and 25 (predicate bisect). §17.3 / §17.8a-8,10.
 *
 * Only TOP-LEVEL CONJUNCTS are captured — a base search that is a single
 * disjunction, or a group mixing fields/barewords, is skipped (noted), because
 * treating a disjunct as a required conjunct would blame a clause the panel
 * never required. Computed names (assigned by eval/rex/rename/spath/extract
 * before the filter) are excluded — they cannot exist on raw events.
 */
export interface FieldFilter {
    field: string;
    op: 'eq' | 'in' | 'neq' | 'range';
    /** Literal values for eq/in; empty for neq/range (existence-only). */
    values: string[];
    origin: 'base' | 'search' | 'where';
    /** The exact source substring, so check 25 can remove it by substring. */
    fragment: string;
    /** eq/in only: true when ANY value carries a `*` wildcard → the membership
     *  test degrades to existence-only (§17.8a-9). */
    wildcard: boolean;
}

export interface SplProbe {
    tier: SplTier;
    /** KV-Store collection read (rollup tier). First one, if a subsearch
     *  reads a second — see `collections` for the full set. */
    collection?: string;
    /** Every `logserv_*` collection this query reads (usually one). */
    collections: string[];
    /** The `metric="…"` arm, when the read carries one. Several collections
     *  are deliberately read whole and have no metric discriminator. */
    metric?: string;
    /** Bucket field used by the range filter. */
    grain: BucketGrain;
    /** True when an `info_min_time`/`info_max_time` range filter was found.
     *  A rollup read WITHOUT one ignores the time picker entirely. */
    hasRangeFilter: boolean;
    /** Sourcetypes constrained in the BASE clause (raw) or the tstats WHERE.
     *  Never populated from a post-`inputlookup` `| search` (trap 3). */
    sourcetypes: string[];
    /** `tag=…` base constraints (DnsAnalytics scopes by `tag=dns`, never by
     *  sourcetype). */
    tags: string[];
    /** Non-rollup lookups (`| lookup <name>` / `| inputlookup <name>.csv`). */
    lookups: string[];
    /** Every backtick macro referenced, in order of first appearance. */
    macros: string[];
    /** The global cloud-provider filter, if it was spliced into this query. */
    cloudFilter?: CloudFilter;
    /** A host constraint found in the base/WHERE scope or a rollup `| search`. */
    hostFilter?: HostFilter;
    /** Filters applied to rollup GRAIN dimensions (post-inputlookup
     *  `| search <dim>=…`), excluding the cloud and host splices. */
    grainFilters: string[];
    /** §17.3/§17.8a-8 — top-level field predicates for checks 22 & 25. Populated
     *  for raw-tier panels only. Empty when the base is a single disjunction
     *  (see `baseDisjunction`). */
    fieldFilters: FieldFilter[];
    /** True when the base clause is a single top-level disjunction (an `OR`
     *  spans the whole clause) — checks 22/25 must skip it, and `fieldFilters`
     *  is empty. */
    baseDisjunction: boolean;
    /** Smallest `| head N` cap in the pipeline, if any. */
    headLimit?: number;
    /** True when the query embeds a `[ … ]` subsearch. */
    hasSubsearch: boolean;
    /** True when the query uses the empty-safe scalar-KPI idiom
     *  (`| stats count as n, sum(count) as count | fillnull value=0 count`).
     *  Its ABSENCE on a rollup-backed KPI is why such a card can show an
     *  em-dash instead of a zero when the collection is empty. */
    emptySafeKpi: boolean;
    /** Static predicate defects (see SplLintCode). */
    lint: SplLintFinding[];
    /** Anything the probe noticed but could not classify. Surfaced to the
     *  report so a human can see what the parser was unsure about. */
    notes: string[];
}

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

/**
 * Split an SPL string on TOP-LEVEL pipes only.
 *
 * Quote-aware (double, single and backtick) and bracket-aware, because SPL in
 * this app routinely contains all of:
 *   rex field=_raw "(?<fw_action>IN_DROP|IN_ACCEPT)"      ← pipe inside a regex
 *   [search `sap_logserv_idx_macro` | top limit=10 host]   ← pipe inside a subsearch
 *   rex field=_raw "^\"(?<hana_op>[^\"]+)\""               ← escaped quotes
 *   eval "Queries per Domain"=round(Queries/'Unique Domains', 1)
 *
 * Returns raw (untrimmed) segments including a leading empty one for a
 * pipe-leading query, so callers can distinguish "starts with |" from not.
 */
export const splitTopLevelPipes = (spl: string): string[] => {
    const out: string[] = [];
    let buf = '';
    let inDouble = false;
    let inSingle = false;
    let inBacktick = false;
    let depth = 0;

    for (let i = 0; i < spl.length; i += 1) {
        const c = spl[i];

        if (inDouble) {
            buf += c;
            if (c === '\\' && i + 1 < spl.length) {
                // Consume the escaped character so an escaped quote (\") does
                // not close the string.
                i += 1;
                buf += spl[i];
            } else if (c === '"') {
                inDouble = false;
            }
            continue;
        }
        if (inSingle) {
            buf += c;
            if (c === "'") inSingle = false;
            continue;
        }
        if (inBacktick) {
            buf += c;
            if (c === '`') inBacktick = false;
            continue;
        }

        if (c === '"') { inDouble = true; buf += c; continue; }
        if (c === "'") { inSingle = true; buf += c; continue; }
        if (c === '`') { inBacktick = true; buf += c; continue; }
        if (c === '[') { depth += 1; buf += c; continue; }
        if (c === ']') { depth = Math.max(0, depth - 1); buf += c; continue; }
        if (c === '|' && depth === 0) { out.push(buf); buf = ''; continue; }

        buf += c;
    }
    out.push(buf);
    return out;
};

/** Remove top-level `[ … ]` subsearches from a predicate scope so a host
 *  Top-N subsearch's own contents are not mistaken for outer predicates. */
const stripSubsearches = (s: string): string => {
    let out = '';
    let depth = 0;
    let inDouble = false;
    for (let i = 0; i < s.length; i += 1) {
        const c = s[i];
        if (inDouble) {
            if (depth === 0) out += c;
            if (c === '\\' && i + 1 < s.length) { i += 1; if (depth === 0) out += s[i]; continue; }
            if (c === '"') inDouble = false;
            continue;
        }
        if (c === '"') { inDouble = true; if (depth === 0) out += c; continue; }
        if (c === '[') { depth += 1; continue; }
        if (c === ']') { depth = Math.max(0, depth - 1); continue; }
        if (depth === 0) out += c;
    }
    return out;
};

/** First word of a pipeline segment, lowercased ('' for an empty segment). */
const commandOf = (segment: string): string => {
    const t = segment.trim();
    if (!t) return '';
    const m = t.match(/^([A-Za-z_][A-Za-z0-9_]*)/);
    return m ? m[1].toLowerCase() : '';
};

const trimFragment = (s: string, max = 140): string => {
    const t = s.trim().replace(/\s+/g, ' ');
    return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

// ---------------------------------------------------------------------------
// Field / predicate extraction
// ---------------------------------------------------------------------------

const MACRO_RE = /`([A-Za-z0-9_]+)(?:\([^`]*\))?`/g;
const IDX_MACRO = 'sap_logserv_idx_macro';

/** `bucket_ts>=info_min_time` — also tolerates the AI-prompt saved searches'
 *  `day_ts>=relative_time(info_min_time,"@d")` snapping form. */
const RANGE_HOURLY_RE = /\bbucket_ts\s*>=\s*(?:relative_time\s*\(\s*)?info_min_time/;
const RANGE_DAILY_RE = /\bday_ts\s*>=\s*(?:relative_time\s*\(\s*)?info_min_time/;

/**
 * `| inputlookup [<options>] <collection> [where <expr>]`
 *
 * Collection names are always bare (never quoted) in this app. Option flags
 * (`append=`, `start=`, `max=`, `strict=`, `override_if_empty=`) are tolerated
 * even though no dashboard read currently uses one on the read side.
 */
const INPUTLOOKUP_RE =
    /^inputlookup\s+(?:(?:append|start|max|strict|override_if_empty)\s*=\s*\S+\s+)*([A-Za-z_][A-Za-z0-9_.-]*)\s*(?:\bwhere\b\s+([\s\S]*))?$/i;

const METRIC_RE = /\bmetric\s*=\s*"([^"]*)"/;

/** Collect every sourcetype constrained in a predicate scope.
 *
 *  Matches `sourcetype="x"`, `sourcetype=x` (unquoted, colons bare — both
 *  spellings ship), and `sourcetype IN ("a","b")`. Deliberately does NOT match
 *  `dc(sourcetype)`, `BY sourcetype`, or `values(sourcetype)` — those are
 *  aggregations/group-bys, not constraints. */
const collectSourcetypes = (scope: string): string[] => {
    const found: string[] = [];

    const inRe = /\bsourcetype\s+IN\s*\(([^)]*)\)/gi;
    let m = inRe.exec(scope);
    while (m) {
        const inner = m[1];
        const qRe = /"([^"]+)"|'([^']+)'/g;
        let q = qRe.exec(inner);
        while (q) {
            found.push(q[1] ?? q[2]);
            q = qRe.exec(inner);
        }
        m = inRe.exec(scope);
    }

    // Equality. `!=` is a NEGATIVE constraint and must not be collected as a
    // requirement, so the lookbehind-free guard checks the preceding char.
    const eqRe = /(^|[\s(])sourcetype\s*(!?=)\s*(?:"([^"]*)"|'([^']*)'|([A-Za-z0-9_:*.-]+))/g;
    let e = eqRe.exec(scope);
    while (e) {
        if (e[2] === '=') {
            const v = e[3] ?? e[4] ?? e[5];
            if (v) found.push(v);
        }
        e = eqRe.exec(scope);
    }

    return Array.from(new Set(found));
};

const collectTags = (scope: string): string[] => {
    const out: string[] = [];
    const re = /(^|[\s(])tag\s*=\s*(?:"([^"]*)"|([A-Za-z0-9_:*.-]+))/g;
    let m = re.exec(scope);
    while (m) {
        const v = m[2] ?? m[3];
        if (v) out.push(v);
        m = re.exec(scope);
    }
    return Array.from(new Set(out));
};

/**
 * Detect the global cloud-provider filter.
 *
 * Both splice forms are exact string transforms performed by
 * `withCloudProvider` (state/CloudProviderProvider.tsx), so we look for
 * exactly what it emits:
 *   rollup : ` | search cloud_provider="<p>"`   (after the range filter)
 *   raw    : ` (cloud_provider="aws" OR NOT cloud_provider=*)`  — aws only
 *            ` cloud_provider="<p>"`                            — azure / gcp
 */
const detectCloudFilter = (segments: string[], predicateScope: string): CloudFilter | undefined => {
    for (const seg of segments) {
        const t = seg.trim();
        const m = t.match(/^search\s+cloud_provider\s*=\s*"([^"]+)"$/i);
        if (m) return { form: 'rollup', provider: m[1] };
    }
    if (/\(\s*cloud_provider\s*=\s*"aws"\s+OR\s+NOT\s+cloud_provider\s*=\s*\*\s*\)/i.test(predicateScope)) {
        return { form: 'raw', provider: 'aws' };
    }
    const raw = predicateScope.match(/(^|[\s(])cloud_provider\s*=\s*"([^"]+)"/);
    if (raw) return { form: 'raw', provider: raw[2] };
    return undefined;
};

/**
 * Detect a host constraint.
 *
 * Three dialects ship, all from HostDetails / DataPipelineOverview:
 *   search  : `host="a"` · `host IN ("a","b")` · a Top-N subsearch
 *   tstats  : `host="a"` · `(host="a" OR host="b")`   (OR-expanded, never IN)
 *   rollup  : the tstats dialect spliced as `| search <fragment>`
 */
const detectHostFilter = (scope: string, withSubsearches: string): HostFilter | undefined => {
    const topn = withSubsearches.match(/\[\s*search\b[\s\S]*?\btop\s+limit\s*=\s*(\d+)\s+host\b[\s\S]*?\]/i);
    if (topn) return { form: 'topn', hosts: [], topN: parseInt(topn[1], 10) };

    const inList = scope.match(/\bhost\s+IN\s*\(([^)]*)\)/i);
    if (inList) {
        const hosts: string[] = [];
        const qRe = /"((?:[^"\\]|\\.)*)"/g;
        let q = qRe.exec(inList[1]);
        while (q) { hosts.push(q[1].replace(/\\"/g, '"')); q = qRe.exec(inList[1]); }
        return { form: 'in', hosts };
    }

    // OR-expanded group: (host="a" OR host="b")
    const orGroup = scope.match(/\(\s*host\s*=\s*"(?:[^"\\]|\\.)*"(?:\s+OR\s+host\s*=\s*"(?:[^"\\]|\\.)*")+\s*\)/i);
    if (orGroup) {
        const hosts: string[] = [];
        const qRe = /host\s*=\s*"((?:[^"\\]|\\.)*)"/g;
        let q = qRe.exec(orGroup[0]);
        while (q) { hosts.push(q[1].replace(/\\"/g, '"')); q = qRe.exec(orGroup[0]); }
        return { form: 'or', hosts };
    }

    const single = scope.match(/(^|[\s(])host\s*=\s*"((?:[^"\\]|\\.)*)"/);
    if (single) return { form: 'eq', hosts: [single[2].replace(/\\"/g, '"')] };

    return undefined;
};

// ---------------------------------------------------------------------------
// Lint rules
// ---------------------------------------------------------------------------

/**
 * Fields whose props.conf `EVAL-` emits the STRING "true"/"false".
 *
 * Comparing one of these against the NUMBER 1 is silently always-false — the
 * defect class that shipped twice in this product and was fixed in sessions
 * 050 (`is_error`, Cloud Connector) and 051→053 (`icm_is_error`, ABAP Network
 * + the Environment Health severity rollup + an AI prompt). The symptom is a
 * panel or KPI pinned at exactly 0 with no error.
 *
 * ENUMERATED FROM SOURCE, not from memory (session 093): these are exactly the
 * 16 distinct `EVAL-<field>` directives in the UI App's `default/props.conf`
 * whose expression yields a quoted "true"/"false". props.conf contains NO
 * numeric 0/1 flag EVAL, which is what makes the rule unambiguous — a numeric
 * comparison against one of these is always wrong.
 *
 * Deliberately ABSENT (both were in an earlier hand-written draft and both
 * would have produced false positives): `is_after_hours` and `is_privileged`
 * are NOT props fields — they are computed in-query as numeric 0/1 (see the
 * shadowing guard below).
 *
 * Keep in lockstep with `default/props.conf`.
 */
export const EVAL_STRING_BOOLEAN_FIELDS: readonly string[] = [
    'icm_is_error',
    'is_admin_user',
    'is_auth_event',
    'is_authenticated',
    'is_business_hours',
    'is_connection_event',
    'is_critical',
    'is_error',
    'is_internal_ip',
    'is_localhost',
    'is_service_account',
    'is_ssl_event',
    'is_successful',
    'is_system_user',
    'is_upgrade_check',
    'is_weekend',
];

/**
 * Rule (a) — `match()` in a base-search clause.
 *
 * `match()` is an EVAL function. It is valid in `eval`, `where` and
 * `fieldformat`; in a base search clause (or the `search` command, which has
 * base-search semantics) it does not evaluate and the clause silently matches
 * nothing. Cost us a whole compliance KPI in session 051 (`kpiPassword`
 * reading 0 while the sibling pie showed 21) and a dashboard build in 011.
 */
const lintMatchInBase = (baseClause: string, segments: string[]): SplLintFinding[] => {
    const out: SplLintFinding[] = [];
    const push = (fragment: string, explanation: string): void => {
        out.push({ code: 'match-in-base', fragment: trimFragment(fragment), explanation });
    };
    // Guard against `x.match(` (JavaScript) and identifiers that merely END in
    // "match" (`searchmatch(`, `cidrmatch(`, `regexmatch(`) — only a bare
    // `match(` token is the eval function.
    //
    // Written as a leading alternation rather than the more natural lookbehind
    // `(?<![.\w])`: this package compiles with `lib: ["es2017"]` and no
    // `target`, so TypeScript rejects lookbehind as an ES2018-only feature
    // (same constraint that forces numbered capture groups elsewhere in the
    // app — session-085 sticky #4).
    const MATCH_CALL = /(?:^|[^.\w])match\s*\(/i;

    if (MATCH_CALL.test(stripSubsearches(baseClause))) {
        push(
            baseClause,
            'match() is an eval-only function. In a base search clause it does not evaluate and the clause silently matches nothing — move it after a `| where`.',
        );
    }

    for (const seg of segments) {
        const t = seg.trim();
        // The `search` command is the ONLY command whose arguments use
        // base-search syntax, so an eval function is equally dead there.
        if (commandOf(t) === 'search' && MATCH_CALL.test(stripSubsearches(t))) {
            push(
                t,
                'The `search` command has base-search semantics and does not evaluate match(). Use `| where match(...)` instead.',
            );
        }
        // A subsearch opens a NEW pipeline whose first segment is again a base
        // clause. `| union [search <base clause with match()> ]` is the shape
        // used by every rollup aggregate in this app, so skipping bracket
        // contents entirely (as an earlier draft did) would make this rule
        // permanently blind to the most common place the defect can hide.
        const subRe = /\[([^[\]]*)\]/g;
        let sm = subRe.exec(t);
        while (sm) {
            const inner = sm[1];
            const innerSegs = splitTopLevelPipes(inner);
            const innerHead = (innerSegs.find((s) => s.trim().length > 0) ?? '').trim();
            const innerBase = /^search\b/i.test(innerHead)
                ? innerHead.replace(/^search\s*/i, '')
                : innerHead;
            if (innerBase && MATCH_CALL.test(innerBase)) {
                push(
                    innerBase,
                    'match() sits in the base clause of a subsearch, where eval functions do not evaluate — the subsearch silently returns nothing.',
                );
            }
            sm = subRe.exec(t);
        }
    }
    return out;
};

/**
 * Rule (b) — a bare unquoted `true`/`false` in a `| where`.
 *
 * In `where`, a bare `false` is a FIELD REFERENCE, not a boolean literal, so
 * `where is_business_hours=false` compares two fields and matches nothing. The
 * identical text in a BASE search IS a literal string match and works — which
 * is exactly why this defect survived: `is_admin_user=true` worked in the base
 * clause of the same query in which `is_business_hours=false` silently did
 * not (session 091; it made every "after hours" filter in the product a no-op).
 */
const lintBareBooleanInWhere = (segments: string[]): SplLintFinding[] => {
    const out: SplLintFinding[] = [];
    for (const seg of segments) {
        const t = seg.trim();
        if (commandOf(t) !== 'where') continue;
        // Strip quoted strings first so `x="false"` (correct) cannot match.
        const bare = t.replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/'(?:[^'\\]|\\.)*'/g, "''");
        const m = bare.match(/([A-Za-z_][A-Za-z0-9_.]*)\s*(?:!=|==|=)\s*(true|false)\b/i);
        if (m) {
            out.push({
                code: 'bare-boolean-in-where',
                fragment: trimFragment(t),
                explanation:
                    `In a \`where\` clause a bare ${m[2]} is a FIELD reference, not a boolean — "${m[1]}" is compared against a non-existent field and the clause matches nothing. Quote it ("${m[2]}") or use the value the field actually holds.`,
            });
        }
    }
    return out;
};

/**
 * Is `field` redefined NUMERICALLY by this query before it is compared?
 *
 * The one false positive that actually occurs in shipped SPL: HanaAudit's
 * `afterHoursAdmin` panel does
 *
 *   … | eval is_weekend=if(strftime(_time,"%w") IN ("0","6"), 1, 0)
 *     | eval is_after_hours=if(…, 1, 0)
 *     | where is_after_hours=1 OR is_weekend=1
 *
 * `is_weekend` IS a props string-boolean, but the in-query `eval` shadows it
 * with a numeric 0/1, so `is_weekend=1` is correct there. Without this guard
 * the rule fires twice on a perfectly good panel — and a lint that cries wolf
 * on shipped code is worse than no lint (Risk 8 in the design doc).
 */
const isNumericallyShadowed = (spl: string, field: string): boolean => {
    const re = new RegExp(
        `\\beval\\s+${field}\\s*=\\s*(?:if|case)\\s*\\([\\s\\S]*?[,(]\\s*[01]\\s*[,)]`,
        'i',
    );
    return re.test(spl);
};

/**
 * Rule (c) — `<field>=1` against a field whose EVAL emits a string boolean.
 * Always false; the panel reads a permanent zero with no error.
 */
const lintNumericVsStringBoolean = (spl: string): SplLintFinding[] => {
    const out: SplLintFinding[] = [];
    for (const field of EVAL_STRING_BOOLEAN_FIELDS) {
        // Any numeric comparison is wrong, not just `=1`.
        const re = new RegExp(`(^|[\\s(,])${field}\\s*(?:=|==|!=|>=|<=|>|<)\\s*[0-9]+(?![0-9."])`, 'i');
        const m = spl.match(re);
        if (!m) continue;
        if (isNumericallyShadowed(spl, field)) continue;
        out.push({
            code: 'numeric-vs-string-boolean',
            fragment: trimFragment(m[0]),
            explanation:
                `"${field}" is a search-time EVAL that emits the STRING "true"/"false", so comparing it to a number is never true and this clause silently matches nothing. Use ${field}="true".`,
        });
    }
    return out;
};

// ---------------------------------------------------------------------------
// Field-filter extraction (checks 22 & 25) — §17.3 / §17.8a-8,10
// ---------------------------------------------------------------------------

/** Fields owned by other checks — never a check-22/25 field filter. */
const FIELD_FILTER_EXCLUDED = new Set([
    'sourcetype',
    'index',
    'host',
    'source',
    'tag',
    'cloud_provider',
    '_time',
    'earliest',
    'latest',
    'earliest_time',
    'latest_time',
]);

const MAX_FIELD_FILTERS = 8;

/**
 * Split a base-search clause into TOP-LEVEL terms, quote- and paren-aware.
 * A term is a quoted string, a `(...)` group (atomic), or a run of
 * non-whitespace. Returns the terms in order; the caller inspects them for
 * top-level `OR`/`AND` connective keywords.
 */
const splitTopLevelTerms = (clause: string): string[] => {
    const terms: string[] = [];
    let buf = '';
    let depth = 0;
    let inD = false;
    let inS = false;
    let esc = false;
    const flush = (): void => {
        if (buf.trim()) terms.push(buf.trim());
        buf = '';
    };
    for (let i = 0; i < clause.length; i += 1) {
        const c = clause[i];
        if (esc) {
            buf += c;
            esc = false;
            continue;
        }
        if (c === '\\') {
            buf += c;
            esc = true;
            continue;
        }
        if (inD) {
            buf += c;
            if (c === '"') inD = false;
            continue;
        }
        if (inS) {
            buf += c;
            if (c === "'") inS = false;
            continue;
        }
        if (c === '"') {
            inD = true;
            buf += c;
            continue;
        }
        if (c === "'") {
            inS = true;
            buf += c;
            continue;
        }
        if (c === '(') {
            depth += 1;
            buf += c;
            continue;
        }
        if (c === ')') {
            depth = Math.max(0, depth - 1);
            buf += c;
            continue;
        }
        if (depth === 0 && /\s/.test(c)) {
            flush();
            continue;
        }
        buf += c;
    }
    flush();
    return terms;
};

/** Parse the inner of an `IN (...)` list or a group's disjuncts to quoted
 *  values. Returns the value list; `wildcard` is true if any carries `*`. */
const parseQuotedList = (inner: string): { values: string[]; wildcard: boolean } => {
    const values: string[] = [];
    const re = /"([^"]*)"|'([^']*)'/g;
    let m = re.exec(inner);
    while (m) {
        values.push(m[1] ?? m[2] ?? '');
        m = re.exec(inner);
    }
    return { values, wildcard: values.some((v) => v.includes('*')) };
};

/** A single `field op value` / `field IN (...)` term → FieldFilter, or null. */
const termToFilter = (
    term: string,
    origin: FieldFilter['origin'],
    computed: Set<string>,
): FieldFilter | null => {
    // field IN ("a","b")
    const inM = term.match(/^([A-Za-z_][A-Za-z0-9_.]*)\s+IN\s*\(([\s\S]*)\)$/i);
    if (inM) {
        const field = inM[1];
        if (FIELD_FILTER_EXCLUDED.has(field.toLowerCase()) || computed.has(field)) return null;
        const { values, wildcard } = parseQuotedList(inM[2]);
        if (values.length === 0) return null;
        return { field, op: 'in', values, origin, fragment: term, wildcard };
    }
    // field=value / field="value" / field!=value / field>=value …
    const eqM = term.match(
        /^([A-Za-z_][A-Za-z0-9_.]*)\s*(!?=|<=|>=|<|>)\s*(?:"([^"]*)"|'([^']*)'|(\S+))$/,
    );
    if (eqM) {
        const field = eqM[1];
        if (FIELD_FILTER_EXCLUDED.has(field.toLowerCase()) || computed.has(field)) return null;
        const opTok = eqM[2];
        const value = eqM[3] ?? eqM[4] ?? eqM[5] ?? '';
        if (opTok === '=') {
            return {
                field,
                op: 'eq',
                values: [value],
                origin,
                fragment: term,
                wildcard: value.includes('*'),
            };
        }
        if (opTok === '!=') {
            return { field, op: 'neq', values: [], origin, fragment: term, wildcard: false };
        }
        // <, >, <=, >= — existence-only (range)
        return { field, op: 'range', values: [], origin, fragment: term, wildcard: false };
    }
    return null;
};

/**
 * Extract the top-level conjunct field filters of a clause. A single
 * parenthesised group whose disjuncts are all `field=value` on the SAME field
 * collapses to one `in` filter; any mixed-field or bare-term group is skipped.
 * If a top-level `OR` spans the clause, returns `{ disjunction: true }` and no
 * filters (§17.8a-8).
 */
const filtersFromClause = (
    clause: string,
    origin: FieldFilter['origin'],
    computed: Set<string>,
    depth = 0,
): { filters: FieldFilter[]; disjunction: boolean } => {
    let terms = splitTopLevelTerms(clause);
    // A clause that is one fully-parenthesised group (`((a) OR (b))`) hides its
    // top-level OR one level down — unwrap once and recurse so the disjunction
    // is seen (bounded to avoid pathological nesting).
    if (depth < 4 && terms.length === 1 && terms[0].startsWith('(') && terms[0].endsWith(')')) {
        return filtersFromClause(terms[0].slice(1, -1), origin, computed, depth + 1);
    }
    // Recombine `field IN (...)` — the tokenizer splits it into three terms.
    const recombined: string[] = [];
    for (let i = 0; i < terms.length; i += 1) {
        if (
            i + 2 < terms.length &&
            /^[A-Za-z_][A-Za-z0-9_.]*$/.test(terms[i]) &&
            /^IN$/i.test(terms[i + 1]) &&
            terms[i + 2].startsWith('(')
        ) {
            recombined.push(`${terms[i]} IN ${terms[i + 2]}`);
            i += 2;
        } else {
            recombined.push(terms[i]);
        }
    }
    terms = recombined;
    if (terms.some((t) => /^OR$/i.test(t))) return { filters: [], disjunction: true };
    const filters: FieldFilter[] = [];
    for (const term of terms) {
        if (/^(AND|NOT)$/i.test(term)) continue;
        if (term.startsWith('(') && term.endsWith(')')) {
            // A group: keep it only if every disjunct is `field=value` on ONE field.
            const inner = term.slice(1, -1);
            const parts = splitTopLevelTerms(inner).filter((p) => !/^OR$/i.test(p));
            const subs = parts.map((p) => termToFilter(p, origin, computed));
            if (subs.length > 0 && subs.every((s) => s && s.op === 'eq')) {
                const field = subs[0]!.field;
                if (subs.every((s) => s!.field === field)) {
                    const values = subs.map((s) => s!.values[0]);
                    filters.push({
                        field,
                        op: 'in',
                        values,
                        origin,
                        fragment: term,
                        wildcard: values.some((v) => v.includes('*')),
                    });
                }
            }
            // else: mixed / bare-term group — skipped (not a single required filter)
            continue;
        }
        const f = termToFilter(term, origin, computed);
        if (f) filters.push(f);
    }
    return { filters, disjunction: false };
};

/** Names assigned by streaming commands before the first transforming command —
 *  they cannot exist on raw events, so filters on them are excluded (§17.8a-10). */
const TRANSFORMING = /^(stats|chart|timechart|top|rare|tstats|transaction|eventstats|streamstats)$/i;
const collectComputedNames = (segments: string[]): Set<string> => {
    const names = new Set<string>();
    const ASSIGN = [
        /\beval\s+([A-Za-z_][A-Za-z0-9_.]*)\s*=/gi,
        /\brename\s+[\s\S]*?\bas\s+"?([A-Za-z_][A-Za-z0-9_.]*)"?/gi,
        /\(\?<([A-Za-z_][A-Za-z0-9_.]*)>/g, // rex named capture
    ];
    for (const seg of segments) {
        const t = seg.trim();
        if (!t) continue;
        if (TRANSFORMING.test(commandOf(t))) break; // pre-transform region only
        for (const re of ASSIGN) {
            re.lastIndex = 0;
            let m = re.exec(t);
            while (m) {
                names.add(m[1]);
                m = re.exec(t);
            }
        }
    }
    return names;
};

/* ---------------------------------------------------------------------------
 * Column-origin resolution (§18.8a-12, review findings P-1/H-F5/H-F10).
 *
 * A blank DISPLAY column can only be corroborated against raw events through
 * its ORIGIN in the dispatched SPL: a `| rename src as "Display"` target must
 * be probed as `src`; a name assigned anywhere in the pipeline by eval / a
 * transforming command's `as` / a rex capture / a lookup OUTPUT cannot exist on
 * raw events at all and must NEVER produce a `column-never-populated` verdict
 * (the §17.8a-10 rule, extended to the WHOLE pipeline — `collectComputedNames`
 * deliberately stops at the first transform and cannot be reused here).
 *
 * Over-collection errs SAFE: a name wrongly classed `computed` is skipped with
 * a note instead of probed, so no false verdict can come from it.
 * ------------------------------------------------------------------------- */

export type ColumnOriginKind = 'passthrough' | 'renamed' | 'computed';
export interface ColumnOrigin {
    kind: ColumnOriginKind;
    /** The raw-event field to probe (the rename SOURCE for `renamed`; the
     *  column itself for `passthrough`; unset for `computed`). */
    probeName?: string;
}

const NAME_RE = '(?:"([^"]+)"|\'([^\']+)\'|([A-Za-z_][A-Za-z0-9_.]*))';
const pickName = (m: RegExpExecArray, base: number): string => m[base] ?? m[base + 1] ?? m[base + 2] ?? '';

const collectAssignedNames = (segments: string[]): Set<string> => {
    const names = new Set<string>();
    for (const seg of segments) {
        const t = seg.trim();
        if (!t) continue;
        const cmd = commandOf(t);
        if (/^eval$/i.test(cmd) || /^eventstats$/i.test(cmd) || /^streamstats$/i.test(cmd)) {
            // eval targets: `<name> =` where the next char is not another `=`
            // (comparison). Also catches the comma-separated multi-assign form.
            const re = new RegExp(NAME_RE + '\\s*=(?!=)', 'g');
            let m = re.exec(t);
            while (m) {
                const n = pickName(m, 1);
                if (n) names.add(n);
                m = re.exec(t);
            }
        }
        if (!/^eval$/i.test(cmd)) {
            // `as <name>` outputs from stats/chart/timechart/etc. — and any
            // other aliasing command. Over-collection (e.g. a rename target
            // landing here) only ever classifies a name `computed`, which
            // SKIPS the probe — the declared safe direction; the rename-chain
            // resolution below checks the FINAL source name, not the target.
            const re = new RegExp('\\bas\\s+' + NAME_RE, 'gi');
            let m = re.exec(t);
            while (m) {
                const n = pickName(m, 1);
                if (n) names.add(n);
                m = re.exec(t);
            }
        }
        // rex named captures — the probe samples events WITHOUT the panel's rex.
        {
            const re = /\(\?<([A-Za-z_][A-Za-z0-9_.]*)>/g;
            let m = re.exec(t);
            while (m) {
                names.add(m[1]);
                m = re.exec(t);
            }
        }
        // lookup OUTPUT/OUTPUTNEW fields — supplied by the lookup, not raw events.
        if (/^lookup$/i.test(cmd)) {
            const om = t.match(/\bOUTPUT(?:NEW)?\b([\s\S]*)$/i);
            if (om) {
                const re = new RegExp(NAME_RE, 'g');
                let m = re.exec(om[1]);
                while (m) {
                    const n = pickName(m, 1);
                    if (n && !/^as$/i.test(n)) names.add(n);
                    m = re.exec(om[1]);
                }
            }
        }
    }
    return names;
};

const collectRenamePairs = (segments: string[]): Map<string, string> => {
    // display -> source, last write wins (SPL rename order).
    const renames = new Map<string, string>();
    for (const seg of segments) {
        const t = seg.trim();
        if (commandOf(t) !== 'rename') continue;
        const re = new RegExp(NAME_RE + '\\s+as\\s+' + NAME_RE, 'gi');
        let m = re.exec(t);
        while (m) {
            const src = pickName(m, 1);
            const dst = pickName(m, 4);
            if (src && dst) renames.set(dst, src);
            m = re.exec(t);
        }
    }
    return renames;
};

/**
 * Resolve each displayed column to what (if anything) may be probed on raw
 * events. Pure and total: every input column gets an entry.
 */
export const resolveColumnOrigins = (
    spl: string,
    columns: ReadonlyArray<string>,
): Record<string, ColumnOrigin> => {
    const segments = splitTopLevelPipes(String(spl ?? ''));
    const assigned = collectAssignedNames(segments);
    const renames = collectRenamePairs(segments);
    const out: Record<string, ColumnOrigin> = {};
    for (const col of columns) {
        let name = col;
        let hops = 0;
        let renamed = false;
        while (renames.has(name) && hops < 5) {
            const next = renames.get(name) as string;
            if (next === name) break;
            name = next;
            renamed = true;
            hops += 1;
        }
        if (assigned.has(name)) {
            out[col] = { kind: 'computed' };
        } else if (renamed) {
            out[col] = { kind: 'renamed', probeName: name };
        } else {
            out[col] = { kind: 'passthrough', probeName: name };
        }
    }
    return out;
};

/** §18.8a-10 — the SINGLE field a scalar KPI query emits, when its terminal
 *  segment is a one-token `| fields X` (keep-form) or `| table X`. Null for
 *  multi-field rows, remove-form, or anything else — which DISABLES the
 *  scalar-twin value probe (kpiBandwidth's `{n, total_bytes, total}` row was
 *  the review's blocker P-4: "first row's numeric value" would have read an
 *  event count against a bytes display). */
export const terminalSingletonField = (spl: string): string | null => {
    const segments = splitTopLevelPipes(String(spl ?? ''));
    let last = '';
    for (const seg of segments) {
        if (seg.trim().length > 0) last = seg.trim();
    }
    const m = last.match(/^(fields|table)\s+(?!\s*-)("?)([A-Za-z_][A-Za-z0-9_.]*)\2\s*$/i);
    return m ? m[3] : null;
};

/** The shared terminal field of BOTH scalar arms — the §18.8a-10 precondition
 *  for the value probe. Null when either arm is not a singleton, or the names
 *  differ. */
export const scalarTwinFieldFor = (cachedSpl: string, rawSpl: string): string | null => {
    const a = terminalSingletonField(cachedSpl);
    const b = terminalSingletonField(rawSpl);
    return a !== null && a === b ? a : null;
};

/** Build `fieldFilters` + `baseDisjunction` for a raw-tier panel. */
const collectFieldFilters = (
    baseClause: string,
    segments: string[],
): { fieldFilters: FieldFilter[]; baseDisjunction: boolean } => {
    const computed = collectComputedNames(segments);
    const base = filtersFromClause(baseClause, 'base', computed);
    const all: FieldFilter[] = [...base.filters];
    // Pre-transform `| search` / `| where` segments (not the head/base itself).
    for (const seg of segments) {
        const t = seg.trim();
        if (!t) continue;
        const cmd = commandOf(t);
        if (TRANSFORMING.test(cmd)) break;
        if (cmd !== 'search' && cmd !== 'where') continue;
        const body = t.replace(/^(search|where)\s+/i, '');
        // A `| search`/`| where` that is itself a disjunction contributes nothing.
        const r = filtersFromClause(body, cmd as 'search' | 'where', computed);
        if (!r.disjunction) all.push(...r.filters);
    }
    // De-dup by fragment; cap.
    const seen = new Set<string>();
    const deduped: FieldFilter[] = [];
    for (const f of all) {
        if (seen.has(f.fragment)) continue;
        seen.add(f.fragment);
        deduped.push(f);
        if (deduped.length >= MAX_FIELD_FILTERS) break;
    }
    return { fieldFilters: deduped, baseDisjunction: base.disjunction };
};

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

const analyze = (splRaw: string): SplProbe => {
    const spl = String(splRaw ?? '');
    const probe: SplProbe = {
        tier: 'unknown',
        collections: [],
        grain: 'none',
        hasRangeFilter: false,
        sourcetypes: [],
        tags: [],
        lookups: [],
        macros: [],
        grainFilters: [],
        fieldFilters: [],
        baseDisjunction: false,
        hasSubsearch: false,
        emptySafeKpi: false,
        lint: [],
        notes: [],
    };
    if (!spl.trim()) {
        probe.notes.push('Empty query — the panel dispatched nothing.');
        return probe;
    }

    const segments = splitTopLevelPipes(spl);
    const head = segments.find((s) => s.trim().length > 0) ?? '';
    const headCmd = commandOf(head);
    probe.hasSubsearch = /\[/.test(spl);

    // --- macros -----------------------------------------------------------
    MACRO_RE.lastIndex = 0;
    let mm = MACRO_RE.exec(spl);
    while (mm) {
        if (!probe.macros.includes(mm[1])) probe.macros.push(mm[1]);
        mm = MACRO_RE.exec(spl);
    }

    // --- range filter + grain --------------------------------------------
    if (RANGE_HOURLY_RE.test(spl)) {
        probe.grain = 'hourly';
        probe.hasRangeFilter = true;
    } else if (RANGE_DAILY_RE.test(spl)) {
        probe.grain = 'daily';
        probe.hasRangeFilter = true;
    }

    // --- tier + tier-specific extraction ----------------------------------
    // `predicateScope` is the ONLY text from which index-level constraints
    // (sourcetype / tag / host / cloud) may be read. For a rollup read it stays
    // empty, so a post-inputlookup `| search sourcetype="x"` can never be
    // mistaken for an index predicate (trap 3).
    let predicateScope = '';
    let predicateScopeWithSubsearches = '';

    if (headCmd === 'inputlookup') {
        probe.tier = 'cached';
        for (const seg of segments) {
            const t = seg.trim();
            if (commandOf(t) !== 'inputlookup') continue;
            const m = t.match(INPUTLOOKUP_RE);
            if (!m) {
                probe.notes.push(`Could not parse an inputlookup segment: ${trimFragment(t, 80)}`);
                continue;
            }
            const name = m[1];
            const whereExpr = m[2] ?? '';
            if (/^logserv_/.test(name)) {
                if (!probe.collections.includes(name)) probe.collections.push(name);
                if (!probe.collection) {
                    probe.collection = name;
                    const met = whereExpr.match(METRIC_RE);
                    if (met) probe.metric = met[1];
                }
            } else {
                // A CSV / non-rollup lookup read as a generating command.
                if (!probe.lookups.includes(name)) probe.lookups.push(name);
            }
        }
        if (!probe.hasRangeFilter) {
            probe.notes.push(
                'This rollup read has no info_min_time/info_max_time range filter, so it ignores the time picker.',
            );
        }
    } else if (headCmd === 'tstats') {
        probe.tier = 'tstats';
        const t = head.trim();
        // Everything between WHERE and the first BY is the predicate.
        const w = t.match(/\bWHERE\b([\s\S]*?)(?:\bBY\b[\s\S]*)?$/i);
        predicateScopeWithSubsearches = w ? w[1] : '';
        predicateScope = stripSubsearches(predicateScopeWithSubsearches);
        if (!w) probe.notes.push('tstats without a WHERE clause — index scope not determined.');
    } else if (spl.includes(`\`${IDX_MACRO}\``) || head.includes('`')) {
        probe.tier = 'raw';
        predicateScopeWithSubsearches = head;
        predicateScope = stripSubsearches(head);
    } else {
        probe.tier = 'unknown';
        probe.notes.push(
            `Unrecognised leading command "${headCmd || '(none)'}" — only tier-agnostic checks apply.`,
        );
    }

    if (predicateScope) {
        probe.sourcetypes = collectSourcetypes(predicateScope);
        probe.tags = collectTags(predicateScope);
    }

    // --- field filters (checks 22 & 25; raw-tier only) --------------------
    // The base clause here excludes the leading macro token: index-level
    // constraints (sourcetype/tag/cloud/host) are owned by other checks and by
    // FIELD_FILTER_EXCLUDED. §17.8a-8,10.
    if (probe.tier === 'raw' && predicateScope) {
        const baseClause = predicateScope.replace(new RegExp('`' + IDX_MACRO + '`', 'g'), ' ');
        const ff = collectFieldFilters(baseClause, segments);
        probe.fieldFilters = ff.fieldFilters;
        probe.baseDisjunction = ff.baseDisjunction;
    }

    // --- filters ----------------------------------------------------------
    probe.cloudFilter = detectCloudFilter(segments, predicateScope);

    if (probe.tier === 'cached') {
        // Host filter arrives as `| search (host="a" OR host="b")` after the
        // range filter, in the same position the cloud pipe uses.
        for (const seg of segments) {
            const t = seg.trim();
            if (commandOf(t) !== 'search') continue;
            const body = t.replace(/^search\s+/i, '');
            if (/^cloud_provider\s*=/.test(body)) continue;
            const hf = detectHostFilter(body, body);
            if (hf && !probe.hostFilter) {
                probe.hostFilter = hf;
                continue;
            }
            probe.grainFilters.push(trimFragment(body, 80));
        }
    } else if (predicateScope) {
        probe.hostFilter = detectHostFilter(predicateScope, predicateScopeWithSubsearches);
    }

    // --- lookups (non-rollup, applied mid-pipeline) -----------------------
    for (const seg of segments) {
        const t = seg.trim();
        if (commandOf(t) !== 'lookup') continue;
        const m = t.match(/^lookup\s+(?:local\s*=\s*\S+\s+|update\s*=\s*\S+\s+)*([A-Za-z_][A-Za-z0-9_.-]*)/i);
        if (m && !probe.lookups.includes(m[1])) probe.lookups.push(m[1]);
    }

    // --- head cap ---------------------------------------------------------
    for (const seg of segments) {
        const t = seg.trim();
        const m = t.match(/^head\s+(\d+)\s*$/i);
        if (m) {
            const n = parseInt(m[1], 10);
            probe.headLimit = typeof probe.headLimit === 'number' ? Math.min(probe.headLimit, n) : n;
        }
    }

    // --- empty-safe scalar KPI idiom --------------------------------------
    probe.emptySafeKpi =
        /\bstats\s+count\s+as\s+n\b/i.test(spl) && /\bfillnull\s+value\s*=\s*0\b/i.test(spl);

    // --- lint -------------------------------------------------------------
    if (probe.tier === 'raw' || probe.tier === 'tstats') {
        probe.lint.push(...lintMatchInBase(predicateScopeWithSubsearches || head, segments));
    } else {
        probe.lint.push(...lintMatchInBase('', segments));
    }
    probe.lint.push(...lintBareBooleanInWhere(segments));
    probe.lint.push(...lintNumericVsStringBoolean(spl));

    return probe;
};

// ---------------------------------------------------------------------------
// Memoised public entry point
// ---------------------------------------------------------------------------

/**
 * A small LRU-ish cache. The probe runs a dozen regexes over a string that can
 * be 3 kB long, and `useSearch` is invoked ~339 times per page — so the probe
 * must never run in a hot render path uncached. In practice a dashboard has
 * well under 100 distinct SPL strings, and the cache is cleared wholesale
 * rather than evicted per-entry (simpler, and the cost of a cold re-parse is
 * microseconds).
 */
const CACHE_LIMIT = 400;
const cache = new Map<string, SplProbe>();

export const probeSpl = (spl: string): SplProbe => {
    const key = spl ?? '';
    const hit = cache.get(key);
    if (hit) return hit;
    const result = analyze(key);
    if (cache.size >= CACHE_LIMIT) cache.clear();
    cache.set(key, result);
    return result;
};

/** Test seam — drop the memo (used by the consistency test). */
export const __clearSplProbeCache = (): void => cache.clear();
