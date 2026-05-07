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
    | 'DB'            // Database (HANA / Oracle / MSSQL / Postgres / etc.) — visual override to render a cylinder icon
    | 'EXT';          // External / non-SAP

export interface TopologyNode {
    id: string;
    label: string;
    kind: NodeKind;
    tag: SystemTag;
    eventCount: number;
    /** Optional health percentage (0-100) — drives the red/green halo on focused SIDs. */
    healthPct?: number;
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
    version: 4;
    savedAt: string;
    /** User-visible layout name. Optional for read-back of legacy localStorage
     *  entries that pre-date the named-layouts feature (build 120 / A.4) —
     *  the migration helper promotes them to "Default" on first KV Store sync. */
    layoutName?: string;
    nodes: { id: string; x: number; y: number }[];
    panels: PanelLayoutState;
    /* All fields below are v4 additions (build 169 / session 028) — every
     * one is optional so a v3 record stays readable. When undefined, the
     * consumer falls back to the dashboard's current default behavior. */
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
}

export const DEFAULT_PANEL_LAYOUT: PanelLayoutState = {
    leftWidth: 240,
    rightWidth: 320,
    bottomHeight: 220,
    leftCollapsed: false,
    rightCollapsed: false,
    bottomCollapsed: false,
};
