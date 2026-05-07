import React, { useState } from 'react';
import styled from 'styled-components';
import FramedPanel from '../FramedPanel';
import { logservTheme } from '../../styles/logservTheme';
import { darken } from '../../utils/colorMath';
import { formatCallCount } from '../../topology/edgeStyle';
import type { ActivityRow } from '../../topology/types';

/**
 * Bottom panel — collapsible "Live Activity" drawer.
 *
 * Left side: top RFC partners table (4-6 rows from the fixture).
 * Right side: a compact "Calls/hour, last 24h" SVG bar chart so the bottom
 * panel mixes table + chart per the design (charts not just tables).
 *
 * Auto-refresh dropdown is a stub — v1 doesn't actually poll. Cadence will
 * be applied in session 026 when live mode lands.
 */

const Wrap = styled.div`
    display: flex;
    flex-direction: column;
`;

const HeaderRow = styled.div`
    display: flex;
    align-items: baseline;
    gap: ${logservTheme.spacing.lg};
    margin-bottom: ${logservTheme.spacing.sm};
    flex-wrap: wrap;
`;

const TitleSubtitle = styled.div`
    color: ${logservTheme.colors.textMuted};
    font-size: ${logservTheme.fontSize.small};
`;

const Controls = styled.div`
    display: flex;
    align-items: center;
    gap: 6px;
    margin-left: auto;
`;

const DropdownLike = styled.select`
    background: ${logservTheme.colors.tableHeaderBackground};
    color: ${logservTheme.colors.textActive};
    border: 1px solid ${logservTheme.colors.panelBorderWeak};
    border-radius: ${logservTheme.radius.small};
    padding: 3px 6px;
    font-size: 11px;
    font-family: inherit;
    cursor: pointer;

    &:focus {
        outline: 2px solid ${logservTheme.colors.cyanAccent};
        outline-offset: -2px;
    }
`;

const ToggleButton = styled.button`
    background: transparent;
    color: ${logservTheme.colors.cyanLight};
    border: 1px solid ${logservTheme.colors.panelBorderWeak};
    border-radius: ${logservTheme.radius.small};
    padding: 3px 8px;
    font-size: 11px;
    font-weight: ${logservTheme.fontWeight.semibold};
    font-family: inherit;
    cursor: pointer;

    &:hover {
        border-color: ${logservTheme.colors.cyanAccent};
    }
`;

const ContentRow = styled.div`
    display: grid;
    grid-template-columns: 1fr 280px;
    gap: ${logservTheme.spacing.lg};
    align-items: stretch;
`;

const Table = styled.table`
    width: 100%;
    border-collapse: collapse;
    font-size: ${logservTheme.fontSize.small};

    thead th {
        text-align: left;
        background: ${logservTheme.colors.tableHeaderBackground};
        color: ${logservTheme.colors.textActive};
        padding: 6px 8px;
        font-weight: ${logservTheme.fontWeight.semibold};
        font-size: 10.5px;
        text-transform: uppercase;
        letter-spacing: 0.5px;
        border-bottom: 1px solid ${logservTheme.colors.panelBorderWeak};
    }
    tbody td {
        padding: 5px 8px;
        color: ${logservTheme.colors.textDefault};
    }
    tbody tr:nth-child(odd) td {
        background: ${logservTheme.colors.tableRowOdd};
    }
    td.r {
        text-align: right;
        font-variant-numeric: tabular-nums;
        font-weight: ${logservTheme.fontWeight.semibold};
    }
    td.dir {
        font-family: monospace;
        font-size: 10.5px;
        color: ${logservTheme.colors.textMuted};
    }
`;

const SidPill = styled.span<{ $kind: 'focused' | 'secondary' }>`
    background: ${(p) => (p.$kind === 'focused' ? logservTheme.colors.red : logservTheme.colors.cyanAccent)};
    color: ${logservTheme.colors.textActive};
    padding: 1px 6px;
    border-radius: ${logservTheme.radius.small};
    font-weight: ${logservTheme.fontWeight.bold};
    font-size: 10.5px;
    letter-spacing: 0.4px;
    margin-right: 6px;
`;

const ChartCaption = styled.div`
    color: ${logservTheme.colors.textMuted};
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    margin-bottom: 4px;
`;

const ChartFooter = styled.div`
    color: ${logservTheme.colors.textMuted};
    font-size: 10px;
    margin-top: 4px;
    font-variant-numeric: tabular-nums;
`;

const ChartCol = styled.div`
    display: flex;
    flex-direction: column;
`;

interface TopologyBottomPanelProps {
    rows: ActivityRow[];
    callsPerHour: number[];
    focusedSidIds: Set<string>;
    /** Range string ("range 7d" in the reference). */
    rangeLabel: string;
    /** Open/closed state controlled by parent so the toolbar can also collapse it. */
    open: boolean;
    onToggleOpen: () => void;
}

const directionGlyph = (d: ActivityRow['direction']): string =>
    d === 'client' ? 'client →' : 'server ←';

const HourlyBars: React.FC<{ data: number[] }> = ({ data }) => {
    const W = 280;
    const H = 84;
    const max = Math.max(...data, 1);
    const barW = W / data.length;
    const teal = logservTheme.colors.teal;
    return (
        <svg width={W} height={H} role="img" aria-label="Calls per hour, last 24h">
            <defs>
                <linearGradient id="bottom-grad" x1="0" x2="0" y1="0" y2="1">
                    <stop offset="0%" stopColor={teal} stopOpacity="1" />
                    <stop offset="100%" stopColor={darken(teal, 0.4)} stopOpacity="1" />
                </linearGradient>
            </defs>
            {data.map((v, i) => {
                const h = Math.max(1, (v / max) * (H - 6));
                return (
                    <rect
                        key={i}
                        x={i * barW + 0.5}
                        y={H - h - 2}
                        width={Math.max(1, barW - 1)}
                        height={h}
                        fill="url(#bottom-grad)"
                        rx={1}
                    />
                );
            })}
            {/* Baseline */}
            <line x1={0} y1={H - 1} x2={W} y2={H - 1} stroke={logservTheme.colors.panelBorderWeak} strokeWidth={1} />
        </svg>
    );
};

const TopologyBottomPanel: React.FC<TopologyBottomPanelProps> = ({
    rows,
    callsPerHour,
    focusedSidIds,
    rangeLabel,
    open,
    onToggleOpen,
}) => {
    const [refresh, setRefresh] = useState<string>('15s');
    const totalCalls = rows.reduce((s, r) => s + r.callCount, 0);
    const peakHour = Math.max(...callsPerHour);
    const lowHour = Math.min(...callsPerHour);

    if (!open) {
        return (
            <FramedPanel
                title="Live Activity"
                actions={<ToggleButton type="button" onClick={onToggleOpen}>Show ▾</ToggleButton>}
                compact
            />
        );
    }

    return (
        <FramedPanel
            title="Live Activity"
            actions={<ToggleButton type="button" onClick={onToggleOpen}>Hide ▴</ToggleButton>}
        >
            <Wrap>
                <HeaderRow>
                    <TitleSubtitle>
                        {`Top ${rows.length} RFC partners · ${formatCallCount(totalCalls)} calls · ${rangeLabel}`}
                    </TitleSubtitle>
                    <Controls>
                        <span style={{ color: logservTheme.colors.textMuted, fontSize: 11 }}>auto-refresh</span>
                        <DropdownLike value={refresh} onChange={(e) => setRefresh(e.target.value)} aria-label="Auto-refresh interval">
                            <option value="off">off</option>
                            <option value="15s">15s</option>
                            <option value="30s">30s</option>
                            <option value="60s">60s</option>
                            <option value="5m">5m</option>
                        </DropdownLike>
                    </Controls>
                </HeaderRow>
                <ContentRow>
                    <Table>
                        <thead>
                            <tr>
                                <th>Source</th>
                                <th>Direction</th>
                                <th>Remote partner</th>
                                <th style={{ textAlign: 'right' }}>Calls</th>
                            </tr>
                        </thead>
                        <tbody>
                            {rows.map((r) => (
                                <tr key={r.id}>
                                    <td>
                                        <SidPill $kind={focusedSidIds.has(r.sourceSid) ? 'focused' : 'secondary'}>
                                            {r.sourceSid}
                                        </SidPill>
                                    </td>
                                    <td className="dir">{directionGlyph(r.direction)}</td>
                                    <td>{r.partner}</td>
                                    <td className="r">{r.callCount.toLocaleString()}</td>
                                </tr>
                            ))}
                        </tbody>
                    </Table>
                    <ChartCol>
                        <ChartCaption>Calls / hour · last 24h</ChartCaption>
                        <HourlyBars data={callsPerHour} />
                        <ChartFooter>
                            {`peak ${formatCallCount(peakHour)} · low ${formatCallCount(lowHour)}`}
                        </ChartFooter>
                    </ChartCol>
                </ContentRow>
            </Wrap>
        </FramedPanel>
    );
};

export default TopologyBottomPanel;
