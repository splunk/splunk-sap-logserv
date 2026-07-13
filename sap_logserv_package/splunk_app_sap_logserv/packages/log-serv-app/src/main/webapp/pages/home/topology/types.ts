/**
 * Environment Topology — domain types.
 *
 * Phase 1 (session 023): static fixture data shaped to these types.
 * Phase 2 (session 024): real SPL aggregations marshalled into the same shape.
 */

export type IntegrationType =
    | 'rfc'           // Remote Function Call (sync)
    | 'idoc'          // Intermediate Document (async)
    | 'qrfc'          // Queued RFC
    | 'trfc'          // Transactional RFC
    | 'bgrfc'         // Background RFC
    | 'web_service'   // SOAP / REST web service
    | 'odata'         // OData / Gateway
    | 'btp_iflow';    // BTP iFlow / CPI

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
    | 'EXT';          // External / non-SAP

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
    /** Optional health percentage (0-100) — drives the red/green halo on focused SIDs. */
    healthPct?: number;
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

export interface TopologyEdge {
    id: string;
    source: string;
    target: string;
    type: IntegrationType;
    /** Direction ranked from the source node's perspective. */
    direction: 'client' | 'server' | 'bidi';
    callCount: number;
    /** Optional business-process tag for filtering. */
    process?: BusinessProcess;
    /** Session 035 / build 188 — preserves the canonical SPL-emitted edge
     *  type ('http' | 'rfc' | 'hana_audit' | 'hana_tenant') alongside the
     *  legacy IntegrationType (which the visual layer uses for coloring).
     *  Session 036's edge-data right pane dispatches on this for per-type
     *  tab content. Optional to keep fixture-data + non-KV-Store callers
     *  type-clean. */
    splType?: 'http' | 'rfc' | 'hana_audit' | 'hana_tenant';
    /** Session 035 / build 188 — canonical SPL filter clauses for raw-event
     *  drilldown, denormalized from the KV Store edge bucket row's
     *  `spl_filter_clauses` JSON-encoded array. Session 036 right-pane tabs
     *  splice these clauses into per-edge SPL queries. */
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
    icmTasksMax?: number;
    icmTasksAvg?: number;
    hanaOpP95Ms?: number;
    hanaOpMaxMs?: number;
    authSuccessCount?: number;
    authFailCount?: number;
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
    /** Integration-type filter checkboxes (e.g. ['rfc-sync','idoc-async']).
     *  Default = all 8 active. */
    enabledTypes?: string[];
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
