import { useEffect, useMemo, useState } from 'react';
import { useTimeRange } from '../state/TimeRangeProvider';
import type {
    TopologyNode,
    TopologyEdge,
    ActivityRow,
    NodeKind,
    SystemTag,
    IntegrationType,
} from '../topology/types';
import { detectDbVendor } from '../topology/types';

/**
 * useTopologyData — KV Store-backed composite hook (session 035 / build 188).
 *
 * Replaces the on-demand 7-SPL composite hook from sessions 023-028
 * (builds 109-150). Now reads from two KV Store collections populated
 * by hourly scheduled searches:
 *
 *   logserv_topology_nodes — one row per (canonical entity, hourly bucket)
 *   logserv_topology_edges — one row per (edge, hourly bucket) with
 *                            pre-computed per-type aggregates and canonical
 *                            SPL filter clauses for session-036 drilldowns
 *
 * The view-side aggregator collapses per-bucket rows into per-entity display
 * rows by id, summing call_count / event_count / error_count and
 * weight-averaging percentile fields.
 *
 * Time-range responsiveness preserved: we resolve the global TimeRange's
 * earliest/latest to epoch seconds and filter `bucket_ts >= earliest_ts AND
 * bucket_ts <= latest_ts` server-side via the KV Store query operator.
 *
 * IP→SID inventory resolution: implemented via a third KV Store collection
 * (logserv_topology_inventory) populated hourly by the parallel scheduled
 * search logserv_topology_aggregate_inventory. The hook fetches all
 * inventory rows, builds an in-memory map from canonical_value (raw IP or
 * host) to resolved_sid, then retargets edge endpoints whose canonical
 * kind is 'ip' or 'host' to the corresponding SID node when the SID is
 * also present in the current time-range's node bucket data. Edges with
 * unresolvable endpoints stay rendered with raw IPs as a graceful
 * fallback. The retargeting may collide multiple raw-IP edges into a
 * single SID-SID edge — the call_count fields sum cleanly; the
 * canonical SPL filter clauses keep the FIRST edge's clauses (lossy on
 * underlying IP detail but acceptable for v1's right-pane drilldown).
 *
 * Failure modes:
 *   - KV Store empty (first install before backfill) → empty topology, isEmpty=true
 *   - KV Store stale (most-recent bucket > 6h old) → staleness.isStale=true
 *   - REST 5xx / network error → errors[] populated, partial data may render
 */

interface NodeBucketRow {
    _key: string;
    id: string;
    canonical_kind: 'sid' | 'ip' | 'host' | 'tenant_db';
    canonical_value: string;
    bucket_ts: number;
    kind: NodeKind;
    tag: SystemTag;
    label: string;
    event_count: number;
    last_seen: number;
}

interface EdgeBucketRow {
    _key: string;
    id: string;
    source_id: string;
    target_id: string;
    type: 'http' | 'rfc' | 'hana_audit' | 'hana_tenant';
    direction: 'client' | 'server' | 'bidi';
    bucket_ts: number;
    call_count: number;
    error_count: number;
    /** Build 224 / session 037 — first-class warning count from
     *  hana_tenant edges. Null for non-hana_tenant edge types. */
    warning_count?: number;
    response_time_p50?: number;
    response_time_p95?: number;
    response_time_max?: number;
    bytes_out_sum?: number;
    icm_tasks_max?: number;
    icm_tasks_avg?: number;
    hana_op_p95_ms?: number;
    hana_op_max_ms?: number;
    auth_success_count?: number;
    auth_fail_count?: number;
    spl_sourcetype: string;
    spl_filter_clauses: string;
}

interface InventoryRow {
    _key: string;
    canonical_value: string;
    canonical_kind: 'ip' | 'host';
    resolved_sid: string;
    updated_at: number;
}

export interface StaleNess {
    /** Most-recent bucket_ts in the dataset, in epoch seconds. */
    lastBucketTs: number;
    /** Hours since lastBucketTs. */
    ageHours: number;
    /** True if ageHours > 6 (the default threshold). */
    isStale: boolean;
}

export interface UseTopologyDataResult {
    nodes: TopologyNode[];
    edges: TopologyEdge[];
    activity: ActivityRow[];
    callsPerHour: number[];
    loading: boolean;
    errors: { search: string; message: string }[];
    inventoryStatus: { totalEndpoints: number; resolved: number };
    staleness?: StaleNess;
    isEmpty: boolean;
}

const APP = 'splunk_app_sap_logserv';
/* Splunk Web's REST proxy requires the `/en-US/splunkd/__raw/` prefix —
 * direct `/servicesNS/...` URLs hit Splunk Web's rewriter instead of the
 * REST endpoint and return 404. Same pattern as topology/persistence.ts
 * KV_BASE (build 120 / A.4). */
const KV_BASE = `/en-US/splunkd/__raw/servicesNS/nobody/${APP}/storage/collections/data`;
const STALENESS_THRESHOLD_HOURS = 6;

/**
 * Resolve a Splunk relative-time spec to absolute epoch seconds.
 *
 * Supports:
 *   - 'now' → current epoch
 *   - Pure number (epoch seconds) → returned as-is
 *   - Relative form `[+-]<num><unit>[@<snap_unit>]` where unit is one of
 *     `s|m|h|d|w|M|y` (seconds/minutes/hours/days/weeks/months/years).
 *     Snap unit floors to the start of that unit (e.g. `-30d@d` → 30 days
 *     ago snapped to start of day).
 *
 * Limitations:
 *   - Treats months as 30 days and years as 365 days (Splunk's actual
 *     calendar arithmetic is more nuanced; close enough for bucket-range
 *     filtering).
 *   - Snap is UTC-based; user's locale isn't honored.
 *
 * If the spec doesn't match any pattern, falls back to `now` and logs to
 * console (defensive — never throw).
 */
const resolveTimeSpec = (spec: string, now: number = Math.floor(Date.now() / 1000)): number => {
    if (!spec || spec === 'now') return now;
    const numeric = Number(spec);
    if (Number.isFinite(numeric) && numeric > 0) return numeric;

    const match = spec.match(/^([+-]?\d+)([smhdwMy])(?:@([smhdwMy]))?$/);
    if (!match) {
        // eslint-disable-next-line no-console
        console.warn(`useTopologyData: unrecognized time spec "${spec}", falling back to now`);
        return now;
    }
    const offset = parseInt(match[1], 10);
    const unit = match[2];
    const snap = match[3];
    const unitSecs: Record<string, number> = {
        s: 1, m: 60, h: 3600, d: 86400, w: 604800,
        M: 86400 * 30, y: 86400 * 365,
    };
    const base = now + offset * (unitSecs[unit] ?? 1);
    if (snap) {
        const snapSecs = unitSecs[snap] ?? 1;
        return Math.floor(base / snapSecs) * snapSecs;
    }
    return base;
};

/**
 * Fetch all rows from a KV Store collection where bucket_ts is within the
 * given range. Returns the parsed JSON array directly. Throws on HTTP error
 * so the caller can populate the errors[] state.
 */
const fetchKvBucketRows = async <T>(
    collection: string,
    earliest_ts: number,
    latest_ts: number,
): Promise<T[]> => {
    const query = JSON.stringify({
        bucket_ts: { $gte: earliest_ts, $lte: latest_ts },
    });
    /* limit=0 means "no limit" in Splunk's collection REST API. Default is
     * 30,000 rows. For a 30-day window with ~50 nodes × 24 buckets/day = 36k
     * node rows, the default limit is JUST over our worst case — explicitly
     * set limit=0 so we don't truncate. */
    const url = `${KV_BASE}/${collection}?query=${encodeURIComponent(query)}&limit=0&output_mode=json`;
    const res = await fetch(url, { credentials: 'same-origin' });
    if (!res.ok) {
        throw new Error(`KV Store fetch failed: ${res.status} ${res.statusText}`);
    }
    return res.json();
};

/**
 * Fetch all rows from a flat (non-bucketed) KV Store collection. Used for
 * the inventory collection which has no bucket_ts dimension.
 */
const fetchKvAllRows = async <T>(collection: string): Promise<T[]> => {
    const url = `${KV_BASE}/${collection}?limit=0&output_mode=json`;
    const res = await fetch(url, { credentials: 'same-origin' });
    if (!res.ok) {
        throw new Error(`KV Store fetch failed: ${res.status} ${res.statusText}`);
    }
    return res.json();
};

/**
 * Map SPL-emitted edge type (rfc/http/hana_audit/hana_tenant) onto the
 * legacy IntegrationType enum used by the visual layer. The SPL type is
 * preserved in `splType` for session-036's right-pane tabs.
 */
const splTypeToIntegrationType = (splType: EdgeBucketRow['type']): IntegrationType => {
    switch (splType) {
        case 'http': return 'web_service';
        case 'rfc': return 'rfc';
        case 'hana_audit': return 'web_service';
        case 'hana_tenant': return 'rfc';
        default: return 'rfc';
    }
};

/**
 * Parse the canonical SPL filter clauses from the edge row's denormalized
 * JSON string. Defensive — returns empty array on parse error.
 */
const parseFilterClauses = (raw: string | undefined): { field: string; value: string }[] => {
    if (!raw) return [];
    try {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed
            .filter((c): c is { field: string; value: string } =>
                c && typeof c.field === 'string' && typeof c.value === 'string',
            );
    } catch {
        return [];
    }
};

/** Top-2 sources by outbound call volume become focused. Preserves the
 *  existing build-109 visual convention. */
const computeFocusedNodeIds = (edges: TopologyEdge[]): Set<string> => {
    const totals = new Map<string, number>();
    edges.forEach((e) => {
        if (e.direction === 'client' || e.direction === 'bidi') {
            totals.set(e.source, (totals.get(e.source) ?? 0) + e.callCount);
        }
    });
    const sorted = Array.from(totals.entries()).sort((a, b) => b[1] - a[1]);
    return new Set(sorted.slice(0, 2).map(([id]) => id));
};

export const useTopologyData = (refreshNonce = 0): UseTopologyDataResult => {
    const { timeRange } = useTimeRange();
    const [nodeRows, setNodeRows] = useState<NodeBucketRow[]>([]);
    const [edgeRows, setEdgeRows] = useState<EdgeBucketRow[]>([]);
    const [inventoryRows, setInventoryRows] = useState<InventoryRow[]>([]);
    const [loading, setLoading] = useState<boolean>(true);
    const [errors, setErrors] = useState<{ search: string; message: string }[]>([]);

    useEffect(() => {
        let cancelled = false;
        setLoading(true);
        setErrors([]);
        const earliest_ts = resolveTimeSpec(timeRange.earliest);
        const latest_ts = resolveTimeSpec(timeRange.latest);

        const fetchBucketed = async <T>(collection: string, label: string): Promise<T[]> => {
            try {
                return await fetchKvBucketRows<T>(collection, earliest_ts, latest_ts);
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                if (!cancelled) {
                    setErrors((prev) => [...prev, { search: label, message }]);
                }
                return [];
            }
        };

        const fetchFlat = async <T>(collection: string, label: string): Promise<T[]> => {
            try {
                return await fetchKvAllRows<T>(collection);
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                if (!cancelled) {
                    setErrors((prev) => [...prev, { search: label, message }]);
                }
                return [];
            }
        };

        (async () => {
            const [nodes, edges, inventory] = await Promise.all([
                fetchBucketed<NodeBucketRow>('logserv_topology_nodes', 'topology_nodes'),
                fetchBucketed<EdgeBucketRow>('logserv_topology_edges', 'topology_edges'),
                fetchFlat<InventoryRow>('logserv_topology_inventory', 'topology_inventory'),
            ]);
            if (cancelled) return;
            setNodeRows(nodes);
            setEdgeRows(edges);
            setInventoryRows(inventory);
            setLoading(false);
        })();

        return () => {
            cancelled = true;
        };
    }, [timeRange.earliest, timeRange.latest, refreshNonce]);

    return useMemo<UseTopologyDataResult>(() => {
        // ---- Build inventory IP/host -> resolved-SID-node-id map ----
        // Two pieces are needed: (a) the canonical_value -> resolved_sid map
        // from the inventory collection, and (b) a resolved_sid -> node_id
        // reverse map built from the node bucket rows where canonical_kind
        // is 'sid'. The retarget step uses (a) to find the SID a raw IP/host
        // belongs to, then (b) to translate that SID into the node id we
        // should retarget the edge to.
        //
        // If the SID isn't present as a node in the current time-range's
        // bucket data (e.g. that SID was idle this window), retargeting
        // can't proceed for that endpoint and the raw IP/host node renders
        // as a fallback.
        const inventoryByValue = new Map<string, string>(); // canonical_value -> resolved_sid
        inventoryRows.forEach((row) => {
            if (row.canonical_value && row.resolved_sid) {
                inventoryByValue.set(row.canonical_value, row.resolved_sid);
            }
        });

        // canonical_value -> node_id (any kind), built from node rows
        const valueToNodeId = new Map<string, string>();
        // resolved_sid -> sid_node_id, built from node rows where kind=='sid'
        const sidToNodeId = new Map<string, string>();
        // node_id -> {kind, value}, used during retargeting to determine
        // whether a given target_id corresponds to an ip/host
        const nodeIdToCanonical = new Map<string, { kind: string; value: string }>();
        nodeRows.forEach((row) => {
            if (!row.id) return;
            valueToNodeId.set(row.canonical_value, row.id);
            if (row.canonical_kind === 'sid') {
                sidToNodeId.set(row.canonical_value, row.id);
            }
            // Last-write-wins for nodeIdToCanonical; multiple buckets share
            // the same id + canonical so this is correct.
            nodeIdToCanonical.set(row.id, {
                kind: row.canonical_kind,
                value: row.canonical_value,
            });
        });

        // Synthetic SID nodes (Fix A — build 193): collect SIDs from two
        // sources that the aggregate-NODES SPL doesn't capture as proper
        // SID node rows:
        //
        //   1. Inventory's resolved_sid column — IPs that map to SIDs whose
        //      gateway events lack local_ip + sap_sid (so they didn't trip
        //      the aggregate-NODES filter).
        //   2. Edge spl_filter_clauses with field = sap_sid or
        //      hana_tenant_sid — RFC + HANA Tenant edges where the SID is
        //      the canonical source/target. The pre-KV-Store path used a
        //      `^[A-Z0-9]{3}$` regex on edge endpoint strings to surface
        //      these; the new architecture has SHA1[:16] hashes instead, so
        //      we have to extract the SID name from the canonical filter
        //      clauses we denormalized onto the edge bucket row.
        //
        // Without these, retargeting can't promote those SIDs into the
        // topology — they'd render as raw peer IPs forever even though we
        // KNOW from inventory + edge clauses which SID owns each. Restores
        // parity with the pre-KV-Store on-demand path which surfaced ~10
        // SIDs on the xsd-vlab dataset (vs 2 with bucket data alone).
        //
        // Synthetic node ids start with `__synth_sid:` so they can't collide
        // with real SHA1[:16] hex strings, and they're deterministic so a
        // saved layout pinning to one stays valid across reloads.
        const syntheticSidNodeIds = new Map<string, string>(); // synth id -> SID name

        const registerSyntheticSid = (sid: string): void => {
            if (!sid || sidToNodeId.has(sid)) return;
            const synthId = `__synth_sid:${sid}`;
            sidToNodeId.set(sid, synthId);
            syntheticSidNodeIds.set(synthId, sid);
            nodeIdToCanonical.set(synthId, { kind: 'sid', value: sid });
        };

        // Source 1: inventory resolved_sid values
        inventoryRows.forEach((row) => {
            if (row.resolved_sid) registerSyntheticSid(row.resolved_sid);
        });

        // Source 2: edge spl_filter_clauses with field = sap_sid OR
        // hana_tenant_sid. Both are SID-typed values. tenant_sid edges put
        // the tenant DB SID as target (e.g., XCQ tenant on XHQ system) — we
        // want both sides to be SID nodes for proper graph rendering.
        //
        // Plus: opportunistically backfill nodeIdToCanonical for ANY edge
        // endpoint that doesn't have a real node bucket row, using the
        // edge's spl_filter_clauses to recover (kind, value). This makes
        // retarget() able to dispatch on kind without needing a node row to
        // exist — critical for catching SIDs whose gateway events lack
        // local_ip and so were skipped by the aggregate-NODES SPL.
        const clauseFieldToKind = (
            field: string,
        ): 'sid' | 'ip' | 'host' | 'tenant_db' | null => {
            if (field === 'sap_sid') return 'sid';
            if (field === 'hana_tenant_sid') return 'tenant_db';
            if (field === 'clientip' || field === 'client_ip'
                || field === 'peer_ip' || field === 'local_ip') return 'ip';
            if (field === 'host' || field === 'hana_host') return 'host';
            return null;
        };

        edgeRows.forEach((row) => {
            const clauses = parseFilterClauses(row.spl_filter_clauses);
            clauses.forEach((c, idx) => {
                if (c.field === 'sap_sid' || c.field === 'hana_tenant_sid') {
                    registerSyntheticSid(c.value);
                }
                /* Recover canonical (kind, value) for the edge's endpoint
                 * when the corresponding node bucket row is missing.
                 * clauses[0] = source endpoint, clauses[1] = target. */
                const endpointId = idx === 0 ? row.source_id
                    : idx === 1 ? row.target_id : null;
                if (!endpointId || nodeIdToCanonical.has(endpointId)) return;
                const kind = clauseFieldToKind(c.field);
                if (kind) {
                    nodeIdToCanonical.set(endpointId, { kind, value: c.value });
                }
            });
        });

        /**
         * Given a node id from an edge endpoint, return the retargeted node
         * id. Three cases:
         *
         *   - Endpoint is a SID (kind='sid'): retarget to the SID's
         *     canonical node id (real bucket id if it exists, synthetic
         *     `__synth_sid:` id otherwise). This catches RFC + HANA Tenant
         *     edges whose source_id is the SHA1 of "sid:X" but whose SID
         *     wasn't captured by the aggregate-NODES SPL — Fix A (build 193).
         *   - Endpoint is IP/host (kind='ip' or 'host'): if inventory
         *     resolves it to a SID AND that SID has a node, retarget to the
         *     SID node. Otherwise stay raw.
         *   - Endpoint is tenant_db: stay raw — those render as DB cylinder
         *     nodes per the topology view's rules.
         */
        const retarget = (nodeId: string): string => {
            const canonical = nodeIdToCanonical.get(nodeId);
            if (!canonical) return nodeId;
            if (canonical.kind === 'sid') {
                return sidToNodeId.get(canonical.value) ?? nodeId;
            }
            if (canonical.kind === 'tenant_db') return nodeId;
            if (canonical.kind === 'ip' || canonical.kind === 'host') {
                const resolvedSid = inventoryByValue.get(canonical.value);
                if (!resolvedSid) return nodeId;
                return sidToNodeId.get(resolvedSid) ?? nodeId;
            }
            return nodeId;
        };

        // ---- Aggregate edges by (retargeted source, retargeted target, type) ----
        // Apply inventory retargeting BEFORE aggregation so multiple raw-IP
        // edges that resolve to the same SID-SID pair collapse into one edge.
        // Group key is "<retargetedSource>::<retargetedTarget>::<type>" — stable
        // across renders for the same logical edge regardless of which buckets
        // are in scope. The row's own SPL-derived `id` is retained on the
        // first row of each group for session-036 right-pane drilldowns.
        const edgeMap = new Map<string, {
            row: EdgeBucketRow;
            retargetedSource: string;
            retargetedTarget: string;
            displayId: string;
            callCountTotal: number;
            errorCountTotal: number;
            warningCountTotal: number;
            responseTimeP95WeightedSum: number;
            responseTimeP95Weight: number;
            responseTimeP50WeightedSum: number;
            responseTimeP50Weight: number;
            responseTimeMaxAcc: number;
            bytesOutSumAcc: number;
            icmTasksMaxAcc: number;
            icmTasksAvgWeightedSum: number;
            icmTasksAvgWeight: number;
            hanaOpP95WeightedSum: number;
            hanaOpP95Weight: number;
            hanaOpMaxAcc: number;
            authSuccessTotal: number;
            authFailTotal: number;
        }>();
        edgeRows.forEach((row) => {
            const w = row.call_count > 0 ? row.call_count : 0;
            const retargetedSource = retarget(row.source_id);
            const retargetedTarget = retarget(row.target_id);
            const groupKey = `${retargetedSource}::${retargetedTarget}::${row.type}`;
            const existing = edgeMap.get(groupKey);
            if (!existing) {
                edgeMap.set(groupKey, {
                    row,
                    retargetedSource,
                    retargetedTarget,
                    displayId: groupKey,
                    callCountTotal: row.call_count,
                    errorCountTotal: row.error_count ?? 0,
                    warningCountTotal: row.warning_count ?? 0,
                    responseTimeP95WeightedSum: (row.response_time_p95 ?? 0) * w,
                    responseTimeP95Weight: row.response_time_p95 != null ? w : 0,
                    responseTimeP50WeightedSum: (row.response_time_p50 ?? 0) * w,
                    responseTimeP50Weight: row.response_time_p50 != null ? w : 0,
                    responseTimeMaxAcc: row.response_time_max ?? 0,
                    bytesOutSumAcc: row.bytes_out_sum ?? 0,
                    icmTasksMaxAcc: row.icm_tasks_max ?? 0,
                    icmTasksAvgWeightedSum: (row.icm_tasks_avg ?? 0) * w,
                    icmTasksAvgWeight: row.icm_tasks_avg != null ? w : 0,
                    hanaOpP95WeightedSum: (row.hana_op_p95_ms ?? 0) * w,
                    hanaOpP95Weight: row.hana_op_p95_ms != null ? w : 0,
                    hanaOpMaxAcc: row.hana_op_max_ms ?? 0,
                    authSuccessTotal: row.auth_success_count ?? 0,
                    authFailTotal: row.auth_fail_count ?? 0,
                });
            } else {
                existing.callCountTotal += row.call_count;
                existing.errorCountTotal += row.error_count ?? 0;
                existing.warningCountTotal += row.warning_count ?? 0;
                if (row.response_time_p95 != null) {
                    existing.responseTimeP95WeightedSum += row.response_time_p95 * w;
                    existing.responseTimeP95Weight += w;
                }
                if (row.response_time_p50 != null) {
                    existing.responseTimeP50WeightedSum += row.response_time_p50 * w;
                    existing.responseTimeP50Weight += w;
                }
                if (row.response_time_max != null) {
                    existing.responseTimeMaxAcc = Math.max(existing.responseTimeMaxAcc, row.response_time_max);
                }
                if (row.bytes_out_sum != null) {
                    existing.bytesOutSumAcc += row.bytes_out_sum;
                }
                if (row.icm_tasks_max != null) {
                    existing.icmTasksMaxAcc = Math.max(existing.icmTasksMaxAcc, row.icm_tasks_max);
                }
                if (row.icm_tasks_avg != null) {
                    existing.icmTasksAvgWeightedSum += row.icm_tasks_avg * w;
                    existing.icmTasksAvgWeight += w;
                }
                if (row.hana_op_p95_ms != null) {
                    existing.hanaOpP95WeightedSum += row.hana_op_p95_ms * w;
                    existing.hanaOpP95Weight += w;
                }
                if (row.hana_op_max_ms != null) {
                    existing.hanaOpMaxAcc = Math.max(existing.hanaOpMaxAcc, row.hana_op_max_ms);
                }
                existing.authSuccessTotal += row.auth_success_count ?? 0;
                existing.authFailTotal += row.auth_fail_count ?? 0;
            }
        });

        const edges: TopologyEdge[] = Array.from(edgeMap.values())
            // Drop self-loops AFTER retargeting — an IP-target edge that
            // retargets to its own source SID becomes a self-loop and gets
            // filtered here (e.g. RFC edge XCP -> 10.x.y.z where the IP is
            // also XCP's own local_ip).
            .filter((agg) => agg.retargetedSource !== agg.retargetedTarget)
            .map((agg) => ({
                id: agg.displayId,
                source: agg.retargetedSource,
                target: agg.retargetedTarget,
                type: splTypeToIntegrationType(agg.row.type),
                direction: agg.row.direction,
                callCount: agg.callCountTotal,
                splType: agg.row.type,
                splFilterClauses: parseFilterClauses(agg.row.spl_filter_clauses),
                splSourcetype: agg.row.spl_sourcetype,
                errorCount: agg.errorCountTotal,
                warningCount: agg.warningCountTotal > 0 ? agg.warningCountTotal : undefined,
                responseTimeP50: agg.responseTimeP50Weight > 0
                    ? agg.responseTimeP50WeightedSum / agg.responseTimeP50Weight
                    : undefined,
                responseTimeP95: agg.responseTimeP95Weight > 0
                    ? agg.responseTimeP95WeightedSum / agg.responseTimeP95Weight
                    : undefined,
                responseTimeMax: agg.responseTimeMaxAcc > 0 ? agg.responseTimeMaxAcc : undefined,
                bytesOutSum: agg.bytesOutSumAcc > 0 ? agg.bytesOutSumAcc : undefined,
                icmTasksMax: agg.icmTasksMaxAcc > 0 ? agg.icmTasksMaxAcc : undefined,
                icmTasksAvg: agg.icmTasksAvgWeight > 0
                    ? agg.icmTasksAvgWeightedSum / agg.icmTasksAvgWeight
                    : undefined,
                hanaOpP95Ms: agg.hanaOpP95Weight > 0
                    ? agg.hanaOpP95WeightedSum / agg.hanaOpP95Weight
                    : undefined,
                hanaOpMaxMs: agg.hanaOpMaxAcc > 0 ? agg.hanaOpMaxAcc : undefined,
                authSuccessCount: agg.authSuccessTotal || undefined,
                authFailCount: agg.authFailTotal || undefined,
            }));

        // ---- Aggregate nodes by id (sum event_count, max last_seen) ----
        // Only include nodes referenced by at least one edge; otherwise the
        // canvas fills with detached partner nodes (one per ip seen as a
        // peer_ip in any sourcetype). The render layer only shows edges
        // anyway, so orphan nodes are visual noise.
        const referencedNodeIds = new Set<string>();
        edges.forEach((e) => {
            referencedNodeIds.add(e.source);
            referencedNodeIds.add(e.target);
        });

        const nodeAggMap = new Map<string, {
            row: NodeBucketRow;
            eventCountTotal: number;
            lastSeenMax: number;
        }>();
        nodeRows.forEach((row) => {
            if (!referencedNodeIds.has(row.id)) return;
            const existing = nodeAggMap.get(row.id);
            if (!existing) {
                nodeAggMap.set(row.id, {
                    row,
                    eventCountTotal: row.event_count,
                    lastSeenMax: row.last_seen,
                });
            } else {
                existing.eventCountTotal += row.event_count;
                existing.lastSeenMax = Math.max(existing.lastSeenMax, row.last_seen);
            }
        });

        // Some edges reference node ids that aren't in the nodes collection
        // (e.g., HTTP clientips: edges row captures every distinct clientip
        // but the aggregate-NODES SPL only indexes inventory-bearing IPs).
        // Synthesize partner nodes for them with a label derived from the
        // edge's canonical SPL filter clauses (clauses[0] = source value,
        // clauses[1] = target value across all 4 edge types).
        const idLabelHints = new Map<string, string>();
        edgeRows.forEach((row) => {
            const clauses = parseFilterClauses(row.spl_filter_clauses);
            if (clauses.length >= 1 && row.source_id && !idLabelHints.has(row.source_id)) {
                idLabelHints.set(row.source_id, clauses[0].value);
            }
            if (clauses.length >= 2 && row.target_id && !idLabelHints.has(row.target_id)) {
                idLabelHints.set(row.target_id, clauses[1].value);
            }
        });

        // Tag heuristic for synthetic SID nodes (no bucket data → must derive
        // tag from name). Mirrors the build-113 SID-prefix logic.
        // Build 211 / session 036 — XH* and XCJ get 'HANA' (was 'DB');
        // ABAP SIDs (`XC*` other) get ECC; rest get ABAP fallback. The
        // `XCJ` carve-out is because XCJ is the data-derived HANA system
        // in the xsd-vlab dataset (per session 023 build 114 knownHanaSystems).
        const tagForSyntheticSid = (sid: string): SystemTag => {
            if (sid.startsWith('XH') || sid === 'XCJ') return 'HANA';
            if (sid.startsWith('XC')) return 'ECC';
            if (sid.startsWith('BTP') || sid.startsWith('CPI')) return 'BTP';
            return 'ABAP';
        };

        const synthesizedNodes: TopologyNode[] = [];
        referencedNodeIds.forEach((id) => {
            if (nodeAggMap.has(id)) return;
            const synthSid = syntheticSidNodeIds.get(id);
            if (synthSid) {
                // Synthetic SID node: surfaces the SID in the topology even
                // though it had no direct gateway events in the time window.
                synthesizedNodes.push({
                    id,
                    label: synthSid,
                    kind: 'sid_secondary',
                    tag: tagForSyntheticSid(synthSid),
                    eventCount: 0,
                });
            } else {
                synthesizedNodes.push({
                    id,
                    label: idLabelHints.get(id) ?? id,
                    kind: 'partner',
                    tag: 'EXT',
                    eventCount: 0,
                });
            }
        });

        // Compute focused node ids from edge volumes (top-2 by outbound call_count).
        const focusedIds = computeFocusedNodeIds(edges);

        /* Build 213 / session 036 — derive `knownHanaSystems` from edge
         * data. The KEY DISTINCTION (build 213 fix): in a `hana_tenant`
         * edge, `field=sap_sid` is the HANA SYSTEM (the database engine
         * — e.g. XHQ, XHX, XHD, XCJ); `field=hana_tenant_sid` is the
         * TENANT (a logical database INSIDE that HANA system, named for
         * the SAP APPLICATION SID it serves — e.g. XCQ, XCP). Tenants
         * share names with the application SIDs they back, but they're
         * NOT HANA systems themselves — they're applications using HANA.
         *
         * Build 211 incorrectly added BOTH field types to knownHanaSystems,
         * which mistagged ECC application SIDs (XCP, XCQ, XCS, XCD)
         * as HANA. Build 213 fix: only add field=sap_sid values. */
        const knownHanaSystems = new Set<string>();
        edgeRows.forEach((row) => {
            if (row.type !== 'hana_tenant') return;
            const clauses = parseFilterClauses(row.spl_filter_clauses);
            clauses.forEach((c) => {
                if (c.field === 'sap_sid' && c.value) knownHanaSystems.add(c.value);
                /* Intentionally NOT adding hana_tenant_sid — those are
                 * application SIDs, classified by the SPL aggregator
                 * with their actual application tag (ECC / S4 / etc). */
            });
        });

        /* Build 211 / session 036 — refine tags for DB-vendor specificity.
         * The SPL aggregation in `logserv_topology_aggregate_nodes` emits
         * the generic 'DB' tag; override here with vendor-specific tags
         * when we have evidence:
         *   - SID node whose label is in knownHanaSystems → 'HANA'
         *   - Partner node with label matching a vendor pattern → that vendor
         *   - Otherwise: keep the SPL-emitted tag.
         * Preserves the data-derived classification authority over the
         * heuristic SID-prefix logic in `tagForSyntheticSid`. */
        const refineTag = (label: string, defaultTag: SystemTag): SystemTag => {
            if (knownHanaSystems.has(label)) return 'HANA';
            const vendor = detectDbVendor(label);
            if (vendor) return vendor;
            return defaultTag;
        };

        const aggregatedNodes: TopologyNode[] = Array.from(nodeAggMap.values()).map((agg) => {
            /* Build 224 / session 037 — only promote a node to `sid_focused`
             * if the SPL has already classified it as some kind of SID
             * (`sid_focused` or `sid_secondary`). Without this guard, a
             * high-volume partner IP (e.g. a webdispatcher clientip whose
             * outbound calls outpace XCP's) would get promoted to focused
             * because computeFocusedNodeIds picks top-2 sources by call
             * volume regardless of node kind. This bug was latent until
             * Path C added webdispatcher clientip / gateway peer_ip /
             * hana:audit client_ip as nodeAggMap entries — pre-Path-C
             * those IPs were synthesized partners and skipped this path. */
            const isSid = agg.row.kind === 'sid_focused' || agg.row.kind === 'sid_secondary';
            const baseKind: NodeKind = isSid && focusedIds.has(agg.row.id)
                ? 'sid_focused'
                : agg.row.kind;
            return {
                id: agg.row.id,
                label: agg.row.label,
                kind: baseKind,
                tag: refineTag(agg.row.label, agg.row.tag),
                eventCount: agg.eventCountTotal,
            };
        });

        /* Apply the same vendor refinement to synthesized nodes. The
         * synthetic SID branch already returns 'HANA' for XH-prefix
         * SIDs and XCJ via tagForSyntheticSid, but refineTag provides
         * a uniform pass for both real-bucket and synthesized nodes. */
        const refinedSynthesizedNodes = synthesizedNodes.map((n) => ({
            ...n,
            tag: refineTag(n.label, n.tag),
        }));

        const nodes: TopologyNode[] = [...aggregatedNodes, ...refinedSynthesizedNodes];

        // ---- Activity table: top 8 edges by callCount, projected to ActivityRow ----
        // Resolve node ids back to their human-readable canonical_value for
        // display. After the v5 schema bump, edge endpoints are SHA1[:16]
        // hashes (good for stability, opaque for users); the bottom Live
        // Activity table needs the underlying IP / hostname / SID string.
        // Three-tier fallback: nodeIdToCanonical (full canonical metadata
        // from a node bucket row) → idLabelHints (canonical_value extracted
        // from the edge's SPL filter clauses) → raw id (last resort).
        const labelForId = (id: string): string => {
            const canonical = nodeIdToCanonical.get(id);
            if (canonical) return canonical.value;
            const hint = idLabelHints.get(id);
            return hint ?? id;
        };
        const activity: ActivityRow[] = edges
            .slice()
            .sort((a, b) => b.callCount - a.callCount)
            .slice(0, 8)
            .map((e, i) => ({
                id: `a-${i}`,
                sourceSid: labelForId(e.source),
                direction: e.direction === 'bidi' ? 'client' : e.direction,
                partner: labelForId(e.target),
                callCount: e.callCount,
            }));

        // ---- Calls per hour: derived from edge bucket_ts distribution ----
        // Sum call_count per bucket_ts, then output the last 24 buckets'
        // values in chronological order. If there are fewer than 24 buckets
        // in the window, the array is shorter.
        const callsByBucket = new Map<number, number>();
        edgeRows.forEach((row) => {
            callsByBucket.set(row.bucket_ts, (callsByBucket.get(row.bucket_ts) ?? 0) + row.call_count);
        });
        const sortedBuckets = Array.from(callsByBucket.keys()).sort((a, b) => a - b);
        const callsPerHour = sortedBuckets.slice(-24).map((ts) => callsByBucket.get(ts) ?? 0);

        // ---- Staleness check ----
        let staleness: StaleNess | undefined;
        if (sortedBuckets.length > 0) {
            const lastBucketTs = sortedBuckets[sortedBuckets.length - 1];
            const ageHours = Math.max(0, (Math.floor(Date.now() / 1000) - lastBucketTs) / 3600);
            staleness = {
                lastBucketTs,
                ageHours,
                isStale: ageHours > STALENESS_THRESHOLD_HOURS,
            };
        }

        const isEmpty = nodes.length === 0 && edges.length === 0;

        // Inventory status diagnostic: count endpoints (sources + targets across
        // all edges) and how many resolved to a SID or tenant_db node. After
        // retargeting, edge endpoints reference the SID node id whenever the
        // raw IP/host had an unambiguous SID mapping in the inventory.
        let totalEndpoints = 0;
        let resolved = 0;
        edges.forEach((e) => {
            [e.source, e.target].forEach((id) => {
                totalEndpoints += 1;
                const canonical = nodeIdToCanonical.get(id);
                if (canonical && (canonical.kind === 'sid' || canonical.kind === 'tenant_db')) {
                    resolved += 1;
                }
            });
        });

        return {
            nodes,
            edges,
            activity,
            callsPerHour,
            loading,
            errors,
            inventoryStatus: { totalEndpoints, resolved },
            staleness,
            isEmpty,
        };
    }, [nodeRows, edgeRows, inventoryRows, loading, errors]);
};
