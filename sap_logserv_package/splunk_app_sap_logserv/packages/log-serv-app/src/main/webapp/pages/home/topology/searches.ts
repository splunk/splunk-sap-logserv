/**
 * SPL strings for the Environment Topology view's right-pane detail tabs.
 *
 * The graph itself (nodes, edges, the IP/host -> SID inventory and the IP
 * enrichment) is read from the KV Store collections that the
 * logserv_topology_* saved searches in savedsearches.conf write every hour
 * (session 035 / build 188 onward) - see useTopologyData. Nothing in this
 * file feeds the graph.
 *
 * What is left here are the detail-tab reads. Each builder returns a complete
 * SPL search over the logserv_topology_detail_rollup KV Store, ready for the
 * `useSearch` hook (which applies the global TimeRangeProvider's
 * earliest/latest), plus the bulk per-scope host-count read the view issues
 * once per load.
 *
 * Build 377 deleted the on-demand searches of the session-023 prototype: the
 * inventory, the RFC / HANA audit / HTTP / HANA tenant edge searches, the Live
 * Activity search and the calls-per-hour search. Nothing had imported them
 * since the KV Store data layer replaced them, and their filters had drifted
 * from the shipped saved searches (the HANA audit loopback filter among
 * them). The shipped SPL is in savedsearches.conf:
 * logserv_topology_aggregate_* and their logserv_topology_backfill_* twins.
 */

import { edgeIdClause, sanitizeEdgeIds } from './edgeIds';
import type { EdgeSplType } from './types';

/**
 * Whitelist sanitization for a node ID before string-interpolating into SPL.
 * Allowed chars: letters, digits, dots (for IPs), hyphens, underscores.
 * Anything else returns empty string (treated as "no node selected").
 *
 * Defense in depth — node IDs come from search results we generated, not
 * user input, but we still scrub before injection.
 */
const sanitizeNodeId = (id: string): string => {
    if (!id || typeof id !== 'string') return '';
    if (!/^[A-Za-z0-9._-]+$/.test(id)) return '';
    if (id.length > 80) return '';
    return id;
};

/* ============================================================================
 * Detail-tab KV-Store rollup reads (session 060 / build 240).
 *
 * The node + edge detail tabs used to dispatch wide live raw scans on every
 * selection (slow at customer scale). They now read the hourly-aggregated
 * logserv_topology_detail_rollup KV Store (~0.1-0.3s inputlookup vs a multi-
 * second-to-minute raw scan) — the same model as the dashboard rollups.
 *
 * `metric` discriminates the tab; `scope` is the node's canonical label
 * (node_* metrics, byte-exact with the old OR-match via the aggregate's
 * explode-dedup) OR the edge id (edge_* metrics). DETAIL_RANGE carries the
 * global TimeRange picker into the generating inputlookup via addinfo. Row
 * shapes are unchanged so useNodeData/useEdgeData/TopologyRightSidebar are
 * untouched. The node Count / hr read uses a fixed -24h bucket_ts window (not
 * addinfo) — its production window is hardcoded recent context.
 *
 * Trade-off: these tabs are now hourly-fresh (like the dashboards) rather than
 * live, and the hana_tenant Performance distribution shows Avg+Max instead of
 * percentiles (percentiles don't merge across hourly buckets — option-c).
 * ============================================================================ */

const DETAIL_ROLL = 'logserv_topology_detail_rollup';
const DETAIL_RANGE =
    '| addinfo | where bucket_ts>=info_min_time AND bucket_ts<info_max_time';

/**
 * Per-node hourly log-event timechart for the right-sidebar bar chart (Count / hr).
 * Reads the node_hourly metric (byte-exact with the old per-node OR-match
 * count). Fixed -24h bucket_ts window regardless of global time range so the
 * chart shows consistent recent context. (See SESSION-MEMORY-023.md Phase 2
 * sparkline design rationale.) useNodeData dispatches this with earliest=-24h
 * so timechart bins the recent window.
 */
export const SEARCH_NODE_HOURLY = (nodeId: string): string | null => {
    const safe = sanitizeNodeId(nodeId);
    if (!safe) return null;
    return `
| inputlookup ${DETAIL_ROLL} where metric="node_hourly" scope="${safe}"
| where bucket_ts >= relative_time(now(), "-24h")
| eval _time=bucket_ts
| timechart span=1h sum(count) as count
| fillnull value=0
| fields _time, count
`.trim();
};

/**
 * Per-node Top Programs (the closest available analogue to "Top Tcodes" in
 * this dataset — `tcode=` is consistently empty in our test data, but the
 * `icm_program` field extracted from sap:abap:icm has clean per-SID
 * distributions like `SAPMSSY1` / `SAPMHTTP`).
 *
 * Returns rows shaped { icm_program, count }. Top 8. Reads the node_program
 * metric (store-all-then-top: byte-exact with the old `top icm_program`).
 */
export const SEARCH_NODE_PROGRAMS = (nodeId: string): string | null => {
    const safe = sanitizeNodeId(nodeId);
    if (!safe) return null;
    return `
| inputlookup ${DETAIL_ROLL} where metric="node_program" scope="${safe}"
${DETAIL_RANGE}
| stats sum(count) as count by icm_program
| sort - count
| head 8
| fields icm_program, count
`.trim();
};

/**
 * Per-node error summary for the right-sidebar Errors tab.
 *
 * Surfaces errors across the topology-relevant sourcetypes via three
 * complementary signals (HTTP 4xx/5xx, severity in {ERROR, CRITICAL, FATAL},
 * non-null gw_error_detail/error_function). `error_kind` is the categorical
 * bucket derived from whichever signal fired — precomputed in the aggregate
 * (verbatim case() expression) so the read is a plain rollup of the
 * node_error metric.
 *
 * Returns rows shaped { sourcetype, error_kind, count, last_seen }. Top 20.
 */
export const SEARCH_NODE_ERRORS = (nodeId: string): string | null => {
    const safe = sanitizeNodeId(nodeId);
    if (!safe) return null;
    return `
| inputlookup ${DETAIL_ROLL} where metric="node_error" scope="${safe}"
${DETAIL_RANGE}
| stats sum(count) as count, max(max_time) as last_seen by sourcetype, error_kind
| sort - count
| head 20
| fields sourcetype, error_kind, count, last_seen
`.trim();
};

/**
 * How many host rows the Hosts tab read returns. Raised from 20 in build 322:
 * the tab now badges each row with an inventory ownership verdict, and 20 bit
 * on the very node used as that feature's evidence (XCP had 21 hosts), turning
 * a soft undercount into a false inventory claim. 100 is above any realistic
 * per-system host count on this data — and when it IS reached the panel says
 * so, from `host_total` below (§8a-4, the MAX_EDGE_IDS precedent: a cap that
 * is reached is a cap that is reported).
 */
export const NODE_HOSTS_LIMIT = 100;

/**
 * Per-node host inventory for the right-sidebar Hosts tab.
 *
 * Lists every Splunk-default `host` value that has logged events touching
 * this node. Includes event count, distinct sourcetype count (the node_host
 * metric carries sourcetype as a grain dim so dc() reconstructs exactly —
 * session-050 #3), SAP instance numbers (build 325 — `values()` over the
 * multivalue `instances` measure the node_host arms now store; empty on rows
 * aggregated before that change), and first/last-seen timestamps.
 *
 * `host_total` is the PRE-cap distinct-host count, carried on every row so the
 * caption can state "N of M" instead of presenting the cap as the truth.
 *
 * Returns rows shaped { host, count, sourcetypes, instances, first_seen,
 * last_seen, host_total }, capped at NODE_HOSTS_LIMIT by event count.
 */
export const SEARCH_NODE_HOSTS = (nodeId: string): string | null => {
    const safe = sanitizeNodeId(nodeId);
    if (!safe) return null;
    return `
| inputlookup ${DETAIL_ROLL} where metric="node_host" scope="${safe}"
${DETAIL_RANGE}
| stats sum(count) as count, dc(sourcetype) as sourcetypes, values(instances) as instances, min(min_time) as first_seen, max(max_time) as last_seen by host
| eventstats dc(host) as host_total
| sort - count
| head ${NODE_HOSTS_LIMIT}
| fields host, count, sourcetypes, instances, first_seen, last_seen, host_total
`.trim();
};

/**
 * Safety margin (seconds) added around the coarse mongod-pushdown bounds in
 * SEARCH_NODE_HOST_COUNTS. The PRECISE window is still cut by `| addinfo`
 * (DETAIL_RANGE) so the count agrees with the Hosts tab; the pushdown only
 * has to be a superset of whatever addinfo resolves, and Splunk's calendar
 * arithmetic (search-head-local snapping) can diverge from the JS resolver's
 * UTC arithmetic by up to ~a day around @d / @mon snaps (the session-060
 * build-321 lesson). Two days over-covers every such divergence.
 */
export const HOST_COUNT_PUSHDOWN_MARGIN_SECONDS = 2 * 86400;

/**
 * Bulk per-scope distinct-host counts for the whole topology view (build 325
 * / session 110, plan item D1). ONE windowed read at topology load feeds a
 * `label -> hostCount` map: the NodeTooltip "Hosts" row (SID nodes) and the
 * right-pane "Hosts (in range)" facts row (SID + tenant nodes).
 *
 * Reads the SAME `node_host` metric the Hosts tab reads, so the two counts
 * agree for the same node + window — `dc(host)` here equals that tab's
 * `host_total` eventstats. (Dispatch timing can briefly differ: this read
 * resolves its window at page load, the tab at node-select time, so across
 * an hourly-aggregate boundary the two can disagree by the newest hour
 * until the next interaction.) Sub-hour windows inherit the rollup's hourly
 * grain, exactly like the Hosts tab (accepted in the plan).
 *
 * Two-layer windowing (review fold, session 110): the caller passes the
 * JS-resolved epoch window and a COARSE `bucket_ts` bound (± the margin
 * above) is pushed into the inputlookup `where`, so mongod streams only the
 * window's rows instead of the whole 365-day retention of the largest
 * detail-rollup metric — the same history-decoupling every other rollup
 * read has (session-035 sticky #1). The PRECISE trim stays `| addinfo`, so
 * agreement with the Hosts tab is unaffected. Non-finite bounds (an
 * unparseable time spec) fall back to the unbounded-but-correct form.
 *
 * No scope filter: the map is only APPLIED to SID + tenant nodes at the
 * consumer — host/IP scopes' counts are computed but unused (a host's dc
 * over itself is trivially 1 anyway).
 */
export const SEARCH_NODE_HOST_COUNTS = (
    earliestTs?: number,
    latestTs?: number,
): string => {
    const lo = typeof earliestTs === 'number' && Number.isFinite(earliestTs)
        ? Math.floor(earliestTs - HOST_COUNT_PUSHDOWN_MARGIN_SECONDS)
        : null;
    const hi = typeof latestTs === 'number' && Number.isFinite(latestTs)
        ? Math.ceil(latestTs + HOST_COUNT_PUSHDOWN_MARGIN_SECONDS)
        : null;
    const bounds = lo != null && hi != null && hi >= lo
        ? ` AND bucket_ts>=${lo} AND bucket_ts<=${hi}`
        : '';
    return `
| inputlookup ${DETAIL_ROLL} where metric="node_host"${bounds}
${DETAIL_RANGE}
| stats dc(host) as hosts by scope
| fields scope, hosts
`.trim();
};

/* ============================================================================
 * Edge-data detail-tab reads (build 202 / session 036; KV-Store cached in
 * session 060 / build 240).
 *
 * The edge tabs now read the hourly logserv_topology_detail_rollup KV Store
 * keyed by the edge id (`scope` = the sha1[:16] edge id, matching
 * logserv_topology_edges.id). The aggregate's edge arms replicate the
 * aggregate_edges id derivation and precompute the same per-type aggregates
 * the live searches used to compute on the fly, so the read is a plain rollup.
 *
 *   - Activity   → NOT dispatched since build 321: computed in-memory by
 *                  useTopologyData from the same bucket rows as the headline.
 *   - Operations → edge_op metric (top entity: uri / remote gateway service
 *                  or client program / action_type / hana_trace_component /
 *                  SAP Router target service).
 *   - Performance→ edge_perf metric (status-class / connection-record kind /
 *                  action_status / SAP Router target role histograms;
 *                  hana_tenant shows Avg+Max of hana_op_duration_ms
 *                  — percentiles don't merge across hourly buckets, option-c.
 *                  Headline p50/p95/max still come from the edge row).
 *   - Errors     → edge_err metric (error_kind / error_detail pairs).
 *
 * Build 378: the RFC arms read gateway CONNECTION records (a remote-gateway
 * connection closed, a client session closed, a broken connection) in the
 * direction the connection was made, so the rfc Operations and Performance
 * reads have rows (the build-240 arms over icm_program / icm_tasks never
 * did); the SAP Router arms (type "saprouter") add a fifth stored type. The
 * reads themselves are type-agnostic and did not change.
 *
 * Signature is `(splType, edgeIds)` — splType only selects the Performance
 * read variant; the ids are the rollup scopes. Returns null when splType is
 * missing, when the id set is empty, or when ANY id is not a stored edge id
 * (fail closed — see topology/edgeIds.ts).
 * ============================================================================ */

/* The edge-id contract (validation, the OR-clause renderer and the display-id
 * producer) lives in topology/edgeIds.ts so the build gate can exercise it
 * directly. Build 321: these three builders take the SET of stored ids
 * composing the rendered edge — retargeting can collapse several — and fail
 * closed if any of them is not a stored id.
 *
 * There is deliberately NO SEARCH_EDGE_ACTIVITY: the Activity series is
 * computed in-memory in useTopologyData from the same bucket rows that produce
 * the edge's headline totals, so the Overview legend decomposes "Calls in
 * window" exactly. Dispatching it would resolve a different window (Splunk's
 * `| addinfo` calendar arithmetic in the search head's local TZ with an
 * exclusive upper bound, versus the hook's UTC-snapped inclusive one). */

/**
 * Per-edge Operations: top entities traversing the edge for the current time
 * range (uri / remote gateway service or client program / action_type /
 * hana_trace_component / SAP Router target service depending on edge type —
 * precomputed in the edge_op metric). Returns rows { entity, count }. Top 10
 * (store-all-then-top → byte-exact). Until build 378 rfc always returned empty
 * (the old arm grouped icm_program, which sap:abap:gateway events never carry).
 */
export const SEARCH_EDGE_OPERATIONS = (
    _splType: EdgeSplType,
    edgeIds: readonly string[] | null | undefined,
): string | null => {
    const sel = sanitizeEdgeIds(edgeIds);
    if (!sel) return null;
    return `
| inputlookup ${DETAIL_ROLL} where metric="edge_op" AND ${edgeIdClause('scope', sel.ids)}
${DETAIL_RANGE}
| stats sum(count) as count by entity
| sort - count
| head 10
| fields entity, count
`.trim();
};

/**
 * Per-edge Performance distribution for the Performance tab (the headline
 * p50/p95/max come straight off the edge row — no dispatch). Reads the
 * edge_perf metric:
 *   HTTP / RFC / HANA Audit / SAP Router → per-bucket_label count histogram
 *     (status class / connection-record kind / action_status / target role).
 *   HANA Tenant → Avg + Max of hana_op_duration_ms (Σsum/Σn + max-of-max;
 *     percentiles don't merge across hourly buckets — session-051 option-c).
 * Returns rows { bucket_label, count }.
 */
export const SEARCH_EDGE_PERFORMANCE = (
    splType: EdgeSplType,
    edgeIds: readonly string[] | null | undefined,
): string | null => {
    const sel = sanitizeEdgeIds(edgeIds);
    if (!sel) return null;
    if (splType === 'hana_tenant') {
        return `
| inputlookup ${DETAIL_ROLL} where metric="edge_perf" AND ${edgeIdClause('scope', sel.ids)}
${DETAIL_RANGE}
| stats sum(sum_dur) as s, sum(n_dur) as n, max(max_dur) as mx
| eval "Avg ms"=round(s/n, 1), "Max ms"=mx
| fields "Avg ms", "Max ms"
| transpose 0
| rename column as bucket_label, "row 1" as count
| fields bucket_label, count
`.trim();
    }
    return `
| inputlookup ${DETAIL_ROLL} where metric="edge_perf" AND ${edgeIdClause('scope', sel.ids)}
${DETAIL_RANGE}
| stats sum(count) as count by bucket_label
| sort - count
| fields bucket_label, count
`.trim();
};

/**
 * Per-edge Errors: top failure modes for the current time range. Reads the
 * edge_err metric (error_kind + error_detail pairs, precomputed per-type:
 * HTTP `HTTP <status>`/uri; RFC gw_error_detail/error_function over the
 * broken-connection lines; HANA Audit `UNSUCCESSFUL <action>`/user; HANA
 * Tenant severity/component; SAP Router `rc=<code>`/server-side connection
 * failed). Returns rows { error_kind, error_detail, count, last_seen }. Top 15.
 */
export const SEARCH_EDGE_ERRORS = (
    _splType: EdgeSplType,
    edgeIds: readonly string[] | null | undefined,
): string | null => {
    const sel = sanitizeEdgeIds(edgeIds);
    if (!sel) return null;
    return `
| inputlookup ${DETAIL_ROLL} where metric="edge_err" AND ${edgeIdClause('scope', sel.ids)}
${DETAIL_RANGE}
| stats sum(count) as count, max(max_time) as last_seen by error_kind, error_detail
| sort - count
| head 15
| fields error_kind, error_detail, count, last_seen
`.trim();
};
