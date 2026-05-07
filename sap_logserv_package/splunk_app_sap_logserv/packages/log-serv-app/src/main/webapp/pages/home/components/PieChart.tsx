import React, { useMemo } from 'react';
import styled from 'styled-components';
import Pie from '@splunk/visualizations/Pie';
import { useSearch } from '../hooks/useSearch';
import { logservTheme } from '../styles/logservTheme';
import { ChartPalette, paletteColors, STATUS_FIELD_COLORS } from '../styles/chartPalettes';
import GradientWrap from './GradientWrap';
import LegendTitleTooltips from './LegendTitleTooltips';

const DEFAULT_GRADIENT_DARKEN = 0.4;

/**
 * PieChart — wraps @splunk/visualizations/Pie with our SearchJob hook +
 * the row-to-columnar adapter. Optional donut hole. Default: donut.
 *
 * Expects results with two fields: a category string field and a count field.
 */

interface PieChartProps {
    /** SPL query producing a 2-column result: category + count. */
    query: string;
    /** Field name to use as the category label. Default: first non-count field. */
    categoryField?: string;
    /** Field name to use as the value. Default: 'count'. */
    valueField?: string;
    height?: number;
    /** Show as donut (with center hole). Default: true. */
    donut?: boolean;
    /** Semantic palette for the slices. See `chartPalettes.ts`. */
    palette?: ChartPalette;
    /** Override the palette's color array. Takes priority over `palette`. */
    seriesColors?: string[];
    /** Override / extend the palette's field-name color map. */
    seriesColorsByField?: Record<string, string>;
}

const Container = styled.div<{ $height: number }>`
    width: 100%;
    height: ${(p) => p.$height}px;
    position: relative;

    /* Highcharts renders the "1/N" page indicator as an SVG <text> whose
     * own class is .highcharts-legend-navigation (not a descendant).
     * Default fill is black — force white so the page count is legible
     * on our dark panel background. */
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

const PieChart: React.FC<PieChartProps> = ({
    query,
    categoryField,
    valueField = 'count',
    height = 280,
    donut = true,
    palette,
    seriesColors: seriesColorsProp,
    seriesColorsByField: seriesColorsByFieldProp,
}) => {
    const { results, loading, error } = useSearch({ query });

    const dataSources = useMemo(() => {
        if (!results || results.length === 0) return null;

        const firstRow = results[0] as Record<string, unknown>;
        const allKeys = Object.keys(firstRow);
        const catKey = categoryField ?? allKeys.find((k) => k !== valueField && !k.startsWith('_')) ?? allKeys[0];

        const fieldNames = [catKey, valueField];
        const columns = fieldNames.map((name) =>
            (results as Array<Record<string, unknown>>).map((row) => {
                const v = row[name];
                if (v === null || typeof v === 'undefined') return null;
                return v as string | number;
            })
        );

        return {
            primary: {
                data: { fields: fieldNames.map((name) => ({ name })), columns },
                meta: { totalCount: results.length, sid: '', app: '' },
                requestParams: { count: results.length, offset: 0 },
            },
        };
    }, [results, categoryField, valueField]);

    if (error) {
        return <Container $height={height}><ErrorLine>{error.message || 'Search failed'}</ErrorLine></Container>;
    }
    if (loading && !dataSources) {
        return <Container $height={height}><StatusLine>Loading…</StatusLine></Container>;
    }
    if (!dataSources) {
        return <Container $height={height}><StatusLine>No data in this time range.</StatusLine></Container>;
    }

    const paletteSeriesColors = paletteColors(palette);
    const finalSeriesColors = seriesColorsProp ?? paletteSeriesColors;
    const paletteFieldColors = palette === 'status' ? STATUS_FIELD_COLORS : undefined;
    const finalFieldColors = seriesColorsByFieldProp
        ? { ...(paletteFieldColors ?? {}), ...seriesColorsByFieldProp }
        : paletteFieldColors;

    const pieOptions = {
        backgroundColor: 'transparent',
        showProgressBar: false,
        showLastUpdated: false,
        showDonutHole: donut,
        // Truncate long category labels with a middle ellipsis and surface
        // the full label in a tooltip on hover. See TimeSeriesChart for
        // the rationale — Splunk's legend item already wraps each entry
        // in a StyledTooltip that fires only when truncation actually
        // occurs, so explicit ellipsisMiddle truncation is the trigger.
        legendTruncation: 'ellipsisMiddle',
        ...(finalSeriesColors ? { seriesColors: finalSeriesColors } : {}),
        ...(finalFieldColors ? { seriesColorsByField: finalFieldColors } : {}),
    };

    return (
        <LegendTitleTooltips>
            <GradientWrap darkenAmount={DEFAULT_GRADIENT_DARKEN}>
                <Container $height={height}>
                    <Pie
                        dataSources={dataSources}
                        width="100%"
                        height={height}
                        options={pieOptions}
                    />
                </Container>
            </GradientWrap>
        </LegendTitleTooltips>
    );
};

export default PieChart;
