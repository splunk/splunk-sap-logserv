import React from 'react';
import styled from 'styled-components';
import KpiCard, { formatInteger } from '../components/KpiCard';
import FramedPanel from '../components/FramedPanel';
import DataTable, { ColumnDef } from '../components/DataTable';
import TimeSeriesChart from '../components/TimeSeriesChart';
import { SparklineFromQuery } from '../components/Sparkline';
import DashboardLayout from '../components/DashboardLayout';
import { useSearch } from '../hooks/useSearch';
import { useTimeRange } from '../state/TimeRangeProvider';
import { buildSplunkSearchUrl, openInNewTab, splQuote } from '../utils/drilldownUrls';
import { logservTheme } from '../styles/logservTheme';

/**
 * HANA Trace — honest port of v0.0.4.2 logserv_hana_trace.xml.
 *
 * 3 KPIs (Total / Errors-Fatal / Unique Components) + Trace Volume line + By-Severity stacked
 * column + Top Components table + Component-by-Severity column + Source File Hotspots table
 * + SID/Instance stacked column + Recent Errors/Fatal table.
 */

const KpiRow = styled.div`
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: ${logservTheme.elevation.panelGap};
    margin-bottom: ${logservTheme.elevation.panelGap};
    @media (max-width: 1100px) { grid-template-columns: 1fr; }
`;
const FullWidthPanel = styled.div`
    margin-bottom: ${logservTheme.elevation.panelGap};
`;
const PanelGrid2 = styled.div`
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: ${logservTheme.elevation.panelGap};
    margin-bottom: ${logservTheme.elevation.panelGap};
    @media (max-width: 1100px) { grid-template-columns: 1fr; }
`;

const ST = 'sourcetype="sap:hana:tracelogs"';
const COMP_FILTER = 'where len(hana_trace_component) > 3 AND hana_trace_component!="INFO" AND hana_trace_component!="of" AND hana_trace_component!="service:"';

const Q = {
    kpiTotal: `\`sap_logserv_idx_macro\` ${ST} | stats count`,
    kpiErrors: `\`sap_logserv_idx_macro\` ${ST} hana_trace_severity IN ("error", "fatal") | stats count`,
    kpiComponents: `\`sap_logserv_idx_macro\` ${ST} | stats dc(hana_trace_component) as components`,

    sparkTotal: `\`sap_logserv_idx_macro\` ${ST} | timechart span=1d count`,
    sparkErrors: `\`sap_logserv_idx_macro\` ${ST} hana_trace_severity IN ("error", "fatal") | timechart span=1d count`,
    sparkComponents: `\`sap_logserv_idx_macro\` ${ST} | timechart span=1d dc(hana_trace_component) as components`,

    traceVolume: `\`sap_logserv_idx_macro\` ${ST} | timechart span=1d count as "Trace Events"`,
    bySeverity: `\`sap_logserv_idx_macro\` ${ST} hana_trace_severity=* | timechart span=1d count by hana_trace_severity`,
    topComponents: `\`sap_logserv_idx_macro\` ${ST} hana_trace_component=*  | ${COMP_FILTER} | stats count as Events dc(hana_trace_source_file) as "Source Files" values(hana_trace_severity) as Severities by hana_trace_component | sort -Events | rename hana_trace_component as Component`,
    componentSeverity: `\`sap_logserv_idx_macro\` ${ST} hana_trace_component=* hana_trace_severity=*  | ${COMP_FILTER} | stats count by hana_trace_component hana_trace_severity | sort -count | chart sum(count) over hana_trace_component by hana_trace_severity | sort -info | rename hana_trace_component as Component`,
    sourceHotspots: `\`sap_logserv_idx_macro\` ${ST} hana_trace_source_file=*  | ${COMP_FILTER} | stats count as Events dc(hana_trace_source_line) as "Unique Lines" latest(hana_trace_severity) as "Latest Severity" by hana_trace_source_file hana_trace_component | sort -Events | rename hana_trace_source_file as "Source File" hana_trace_component as Component`,
    sidInstance: `\`sap_logserv_idx_macro\` ${ST} | stats count by sap_sid hana_instance | sort -count | rename sap_sid as SID hana_instance as Instance`,
    errorDetail: `\`sap_logserv_idx_macro\` ${ST} hana_trace_severity IN ("error", "fatal") | table _time sap_sid hana_instance hana_trace_component hana_trace_source_file hana_trace_source_line hana_trace_severity | sort -_time | rename sap_sid as SID hana_instance as Instance hana_trace_component as Component hana_trace_source_file as "Source File" hana_trace_source_line as Line hana_trace_severity as Severity`,

    // SQL operation duration (build 186 / session 034 deep-dive). 14.6% of trace
    // events carry a "<float> msec" duration field; the rex pulls the leading
    // quoted operation name to give the table a useful first column.
    slowestOps: `\`sap_logserv_idx_macro\` ${ST} hana_op_duration_ms=* | rex field=_raw "^\\\"(?<hana_op>[^\\\"]+)\\\"" | sort - hana_op_duration_ms | head 20 | eval Duration = round(hana_op_duration_ms, 2) | table _time host sap_sid hana_op Duration | rename sap_sid AS SID hana_op AS Operation Duration AS "Duration (ms)"`,
    durationPercentiles: `\`sap_logserv_idx_macro\` ${ST} hana_op_duration_ms=* | timechart span=1d perc50(hana_op_duration_ms) AS "p50 (ms)" perc95(hana_op_duration_ms) AS "p95 (ms)" max(hana_op_duration_ms) AS "Max (ms)"`,
};

interface FirstRow { value: unknown; loading: boolean; error: Error | null; }
const useFirstRowField = (q: string, f: string): FirstRow => {
    const { results, loading, error } = useSearch({ query: q });
    const value = results && results[0] ? (results[0] as Record<string, unknown>)[f] : undefined;
    return { value, loading, error };
};

const TOP_COMP_COLS: ColumnDef[] = [
    { key: 'Component', label: 'Component' },
    { key: 'Events', label: 'Events', align: 'right', render: (v) => formatInteger(v) },
    { key: 'Source Files', label: 'Source Files', align: 'right', render: (v) => formatInteger(v) },
    { key: 'Severities', label: 'Severities' },
];
const SOURCE_HOTSPOT_COLS: ColumnDef[] = [
    { key: 'Source File', label: 'Source File' },
    { key: 'Component', label: 'Component' },
    { key: 'Events', label: 'Events', align: 'right', render: (v) => formatInteger(v) },
    { key: 'Unique Lines', label: 'Unique Lines', align: 'right', render: (v) => formatInteger(v) },
    { key: 'Latest Severity', label: 'Latest Severity' },
];
const ERROR_DETAIL_COLS: ColumnDef[] = [
    { key: '_time', label: 'Time', width: '160px', render: (v) => v ? new Date(String(v)).toLocaleString('en-US', { hour12: false }) : '' },
    { key: 'SID', label: 'SID', width: '70px' },
    { key: 'Instance', label: 'Instance', width: '90px' },
    { key: 'Component', label: 'Component', width: '160px' },
    { key: 'Source File', label: 'Source File' },
    { key: 'Line', label: 'Line', align: 'right', width: '80px' },
    { key: 'Severity', label: 'Severity', width: '90px' },
];

// SQL operation duration columns (build 186)
const SLOWEST_OPS_COLS: ColumnDef[] = [
    { key: '_time', label: 'Time', width: '160px', render: (v) => v ? new Date(String(v)).toLocaleString('en-US', { hour12: false }) : '' },
    { key: 'host', label: 'Host' },
    { key: 'SID', label: 'SID', width: '70px' },
    { key: 'Operation', label: 'Operation' },
    { key: 'Duration (ms)', label: 'Duration (ms)', align: 'right' },
];

const HanaTrace: React.FC = () => {
    const total = useFirstRowField(Q.kpiTotal, 'count');
    const errors = useFirstRowField(Q.kpiErrors, 'count');
    const components = useFirstRowField(Q.kpiComponents, 'components');

    const topComponents = useSearch({ query: Q.topComponents });
    const sourceHotspots = useSearch({ query: Q.sourceHotspots });
    const errorDetail = useSearch({ query: Q.errorDetail });
    const slowestOps = useSearch({ query: Q.slowestOps });

    const errorTone = Number(errors.value ?? 0) > 0 ? 'critical' : 'neutral';

    /* Drilldowns (build 159 / session 027 task 6). */
    const { timeRange } = useTimeRange();
    const goComponentRow = (row: Record<string, unknown>): void => {
        const c = String(row.Component ?? '');
        if (!c) return;
        const spl = `\`sap_logserv_idx_macro\` ${ST} hana_trace_component="${splQuote(c)}" | sort -_time`;
        openInNewTab(buildSplunkSearchUrl(spl, timeRange.earliest, timeRange.latest));
    };
    const goSourceFileRow = (row: Record<string, unknown>): void => {
        const file = String(row['Source File'] ?? '');
        if (!file) return;
        const spl = `\`sap_logserv_idx_macro\` ${ST} hana_trace_source_file="${splQuote(file)}" | sort -_time`;
        openInNewTab(buildSplunkSearchUrl(spl, timeRange.earliest, timeRange.latest));
    };
    const goErrorDetailRow = (row: Record<string, unknown>): void => {
        const sid = String(row.SID ?? '');
        const c = String(row.Component ?? '');
        if (!sid && !c) return;
        const sidClause = sid ? ` sap_sid="${splQuote(sid)}"` : '';
        const cClause = c ? ` hana_trace_component="${splQuote(c)}"` : '';
        const spl = `\`sap_logserv_idx_macro\` ${ST} hana_trace_severity IN ("error", "fatal")${sidClause}${cClause} | sort -_time`;
        openInNewTab(buildSplunkSearchUrl(spl, timeRange.earliest, timeRange.latest));
    };

    return (
        <DashboardLayout
            category="APPLICATIONS"
            title="HANA Trace"
            subtitle="SAP HANA trace log analysis — error and fatal events, top components, and source file hotspots"
        >
            <KpiRow>
                <KpiCard label="Total Trace Events" value={total.value} loading={total.loading} error={total.error} formatValue={formatInteger}
                    sparkline={<SparklineFromQuery query={Q.sparkTotal} valueField="count" fill />} />
                <KpiCard label="Errors / Fatal" value={errors.value} loading={errors.loading} error={errors.error} formatValue={formatInteger} tone={errorTone}
                    sparkline={<SparklineFromQuery query={Q.sparkErrors} valueField="count" color={logservTheme.colors.red} fill />} />
                <KpiCard label="Unique Components" value={components.value} loading={components.loading} error={components.error} formatValue={formatInteger}
                    sparkline={<SparklineFromQuery query={Q.sparkComponents} valueField="components" fill />} />
            </KpiRow>

            <PanelGrid2>
                <FramedPanel title="Trace Volume Over Time" subtitle="Daily count of HANA trace events">
                    <TimeSeriesChart query={Q.traceVolume} height={280} palette="volume" />
                </FramedPanel>
                <FramedPanel title="Trace Events by Severity" subtitle="Stacked daily volume by severity">
                    <TimeSeriesChart query={Q.bySeverity} height={280} palette="status" />
                </FramedPanel>
            </PanelGrid2>

            <PanelGrid2>
                <FramedPanel title="Components" subtitle="HANA components ranked by event volume">
                    <DataTable columns={TOP_COMP_COLS} rows={topComponents.results} loading={topComponents.loading} error={topComponents.error} emptyMessage="No HANA trace events in this time range." onRowClick={goComponentRow} />
                </FramedPanel>
                <FramedPanel title="Component by Severity" subtitle="Severity mix per component">
                    <TimeSeriesChart query={Q.componentSeverity} height={280} palette="status" />
                </FramedPanel>
            </PanelGrid2>

            <PanelGrid2>
                <FramedPanel title="Source File Hotspots" subtitle="Source files ranked by trace event count">
                    <DataTable columns={SOURCE_HOTSPOT_COLS} rows={sourceHotspots.results} loading={sourceHotspots.loading} error={sourceHotspots.error} emptyMessage="No HANA trace events in this time range." onRowClick={goSourceFileRow} />
                </FramedPanel>
                <FramedPanel title="Activity by SID / Instance" subtitle="Trace volume by HANA SID + instance">
                    <TimeSeriesChart query={Q.sidInstance} height={280} palette="volume" />
                </FramedPanel>
            </PanelGrid2>

            <PanelGrid2>
                <FramedPanel title="Slowest SQL Operations" subtitle="Top 20 trace events by reported duration (msec) — leading quoted operation name extracted via rex">
                    <DataTable columns={SLOWEST_OPS_COLS} rows={slowestOps.results} loading={slowestOps.loading} error={slowestOps.error} emptyMessage="No trace events with duration field in this time range." />
                </FramedPanel>
                <FramedPanel title="Operation Duration Percentiles" subtitle="Daily p50 / p95 / max of HANA SQL operation duration (msec) — only events that carry the duration field">
                    <TimeSeriesChart query={Q.durationPercentiles} height={280} palette="categorical" chartType="line" />
                </FramedPanel>
            </PanelGrid2>

            <FullWidthPanel>
                <FramedPanel title="Recent Errors / Fatal Events" subtitle="Error/fatal severity events, most-recent first">
                    <DataTable columns={ERROR_DETAIL_COLS} rows={errorDetail.results} loading={errorDetail.loading} error={errorDetail.error} emptyMessage="No HANA error/fatal events in this time range." onRowClick={goErrorDetailRow} />
                </FramedPanel>
            </FullWidthPanel>
        </DashboardLayout>
    );
};

export default HanaTrace;
