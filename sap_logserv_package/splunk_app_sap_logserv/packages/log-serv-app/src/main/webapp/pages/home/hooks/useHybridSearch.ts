import { useSearch, UseSearchOptions, UseSearchResult } from './useSearch';
import { useTimeRange } from '../state/TimeRangeProvider';
import { shouldUseRawSource } from '../utils/hybridRouting';

/**
 * Hybrid rollup/raw read routing (session 085).
 *
 * A panel converted to an hourly KV-Store rollup (the dashboard-perf refactor,
 * sessions 048-062) is fast on wide 7d/30d/90d ranges but wrong on sub-hour
 * ranges (the hourly `bucket_ts` grain reads empty or ~4x-overcounts a
 * sub-hour window). These helpers pick between the fast CACHED (rollup) query
 * and the always-correct RAW query based on the selected time range. See
 * `utils/hybridRouting.ts` for the routing rule + rationale.
 *
 * Contract: `cached` and `raw` MUST produce identical output columns so the
 * consuming viz never breaks when the route flips. (In practice each raw query
 * is the pre-refactor query, byte-verified equal to its rollup at wide windows.)
 */

/**
 * Resolve which of the two queries to dispatch for the current global range (or
 * an explicit range). Returns the query STRING, for consumers that run their own
 * search from a `query` prop (e.g. `<TimeSeriesChart>`, `<SparklineFromQuery>`).
 *
 * Reads the global TimeRangeProvider so it re-renders — and re-routes — whenever
 * the picker changes. Pass explicit `earliest`/`latest` only for a panel that
 * overrides the global range (rare).
 */
export const useRoutedQuery = (
    cached: string,
    raw: string,
    earliest?: string,
    latest?: string,
): string => {
    const { timeRange } = useTimeRange();
    const effEarliest = earliest ?? timeRange.earliest;
    const effLatest = latest ?? timeRange.latest;
    return shouldUseRawSource(effEarliest, effLatest) ? raw : cached;
};

export interface UseHybridSearchOptions extends Omit<UseSearchOptions, 'query'> {
    /** Fast rollup (KV-Store) query — used for wide ranges. */
    cached: string;
    /** Always-correct raw-index query — used for sub-hour / short ranges. Must
     *  return the same output columns as `cached`. */
    raw: string;
}

/**
 * Drop-in replacement for `useSearch` that routes between a cached (rollup) and
 * a raw query by time range. Same return shape as `useSearch`.
 */
export const useHybridSearch = <TRow = Record<string, unknown>>({
    cached,
    raw,
    earliest,
    latest,
    ...rest
}: UseHybridSearchOptions): UseSearchResult<TRow> => {
    const query = useRoutedQuery(cached, raw, earliest, latest);
    // Pass earliest/latest through so useSearch dispatches over the SAME
    // effective range the routing decision was made on.
    return useSearch<TRow>({ query, earliest, latest, ...rest });
};
