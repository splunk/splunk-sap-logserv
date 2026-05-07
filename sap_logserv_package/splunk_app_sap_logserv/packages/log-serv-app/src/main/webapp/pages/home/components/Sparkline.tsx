import React, { useState } from 'react';
import styled from 'styled-components';
import { useSearch } from '../hooks/useSearch';
import { logservTheme } from '../styles/logservTheme';

/**
 * Sparkline — tiny inline SVG line chart for KPI tiles.
 *
 * Two surfaces:
 *   - <Sparkline> — pure visual. Takes an array of numbers (and optional
 *     timestamps for hover tooltips).
 *   - <SparklineFromQuery> — wires a Splunk timechart query to a Sparkline.
 *
 * Hover behavior: moving the mouse over the chart snaps to the nearest data
 * point and shows a tooltip with the timestamp and value, plus a dashed
 * guide line and dot at the hovered point. Skips null/empty data points.
 */

interface SparklineProps {
    values: Array<number | null | undefined>;
    /** Optional timestamps (ISO strings or unix-second numbers) aligned with values. */
    times?: Array<string | number | null | undefined>;
    /** Optional label shown on the second tooltip line, e.g. "Total Events". */
    label?: string;
    /** Format the value for the tooltip. Defaults to integer with commas. */
    formatValue?: (v: number) => string;
    width?: number;
    height?: number;
    color?: string;
    fill?: boolean;
}

const Wrap = styled.div`
    display: block;
    line-height: 0;
    width: 100%;
`;

const SvgWrap = styled.div`
    position: relative;
    width: 100%;
`;

const ResponsiveSvg = styled.svg`
    width: 100%;
    display: block;
`;

const PlaceholderLine = styled.div<{ $height: number }>`
    width: 100%;
    height: ${(p) => p.$height}px;
    background: ${logservTheme.colors.tableHeaderBackground};
    border-radius: 2px;
`;

const Tooltip = styled.div<{ $left: number; $alignRight: boolean }>`
    position: absolute;
    bottom: calc(100% + 6px);
    left: ${(p) => (p.$alignRight ? 'auto' : `${p.$left}%`)};
    right: ${(p) => (p.$alignRight ? `${100 - p.$left}%` : 'auto')};
    transform: ${(p) => (p.$alignRight ? 'translateX(0)' : 'translateX(-50%)')};
    pointer-events: none;
    background: ${logservTheme.colors.tableHeaderBackground};
    color: ${logservTheme.colors.textActive};
    border: 1px solid ${logservTheme.colors.panelBorder};
    border-radius: 3px;
    padding: 6px 10px;
    font-size: 11px;
    line-height: 1.5;
    white-space: nowrap;
    z-index: 10;
    font-feature-settings: 'tnum' 1;
`;

const TimeLine = styled.div`
    color: ${logservTheme.colors.textActive};
    font-size: 10px;
`;

const ValueLine = styled.div`
    color: ${logservTheme.colors.textActive};
    font-weight: ${logservTheme.fontWeight.semibold};
`;

const defaultFormat = (n: number): string => n.toLocaleString('en-US');

const formatTimeShort = (raw: string | number | null | undefined): string | null => {
    if (raw === null || typeof raw === 'undefined') return null;
    const d = typeof raw === 'number' ? new Date(raw * 1000) : new Date(String(raw));
    if (Number.isNaN(d.getTime())) return String(raw);
    return d.toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
    });
};

export const Sparkline: React.FC<SparklineProps> = ({
    values,
    times,
    label,
    formatValue,
    width = 140,
    height = 32,
    color = logservTheme.colors.cyanLight,
    fill = false,
}) => {
    const [hoverIdx, setHoverIdx] = useState<number | null>(null);

    const cleaned = (values ?? []).map((v) => (typeof v === 'number' && Number.isFinite(v) ? v : null));
    const numeric = cleaned.filter((v): v is number => v !== null);

    if (numeric.length < 2) {
        return (
            <Wrap>
                <PlaceholderLine $height={height} />
            </Wrap>
        );
    }

    const max = Math.max(...numeric);
    const min = Math.min(...numeric);
    const range = max - min || 1;
    const stepX = width / (cleaned.length - 1);

    const points = cleaned.map((v, i) => {
        const x = i * stepX;
        const y = v === null ? height / 2 : height - ((v - min) / range) * (height - 2) - 1;
        return { x, y, v };
    });

    // Build the line as ONE continuous path that skips over null/missing
    // values rather than breaking into separate subpaths. This way the line
    // stays connected — visually consistent with the area fill, which also
    // interpolates across nulls.
    let d = '';
    points.forEach((p) => {
        if (p.v === null) return;
        d += `${d ? 'L' : 'M'} ${p.x.toFixed(2)} ${p.y.toFixed(2)} `;
    });

    // Build the fill area as ONE closed polygon over the non-null points only.
    // We can't reuse the line `d` here because if the line has null gaps it
    // contains multiple `M` subpaths — and a trailing `Z` only closes the
    // LAST subpath, producing a diagonal closing edge that bleeds the fill
    // across the chart. A separate single-subpath polygon avoids that.
    let areaD = '';
    if (fill) {
        const drawn = points.filter((p) => p.v !== null);
        if (drawn.length >= 2) {
            const first = drawn[0];
            const last = drawn[drawn.length - 1];
            const top = drawn
                .map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(2)} ${p.y.toFixed(2)}`)
                .join(' ');
            areaD = `${top} L ${last.x.toFixed(2)} ${height} L ${first.x.toFixed(2)} ${height} Z`;
        }
    }

    const handleMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
        const rect = e.currentTarget.getBoundingClientRect();
        if (rect.width === 0) return;
        const ratio = (e.clientX - rect.left) / rect.width;
        const idx = Math.max(0, Math.min(cleaned.length - 1, Math.round(ratio * (cleaned.length - 1))));
        if (cleaned[idx] === null) {
            setHoverIdx(null);
            return;
        }
        setHoverIdx(idx);
    };

    const handleMouseLeave = () => setHoverIdx(null);

    const fmt = formatValue ?? defaultFormat;
    const hoverPoint = hoverIdx !== null ? points[hoverIdx] : null;
    const hoverValue = hoverIdx !== null ? cleaned[hoverIdx] : null;
    const hoverTime = hoverIdx !== null && times ? formatTimeShort(times[hoverIdx]) : null;
    const hoverLeftPct = hoverIdx !== null ? (hoverIdx / (cleaned.length - 1)) * 100 : 0;
    // Flip the tooltip to align right when the hovered point is in the right ~20%
    // of the chart, otherwise the tooltip overflows the KPI card.
    const alignRight = hoverLeftPct > 80;

    return (
        <Wrap>
            <SvgWrap>
                <ResponsiveSvg
                    height={height}
                    viewBox={`0 0 ${width} ${height}`}
                    preserveAspectRatio="none"
                    onMouseMove={handleMouseMove}
                    onMouseLeave={handleMouseLeave}
                >
                    {fill && areaD && <path d={areaD} fill={color} fillOpacity={0.18} />}
                    <path
                        d={d}
                        fill="none"
                        stroke={color}
                        strokeWidth={1.5}
                        strokeLinejoin="round"
                        vectorEffect="non-scaling-stroke"
                    />
                    {hoverPoint && hoverValue !== null && (
                        <>
                            <line
                                x1={hoverPoint.x}
                                y1={0}
                                x2={hoverPoint.x}
                                y2={height}
                                stroke={color}
                                strokeWidth={1}
                                strokeDasharray="2,2"
                                opacity={0.6}
                                vectorEffect="non-scaling-stroke"
                                pointerEvents="none"
                            />
                            <circle
                                cx={hoverPoint.x}
                                cy={hoverPoint.y}
                                r={2.5}
                                fill={color}
                                stroke={logservTheme.colors.panelBackground}
                                strokeWidth={1}
                                vectorEffect="non-scaling-stroke"
                                pointerEvents="none"
                            />
                        </>
                    )}
                </ResponsiveSvg>
                {hoverPoint && hoverValue !== null && (
                    <Tooltip $left={hoverLeftPct} $alignRight={alignRight}>
                        {hoverTime && <TimeLine>{hoverTime}</TimeLine>}
                        <ValueLine>
                            {label ? `${label}: ` : ''}
                            {fmt(hoverValue)}
                        </ValueLine>
                    </Tooltip>
                )}
            </SvgWrap>
        </Wrap>
    );
};

interface SparklineFromQueryProps {
    /** SPL — typically a `... | timechart span=1d <agg> AS <field>` form. */
    query: string;
    /** The field name to read from each timechart bucket. */
    valueField: string;
    /** Optional label shown in the hover tooltip (e.g. "Total Events"). */
    label?: string;
    /** Format the value for the tooltip. Defaults to integer with commas. */
    formatValue?: (v: number) => string;
    width?: number;
    height?: number;
    color?: string;
    fill?: boolean;
}

export const SparklineFromQuery: React.FC<SparklineFromQueryProps> = ({
    query,
    valueField,
    label,
    formatValue,
    width,
    height,
    color,
    fill,
}) => {
    const { results, error } = useSearch({ query });
    if (error || !results) {
        return <Sparkline values={[]} width={width} height={height} color={color} fill={fill} />;
    }
    const values = results.map((row) => {
        const raw = (row as Record<string, unknown>)[valueField];
        if (raw === null || typeof raw === 'undefined') return null;
        const n = typeof raw === 'number' ? raw : parseFloat(String(raw));
        return Number.isFinite(n) ? n : null;
    });
    const times = results.map((row) => {
        const raw = (row as Record<string, unknown>)._time;
        if (raw === null || typeof raw === 'undefined') return null;
        return raw as string | number;
    });
    return (
        <Sparkline
            values={values}
            times={times}
            label={label}
            formatValue={formatValue}
            width={width}
            height={height}
            color={color}
            fill={fill}
        />
    );
};

export default Sparkline;
