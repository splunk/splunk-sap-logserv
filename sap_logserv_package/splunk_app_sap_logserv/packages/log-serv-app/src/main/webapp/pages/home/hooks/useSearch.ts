import { useCallback, useEffect, useState } from 'react';
import SearchJob from '@splunk/search-job';
import { useTimeRange } from '../state/TimeRangeProvider';
import { useRefreshContext } from '../state/RefreshProvider';
import { useGlobalRefresh } from '../state/GlobalRefreshProvider';

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
    const [results, setResults] = useState<TRow[] | null>(null);
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

    useEffect(() => {
        if (!enabled || !query) {
            return undefined;
        }

        setLoading(true);
        setError(null);
        setSid(undefined);
        setDispatchedAt(Date.now());

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const search = (SearchJob as any).create({
            search: query,
            earliest_time: effectiveEarliest,
            latest_time: effectiveLatest,
        });

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
                setResults((data && data.results) || []);
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
    }, [query, effectiveEarliest, effectiveLatest, enabled, count, effectiveRefreshNonce]);

    return { results, loading, error, sid, spl: query, dispatchedAt, refresh };
};
