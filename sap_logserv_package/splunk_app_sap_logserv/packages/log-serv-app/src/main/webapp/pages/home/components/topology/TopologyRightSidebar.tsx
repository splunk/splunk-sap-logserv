import React, { useCallback, useState } from 'react';
import styled from 'styled-components';
import FramedPanel from '../FramedPanel';
import { logservTheme } from '../../styles/logservTheme';
import { useThemeMode } from '../../state/ThemeModeProvider';
import type { ColorTokens } from '../../styles/magneticTokens';
import { darken } from '../../utils/colorMath';
import { formatCallCount } from '../../topology/edgeStyle';
import type { TopologyNode, TopologyEdge } from '../../topology/types';
import { isDatabaseTag, displayTag } from '../../topology/types';
import type { NodeError, NodeHost } from '../../hooks/useNodeData';
import type { UseEdgeDataResult } from '../../hooks/useEdgeData';
import {
    classifyHostOwnership,
    donutSegments,
    hasInflatedWedges,
    partnerColorAt,
    splitPartners,
    trafficTotal,
    visibleWedgeCount,
} from '../../topology/panelFacts';
import type {
    EdgeAppServerRow,
    EndpointAttribution,
    Ownership,
    PartnerEntry,
    TrafficRow,
} from '../../topology/panelFacts';
import { enrichmentSourceLabel, groupUsersBySource } from '../../topology/enrichment';
import type { IpEnrichmentEntry } from '../../topology/enrichment';

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
    /* Light text on the colored fill in BOTH modes (build 259). */
    color: ${logservTheme.colors.inverseText};
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
    /* Build 324 / session 109 — horizontal section dividers in every
     * right-panel tab: a hairline above each section caption separates
     * it from the preceding section (tab-leading captions get a rule
     * under the tab bar, which reads as consistent chrome). */
    border-top: 1px solid ${logservTheme.colors.panelBorderWeak};
    padding-top: 10px;
    margin-top: 10px;
`;

/* Build 324 — explicit divider for section seams that have no
 * ChartCaption heading (e.g. the Overview disclosure block). */
const SectionDivider = styled.div`
    border-top: 1px solid ${logservTheme.colors.panelBorderWeak};
    margin-top: 10px;
    padding-top: 2px;
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
/** Shown instead of "no events" when the three edge reads were deliberately
 *  not dispatched, so the pane never asserts an absence it did not measure. */
const NOT_DISPATCHED_MSG =
    'This edge carries no stored rollup key, so nothing was queried.';

/** Stable empty array for the optional traffic prop — a `?? []` at the use site
 *  would hand a fresh identity to every render. */
const EMPTY_TRAFFIC: TrafficRow[] = [];

/** Rendered when a rendered edge spans more stored edges than one read may
 *  splice: the tab totals then cover only part of the edge, and must say so. */
const TruncationNote = ({ used, total }: { used: number; total: number }) => (
    <EmptyMsg style={{ fontSize: 10, padding: '0 0 6px' }}>
        {`Showing the first ${used.toLocaleString()} of ${total.toLocaleString()} underlying edges — totals below are partial.`}
    </EmptyMsg>
);

const shortSourcetype = (st: string): string => {
    if (!st) return '';
    return st.startsWith('sap:') ? st.slice(4) : st;
};

/** Color palette for donut wedges — cycled deterministically by
 *  `partnerColorAt`, which steps the shade once per completed cycle so an
 *  unbounded partner list never runs out of colors. Built from the RESOLVED
 *  mode tokens (not logservTheme var() refs) because the wedge colors land on
 *  SVG `fill` attributes in DonutChart, where CSS variables don't resolve.
 *  Build 246 / Phase 0.
 *
 *  Build 322: `textMuted` dropped — it is the SAME hex in both modes, so
 *  shading it buries it in the dark panel background and washes it out on
 *  white. Ordered so the two near-duplicate pairs the palette contains
 *  (orange/orangeLight, cyanAccent/cyanLight) are far apart in the cycle and
 *  never land on adjacent legend rows. The gate asserts that the first
 *  MAX_LEGEND_ROWS+1 generated colors stay at least as discriminable as this
 *  base set (§8a-12). */
const partnerPalette = (c: ColorTokens): string[] => [
    c.teal,
    c.orange,
    c.purple,
    c.cyanAccent,
    c.redLight,
    c.orangeLight,
    c.cyanLight,
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
 * One donut wedge. `id` is the React key and the attribution lookup key; `code`
 * is display text only. Keying on the label was safe only while the list was
 * sliced to four — distinct node ids can share a label (ids hash `kind:value`,
 * labels are the bare value), and a duplicate key silently drops a wedge from a
 * chart whose centre total still includes it (§8a-11).
 */
interface DonutDatum {
    id: string;
    code: string;
    calls: number;
    color: string;
    /* Build 331 / session 112 — the per-row ownership badge was REMOVED at
     * user direction ("just show the IP and # calls"): retargeting folds
     * every inventoried address into its owner's node, so "owner not
     * established" was the only verdict a legend row could reach, and a
     * uniform column of it read as noise. Ownership still renders where it
     * can actually vary: the Hosts tab rows and the Edge Details
     * "By app server" table. */
}

/**
 * The hover text for one wedge (and its legend row): the endpoint, its exact
 * call count, and its share of this chart's total. The share is stated because
 * the angle cannot be trusted to convey it — a slice too small to survive its
 * own 1 px stroke is widened to stay visible.
 */
const wedgeTooltip = (d: DonutDatum, total: number): string => {
    const pct = total > 0 ? (d.calls / total) * 100 : 0;
    const shown = pct > 0 && pct < 0.1 ? '<0.1' : pct.toFixed(1);
    return `${d.code} — ${d.calls.toLocaleString()} calls (${shown}% of ${total.toLocaleString()})`;
};

/**
 * Hand-rolled SVG donut chart. Center hole shows the exact total.
 * ~120 px square.
 *
 * Build 322 — three rendering defects the old top-4 cap was hiding:
 *   - wedges are stroked 1 px against a ~314 px circumference, so anything
 *     under ~0.6% was consumed by its own stroke while its legend row claimed
 *     a color. `donutSegments` reserves a minimum sliver per wedge.
 *   - `arcPath(0, 1)` is a degenerate arc-to-itself and draws NOTHING, which
 *     single-wedge donuts hit every time once one donut became two. The
 *     build-227/228 full-circle fix is ported here.
 *   - an empty data array divided by zero and emitted an invalid path under a
 *     centre reading "0 calls". Callers render an empty state instead, and the
 *     guard below is defence in depth.
 */
const DonutChart: React.FC<{ data: DonutDatum[]; label: string }> = ({ data, label }) => {
    const W = 120;
    const cx = W / 2;
    const cy = W / 2;
    const r = 50;
    const innerR = 32;
    const total = data.reduce((s, d) => s + d.calls, 0);
    const values = data.map((d) => d.calls);
    const wedges = visibleWedgeCount(values);
    const segments = donutSegments(values);

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
        /* Build 246 / Phase 0: fill/stroke moved to inline `style` — the
         * logservTheme values are var(--lsv-*) refs, which resolve in CSS
         * positions (inline style) but not attribute positions. Wedge
         * colors (d.color) are already resolved hex from partnerPalette. */
        <svg width={W} height={W} role="img" aria-label={label}>
            {wedges === 1 && (() => {
                /* A single wedge is the whole ring: draw it as a stroked
                 * circle, because a 0..360 arc path renders as nothing. */
                const only = data[values.findIndex((v) => v > 0)];
                return (
                    <circle
                        cx={cx}
                        cy={cy}
                        r={(r + innerR) / 2}
                        fill="none"
                        stroke={only?.color}
                        strokeWidth={r - innerR}
                    >
                        {only && <title>{wedgeTooltip(only, total)}</title>}
                    </circle>
                );
            })()}
            {wedges > 1 && data.map((d, i) => {
                const seg = segments[i];
                if (!seg || seg.t1 <= seg.t0) return null;
                return (
                    /* An SVG <title> child is the browser's own tooltip — no
                     * positioning code, no portal, and it survives the panel's
                     * overflow clipping. Same idiom the chart legends use
                     * (components/LegendTitleTooltips.tsx, session 016). It
                     * carries the EXACT count and share, which matters because
                     * the wedge ANGLE is only approximate once a small slice
                     * has been widened to stay visible. */
                    <path
                        key={d.id}
                        d={arcPath(seg.t0, seg.t1)}
                        fill={d.color}
                        style={{ stroke: logservTheme.colors.panelBackground }}
                        strokeWidth={1}
                    >
                        <title>{wedgeTooltip(d, total)}</title>
                    </path>
                );
            })}
            <text x={cx} y={cy - 2} textAnchor="middle" fontSize="11" fontWeight="600" style={{ fill: logservTheme.colors.textActive }}>{formatCallCount(total)}</text>
            <text x={cx} y={cy + 12} textAnchor="middle" fontSize="9" style={{ fill: logservTheme.colors.textMuted }}>calls</text>
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
        /* Nothing here truncates: the label WRAPS. min-width: 0 is still
         * load-bearing (build 322) because a flex item's automatic minimum is
         * its min-content width — without it a long hostname refuses to shrink
         * and pushes the count out of the row with no scrollbar, and the exact
         * count is precisely what justifies the donut's approximate angles.
         * The overflow-wrap rule lets an unbroken IP or FQDN wrap inside the
         * column rather than overflow it. */
        flex: 1;
        min-width: 0;
        overflow-wrap: anywhere;
        font-family: monospace;
        font-size: 10px;
    }
    .count {
        color: ${logservTheme.colors.textMuted};
        font-variant-numeric: tabular-nums;
        flex-shrink: 0;
    }
    /* Build 331 — the build-322 per-row ownership chip (.owner) was removed
     * with the badge column (user direction; see the DonutDatum comment). */
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

/** The ownership verdict as the panel says it. "shared" is deliberately NOT a
 *  word used here: absence from the inventory has at least four causes and we
 *  have measured none of them (§8a-6). */
const ownershipText = (o: Ownership | undefined | null): string | null => {
    if (!o || o.state === 'none') return null;
    if (o.state === 'owner') return `owner: ${o.sid}`;
    return 'owner not established';
};

/**
 * One direction's partner donut with its legend directly beneath it.
 *
 * The legend lists EVERY partner — no row cap and no remainder row. It was
 * briefly capped at eight rows with the remainder disclosed, to keep the two
 * stacked blocks short; the user asked for the full list instead. The right
 * zone already scrolls, so a wide fan-out makes this block tall rather than
 * incomplete, and nothing about the node's traffic is left unnamed.
 */
const PartnerDonutBlock: React.FC<{
    title: string;
    data: DonutDatum[];
    calls: number;
    emptyMsg: string;
}> = ({ title, data, calls, emptyMsg }) => {
    const total = data.reduce((s, d) => s + d.calls, 0);
    return (
        <ChartBlock>
            <ChartCaption>
                {data.length > 0
                    ? `${title} · ${data.length} · ${calls.toLocaleString()} calls`
                    : title}
            </ChartCaption>
            {data.length === 0 ? (
                <EmptyMsg style={{ fontSize: 11, padding: '8px 0' }}>{emptyMsg}</EmptyMsg>
            ) : (
                <>
                    <DonutChart data={data} label={title} />
                    {/* Build 331 — legend rows are swatch + endpoint + count only;
                      * the ownership badge column was removed at user direction
                      * (see the DonutDatum comment). */}
                    <DonutLegend>
                        {data.map((d) => {
                            const tip = wedgeTooltip(d, total);
                            return (
                                <li key={d.id} title={tip}>
                                    <span className="swatch" style={{ background: d.color }} />
                                    <span className="code">{d.code}</span>
                                    <span className="count">{formatCallCount(d.calls)}</span>
                                </li>
                            );
                        })}
                    </DonutLegend>
                </>
            )}
        </ChartBlock>
    );
};

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
    /* Light text on the accent fill in BOTH modes (build 259). */
    color: ${logservTheme.colors.inverseText};
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
    /** Build 322 — distinct hosts BEFORE the read's cap, so the caption states
     *  "20 of 47" rather than presenting the cap as the count. */
    nodeHostTotal?: number | null;
    /** Build 325 (plan item D1) — the selected node's window host count from
     *  the bulk node_host read, for the Overview "Hosts (in range)" facts
     *  row. The parent gates it to SID + tenant nodes; undefined renders no
     *  row. Same metric + window as the Hosts tab, so it agrees with that
     *  tab's caption (dispatch timing across an hourly-aggregate boundary
     *  can briefly differ). */
    nodeHostCount?: number | null;
    /** Build 329 / session 112 — the IP enrichment index (hostname + user
     *  names per IP, from logserv_topology_ip_enrichment, label-keyed).
     *  Drives the Overview "Hostname" / "Users" rows under the Tag row for
     *  IP-labeled partner squares. Latest-known semantics — NOT bound to
     *  the time picker; the "Names as of" line carries the honesty. */
    ipEnrichment?: ReadonlyMap<string, IpEnrichmentEntry>;
    /** Build 322 — the selected node's traffic rows, accounting for 100% of
     *  its calls. Pass a stable array (a `?? []` in JSX would hand this a new
     *  identity every render and invalidate the memo below). */
    nodeTraffic?: TrafficRow[];
    /** Build 322 — node id -> canonical + inventory owner, built in the hook.
     *  An id absent from this record renders NO badge (§8a-7). */
    endpointAttribution?: Record<string, EndpointAttribution>;
    /** Build 322 — canonical_value -> owning SID, for the Hosts tab's rows
     *  (raw host names, the one legitimately value-keyed lookup). */
    hostOwnerByValue?: Record<string, string>;
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
    /* Resolved hex tokens — stopColor is an SVG attribute + darken() needs
     * literal hex (build 246 / Phase 0). */
    const { tokens } = useThemeMode();
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
                    <stop offset="0%" stopColor={tokens.cyanLight} stopOpacity="1" />
                    <stop offset="100%" stopColor={darken(tokens.cyanLight, 0.4)} stopOpacity="1" />
                </linearGradient>
                <linearGradient id="activity-grad-error" x1="0" x2="0" y1="0" y2="1">
                    <stop offset="0%" stopColor={tokens.red} stopOpacity="1" />
                    <stop offset="100%" stopColor={darken(tokens.red, 0.4)} stopOpacity="1" />
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
    nodeHostTotal,
    nodeHostCount,
    ipEnrichment,
    nodeTraffic,
    endpointAttribution,
    hostOwnerByValue,
    selectedEdge,
    edgeNodes,
    edgeData,
    onCollapse,
    tab: controlledTab,
    onTabChange,
    edgeTab: controlledEdgeTab,
    onEdgeTabChange,
}) => {
    /* Resolved hex tokens for the donut wedge palette + HourlyChart color
     * (SVG fill attributes + darken() — var() refs don't work there).
     * Named PARTNER_PALETTE to match the pre-build-246 module constant so
     * the existing usage sites below stay textually identical. */
    const { tokens, mode } = useThemeMode();
    const PARTNER_PALETTE = React.useMemo(() => partnerPalette(tokens), [tokens]);
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

    /* Build 329 / session 112 — the selected node's IP enrichment entry
     * (label-keyed; non-IP labels miss the map by construction). Plain
     * lookup, no memo — Map.get is O(1). */
    const selectedIpEnrichment: IpEnrichmentEntry | null = (selectedNode && ipEnrichment
        ? ipEnrichment.get(selectedNode.label) ?? null
        : null);

    /** Resolve edge endpoint id back to a human-readable label. Backed by a
     *  memoised map since build 322: the partner list is no longer capped at
     *  four, so a linear scan per partner per donut per render put an
     *  O(partners x nodes) cost in the panel-drag path. Falls back to the raw
     *  id (SHA1[:16]) if no match. */
    const labelById = React.useMemo(
        () => new Map((edgeNodes ?? []).map((n) => [n.id, n.label])),
        [edgeNodes],
    );
    const labelForEndpoint = useCallback(
        (id: string): string => labelById.get(id) ?? id,
        [labelById],
    );

    /**
     * Partners split by GRAPH ROLE (build 322, replacing the build-205
     * top-4 + OTHER donut).
     *
     * Two things the old single donut deliberately did NOT claim, and which
     * the split has to get right:
     *   - It summed both directions, so it made no direction claim. Splitting
     *     forces every partner into one bucket, so edges stored
     *     `direction="bidi"` — whose source/target ordering is an artefact of
     *     how the SPL arm assembles the pair — are excluded from both and
     *     surfaced on their own line (§8a-8).
     *   - It sliced to four, so its legend could not over-claim. Every partner
     *     is now listed and counted; only the LEGEND is bounded, by a named
     *     remainder (§8a-10).
     */
    const partnerSplit = React.useMemo(
        () => splitPartners(selectedNodeIncomingEdges, selectedNodeOutgoingEdges),
        [selectedNodeIncomingEdges, selectedNodeOutgoingEdges],
    );

    /**
     * Turn one direction's partners into donut data. Labels are resolved for
     * display only; the id is the key AND the attribution lookup, so a
     * label-collision cannot leak across rows. Where two partners in the
     * SAME donut resolve to the same label (a `tenant_db` and a `sid` share
     * theirs by design), the canonical kind disambiguates the visible text —
     * two identical rows with different counts is unreadable regardless of
     * the React key. (Build 331: the per-row ownership badge is gone; the
     * attribution now feeds ONLY this disambiguation.)
     */
    const buildDonutData = useCallback(
        (entries: PartnerEntry[]): DonutDatum[] => {
            const labels = entries.map((p) => labelForEndpoint(p.id));
            const seen = new Map<string, number>();
            labels.forEach((l) => seen.set(l, (seen.get(l) ?? 0) + 1));
            return entries.map((p, i) => {
                /* The id-keyed attribution lookup stays: it disambiguates
                 * label collisions (a tenant_db and a sid share a label by
                 * design). Build 331 removed only the ownership badge. */
                const att = endpointAttribution ? endpointAttribution[p.id] : undefined;
                const dup = (seen.get(labels[i]) ?? 0) > 1;
                return {
                    id: p.id,
                    code: dup && att?.kind ? `${labels[i]} (${att.kind})` : labels[i],
                    calls: p.calls,
                    color: partnerColorAt(PARTNER_PALETTE, i, mode),
                };
            });
        },
        [labelForEndpoint, endpointAttribution, PARTNER_PALETTE, mode],
    );

    /* Declared above the edge-branch early return so the hooks stay
     * unconditional. Memoised rather than computed in the render body: the
     * partner list is unbounded since build 322, and the dashboard re-renders
     * on every mousemove while a panel divider is being dragged. */
    const inboundDonut = React.useMemo(
        () => buildDonutData(partnerSplit.inbound),
        [buildDonutData, partnerSplit.inbound],
    );
    const outboundDonut = React.useMemo(
        () => buildDonutData(partnerSplit.outbound),
        [buildDonutData, partnerSplit.outbound],
    );

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
                                    <tr>
                                        <td className="k">{splType === 'hana_audit' ? 'Auth failures (CONNECT)' : 'Errors in window'}</td>
                                        <td className="v">{(selectedEdge.errorCount ?? 0).toLocaleString()}</td>
                                    </tr>
                                    {selectedEdge.callCount > 0 && (
                                        <tr><td className="k">Error rate</td><td className="v">{errorRate.toFixed(2)}%</td></tr>
                                    )}
                                    {selectedEdge.splSourcetype && (
                                        <tr><td className="k">Sourcetype</td><td className="v">{shortSourcetype(selectedEdge.splSourcetype)}</td></tr>
                                    )}
                                </tbody>
                            </FactsTable>
                            {/* Build 325 (plan item E3) — RFC edges only: the per-app-
                              * server split of this edge's calls, grouped by the stored
                              * SID-side gateway listening address (local_ip). The rows
                              * partition the member rows, so Calls sums to the facts
                              * table's "Calls in window" by construction. Shown for any
                              * RFC edge, even one row — it names the app server. The
                              * caption counts only NAMED addresses: a "(not recorded)"
                              * bucket is explicitly not an app server. */}
                            {splType === 'rfc' && selectedEdge.appServers && selectedEdge.appServers.length > 0 && (() => {
                                /* Captured once: the outer && guard's narrowing does
                                 * not reach into this closure. */
                                const appServers = selectedEdge.appServers as EdgeAppServerRow[];
                                const namedCount = appServers.filter((a) => a.localIp !== null).length;
                                return (
                                <>
                                    <ChartCaption>
                                        {namedCount > 0
                                            ? `By app server · ${namedCount} · current time range`
                                            : 'By app server · current time range'}
                                    </ChartCaption>
                                    <EmptyMsg style={{ fontSize: 10, padding: '0 0 6px' }}>
                                        {`Each row is a SID-side gateway listening address this edge's calls were recorded against — the app servers of ${sourceLabel} as the gateway log names them, not a full instance inventory. Ownership comes from the system inventory and is not limited to the selected time range; an address without an owner is one the inventory has not attributed to exactly one system.`}
                                    </EmptyMsg>
                                    {appServers.some((a) => a.localIp === null) && (
                                        <EmptyMsg style={{ fontSize: 10, padding: '0 0 6px' }}>
                                            Calls recorded before the per-app-server upgrade carry no
                                            address and are grouped as “(not recorded)”. Running Clear +
                                            Backfill on the Environment Topology (graph) rollup from
                                            Settings → Dashboard Data resolves them — note the clear
                                            discards graph history older than the backfill window, so on
                                            long-established installs check the release notes for the
                                            RFC-only alternative that keeps it.
                                        </EmptyMsg>
                                    )}
                                    <TableScroll>
                                        <DataTable>
                                            <thead>
                                                <tr>
                                                    <th>App server</th>
                                                    <th className="num">Calls</th>
                                                    <th className="num">Errors</th>
                                                </tr>
                                            </thead>
                                            <tbody>
                                                {appServers.map((a) => {
                                                    const owner = a.localIp
                                                        ? ownershipText(classifyHostOwnership(a.localIp, hostOwnerByValue ?? {}))
                                                        : null;
                                                    return (
                                                        <tr key={a.localIp ?? '(not recorded)'}>
                                                            <td className="primary">
                                                                <div>{a.localIp ?? '(not recorded)'}</div>
                                                                {owner && <div className="secondary">{owner}</div>}
                                                            </td>
                                                            <td className="num">{a.calls.toLocaleString()}</td>
                                                            <td className="num">{a.errors.toLocaleString()}</td>
                                                        </tr>
                                                    );
                                                })}
                                            </tbody>
                                        </DataTable>
                                    </TableScroll>
                                </>
                                );
                            })()}
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
                                    {edgeData?.dispatched
                                        ? 'No grouping data for this edge in the current time range.'
                                        : NOT_DISPATCHED_MSG}
                                </EmptyMsg>
                            )}
                            {edgeData?.truncated && (
                                <TruncationNote used={edgeData.idsUsed} total={edgeData.idsTotal} />
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
                                        label="Top entities on this edge"
                                        data={edgeData.operations.map((op, i) => ({
                                            id: op.entity,
                                            code: op.entity,
                                            calls: op.count,
                                            color: partnerColorAt(PARTNER_PALETTE, i, mode),
                                        }))}
                                    />
                                    <DonutLegend>
                                        {edgeData.operations.map((op, i) => (
                                            <li key={op.entity}>
                                                <span className="swatch" style={{ background: partnerColorAt(PARTNER_PALETTE, i, mode) }} />
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
                                {/* No rfc headline cells: the only candidates were
                                    icm_tasks max/avg, which no saved search computes
                                    (the fields appear solely in the aggregate's `| fields`
                                    projection), so they could only ever render an em dash.
                                    Dropped in build 321 rather than shipped beside a
                                    newly-live histogram looking like pending data. */}
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
                            {edgeData?.truncated && (
                                <TruncationNote used={edgeData.idsUsed} total={edgeData.idsTotal} />
                            )}
                            {!edgeData?.performanceLoading && edgeData?.performance && edgeData.performance.length > 0 && (
                                <>
                                    <ChartCaption style={{ marginTop: 12 }}>
                                        {splType === 'http' ? 'Status class distribution'
                                            : splType === 'rfc' ? 'icm_tasks distribution'
                                            : splType === 'hana_audit' ? 'Action status mix'
                                            : splType === 'hana_tenant' ? 'SQL duration (avg + max)'
                                            : 'Distribution'}
                                    </ChartCaption>
                                    {splType === 'hana_tenant' && (
                                        <EmptyMsg style={{ fontSize: 10, padding: '0 0 6px' }}>
                                            Percentiles are not available here: they cannot be merged
                                            across hourly buckets, so this reads mean and maximum.
                                        </EmptyMsg>
                                    )}
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
                                    {edgeData?.dispatched
                                        ? 'No errors for this edge in the current time range.'
                                        : NOT_DISPATCHED_MSG}
                                </EmptyMsg>
                            )}
                            {edgeData?.truncated && (
                                <TruncationNote used={edgeData.idsUsed} total={edgeData.idsTotal} />
                            )}
                            {!edgeData?.errorsLoading && edgeData?.errors && edgeData.errors.length > 0 && (
                                <>
                                    <ChartCaption>
                                        {`Top ${edgeData.errors.length} error mode${edgeData.errors.length === 1 ? '' : 's'} · ${
                                            splType === 'hana_audit'
                                                ? 'all unsuccessful operations'
                                                : 'current time range'
                                        }`}
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
        ? tokens.red
        : tokens.cyanLight;

    /* Build 322 — the CANONICAL kind decides every ownership claim below. Not
     * the visual kind, and never the label: a tenant database node shares its
     * label with the application SID it backs, and `useNodeData` dispatches the
     * same label-scoped read for both, so canonical kind is the only thing that
     * separates them. On an IP-kind node the Hosts rows are the SAP-side hosts
     * on the OTHER end of the connection, where an ownership badge would read
     * as the exact opposite of the truth (§8a-5). */
    const selectedAttribution = endpointAttribution
        ? endpointAttribution[selectedNode.id]
        : undefined;
    const isSidNode = selectedAttribution?.kind === 'sid';
    const bidiTypeText = partnerSplit.bidiTypes.length > 0
        ? partnerSplit.bidiTypes.map(edgeTypeLabel).join(' / ')
        : 'Some';

    const trafficRows = nodeTraffic ?? EMPTY_TRAFFIC;
    const trafficSum = trafficTotal(trafficRows);
    const hostsShown = nodeHosts ? nodeHosts.length : 0;
    const hostsTotal = typeof nodeHostTotal === 'number' && nodeHostTotal > 0
        ? nodeHostTotal
        : hostsShown;
    const hostsTruncated = hostsTotal > hostsShown;

    return (
        <Stack>
            <FramedPanel title="Details" actions={collapseAction}>
                <NodeIdRow>
                    <SidBadge $kind={selectedNode.kind}>{selectedNode.label}</SidBadge>
                    <KindChip $kind={selectedNode.kind}>
                        {selectedNode.kind === 'sid_focused' ? 'SID (HIGH TRAFFIC)' : selectedNode.kind === 'sid_secondary' ? 'SID' : 'PARTNER'}
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
                                <tr><td className="k">Kind</td><td className="v">{selectedNode.kind === 'sid_focused' ? 'High Traffic SID' : selectedNode.kind === 'sid_secondary' ? 'Regular Traffic SID' : 'Remote partner'}</td></tr>
                                <tr><td className="k">Tag</td><td className="v">{displayTag(selectedNode.tag as never)}</td></tr>
                                {/* Build 329 / session 112 — IP enrichment rows, placed
                                  * directly under the Tag row (user-ratified). Hostname
                                  * renders only when unambiguous (the guards live in
                                  * topology/enrichment.ts — suppress over guess);
                                  * users are source-labeled and ALL listed (decision
                                  * 1/2); "Names as of" carries the latest-known
                                  * honesty (decision 4 — this data is deliberately
                                  * NOT bound to the time picker). */}
                                {selectedIpEnrichment?.hostname && (
                                    <tr>
                                        <td className="k">Hostname</td>
                                        <td className="v">{`${selectedIpEnrichment.hostname} (${selectedIpEnrichment.hostnameSources.map(enrichmentSourceLabel).join(', ')})`}</td>
                                    </tr>
                                )}
                                {selectedIpEnrichment && selectedIpEnrichment.userCount > 0 && (
                                    <tr>
                                        <td className="k">{selectedIpEnrichment.userCount === 1 ? 'User' : `Users (${selectedIpEnrichment.userCount})`}</td>
                                        <td className="v">
                                            {groupUsersBySource(selectedIpEnrichment)
                                                .map((g) => `${g.label}: ${g.names.join(', ')}`)
                                                .join(' · ')}
                                        </td>
                                    </tr>
                                )}
                                {selectedIpEnrichment && (
                                    <tr>
                                        <td className="k">Names as of</td>
                                        <td className="v">{formatRelative(selectedIpEnrichment.lastSeen)}</td>
                                    </tr>
                                )}
                                <tr><td className="k">Events</td><td className="v">{selectedNode.eventCount.toLocaleString()}</td></tr>
                                {/* Build 325 (plan item D1) — from the bulk node_host
                                  * rollup read: the same metric + window as the Hosts
                                  * tab, so it agrees with that tab's caption (dispatch
                                  * timing across an hourly-aggregate boundary can
                                  * briefly differ). Parent-gated to SID + tenant nodes;
                                  * absent = no row (an absent row is not a claim). The
                                  * tenant label-collision hedge renders below the
                                  * table, where a sentence fits. */}
                                {nodeHostCount != null && nodeHostCount > 0 && (
                                    <tr><td className="k">Hosts (in range)</td><td className="v">{nodeHostCount.toLocaleString()}</td></tr>
                                )}
                                {/* Build 322 — the exact per-direction totals live here, not
                                  * in the donut centres, which abbreviate via formatCallCount
                                  * ("11.6K"). Without them the reconciliation the split makes
                                  * possible would be thrown away at the last step (§8a-8).
                                  * The partition matches the donuts: bidirectional edges are
                                  * counted separately, never filed under in or out. */}
                                <tr><td className="k">Total calls</td><td className="v">{totalCalls.toLocaleString()}</td></tr>
                                <tr><td className="k">Inbound calls</td><td className="v">{partnerSplit.inboundCalls.toLocaleString()}</td></tr>
                                <tr><td className="k">Outbound calls</td><td className="v">{partnerSplit.outboundCalls.toLocaleString()}</td></tr>
                                {partnerSplit.bidiEdges > 0 && (
                                    <tr><td className="k">Bidirectional calls</td><td className="v">{partnerSplit.bidiCalls.toLocaleString()}</td></tr>
                                )}
                                <tr><td className="k">Inbound edges</td><td className="v">{selectedNodeIncomingEdges.filter((e) => e.direction !== 'bidi').length}</td></tr>
                                <tr><td className="k">Outbound edges</td><td className="v">{selectedNodeOutgoingEdges.filter((e) => e.direction !== 'bidi').length}</td></tr>
                                {partnerSplit.bidiEdges > 0 && (
                                    <tr><td className="k">Bidirectional edges</td><td className="v">{partnerSplit.bidiEdges}</td></tr>
                                )}
                                {selectedNode.healthPct != null && (
                                    <tr><td className="k">Health</td><td className="v">{selectedNode.healthPct}%</td></tr>
                                )}
                            </tbody>
                        </FactsTable>
                        {/* Build 325 — the §8a-5 hedge for the tenant host count:
                          * the count is scoped by the node's NAME, which a tenant
                          * database shares with the application system it backs, so
                          * without this sentence the row would present that
                          * system's hosts as the tenant's. SID nodes need no hedge
                          * (their count means exactly what the row says). */}
                        {nodeHostCount != null && nodeHostCount > 0
                            && selectedAttribution?.kind === 'tenant_db' && (
                            <EmptyMsg style={{ fontSize: 10, padding: '2px 0 0' }}>
                                {`The host count is scoped by the name ${selectedNode.label}, which this tenant database shares with an application system — so it counts that system's hosts. The Hosts tab lists them.`}
                            </EmptyMsg>
                        )}

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
                        {/* Build 322 — two donuts, stacked, each with its own legend.
                          * Captioned by GRAPH ROLE rather than IN/OUT: the panel can
                          * say which side of an edge a partner sits on, and does not
                          * claim a traffic direction for edges the data records as
                          * bidirectional. */}
                        {/* The empty state must not deny traffic the same screen
                          * reports. hana_tenant is both the only arm emitting a
                          * tenant database AND the only one stored bidirectional,
                          * so a tenant node's edges are 100% bidi and BOTH donuts
                          * are empty — directly under a Facts table showing its
                          * call total. Say why they are empty, not that nothing
                          * happened. */}
                        <ChartRow>
                            <PartnerDonutBlock
                                title={isSidNode ? 'Partners calling this system' : 'Endpoints calling this node'}
                                data={inboundDonut}
                                calls={partnerSplit.inboundCalls}
                                emptyMsg={partnerSplit.bidiEdges > 0
                                    ? 'No inbound-recorded traffic — this node’s bidirectional calls are counted separately (see below).'
                                    : 'Nothing calls this node in the current time range.'}
                            />
                        </ChartRow>
                        <ChartRow>
                            <PartnerDonutBlock
                                title={isSidNode ? 'Partners this system calls' : 'Endpoints this node calls'}
                                data={outboundDonut}
                                calls={partnerSplit.outboundCalls}
                                emptyMsg={partnerSplit.bidiEdges > 0
                                    ? 'No outbound-recorded traffic — this node’s bidirectional calls are counted separately (see above).'
                                    : 'This node calls nothing in the current time range.'}
                            />
                        </ChartRow>
                        {partnerSplit.bidiEdges > 0 && (
                            <EmptyMsg style={{ fontSize: 10, padding: '4px 0 0' }}>
                                {`${bidiTypeText} traffic is recorded as bidirectional (${partnerSplit.bidiCalls.toLocaleString()} calls on ${partnerSplit.bidiEdges} edge${partnerSplit.bidiEdges === 1 ? '' : 's'}) and is not split between the two charts.`}
                            </EmptyMsg>
                        )}
                        {totalCalls > 0 && (
                            <>
                                <SectionDivider />
                                {/* Build 331 — the two ownership-provenance paragraphs
                                  * that stood here left with the legend badge column
                                  * (user direction: rows show the endpoint and its
                                  * call count only). */}
                                <EmptyMsg style={{ fontSize: 10, padding: '4px 0 0' }}>
                                    This breakdown covers every integration type, including any
                                    unchecked in the toolbar filter.
                                    {/* Fires exactly when the geometry stops encoding
                                      * proportion — a slice too small to survive its own
                                      * stroke is widened to stay visible — rather than at a
                                      * proxy like a partner count. */}
                                    {hasInflatedWedges(inboundDonut.map((d) => d.calls))
                                        || hasInflatedWedges(outboundDonut.map((d) => d.calls))
                                        ? ' Slices too small to be visible are drawn at a minimum size, so those angles are approximate — hover any slice for its exact count and share.'
                                        : ''}
                                </EmptyMsg>
                            </>
                        )}
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
                                {/* Build 322 — `partnerColorAt` instead of a bare modulo:
                                  * the palette is 7 long and this list runs to 8, so the
                                  * last program used to repeat the first one's colour. */}
                                <DonutChart
                                    label="Top ABAP ICM programs"
                                    data={nodePrograms.map((p, i) => ({
                                        id: p.program,
                                        code: p.program,
                                        calls: p.count,
                                        color: partnerColorAt(PARTNER_PALETTE, i, mode),
                                    }))}
                                />
                                <DonutLegend>
                                    {nodePrograms.map((p, i) => (
                                        <li key={p.program}>
                                            <span className="swatch" style={{ background: partnerColorAt(PARTNER_PALETTE, i, mode) }} />
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
                                    {hostsTruncated
                                        ? `${hostsShown} of ${hostsTotal} hosts · current time range`
                                        : `${hostsShown} host${hostsShown === 1 ? '' : 's'} · current time range`}
                                </ChartCaption>
                                {/* A cap that is reached is a cap that is reported — the
                                  * MAX_EDGE_IDS precedent. Without this the caption would
                                  * present the cap as the host count, and the ownership
                                  * column would make that undercount load-bearing (§8a-4). */}
                                {hostsTruncated && (
                                    <EmptyMsg style={{ fontSize: 10, padding: '0 0 6px' }}>
                                        {`Showing the ${hostsShown.toLocaleString()} busiest of ${hostsTotal.toLocaleString()} hosts.${
                                            isSidNode ? ' The ownership shown below covers only these.' : ''
                                        }`}
                                    </EmptyMsg>
                                )}
                                {/* Branch on the CANONICAL kind, not on "not a SID". The read is
                                  * scoped by the node's LABEL, and a tenant database shares its
                                  * label with the application system it backs — so its rows are
                                  * that system's hosts, reached through a name collision. They
                                  * are not "the far end of the connection", which is only true
                                  * for an ip-kind node. */}
                                <EmptyMsg style={{ fontSize: 10, padding: '0 0 6px' }}>
                                    {isSidNode
                                        ? 'Hosts that logged events for this system. Ownership comes from the system inventory, which records a host only once it has been seen carrying exactly one SAP system identifier — "owner not established" means that has not happened yet, and the inventory is not limited to the selected time range.'
                                        : selectedAttribution?.kind === 'tenant_db'
                                            ? `These rows are scoped by the name ${selectedNode.label}, which this tenant database shares with an application system, so they may include that system's hosts.`
                                            : selectedAttribution?.kind === 'ip'
                                                ? 'Hosts that logged events referencing this address. They sit on the SAP side of the connection, so no ownership is claimed for them here.'
                                                : 'Hosts that logged events matching this node’s name. No ownership is claimed for them here.'}
                                </EmptyMsg>
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
                                            {nodeHosts.map((h) => {
                                                const owner = isSidNode
                                                    ? ownershipText(classifyHostOwnership(h.host, hostOwnerByValue ?? {}))
                                                    : null;
                                                return (
                                                    <tr key={h.host}>
                                                        <td className="primary">
                                                            <div>{h.host}</div>
                                                            {/* Build 325 (plan item D2) — the SAP instance numbers
                                                              * recorded on this host's events, from the rollup's new
                                                              * `instances` measure. Absent (no clause) when the rows
                                                              * carry none — including rows aggregated pre-325. */}
                                                            <div className="secondary">
                                                                {`${h.sourcetypeCount} sourcetype${h.sourcetypeCount === 1 ? '' : 's'}${
                                                                    h.instances && h.instances.length > 0
                                                                        ? ` · inst ${h.instances.join(', ')}`
                                                                        : ''
                                                                } · first seen ${formatRelative(h.firstSeen)}`}
                                                            </div>
                                                            {owner && <div className="secondary">{owner}</div>}
                                                        </td>
                                                        <td className="num">{h.count.toLocaleString()}</td>
                                                        <td className="relTime">{formatRelative(h.lastSeen)}</td>
                                                    </tr>
                                                );
                                            })}
                                        </tbody>
                                    </DataTable>
                                </TableScroll>
                            </>
                        )}
                        {/* Build 322 — calls by host. Rows are classified per EDGE, so
                          * every incident edge lands in exactly one of them and the
                          * column sums to `Total calls` on the Overview tab. Rendered
                          * independently of the hosts table above: the two come from
                          * different collections and either can be empty alone. */}
                        {trafficRows.length > 0 && (
                            <>
                                <ChartCaption style={{ marginTop: 12 }}>
                                    Calls by host and edge type · current time range
                                </ChartCaption>
                                {/* A structural statement, not an enumeration of types: on a
                                  * partner node there are no host rows at all, and an inbound
                                  * RFC row is neither "a call this node makes" nor "recorded
                                  * against a system as a whole". The Events clause renders only
                                  * when the table it refers to is actually on screen. */}
                                <EmptyMsg style={{ fontSize: 10, padding: '0 0 6px' }}>
                                    {`A row names a host only when this node's own side of the edge is a hostname, which is always the receiving side; otherwise the calls are grouped by edge type.${
                                        trafficSum === totalCalls
                                            ? ` Together the rows account for all ${totalCalls.toLocaleString()} calls on this node's edges.`
                                            : ''
                                    }${
                                        nodeHosts && nodeHosts.length > 0
                                            ? ' "Calls" counts edge calls; the Events column above counts log events, from a different rollup.'
                                            : ''
                                    }`}
                                </EmptyMsg>
                                <TableScroll>
                                    <DataTable>
                                        <thead>
                                            <tr>
                                                <th>Host / edge type</th>
                                                <th className="num">Calls</th>
                                                <th className="num">Errors</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {trafficRows.map((t) => (
                                                <tr key={`${t.scope}-${t.key}-${t.flow}`}>
                                                    <td className="primary">
                                                        <div>{t.scope === 'host' ? t.key : edgeTypeLabel(t.key)}</div>
                                                        <div className="secondary">
                                                            {t.scope === 'host'
                                                                ? t.flow
                                                                : `${t.flow} · this node’s side is not a host`}
                                                        </div>
                                                    </td>
                                                    <td className="num">{t.calls.toLocaleString()}</td>
                                                    <td className="num">{t.errors.toLocaleString()}</td>
                                                </tr>
                                            ))}
                                            <tr>
                                                <td className="primary">Total</td>
                                                <td className="num">{trafficSum.toLocaleString()}</td>
                                                <td className="num" />
                                            </tr>
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
