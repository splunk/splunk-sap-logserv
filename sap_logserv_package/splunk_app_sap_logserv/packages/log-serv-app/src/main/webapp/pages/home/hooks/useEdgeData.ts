import { useMemo } from 'react';
import { useSearch } from './useSearch';
import {
    SEARCH_EDGE_OPERATIONS,
    SEARCH_EDGE_PERFORMANCE,
    SEARCH_EDGE_ERRORS,
} from '../topology/searches';
import { sanitizeEdgeIds } from '../topology/edgeIds';
import type { EdgeActivityPoint, TopologyEdge } from '../topology/types';

/**
 * useEdgeData — per-selected-edge SPL data for the right sidebar's 5-tab
 * Edge Details panel. Build 202 / session 036.
 *
 * Symmetric to useNodeData:
 *   - Overview     → derived from the cached topology data (no SPL)
 *   - Activity     → `edge.activity`, computed in-memory by useTopologyData
 *                    (build 321). No dispatch: the Overview tab renders this
 *                    series' totals directly beneath `callCount`, so they must
 *                    decompose it exactly - which holds only if both come from
 *                    the same rows over the same window.
 *   - Operations   → SEARCH_EDGE_OPERATIONS (top entity by edge type)
 *   - Performance  → SEARCH_EDGE_PERFORMANCE (per-type distribution)
 *                    NOTE: aggregated p50/p95/max numbers come straight from
 *                    the cached edge.responseTimeP* / hanaOpP95Ms fields with
 *                    no SPL dispatch — this search only powers the
 *                    distribution histogram below those numbers.
 *   - Errors       → SEARCH_EDGE_ERRORS (top failures by edge type)
 *
 * The three SPL reads fire only when `edge` is non-null, carries `splType`,
 * and carries a valid `bucketIds` set (the stored `logserv_topology_edges.id`
 * values behind the rendered edge - see topology/edgeIds.ts). When they do not
 * fire, `dispatched` is false and the right pane says so, rather than
 * asserting the absence of events it never looked for: from build 240 to 320
 * this hook passed the composite DISPLAY id to the builders, every read was
 * rejected, and all four tabs claimed "no events for this edge".
 */

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

/** Re-exported from topology/types so existing importers keep working; the
 *  series itself now rides on TopologyEdge (build 321). */
export type { EdgeActivityPoint };

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
    /** False when the three SPL reads were deliberately NOT dispatched (no
     *  splType, or no usable stored id set). Lets the UI distinguish "queried,
     *  found nothing" from "never queried" - the ambiguity that hid the
     *  build-240 regression for 80 builds. */
    dispatched: boolean;
    /** True when the rendered edge spans more stored edges than one read may
     *  splice (MAX_EDGE_IDS): the three tabs then cover `idsUsed` of
     *  `idsTotal`, and say so. */
    truncated: boolean;
    idsUsed: number;
    idsTotal: number;
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
    dispatched: false, truncated: false, idsUsed: 0, idsTotal: 0,
};

export const useEdgeData = (edge: TopologyEdge | null, refreshNonce = 0): UseEdgeDataResult => {
    /* Resolve SPL strings up front so all three useSearch calls execute on
     * every render regardless of whether they have valid args (React hook
     * rules require unconditional hook calls). The detail tabs read the hourly
     * KV-Store rollup scoped by the STORED edge ids (session 060 / build 240,
     * corrected in build 321), so we need splType (to pick the Performance
     * read variant) + `edge.bucketIds`. When the edge is null or either is
     * missing, each query resolves to null + enabled=false so useSearch is a
     * no-op -- and `dispatched` reports that, so the pane can say it.
     */
    const splType = edge?.splType ?? null;
    /* The STORED ids - never `edge.id`, which is the composite display key
     * (that substitution is exactly the build-240 bug). Sanitized once here
     * for the truncation counters; each builder re-sanitizes independently. */
    const selection = sanitizeEdgeIds(edge?.bucketIds);
    const edgeIds = selection ? selection.ids : [];
    const canQuery = splType != null && selection != null;

    const operationsQuery = canQuery
        ? SEARCH_EDGE_OPERATIONS(splType, edgeIds)
        : null;
    const operationsResult = useSearch<OperationsRow>({
        query: operationsQuery ?? '',
        enabled: !!operationsQuery,
        refreshNonce,
    });

    const performanceQuery = canQuery
        ? SEARCH_EDGE_PERFORMANCE(splType, edgeIds)
        : null;
    const performanceResult = useSearch<PerformanceRow>({
        query: performanceQuery ?? '',
        enabled: !!performanceQuery,
        refreshNonce,
    });

    const errorsQuery = canQuery
        ? SEARCH_EDGE_ERRORS(splType, edgeIds)
        : null;
    const errorsResult = useSearch<ErrorRow>({
        query: errorsQuery ?? '',
        enabled: !!errorsQuery,
        refreshNonce,
    });

    return useMemo<UseEdgeDataResult>(() => {
        if (!edge) return EMPTY;
        /* Activity rides on the edge itself, so it is available even when the
         * SPL reads cannot run - it is derived from the very rows that
         * produced the edge's headline totals. */
        const activity = Array.isArray(edge.activity) ? edge.activity : null;
        if (!canQuery) {
            return {
                ...EMPTY,
                activity,
                idsTotal: Array.isArray(edge.bucketIds) ? edge.bucketIds.length : 0,
            };
        }
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
            activityLoading: false,
            activityError: null,
            operations,
            operationsLoading: operationsResult.loading,
            operationsError: operationsResult.error,
            performance,
            performanceLoading: performanceResult.loading,
            performanceError: performanceResult.error,
            errors,
            errorsLoading: errorsResult.loading,
            errorsError: errorsResult.error,
            dispatched: true,
            truncated: selection ? selection.truncated : false,
            idsUsed: edgeIds.length,
            idsTotal: selection ? selection.requested : 0,
        };
    }, [edge, canQuery, edgeIds.length, selection,
        operationsResult.results, operationsResult.loading, operationsResult.error,
        performanceResult.results, performanceResult.loading, performanceResult.error,
        errorsResult.results, errorsResult.loading, errorsResult.error]);
};
