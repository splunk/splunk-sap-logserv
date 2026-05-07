import React, { useMemo } from 'react';
import styled from 'styled-components';
import Column from '@splunk/visualizations/Column';
import Line from '@splunk/visualizations/Line';
import Area from '@splunk/visualizations/Area';
import { useSearch } from '../hooks/useSearch';
import { logservTheme } from '../styles/logservTheme';
import { ChartPalette, paletteColors, STATUS_FIELD_COLORS } from '../styles/chartPalettes';
import GradientWrap from './GradientWrap';
import LegendTitleTooltips from './LegendTitleTooltips';

/** Default vertical-gradient darkness (0 = same color, 1 = black). */
const DEFAULT_GRADIENT_DARKEN = 0.4;

/**
 * TimeSeriesChart — wraps @splunk/visualizations/Column with our SearchJob
 * hook + a row-to-columnar adapter. Default expects results from a `timechart`
 * SPL with `_time` and one or more value fields (e.g., `count`).
 */

interface TimeSeriesChartProps {
    /** SPL query that produces `_time` + one or more value fields. */
    query: string;
    /** Default: the first non-`_time` field in the result fields. */
    valueFields?: string[];
    /** Chart height in px. Default: 280. */
    height?: number;
    /** Tooltip / legend formatter for the y-axis. */
    yLabel?: string;
    /** Semantic palette for the chart. See `chartPalettes.ts`. */
    palette?: ChartPalette;
    /** Override the palette's color array. Takes priority over `palette`. */
    seriesColors?: string[];
    /** Override / extend the palette's field-name color map.
     * Merged with the palette's STATUS_FIELD_COLORS if `palette="status"`. */
    seriesColorsByField?: Record<string, string>;
    /** Chart shape:
     *  - 'column' (default) — stacked vertical bars; good for low-density volume
     *  - 'line'             — multi-line; good for trend comparison across series
     *  - 'area'             — stacked area fill; good for cumulative composition
     *
     *  When switching from column to line, also consider whether your data
     *  density still fits the canvas — if you have >300 points, use a wider
     *  bin via `chooseTimechartSpan` from utils/timechartSpan.ts. */
    chartType?: 'column' | 'line' | 'area';
}

const Container = styled.div<{ $height: number }>`
    width: 100%;
    height: ${(p) => p.$height}px;
    position: relative;

    /* Highcharts' built-in legend pagination renders the "1/N" page
     * indicator as an SVG <text> element whose own class is
     * .highcharts-legend-navigation (NOT a descendant — the text element
     * itself carries the class). Default fill is black, unreadable on our
     * dark panel background. Force it to white so the page count is
     * legible. The arrow paths get .highcharts-legend-nav-active /
     * .highcharts-legend-nav-inactive — Highcharts already styles those
     * visibly so we leave them alone. */
    text.highcharts-legend-navigation {
        fill: ${logservTheme.colors.textActive} !important;
    }
`;

const StatusLine = styled.div`
    color: ${logservTheme.colors.textMuted};
    text-align: center;
    padding: ${logservTheme.spacing.lg};
    font-size: ${logservTheme.fontSize.small};
`;

const ErrorLine = styled(StatusLine)`
    color: ${logservTheme.colors.red};
`;

const rowsToColumnar = (
    rows: Array<Record<string, unknown>>,
    fieldNames: string[]
): { fields: { name: string }[]; columns: (string | number | null)[][] } => {
    const fields = fieldNames.map((name) => ({ name }));
    const columns = fieldNames.map((name) =>
        rows.map((row) => {
            const v = row[name];
            if (v === null || typeof v === 'undefined') return null;
            return v as string | number;
        })
    );
    return { fields, columns };
};

const TimeSeriesChart: React.FC<TimeSeriesChartProps> = ({
    query,
    valueFields,
    height = 280,
    yLabel,
    palette,
    seriesColors: seriesColorsProp,
    seriesColorsByField: seriesColorsByFieldProp,
    chartType = 'column',
}) => {
    const { results, loading, error } = useSearch({ query });

    const dataSources = useMemo(() => {
        if (!results || results.length === 0) {
            return null;
        }

        // Pick fields: always include `_time` first if present, then either
        // explicit valueFields or every non-underscore key found across the
        // entire result set.
        //
        // Scanning ALL rows (not just results[0]) matters because timechart
        // emits rows for empty bins with only `_time` + meta fields. If the
        // first few bins are empty, the value fields don't exist on the
        // first row, and a first-row-only scan would render zero series.
        const allRows = results as Array<Record<string, unknown>>;
        const fieldOrder: string[] = [];
        const seen = new Set<string>();
        for (const row of allRows) {
            for (const k of Object.keys(row)) {
                if (!seen.has(k)) {
                    seen.add(k);
                    fieldOrder.push(k);
                }
            }
        }
        const hasTime = seen.has('_time');
        const valueKeys = valueFields ?? fieldOrder.filter((k) => k !== '_time' && !k.startsWith('_'));
        const fieldNames = hasTime ? ['_time', ...valueKeys] : valueKeys;

        const data = rowsToColumnar(allRows, fieldNames);
        return {
            primary: {
                data,
                meta: { totalCount: results.length, sid: '', app: '' },
                requestParams: { count: results.length, offset: 0 },
            },
        };
    }, [results, valueFields]);

    if (error) {
        return (
            <Container $height={height}>
                <ErrorLine>{error.message || 'Search failed'}</ErrorLine>
            </Container>
        );
    }

    if (loading && !dataSources) {
        return (
            <Container $height={height}>
                <StatusLine>Loading…</StatusLine>
            </Container>
        );
    }

    if (!dataSources) {
        return (
            <Container $height={height}>
                <StatusLine>No data in this time range.</StatusLine>
            </Container>
        );
    }

    const paletteSeriesColors = paletteColors(palette);
    const finalSeriesColors = seriesColorsProp ?? paletteSeriesColors;
    const paletteFieldColors = palette === 'status' ? STATUS_FIELD_COLORS : undefined;
    const finalFieldColors = seriesColorsByFieldProp
        ? { ...(paletteFieldColors ?? {}), ...seriesColorsByFieldProp }
        : paletteFieldColors;

    const options = {
        backgroundColor: 'transparent',
        showProgressBar: false,
        showLastUpdated: false,
        // Truncate long legend labels with a middle ellipsis (e.g.,
        // "hec53v013858" → "hec5…3858") and surface the full label in a
        // tooltip on hover. Splunk's LegendSeriesItem wraps each entry in
        // a StyledTooltip whose content is set to `label` only when the
        // text is overflowed — without setting `legendTruncation`, the
        // default lets text wrap which sidesteps the tooltip entirely.
        // Setting "ellipsisMiddle" forces JS-driven truncation so the
        // overflow signal is reliable AND the visible cue (…) hints
        // that hovering will reveal the full text.
        legendTruncation: 'ellipsisMiddle',
        ...(yLabel ? { yAxisTitleText: yLabel } : {}),
        ...(finalSeriesColors ? { seriesColors: finalSeriesColors } : {}),
        ...(finalFieldColors ? { seriesColorsByField: finalFieldColors } : {}),
    };

    const Viz = chartType === 'line' ? Line : chartType === 'area' ? Area : Column;

    // Line chart wrappers don't benefit from the column-bar gradient and
    // can render slightly cleaner without it. Skip the wrap for line type.
    const chart = (
        <Container $height={height}>
            <Viz dataSources={dataSources} width="100%" height={height} options={options} />
        </Container>
    );
    const wrapped = chartType === 'line' ? chart : (
        <GradientWrap darkenAmount={DEFAULT_GRADIENT_DARKEN}>{chart}</GradientWrap>
    );
    // LegendTitleTooltips adds native HTML `title` attributes to legend
    // items so hover reveals the full label even when it's been truncated
    // by `legendTruncation: ellipsisMiddle`. Splunk's own StyledTooltip
    // has a timing issue (content set on mouseenter but the tooltip
    // already missed the open window) — native title attrs sidestep it.
    return <LegendTitleTooltips>{wrapped}</LegendTitleTooltips>;
};

export default TimeSeriesChart;
