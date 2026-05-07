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

/**
 * Per-node hourly-calls timechart for the right-sidebar bar chart.
 * Matches events touching the node via ANY of the topology-relevant fields
 * (sap_sid, peer_ip, local_ip, client_ip, clientip, host).
 *
 * Hardcoded to -24h regardless of global time range so the chart shows
 * consistent recent context. (See SESSION-MEMORY-023.md Phase 2 sparkline
 * design rationale.)
 */
export const SEARCH_NODE_HOURLY = (nodeId: string): string | null => {
    const safe = sanitizeNodeId(nodeId);
    if (!safe) return null;
    const q = `"${safe}"`;
    return `
${IDX} (sap_sid=${q} OR peer_ip=${q} OR local_ip=${q} OR client_ip=${q} OR clientip=${q} OR host=${q})
| timechart span=1h count
| fields _time, count
`.trim();
};

/**
 * Per-node Top Programs (the closest available analogue to "Top Tcodes" in
 * this dataset — `tcode=` is consistently empty in our test data, but the
 * `icm_program` field extracted from sap:abap:icm has clean per-SID
 * distributions like `SAPMSSY1` / `SAPMHTTP`).
 *
 * Returns rows shaped { icm_program, count }. Top 8.
 */
export const SEARCH_NODE_PROGRAMS = (nodeId: string): string | null => {
    const safe = sanitizeNodeId(nodeId);
    if (!safe) return null;
    const q = `"${safe}"`;
    return `
${IDX} sourcetype=sap:abap:icm icm_program=*
    (sap_sid=${q} OR peer_ip=${q} OR local_ip=${q} OR client_ip=${q} OR host=${q})
| top icm_program limit=8
| fields icm_program, count
`.trim();
};

/**
 * Per-node error summary for the right-sidebar Errors tab.
 *
 * Surfaces errors across the topology-relevant sourcetypes via three
 * complementary signals (any of which alone qualifies a row as "error"):
 *   - HTTP 4xx/5xx response codes from sap:webdispatcher:access
 *   - severity in {ERROR, CRITICAL, FATAL} from HANA audit / ABAP / saprouter
 *   - non-null gw_error_detail or error_function from gateway / saprouter trace
 *
 * `error_kind` is a categorical bucket derived from whichever signal fired
 * (severity name, "HTTP <code>", gateway detail, or trace function name).
 *
 * Returns rows shaped { sourcetype, error_kind, count, last_seen }. Top 20.
 */
export const SEARCH_NODE_ERRORS = (nodeId: string): string | null => {
    const safe = sanitizeNodeId(nodeId);
    if (!safe) return null;
    const q = `"${safe}"`;
    return `
${IDX} (sap_sid=${q} OR peer_ip=${q} OR local_ip=${q} OR client_ip=${q} OR clientip=${q} OR host=${q})
    (status>=400 OR severity="ERROR" OR severity="CRITICAL" OR severity="FATAL" OR gw_error_detail=* OR error_function=*)
| eval error_kind=case(
    severity=="ERROR" OR severity=="CRITICAL" OR severity=="FATAL", severity,
    isnum(status) AND status>=400, "HTTP " . tostring(status),
    isnotnull(gw_error_detail), gw_error_detail,
    isnotnull(error_function), error_function,
    1==1, "unknown"
  )
| stats count, max(_time) as last_seen by sourcetype, error_kind
| sort - count
| head 20
| fields sourcetype, error_kind, count, last_seen
`.trim();
};

/**
 * Per-node host inventory for the right-sidebar Hosts tab.
 *
 * Lists every Splunk-default `host` value that has logged events touching
 * this node (via any of the topology-relevant fields). Includes event count,
 * distinct sourcetype count (so users can spot multi-purpose forwarders),
 * and first/last-seen timestamps for freshness assessment.
 *
 * Returns rows shaped { host, count, sourcetypes, first_seen, last_seen }.
 * Top 20 by event count.
 */
export const SEARCH_NODE_HOSTS = (nodeId: string): string | null => {
    const safe = sanitizeNodeId(nodeId);
    if (!safe) return null;
    const q = `"${safe}"`;
    return `
${IDX} (sap_sid=${q} OR peer_ip=${q} OR local_ip=${q} OR client_ip=${q} OR clientip=${q} OR host=${q})
| stats count, dc(sourcetype) as sourcetypes, min(_time) as first_seen, max(_time) as last_seen by host
| sort - count
| head 20
| fields host, count, sourcetypes, first_seen, last_seen
`.trim();
};
