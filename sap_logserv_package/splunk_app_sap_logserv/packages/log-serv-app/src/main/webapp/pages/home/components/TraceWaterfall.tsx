import React, { useMemo } from 'react';
import styled from 'styled-components';
import { logservTheme } from '../styles/logservTheme';
import { verticalGradient } from '../utils/colorMath';

/** Match TimeSeriesChart's DEFAULT_GRADIENT_DARKEN so HTML waterfall bars
 *  share the exact visual fade as the SVG charts on the same dashboard. */
const STAGE_GRADIENT_DARKEN = 0.4;

/**
 * TraceWaterfall — per-request timing breakdown shown as stacked horizontal
 * bars, like the browser DevTools Network panel. The signature redesigned
 * widget for v0.0.5.0 Web Dispatcher pilot — not possible in DS v2.
 *
 * Each row is one HTTP request with four timing stages (dt1–dt4) plus total.
 * Bars are scaled to the slowest request in the dataset so the visual
 * conveys relative slowness instantly.
 */

export interface TraceRow {
    _time?: string | number;
    uri?: string;
    method?: string;
    status?: string | number;
    dt1_us?: string | number;
    dt2_us?: string | number;
    dt3_us?: string | number;
    dt4_us?: string | number;
    total_us?: string | number;
}

interface Props {
    rows: TraceRow[] | null;
    loading?: boolean;
    error?: Error | null;
    /** Max rows to render. Default: 20 */
    maxRows?: number;
}

const STAGE_COLORS = {
    dt1: logservTheme.colors.cyanLight,
    dt2: logservTheme.colors.teal,
    dt3: logservTheme.colors.purple,
    dt4: logservTheme.colors.orange,
};

const STAGE_LABELS = {
    dt1: 'dt1 — request parse / dispatch',
    dt2: 'dt2 — backend processing',
    dt3: 'dt3 — response build',
    dt4: 'dt4 — response transmit',
};

const Wrapper = styled.div`
    color: ${logservTheme.colors.textActive};
    font-size: ${logservTheme.fontSize.body};
`;

const Legend = styled.div`
    display: flex;
    gap: ${logservTheme.spacing.lg};
    flex-wrap: wrap;
    padding: ${logservTheme.spacing.sm} 0;
    margin-bottom: ${logservTheme.spacing.sm};
    font-size: ${logservTheme.fontSize.small};
    color: ${logservTheme.colors.textMuted};
`;

const LegendItem = styled.div`
    display: flex;
    align-items: center;
    gap: ${logservTheme.spacing.xs};
`;

const Swatch = styled.span<{ $color: string }>`
    display: inline-block;
    width: 12px;
    height: 12px;
    border-radius: 2px;
    background: ${(p) => verticalGradient(p.$color, STAGE_GRADIENT_DARKEN)};
`;

const Header = styled.div`
    display: grid;
    grid-template-columns: 80px 0.7fr 80px minmax(200px, 0.5fr) 60px 80px;
    gap: ${logservTheme.spacing.md};
    padding: ${logservTheme.spacing.sm} ${logservTheme.spacing.md};
    background: ${logservTheme.colors.tableHeaderBackground};
    color: ${logservTheme.colors.textActive};
    font-size: ${logservTheme.fontSize.small};
    font-weight: ${logservTheme.fontWeight.semibold};
    text-transform: uppercase;
    letter-spacing: 0.5px;
    border-bottom: 1px solid ${logservTheme.colors.panelBorderWeak};
`;

const Row = styled.div<{ $isError: boolean }>`
    display: grid;
    grid-template-columns: 80px 0.7fr 80px minmax(200px, 0.5fr) 60px 80px;
    gap: ${logservTheme.spacing.md};
    padding: ${logservTheme.spacing.sm} ${logservTheme.spacing.md};
    border-bottom: 1px solid ${logservTheme.colors.panelBorderWeak};
    color: ${(p) => (p.$isError ? logservTheme.colors.red : logservTheme.colors.textDefault)};

    &:nth-child(odd) {
        background: ${logservTheme.colors.tableRowOdd};
    }

    &:hover {
        background: ${logservTheme.colors.hoverBackground};
    }
`;

const Cell = styled.div<{ $align?: 'left' | 'right' | 'center' }>`
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    text-align: ${(p) => p.$align ?? 'left'};
    align-self: center;
`;

const Bar = styled.div`
    display: flex;
    width: 100%;
    height: 14px;
    background: ${logservTheme.colors.tableHeaderBackground};
    border-radius: 2px;
    overflow: hidden;
    align-self: center;
`;

const Segment = styled.div<{ $width: number; $color: string }>`
    width: ${(p) => p.$width.toFixed(2)}%;
    background: ${(p) => verticalGradient(p.$color, STAGE_GRADIENT_DARKEN)};
    height: 100%;

    &:not(:last-child) {
        border-right: 1px solid ${logservTheme.colors.panelBackground};
    }
`;

const StatusLine = styled.div`
    padding: ${logservTheme.spacing.lg};
    color: ${logservTheme.colors.textMuted};
    text-align: center;
    font-size: ${logservTheme.fontSize.small};
`;

const ErrorLine = styled(StatusLine)`
    color: ${logservTheme.colors.red};
`;

const MonoCell = styled(Cell)`
    font-family: monospace;
    color: ${logservTheme.colors.cyanLight};
`;

const num = (raw: unknown): number => {
    if (raw === null || typeof raw === 'undefined') return 0;
    const n = typeof raw === 'number' ? raw : parseFloat(String(raw));
    return Number.isNaN(n) ? 0 : n;
};

const formatTime = (raw: string | number | undefined): string => {
    if (!raw) return '';
    // Splunk _time is typically ISO. Show just HH:MM:SS for compactness.
    const d = new Date(String(raw));
    if (Number.isNaN(d.getTime())) return String(raw);
    return d.toLocaleTimeString('en-US', { hour12: false });
};

const formatMs = (us: number): string => {
    const ms = us / 1000;
    if (ms < 10) return `${ms.toFixed(2)} ms`;
    if (ms < 1000) return `${ms.toFixed(0)} ms`;
    return `${(ms / 1000).toFixed(2)} s`;
};

const TraceWaterfall: React.FC<Props> = ({ rows, loading = false, error = null, maxRows = 20 }) => {
    const computed = useMemo(() => {
        if (!rows) return null;
        const limited = rows.slice(0, maxRows);
        const totals = limited.map((r) => num(r.total_us));
        const max = totals.length ? Math.max(...totals) : 0;
        return { limited, max };
    }, [rows, maxRows]);

    if (error) {
        return <ErrorLine>{error.message || 'Search failed'}</ErrorLine>;
    }
    if (loading && (!computed || computed.limited.length === 0)) {
        return <StatusLine>Loading…</StatusLine>;
    }
    if (!computed || computed.limited.length === 0) {
        return <StatusLine>No request traces available in this time range.</StatusLine>;
    }

    const { limited, max } = computed;

    return (
        <Wrapper>
            <Legend>
                {(Object.keys(STAGE_COLORS) as Array<keyof typeof STAGE_COLORS>).map((stage) => (
                    <LegendItem key={stage} title={STAGE_LABELS[stage]}>
                        <Swatch $color={STAGE_COLORS[stage]} />
                        <span>{STAGE_LABELS[stage]}</span>
                    </LegendItem>
                ))}
            </Legend>
            <Header>
                <Cell>Time</Cell>
                <Cell>URI</Cell>
                <Cell>Status</Cell>
                <Cell>Timeline</Cell>
                <Cell $align="right">Method</Cell>
                <Cell $align="right">Total</Cell>
            </Header>
            {limited.map((row, idx) => {
                const dt1 = num(row.dt1_us);
                const dt2 = num(row.dt2_us);
                const dt3 = num(row.dt3_us);
                const dt4 = num(row.dt4_us);
                const total = num(row.total_us);
                const statusNum = num(row.status);
                const isError = statusNum >= 400;

                const pct = (v: number): number => (max > 0 ? (v / max) * 100 : 0);
                const tooltip = `dt1: ${formatMs(dt1)} • dt2: ${formatMs(dt2)} • dt3: ${formatMs(dt3)} • dt4: ${formatMs(dt4)}`;

                return (
                    // eslint-disable-next-line react/no-array-index-key
                    <Row key={`row-${idx}`} $isError={isError} title={tooltip}>
                        <Cell>{formatTime(row._time)}</Cell>
                        <MonoCell title={String(row.uri ?? '')}>{row.uri ?? '—'}</MonoCell>
                        <Cell>{row.status ?? '—'}</Cell>
                        <Bar>
                            <Segment $width={pct(dt1)} $color={STAGE_COLORS.dt1} />
                            <Segment $width={pct(dt2)} $color={STAGE_COLORS.dt2} />
                            <Segment $width={pct(dt3)} $color={STAGE_COLORS.dt3} />
                            <Segment $width={pct(dt4)} $color={STAGE_COLORS.dt4} />
                        </Bar>
                        <Cell $align="right">{row.method ?? ''}</Cell>
                        <Cell $align="right">{formatMs(total)}</Cell>
                    </Row>
                );
            })}
        </Wrapper>
    );
};

export default TraceWaterfall;
