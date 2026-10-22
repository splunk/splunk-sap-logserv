import type { ColorTokens } from '../styles/magneticTokens';
import type { EdgeSplType, IntegrationType, TopologyEdge } from './types';

/**
 * Edge styling helpers — keep all integration-type → color / thickness /
 * dasharray decisions in one place so the legend (TopologyToolbar) and the
 * actual rendered edges (TopologyGraph) stay in sync.
 *
 * Phase 0 Magnetic re-theme (build 246): the helpers take the RESOLVED
 * color tokens (`useThemeMode().tokens`) as a parameter instead of
 * importing logservTheme. Edge colors feed @xyflow/react's
 * `markerEnd.color` (SVG marker plumbing) and the MiniMap, where CSS
 * var(--lsv-*) references don't resolve — literal hex is required. Passing
 * tokens per-call also makes edges re-color automatically on mode flips
 * (callers re-render when the ThemeModeProvider context changes).
 *
 * Build 378: the SAP Router type, and the per-stored-type helpers the right
 * pane reads (splTypeLabel / splTypeColorToken / edgeMeasureLabels /
 * edgeOperationsNoun / edgePerformanceCaption) moved here from the sidebar,
 * so the consistency suite can hold them next to the graph's own colour.
 */

/** The colour token of the SAP Router edge type — ONE name, read by the graph
 *  and legend (edgeColor) and by the right pane's type badge
 *  (splTypeColorToken), so the two can never disagree. Every other edge
 *  legend token is taken (and light-mode orangeLight == yellow already
 *  collide), red and green carry the health ring's meaning, and cyanLight is
 *  the selected-edge stroke; surfaceInverse (charcoal on light, pale
 *  blue-grey on dark) is the token furthest from all of them in both modes —
 *  utils/topologyTypes.consistency-test.ts measures it. */
export const SAPROUTER_EDGE_TOKEN = 'surfaceInverse' as const;

export const edgeColor = (type: IntegrationType, c: ColorTokens): string => {
    switch (type) {
        case 'rfc':         return c.teal;        // sync RFC — primary positive flow
        case 'idoc':        return c.cyanAccent;  // async iDoc
        case 'qrfc':        return c.orange;      // queued
        case 'trfc':        return c.yellow;      // transactional
        case 'bgrfc':       return c.purple;      // background
        case 'web_service': return c.redLight;    // SOAP/REST
        case 'odata':       return c.cyanLight;   // OData / Gateway
        case 'btp_iflow':   return c.orangeLight; // BTP iFlow / CPI
        case 'saprouter':   return c[SAPROUTER_EDGE_TOKEN]; // SAP Router (build 378)
        default:            return c.textMuted;
    }
};

export const integrationTypeLabel = (type: IntegrationType): string => {
    switch (type) {
        case 'rfc':         return 'RFC (sync)';
        case 'idoc':        return 'iDoc (async)';
        case 'qrfc':        return 'qRFC (queued)';
        case 'trfc':        return 'tRFC (transactional)';
        case 'bgrfc':       return 'bgRFC (background)';
        case 'web_service': return 'Web service / SOAP';
        case 'odata':       return 'OData / Gateway';
        case 'btp_iflow':   return 'BTP iFlow / CPI';
        case 'saprouter':   return 'SAP Router';
        default:            return String(type);
    }
};

/** Map call volume → stroke width in px (1.0 to 5.0). Log scale. */
export const edgeThickness = (callCount: number): number => {
    if (callCount <= 0) return 1;
    const logged = Math.log10(callCount); // ~1 (10) to ~7 (10M)
    const clamped = Math.max(1, Math.min(7, logged));
    return 1 + (clamped - 1) * 0.7; // 1.0 .. ~5.2
};

export const formatCallCount = (n: number): string => {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
    return n.toLocaleString();
};

/**
 * Compute the marker ID + style overrides for an edge. Direction:
 *   - client:  solid line, arrow at target end
 *   - server:  dashed line, arrow at source end (visualized as reversed)
 *   - bidi:    solid line, arrows at both ends
 */
export const edgeStyleFor = (
    edge: TopologyEdge,
    c: ColorTokens,
): { stroke: string; strokeWidth: number; strokeDasharray?: string; animated: boolean } => {
    const stroke = edgeColor(edge.type, c);
    const strokeWidth = edgeThickness(edge.callCount);
    const strokeDasharray = edge.direction === 'server' ? '6,4' : undefined;
    // Animate the highest-volume edges to draw the eye to traffic hot spots.
    const animated = edge.callCount >= 1_000_000;
    return { stroke, strokeWidth, strokeDasharray, animated };
};

/** All integration types in display order (used by the filter chip list). */
export const ALL_INTEGRATION_TYPES: IntegrationType[] = [
    'rfc',
    'idoc',
    'qrfc',
    'trfc',
    'bgrfc',
    'web_service',
    'odata',
    'btp_iflow',
    'saprouter',
];

/**
 * Map the stored edge type (`logserv_topology_edges.type`) onto the
 * IntegrationType the graph, legend and filters use. The stored type is kept
 * on the edge as `splType` for the right pane's per-type tabs. HTTP and HANA
 * Audit edges draw as 'web_service' and HANA Tenant edges as 'rfc' — the
 * long-standing mapping, unchanged (re-basing the legend on the stored types
 * was option U2, not taken). SAP Router edges draw as their own type.
 * Moved here from useTopologyData in build 378 so it can be tested.
 */
export const splTypeToIntegrationType = (splType: EdgeSplType | string): IntegrationType => {
    switch (splType) {
        case 'http': return 'web_service';
        case 'rfc': return 'rfc';
        case 'hana_audit': return 'web_service';
        case 'hana_tenant': return 'rfc';
        case 'saprouter': return 'saprouter';
        default: return 'rfc';
    }
};

/* ---------------------------------------------------------------------------
 * The right pane's per-stored-type text and colour (build 378: moved from
 * TopologyRightSidebar, which delegates here). The four pre-378 types return
 * exactly the strings and tokens the sidebar used before.
 * ------------------------------------------------------------------------ */

/** The right pane's name for a stored edge type (type badge, facts row, the
 *  Hosts tab's edge-type rows, the bidirectional note). */
export const splTypeLabel = (splType: string | undefined): string => {
    switch (splType) {
        case 'http': return 'HTTP';
        case 'rfc': return 'RFC';
        case 'hana_audit': return 'HANA Audit';
        case 'hana_tenant': return 'HANA Tenant';
        case 'saprouter': return 'SAP Router';
        default: return splType ?? 'unknown';
    }
};

/** The colour token of the right pane's type badge. SAP Router uses the
 *  graph's own token (SAPROUTER_EDGE_TOKEN); the other four keep the pane's
 *  long-standing scheme (which colours by stored type, not by the legend). */
export const splTypeColorToken = (splType: string | undefined): keyof ColorTokens => {
    switch (splType) {
        case 'http': return 'cyanAccent';
        case 'rfc': return 'teal';
        case 'hana_audit': return 'orange';
        case 'hana_tenant': return 'purple';
        case 'saprouter': return SAPROUTER_EDGE_TOKEN;
        default: return 'textMuted';
    }
};

/** What an edge type's call_count and error_count count, as the Edge Details
 *  pane names them. */
export interface EdgeMeasureLabels {
    /** The noun after the count in the pane header ("1,234 calls"). */
    unit: string;
    /** Overview facts row for call_count. */
    countRow: string;
    /** Overview facts row for error_count. */
    errorRow: string;
    /** Activity tab caption. */
    perHourCaption: string;
    /** Activity legend: the part of call_count that is not an error. */
    okLegend: string;
    /** Activity legend: error_count. */
    errLegend: string;
}

/**
 * Build 378: an RFC edge counts CONNECTIONS (connection records plus distinct
 * broken connections; the gateway trace records no individual calls), and its
 * errors are the broken connections, a subset of them. A SAP Router edge
 * counts the router's routed connections (CONNECT TO lines) and the failed
 * server-side connections toward the same target (NiBufReceive failures),
 * counted from separate log lines. HTTP and the HANA types keep "calls".
 */
export const edgeMeasureLabels = (splType: string | undefined): EdgeMeasureLabels => {
    switch (splType) {
        case 'rfc':
            return {
                unit: 'connections',
                countRow: 'Connections in window',
                errorRow: 'Broken connections',
                perHourCaption: 'Connections + broken connections per hour',
                okLegend: 'Closed normally',
                errLegend: 'Broken connections',
            };
        case 'saprouter':
            return {
                unit: 'routed connections',
                countRow: 'Routed connections in window',
                errorRow: 'Failed connections',
                perHourCaption: 'Routed + failed connections per hour',
                okLegend: 'Routed without a failure',
                errLegend: 'Failed connections',
            };
        case 'hana_audit':
            return {
                unit: 'calls',
                countRow: 'Calls in window',
                errorRow: 'Auth failures (CONNECT)',
                perHourCaption: 'Calls + errors per hour',
                okLegend: 'Successful calls',
                errLegend: 'Errors',
            };
        default:
            return {
                unit: 'calls',
                countRow: 'Calls in window',
                errorRow: 'Errors in window',
                perHourCaption: 'Calls + errors per hour',
                okLegend: 'Successful calls',
                errLegend: 'Errors',
            };
    }
};

/** The word under a donut's centre total. The 64 px hole holds one short
 *  word at 9 px, so a two-word unit keeps its noun: "routed connections"
 *  reads "connections" there (the wedge hover text keeps the full unit).
 *  An empty unit reads "calls", the donut's default. */
export const donutCentreUnit = (unit: string): string => {
    const words = unit.trim().split(/\s+/).filter((w) => w.length > 0);
    return words.length > 0 ? words[words.length - 1] : 'calls';
};

/**
 * Build 380: what a count over several edge types counts - a node pane donut
 * adds up all of one direction's edges. `unit` follows the count in captions
 * and wedge hover text; `centre` is the one short word under the donut's
 * total. One type keeps its own unit (a SAP Router-only donut counts "routed
 * connections"); RFC and SAP Router together count "connections"; calls and
 * connections together are "calls + connections", the panel's facts-table
 * wording since build 379, whose centre word is "total" (the last word,
 * "connections", would misname the calls). No type at all reads "calls", the
 * donut's default; an edge without a type counts calls.
 */
export const combinedMeasureUnit = (
    splTypes: readonly (string | undefined)[],
): { unit: string; centre: string } => {
    const units = Array.from(new Set(splTypes.map((t) => edgeMeasureLabels(t || undefined).unit))).sort();
    if (units.length === 0) return { unit: 'calls', centre: 'calls' };
    if (units.length === 1) return { unit: units[0], centre: donutCentreUnit(units[0]) };
    if (units.every((u) => donutCentreUnit(u) === 'connections')) return { unit: 'connections', centre: 'connections' };
    return { unit: 'calls + connections', centre: 'total' };
};

/** Operations tab: what the top entities of the edge_op metric are. */
export const edgeOperationsNoun = (splType: string | undefined): string => {
    switch (splType) {
        case 'http': return 'URIs';
        case 'rfc': return 'remote services / client programs';
        case 'hana_audit': return 'action types';
        case 'hana_tenant': return 'trace components';
        case 'saprouter': return 'target services';
        default: return 'entities';
    }
};

/** Performance tab: the caption of the edge_perf distribution. */
export const edgePerformanceCaption = (splType: string | undefined): string => {
    switch (splType) {
        case 'http': return 'Status class distribution';
        case 'rfc': return 'Connection record mix';
        case 'hana_audit': return 'Action status mix';
        case 'hana_tenant': return 'hdbcons command duration (avg + max)';
        case 'saprouter': return 'Target role mix';
        default: return 'Distribution';
    }
};

/**
 * Share of an edge's or a node's traffic that failed, in [0, 1]. The SAP
 * Router arm counts failures from separate log lines (Demo Gen samples them
 * independently of the CONNECT TO lines), so an hour can hold failures and
 * no routed connection: such an edge is 100 % failed, never NaN or above 1.
 */
export const failureRate = (total: number, errors: number): number => {
    if (total > 0) return Math.min(1, Math.max(0, errors) / total);
    return errors > 0 ? 1 : 0;
};
