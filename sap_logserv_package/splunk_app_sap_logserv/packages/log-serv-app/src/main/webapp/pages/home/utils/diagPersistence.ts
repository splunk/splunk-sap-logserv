/**
 * diagPersistence — KV Store persistence for LogServ Data Doctor reports
 * (design §13.5 + §13.8a corrections; session 096; decision 5's other half).
 *
 * Every generated report (panel / dashboard / environment) is best-effort
 * persisted into the `logserv_diag_reports` collection so the `#/diagnostics`
 * page can list and re-download past reports. The stored payload is the FULL
 * `DiagReportModel` (minus the machine-readable-appendix section, which
 * duplicates `model.json` byte-for-byte — it is re-appended on fetch), so
 * `renderReportPdf` reproduces the identical PDF later.
 *
 * GATE-SAFETY CONTRACT (this module is loaded by `bin/check-diagnostics.js`
 * under plain node, and its consistency test drives every path):
 *  - NO `@splunk` imports — the username comes from `model.meta.username`;
 *  - no React, no module-level `window`/`document` access (the CSRF read is
 *    call-time and guarded);
 *  - `fetch` is injectable on every I/O function.
 *
 * WRITE:[*] REALITY (design Risk 7): the collection is world-writable like
 * every other `logserv_*` collection, so everything read back is UNTRUSTED —
 * rows are validated on read (`parseListRow`, `looksLikeReportModel`, size
 * cap, key pattern) and stored reports are shared, unauthenticated-integrity
 * artifacts: the authoritative copy of a report is the one downloaded when it
 * was generated.
 */

import { DiagReportModel, jsonAppendixSection, dataBanner, LEGACY_DATA_BANNERS } from './diagReport';

export const DIAG_REPORTS_COLLECTION = 'logserv_diag_reports';

/**
 * Every field the persistence layer writes. The build gate drift-checks
 * transforms.conf's `[logserv_diag_reports] fields_list` against this array in
 * BOTH directions: the nightly retention search rewrites every surviving row
 * through that fields_list, silently STRIPPING any unlisted field — a drifted
 * list would destroy stored models one night later with a green build.
 */
export const DIAG_REPORT_FIELDS: string[] = [
    '_key',
    'report_id',
    'generated_at',
    'generated_at_iso',
    'username',
    'scope',
    'scope_label',
    'verdict_summary',
    'app_build',
    'truncated',
    'model_json',
];

/**
 * Size caps (§13.8a correction 5). The nightly retention round-trips every
 * surviving row through one SPL search; the product of these two constants
 * bounds that worst case (100 × 200 000 chars = 20 MB), provably under the
 * `limits.conf [kvstore] max_size_per_result_mb = 50` default — at which a
 * truncated read would feed a partial set into an OVERWRITE and silently
 * delete stored reports. The consistency test asserts the product stays
 * ≤ 40 MB. `RETENTION_MAX_ROWS` must match the `| sort N - generated_at`
 * count in `[logserv_diag_reports_retention]` (the gate derives the expected
 * SPL token from this constant).
 */
export const MAX_MODEL_JSON_CHARS = 200000;
export const RETENTION_MAX_ROWS = 100;

/** Report IDs come from diagReport.makeReportId(): `LSV-<base36>-<base36>`,
 *  uppercase. Anything else in `_key` is a hand-POSTed row — skipped on read
 *  and never spliced into a fetch URL. */
const REPORT_KEY_PATTERN = /^LSV-[A-Z0-9]+-[A-Z0-9]+$/;

const APP_NAMESPACE = 'splunk_app_sap_logserv';
const KV_BASE =
    `/en-US/splunkd/__raw/servicesNS/nobody/${APP_NAMESPACE}` +
    `/storage/collections/data/${DIAG_REPORTS_COLLECTION}`;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DiagReportRecord {
    _key: string;
    report_id: string;
    /** Epoch SECONDS (number) — the retention search compares this against
     *  `relative_time(now(), "-365d")`. */
    generated_at: number;
    generated_at_iso: string;
    username: string;
    /** The report kind: panel | dashboard | environment (from model.json.kind). */
    scope: string;
    scope_label: string;
    verdict_summary: string;
    app_build: string;
    /** 1 when the model was too large to store (listable, not re-downloadable). */
    truncated: number;
    /** JSON.stringify of the DiagReportModel (appendix section stripped), or
     *  '' when truncated. */
    model_json: string;
}

export interface DiagReportListRow {
    key: string;
    generatedAt: number;
    generatedAtIso: string;
    username: string;
    scope: string;
    scopeLabel: string;
    verdictSummary: string;
    appBuild: string;
    truncated: boolean;
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

const defaultFetch: FetchLike = (url, init) =>
    (fetch as unknown as FetchLike)(url, init);

// ---------------------------------------------------------------------------
// Headers (call-time, node-safe)
// ---------------------------------------------------------------------------

const readCsrfToken = (): string => {
    if (typeof document === 'undefined') return '';
    const m = `; ${document.cookie}`.match(/; splunkweb_csrf_token_\d+=([^;]+)/);
    return m ? decodeURIComponent(m[1]) : '';
};

const sharedHeaders = (): Record<string, string> => ({
    'X-Requested-With': 'XMLHttpRequest',
});

const mutatingHeaders = (): Record<string, string> => ({
    ...sharedHeaders(),
    'Content-Type': 'application/json',
    'X-Splunk-Form-Key': readCsrfToken(),
});

// ---------------------------------------------------------------------------
// Pure model helpers
// ---------------------------------------------------------------------------

const APPENDIX_HEADING = jsonAppendixSection({}).heading;

/** Drop the machine-readable-appendix section before storage — it duplicates
 *  `model.json` byte-for-byte and would double every stored row's size. */
export const stripAppendixForStorage = (model: DiagReportModel): DiagReportModel => ({
    ...model,
    sections: model.sections.filter((s) => s.heading !== APPENDIX_HEADING),
});

/** Re-append the appendix (from `model.json`, via the SAME builder the report
 *  builders use) so a re-rendered PDF is content-identical to the original. */
export const restoreAppendix = (model: DiagReportModel): DiagReportModel => {
    for (let i = 0; i < model.sections.length; i += 1) {
        if (model.sections[i].heading === APPENDIX_HEADING) return model;
    }
    return {
        ...model,
        sections: model.sections.concat([jsonAppendixSection(model.json)]),
    };
};

/** One line for the list's Summary column, derived per report kind. Pure and
 *  defensive — `model.json` may be anything after a KV round trip. */
export const summarizeModel = (model: DiagReportModel): string => {
    const json = (model.json || {}) as Record<string, unknown>;
    const kind = typeof json.kind === 'string' ? json.kind : '';
    if (kind === 'panel') {
        const diag = json.diagnosis as
            | { top?: { headline?: unknown; confidence?: unknown } }
            | undefined;
        const head =
            diag && diag.top && typeof diag.top.headline === 'string' ? diag.top.headline : '';
        const conf =
            diag && diag.top && typeof diag.top.confidence === 'string' ? diag.top.confidence : '';
        if (head) return conf ? `${head} (${conf})` : head;
        return 'Panel diagnosis';
    }
    if (kind === 'dashboard') {
        const sweep = json.sweep as
            | { entries?: unknown[]; diagnosedCount?: unknown }
            | undefined;
        const total = sweep && Array.isArray(sweep.entries) ? sweep.entries.length : 0;
        const diagnosed =
            sweep && typeof sweep.diagnosedCount === 'number' ? sweep.diagnosedCount : 0;
        return `${diagnosed} of ${total} panel(s) diagnosed`;
    }
    if (kind === 'environment') {
        const env = json.environment as { rollups?: Array<{ status?: unknown }> } | undefined;
        const rows = env && Array.isArray(env.rollups) ? env.rollups : [];
        const tally: Record<string, number> = {};
        rows.forEach((r) => {
            const s = r && typeof r.status === 'string' ? r.status : 'unknown';
            tally[s] = (tally[s] || 0) + 1;
        });
        const parts: string[] = [];
        ['ok', 'stale', 'empty', 'not-checked'].forEach((s) => {
            if (tally[s]) parts.push(`${s} ${tally[s]}`);
        });
        if (parts.length > 0) return `Rollups: ${parts.join(' / ')}`;
        return 'Environment diagnosis';
    }
    return model.scopeLine || 'Diagnostic report';
};

/** Build the KV record for a model. `nowSec` injectable for the tests. */
export const buildReportRecord = (
    model: DiagReportModel,
    nowSec?: number,
): DiagReportRecord => {
    const at = typeof nowSec === 'number' ? nowSec : Math.floor(Date.now() / 1000);
    const stored = stripAppendixForStorage(model);
    let modelJson = '';
    try {
        modelJson = JSON.stringify(stored);
    } catch (e) {
        modelJson = '';
    }
    let truncated = 0;
    if (!modelJson || modelJson.length > MAX_MODEL_JSON_CHARS) {
        modelJson = '';
        truncated = 1;
    }
    const kind =
        stored.json && typeof (stored.json as Record<string, unknown>).kind === 'string'
            ? String((stored.json as Record<string, unknown>).kind)
            : 'unknown';
    return {
        _key: model.reportId,
        report_id: model.reportId,
        generated_at: at,
        generated_at_iso: new Date(at * 1000).toISOString(),
        username: model.meta && typeof model.meta.username === 'string' ? model.meta.username : '',
        scope: kind,
        scope_label: model.scopeLine || '',
        verdict_summary: summarizeModel(model),
        app_build: model.meta && typeof model.meta.appBuild === 'string' ? model.meta.appBuild : '',
        truncated,
        model_json: modelJson,
    };
};

// ---------------------------------------------------------------------------
// Read-side validation (write:[*] sanitize-on-read)
// ---------------------------------------------------------------------------

/** Validate EVERY field `renderReportPdf` dereferences (§13.8a correction 7) —
 *  a stored row passing this cannot throw inside the re-render. */
export const looksLikeReportModel = (m: unknown): m is DiagReportModel => {
    if (!m || typeof m !== 'object') return false;
    const o = m as Record<string, unknown>;
    if (typeof o.title !== 'string' || typeof o.scopeLine !== 'string') return false;
    if (typeof o.reportId !== 'string' || typeof o.banner !== 'string') return false;
    if (typeof o.generatedAtLocal !== 'string' || typeof o.generatedAtUtc !== 'string') {
        return false;
    }
    if (typeof o.filenameBase !== 'string') return false;
    if (!o.json || typeof o.json !== 'object' || Array.isArray(o.json)) return false;
    const meta = o.meta as Record<string, unknown> | null | undefined;
    if (!meta || typeof meta !== 'object') return false;
    if (typeof meta.appVersion !== 'string' || typeof meta.appBuild !== 'string') return false;
    if (typeof meta.appBuildDate !== 'string' || typeof meta.username !== 'string') return false;
    if (typeof meta.templatesOnly !== 'boolean') return false;
    if (!Array.isArray(o.sections)) return false;
    for (let i = 0; i < o.sections.length; i += 1) {
        const s = o.sections[i] as Record<string, unknown> | null;
        if (!s || typeof s !== 'object') return false;
        if (typeof s.heading !== 'string' || !Array.isArray(s.blocks)) return false;
    }
    /* SS16.8a-25/26 — sample-bearing models are NEVER stored, and the banner
     * must be the exact derivation of the samples state, so a hand-POSTed row
     * cannot re-render with an understating banner. `json.rawSamples != null`
     * fails the shape gate outright (such a model has no business in the
     * collection); a rawSamples-free model must carry the samples-free banner
     * VERBATIM — the CURRENT one, or (§20.8a-4) an exact PRIOR-build form from
     * `LEGACY_DATA_BANNERS`: without the legacy list, a banner wording change
     * silently makes every previously stored report un-re-downloadable. */
    const json = o.json as Record<string, unknown>;
    if (json.rawSamples != null) return false;
    if (o.banner !== dataBanner(false) && LEGACY_DATA_BANNERS.indexOf(o.banner as string) === -1) {
        return false;
    }
    return true;
};

/** Filename allowlist for stored models (the value reaches triggerDownload). */
export const safeFilenameBase = (s: unknown): string => {
    const cleaned = String(s || '')
        .replace(/[^A-Za-z0-9._-]+/g, '-')
        .replace(/^[-.]+/, '')
        .replace(/[-.]+$/, '')
        .slice(0, 80);
    return cleaned || 'logserv-diagnostic-report';
};

/** Defensive parse of one list row; null = skip (junk / malformed / future-dated). */
export const parseListRow = (r: unknown, nowSec: number): DiagReportListRow | null => {
    if (!r || typeof r !== 'object') return null;
    const o = r as Record<string, unknown>;
    const key = typeof o._key === 'string' ? o._key : '';
    if (!REPORT_KEY_PATTERN.test(key)) return null;
    const at = typeof o.generated_at === 'number' ? o.generated_at : Number(o.generated_at);
    if (!Number.isFinite(at) || at <= 0) return null;
    if (at > nowSec + 86400) return null; // far-future junk defeats sort + caps
    const str = (v: unknown): string => (typeof v === 'string' ? v : '');
    return {
        key,
        generatedAt: at,
        generatedAtIso: str(o.generated_at_iso),
        username: str(o.username),
        scope: str(o.scope),
        scopeLabel: str(o.scope_label),
        verdictSummary: str(o.verdict_summary),
        appBuild: str(o.app_build),
        truncated: o.truncated === 1 || o.truncated === '1' || o.truncated === true,
    };
};

// ---------------------------------------------------------------------------
// I/O
// ---------------------------------------------------------------------------

/**
 * Best-effort persist — a single collection-level POST create (report IDs are
 * unique per generation, so no upsert two-step is needed; a duplicate key just
 * 409s and is reported, not retried). Never throws.
 */
export const persistReport = async (
    model: DiagReportModel,
    fetchImpl?: FetchLike,
): Promise<{ ok: boolean; reason: string }> => {
    const f = fetchImpl || defaultFetch;
    try {
        if (!REPORT_KEY_PATTERN.test(model.reportId)) {
            return { ok: false, reason: `Unexpected report id: ${model.reportId}` };
        }
        /* SS16.8a-25 — REFUSE sample-bearing models regardless of caller.
         * The reports collection is world-readable + export=system; storing
         * raw events in it would bypass index ACLs. `downloadReport` already
         * derives the skip; this guard makes the rule unforgeable here. */
        if (model.json && model.json.rawSamples != null) {
            return { ok: false, reason: 'Sample-bearing reports are download-only, never stored.' };
        }
        const record = buildReportRecord(model);
        const resp = await f(KV_BASE, {
            method: 'POST',
            credentials: 'same-origin',
            headers: mutatingHeaders(),
            body: JSON.stringify(record),
        });
        if (!resp.ok) return { ok: false, reason: `KV Store write failed: HTTP ${resp.status}` };
        return { ok: true, reason: '' };
    } catch (e) {
        return { ok: false, reason: e instanceof Error ? e.message : String(e) };
    }
};

/**
 * Newest-first listing WITHOUT the model payloads (`fields` excludes
 * model_json so a large row cannot bloat the list read).
 * `sort=generated_at:-1` is the ONLY descending form the KV data endpoint
 * honours — `sort=-generated_at` is accepted, ~90x slower, and silently
 * returns ASCENDING (session 094). Returns null on transport failure so the
 * caller can distinguish "no reports" from "could not list".
 */
export const listReports = async (
    limit = 50,
    fetchImpl?: FetchLike,
): Promise<DiagReportListRow[] | null> => {
    const f = fetchImpl || defaultFetch;
    const fields = DIAG_REPORT_FIELDS.filter((x) => x !== 'model_json').join(',');
    const url =
        `${KV_BASE}?sort=generated_at:-1&limit=${Math.max(1, Math.floor(limit))}` +
        `&fields=${encodeURIComponent(fields)}&output_mode=json`;
    try {
        const resp = await f(url, { credentials: 'same-origin', headers: sharedHeaders() });
        if (!resp.ok) return null;
        const raw = await resp.json();
        if (!Array.isArray(raw)) return null;
        const nowSec = Math.floor(Date.now() / 1000);
        const rows: DiagReportListRow[] = [];
        raw.forEach((r) => {
            const row = parseListRow(r, nowSec);
            if (row) rows.push(row);
        });
        return rows;
    } catch (e) {
        return null;
    }
};

/**
 * Fetch + validate one stored model. Null on ANY failure: bad key, transport,
 * truncated/absent payload, oversize payload (a hand-POSTed multi-MB row must
 * not reach the renderer), non-JSON, or a shape the renderer would throw on.
 * The returned model has the appendix section restored and a sanitized
 * filenameBase.
 */
export const fetchReportModel = async (
    key: string,
    fetchImpl?: FetchLike,
): Promise<DiagReportModel | null> => {
    const f = fetchImpl || defaultFetch;
    if (!REPORT_KEY_PATTERN.test(key)) return null;
    try {
        const resp = await f(`${KV_BASE}/${encodeURIComponent(key)}?output_mode=json`, {
            credentials: 'same-origin',
            headers: sharedHeaders(),
        });
        if (!resp.ok) return null;
        const raw = await resp.json();
        if (!raw || typeof raw !== 'object') return null;
        const mj = (raw as Record<string, unknown>).model_json;
        if (typeof mj !== 'string' || mj.length === 0) return null;
        if (mj.length > MAX_MODEL_JSON_CHARS) return null;
        let parsed: unknown;
        try {
            parsed = JSON.parse(mj);
        } catch (e) {
            return null;
        }
        if (!looksLikeReportModel(parsed)) return null;
        const model = restoreAppendix(parsed);
        return { ...model, filenameBase: safeFilenameBase(model.filenameBase) };
    } catch (e) {
        return null;
    }
};
