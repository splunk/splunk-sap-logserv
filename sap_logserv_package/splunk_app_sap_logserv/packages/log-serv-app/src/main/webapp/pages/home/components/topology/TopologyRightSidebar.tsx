import React, { useCallback, useState } from 'react';
import styled from 'styled-components';
import FramedPanel from '../FramedPanel';
import { logservTheme } from '../../styles/logservTheme';
import { darken } from '../../utils/colorMath';
import { formatCallCount } from '../../topology/edgeStyle';
import type { TopologyNode, TopologyEdge } from '../../topology/types';
import type { NodeError, NodeHost } from '../../hooks/useNodeData';

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
 * Width 240, height 60, with axis-free bars matching TimeSeriesChart's
 * "compact" aesthetic in the right sidebar.
 */
const HourlyChart: React.FC<{ data: number[]; color: string }> = ({ data, color }) => {
    const W = 240;
    const H = 64;
    const max = Math.max(...data, 1);
    const barW = W / data.length;
    return (
        <svg width={W} height={H} role="img" aria-label="Calls per hour, last 24h">
            <defs>
                <linearGradient id="hourly-grad" x1="0" x2="0" y1="0" y2="1">
                    <stop offset="0%" stopColor={color} stopOpacity="1" />
                    <stop offset="100%" stopColor={darken(color, 0.4)} stopOpacity="1" />
                </linearGradient>
            </defs>
            {data.map((v, i) => {
                const h = Math.max(1, (v / max) * (H - 4));
                return (
                    <rect
                        key={i}
                        x={i * barW + 0.5}
                        y={H - h}
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
}

export type RightTab = 'overview' | 'tcodes' | 'errors' | 'hosts';

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
    onCollapse,
    tab: controlledTab,
    onTabChange,
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

    /** Top partners derived from in+out edges. Group by the OTHER endpoint
     *  (not the selected node), sum call counts, take top 4 + "OTHER". */
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
            code: p.id,
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
    }, [selectedNode, selectedNodeIncomingEdges, selectedNodeOutgoingEdges]);

    const collapseAction = onCollapse ? (
        <CollapseChevron type="button" onClick={onCollapse} title="Collapse panel" aria-label="Collapse details panel">
            {'›'}
        </CollapseChevron>
    ) : undefined;

    if (!selectedNode) {
        return (
            <FramedPanel title="Details" subtitle="Click a node" actions={collapseAction}>
                <EmptyMsg>
                    Select a node in the graph to inspect its integrations,
                    top transactions, errors, and hosts.
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
