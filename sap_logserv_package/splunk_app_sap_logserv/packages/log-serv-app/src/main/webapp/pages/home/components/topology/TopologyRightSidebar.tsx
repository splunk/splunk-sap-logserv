import React, { useCallback, useState } from 'react';
import styled from 'styled-components';
import FramedPanel from '../FramedPanel';
import { logservTheme } from '../../styles/logservTheme';
import { darken } from '../../utils/colorMath';
import { formatCallCount } from '../../topology/edgeStyle';
import type { TopologyNode, TopologyEdge } from '../../topology/types';
import { isDatabaseTag } from '../../topology/types';
import type { NodeError, NodeHost } from '../../hooks/useNodeData';
import type { UseEdgeDataResult } from '../../hooks/useEdgeData';

/**
 * Right sidebar — selected-node details.
 *
 * Empty state: prompt the user to click a node.
 * Selected state: show identity card + tabbed content:
 *   - Overview: per-node hourly bar chart + top partners donut (real SPL data)
 *   - Top Programs: per-node `icm_program` donut + legend (real SPL data)
 *   - Errors: per-node error breakdown by sourcetype + error_kind (real SPL data,
 *     wired in build 118 / session 024)
 *   - Hosts: per-node host inventory with first/last-seen + sourcetype count
 *     (real SPL data, wired in build 118 / session 024)
 *
 * Chart visuals are hand-rolled SVG to avoid pulling Splunk-viz into the
 * lazy chunk. Color + dark-on-dark choices match TimeSeriesChart / PieChart
 * conventions used elsewhere in the app.
 */

const Stack = styled.div`
    display: flex;
    flex-direction: column;
    gap: ${logservTheme.spacing.md};
`;

const EmptyMsg = styled.div`
    color: ${logservTheme.colors.textMuted};
    font-size: ${logservTheme.fontSize.body};
    line-height: 1.5;
    padding: ${logservTheme.spacing.md} 0;
`;

const NodeIdRow = styled.div`
    display: flex;
    align-items: center;
    gap: ${logservTheme.spacing.sm};
    margin-bottom: ${logservTheme.spacing.sm};
`;

const SidBadge = styled.div<{ $kind: TopologyNode['kind'] }>`
    background: ${(p) => (p.$kind === 'sid_focused' ? logservTheme.colors.red : logservTheme.colors.cyanAccent)};
    color: ${logservTheme.colors.textActive};
    padding: 4px 8px;
    border-radius: ${logservTheme.radius.small};
    font-weight: ${logservTheme.fontWeight.bold};
    font-size: ${logservTheme.fontSize.large};
    letter-spacing: 0.5px;
`;

const KindChip = styled.span<{ $kind: TopologyNode['kind'] }>`
    background: ${logservTheme.colors.tableHeaderBackground};
    color: ${(p) => (p.$kind === 'sid_focused' ? logservTheme.colors.red : logservTheme.colors.cyanLight)};
    border: 1px solid ${(p) => (p.$kind === 'sid_focused' ? logservTheme.colors.red : logservTheme.colors.cyanAccent)};
    padding: 2px 6px;
    border-radius: 3px;
    font-size: 10px;
    font-weight: ${logservTheme.fontWeight.semibold};
    letter-spacing: 0.5px;
`;

const TabBar = styled.div`
    display: flex;
    gap: 0;
    border-bottom: 1px solid ${logservTheme.colors.panelBorderWeak};
    margin-bottom: ${logservTheme.spacing.md};
`;

const Tab = styled.button<{ $active: boolean }>`
    background: transparent;
    color: ${(p) => (p.$active ? logservTheme.colors.cyanLight : logservTheme.colors.textMuted)};
    border: none;
    border-bottom: 2px solid ${(p) => (p.$active ? logservTheme.colors.cyanAccent : 'transparent')};
    padding: 6px 8px;
    font-size: 11px;
    font-weight: ${logservTheme.fontWeight.semibold};
    font-family: inherit;
    cursor: pointer;
    margin-bottom: -1px;

    &:hover {
        color: ${logservTheme.colors.cyanLight};
    }

    &:focus {
        outline: 2px solid ${logservTheme.colors.cyanAccent};
        outline-offset: -2px;
    }
`;

const FactsTable = styled.table`
    width: 100%;
    font-size: ${logservTheme.fontSize.small};
    border-collapse: collapse;

    td {
        padding: 3px 0;
    }
    td.k {
        color: ${logservTheme.colors.textMuted};
        text-transform: uppercase;
        letter-spacing: 0.4px;
        font-size: 10px;
        width: 38%;
    }
    td.v {
        color: ${logservTheme.colors.textActive};
        font-weight: ${logservTheme.fontWeight.semibold};
        text-align: right;
        font-variant-numeric: tabular-nums;
    }
`;

const ChartCaption = styled.div`
    color: ${logservTheme.colors.textMuted};
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    margin-bottom: 4px;
`;

const StubNote = styled.div`
    color: ${logservTheme.colors.textMuted};
    font-size: 11px;
    font-style: italic;
    padding: ${logservTheme.spacing.md} 0;
`;

/**
 * Compact 3-column data table tuned for the narrow right sidebar
 * (220–520 px wide). Each row groups a primary line (active) and an
 * optional secondary line (muted). Wraps long primary identifiers onto
 * the next line via word-break rather than truncating with ellipsis —
 * users want the full host / sourcetype name visible at a glance.
 */
const DataTable = styled.table`
    width: 100%;
    font-size: 11px;
    border-collapse: collapse;
    table-layout: fixed;

    th {
        text-align: left;
        text-transform: uppercase;
        letter-spacing: 0.4px;
        font-size: 10px;
        font-weight: ${logservTheme.fontWeight.semibold};
        color: ${logservTheme.colors.textMuted};
        padding: 4px 4px 6px;
        border-bottom: 1px solid ${logservTheme.colors.panelBorderWeak};
    }
    th.num {
        text-align: right;
    }

    tbody tr {
        border-bottom: 1px solid ${logservTheme.colors.panelBorderWeak};
    }
    tbody tr:last-child {
        border-bottom: none;
    }

    td {
        padding: 5px 4px;
        vertical-align: top;
    }
    td.primary {
        color: ${logservTheme.colors.textActive};
        font-weight: ${logservTheme.fontWeight.semibold};
        word-break: break-all;
    }
    td.secondary {
        color: ${logservTheme.colors.textMuted};
        font-size: 10px;
        font-family: monospace;
        word-break: break-all;
    }
    td.num {
        color: ${logservTheme.colors.textActive};
        text-align: right;
        font-variant-numeric: tabular-nums;
        font-weight: ${logservTheme.fontWeight.semibold};
        white-space: nowrap;
    }
    td.relTime {
        color: ${logservTheme.colors.textMuted};
        font-size: 10px;
        text-align: right;
        white-space: nowrap;
    }

    .errBucket {
        color: ${logservTheme.colors.red};
        font-size: 10px;
        font-family: monospace;
    }
`;

const TableScroll = styled.div`
    /* Vertical scroll inside the panel when the row count exceeds the
     * visible space — caps growth so the toolbar/tabs don't push offscreen. */
    max-height: 380px;
    overflow-y: auto;
    margin-top: ${logservTheme.spacing.sm};
`;

/**
 * Compact relative-time formatter. Returns strings like "2m ago", "3h ago",
 * "5d ago", "—" if the epoch is 0/falsy. Uses now() at call time so values
 * shift naturally over time even without a re-render (good enough for a
 * data table — admins re-click or refresh anyway).
 */
const formatRelative = (epochSec: number): string => {
    if (!epochSec || !Number.isFinite(epochSec)) return '—';
    const nowSec = Math.floor(Date.now() / 1000);
    const delta = nowSec - epochSec;
    if (delta < 0) return 'just now';
    if (delta < 60) return `${delta}s ago`;
    if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
    if (delta < 86400) return `${Math.floor(delta / 3600)}h ago`;
    if (delta < 86400 * 30) return `${Math.floor(delta / 86400)}d ago`;
    if (delta < 86400 * 365) return `${Math.floor(delta / 86400 / 30)}mo ago`;
    return `${Math.floor(delta / 86400 / 365)}y ago`;
};

/** Strip the redundant `sap:` prefix from a sourcetype label so it fits in
 *  the narrow column without ellipsis. `sap:webdispatcher:access` -> `webdispatcher:access`. */
const shortSourcetype = (st: string): string => {
    if (!st) return '';
    return st.startsWith('sap:') ? st.slice(4) : st;
};

/** Color palette for top-partner donut wedges — rotated through deterministically. */
const PARTNER_PALETTE = [
    logservTheme.colors.teal,
    logservTheme.colors.cyanAccent,
    logservTheme.colors.orange,
    logservTheme.colors.purple,
    logservTheme.colors.cyanLight,
    logservTheme.colors.orangeLight,
    logservTheme.colors.redLight,
    logservTheme.colors.textMuted,
];

/**
 * Hand-rolled SVG bar chart — calls/hour for the last 24 hours.
 * Build 203 / session 036 — converted to responsive width via viewBox so
 * the chart scales to fit the right sidebar regardless of its current
 * resize-handle width (220-520 px range). Same fix as ActivityTrendChart.
 */
const HourlyChart: React.FC<{ data: number[]; color: string }> = ({ data, color }) => {
    const VB_W = 240;
    const VB_H = 64;
    const max = Math.max(...data, 1);
    const barW = VB_W / data.length;
    return (
        <svg
            width="100%"
            height={VB_H}
            viewBox={`0 0 ${VB_W} ${VB_H}`}
            preserveAspectRatio="none"
            role="img"
            aria-label="Calls per hour, last 24h"
            style={{ display: 'block' }}
        >
            <defs>
                <linearGradient id="hourly-grad" x1="0" x2="0" y1="0" y2="1">
                    <stop offset="0%" stopColor={color} stopOpacity="1" />
                    <stop offset="100%" stopColor={darken(color, 0.4)} stopOpacity="1" />
                </linearGradient>
            </defs>
            {data.map((v, i) => {
                const h = Math.max(1, (v / max) * (VB_H - 4));
                return (
                    <rect
                        key={i}
                        x={i * barW + 0.5}
                        y={VB_H - h}
                        width={Math.max(1, barW - 1)}
                        height={h}
                        fill="url(#hourly-grad)"
                        rx={1}
                    />
                );
            })}
        </svg>
    );
};

/**
 * Hand-rolled SVG donut chart — top tcodes for the selected SID.
 * Slices proportional to count. Center hole shows total. ~120 px square.
 */
const DonutChart: React.FC<{ data: { code: string; count: number; color: string }[] }> = ({ data }) => {
    const W = 120;
    const cx = W / 2;
    const cy = W / 2;
    const r = 50;
    const innerR = 32;
    const total = data.reduce((s, d) => s + d.count, 0);
    let cum = 0;

    const arcPath = (start: number, end: number): string => {
        const a0 = (start * 2 * Math.PI) - Math.PI / 2;
        const a1 = (end * 2 * Math.PI) - Math.PI / 2;
        const x0 = cx + r * Math.cos(a0);
        const y0 = cy + r * Math.sin(a0);
        const x1 = cx + r * Math.cos(a1);
        const y1 = cy + r * Math.sin(a1);
        const xi0 = cx + innerR * Math.cos(a0);
        const yi0 = cy + innerR * Math.sin(a0);
        const xi1 = cx + innerR * Math.cos(a1);
        const yi1 = cy + innerR * Math.sin(a1);
        const large = (end - start) > 0.5 ? 1 : 0;
        return `M ${x0} ${y0} A ${r} ${r} 0 ${large} 1 ${x1} ${y1} L ${xi1} ${yi1} A ${innerR} ${innerR} 0 ${large} 0 ${xi0} ${yi0} Z`;
    };

    return (
        <svg width={W} height={W} role="img" aria-label="Top tcodes by call volume">
            {data.map((d) => {
                const start = cum / total;
                const end = (cum + d.count) / total;
                cum += d.count;
                return <path key={d.code} d={arcPath(start, end)} fill={d.color} stroke={logservTheme.colors.panelBackground} strokeWidth={1} />;
            })}
            <text x={cx} y={cy - 2} textAnchor="middle" fontSize="11" fontWeight="600" fill={logservTheme.colors.textActive}>{formatCallCount(total)}</text>
            <text x={cx} y={cy + 12} textAnchor="middle" fontSize="9" fill={logservTheme.colors.textMuted}>calls</text>
        </svg>
    );
};

const DonutLegend = styled.ul`
    list-style: none;
    margin: 6px 0 0;
    padding: 0;
    font-size: 10.5px;

    li {
        display: flex;
        align-items: center;
        gap: 6px;
        color: ${logservTheme.colors.textDefault};
        padding: 1px 0;
    }
    .swatch {
        width: 9px;
        height: 9px;
        border-radius: 2px;
    }
    .code {
        flex: 1;
        font-family: monospace;
        font-size: 10px;
    }
    .count {
        color: ${logservTheme.colors.textMuted};
        font-variant-numeric: tabular-nums;
    }
`;

const ChartRow = styled.div`
    display: flex;
    gap: ${logservTheme.spacing.md};
    align-items: flex-start;
    margin-top: ${logservTheme.spacing.sm};
`;

const ChartBlock = styled.div`
    flex: 1;
    min-width: 0;
`;

/* Build 202 / session 036 — Edge Details panel-specific styled components. */

const EndpointCard = styled.div`
    background: ${logservTheme.colors.tableHeaderBackground};
    border: 1px solid ${logservTheme.colors.panelBorderWeak};
    border-radius: ${logservTheme.radius.small};
    padding: ${logservTheme.spacing.sm} ${logservTheme.spacing.md};
    display: flex;
    flex-direction: column;
    gap: 4px;
    flex: 1;
    min-width: 0;

    .epLabel {
        text-transform: uppercase;
        letter-spacing: 0.5px;
        font-size: 9.5px;
        color: ${logservTheme.colors.textMuted};
    }
    .epValue {
        font-size: 12px;
        font-weight: ${logservTheme.fontWeight.semibold};
        color: ${logservTheme.colors.textActive};
        word-break: break-all;
        line-height: 1.3;
    }
`;

const EndpointArrow = styled.div`
    align-self: center;
    color: ${logservTheme.colors.cyanAccent};
    font-size: 16px;
    font-weight: bold;
    padding: 0 4px;
`;

const EndpointRow = styled.div`
    display: flex;
    gap: ${logservTheme.spacing.sm};
    align-items: stretch;
    margin-bottom: ${logservTheme.spacing.md};
`;

const EdgeTypeBadge = styled.span<{ $color: string }>`
    display: inline-block;
    background: ${(p) => p.$color};
    color: ${logservTheme.colors.textActive};
    padding: 3px 10px;
    border-radius: ${logservTheme.radius.small};
    font-weight: ${logservTheme.fontWeight.bold};
    font-size: 10px;
    letter-spacing: 0.5px;
    text-transform: uppercase;
`;

const PerfMetric = styled.div`
    background: ${logservTheme.colors.tableHeaderBackground};
    border: 1px solid ${logservTheme.colors.panelBorderWeak};
    border-radius: ${logservTheme.radius.small};
    padding: 6px 10px;
    flex: 1;
    min-width: 0;

    .perfLabel {
        text-transform: uppercase;
        letter-spacing: 0.5px;
        font-size: 9.5px;
        color: ${logservTheme.colors.textMuted};
        line-height: 1.4;
    }
    .perfValue {
        font-size: 14px;
        font-weight: ${logservTheme.fontWeight.bold};
        color: ${logservTheme.colors.cyanLight};
        font-variant-numeric: tabular-nums;
        margin-top: 2px;
    }
`;

const PerfRow = styled.div`
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
    margin-bottom: ${logservTheme.spacing.sm};
`;

const ActivityChartWrap = styled.div`
    margin-top: ${logservTheme.spacing.sm};
    background: ${logservTheme.colors.tableHeaderBackground};
    border: 1px solid ${logservTheme.colors.panelBorderWeak};
    border-radius: ${logservTheme.radius.small};
    padding: 8px;
`;

const PerfBarRow = styled.div`
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 3px 0;
    font-size: 10.5px;

    .label {
        flex: 0 0 38%;
        color: ${logservTheme.colors.textActive};
        font-family: monospace;
        font-size: 10px;
        word-break: break-all;
    }
    .barOuter {
        flex: 1;
        height: 8px;
        background: ${logservTheme.colors.panelBackground};
        border-radius: 1px;
        overflow: hidden;
    }
    .barInner {
        height: 100%;
        background: ${logservTheme.colors.cyanAccent};
    }
    .num {
        flex: 0 0 60px;
        text-align: right;
        color: ${logservTheme.colors.textMuted};
        font-variant-numeric: tabular-nums;
    }
`;

const CollapseChevron = styled.button`
    background: transparent;
    color: ${logservTheme.colors.textMuted};
    border: 1px solid ${logservTheme.colors.panelBorderWeak};
    border-radius: ${logservTheme.radius.small};
    width: 22px;
    height: 22px;
    cursor: pointer;
    font-size: 12px;
    font-weight: ${logservTheme.fontWeight.bold};
    font-family: inherit;
    line-height: 1;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0;

    &:hover {
        color: ${logservTheme.colors.cyanLight};
        border-color: ${logservTheme.colors.cyanAccent};
    }

    &:focus {
        outline: 2px solid ${logservTheme.colors.cyanAccent};
        outline-offset: -2px;
    }
`;

interface TopologyRightSidebarProps {
    selectedNode: TopologyNode | null;
    selectedNodeIncomingEdges: TopologyEdge[];
    selectedNodeOutgoingEdges: TopologyEdge[];
    /** Per-node hourly call counts (24h) from useNodeData. null when no
     *  selection or the search hasn't returned yet. */
    nodeHourly: number[] | null;
    /** True while the per-node hourly search is in flight. */
    nodeHourlyLoading: boolean;
    /** Per-node Top Programs (icm_program field, follows global TimeRange). */
    nodePrograms: { program: string; count: number }[] | null;
    nodeProgramsLoading: boolean;
    /** Per-node error rollup (status>=400 / severity=ERROR / gw_error_detail / error_function),
     *  follows global TimeRange. */
    nodeErrors: NodeError[] | null;
    nodeErrorsLoading: boolean;
    /** Per-node host inventory (Splunk default `host` field), follows global TimeRange. */
    nodeHosts: NodeHost[] | null;
    nodeHostsLoading: boolean;
    /** Build 202 / session 036 — per-edge selection.
     *  When non-null, the sidebar swaps from the 4-tab Node Details panel to
     *  the 5-tab Edge Details panel. Mutex with selectedNode is enforced at
     *  the IntegrationTopology dashboard level. */
    selectedEdge?: TopologyEdge | null;
    /** Build 202 / session 036 — full topology nodes list, used to resolve
     *  edge.source / edge.target ids back to human-readable labels for the
     *  Overview tab's source/target identity cards. */
    edgeNodes?: TopologyNode[];
    /** Build 202 / session 036 — per-edge SPL data for the Activity /
     *  Operations / Performance / Errors tabs. Activity Trend timechart,
     *  Operations top-10, Performance distribution, Errors top-15. Hook
     *  returns null fields when no edge is selected. */
    edgeData?: UseEdgeDataResult;
    /** Optional collapse handler — renders a "›" chevron in the details header. */
    onCollapse?: () => void;
    /** Optional controlled tab state (build 169 / session 028) — when provided
     *  by the parent, the sidebar's tab is fully controlled. When undefined,
     *  the sidebar falls back to its own internal state, preserving existing
     *  caller behavior. Used by the layout-restore feature so a saved layout's
     *  `rightTabId` can be applied on load. */
    tab?: RightTab;
    /** Companion setter when `tab` is controlled. */
    onTabChange?: (next: RightTab) => void;
    /** Build 202 / session 036 — controlled edge tab state (parallel to tab/onTabChange
     *  for nodes). When undefined, the sidebar falls back to internal edge tab state. */
    edgeTab?: EdgeRightTab;
    /** Companion setter when `edgeTab` is controlled. */
    onEdgeTabChange?: (next: EdgeRightTab) => void;
}

export type RightTab = 'overview' | 'tcodes' | 'errors' | 'hosts';

/** Build 202 / session 036 — Edge Details right-pane tab IDs. */
export type EdgeRightTab = 'overview' | 'activity' | 'operations' | 'performance' | 'errors';

/**
 * Activity Trend stacked-area chart — calls + errors over time for the
 * selected edge, in the dispatched window. Renders TWO series stacked:
 * errors at the top (red) over successes (cyan-light) below.
 *
 * Build 203 / session 036 — converted from fixed 280×90 to responsive
 * `width: 100%` + `viewBox` so the chart scales to fit the right
 * sidebar's actual width (which can vary 220-520 px via the panel
 * resize handle, or be even narrower when the user has the sidebar
 * compressed). `preserveAspectRatio: none` lets the bars stretch
 * horizontally rather than the chart letterboxing.
 */
const ActivityTrendChart: React.FC<{
    data: { time: number; count: number; errorCount: number }[];
}> = ({ data }) => {
    const VB_W = 280;
    const VB_H = 90;
    if (data.length === 0) return null;
    const maxVal = Math.max(...data.map((d) => d.count), 1);
    const barW = VB_W / data.length;
    return (
        <svg
            width="100%"
            height={VB_H}
            viewBox={`0 0 ${VB_W} ${VB_H}`}
            preserveAspectRatio="none"
            role="img"
            aria-label="Edge activity trend"
            style={{ display: 'block' }}
        >
            <defs>
                <linearGradient id="activity-grad-success" x1="0" x2="0" y1="0" y2="1">
                    <stop offset="0%" stopColor={logservTheme.colors.cyanLight} stopOpacity="1" />
                    <stop offset="100%" stopColor={darken(logservTheme.colors.cyanLight, 0.4)} stopOpacity="1" />
                </linearGradient>
                <linearGradient id="activity-grad-error" x1="0" x2="0" y1="0" y2="1">
                    <stop offset="0%" stopColor={logservTheme.colors.red} stopOpacity="1" />
                    <stop offset="100%" stopColor={darken(logservTheme.colors.red, 0.4)} stopOpacity="1" />
                </linearGradient>
            </defs>
            {data.map((d, i) => {
                const totalH = Math.max(1, (d.count / maxVal) * (VB_H - 4));
                const errorH = Math.max(0, (d.errorCount / maxVal) * (VB_H - 4));
                const successH = Math.max(0, totalH - errorH);
                const successY = VB_H - totalH;
                const errorY = VB_H - errorH;
                return (
                    <g key={i}>
                        <rect
                            x={i * barW + 0.5}
                            y={successY}
                            width={Math.max(1, barW - 1)}
                            height={successH}
                            fill="url(#activity-grad-success)"
                            rx={1}
                        />
                        {errorH > 0 && (
                            <rect
                                x={i * barW + 0.5}
                                y={errorY}
                                width={Math.max(1, barW - 1)}
                                height={errorH}
                                fill="url(#activity-grad-error)"
                                rx={1}
                            />
                        )}
                    </g>
                );
            })}
        </svg>
    );
};

const formatLatency = (ms: number | undefined): string => {
    if (ms == null || !Number.isFinite(ms)) return '—';
    if (ms < 1) return `${ms.toFixed(2)} ms`;
    if (ms < 1000) return `${Math.round(ms)} ms`;
    return `${(ms / 1000).toFixed(2)} s`;
};

const formatBytes = (bytes: number | undefined): string => {
    if (bytes == null || !Number.isFinite(bytes)) return '—';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
};

const edgeTypeColor = (splType: string | undefined): string => {
    switch (splType) {
        case 'http': return logservTheme.colors.cyanAccent;
        case 'rfc': return logservTheme.colors.teal;
        case 'hana_audit': return logservTheme.colors.orange;
        case 'hana_tenant': return logservTheme.colors.purple;
        default: return logservTheme.colors.textMuted;
    }
};

const edgeTypeLabel = (splType: string | undefined): string => {
    switch (splType) {
        case 'http': return 'HTTP';
        case 'rfc': return 'RFC';
        case 'hana_audit': return 'HANA Audit';
        case 'hana_tenant': return 'HANA Tenant';
        default: return splType ?? 'unknown';
    }
};

const TopologyRightSidebar: React.FC<TopologyRightSidebarProps> = ({
    selectedNode,
    selectedNodeIncomingEdges,
    selectedNodeOutgoingEdges,
    nodeHourly,
    nodeHourlyLoading,
    nodePrograms,
    nodeProgramsLoading,
    nodeErrors,
    nodeErrorsLoading,
    nodeHosts,
    nodeHostsLoading,
    selectedEdge,
    edgeNodes,
    edgeData,
    onCollapse,
    tab: controlledTab,
    onTabChange,
    edgeTab: controlledEdgeTab,
    onEdgeTabChange,
}) => {
    const [internalTab, setInternalTab] = useState<RightTab>('overview');
    const tab = controlledTab ?? internalTab;
    const setTab = useCallback(
        (next: RightTab): void => {
            if (onTabChange) onTabChange(next);
            else setInternalTab(next);
        },
        [onTabChange],
    );
    const [internalEdgeTab, setInternalEdgeTab] = useState<EdgeRightTab>('overview');
    const edgeTab = controlledEdgeTab ?? internalEdgeTab;
    const setEdgeTab = useCallback(
        (next: EdgeRightTab): void => {
            if (onEdgeTabChange) onEdgeTabChange(next);
            else setInternalEdgeTab(next);
        },
        [onEdgeTabChange],
    );

    /** Resolve edge endpoint id back to a human-readable label by looking
     *  up the corresponding node in the edgeNodes list. Falls back to the
     *  raw id (SHA1[:16]) if no match. */
    const labelForEndpoint = useCallback(
        (id: string): string => {
            if (!edgeNodes) return id;
            const node = edgeNodes.find((n) => n.id === id);
            return node?.label ?? id;
        },
        [edgeNodes],
    );

    /** Top partners derived from in+out edges. Group by the OTHER endpoint
     *  (not the selected node), sum call counts, take top 4 + "OTHER".
     *  Build 205 / session 036 — resolve SHA1[:16] node ids back to human-
     *  readable labels via labelForEndpoint (looks up edgeNodes). Without
     *  this, the donut legend showed opaque hex strings like
     *  `d268d4a8e9919dd4` instead of the actual SID / IP / hostname. */
    const topPartners = React.useMemo(() => {
        if (!selectedNode) return [];
        const counts = new Map<string, number>();
        selectedNodeIncomingEdges.forEach((e) => {
            counts.set(e.source, (counts.get(e.source) ?? 0) + e.callCount);
        });
        selectedNodeOutgoingEdges.forEach((e) => {
            counts.set(e.target, (counts.get(e.target) ?? 0) + e.callCount);
        });
        const sorted = Array.from(counts.entries())
            .map(([id, count]) => ({ id, count }))
            .sort((a, b) => b.count - a.count);
        const top = sorted.slice(0, 4);
        const rest = sorted.slice(4);
        const restTotal = rest.reduce((s, r) => s + r.count, 0);
        const list = top.map((p, i) => ({
            code: labelForEndpoint(p.id),
            count: p.count,
            color: PARTNER_PALETTE[i],
        }));
        if (restTotal > 0) {
            list.push({
                code: `OTHER (${rest.length})`,
                count: restTotal,
                color: PARTNER_PALETTE[Math.min(top.length, PARTNER_PALETTE.length - 1)],
            });
        }
        return list;
    }, [selectedNode, selectedNodeIncomingEdges, selectedNodeOutgoingEdges, labelForEndpoint]);

    const collapseAction = onCollapse ? (
        <CollapseChevron type="button" onClick={onCollapse} title="Collapse panel" aria-label="Collapse details panel">
            {'›'}
        </CollapseChevron>
    ) : undefined;

    /* Build 202 / session 036 — Edge Details branch.
     * When an edge is selected (selectedEdge is non-null), render the 5-tab
     * Edge Details panel. Mutex with selectedNode is enforced at the
     * IntegrationTopology dashboard level — both can't be set at once. The
     * edge branch is checked BEFORE the node empty-state so an edge
     * selection without a node selection still renders the edge UI. */
    if (selectedEdge) {
        const sourceLabel = labelForEndpoint(selectedEdge.source);
        const targetLabel = labelForEndpoint(selectedEdge.target);
        const splType = selectedEdge.splType;
        const typeColor = edgeTypeColor(splType);
        const typeLabel = edgeTypeLabel(splType);
        const errorRate = selectedEdge.errorCount && selectedEdge.callCount > 0
            ? (selectedEdge.errorCount / selectedEdge.callCount) * 100
            : 0;

        return (
            <Stack>
                <FramedPanel title="Edge Details" actions={collapseAction}>
                    <EndpointRow>
                        <EndpointCard>
                            <span className="epLabel">Source</span>
                            <span className="epValue">{sourceLabel}</span>
                        </EndpointCard>
                        <EndpointArrow aria-hidden>→</EndpointArrow>
                        <EndpointCard>
                            <span className="epLabel">Target</span>
                            <span className="epValue">{targetLabel}</span>
                        </EndpointCard>
                    </EndpointRow>
                    <NodeIdRow>
                        <EdgeTypeBadge $color={typeColor}>{typeLabel}</EdgeTypeBadge>
                        <KindChip $kind="partner" style={{ color: typeColor, borderColor: typeColor }}>
                            {selectedEdge.direction.toUpperCase()}
                        </KindChip>
                        <span style={{ marginLeft: 'auto', fontSize: 11, color: logservTheme.colors.textMuted }}>
                            {selectedEdge.callCount.toLocaleString()} calls
                        </span>
                    </NodeIdRow>
                    <TabBar role="tablist" aria-label="Edge detail tabs">
                        {(['overview', 'activity', 'operations', 'performance', 'errors'] as EdgeRightTab[]).map((t) => (
                            <Tab
                                key={t}
                                type="button"
                                role="tab"
                                aria-selected={edgeTab === t}
                                $active={edgeTab === t}
                                onClick={() => setEdgeTab(t)}
                            >
                                {t === 'overview' ? 'Overview'
                                    : t === 'activity' ? 'Activity'
                                    : t === 'operations' ? 'Operations'
                                    : t === 'performance' ? 'Performance'
                                    : 'Errors'}
                            </Tab>
                        ))}
                    </TabBar>

                    {edgeTab === 'overview' && (
                        <>
                            <FactsTable>
                                <tbody>
                                    <tr><td className="k">Edge type</td><td className="v">{typeLabel}</td></tr>
                                    <tr><td className="k">Direction</td><td className="v">{selectedEdge.direction}</td></tr>
                                    <tr><td className="k">Calls in window</td><td className="v">{selectedEdge.callCount.toLocaleString()}</td></tr>
                                    <tr><td className="k">Errors in window</td><td className="v">{(selectedEdge.errorCount ?? 0).toLocaleString()}</td></tr>
                                    {selectedEdge.callCount > 0 && (
                                        <tr><td className="k">Error rate</td><td className="v">{errorRate.toFixed(2)}%</td></tr>
                                    )}
                                    {selectedEdge.splSourcetype && (
                                        <tr><td className="k">Sourcetype</td><td className="v">{shortSourcetype(selectedEdge.splSourcetype)}</td></tr>
                                    )}
                                </tbody>
                            </FactsTable>
                            {edgeData?.activity && edgeData.activity.length > 0 && (
                                <ActivityChartWrap>
                                    <ChartCaption>Activity over current time range</ChartCaption>
                                    <ActivityTrendChart data={edgeData.activity} />
                                    <DonutLegend style={{ marginTop: 6 }}>
                                        <li>
                                            <span className="swatch" style={{ background: logservTheme.colors.cyanLight }} />
                                            <span className="code">Successful calls</span>
                                            <span className="count">{
                                                edgeData.activity.reduce((s, p) => s + (p.count - p.errorCount), 0).toLocaleString()
                                            }</span>
                                        </li>
                                        <li>
                                            <span className="swatch" style={{ background: logservTheme.colors.red }} />
                                            <span className="code">Errors</span>
                                            <span className="count">{
                                                edgeData.activity.reduce((s, p) => s + p.errorCount, 0).toLocaleString()
                                            }</span>
                                        </li>
                                    </DonutLegend>
                                </ActivityChartWrap>
                            )}
                        </>
                    )}

                    {edgeTab === 'activity' && (
                        <>
                            {edgeData?.activityLoading && (
                                <EmptyMsg style={{ fontSize: 11, padding: '8px 0' }}>
                                    Querying Splunk for activity timechart…
                                </EmptyMsg>
                            )}
                            {!edgeData?.activityLoading && (!edgeData?.activity || edgeData.activity.length === 0) && (
                                <EmptyMsg style={{ fontSize: 11, padding: '8px 0' }}>
                                    No events for this edge in the current time range.
                                </EmptyMsg>
                            )}
                            {!edgeData?.activityLoading && edgeData?.activity && edgeData.activity.length > 0 && (
                                <ActivityChartWrap>
                                    <ChartCaption>Calls + errors per hour · current time range</ChartCaption>
                                    <ActivityTrendChart data={edgeData.activity} />
                                    <DonutLegend style={{ marginTop: 6 }}>
                                        <li>
                                            <span className="swatch" style={{ background: logservTheme.colors.cyanLight }} />
                                            <span className="code">Successful calls</span>
                                            <span className="count">{
                                                edgeData.activity.reduce((s, p) => s + (p.count - p.errorCount), 0).toLocaleString()
                                            }</span>
                                        </li>
                                        <li>
                                            <span className="swatch" style={{ background: logservTheme.colors.red }} />
                                            <span className="code">Errors</span>
                                            <span className="count">{
                                                edgeData.activity.reduce((s, p) => s + p.errorCount, 0).toLocaleString()
                                            }</span>
                                        </li>
                                    </DonutLegend>
                                </ActivityChartWrap>
                            )}
                        </>
                    )}

                    {edgeTab === 'operations' && (
                        <>
                            {edgeData?.operationsLoading && (
                                <EmptyMsg style={{ fontSize: 11, padding: '8px 0' }}>
                                    Querying Splunk for top entities traversing this edge…
                                </EmptyMsg>
                            )}
                            {!edgeData?.operationsLoading && (!edgeData?.operations || edgeData.operations.length === 0) && (
                                <EmptyMsg style={{ fontSize: 11, padding: '8px 0' }}>
                                    No grouping data for this edge in the current time range.
                                </EmptyMsg>
                            )}
                            {!edgeData?.operationsLoading && edgeData?.operations && edgeData.operations.length > 0 && (
                                <ChartBlock>
                                    <ChartCaption>
                                        {`Top ${
                                            splType === 'http' ? 'URIs'
                                            : splType === 'rfc' ? 'ABAP programs'
                                            : splType === 'hana_audit' ? 'action types'
                                            : splType === 'hana_tenant' ? 'trace components'
                                            : 'entities'
                                        } · current time range`}
                                    </ChartCaption>
                                    <DonutChart
                                        data={edgeData.operations.map((op, i) => ({
                                            code: op.entity,
                                            count: op.count,
                                            color: PARTNER_PALETTE[i % PARTNER_PALETTE.length],
                                        }))}
                                    />
                                    <DonutLegend>
                                        {edgeData.operations.map((op, i) => (
                                            <li key={op.entity}>
                                                <span className="swatch" style={{ background: PARTNER_PALETTE[i % PARTNER_PALETTE.length] }} />
                                                <span className="code" title={op.entity}>{op.entity}</span>
                                                <span className="count">{formatCallCount(op.count)}</span>
                                            </li>
                                        ))}
                                    </DonutLegend>
                                </ChartBlock>
                            )}
                        </>
                    )}

                    {edgeTab === 'performance' && (
                        <>
                            {/* Pre-computed aggregates from the cached edge object — instant, no SPL dispatch. */}
                            <ChartCaption>Cached aggregates · current time range window</ChartCaption>
                            <PerfRow>
                                {splType === 'http' && (
                                    <>
                                        <PerfMetric>
                                            <div className="perfLabel">p50 latency</div>
                                            <div className="perfValue">{formatLatency(selectedEdge.responseTimeP50)}</div>
                                        </PerfMetric>
                                        <PerfMetric>
                                            <div className="perfLabel">p95 latency</div>
                                            <div className="perfValue">{formatLatency(selectedEdge.responseTimeP95)}</div>
                                        </PerfMetric>
                                        <PerfMetric>
                                            <div className="perfLabel">max latency</div>
                                            <div className="perfValue">{formatLatency(selectedEdge.responseTimeMax)}</div>
                                        </PerfMetric>
                                        <PerfMetric>
                                            <div className="perfLabel">bytes out total</div>
                                            <div className="perfValue">{formatBytes(selectedEdge.bytesOutSum)}</div>
                                        </PerfMetric>
                                    </>
                                )}
                                {splType === 'rfc' && (
                                    <>
                                        <PerfMetric>
                                            <div className="perfLabel">icm_tasks max</div>
                                            <div className="perfValue">{selectedEdge.icmTasksMax?.toLocaleString() ?? '—'}</div>
                                        </PerfMetric>
                                        <PerfMetric>
                                            <div className="perfLabel">icm_tasks avg</div>
                                            <div className="perfValue">{
                                                selectedEdge.icmTasksAvg != null
                                                    ? selectedEdge.icmTasksAvg.toFixed(1)
                                                    : '—'
                                            }</div>
                                        </PerfMetric>
                                    </>
                                )}
                                {splType === 'hana_tenant' && (
                                    <>
                                        <PerfMetric>
                                            <div className="perfLabel">p95 SQL duration</div>
                                            <div className="perfValue">{formatLatency(selectedEdge.hanaOpP95Ms)}</div>
                                        </PerfMetric>
                                        <PerfMetric>
                                            <div className="perfLabel">max SQL duration</div>
                                            <div className="perfValue">{formatLatency(selectedEdge.hanaOpMaxMs)}</div>
                                        </PerfMetric>
                                    </>
                                )}
                                {splType === 'hana_audit' && (
                                    <>
                                        <PerfMetric>
                                            <div className="perfLabel">auth success</div>
                                            <div className="perfValue">{(selectedEdge.authSuccessCount ?? 0).toLocaleString()}</div>
                                        </PerfMetric>
                                        <PerfMetric>
                                            <div className="perfLabel">auth fail</div>
                                            <div className="perfValue">{(selectedEdge.authFailCount ?? 0).toLocaleString()}</div>
                                        </PerfMetric>
                                    </>
                                )}
                            </PerfRow>
                            {/* Distribution histogram from per-edge SPL search. */}
                            {edgeData?.performanceLoading && (
                                <EmptyMsg style={{ fontSize: 11, padding: '8px 0' }}>
                                    Querying Splunk for distribution detail…
                                </EmptyMsg>
                            )}
                            {!edgeData?.performanceLoading && edgeData?.performance && edgeData.performance.length > 0 && (
                                <>
                                    <ChartCaption style={{ marginTop: 12 }}>
                                        {splType === 'http' ? 'Status class distribution'
                                            : splType === 'rfc' ? 'icm_tasks distribution'
                                            : splType === 'hana_audit' ? 'Action status mix'
                                            : splType === 'hana_tenant' ? 'SQL duration percentiles'
                                            : 'Distribution'}
                                    </ChartCaption>
                                    {(() => {
                                        const maxCount = Math.max(...edgeData.performance.map((p) => p.count), 1);
                                        return edgeData.performance.map((p) => {
                                            const pct = (p.count / maxCount) * 100;
                                            return (
                                                <PerfBarRow key={p.bucketLabel}>
                                                    <span className="label">{p.bucketLabel}</span>
                                                    <span className="barOuter">
                                                        <span className="barInner" style={{ width: `${pct}%` }} />
                                                    </span>
                                                    <span className="num">{p.count.toLocaleString()}</span>
                                                </PerfBarRow>
                                            );
                                        });
                                    })()}
                                </>
                            )}
                        </>
                    )}

                    {edgeTab === 'errors' && (
                        <>
                            {edgeData?.errorsLoading && (
                                <EmptyMsg style={{ fontSize: 11, padding: '8px 0' }}>
                                    Querying Splunk for top failure modes on this edge…
                                </EmptyMsg>
                            )}
                            {!edgeData?.errorsLoading && (!edgeData?.errors || edgeData.errors.length === 0) && (
                                <EmptyMsg style={{ fontSize: 11, padding: '8px 0' }}>
                                    No errors for this edge in the current time range.
                                </EmptyMsg>
                            )}
                            {!edgeData?.errorsLoading && edgeData?.errors && edgeData.errors.length > 0 && (
                                <>
                                    <ChartCaption>
                                        {`${edgeData.errors.length} error mode${edgeData.errors.length === 1 ? '' : 's'} · current time range`}
                                    </ChartCaption>
                                    <TableScroll>
                                        <DataTable>
                                            <thead>
                                                <tr>
                                                    <th>Kind · Detail</th>
                                                    <th className="num">Count</th>
                                                    <th className="num">Last seen</th>
                                                </tr>
                                            </thead>
                                            <tbody>
                                                {edgeData.errors.map((e, i) => (
                                                    <tr key={`${e.errorKind}-${e.errorDetail}-${i}`}>
                                                        <td className="primary">
                                                            <div>{e.errorKind}</div>
                                                            <div className="secondary">{e.errorDetail}</div>
                                                        </td>
                                                        <td className="num">{e.count.toLocaleString()}</td>
                                                        <td className="relTime">{formatRelative(e.lastSeen)}</td>
                                                    </tr>
                                                ))}
                                            </tbody>
                                        </DataTable>
                                    </TableScroll>
                                </>
                            )}
                        </>
                    )}
                </FramedPanel>
            </Stack>
        );
    }

    if (!selectedNode) {
        return (
            <FramedPanel title="Details" subtitle="Click a node or edge" actions={collapseAction}>
                <EmptyMsg>
                    Click a node to inspect its integrations, top programs,
                    errors, and hosts.<br /><br />
                    Click an edge to inspect its activity trend, top entities,
                    performance metrics, and failure modes.
                </EmptyMsg>
            </FramedPanel>
        );
    }

    const totalCalls = [...selectedNodeIncomingEdges, ...selectedNodeOutgoingEdges]
        .reduce((s, e) => s + e.callCount, 0);
    const sparklineColor = selectedNode.kind === 'sid_focused'
        ? logservTheme.colors.red
        : logservTheme.colors.cyanLight;

    return (
        <Stack>
            <FramedPanel title="Details" actions={collapseAction}>
                <NodeIdRow>
                    <SidBadge $kind={selectedNode.kind}>{selectedNode.label}</SidBadge>
                    <KindChip $kind={selectedNode.kind}>
                        {selectedNode.kind === 'sid_focused' ? 'SID (FOCUS)' : selectedNode.kind === 'sid_secondary' ? 'SID' : 'PARTNER'}
                    </KindChip>
                </NodeIdRow>
                <TabBar role="tablist" aria-label="Node detail tabs">
                    {(['overview', 'tcodes', 'errors', 'hosts'] as RightTab[]).map((t) => (
                        <Tab
                            key={t}
                            type="button"
                            role="tab"
                            aria-selected={tab === t}
                            $active={tab === t}
                            onClick={() => setTab(t)}
                        >
                            {t === 'overview' ? 'Overview' : t === 'tcodes' ? 'Top Programs' : t === 'errors' ? 'Errors' : 'Hosts'}
                        </Tab>
                    ))}
                </TabBar>

                {tab === 'overview' && (
                    <>
                        <FactsTable>
                            <tbody>
                                <tr><td className="k">Kind</td><td className="v">{selectedNode.kind === 'sid_focused' ? 'Focused SAP SID' : selectedNode.kind === 'sid_secondary' ? 'Secondary SAP SID' : 'Remote partner'}</td></tr>
                                <tr><td className="k">Tag</td><td className="v">{selectedNode.tag}</td></tr>
                                <tr><td className="k">Events</td><td className="v">{selectedNode.eventCount.toLocaleString()}</td></tr>
                                <tr><td className="k">Total calls (in+out)</td><td className="v">{totalCalls.toLocaleString()}</td></tr>
                                <tr><td className="k">Inbound edges</td><td className="v">{selectedNodeIncomingEdges.length}</td></tr>
                                <tr><td className="k">Outbound edges</td><td className="v">{selectedNodeOutgoingEdges.length}</td></tr>
                                {selectedNode.healthPct != null && (
                                    <tr><td className="k">Health</td><td className="v">{selectedNode.healthPct}%</td></tr>
                                )}
                            </tbody>
                        </FactsTable>

                        {/* Build 203 / session 036 — DB-specific roll-up.
                          * HANA database SIDs (XHQ / XHX / XHD / XCJ in the
                          * xsd-vlab dataset) carry tag === 'DB' but the node
                          * panel's other tabs (Top Programs / Errors / Hosts)
                          * surface mostly ABAP-flavored data — `icm_program`
                          * is empty for HANA-only SIDs. Surface what we
                          * already have on incident edges so the Overview
                          * tab is non-sparse for DB nodes:
                          *   - List of tenant DBs hosted (from incoming
                          *     hana_tenant edges where target = this node)
                          *   - Sum of HANA SQL p95 latency across tenant
                          *     edges (max-of, since latencies don't sum)
                          *   - Sum of HANA Audit auth success/fail counts
                          *     across hana_audit edges incident to this node
                          * Derived from in-memory edge data — no SPL dispatch
                          * needed. */}
                        {/* Build 211 / session 036 — accept any DB-vendor
                          * tag (HANA / ORACLE / MSSQL / POSTGRES / DB2)
                          * plus the generic DB fallback. */}
                        {isDatabaseTag(selectedNode.tag) && (() => {
                            const allEdges = [...selectedNodeIncomingEdges, ...selectedNodeOutgoingEdges];
                            const tenantEdges = allEdges.filter((e) => e.splType === 'hana_tenant');
                            const auditEdges = allEdges.filter((e) => e.splType === 'hana_audit');
                            const tenantLabels = tenantEdges
                                .map((e) => {
                                    /* Tenant edges: source is the system SID,
                                     * target is the tenant SID (or vice-versa).
                                     * The tenant is whichever endpoint is NOT
                                     * the currently selected node. */
                                    const otherId = e.source === selectedNode.id ? e.target : e.source;
                                    const otherNode = edgeNodes?.find((n) => n.id === otherId);
                                    return otherNode?.label ?? otherId;
                                })
                                .filter((v, i, arr) => arr.indexOf(v) === i)
                                .sort();
                            const maxP95 = tenantEdges.reduce(
                                (acc, e) => Math.max(acc, e.hanaOpP95Ms ?? 0), 0,
                            );
                            const maxOpMax = tenantEdges.reduce(
                                (acc, e) => Math.max(acc, e.hanaOpMaxMs ?? 0), 0,
                            );
                            const tenantCalls = tenantEdges.reduce((s, e) => s + e.callCount, 0);
                            const authSuccess = auditEdges.reduce(
                                (s, e) => s + (e.authSuccessCount ?? 0), 0,
                            );
                            const authFail = auditEdges.reduce(
                                (s, e) => s + (e.authFailCount ?? 0), 0,
                            );
                            const hasAnything = tenantLabels.length > 0
                                || authSuccess > 0 || authFail > 0;
                            if (!hasAnything) return null;
                            return (
                                <ActivityChartWrap>
                                    <ChartCaption>HANA database roll-up</ChartCaption>
                                    <FactsTable>
                                        <tbody>
                                            {tenantLabels.length > 0 && (
                                                <tr>
                                                    <td className="k">Tenant DBs</td>
                                                    <td className="v">{tenantLabels.join(' · ')}</td>
                                                </tr>
                                            )}
                                            {tenantEdges.length > 0 && (
                                                <tr>
                                                    <td className="k">Tenant SQL ops</td>
                                                    <td className="v">{tenantCalls.toLocaleString()}</td>
                                                </tr>
                                            )}
                                            {maxP95 > 0 && (
                                                <tr>
                                                    <td className="k">SQL p95 (any tenant)</td>
                                                    <td className="v">{formatLatency(maxP95)}</td>
                                                </tr>
                                            )}
                                            {maxOpMax > 0 && (
                                                <tr>
                                                    <td className="k">SQL max (any tenant)</td>
                                                    <td className="v">{formatLatency(maxOpMax)}</td>
                                                </tr>
                                            )}
                                            {(authSuccess > 0 || authFail > 0) && (
                                                <>
                                                    <tr>
                                                        <td className="k">Auth success</td>
                                                        <td className="v">{authSuccess.toLocaleString()}</td>
                                                    </tr>
                                                    <tr>
                                                        <td className="k">Auth failed</td>
                                                        <td className="v">{authFail.toLocaleString()}</td>
                                                    </tr>
                                                </>
                                            )}
                                        </tbody>
                                    </FactsTable>
                                </ActivityChartWrap>
                            );
                        })()}
                        <ChartRow>
                            <ChartBlock>
                                <ChartCaption>Calls / hr · last 24h{nodeHourlyLoading ? ' · loading…' : ''}</ChartCaption>
                                {nodeHourly && nodeHourly.length > 0 ? (
                                    <HourlyChart data={nodeHourly} color={sparklineColor} />
                                ) : (
                                    <EmptyMsg style={{ fontSize: 11, padding: '8px 0' }}>
                                        {nodeHourlyLoading
                                            ? 'Querying Splunk for hourly call counts…'
                                            : 'No hourly activity for this node in the last 24h.'}
                                    </EmptyMsg>
                                )}
                            </ChartBlock>
                        </ChartRow>
                        <ChartRow>
                            <ChartBlock>
                                <ChartCaption>Top partners (in + out)</ChartCaption>
                                {topPartners.length > 0 ? (
                                    <>
                                        <DonutChart data={topPartners} />
                                        <DonutLegend>
                                            {topPartners.map((d) => (
                                                <li key={d.code}>
                                                    <span className="swatch" style={{ background: d.color }} />
                                                    <span className="code" title={d.code}>{d.code}</span>
                                                    <span className="count">{formatCallCount(d.count)}</span>
                                                </li>
                                            ))}
                                        </DonutLegend>
                                    </>
                                ) : (
                                    <EmptyMsg style={{ fontSize: 11, padding: '8px 0' }}>
                                        This node has no edges in the current time range.
                                    </EmptyMsg>
                                )}
                            </ChartBlock>
                        </ChartRow>
                    </>
                )}

                {tab === 'tcodes' && (
                    <>
                        {nodeProgramsLoading && (
                            <EmptyMsg style={{ fontSize: 11, padding: '8px 0' }}>
                                Querying Splunk for top programs (sap:abap:icm `icm_program` field) for the current time range…
                            </EmptyMsg>
                        )}
                        {!nodeProgramsLoading && (!nodePrograms || nodePrograms.length === 0) && (
                            <EmptyMsg style={{ fontSize: 11, padding: '8px 0' }}>
                                No `icm_program` events for this node in the current time range.
                                (Note: `tcode=` is consistently empty in this dataset, so we surface the
                                ABAP ICM program field instead — `SAPMSSY1`, `SAPMHTTP`, etc. — which is the
                                closest meaningful per-SID breakdown.)
                            </EmptyMsg>
                        )}
                        {!nodeProgramsLoading && nodePrograms && nodePrograms.length > 0 && (
                            <ChartBlock>
                                <ChartCaption>Top ABAP ICM programs (current time range)</ChartCaption>
                                <DonutChart
                                    data={nodePrograms.map((p, i) => ({
                                        code: p.program,
                                        count: p.count,
                                        color: PARTNER_PALETTE[i % PARTNER_PALETTE.length],
                                    }))}
                                />
                                <DonutLegend>
                                    {nodePrograms.map((p, i) => (
                                        <li key={p.program}>
                                            <span className="swatch" style={{ background: PARTNER_PALETTE[i % PARTNER_PALETTE.length] }} />
                                            <span className="code" title={p.program}>{p.program}</span>
                                            <span className="count">{formatCallCount(p.count)}</span>
                                        </li>
                                    ))}
                                </DonutLegend>
                            </ChartBlock>
                        )}
                    </>
                )}
                {tab === 'errors' && (
                    <>
                        {nodeErrorsLoading && (
                            <EmptyMsg style={{ fontSize: 11, padding: '8px 0' }}>
                                Querying Splunk for errors associated with this node…
                            </EmptyMsg>
                        )}
                        {!nodeErrorsLoading && (!nodeErrors || nodeErrors.length === 0) && (
                            <EmptyMsg style={{ fontSize: 11, padding: '8px 0' }}>
                                No errors found for this node in the current time range.
                                (Looks for HTTP 4xx/5xx, severity ERROR/CRITICAL/FATAL,
                                gateway error details, and saprouter trace error functions.)
                            </EmptyMsg>
                        )}
                        {!nodeErrorsLoading && nodeErrors && nodeErrors.length > 0 && (
                            <>
                                <ChartCaption>
                                    {`${nodeErrors.length} error categor${nodeErrors.length === 1 ? 'y' : 'ies'} · current time range`}
                                </ChartCaption>
                                <TableScroll>
                                    <DataTable>
                                        <thead>
                                            <tr>
                                                <th>Source · Kind</th>
                                                <th className="num">Count</th>
                                                <th className="num">Last seen</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {nodeErrors.map((e, i) => (
                                                <tr key={`${e.sourcetype}-${e.errorKind}-${i}`}>
                                                    <td className="primary">
                                                        <div>{e.errorKind}</div>
                                                        <div className="errBucket">{shortSourcetype(e.sourcetype)}</div>
                                                    </td>
                                                    <td className="num">{e.count.toLocaleString()}</td>
                                                    <td className="relTime">{formatRelative(e.lastSeen)}</td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </DataTable>
                                </TableScroll>
                            </>
                        )}
                    </>
                )}
                {tab === 'hosts' && (
                    <>
                        {nodeHostsLoading && (
                            <EmptyMsg style={{ fontSize: 11, padding: '8px 0' }}>
                                Querying Splunk for hosts that mention this node…
                            </EmptyMsg>
                        )}
                        {!nodeHostsLoading && (!nodeHosts || nodeHosts.length === 0) && (
                            <EmptyMsg style={{ fontSize: 11, padding: '8px 0' }}>
                                No host activity for this node in the current time range.
                            </EmptyMsg>
                        )}
                        {!nodeHostsLoading && nodeHosts && nodeHosts.length > 0 && (
                            <>
                                <ChartCaption>
                                    {`${nodeHosts.length} host${nodeHosts.length === 1 ? '' : 's'} · current time range`}
                                </ChartCaption>
                                <TableScroll>
                                    <DataTable>
                                        <thead>
                                            <tr>
                                                <th>Host</th>
                                                <th className="num">Events</th>
                                                <th className="num">Last seen</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {nodeHosts.map((h) => (
                                                <tr key={h.host}>
                                                    <td className="primary">
                                                        <div>{h.host}</div>
                                                        <div className="secondary">
                                                            {`${h.sourcetypeCount} sourcetype${h.sourcetypeCount === 1 ? '' : 's'} · first seen ${formatRelative(h.firstSeen)}`}
                                                        </div>
                                                    </td>
                                                    <td className="num">{h.count.toLocaleString()}</td>
                                                    <td className="relTime">{formatRelative(h.lastSeen)}</td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </DataTable>
                                </TableScroll>
                            </>
                        )}
                    </>
                )}
            </FramedPanel>
        </Stack>
    );
};

export default TopologyRightSidebar;
