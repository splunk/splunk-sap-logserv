import { useCallback, useContext, useEffect, useRef, useState } from 'react';
import SearchJob from '@splunk/search-job';
import { username as splunkUsername } from '@splunk/splunk-utils/config';
import { useTimeRange } from '../state/TimeRangeProvider';
import { useRefreshContext } from '../state/RefreshProvider';
import { useGlobalRefresh } from '../state/GlobalRefreshProvider';
import { useDiagnosticCollector, nextSearchInstanceId } from '../state/DiagnosticCollector';
import { FilterKeyContext } from '../state/FilterKeyContext';
import { isFilterPending, isFilterUnavailable, rowsAreStale, RowsFor } from '../utils/queryFilters';
import { kvWindowNeedsClock, withKvWindow } from '../utils/kvWindow';
import { onServerClockSettled, serverClockSettled, serverNowSec, startServerClock } from '../utils/serverClock';

/** The app every panel search runs in (build 403): this App, whatever its sharing. */
const SEARCH_APP = 'splunk_app_sap_logserv';

export interface UseSearchOptions {
    query: string;
    earliest?: string;
    latest?: string;
    enabled?: boolean;
    /** Maximum result rows to fetch. Defaults to `0` ("all rows") so widgets
     *  never silently truncate data inside the selected time range. Pass a
     *  positive number to cap explicitly (rare — usually only needed for
     *  perf-sensitive previews). */
    count?: number;
    /** Bump from the parent to force a re-run with the same query/time range.
     *  Wired through useEffect deps so a value change re-subscribes to a fresh
     *  search job. Default 0 (never re-run on its own).
     *
     *  Build 155 / session 027: the effective re-run trigger is
     *  `refreshNonce + RefreshProvider.refreshNonce` (additive). The
     *  RefreshProvider context delivers the per-dashboard auto-refresh
     *  cadence the user picked from the title-row dropdown; the explicit
     *  prop is for callers that drive their own manual refresh (e.g.
     *  IntegrationTopology's manual Refresh button). Both contribute. */
    refreshNonce?: number;
}

export interface UseSearchResult<TRow = Record<string, unknown>> {
    results: TRow[] | null;
    loading: boolean;
    error: Error | null;
    /** Build 234 — panel-toolbar metadata. The dispatched job SID (resolves
     *  asynchronously via SearchJob.getSid(); undefined until the job is
     *  created). Powers the Inspect + Download actions. */
    sid?: string;
    /** The dispatched SPL string (the `query` passed in). Powers Open-in-Search. */
    spl: string;
    /** Epoch-ms when this search was last (re-)dispatched. Powers the
     *  "&lt;1m ago" last-run timestamp. */
    dispatchedAt?: number;
    /** Re-run just this search (bumps an internal nonce). Powers the per-panel
     *  Refresh action. Stable identity (useCallback). */
    refresh: () => void;
    /** Session 093 — the time window this search ACTUALLY ran over: the
     *  caller's explicit `earliest`/`latest` when supplied, otherwise the
     *  global TimeRangeProvider's. Computed here since forever and, until now,
     *  thrown away at the return — which meant no caller could report the
     *  window behind a "0 rows" result. It is NOT always the picker's current
     *  value: the topology right-pane hooks pin `-24h`/`now`. */
    effectiveEarliest: string;
    effectiveLatest: string;
    /** Row count, or null when no result has arrived yet (still loading, or
     *  never dispatched). Convenience for empty-state reasoning — the same
     *  value as `results?.length`. */
    rowCount: number | null;
    /** False when the hook was mounted but deliberately dispatched nothing
     *  (`enabled: false`, or an empty `query`).
     *
     *  This distinction is load-bearing and not otherwise recoverable: the
     *  dispatch effect returns EARLY in that case (before clearing `results`,
     *  `loading`, `error` and `sid`), so a hook that has been disabled can
     *  still be holding rows from a previous query — and `results === null`
     *  can equally mean "never dispatched" or "dispatched, nothing back yet".
     *  Live cases: HostDetails' host-inventory panel and the 8 topology hooks
     *  whenever the selection clears. */
    dispatched: boolean;
}

// Re-export the result type without a generic parameter for convenience —
// callers that don't care about row shape can `import { UseSearchResult }`
// and pass it through helpers like `<ConditionalPanel search={...}>`.

/**
 * Run a Splunk search inside a React component. Subscribes on mount and re-runs
 * whenever the query, explicit earliest/latest, or the global TimeRangeProvider's
 * range changes. Cancels the search and unsubscribes on unmount.
 */
export const useSearch = <TRow = Record<string, unknown>>({
    query,
    earliest,
    latest,
    enabled = true,
    count,
    refreshNonce = 0,
}: UseSearchOptions): UseSearchResult<TRow> => {
    const { timeRange } = useTimeRange();
    const { refreshNonce: contextNonce } = useRefreshContext();
    const { globalRefreshNonce } = useGlobalRefresh();
    // Session 093 — page-level diagnostic registry. Default is a no-op, so a
    // call site outside a DashboardLayout registers into the void.
    const { register } = useDiagnosticCollector();
    const instanceIdRef = useRef<string>('');
    if (!instanceIdRef.current) instanceIdRef.current = nextSearchInstanceId();
    const [results, setResults] = useState<TRow[] | null>(null);
    // Build 395 - what `results` was fetched under. See rowsAreStale.
    const filterKey = useContext(FilterKeyContext);
    const filterKeyRef = useRef(filterKey);
    filterKeyRef.current = filterKey;
    const [rowsFor, setRowsFor] = useState<RowsFor | null>(null);
    const [loading, setLoading] = useState<boolean>(false);
    const [error, setError] = useState<Error | null>(null);
    // Build 234 — panel-toolbar metadata.
    const [sid, setSid] = useState<string | undefined>(undefined);
    const [dispatchedAt, setDispatchedAt] = useState<number | undefined>(undefined);
    // Per-panel manual-refresh nonce (the Refresh action bumps this).
    const [localNonce, setLocalNonce] = useState(0);
    const refresh = useCallback(() => setLocalNonce((n) => n + 1), []);

    const effectiveEarliest = earliest ?? timeRange.earliest;
    const effectiveLatest = latest ?? timeRange.latest;
    /** Combined re-run trigger: explicit prop (manual refresh button etc.)
     *  + per-dashboard auto-refresh tick from the RefreshProvider context
     *  + this panel's own Refresh-action nonce (build 234)
     *  + the global nav-bar Refresh button nonce (session 088). */
    const effectiveRefreshNonce =
        (refreshNonce ?? 0) + contextNonce + localNonce + globalRefreshNonce;

    // Build 398 - a rollup read that takes the time bound (utils/kvWindow.ts) waits for the
    // server's clock, read once per page load: it answers, fails, or counts as no answer after
    // SERVER_CLOCK_TIMEOUT_MS. Run before it, the job would read every stored row of its metric
    // (the 397 audit's M5). Other queries never wait, and one that did not wait is not run
    // again when the clock answers: this flag only changes for a query that waited.
    const [, setClockTick] = useState(0);
    const waitsForClock = !!enabled && !!query && !serverClockSettled() && kvWindowNeedsClock(query, effectiveEarliest);
    useEffect(() => {
        if (!waitsForClock) return undefined;
        let live = true;
        startServerClock();
        onServerClockSettled(() => {
            if (live) setClockTick((n) => n + 1);
        });
        return () => {
            live = false;
        };
    }, [waitsForClock]);

    useEffect(() => {
        if (!enabled || !query) {
            return undefined;
        }

        // Build 395 - this query cannot honour the SID or Host filter. There is
        // nothing to dispatch: the panel is empty, its hint says why, and rows
        // from before the filter do not stay on screen looking filtered.
        const rowsKey: RowsFor = { query, filterKey: filterKeyRef.current };
        if (isFilterUnavailable(query)) {
            setResults([]);
            setRowsFor(rowsKey);
            setLoading(false);
            setError(null);
            setSid(undefined);
            setDispatchedAt(undefined);
            return undefined;
        }
        // Build 397 - the query is waiting on a check (see FILTER_PENDING_SPL). Rows
        // from before must not stay on screen, and `loading` stays up until the
        // rebuilt query takes over, so the panel never paints "No data" in between.
        if (isFilterPending(query)) {
            setResults(null);
            setRowsFor(rowsKey);
            setLoading(true);
            setError(null);
            setSid(undefined);
            setDispatchedAt(undefined);
            return undefined;
        }
        // Build 398 - waiting for the server's clock (waitsForClock above), the same way.
        if (waitsForClock) {
            setResults(null);
            setRowsFor(rowsKey);
            setLoading(true);
            setError(null);
            setSid(undefined);
            setDispatchedAt(undefined);
            return undefined;
        }

        setLoading(true);
        setError(null);
        setSid(undefined);
        setDispatchedAt(Date.now());

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const search = (SearchJob as any).create(
            {
                // Build 397 - the job reads only the rollup rows near its time range. The
                // panel's `spl`, and everything that reads it, keeps the query as written.
                search: withKvWindow(query, effectiveEarliest, serverNowSec()),
                earliest_time: effectiveEarliest,
                latest_time: effectiveLatest,
            },
            // Build 403 - dispatched in the LogServ App's namespace, as the signed-in user
            // (servicesNS/<user>/splunk_app_sap_logserv/search/jobs). Through /services/ (builds
            // up to 402) a job ran in the user's default app, which sees the App's macro, lookup
            // definitions and field extractions only while the App is shared to all apps: with
            // the App shared "App" only, its panels came back empty or 0 (a customer's report on
            // build 399, reproduced on the reference system).
            { app: SEARCH_APP, owner: splunkUsername || 'nobody' },
        );

        // Resolve the dispatched job SID (async Observable) for the panel
        // toolbar's Inspect + Download actions. Best-effort: failures are
        // swallowed — the data subscription below is independent.
        let sidSub: { unsubscribe: () => void } | undefined;
        try {
            sidSub = search.getSid().subscribe({
                next: (s: string) => setSid(s),
                error: () => undefined,
            });
        } catch (_e) {
            // getSid not available — toolbar falls back to Open-in-Search only
        }

        // Default to `count: 0` ("all rows") so no widget silently truncates
        // data inside the selected time range. Callers can override per-call
        // by passing an explicit `count`.
        const effectiveCount = typeof count === 'number' ? count : 0;
        const subscription = search.getResults({ count: effectiveCount }).subscribe({
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            next: (data: any) => {
                // In this order: rows with the old key read as stale for a moment,
                // and the reverse would draw old rows as current.
                setResults((data && data.results) || []);
                setRowsFor(rowsKey);
                setLoading(false);
            },
            error: (err: Error) => {
                setError(err);
                setLoading(false);
            },
        });

        return () => {
            try {
                subscription.unsubscribe();
            } catch (_e) {
                // ignore
            }
            try {
                if (sidSub) sidSub.unsubscribe();
            } catch (_e) {
                // ignore
            }
            try {
                search.cancel();
            } catch (_e) {
                // ignore
            }
        };
    }, [query, effectiveEarliest, effectiveLatest, enabled, count, effectiveRefreshNonce, waitsForClock]);

    // ----- diagnostic registration (session 093) ---------------------------
    // Declared AFTER the dispatch effect so it observes post-dispatch state on
    // every dep change (React runs effects in declaration order).
    //
    // Three constraints, all load-bearing:
    //  1. PRIMITIVE DEPS ONLY. The returned object literal is new every render
    //     and `results` is a new array on every streaming re-emit, so depending
    //     on either would re-fire this effect on every render of all 339 call
    //     sites. Mirrors `usePanelMetaReporter`, which deps on scalars for the
    //     same reason.
    //  2. `register` MUST be identity-stable — it is (`useCallback([])` inside
    //     the provider), and the no-op default is a module constant.
    //  3. Writing to the registry re-renders NOTHING (it is a ref-backed Map),
    //     so this effect is free at page scale.
    const stale = rowsAreStale(rowsFor, query, filterKey);
    const shownResults = stale ? null : results;
    const rowCount = shownResults ? shownResults.length : null;
    const errorMessage = error ? error.message || 'Search failed' : null;
    const dispatched = !!enabled && !!query && !isFilterUnavailable(query);
    // The first render after a filter change has no rows and has not started loading
    // yet: without this a panel paints "No data" for a frame.
    const shownLoading = loading || (stale && dispatched && !error);

    useEffect(() => {
        const id = instanceIdRef.current;
        register(id, {
            id,
            spl: query,
            sid,
            dispatchedAt,
            earliest: effectiveEarliest,
            latest: effectiveLatest,
            dispatched,
            loading: shownLoading,
            errorMessage,
            rowCount,
        });
        return () => register(id, null);
    }, [
        register,
        query,
        sid,
        dispatchedAt,
        effectiveEarliest,
        effectiveLatest,
        dispatched,
        shownLoading,
        errorMessage,
        rowCount,
    ]);

    return {
        results: shownResults,
        loading: shownLoading,
        error,
        sid,
        spl: query,
        dispatchedAt,
        refresh,
        effectiveEarliest,
        effectiveLatest,
        rowCount,
        dispatched,
    };
};
