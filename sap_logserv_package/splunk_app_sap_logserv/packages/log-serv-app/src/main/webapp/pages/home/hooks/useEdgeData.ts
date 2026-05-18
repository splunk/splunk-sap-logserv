import { useMemo } from 'react';
import { useSearch } from './useSearch';
import {
    SEARCH_EDGE_ACTIVITY,
    SEARCH_EDGE_OPERATIONS,
    SEARCH_EDGE_PERFORMANCE,
    SEARCH_EDGE_ERRORS,
} from '../topology/searches';
import type { TopologyEdge } from '../topology/types';

/**
 * useEdgeData — per-selected-edge SPL data for the right sidebar's 5-tab
 * Edge Details panel. Build 202 / session 036.
 *
 * Symmetric to useNodeData. Each tab beyond Overview + Performance has a
 * corresponding SPL search:
 *   - Overview     → derived from the cached topology data (no extra SPL)
 *   - Activity     → SEARCH_EDGE_ACTIVITY (timechart count + error_count)
 *   - Operations   → SEARCH_EDGE_OPERATIONS (top entity by edge type)
 *   - Performance  → SEARCH_EDGE_PERFORMANCE (per-type distribution)
 *                    NOTE: aggregated p50/p95/max numbers come straight from
 *                    the cached edge.responseTimeP* / hanaOpP95Ms fields with
 *                    no SPL dispatch — this search only powers the
 *                    distribution histogram below those numbers.
 *   - Errors       → SEARCH_EDGE_ERRORS (top failures by edge type)
 *
 * The hook only fires SPL searches when `edge` is non-null. If `edge.splType`
 * or `edge.splFilterClauses` or `edge.splSourcetype` is missing (e.g. a
 * fixture-data edge from the prototype era), the searches return null and
 * the right pane renders an empty-state message.
 */

interface ActivityRow {
    _time: string;
    count: string | number;
    error_count: string | number;
}

interface OperationsRow {
    entity: string;
    count: string | number;
}

interface PerformanceRow {
    bucket_label: string;
    count: string | number;
}

interface ErrorRow {
    error_kind: string;
    error_detail: string;
    count: string | number;
    last_seen: string | number;
}

export interface EdgeActivityPoint {
    /** Epoch seconds of the bucket. */
    time: number;
    count: number;
    errorCount: number;
}

export interface EdgeOperationRow {
    entity: string;
    count: number;
}

export interface EdgePerformanceRow {
    bucketLabel: string;
    count: number;
}

export interface EdgeErrorRow {
    errorKind: string;
    errorDetail: string;
    count: number;
    /** Epoch seconds. */
    lastSeen: number;
}

export interface UseEdgeDataResult {
    activity: EdgeActivityPoint[] | null;
    activityLoading: boolean;
    activityError: Error | null;
    operations: EdgeOperationRow[] | null;
    operationsLoading: boolean;
    operationsError: Error | null;
    performance: EdgePerformanceRow[] | null;
    performanceLoading: boolean;
    performanceError: Error | null;
    errors: EdgeErrorRow[] | null;
    errorsLoading: boolean;
    errorsError: Error | null;
}

const num = (v: string | number | undefined): number => {
    if (typeof v === 'number') return v;
    if (typeof v === 'string') {
        const n = Number(v);
        return Number.isFinite(n) ? n : 0;
    }
    return 0;
};

const toEpoch = (v: string | number | undefined): number => {
    if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
    if (typeof v !== 'string' || !v) return 0;
    const asNum = Number(v);
    if (Number.isFinite(asNum) && asNum > 0) return asNum;
    const t = Date.parse(v);
    return Number.isFinite(t) ? Math.floor(t / 1000) : 0;
};

const EMPTY: UseEdgeDataResult = {
    activity: null, activityLoading: false, activityError: null,
    operations: null, operationsLoading: false, operationsError: null,
    performance: null, performanceLoading: false, performanceError: null,
    errors: null, errorsLoading: false, errorsError: null,
};

export const useEdgeData = (edge: TopologyEdge | null, refreshNonce = 0): UseEdgeDataResult => {
    /* Resolve SPL strings up front so all four useSearch calls execute on
     * every render regardless of whether they have valid args (React hook
     * rules require unconditional hook calls). When the edge is null or
     * the edge lacks splType/splFilterClauses/splSourcetype, each query
     * resolves to an empty string + enabled=false so useSearch is a no-op.
     */
    const splType = edge?.splType ?? null;
    const splSourcetype = edge?.splSourcetype ?? '';
    const clauses = edge?.splFilterClauses ?? [];
    const canQuery = splType != null && !!splSourcetype && clauses.length > 0;

    const activityQuery = canQuery
        ? SEARCH_EDGE_ACTIVITY(splType, splSourcetype, clauses)
        : null;
    const activityResult = useSearch<ActivityRow>({
        query: activityQuery ?? '',
        enabled: !!activityQuery,
        refreshNonce,
    });

    const operationsQuery = canQuery
        ? SEARCH_EDGE_OPERATIONS(splType, splSourcetype, clauses)
        : null;
    const operationsResult = useSearch<OperationsRow>({
        query: operationsQuery ?? '',
        enabled: !!operationsQuery,
        refreshNonce,
    });

    const performanceQuery = canQuery
        ? SEARCH_EDGE_PERFORMANCE(splType, splSourcetype, clauses)
        : null;
    const performanceResult = useSearch<PerformanceRow>({
        query: performanceQuery ?? '',
        enabled: !!performanceQuery,
        refreshNonce,
    });

    const errorsQuery = canQuery
        ? SEARCH_EDGE_ERRORS(splType, splSourcetype, clauses)
        : null;
    const errorsResult = useSearch<ErrorRow>({
        query: errorsQuery ?? '',
        enabled: !!errorsQuery,
        refreshNonce,
    });

    return useMemo<UseEdgeDataResult>(() => {
        if (!edge || !canQuery) return EMPTY;
        const activity = activityResult.results
            ? activityResult.results.map((r) => ({
                time: toEpoch(r._time),
                count: num(r.count),
                errorCount: num(r.error_count),
            }))
            : null;
        const operations = operationsResult.results
            ? operationsResult.results.map((r) => ({
                entity: r.entity,
                count: num(r.count),
            }))
            : null;
        const performance = performanceResult.results
            ? performanceResult.results.map((r) => ({
                bucketLabel: r.bucket_label,
                count: num(r.count),
            }))
            : null;
        const errors = errorsResult.results
            ? errorsResult.results.map((r) => ({
                errorKind: r.error_kind,
                errorDetail: r.error_detail,
                count: num(r.count),
                lastSeen: toEpoch(r.last_seen),
            }))
            : null;
        return {
            activity,
            activityLoading: activityResult.loading,
            activityError: activityResult.error,
            operations,
            operationsLoading: operationsResult.loading,
            operationsError: operationsResult.error,
            performance,
            performanceLoading: performanceResult.loading,
            performanceError: performanceResult.error,
            errors,
            errorsLoading: errorsResult.loading,
            errorsError: errorsResult.error,
        };
    }, [edge, canQuery,
        activityResult.results, activityResult.loading, activityResult.error,
        operationsResult.results, operationsResult.loading, operationsResult.error,
        performanceResult.results, performanceResult.loading, performanceResult.error,
        errorsResult.results, errorsResult.loading, errorsResult.error]);
};
