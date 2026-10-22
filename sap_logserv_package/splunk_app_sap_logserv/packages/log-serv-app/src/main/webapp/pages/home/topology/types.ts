/**
 * Environment Topology — domain types.
 *
 * Phase 1 (session 023): static fixture data shaped to these types.
 * Phase 2 (session 024): real SPL aggregations marshalled into the same shape.
 */

/* Type-only import; erased at compile time, so no runtime cycle with
 * panelFacts (which itself imports nothing from this module). */
import type { EdgeAppServerRow } from './panelFacts';

export type IntegrationType =
    | 'rfc'           // Remote Function Call (sync)
    | 'idoc'          // Intermediate Document (async)
    | 'qrfc'          // Queued RFC
    | 'trfc'          // Transactional RFC
    | 'bgrfc'         // Background RFC
    | 'web_service'   // SOAP / REST web service
    | 'odata'         // OData / Gateway
    | 'btp_iflow'     // BTP iFlow / CPI
    /* Build 378 (U32 / U1): the 9th type, and the first since the legacy
     * eight that a rollup arm actually produces under its own name — the
     * SAP Router CONNECT TO edges (stored type "saprouter"). Saved layouts
     * from before it existed keep it enabled on load: see
     * restoreEnabledTypes in topology/persistence.ts. */
    | 'saprouter';    // SAP Router routed connection (CONNECT TO)

/** The edge types the rollup stores (`logserv_topology_edges.type`). The
 *  visual layer maps them onto IntegrationType (splTypeToIntegrationType in
 *  topology/edgeStyle.ts); the right pane dispatches on this value. */
export type EdgeSplType = 'http' | 'rfc' | 'hana_audit' | 'hana_tenant' | 'saprouter';

/** Canonical endpoint kinds the topology rollups store — node rows'
 *  `canonical_kind`, edge rows' `source_kind` / `target_kind`. Build 378
 *  (U29, option S2) adds `saprouter`: the host that wrote a SAP Router log,
 *  kept apart from the `host` kind so the host -> SID inventory can never
 *  fold a router into an SAP system that happens to run on the same VM. */
export type CanonicalKind = 'sid' | 'ip' | 'host' | 'tenant_db' | 'saprouter';

export type BusinessProcess =
    | 'o2c_order'
    | 'o2c_delivery'
    | 'o2c_invoice'
    | 'o2c_payment'
    | 'mixed'
    | 'untagged';

export type NodeKind =
    | 'sid_focused'   // The SAP systems we're focused on (big red rings)
    | 'sid_secondary' // Other internal SAP systems (medium white circles)
    | 'partner';      // External / non-SAP system (small gray rounded squares)

export type SystemTag =
    | 'ECC'           // ERP Central Component
    | 'S4'            // S/4HANA
    | 'BTP'           // Business Technology Platform
    | 'JV'            // Joint Venture
    | 'ABAP'          // Generic ABAP
    /* Build 211 / session 036 — DB tag split into per-vendor sub-tags
     * so the Topology view can attribute health signals to the right
     * vendor and (for HANA) drive vendor-specific health metrics
     * (slow queries from hana_op_duration_ms, severity=WARNING events,
     * etc.). All DB-vendor tags trigger the cylinder-icon visual via
     * the `isDatabaseTag()` helper below. */
    | 'DB'            // Generic / unknown database (fallback)
    | 'HANA'          // SAP HANA — gets HANA-specific health metrics
    | 'ORACLE'        // Oracle database
    | 'MSSQL'         // Microsoft SQL Server
    | 'POSTGRES'      // PostgreSQL
    | 'DB2'           // IBM DB2
    | 'TENANT'        // HANA tenant database (session 109 — tenant_db edge endpoints)
    | 'ROUTER'        // SAP Router host (build 378 — canonical kind saprouter)
    | 'EXT';          // External / non-SAP

/** User-visible tag strings (session 109 / build 324). Internal SystemTag
 *  values stay stable (session-023 sticky: rename user-visible labels only);
 *  this map is applied wherever a tag renders. `short` = the under-node
 *  chip form (kept compact per the session-109 decision: short chips, full
 *  string in the Tag row + hover tooltip). */
export const displayTag = (tag: SystemTag, opts?: { short?: boolean }): string => {
    if (tag === 'HANA') return 'HANA SYSTEM';
    if (tag === 'TENANT') return opts?.short ? 'HANA TENANT' : 'APP SERVERS - HANA TENANT';
    if (tag === 'ROUTER') return 'SAP ROUTER';
    return tag;
};

/** The tag a node of this canonical kind always carries, whatever the stored
 *  row or the label heuristics say; null = no fixed tag (the stored tag,
 *  refined by refineTag in useTopologyData, applies). Build 324 fixed TENANT
 *  for tenant databases; build 378 fixes ROUTER for SAP Router hosts, so a
 *  router whose host name happens to contain "hdb" or "ora" is never drawn
 *  as a database. */
export const fixedTagForKind = (kind: string | undefined | null): SystemTag | null => {
    if (kind === 'tenant_db') return 'TENANT';
    if (kind === 'saprouter') return 'ROUTER';
    return null;
};

/** True for the tags fixedTagForKind assigns: refineTag must leave them. */
export const isFixedTag = (tag: SystemTag): boolean => tag === 'TENANT' || tag === 'ROUTER';

/** Canonical kind of an edge endpoint recovered from the edge row's
 *  `spl_filter_clauses` field name (clauses[0] = source, clauses[1] =
 *  target), for endpoints that have no node row. Unknown fields give null,
 *  so the endpoint is simply not classified (never guessed). Build 378 adds
 *  the SAP Router fields (router host -> saprouter, target address -> ip)
 *  and the gateway client address of the RFC connection records. */
export const clauseFieldToKind = (field: string): CanonicalKind | null => {
    if (field === 'sap_sid') return 'sid';
    if (field === 'hana_tenant_sid') return 'tenant_db';
    if (field === 'saprouter_host') return 'saprouter';
    if (field === 'clientip' || field === 'client_ip'
        || field === 'peer_ip' || field === 'local_ip'
        || field === 'saprouter_target_ip' || field === 'gw_client_ip') return 'ip';
    if (field === 'host' || field === 'hana_host') return 'host';
    return null;
};

/**
 * The node id an edge endpoint is DRAWN on (the inventory retargeting rule of
 * useTopologyData, as a pure function since build 378 so the consistency
 * suite can hold it):
 *
 *   - sid: the SID's node (a real bucket row's id, or the synthetic
 *     `__synth_sid:` id), else the endpoint itself;
 *   - ip / host: the owning SID's node when the inventory names exactly one
 *     owner AND that SID has a node, else the endpoint itself;
 *   - tenant_db: always itself (drawn as the tenant circle);
 *   - saprouter: always itself (U29 / S2) — even when the inventory holds a
 *     row for the same host name (a router VM that also runs an SAP system),
 *     the router stays its own "SAP ROUTER" node;
 *   - anything else, or no canonical entry: itself.
 */
export const retargetEndpoint = (
    nodeId: string,
    canonical: { kind: string; value: string } | null | undefined,
    ownerOf: (value: string) => string | undefined,
    sidNodeId: (sid: string) => string | undefined,
): string => {
    if (!canonical) return nodeId;
    if (canonical.kind === 'sid') return sidNodeId(canonical.value) ?? nodeId;
    if (canonical.kind === 'tenant_db') return nodeId;
    if (canonical.kind === 'saprouter') return nodeId;
    if (canonical.kind === 'ip' || canonical.kind === 'host') {
        const resolvedSid = ownerOf(canonical.value);
        if (!resolvedSid) return nodeId;
        return sidNodeId(resolvedSid) ?? nodeId;
    }
    return nodeId;
};

/** Predicate: is this tag a database-vendor tag? Used by node renderers
 *  (SidNode + PartnerNode) to decide whether to show the cylinder icon,
 *  by the right sidebar to show the HANA roll-up section, and by the
 *  IntegrationTopology call-bucket computation to apply vendor-specific
 *  health heuristics. Centralizing here keeps additions of new DB
 *  vendors (e.g., MariaDB) to a single place. */
export const isDatabaseTag = (tag: SystemTag): boolean => (
    tag === 'DB'
    || tag === 'HANA'
    || tag === 'ORACLE'
    || tag === 'MSSQL'
    || tag === 'POSTGRES'
    || tag === 'DB2'
);

/** Detect a partner DB's vendor from its label string (hostname / IP /
 *  service name). Returns null if no DB substring matches — caller
 *  defaults to the generic 'DB' tag when other heuristics already
 *  classified the node as database. Order matters: more-specific
 *  patterns checked first to avoid e.g. "mariadb" matching the
 *  shorter "db2" pattern. Build 211 / session 036. */
export const detectDbVendor = (label: string): SystemTag | null => {
    if (!label) return null;
    const lc = label.toLowerCase();
    /* HANA — typically uses hdb / hana naming or the SAP _hdb suffix. */
    if (lc.includes('hana') || lc.includes('hdb')) return 'HANA';
    /* Oracle — orcl, oracle, ora-, oradb. */
    if (lc.includes('oracle') || lc.includes('orcl') || /(?:^|[^a-z])ora(?:db|cle|-)?/.test(lc)) return 'ORACLE';
    /* Microsoft SQL Server — mssql, sqlserver, msdb, sqlsvr. */
    if (lc.includes('mssql') || lc.includes('sqlserver') || lc.includes('sqlsvr') || lc.includes('msdb')) return 'MSSQL';
    /* PostgreSQL — postgres, postgresql, pg-, pgdb. */
    if (lc.includes('postgres') || /(?:^|[^a-z])pg-/.test(lc) || lc.includes('pgdb')) return 'POSTGRES';
    /* IBM DB2 — checked LAST so "db2" doesn't accidentally match other vendors. */
    if (/(?:^|[^a-z])db2(?:[^a-z]|$)/.test(lc)) return 'DB2';
    return null;
};

export interface TopologyNode {
    id: string;
    label: string;
    kind: NodeKind;
    tag: SystemTag;
    eventCount: number;
    /* Build 377 (U38): the optional health percentage is gone. No saved
     * search ever wrote the node KV field it was read from, so the halo it
     * coloured was always the default accent; node health is the
     * read-time call-bucket ring below (callBuckets). */
    /* Build 325 note: the D1 per-node host count is deliberately NOT a
     * field on this interface. Attaching it would put the late-arriving
     * bulk SPL read into the node-array identity that TopologyGraph's
     * layout effect keys on — re-running d3-force and clobbering the
     * user's viewport/drags seconds after every load (review fold,
     * session 110). It travels via HostCountContext (the tooltip) and
     * the sidebar's nodeHostCount prop instead. */
    /** Build 206 / session 036 — call-volume breakdown for the thin outer
     *  ring rendered on SID circular nodes. Computed in IntegrationTopology
     *  by summing across incident edges:
     *    normal  = sum of (callCount - errorCount) across all incident edges
     *    warning = sum of errorCount on edges where errorRate < 10% (sporadic)
     *    error   = sum of errorCount on edges where errorRate >= 10% (systematic)
     *  When all three buckets are 0, the ring is suppressed entirely. The
     *  ring renders only on SidNode (sid_focused + sid_secondary), not
     *  PartnerNode — partner squares stay clean. Optional so non-KV-Store
     *  callers (fixtures, edge-only renders) stay type-clean. */
    callBuckets?: {
        normal: number;
        warning: number;
        error: number;
    };
}

/** One hourly point of an edge's activity series. Computed in-memory from the
 *  same `logserv_topology_edges` bucket rows that produce the edge's headline
 *  totals (build 321) — so the Overview tab's "Successful calls + Errors"
 *  legend is a decomposition of "Calls in window" BY CONSTRUCTION. It used to
 *  be a separate SPL dispatch whose window was resolved by Splunk's calendar
 *  arithmetic (`| addinfo`, search-head-local TZ, exclusive upper bound) while
 *  the headline was resolved in JS (UTC-snapped, inclusive) — two disagreeing
 *  decompositions of one number, rendered adjacent. */
export interface EdgeActivityPoint {
    /** Epoch seconds of the hourly bucket. */
    time: number;
    count: number;
    errorCount: number;
}

export interface TopologyEdge {
    /** The key of the RENDERED edge — `edgeDisplayId(source, target, type)`
     *  over the RETARGETED endpoints (topology/edgeIds.ts). Stable across
     *  renders, used as the ReactFlow key, the selection key and the persisted
     *  `selectedEdgeId`. NOT a storage key: never splice it into SPL — use
     *  `bucketIds`. */
    id: string;
    source: string;
    target: string;
    type: IntegrationType;
    /** Direction ranked from the source node's perspective. */
    direction: 'client' | 'server' | 'bidi';
    callCount: number;
    /** Build 321 — the distinct `logserv_topology_edges.id` values (also the
     *  detail rollup's `scope`) whose hourly buckets compose this rendered
     *  edge. A set, not a scalar: inventory retargeting can collapse several
     *  stored edges onto one rendered edge. REQUIRED, deliberately: it is the
     *  only compiler-enforced guarantee that a future construction site cannot
     *  repeat the build-240 regression of feeding the display id to SPL. */
    bucketIds: string[];
    /** Build 321 — the per-hour activity series, summed in-memory across
     *  `bucketIds` over exactly the window that produced `callCount`. */
    activity: EdgeActivityPoint[];
    /** Optional business-process tag for filtering. */
    process?: BusinessProcess;
    /** Session 035 / build 188 — preserves the canonical SPL-emitted edge
     *  type ('http' | 'rfc' | 'hana_audit' | 'hana_tenant', plus 'saprouter'
     *  since build 378) alongside the legacy IntegrationType (which the
     *  visual layer uses for coloring). Session 036's edge-data right pane
     *  dispatches on this for per-type tab content. Optional to keep
     *  fixture-data + non-KV-Store callers type-clean. */
    splType?: EdgeSplType;
    /** Session 035 / build 188 — canonical SPL filter clauses, denormalized
     *  from the KV Store edge bucket row's `spl_filter_clauses` JSON array.
     *  Session 036's right pane spliced these into per-edge SPL; since the
     *  build-240 KV rewrite the tabs read the rollup by `bucketIds` instead,
     *  so these survive only as ENDPOINT LABEL HINTS (useTopologyData recovers
     *  a synthesized partner's label from them when it has no node row).
     *  Build 325 caveat: they come from ONE member row, so on an RFC edge
     *  they pin a single `local_ip` of the N the edge may span — never
     *  rebuild a raw-event filter from them (a future consumer would filter
     *  to one app server while the headline sums all of them). */
    splFilterClauses?: { field: string; value: string }[];
    /** Session 035 / build 188 — canonical sourcetype that produced this
     *  edge's underlying events. Pairs with splFilterClauses for raw-event
     *  drilldown SPL construction. */
    splSourcetype?: string;
    /** Session 035 / build 188 — pre-computed per-bucket aggregates summed
     *  across the time-range window. Optional; populated only for edge
     *  types where the underlying SPL emits the field. Surfaced in
     *  session 036's right-pane Performance tab. */
    errorCount?: number;
    /** Build 224 / session 037 — first-class warning bucket count for
     *  hana_tenant edges (counts events where hana_trace_severity="WARNING"
     *  OR hana_op_duration_ms > 1000, excluding ERROR/FATAL events).
     *  Replaces the build-211 "25% of clean calls move to warning when
     *  hanaOpMaxMs > 1000" heuristic. Optional because non-hana_tenant
     *  edges don't emit it. */
    warningCount?: number;
    responseTimeP50?: number;
    responseTimeP95?: number;
    responseTimeMax?: number;
    bytesOutSum?: number;
    hanaOpP95Ms?: number;
    hanaOpMaxMs?: number;
    authSuccessCount?: number;
    authFailCount?: number;
    /** Build 325 / session 110 (plan item E3) — RFC edges only: the
     *  per-app-server split of this rendered edge's member rows, grouped by
     *  the stored `local_ip` (the address of the gateway that wrote the
     *  record — the SAP system's side of the connection; the build-325 key
     *  change projects it onto RFC rows). Sums to `callCount` by
     *  construction. Rows that carry no address group under `localIp: null`:
     *  since build 378 these are the connection records (a remote-gateway
     *  connection closed, a client session closed), whose log lines name no
     *  local address. Absent on non-RFC edges. */
    appServers?: EdgeAppServerRow[];
}

/** Tuple counted in the bottom Live Activity table. */
export interface ActivityRow {
    id: string;
    sourceSid: string;
    direction: 'client' | 'server';
    partner: string;
    callCount: number;
}

/** Per-user persisted node positions + zone sizes + collapsed flags. */
export interface PanelLayoutState {
    leftWidth: number;
    rightWidth: number;
    bottomHeight: number;
    leftCollapsed: boolean;
    rightCollapsed: boolean;
    bottomCollapsed: boolean;
}

/** ReactFlow viewport state captured on save and re-applied on load.
 *  All three numbers are doubles — no rounding. Build 169 / session 028. */
export interface ViewportState {
    x: number;
    y: number;
    zoom: number;
}

export interface SavedLayout {
    version: 5;
    savedAt: string;
    /** User-visible layout name. Optional for read-back of legacy localStorage
     *  entries that pre-date the named-layouts feature (build 120 / A.4) —
     *  the migration helper promotes them to "Default" on first KV Store sync. */
    layoutName?: string;
    nodes: { id: string; x: number; y: number }[];
    panels: PanelLayoutState;
    /* v4 fields (build 169 / session 028) — restore additional viewport &
     * control state on load so a saved layout reproduces the user's session
     * more completely. All optional. */
    /** ReactFlow viewport (zoom + pan). Default = ReactFlow's `fitView`. */
    viewport?: ViewportState;
    /** Integration-type filter checkboxes — the ENABLED IntegrationType
     *  values (e.g. ['rfc','web_service']). Default = all active. */
    enabledTypes?: string[];
    /** Build 378 — the integration types that existed when the layout was
     *  saved (ALL_INTEGRATION_TYPES at save time). Loading a layout enables
     *  every type it could not have known about, and honours an unchecked
     *  box for a type it did know (restoreEnabledTypes in persistence.ts).
     *  Absent on layouts saved before build 378: those knew exactly the
     *  frozen eight (LEGACY_INTEGRATION_TYPES_V5). */
    knownTypes?: string[];
    /** Selected node id for the right-sidebar Details panel. Default = null
     *  (nothing selected). */
    selectedNodeId?: string | null;
    /** Right-sidebar active tab id. Default = 'overview'. */
    rightTabId?: string;
    /** Snap-to-grid toggle (toolbar). Default = false. */
    snapMode?: boolean;
    /* v5 field (build 188 / session 035 — foundation for session 036
     * edge-data right pane). Selected edge id for the right-sidebar
     * Edge Details panel. Default null. Mutually exclusive with
     * selectedNodeId — selecting one clears the other (enforced at the
     * IntegrationTopology level, not in the persisted schema). v4
     * records are wiped on first v5 read; users re-save once. */
    selectedEdgeId?: string | null;
    /* Build 215 / session 036 — the layout algorithm (Force / Layered /
     * Tree) that produced the saved node positions. Loading a layout
     * restores both the positions AND the algorithm so the saved blob
     * (Force) doesn't get inappropriately applied in Layered/Tree mode.
     * Optional for backward compat with v5 records saved before
     * build 215 — those default to 'force' on load. The string union
     * is duplicated here to avoid an import cycle between
     * topology/types and topology/layout. Adding a new layout mode
     * needs to add a new option here and in layout.ts's LayoutMode. */
    layoutMode?: 'force' | 'layered' | 'tree';
}

export const DEFAULT_PANEL_LAYOUT: PanelLayoutState = {
    leftWidth: 240,
    rightWidth: 320,
    /* 220 → 300 in build 280 (session 081): the default Live Activity
     * height showed only ~5 of the 8 partner rows. 300 px shows ~7-8 with
     * the panel's new internal scroll covering the rest; saved layouts
     * keep whatever height the user persisted (the expand gesture floors
     * a smaller saved height up to this default — see toggleBottom). */
    bottomHeight: 300,
    leftCollapsed: false,
    rightCollapsed: false,
    bottomCollapsed: false,
};
