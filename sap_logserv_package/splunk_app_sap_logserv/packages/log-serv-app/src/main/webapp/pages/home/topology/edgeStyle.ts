import type { ColorTokens } from '../styles/magneticTokens';
import type { IntegrationType, TopologyEdge } from './types';

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
 */

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
];
