import React, { useMemo } from 'react';
import styled from 'styled-components';
import Column from '@splunk/visualizations/Column';
import Line from '@splunk/visualizations/Line';
import Pie from '@splunk/visualizations/Pie';
import { logservTheme } from '../../../styles/logservTheme';
import { paletteColors, ChartPalette, STATUS_FIELD_COLORS } from '../../../styles/chartPalettes';
import FramedPanel from '../../FramedPanel';
import DataTable, { ColumnDef } from '../../DataTable';
import GradientWrap from '../../GradientWrap';
import LegendTitleTooltips from '../../LegendTitleTooltips';
import { Hidden, unwrapHidden } from '../../ai/types/Hidden';
import { MCPToolResult } from '../../ai/mcp/MCPClient';
import { detectToolError } from '../../../utils/mcpErrorDetect';
import { resolveDashboardLinks } from '../../../routes/dashboardLinks';
import { buildSplunkSearchUrl } from '../../../utils/drilldownUrls';

/**
 * ToolResultPanel — renders the hidden result of an MCP tool call as one
 * of the dashboard primitives (DataTable / TimeSeriesChart-equivalent /
 * KpiCard-equivalent / PieChart-equivalent) based on the prompt's
 * `renderHint` and the actual row shape.
 *
 * The chart renderers here are inline (use the underlying Splunk viz
 * primitives directly with synthesized `dataSources`) rather than
 * delegating to the dashboard-side chart components — those wrap the
 * `useSearch` hook and run their own SPL, but we already have the rows
 * in hand from the MCP response.
 *
 * Privacy invariant: this component reads from `Hidden<MCPToolResult>`
 * via `unwrapHidden()`, but the unwrapped value is rendered to React
 * elements only. Those elements never reach the AI provider — the
 * outbound payload builder consumes only `Visible<Message>[]` and
 * cannot accept React nodes.
 */

const DEFAULT_GRADIENT_DARKEN = 0.4;
const TIME_SERIES_HEIGHT = 320;
const PIE_HEIGHT = 280;

interface ToolResultPanelProps {
    title: string;
    subtitle?: string;
    /** The Hidden result wrapper. */
    result: Hidden<MCPToolResult>;
    /** Primary render hint — dictates the dominant visualization. */
    renderHint?: 'table' | 'timechart' | 'kpi' | 'pie';
    /** Optional companion chart hint. Only honored when renderHint
     *  resolves to 'table' — surfaces the same data as both a chart
     *  (on top) AND a table (below) so users get the at-a-glance
     *  shape PLUS the sortable detail. Ignored when renderHint is
     *  itself a chart type. */
    chartHint?: 'timechart' | 'kpi' | 'pie';
    /** Optional explicit palette name. When provided, overrides the
     *  auto-detect heuristic. Read from the intent map's per-prompt
     *  `chartPalette` field. Build 139 — replaces the prior
     *  `paletteColors('volume')` hardcode that gave every timechart
     *  the same cool-spectrum colors regardless of metric type. */
    chartPalette?: ChartPalette;
    /** When provided, renders a "Clear" button in the panel header. The
     *  caller is responsible for the actual removal (typically calling
     *  `removeToolResult(toolUseId)` on the AIAssistant context). */
    onClear?: () => void;
    /** Optional related-dashboard slug(s). Single string or array — the
     *  panel renders one `↗ Dashboard` link per resolvable slug in the
     *  title-row actions, opening the dashboard in a new tab. Sourced
     *  from the intent map's per-prompt `dashboard` field, plumbed
     *  through the dispatch path → ToolResult metadata → here.
     *  Build 156 / session 027. */
    dashboard?: string | string[];
    /** Optional SPL string for the "↗ Run SPL" drill-down chip in
     *  the actions slot. When set, the panel renders a chip that opens
     *  Splunk's Search app in a new tab with this SPL pre-populated and
     *  the dispatch's earliest/latest tokens pre-applied. Omitted on
     *  synthetic blocked-SPL results so the chip doesn't help the user
     *  manually run a security-blocked query. Build 172. */
    spl?: string;
    /** Splunk earliest token used at dispatch time. Plumbed into the
     *  drill-down URL so a -24h verify query opens Search at -24h, not
     *  the user's current TimeRange picker. Build 172. */
    earliest?: string;
    /** Splunk latest token. See `earliest`. */
    latest?: string;
}

const Wrapper = styled.div`
    margin-bottom: ${logservTheme.spacing.md};
`;

const ErrorLine = styled.div`
    color: ${logservTheme.colors.red};
    padding: ${logservTheme.spacing.md};
    font-size: ${logservTheme.fontSize.body};
`;

const EmptyLine = styled.div`
    color: ${logservTheme.colors.textMuted};
    padding: ${logservTheme.spacing.md};
    font-size: ${logservTheme.fontSize.body};
    text-align: center;
`;

/**
 * Healthy-posture empty state. Distinct from EmptyLine (used for "no
 * fields in result" / chart fallbacks) — this signals "search ran
 * cleanly, zero matches, this dimension is healthy" rather than
 * "something is missing." Visually anchored with a green accent strip
 * + checkmark + the "clean posture" framing the AI uses in its trailer
 * "Other dimensions checked" line, so the right pane mirrors the chat.
 *
 * Added in session 019 to fix Issue A perception: 7-of-12 panels saying
 * only "No rows returned." with no attribution looked like missing
 * panels; now they are unmistakably "this dimension was checked and is
 * healthy."
 */
const HealthyEmptyWrap = styled.div`
    display: flex;
    align-items: center;
    gap: ${logservTheme.spacing.sm};
    padding: ${logservTheme.spacing.md};
    border-left: 3px solid ${logservTheme.colors.teal};
    background: rgba(0, 212, 180, 0.06);
    border-radius: ${logservTheme.radius.small};
`;

const HealthyCheck = styled.span`
    color: ${logservTheme.colors.teal};
    font-size: 18px;
    line-height: 1;
    flex-shrink: 0;
`;

const HealthyText = styled.div`
    color: ${logservTheme.colors.textActive};
    font-size: ${logservTheme.fontSize.body};
    line-height: 1.4;
`;

const HealthySubtext = styled.div`
    color: ${logservTheme.colors.textMuted};
    font-size: ${logservTheme.fontSize.small};
    margin-top: 2px;
`;

const ChartContainer = styled.div<{ $height: number }>`
    width: 100%;
    height: ${(p) => p.$height}px;
    position: relative;
    text.highcharts-legend-navigation {
        fill: ${logservTheme.colors.textActive} !important;
    }
`;

const KpiWrap = styled.div`
    padding: ${logservTheme.spacing.lg} ${logservTheme.spacing.md};
    text-align: center;
`;

const KpiValue = styled.div`
    color: ${logservTheme.colors.textActive};
    font-size: 36px;
    font-weight: ${logservTheme.fontWeight.semibold};
    margin-bottom: ${logservTheme.spacing.xs};
`;

const KpiLabel = styled.div`
    color: ${logservTheme.colors.textMuted};
    font-size: ${logservTheme.fontSize.small};
    text-transform: uppercase;
    letter-spacing: 0.04em;
`;

const SectionDivider = styled.div`
    margin: ${logservTheme.spacing.md} 0 ${logservTheme.spacing.sm};
    padding-top: ${logservTheme.spacing.sm};
    border-top: 1px solid ${logservTheme.colors.panelBorderWeak};
    color: ${logservTheme.colors.textMuted};
    font-size: ${logservTheme.fontSize.small};
    text-transform: uppercase;
    letter-spacing: 0.04em;
`;

const ClearButton = styled.button`
    background: transparent;
    border: 1px solid ${logservTheme.colors.panelBorderWeak};
    color: ${logservTheme.colors.textMuted};
    border-radius: ${logservTheme.radius.small};
    padding: 3px 10px;
    cursor: pointer;
    font-family: inherit;
    font-size: ${logservTheme.fontSize.small};

    &:hover {
        color: ${logservTheme.colors.red};
        border-color: ${logservTheme.colors.red};
    }
`;

/* Tile-row dashboard link (build 156 / session 027). Sits to the LEFT of
   the Clear button in the FramedPanel actions slot. Opens the relevant
   OOTB dashboard in a new browser tab. Styled to match ClearButton's
   geometry (same height + padding) but with the cyan accent so it reads
   as a "go-to" affordance instead of a destructive one. The ↗ glyph
   matches the next-step deep-link convention from build 141. */
const DashboardLink = styled.a`
    background: transparent;
    border: 1px solid ${logservTheme.colors.panelBorderWeak};
    color: ${logservTheme.colors.cyanLight};
    border-radius: ${logservTheme.radius.small};
    padding: 3px 10px;
    cursor: pointer;
    font-family: inherit;
    font-size: ${logservTheme.fontSize.small};
    text-decoration: none;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    transition: border-color 80ms ease-out, color 80ms ease-out;

    &:hover {
        color: ${logservTheme.colors.cyanLight};
        border-color: ${logservTheme.colors.cyanAccent};
        text-decoration: none;
    }

    &:focus {
        outline: 2px solid ${logservTheme.colors.cyanAccent};
        outline-offset: -2px;
    }
`;

const ActionsRow = styled.div`
    display: inline-flex;
    align-items: center;
    gap: ${logservTheme.spacing.sm};
`;

const ToolResultPanel: React.FC<ToolResultPanelProps> = ({
    title,
    subtitle,
    result,
    renderHint,
    chartHint,
    chartPalette,
    dashboard,
    spl,
    earliest,
    latest,
    onClear,
}) => {
    const inner = unwrapHidden(result);
    const rows = useMemo(() => extractRows(inner), [inner]);
    const dashboardLinks = useMemo(() => resolveDashboardLinks(dashboard), [dashboard]);
    // Build 172 — drill-down URL for the "↗ Run SPL" chip in the
    // actions slot. Hidden when no SPL is available (synthetic blocked-
    // SPL results, or paths that didn't plumb the SPL through). Uses the
    // shared `buildSplunkSearchUrl` (utils/drilldownUrls.ts) — the same
    // helper the dashboards use, so URL shape stays in lockstep.
    const splUrl = useMemo(
        () => (spl ? buildSplunkSearchUrl(spl, earliest, latest) : undefined),
        [spl, earliest, latest],
    );

    const hasAny = dashboardLinks.length > 0 || splUrl || onClear;
    const actions = hasAny ? (
        <ActionsRow>
            {dashboardLinks.map((d) => (
                <DashboardLink
                    key={d.slug}
                    href={d.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    title={`Open ${d.name} in a new tab`}
                    aria-label={`Open dashboard: ${d.name}`}
                >
                    <span aria-hidden>↗</span>
                    {d.name}
                </DashboardLink>
            ))}
            {splUrl && (
                <DashboardLink
                    href={splUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    title="Open this SPL in Splunk's Search app (new tab)"
                    aria-label="Open this SPL in Splunk Search"
                >
                    <span aria-hidden>↗</span>
                    Run SPL
                </DashboardLink>
            )}
            {onClear && (
                <ClearButton type="button" onClick={onClear} aria-label="Clear this result">
                    Clear
                </ClearButton>
            )}
        </ActionsRow>
    ) : undefined;

    return (
        <Wrapper>
            <FramedPanel title={title} subtitle={subtitle} actions={actions}>
                {renderBody(inner, rows, renderHint, chartHint, chartPalette)}
            </FramedPanel>
        </Wrapper>
    );
};

const renderBody = (
    inner: MCPToolResult,
    rows: Array<Record<string, unknown>>,
    renderHint: ToolResultPanelProps['renderHint'],
    chartHint?: ToolResultPanelProps['chartHint'],
    chartPalette?: ToolResultPanelProps['chartPalette'],
): React.ReactNode => {
    // Hard JSON-RPC errors AND soft MCP-server-domain errors
    // (`{status_code: 4xx, content: "..."}` embedded in content[0].text)
    // both render as a clean error block instead of a raw-JSON table.
    const detected = detectToolError(inner);
    if (detected) {
        return (
            <ErrorLine>
                {detected.statusCode ? `HTTP ${detected.statusCode}: ` : ''}
                {detected.message}
            </ErrorLine>
        );
    }
    if (rows.length === 0) {
        return (
            <HealthyEmptyWrap>
                <HealthyCheck aria-hidden>✓</HealthyCheck>
                <div>
                    <HealthyText>Healthy posture — no events matched.</HealthyText>
                    <HealthySubtext>
                        The search ran cleanly and returned zero rows for the selected
                        time window. Nothing to investigate here.
                    </HealthySubtext>
                </div>
            </HealthyEmptyWrap>
        );
    }

    const effectiveHint = renderHint ?? autoDetectHint(rows);

    // For chart/kpi-primary results, render the visualization on top
    // AND the underlying rows as a table below it so the user gets both
    // a quick-read visual AND the drillable detail. For table-primary
    // results that ALSO have a `chartHint` from the catalog, dispatch
    // on the chartHint to render a companion chart above the table.
    // Pure table-only (no chartHint) renders the table by itself.
    const tableEl = (
        <DataTable columns={extractColumns(rows)} rows={rows} pageSize={10} />
    );
    const renderChart = (hint: 'timechart' | 'kpi' | 'pie'): React.ReactNode => {
        switch (hint) {
            case 'timechart': return renderTimeSeries(rows, chartPalette);
            case 'pie': return renderPie(rows, chartPalette);
            case 'kpi': return renderKpi(rows);
        }
    };
    switch (effectiveHint) {
        case 'timechart':
        case 'pie':
        case 'kpi':
            return (
                <>
                    {renderChart(effectiveHint)}
                    <SectionDivider>Underlying data</SectionDivider>
                    {tableEl}
                </>
            );
        case 'table':
        default:
            if (chartHint) {
                return (
                    <>
                        {renderChart(chartHint)}
                        <SectionDivider>Underlying data</SectionDivider>
                        {tableEl}
                    </>
                );
            }
            return tableEl;
    }
};

// ─── row extraction ───────────────────────────────────────────────────────

/**
 * Pull the result rows out of the MCPToolResult. Resolution order:
 *   1. `structuredContent.results` — App 7931 saved-search responses
 *      already deliver this shape: `{ results: [...], truncated, total_rows }`.
 *      Most reliable; preferred when present.
 *   2. `content[0].text` parsed as JSON — text-only MCP tools serialize
 *      the same envelope into a string; we parse and extract `.results`.
 *   3. `content` itself if it's already an array of objects.
 *   4. `content.rows` — fallback for tools that follow a different
 *      convention.
 *
 * Falls back to `[]` for anything unrecognized so the UI shows
 * "No rows returned." rather than crashing.
 */
const extractRows = (
    inner: MCPToolResult,
): Array<Record<string, unknown>> => {
    // 1. structuredContent.results
    const sc = inner.structuredContent as Record<string, unknown> | undefined;
    if (sc && Array.isArray(sc.results)) {
        return (sc.results as Array<unknown>).filter(
            (r): r is Record<string, unknown> => typeof r === 'object' && r !== null,
        );
    }

    // 2. content[0].text JSON parse
    if (Array.isArray(inner.content)) {
        const first = inner.content[0] as Record<string, unknown> | undefined;
        if (first && typeof first.text === 'string') {
            try {
                const parsed = JSON.parse(first.text) as unknown;
                if (
                    parsed &&
                    typeof parsed === 'object' &&
                    Array.isArray((parsed as { results?: unknown }).results)
                ) {
                    return ((parsed as { results: Array<unknown> }).results).filter(
                        (r): r is Record<string, unknown> => typeof r === 'object' && r !== null,
                    );
                }
                if (Array.isArray(parsed)) {
                    return parsed.filter(
                        (r): r is Record<string, unknown> => typeof r === 'object' && r !== null,
                    );
                }
            } catch (_e) { /* not JSON, fall through */ }
        }
        // 3. content is already a row array
        return inner.content.filter(
            (r): r is Record<string, unknown> => typeof r === 'object' && r !== null,
        );
    }

    // 4. content.rows
    if (typeof inner.content === 'object' && inner.content !== null) {
        const c = inner.content as Record<string, unknown>;
        if (Array.isArray(c.rows)) {
            return (c.rows as Array<unknown>).filter(
                (r): r is Record<string, unknown> => typeof r === 'object' && r !== null,
            );
        }
    }

    return [];
};

const extractColumns = (rows: Array<Record<string, unknown>>): ColumnDef[] => {
    if (rows.length === 0) return [];
    const seen = new Set<string>();
    const order: string[] = [];
    for (const row of rows) {
        for (const k of Object.keys(row)) {
            if (!seen.has(k)) {
                seen.add(k);
                order.push(k);
            }
        }
    }
    return order.map((key) => ({ key, label: key }));
};

// ─── auto-detect render hint when none provided ────────────────────────────

const autoDetectHint = (
    rows: Array<Record<string, unknown>>,
): NonNullable<ToolResultPanelProps['renderHint']> => {
    if (rows.length === 0) return 'table';
    const first = rows[0];
    const keys = Object.keys(first);

    if (keys.includes('_time')) return 'timechart';
    if (rows.length === 1 && keys.length <= 2) return 'kpi';
    if (rows.length <= 25 && keys.length === 2 && hasNumericColumn(rows, keys)) return 'pie';
    return 'table';
};

/**
 * Strict numeric-string regex. Matches `123`, `-3.14`, `1.5e10`, etc.
 * Importantly, REJECTS multi-dot strings like IP addresses
 * (`147.204.127.97`) and version strings (`1.2.3`) — the prior loose
 * regex `/^[\d.+-eE]+$/` matched those and caused IP/version columns
 * to be mis-detected as numeric, which broke pie-chart value-column
 * selection (the renderer would pick `src_ip` instead of `query_count`
 * for the dns_beaconing search and produce a flat gray donut). */
const NUMERIC_STRING_RE = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

const hasNumericColumn = (
    rows: Array<Record<string, unknown>>,
    keys: string[],
): boolean =>
    keys.some((k) => rows.every((r) => typeof r[k] === 'number' || NUMERIC_STRING_RE.test(String(r[k] ?? ''))));

// ─── renderers ─────────────────────────────────────────────────────────────

const rowsToColumnar = (
    rows: Array<Record<string, unknown>>,
    fieldNames: string[],
): { fields: { name: string }[]; columns: (string | number | null)[][] } => {
    const fields = fieldNames.map((name) => ({ name }));
    const columns = fieldNames.map((name) =>
        rows.map((row) => {
            const v = row[name];
            if (v === null || typeof v === 'undefined') return null;
            return v as string | number;
        }),
    );
    return { fields, columns };
};

const buildDataSources = (
    rows: Array<Record<string, unknown>>,
    fieldNames: string[],
): {
    primary: {
        data: { fields: { name: string }[]; columns: (string | number | null)[][] };
        meta: { totalCount: number; sid: string; app: string };
        requestParams: { count: number; offset: number };
    };
} => ({
    primary: {
        data: rowsToColumnar(rows, fieldNames),
        meta: { totalCount: rows.length, sid: '', app: '' },
        requestParams: { count: rows.length, offset: 0 },
    },
});

/**
 * Auto-detect a chart palette when the prompt didn't declare one. Cheap
 * heuristic over the value-field names we'd plot:
 *
 *   1. Severity-bucket field names (INFO / WARNING / ERROR / FATAL /
 *      UNKNOWN / CRITICAL, any case) → `status`. The `status` palette
 *      uses STATUS_FIELD_COLORS to map each severity to a fixed color
 *      so the meaning sticks (red = error regardless of legend order).
 *   2. HTTP-status bucket names (`2xx`, `3xx`, `4xx`, `5xx`) → `status`
 *      for the same reason.
 *   3. Single-series timechart (one value column) → `volume`. Cyan-
 *      spectrum highlights the lone metric line cleanly.
 *   4. Default for multi-series → `categorical`. Any `count by host /
 *      sourcetype / peer / ...` falls here. The 14-color CATEGORICAL
 *      ramp gives wide hue separation, fixing the prior "everything
 *      looked cyan" issue. Build 139.
 */
const SEVERITY_VALUES = new Set<string>([
    'INFO', 'WARNING', 'ERROR', 'FATAL', 'UNKNOWN', 'CRITICAL',
    'info', 'warning', 'error', 'fatal', 'unknown', 'critical',
    'Info', 'Warning', 'Error', 'Fatal', 'Unknown', 'Critical',
]);
const HTTP_BUCKET_RE = /^[2-5]xx$/;
const autoDetectChartPalette = (valueKeys: string[]): ChartPalette => {
    if (valueKeys.length > 1 && valueKeys.every((k) => SEVERITY_VALUES.has(k))) return 'status';
    if (valueKeys.length > 1 && valueKeys.some((k) => HTTP_BUCKET_RE.test(k))) return 'status';
    if (valueKeys.length <= 1) return 'volume';
    return 'categorical';
};

const renderTimeSeries = (
    rows: Array<Record<string, unknown>>,
    chartPalette?: ChartPalette,
): React.ReactNode => {
    const allKeys = collectAllKeys(rows);
    const hasTime = allKeys.includes('_time');
    if (!hasTime) {
        // Hint says timechart but there's no _time column. Fall back to a
        // table so the user still sees something rather than an empty chart.
        return <DataTable columns={extractColumns(rows)} rows={rows} pageSize={10} />;
    }
    const valueKeys = allKeys.filter((k) => k !== '_time' && !k.startsWith('_'));
    if (valueKeys.length === 0) {
        return <DataTable columns={extractColumns(rows)} rows={rows} pageSize={10} />;
    }
    // > 5 series → multi-line chart per the project convention; otherwise
    // stacked column. Keeps high-cardinality timecharts legible.
    const useLine = valueKeys.length > 5;
    const fieldNames = ['_time', ...valueKeys];
    const dataSources = buildDataSources(rows, fieldNames);
    // Resolve palette: explicit > auto-detect. Status palette also wires
    // up STATUS_FIELD_COLORS so severity field names get fixed colors.
    const effectivePalette = chartPalette ?? autoDetectChartPalette(valueKeys);
    const options: Record<string, unknown> = {
        backgroundColor: 'transparent',
        showProgressBar: false,
        showLastUpdated: false,
        legendTruncation: 'ellipsisMiddle',
    };
    if (effectivePalette === 'status') {
        options.seriesColorsByField = STATUS_FIELD_COLORS;
    } else {
        const colors = paletteColors(effectivePalette);
        if (colors) options.seriesColors = colors;
    }
    const Viz = useLine ? Line : Column;
    const chart = (
        <ChartContainer $height={TIME_SERIES_HEIGHT}>
            <Viz dataSources={dataSources} width="100%" height={TIME_SERIES_HEIGHT} options={options} />
        </ChartContainer>
    );
    const wrapped = useLine ? chart : (
        <GradientWrap darkenAmount={DEFAULT_GRADIENT_DARKEN}>{chart}</GradientWrap>
    );
    return <LegendTitleTooltips>{wrapped}</LegendTitleTooltips>;
};

const renderPie = (
    rows: Array<Record<string, unknown>>,
    chartPalette?: ChartPalette,
): React.ReactNode => {
    const keys = collectAllKeys(rows);
    if (keys.length < 2) {
        return <DataTable columns={extractColumns(rows)} rows={rows} pageSize={10} />;
    }
    // valueKey selection — three-tier heuristic:
    //   1. Prefer columns whose NAME matches known metric patterns
    //      (`count`, `total`, `sum`, `_pct`, `_ms`, `_rate`, etc.).
    //      Multiple aggregates per query are common (e.g. dns_beaconing
    //      returns query, src_ip, query_count, avg_t, time_var — where
    //      query_count is the headline metric and avg_t/time_var are
    //      diagnostic floats). The "last-numeric" rule alone gets this
    //      wrong; name-pattern matching gets it right.
    //   2. If none match, fall back to the LAST all-numeric column.
    //      SPL `stats count by A B` produces `[A, B, count]`, so the
    //      last numeric column is the metric in the common case.
    //   3. If no numeric columns at all, use keys[1] as a degenerate
    //      fallback (the renderer will then plot string-string).
    const isMetricName = (k: string): boolean => {
        const n = k.toLowerCase();
        return /(?:^|_)(count|total|sum|pct|percent|rate|ms|num|n)(?:_|$)/.test(n)
            || /^(count|total|sum|value)$/.test(n);
    };
    const isAllNumeric = (k: string): boolean =>
        rows.every((r) => typeof r[k] === 'number')
        || rows.every((r) => NUMERIC_STRING_RE.test(String(r[k] ?? '')));
    const lastMatch = (filter: (k: string) => boolean): string | undefined => {
        for (let i = keys.length - 1; i >= 0; i -= 1) {
            if (filter(keys[i])) return keys[i];
        }
        return undefined;
    };
    const numericKey =
        lastMatch((k) => isMetricName(k) && isAllNumeric(k)) ??
        lastMatch(isAllNumeric);
    const valueKey = numericKey ?? keys[1];

    // catKey — must be a NON-NUMERIC column (otherwise the chart shows
    // ambiguous numeric labels like raw timestamps). Filter to
    // non-numeric non-value columns first, then pick the highest
    // cardinality (resolves the cross-stack-auth case where `stack`
    // had cardinality 1 and `user` had cardinality 7 — `user` wins).
    // Falls back to any non-value column only if no non-numeric
    // candidate exists.
    const nonValueKeys = keys.filter((k) => k !== valueKey);
    const cardinalityFor = (k: string): number =>
        new Set(rows.map((r) => String(r[k] ?? ''))).size;
    const stringCandidates = nonValueKeys.filter((k) => !isAllNumeric(k));
    const catCandidates = stringCandidates.length > 0 ? stringCandidates : nonValueKeys;
    const catKey = catCandidates.length > 0
        ? catCandidates.reduce(
            (best, k) => (cardinalityFor(k) > cardinalityFor(best) ? k : best),
            catCandidates[0],
        )
        : keys[0];

    // Cap pie at PIE_MAX_WEDGES by value (descending). Splunk's Pie viz
    // can only fit ~14 callout labels around the edge — beyond that,
    // the smaller wedges become unlabeled noise. The tail rows get
    // collapsed into a single "Other (N more)" wedge so the user sees
    // the long-tail share without losing it. The full row set still
    // renders in the table below the chart, so no information is lost.
    const PIE_MAX_WEDGES = 15;
    const valueOf = (r: Record<string, unknown>): number => {
        const v = r[valueKey];
        if (typeof v === 'number') return v;
        const n = Number(String(v ?? ''));
        return Number.isFinite(n) ? n : 0;
    };
    let pieRows: Array<Record<string, unknown>> = rows;
    if (rows.length > PIE_MAX_WEDGES) {
        const sorted = [...rows].sort((a, b) => valueOf(b) - valueOf(a));
        const top = sorted.slice(0, PIE_MAX_WEDGES - 1);
        const tail = sorted.slice(PIE_MAX_WEDGES - 1);
        const tailSum = tail.reduce((s, r) => s + valueOf(r), 0);
        const otherRow: Record<string, unknown> = {
            [catKey]: `Other (${tail.length} more)`,
            [valueKey]: tailSum,
        };
        pieRows = [...top, otherRow];
    }

    const dataSources = buildDataSources(pieRows, [catKey, valueKey]);
    // Pie palette: explicit > 'categorical' default. The categorical
    // ramp's wide hue spread is the right default for pies because pie
    // wedges typically represent arbitrary categorical breakdowns
    // (top destinations, top users, top peers, etc.).
    const pieColors = paletteColors(chartPalette ?? 'categorical') ?? paletteColors('categorical');
    const options = {
        backgroundColor: 'transparent',
        showProgressBar: false,
        showLastUpdated: false,
        showDonutHole: true,
        legendTruncation: 'ellipsisMiddle',
        seriesColors: pieColors,
    };
    return (
        <LegendTitleTooltips>
            <GradientWrap darkenAmount={DEFAULT_GRADIENT_DARKEN}>
                <ChartContainer $height={PIE_HEIGHT}>
                    <Pie dataSources={dataSources} width="100%" height={PIE_HEIGHT} options={options} />
                </ChartContainer>
            </GradientWrap>
        </LegendTitleTooltips>
    );
};

const renderKpi = (rows: Array<Record<string, unknown>>): React.ReactNode => {
    if (rows.length === 0) return <EmptyLine>No rows returned.</EmptyLine>;
    const first = rows[0];
    const keys = Object.keys(first);
    if (keys.length === 0) return <EmptyLine>No fields in result.</EmptyLine>;

    // Pick the first numeric-looking field as the KPI value; the other
    // (if any) becomes the label. With one column, the column name itself
    // acts as the label. Uses the strict NUMERIC_STRING_RE so IP-like /
    // version-like strings don't get mis-detected as the KPI value.
    const numericKey =
        keys.find((k) => typeof first[k] === 'number') ??
        keys.find((k) => NUMERIC_STRING_RE.test(String(first[k] ?? ''))) ??
        keys[0];
    const labelKey = keys.find((k) => k !== numericKey);
    const value = String(first[numericKey] ?? '0');
    const labelText = labelKey ? String(first[labelKey] ?? numericKey) : numericKey;
    return (
        <KpiWrap>
            <KpiValue>{formatKpiNumber(value)}</KpiValue>
            <KpiLabel>{labelText}</KpiLabel>
        </KpiWrap>
    );
};

const formatKpiNumber = (raw: string): string => {
    const n = Number(raw);
    if (!Number.isFinite(n)) return raw;
    return n.toLocaleString();
};

const collectAllKeys = (rows: Array<Record<string, unknown>>): string[] => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const row of rows) {
        for (const k of Object.keys(row)) {
            if (!seen.has(k)) {
                seen.add(k);
                out.push(k);
            }
        }
    }
    return out;
};

export default ToolResultPanel;
