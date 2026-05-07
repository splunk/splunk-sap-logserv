/**
 * auditQuery — read-only fetch of `_ai_assistant_audit` events from
 * Splunk's search REST endpoint. Used by the Settings page's Audit Log
 * viewer (build 95, session 022).
 *
 * The endpoint is `services/search/jobs/oneshot` proxied through Splunk
 * Web's `__raw` route — same auth model as `aiConfigApi.ts` (cookie
 * session + X-Requested-With + X-Splunk-Form-Key).
 *
 * Read-only by design. There is no write path in this module. The
 * underlying Splunk endpoint is also a search dispatcher — it cannot
 * mutate index data even if a caller tried.
 *
 * Tamper-resistance note. The data this module returns is whatever
 * Splunk's index has at query time. A host-root admin who tampered
 * with the bucket between the audit write and this read would return
 * tampered data without warning. The viewer's inline doc note covers
 * the threat model and the recommended forwarder mitigation.
 */

const APP_NAMESPACE = 'splunk_app_sap_logserv';
/**
 * Search-time anchor for the audit-log SPL. Resolves to the configured
 * audit index name via `default/macros.conf`. Customers who rename the
 * audit index update the macro definition (and the matching
 * `audit_index_name` field in `ai_assistant_settings.conf`); this
 * module needs no code change.
 */
const AUDIT_INDEX_MACRO = '`sap_logserv_audit_idx_macro`';
const ONESHOT_URL =
    `/en-US/splunkd/__raw/servicesNS/nobody/${APP_NAMESPACE}/search/jobs/oneshot`;

/* Time-range preset map removed in build 137 / session 024 — the audit
 * viewer now reads earliest/latest directly from the global TimeRange
 * picker in the navigation bar (see AuditLogViewer's useTimeRange()
 * call). Per-page time pickers fragmented the UX; the global one is
 * always visible and the convention across every dashboard. */

/** Audit categories we know about. Extend whenever a new category is
 *  added to `auditTypes.ts`. Sorted alphabetically so the viewer's
 *  multi-select renders in a stable order; insertion order in
 *  auditTypes.ts is build-history-driven and not user-friendly.
 *  Build 136 / session 024 — added the 3 categories that landed in
 *  session 022 (`ai_assistant_enable_acceptance`,
 *  `audit_forwarder_failure`, `forwarder_disabled_acceptance`) and
 *  were never reflected here, leaving 18-of-38 events unfilterable. */
export const AUDIT_CATEGORIES = [
    'ai_assistant_enable_acceptance',
    'audit_forwarder_failure',
    'daily_spend_cap_hit',
    'forwarder_disabled_acceptance',
    'local_only',
    'rate_limited_prompt',
    'security_blocked_spl',
    'session_tool_cap_hit',
    'user_prompt_jailbreak_flag',
    'vendor_tier1',
    'vendor_tier2',
    'vendor_tier2_elevation',
] as const;

export type AuditCategoryName = typeof AUDIT_CATEGORIES[number];

export interface AuditQueryFilters {
    /** Splunk earliest_time string (relative like "-7d" or absolute epoch).
     *  Sourced from the global TimeRangeProvider in the viewer — build 137
     *  / session 024 replaced the previous `range: TimeRangePreset` field. */
    earliest: string;
    /** Splunk latest_time string. Usually "now" but the global picker can
     *  also produce absolute timestamps. */
    latest: string;
    /** When non-empty, restrict results to these categories. Empty array
     *  means "all categories". */
    categories: AuditCategoryName[];
    /** When non-empty, restrict to events whose `user` field contains
     *  this substring (case-insensitive). */
    userContains: string;
    /** Max number of events to return from Splunk. The viewer paginates
     *  these client-side at PAGE_SIZE rows per page. The endpoint returns
     *  at most `count` results regardless of how many match. */
    limit: number;
}

/** A single audit row returned by the search. The shape is the union of
 *  every `AuditEvent` shape from `auditTypes.ts` plus Splunk's
 *  metadata (`_time`, `_raw`). The viewer renders fields based on
 *  `category`. */
export interface AuditRow {
    _time: string;
    _raw?: string;
    category: string;
    user?: string;
    sessionId?: string;
    seq?: number;
    [key: string]: unknown;
}

const readCsrfToken = (): string => {
    const m = (`; ${document.cookie}`).match(
        /; splunkweb_csrf_token_\d+=([^;]+)/,
    );
    return m ? decodeURIComponent(m[1]) : '';
};

const buildHeaders = (): Record<string, string> => ({
    'X-Requested-With': 'XMLHttpRequest',
    'X-Splunk-Form-Key': readCsrfToken(),
    'Content-Type': 'application/x-www-form-urlencoded',
});

const escapeForSpl = (s: string): string =>
    // Splunk SPL uses double-quote-delimited literals; escape backslashes
    // and double quotes inside any user-provided substring.
    s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

/**
 * Build the SPL search string from filter inputs. Always anchors to the
 * audit index. Filters compose with AND; multiple categories compose
 * with OR. Sorts descending by _time.
 *
 * The SPL is constructed defensively — user inputs are filtered through
 * `escapeForSpl` before string interpolation. The `category` and time
 * range come from typed enums, so they don't need escaping.
 */
const buildSpl = (filters: AuditQueryFilters): string => {
    const clauses: string[] = [AUDIT_INDEX_MACRO];
    if (filters.categories.length > 0) {
        const cats = filters.categories.map((c) => `"${c}"`).join(',');
        clauses.push(`category IN (${cats})`);
    }
    if (filters.userContains.trim().length > 0) {
        const u = escapeForSpl(filters.userContains.trim());
        clauses.push(`user="*${u}*"`);
    }
    // `spath` parses the JSON in `_raw` and projects every leaf field
    // into a column. Required because the audit sourcetype
    // `logserv:ai_assistant:audit` doesn't have `KV_MODE=json` set in
    // props.conf — without spath the search result only carries
    // `_time` + `_raw` + Splunk metadata, leaving `category`, `user`,
    // and the per-category fields invisible to the JSON renderer.
    //
    // The follow-up `eval category=json_extract(_raw,"category")` is a
    // workaround for a Splunk reserved-field collision: `category` is
    // pre-populated by Splunk's automatic event classification (value
    // "unknown" for our sourcetype) and `spath` does NOT overwrite it.
    // `eval` does, so we re-derive the category directly from the
    // raw JSON. Other JSON fields (user, model, sessionId, etc.) don't
    // collide with reserved names and arrive correctly via spath alone.
    return [
        `search ${clauses.join(' ')}`,
        `head ${Math.max(1, Math.min(5000, filters.limit))}`,
        // Sort descending so the newest event shows up first. _time alone
        // would already be sorted by Splunk for index= searches in most
        // cases, but `head` doesn't guarantee order — this makes it
        // explicit.
        `sort -_time`,
        `spath`,
        `eval category=json_extract(_raw, "category")`,
    ].join(' | ');
};

/**
 * Run the audit-log search and return parsed rows. Resolves with an
 * empty array on any failure (network, 401/403, malformed JSON) — the
 * viewer treats this as "nothing to show" and surfaces an error banner
 * via the `meta.error` channel below.
 */
export interface AuditQueryResult {
    rows: AuditRow[];
    /** Splunk's reported `init_offset + length(results)` — useful when
     *  the result count equals `limit` (caller can show a "more
     *  available, raise the limit" hint). */
    resultCount: number;
    /** Time taken by the search in ms (Splunk's reported `runDuration` */
    durationMs?: number;
    /** Empty string on success; non-empty when the call failed and the
     *  caller should surface this to the user. */
    error: string;
}

export const queryAuditLog = async (
    filters: AuditQueryFilters,
): Promise<AuditQueryResult> => {
    const spl = buildSpl(filters);
    const params = new URLSearchParams();
    params.set('search', spl);
    params.set('earliest_time', filters.earliest);
    params.set('latest_time', filters.latest);
    params.set('output_mode', 'json');
    // count caps the result page size; mirrors the SPL `head N` for
    // consistency.
    params.set('count', String(Math.max(1, Math.min(5000, filters.limit))));

    let resp: Response;
    try {
        resp = await fetch(ONESHOT_URL, {
            method: 'POST',
            credentials: 'same-origin',
            headers: buildHeaders(),
            body: params.toString(),
        });
    } catch (e) {
        return {
            rows: [],
            resultCount: 0,
            error: `Network error: ${e instanceof Error ? e.message : String(e)}`,
        };
    }
    if (!resp.ok) {
        return {
            rows: [],
            resultCount: 0,
            error: `Search failed: HTTP ${resp.status} ${resp.statusText}`,
        };
    }
    let data: unknown;
    try {
        data = await resp.json();
    } catch (e) {
        return {
            rows: [],
            resultCount: 0,
            error: `Invalid JSON from Splunk: ${e instanceof Error ? e.message : String(e)}`,
        };
    }
    const obj = data as { results?: unknown[] };
    const results = Array.isArray(obj.results) ? obj.results : [];
    const rows: AuditRow[] = results
        .filter((r): r is Record<string, unknown> => !!r && typeof r === 'object')
        .map((r) => {
            const row: AuditRow = {
                _time: typeof r._time === 'string' ? r._time : '',
                category: typeof r.category === 'string' ? r.category : 'unknown',
            };
            // Spread every other key as-is; Splunk returns indexed/extracted
            // fields plus `_raw`. The viewer cares about `_raw` for the
            // expand-row JSON view; everything else is metadata.
            for (const [k, v] of Object.entries(r)) {
                if (k === '_time' || k === 'category') continue;
                row[k] = v;
            }
            return row;
        });
    return { rows, resultCount: rows.length, error: '' };
};
