import { logservTheme } from '../styles/logservTheme';
import type { IntegrationType, TopologyEdge } from './types';

/**
 * Edge styling helpers — keep all integration-type → color / thickness /
 * dasharray decisions in one place so the legend (TopologyToolbar) and the
 * actual rendered edges (TopologyGraph) stay in sync.
 */

export const edgeColor = (type: IntegrationType): string => {
    switch (type) {
        case 'rfc':         return logservTheme.colors.teal;       // sync RFC — primary positive flow
        case 'idoc':        return logservTheme.colors.cyanAccent; // async iDoc
        case 'qrfc':        return logservTheme.colors.orange;     // queued
        case 'trfc':        return logservTheme.colors.yellow;     // transactional
        case 'bgrfc':       return logservTheme.colors.purple;     // background
        case 'web_service': return logservTheme.colors.redLight;   // SOAP/REST
        case 'odata':       return logservTheme.colors.cyanLight;  // OData / Gateway
        case 'btp_iflow':   return logservTheme.colors.orangeLight;// BTP iFlow / CPI
        default:            return logservTheme.colors.textMuted;
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
): { stroke: string; strokeWidth: number; strokeDasharray?: string; animated: boolean } => {
    const stroke = edgeColor(edge.type);
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
