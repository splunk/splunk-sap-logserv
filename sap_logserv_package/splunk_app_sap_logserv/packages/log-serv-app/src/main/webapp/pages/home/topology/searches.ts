/**
 * SPL strings for the Environment Topology view (Phase 2 / session 023).
 *
 * Each exported function returns a complete SPL search ready to feed to
 * the `useSearch` hook (which auto-applies the global TimeRangeProvider's
 * earliest/latest). All searches scope to the SAP LogServ index via the
 * `sap_logserv_idx_macro` macro.
 *
 * The four searches together feed the topology view:
 *   1. SEARCH_INVENTORY  — IP/host -> SID map (used to enrich edge endpoints)
 *   2. SEARCH_RFC_EDGES  — sap:abap:gateway peer-to-local connections
 *   3. SEARCH_HANA_EDGES — sap:hana:audit cross-stack auth (client_ip -> HANA)
 *   4. SEARCH_HTTP_EDGES — sap:webdispatcher:access (clientip -> dispatcher)
 *
 * The React side joins these in JS rather than via SPL `join` (cleaner
 * loading semantics; per-search error isolation; easier to debug).
 *
 * Self-derived IP/host -> SID resolution:
 *   - The `local_ip` field in gateway events is canonical: an event tagged
 *     with sap_sid=XCP that logged L=10.186.74.23 means that IP belongs to
 *     XCP. (See SESSION-MEMORY-023.md Path A Phase 2.)
 *   - The Splunk-default `host` field works the same way for non-IP
 *     hostnames, but multi-SID hosts (centralized forwarders like
 *     hec53v013858) are excluded by the `mvcount(sids)=1` filter.
 */

import { edgeIdClause, sanitizeEdgeIds } from './edgeIds';

const IDX = '`sap_logserv_idx_macro`';

/**
 * Inventory: build (ip|host) -> sid mappings from multiple sourcetype-specific
 * canonical fields. Returns rows shaped { key: <ip-or-host>, sid: <SID>, kind:
 * 'ip'|'host' }.
 *
 * Filters multi-SID keys (centralized forwarders, ambiguous hostnames) via
 * `mvcount(sids)=1` after the union so only unambiguous mappings flow through.
 *
 * Four canonical mapping sources (each contributes independently and gets
 * merged):
 *
 *   1. **gateway L= local_ip** -> sap_sid: a gateway daemon log line that
 *      includes its own L=<ip> and is tagged sap_sid=X PROVES that ip
 *      belongs to X (the daemon listens on that local IP).
 *   2. **ICM icm_local_ip** -> sap_sid (added build 122 / A.3): the ABAP
 *      ICM process logs its own listening IP via the icm_local_ip EXTRACT
 *      directive. Same self-attribution pattern as gateway L= but covers
 *      ICM-only hosts that don't run a gateway daemon. Empirically adds ~6
 *      fresh IP→SID mappings on the xsd-vlab dataset (doubles the IP-side
 *      inventory from 5 → 11).
 *   3. **HANA tracelogs hana_host** -> sap_sid: HANA tracelog source paths
 *      contain the HANA hostname segment, and the events are tagged with
 *      the HANA SID via the existing EXTRACT-sap_sid. Pairs them as
 *      "hana_host belongs to sap_sid" (added build 113 / Phase 3).
 *   4. **Splunk default `host` field** across all SAP sourcetypes ->
 *      sap_sid: the Splunk-stamped originating host, when single-SID.
 *
 * Sources investigated and rejected (session 024 / A.3):
 *   - DNS query log (isc:bind:query): no sap_sid attribution on DNS events,
 *     and no extracted hostname↔IP pairing (BIND log only has src_ip + query
 *     name; no "answer" field captured by the BIND TA at our deployment).
 *   - Saprouter peer_hostname: saprouter events lack sap_sid attribution AND
 *     most peer parens are IP-only (the build-113 EXTRACT skips IP-only
 *     parens by design), so the source returns near-zero rows. The
 *     hostnames it does produce belong to REMOTE peers, not the saprouter's
 *     own SID — including them would corrupt inventory.
 *   - icm_peer_ip / client_ip: remote-end IPs, attributing them to the
 *     LOGGING sap_sid would be wrong by construction.
 *
 * The union with `mvcount(sids)=1` after stats gives "every key that
 * unambiguously maps to one SID across all sources".
 */
export const SEARCH_INVENTORY = (): string => `
| union
    [search ${IDX} sourcetype=sap:abap:gateway local_ip=* sap_sid=*
        | eval key=local_ip, kind="ip"
        | fields key, kind, sap_sid]
    [search ${IDX} sourcetype=sap:abap:icm icm_local_ip=* sap_sid=*
        | eval key=icm_local_ip, kind="ip"
        | fields key, kind, sap_sid]
    [search ${IDX} sourcetype=sap:hana:tracelogs hana_host=* sap_sid=*
        | eval key=hana_host, kind="host"
        | fields key, kind, sap_sid]
    [search ${IDX} sap_sid=* host=*
        | eval key=host, kind="host"
        | fields key, kind, sap_sid]
| stats values(sap_sid) as sids by key, kind
| where mvcount(sids) = 1
| eval sid=mvindex(sids, 0)
| fields key, sid, kind
`.trim();

/**
 * RFC connection edges from sap:abap:gateway P=/L= log lines.
 * Returns rows: { src_sid, peer_ip, local_ip, call_count }
 * The React side resolves peer_ip via the inventory.
 */
export const SEARCH_RFC_EDGES = (): string => `
${IDX} sourcetype=sap:abap:gateway peer_ip=* local_ip=* sap_sid=*
| stats count as call_count by sap_sid, peer_ip, local_ip
| rename sap_sid as src_sid
| sort - call_count
| head 200
`.trim();

/**
 * HANA cross-stack edges: who's authenticating to which HANA system.
 * Returns rows: { hana_sid, client_ip, user, call_count }
 *
 * The HANA system's SID is derived by joining its `host` field against the
 * inventory (where the same hostname has a sap_sid attached from
 * non-audit HANA events).
 */
export const SEARCH_HANA_EDGES = (): string => `
${IDX} sourcetype=sap:hana:audit client_ip=* host=*
| where client_ip != "127.0.0.1"
| stats count as call_count by host, client_ip, user
| rename host as hana_host
| sort - call_count
| head 100
`.trim();

/**
 * HTTP inbound edges: client IPs hitting Web Dispatcher.
 * Returns rows: { dispatcher_host, clientip, call_count, error_count }
 */
export const SEARCH_HTTP_EDGES = (): string => `
${IDX} sourcetype=sap:webdispatcher:access clientip=* host=*
| stats count as call_count, sum(eval(if(status>=400, 1, 0))) as error_count by host, clientip
| rename host as dispatcher_host
| sort - call_count
| head 100
`.trim();

/**
 * HANA tenant database hosting edges: HANA system SID <- tenant DB SID.
 * Sourced from sap:hana:tracelogs source-path pattern
 * `/usr/sap/<HANA_SID>/HDB<inst>/<host>/trace/DB_<TENANT_SID>/...` extracted
 * via the EXTRACT-hana_tenant_sid directive (build 113).
 *
 * Returns rows shaped { hana_system, tenant_sid, call_count }. The hana_system
 * is treated as a database in the topology view (cylinder icon, 'DB' tag);
 * the tenant_sid is the application SID running on top of it.
 *
 * Critical for surfacing HANA systems as nodes — HANA audit edges target
 * forwarder hosts (hec53v*) which resolve to the HANA SID via inventory but
 * don't directly produce HANA-system nodes. These tenant edges put the HANA
 * SID front and center.
 */
export const SEARCH_HANA_TENANT_EDGES = (): string => `
${IDX} sourcetype=sap:hana:tracelogs sap_sid=* hana_tenant_sid=*
| stats count as call_count by sap_sid, hana_tenant_sid
| rename sap_sid as hana_system, hana_tenant_sid as tenant_sid
| where hana_system != tenant_sid
| sort - call_count
| head 30
`.trim();

/**
 * Top RFC partners for the bottom Live Activity table.
 * Returns rows: { source_sid, direction, partner, call_count }
 *
 * Uses the same gateway P=/L= data as the RFC edges; partner can be either
 * a resolved SID or the raw IP if unresolved. Direction is derived: if
 * src_sid hosts the local_ip (the call originated locally), it's "client";
 * otherwise "server".
 */
export const SEARCH_ACTIVITY = (): string => `
${IDX} sourcetype=sap:abap:gateway peer_ip=* local_ip=* sap_sid=*
| stats count as call_count by sap_sid, peer_ip
| rename sap_sid as source_sid, peer_ip as partner
| eval direction="client"
| sort - call_count
| head 8
`.trim();

/**
 * Calls per hour for the bottom panel sparkline (24h trend regardless of
 * the global time range — gives consistent context).
 */
export const SEARCH_CALLS_PER_HOUR = (): string => `
${IDX} sourcetype=sap:abap:gateway peer_ip=*
| timechart span=1h count
| eval call_count=count
| fields _time, call_count
`.trim();

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
 * untouched. The node Calls/Hr read uses a fixed -24h bucket_ts window (not
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
 * Per-node hourly-calls timechart for the right-sidebar bar chart.
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
 *   - Operations → edge_op metric (top entity: uri / icm_program / action_type
 *                  / hana_trace_component).
 *   - Performance→ edge_perf metric (status-class / icm_tasks / action_status
 *                  histograms; hana_tenant shows Avg+Max of hana_op_duration_ms
 *                  — percentiles don't merge across hourly buckets, option-c.
 *                  Headline p50/p95/max still come from the edge row).
 *   - Errors     → edge_err metric (error_kind / error_detail pairs).
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
 * range (uri / icm_program / action_type / hana_trace_component depending on
 * edge type — precomputed in the edge_op metric). Returns rows { entity, count
 * }. Top 10 (store-all-then-top → byte-exact). rfc legitimately returns empty
 * (icm_program is absent on sap:abap:gateway events — same as the old live
 * search).
 */
export const SEARCH_EDGE_OPERATIONS = (
    _splType: 'http' | 'rfc' | 'hana_audit' | 'hana_tenant',
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
 *   HTTP / RFC / HANA Audit → per-bucket_label count histogram (status class /
 *     icm_tasks band / action_status).
 *   HANA Tenant → Avg + Max of hana_op_duration_ms (Σsum/Σn + max-of-max;
 *     percentiles don't merge across hourly buckets — session-051 option-c).
 * Returns rows { bucket_label, count }.
 */
export const SEARCH_EDGE_PERFORMANCE = (
    splType: 'http' | 'rfc' | 'hana_audit' | 'hana_tenant',
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
 * HTTP `HTTP <status>`/uri; RFC gw_error_detail/error_function; HANA Audit
 * `UNSUCCESSFUL <action>`/user; HANA Tenant severity/component). Returns rows
 * { error_kind, error_detail, count, last_seen }. Top 15.
 */
export const SEARCH_EDGE_ERRORS = (
    _splType: 'http' | 'rfc' | 'hana_audit' | 'hana_tenant',
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
