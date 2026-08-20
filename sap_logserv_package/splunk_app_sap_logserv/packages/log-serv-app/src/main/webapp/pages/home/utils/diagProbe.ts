/**
 * diagProbe — the imperative dispatch service behind the Missing-Data
 * Diagnostic's evidence checks (session 094, Phase 2).
 *
 * Phase 1's checks are FREE: pure functions of state a panel already has. This
 * module is what makes the rest possible — it actually asks Splunk questions.
 * It is deliberately small and blunt: run an SPL, read a KV collection, obey a
 * budget, stop when told.
 *
 * WHY RAW `fetch` AND NOT `useSearch`
 * -----------------------------------
 * `useSearch` is a declarative React hook: it dispatches on mount and on
 * dependency change, and surfaces only `{results, loading, error}`. The
 * diagnostic needs the opposite — a caller-driven sequence of short probes with
 * a cancel button, a concurrency cap and a wall-clock budget. That is the same
 * conclusion `RollupBackfillPanel` and `AuditLogViewer` reached; this module
 * uses their transport verbatim (session-055 sticky).
 *
 * THE BUDGET IS THE POINT
 * -----------------------
 * This runs inside a customer's search head — possibly one that is already
 * saturated, which is one of the things the diagnostic exists to detect. Every
 * probe therefore passes through a semaphore (default 2 concurrent) and a
 * shared wall-clock budget (default 90 s). Once the budget is spent, further
 * probes resolve immediately as `skipped` instead of dispatching, and the
 * report says "not evaluated — budget exhausted" rather than silently omitting
 * a check. Design doc §3.5 / Risk 5.
 *
 * COST NOTES, measured on `splunk-sh-idxr` (106 M events, 782 K-row collection):
 *   | tstats count WHERE <macro>                                   ~1.2 s
 *   | tstats count WHERE <macro> (sourcetype=…) BY sourcetype      ~0.6 s
 *   | tstats max(_time) … BY sourcetype   (ALL TIME)               ~2.9 s
 *   | inputlookup <coll> … | stats count  (windowed)               ~0.5 s
 *   | inputlookup <coll> | stats count, min(bucket_ts), max(…)     ~5.1 s  ← avoid
 *   | makeresults count=1                                          ~0.2 s
 * The extent probe is the reason `kvExtent` exists: the same oldest/newest
 * facts come back from the KV REST API in 12–565 ms instead of 5 s.
 */

const APP_NAMESPACE = 'splunk_app_sap_logserv';
const BASE = `/en-US/splunkd/__raw/servicesNS/nobody/${APP_NAMESPACE}`;
const ONESHOT_URL = `${BASE}/search/jobs/oneshot`;
const KV_DATA_BASE = `${BASE}/storage/collections/data`;

/** Splunk Web's CSRF cookie, same reader as `auditQuery.ts`. */
const readCsrfToken = (): string => {
    const m = `; ${document.cookie}`.match(/; splunkweb_csrf_token_\d+=([^;]+)/);
    return m ? decodeURIComponent(m[1]) : '';
};

const postHeaders = (): Record<string, string> => ({
    'X-Requested-With': 'XMLHttpRequest',
    'X-Splunk-Form-Key': readCsrfToken(),
    'Content-Type': 'application/x-www-form-urlencoded',
});

const getHeaders = (): Record<string, string> => ({
    'X-Requested-With': 'XMLHttpRequest',
    'X-Splunk-Form-Key': readCsrfToken(),
});

export interface ProbeResult<TRow = Record<string, unknown>> {
    rows: TRow[];
    /** Empty string on success. Non-empty is shown to the user verbatim — the
     *  message IS the diagnosis for a whole class of failures (a 403 tells you
     *  the role cannot do this; that is information, not an omission). */
    error: string;
    durationMs: number;
    /** True when the probe never ran: the budget was spent, or the runner was
     *  cancelled. A skipped check must never be reported as a passed one. */
    skipped: boolean;
}

const EMPTY_SKIPPED: ProbeResult = { rows: [], error: '', durationMs: 0, skipped: true };

/**
 * Inspect a Splunk JSON response body for messages that mean the rows canNOT
 * be trusted as complete. Pure and exported so the build gate can test it.
 *
 * WHY (session 095, finding 7): every probe passes `max_time`, so on a slow
 * search head the SERVER finalizes the job and returns HTTP 200 with PARTIAL
 * results plus a finalization message. `| tstats … BY sourcetype` truncated
 * that way can be missing a sourcetype entirely — and per the tri-state
 * contract an absent row means "none present", so ignoring the message would
 * fabricate ABSENCE evidence and feed a false "nothing is wrong" verdict on
 * exactly the saturated instance this tool exists to diagnose.
 *
 * Matched: any ERROR/FATAL message, and any message whose text indicates the
 * search was finalized/auto-cancelled/time-limited. Benign INFO/WARN chatter
 * (timerange substitution etc.) passes through.
 */
export const oneshotFailureMessage = (data: unknown): string | null => {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    const msgs = (data as { messages?: unknown }).messages;
    if (!Array.isArray(msgs)) return null;
    for (const m of msgs) {
        if (!m || typeof m !== 'object') continue;
        const type = String((m as { type?: unknown }).type || '').toUpperCase();
        const text = String((m as { text?: unknown }).text || '');
        if (type === 'ERROR' || type === 'FATAL') return text || `Splunk returned ${type}`;
        if (/finaliz|auto[-_ ]?cancel|max_?time|time\s+limit/i.test(text)) {
            return `Search did not complete: ${text}`;
        }
    }
    return null;
};

/**
 * Identifiers spliced into probe SPL — collection names, metric arms,
 * sourcetypes — originate from `splProbe` parsing our OWN dispatched SPL, so
 * they are already constrained in practice. They are validated anyway:
 * defence in depth costs one regex, and `splProbe` also reads host and grain
 * filter VALUES, which on some dashboards originate from a URL parameter or
 * from localStorage (Host Details resolves its selection from `?host=` /
 * `?hosts=`). Anything that fails is dropped rather than escaped, because a
 * probe is optional — a missing check is honest, a mangled one is not.
 */
const SAFE_IDENTIFIER = /^[A-Za-z0-9:._-]{1,120}$/;
export const isSafeIdentifier = (s: string): boolean =>
    typeof s === 'string' && SAFE_IDENTIFIER.test(s);
export const safeIdentifiers = (xs: readonly string[]): string[] =>
    xs.filter(isSafeIdentifier);

export interface ProbeRunnerOptions {
    /** Total wall-clock the whole diagnosis may spend dispatching. */
    budgetMs?: number;
    /** Maximum probes in flight at once. */
    concurrency?: number;
}

export interface ProbeRunner {
    /** Dispatch an SPL search over a window.
     *  `maxTimeSeconds` (§17.8a-5) caps THIS probe's server-side runtime below
     *  the shared floor — used by the deep checks (21 raw scan, 25 bisect) that
     *  must not each consume the whole remaining budget. Omitted → today's
     *  behaviour (the rest of the budget, up to 60 s). Always further clamped to
     *  the remaining budget so the server still gives up before the client. */
    search<TRow = Record<string, unknown>>(
        spl: string,
        earliest: string,
        latest: string,
        maxTimeSeconds?: number,
    ): Promise<ProbeResult<TRow>>;
    /**
     * Read a KV Store collection directly. Far cheaper than `| inputlookup`
     * for oldest/newest questions — see the cost notes above.
     * `params` is passed through as query parameters (e.g.
     * `{ sort: 'bucket_ts:-1', limit: '1', fields: 'bucket_ts' }`).
     */
    kv<TRow = Record<string, unknown>>(
        collection: string,
        params: Record<string, string>,
    ): Promise<ProbeResult<TRow>>;
    /** Generic authenticated GET against a splunkd REST path, returning the
     *  `entry` array. For reading objects (saved searches, apps) rather than
     *  dispatching searches. */
    rest<TRow = Record<string, unknown>>(url: string): Promise<ProbeResult<TRow>>;
    /** Abort everything in flight and skip everything subsequent. */
    cancel(): void;
    isCancelled(): boolean;
    /** Wall-clock consumed since the runner was created. */
    elapsedMs(): number;
    remainingMs(): number;
    /** How many probes actually dispatched — for the report's cost line. */
    dispatched(): number;
}

export const createProbeRunner = (opts: ProbeRunnerOptions = {}): ProbeRunner => {
    const budgetMs = typeof opts.budgetMs === 'number' ? opts.budgetMs : 90000;
    const concurrency = Math.max(1, typeof opts.concurrency === 'number' ? opts.concurrency : 2);
    const startedAt = Date.now();
    const controllers = new Set<AbortController>();
    let cancelled = false;
    let inFlight = 0;
    let count = 0;
    const queue: Array<() => void> = [];

    const elapsedMs = (): number => Date.now() - startedAt;
    const remainingMs = (): number => Math.max(0, budgetMs - elapsedMs());

    /** Semaphore. Resolves when a slot is free. */
    const acquire = (): Promise<void> =>
        new Promise<void>((resolve) => {
            if (inFlight < concurrency) {
                inFlight += 1;
                resolve();
            } else {
                queue.push(() => {
                    inFlight += 1;
                    resolve();
                });
            }
        });

    const release = (): void => {
        inFlight -= 1;
        const next = queue.shift();
        if (next) next();
    };

    const cancel = (): void => {
        cancelled = true;
        controllers.forEach((c) => {
            try {
                c.abort();
            } catch (_e) {
                /* ignore */
            }
        });
        controllers.clear();
        // Drain the queue so nothing dispatches after a cancel.
        while (queue.length) {
            const next = queue.shift();
            if (next) next();
        }
    };

    /** Shared request path. `build` returns the fetch input for this probe. */
    const request = async <TRow>(
        build: (signal: AbortSignal) => { url: string; init: RequestInit },
    ): Promise<ProbeResult<TRow>> => {
        if (cancelled || remainingMs() <= 0) return EMPTY_SKIPPED as ProbeResult<TRow>;
        await acquire();
        // Re-check AFTER waiting for a slot: the budget may have been spent, or
        // the user may have cancelled, while this probe sat in the queue.
        if (cancelled || remainingMs() <= 0) {
            release();
            return EMPTY_SKIPPED as ProbeResult<TRow>;
        }
        const t0 = Date.now();
        const controller = new AbortController();
        controllers.add(controller);
        // Never let a single probe outlive the remaining budget.
        const timer = setTimeout(() => {
            try {
                controller.abort();
            } catch (_e) {
                /* ignore */
            }
        }, Math.max(1000, remainingMs()));
        try {
            const { url, init } = build(controller.signal);
            count += 1;
            const resp = await fetch(url, init);
            if (!resp.ok) {
                return {
                    rows: [],
                    error: `HTTP ${resp.status} ${resp.statusText}`,
                    durationMs: Date.now() - t0,
                    skipped: false,
                };
            }
            const data = (await resp.json()) as unknown;
            // `search/jobs/oneshot` returns { results: [...] };
            // the KV data endpoint returns a bare array.
            /* Three response shapes reach here: `search/jobs/oneshot` returns
             * `{results: []}`, the KV data endpoint returns a bare array, and
             * the REST object endpoints return `{entry: []}`. */
            /* A 200 whose body carries an ERROR/finalization message holds rows
             * that CANNOT be trusted as complete — surfacing them as data would
             * fabricate absence evidence (session 095, finding 7). Report the
             * message as the probe's error instead; tri-state does the rest. */
            const failure = oneshotFailureMessage(data);
            if (failure) {
                return {
                    rows: [],
                    error: failure,
                    durationMs: Date.now() - t0,
                    skipped: false,
                };
            }
            const obj = data as { results?: unknown[]; entry?: unknown[] };
            const rows = Array.isArray(data)
                ? (data as TRow[])
                : ((obj.results || obj.entry || []) as TRow[]);
            return { rows, error: '', durationMs: Date.now() - t0, skipped: false };
        } catch (e) {
            const aborted = cancelled || (e instanceof Error && e.name === 'AbortError');
            return {
                rows: [],
                error: aborted ? '' : `Network error: ${e instanceof Error ? e.message : String(e)}`,
                durationMs: Date.now() - t0,
                skipped: aborted,
            };
        } finally {
            clearTimeout(timer);
            controllers.delete(controller);
            release();
        }
    };

    const search = <TRow>(
        spl: string,
        earliest: string,
        latest: string,
        maxTimeSeconds?: number,
    ): Promise<ProbeResult<TRow>> =>
        request<TRow>((signal) => {
            const params = new URLSearchParams();
            /* The raw REST endpoint requires an EVENT search to begin with the
             * literal `search` keyword — `@splunk/search-job` prepends it, raw
             * fetch does NOT (sessions 055 / 062 / 085). Every probe in
             * `diagEvidence` is pipe-leading, so this normally does nothing;
             * it is here so a future probe cannot reintroduce the bug. */
            params.set('search', /^\s*(search\b|\|)/i.test(spl) ? spl : `search ${spl}`);
            params.set('earliest_time', earliest);
            params.set('latest_time', latest);
            params.set('output_mode', 'json');
            params.set('count', '0');
            /* SERVER-SIDE bounds. `search/jobs/oneshot` is a blocking dispatch
             * that returns results rather than a sid — so there is no
             * `search/jobs/<sid>/control?action=cancel` to call, and aborting
             * the fetch only abandons the HTTP response: the job keeps running
             * and keeps holding a search slot. That makes a purely client-side
             * budget an illusion on the one machine we must not add load to.
             * `max_time` bounds the job's own runtime and `auto_cancel` reaps
             * it if the client goes away, so cancelling the fetch really does
             * stop the work. Kept below the remaining client budget so the
             * server gives up first. */
            // §17.8a-5: an explicit per-probe cap clamps BELOW the budget-derived
            // ceiling (never above it, and never below the 5 s floor), so a deep
            // check cannot spend the whole drawer budget on one raw scan.
            const budgetSeconds = Math.max(5, Math.ceil(Math.min(remainingMs(), 60000) / 1000));
            const perProbeSeconds =
                typeof maxTimeSeconds === 'number'
                    ? Math.max(5, Math.min(budgetSeconds, Math.floor(maxTimeSeconds)))
                    : budgetSeconds;
            params.set('max_time', String(perProbeSeconds));
            params.set('auto_cancel', String(perProbeSeconds));
            return {
                url: ONESHOT_URL,
                init: {
                    method: 'POST',
                    credentials: 'same-origin',
                    headers: postHeaders(),
                    body: params.toString(),
                    signal,
                },
            };
        });

    const kv = <TRow>(
        collection: string,
        params: Record<string, string>,
    ): Promise<ProbeResult<TRow>> => {
        if (!isSafeIdentifier(collection)) {
            return Promise.resolve({
                rows: [],
                error: `Refusing to read collection with unexpected name: ${collection}`,
                durationMs: 0,
                skipped: false,
            });
        }
        return request<TRow>((signal) => {
            const qs = new URLSearchParams(params);
            qs.set('output_mode', 'json');
            return {
                url: `${KV_DATA_BASE}/${encodeURIComponent(collection)}?${qs.toString()}`,
                init: {
                    method: 'GET',
                    credentials: 'same-origin',
                    headers: getHeaders(),
                    signal,
                },
            };
        });
    };

    const rest = <TRow>(url: string): Promise<ProbeResult<TRow>> =>
        request<TRow>((signal) => ({
            url,
            init: {
                method: 'GET',
                credentials: 'same-origin',
                headers: getHeaders(),
                signal,
            },
        }));

    return {
        search,
        kv,
        rest,
        cancel,
        isCancelled: () => cancelled,
        elapsedMs,
        remainingMs,
        dispatched: () => count,
    };
};

/**
 * Read a saved search's definition. Used to trace a cached panel's collection
 * back to the aggregate that populates it — a GET of an object the app itself
 * ships, no capability beyond what every dashboard already needs.
 */
export const fetchSavedSearchSpl = async (
    runner: ProbeRunner,
    name: string,
): Promise<{
    spl: string | null;
    disabled: boolean | null;
    /** §20.8a-6 — the entry's cron, VERBATIM, so no §20 surface has to guess
     *  (or hardcode) a cadence. null when absent/non-string. */
    cronSchedule: string | null;
    /** §20.8a-7 — the entry's `updated` timestamp (entry level, not content):
     *  "definition last modified" turns the current-definition caveat into a
     *  checkable fact. null when absent. */
    updated: string | null;
    error: string;
    skipped: boolean;
}> => {
    if (!isSafeIdentifier(name)) {
        return {
            spl: null,
            disabled: null,
            cronSchedule: null,
            updated: null,
            error: `Unexpected saved-search name: ${name}`,
            skipped: false,
        };
    }
    const r = await runner.rest<{
        updated?: unknown;
        content?: { search?: string; disabled?: unknown; cron_schedule?: unknown };
    }>(`${BASE}/saved/searches/${encodeURIComponent(name)}?output_mode=json`);
    if (r.skipped || r.error) {
        return {
            spl: null,
            disabled: null,
            cronSchedule: null,
            updated: null,
            error: r.error,
            skipped: r.skipped,
        };
    }
    const entry = r.rows.length > 0 ? r.rows[0] : undefined;
    const spl = entry && entry.content ? entry.content.search : undefined;
    const rawCron = entry && entry.content ? entry.content.cron_schedule : undefined;
    const cronSchedule = typeof rawCron === 'string' && rawCron.trim() ? rawCron.trim() : null;
    const updated = entry && typeof entry.updated === 'string' ? entry.updated : null;
    /* `disabled` rides along for the §14.5 producer-disabled upgrade — the
     * trace already fetches this entry, so the fact is free. Tri-state:
     * null = the field was not a boolean (older Splunk / partial entry),
     * and consumers must treat null as UNKNOWN, never as enabled. Splunk
     * REST returns booleans here in JSON mode; the coercion also accepts the
     * '0'/'1' string forms seen from some conf-backed endpoints
     * (RollupBackfillPanel precedent). */
    const rawDisabled = entry && entry.content ? entry.content.disabled : undefined;
    const disabled =
        typeof rawDisabled === 'boolean'
            ? rawDisabled
            : rawDisabled === '1' || rawDisabled === 'true'
              ? true
              : rawDisabled === '0' || rawDisabled === 'false'
                ? false
                : null;
    return {
        spl: typeof spl === 'string' ? spl : null,
        disabled,
        cronSchedule,
        updated,
        error: '',
        skipped: false,
    };
};

/**
 * The index name(s) the app's index macro NAMES, read from the macro
 * DEFINITION itself — window-independent.
 *
 * WHY (session 095, finding 1): the windowed `| tstats … BY index` resolves to
 * an EMPTY list exactly when the window has zero events — which is the only
 * time the "can this role even see the index?" question matters. Splunk
 * returns zero rows and no error for an unauthorized index, so without this
 * read the visibility gate was structurally dead code and the authorization
 * case fell through to a false "there are no events of any kind".
 *
 * Reading `configs/conf-macros` in the app namespace needs no capability
 * beyond what every dashboard already uses (the macro is expanded in every
 * search the user runs), and it picks up a customer's `local/macros.conf`
 * override (e.g. jaclyn's `sap_logserv_logs_con01`).
 */
export const fetchMacroIndexes = async (
    runner: ProbeRunner,
): Promise<{ indexes: string[] | null; error: string; skipped: boolean }> => {
    const r = await runner.rest<{ content?: { definition?: string } }>(
        `${BASE}/configs/conf-macros/sap_logserv_idx_macro?output_mode=json`,
    );
    if (r.skipped || r.error) return { indexes: null, error: r.error, skipped: r.skipped };
    const entry = r.rows.length > 0 ? r.rows[0] : undefined;
    const def = entry && entry.content ? entry.content.definition : undefined;
    if (typeof def !== 'string' || def.length === 0) {
        return { indexes: null, error: 'Macro definition could not be read.', skipped: false };
    }
    const out: string[] = [];
    const re = /\bindex\s*=\s*"?([A-Za-z0-9_-]+)"?/g;
    let m = re.exec(def);
    while (m !== null) {
        if (isSafeIdentifier(m[1]) && out.indexOf(m[1]) === -1) out.push(m[1]);
        m = re.exec(def);
    }
    return { indexes: out, error: '', skipped: false };
};

/* ---------------------------------------------------------------------------
 * ONE DIAGNOSIS AT A TIME
 *
 * `concurrency` is a PER-RUNNER cap, and the failure this tool exists to
 * diagnose — ingest stopped, or the search head saturated — makes EVERY panel
 * on a dashboard empty at once. Host Details alone runs 29 search hooks. If
 * each empty panel could start its own runner, an operator clicking three
 * diagnoses while the first felt slow would triple the load on the machine they
 * are trying to rescue.
 *
 * So the app gets exactly one live runner. Starting a diagnosis supersedes any
 * run still in flight (cancelling it server-side via auto_cancel), and callers
 * can ask whether one is active to disable the affordance elsewhere.
 * ------------------------------------------------------------------------- */
let activeRunner: ProbeRunner | null = null;

/* §18.8a-24 — a plain module variable is invisible to React, so a render-time
 * `disabled={isDiagnosisActive()}` would be stale in both directions (the
 * review's H-F12: enabled during a sweep, stuck disabled after it). Begin/end
 * notify subscribers so a small hook can re-render the Diagnose affordances;
 * the CLICK-HANDLER's imperative `isDiagnosisActive()` check remains the
 * actual enforcement. */
const diagnosisSubscribers = new Set<() => void>();
const notifyDiagnosisSubscribers = (): void => {
    diagnosisSubscribers.forEach((cb) => {
        try {
            cb();
        } catch {
            /* a subscriber must never break the singleton */
        }
    });
};

/** Subscribe to singleton begin/end transitions. Returns the unsubscriber. */
export const subscribeDiagnosisActive = (cb: () => void): (() => void) => {
    diagnosisSubscribers.add(cb);
    return () => {
        diagnosisSubscribers.delete(cb);
    };
};

/** Begin a diagnosis, cancelling and replacing any run already in progress. */
export const beginDiagnosis = (opts: ProbeRunnerOptions = {}): ProbeRunner => {
    if (activeRunner) activeRunner.cancel();
    activeRunner = createProbeRunner(opts);
    notifyDiagnosisSubscribers();
    return activeRunner;
};

/** True while a diagnosis is running — disable "Run full diagnosis" elsewhere. */
export const isDiagnosisActive = (): boolean =>
    !!activeRunner && !activeRunner.isCancelled() && activeRunner.remainingMs() > 0;

/** Release the singleton. Safe to call from an unmount handler. */
export const endDiagnosis = (runner?: ProbeRunner): void => {
    if (runner && runner !== activeRunner) {
        runner.cancel();
        return;
    }
    if (activeRunner) activeRunner.cancel();
    activeRunner = null;
    notifyDiagnosisSubscribers();
};

/**
 * Oldest / newest bucket for a rollup collection, via the KV REST API.
 *
 * `sort=<field>:-1` is the ONLY descending form Splunk's KV Store data endpoint
 * honours. `sort=-<field>` is accepted, is ~90x slower, and silently returns
 * the ASCENDING result — verified on `splunk-sh-idxr`, where it reported the
 * oldest bucket as the newest. Using it would make every freshness verdict
 * exactly wrong.
 */
export const kvExtent = async (
    runner: ProbeRunner,
    collection: string,
    bucketField: string,
): Promise<{ oldest: number | null; newest: number | null; error: string; skipped: boolean }> => {
    if (!isSafeIdentifier(bucketField)) {
        return { oldest: null, newest: null, error: `Unexpected bucket field: ${bucketField}`, skipped: false };
    }
    const one = { limit: '1', fields: bucketField };
    const [asc, desc] = await Promise.all([
        runner.kv<Record<string, unknown>>(collection, { ...one, sort: `${bucketField}:1` }),
        runner.kv<Record<string, unknown>>(collection, { ...one, sort: `${bucketField}:-1` }),
    ]);
    const pick = (r: ProbeResult): number | null => {
        const v = r.rows.length > 0 ? (r.rows[0] as Record<string, unknown>)[bucketField] : undefined;
        const n = typeof v === 'number' ? v : Number(v);
        return Number.isFinite(n) ? n : null;
    };
    return {
        oldest: pick(asc),
        newest: pick(desc),
        error: asc.error || desc.error,
        skipped: asc.skipped || desc.skipped,
    };
};

/** First numeric field of the first row — the shape every counting probe returns. */
export const firstNumber = (r: ProbeResult, field: string): number | null => {
    if (r.rows.length === 0) return null;
    const v = (r.rows[0] as Record<string, unknown>)[field];
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) ? n : null;
};
