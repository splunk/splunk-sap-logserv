import React from 'react';
import styled from 'styled-components';
import KpiCard, { formatInteger } from '../components/KpiCard';
import FramedPanel from '../components/FramedPanel';
import DataTable, { ColumnDef } from '../components/DataTable';
import TimeSeriesChart from '../components/TimeSeriesChart';
import PieChart from '../components/PieChart';
import { SparklineFromQuery } from '../components/Sparkline';
import DashboardLayout from '../components/DashboardLayout';
import { useSearch } from '../hooks/useSearch';
import { useTimeRange } from '../state/TimeRangeProvider';
import { buildHostDetailsUrl, buildSplunkSearchUrl, openInNewTab, splQuote } from '../utils/drilldownUrls';
import { logservTheme } from '../styles/logservTheme';

/**
 * Work Process Performance — honest port of v0.0.4.2 logserv_work_process_performance.xml.
 *
 * 4 KPIs (Total / Active SIDs / Dispatcher Errors / Active Functions) +
 * Category Trend column + Category Distribution pie + Top Functions bar +
 * Dispatcher Severity column + Activity by SID/Instance table + Recent Errors table.
 */

const KpiRow = styled.div`
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: ${logservTheme.elevation.panelGap};
    margin-bottom: ${logservTheme.elevation.panelGap};
    @media (max-width: 1100px) { grid-template-columns: repeat(2, minmax(0, 1fr)); }
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

const ST_WP = 'sourcetype="sap:abap:workprocess"';
const ST_DP = 'sourcetype="sap:abap:dispatcher"';
const ST_ICM = 'sourcetype="sap:abap:icm"';

const Q = {
    kpiTotal: `\`sap_logserv_idx_macro\` ${ST_WP} | stats count`,
    kpiSids: `\`sap_logserv_idx_macro\` ${ST_WP} | stats dc(sap_sid) as sids`,
    kpiErrors: `\`sap_logserv_idx_macro\` ${ST_DP} dp_severity="ERROR" | stats count`,
    kpiFunctions: `\`sap_logserv_idx_macro\` ${ST_WP} wp_function=* | stats dc(wp_function) as functions`,

    sparkTotal: `\`sap_logserv_idx_macro\` ${ST_WP} | timechart span=1d count`,
    sparkSids: `\`sap_logserv_idx_macro\` ${ST_WP} | timechart span=1d dc(sap_sid) as sids`,
    sparkErrors: `\`sap_logserv_idx_macro\` ${ST_DP} dp_severity="ERROR" | timechart span=1d count`,
    sparkFunctions: `\`sap_logserv_idx_macro\` ${ST_WP} wp_function=* | timechart span=1d dc(wp_function) as functions`,

    categoryTrend: `\`sap_logserv_idx_macro\` ${ST_WP} wp_category_name=* | timechart span=1d count by wp_category_name limit=14`,
    categoryMix: `\`sap_logserv_idx_macro\` ${ST_WP} wp_category_name=* | stats count by wp_category_name | sort -count`,
    topFunctions: `\`sap_logserv_idx_macro\` ${ST_WP} wp_function=* | stats count by wp_function | sort -count | rename wp_function as "Function", count as "Events"`,
    severityTrend: `\`sap_logserv_idx_macro\` ${ST_DP} dp_severity=* | timechart span=1d count by dp_severity`,
    bySid: `\`sap_logserv_idx_macro\` ${ST_WP} | stats count as "Total Events", dc(wp_function) as "Unique Functions", dc(wp_category_name) as "WP Categories" by sap_sid, sap_instance | sort -"Total Events" | rename sap_sid as "SID", sap_instance as "Instance"`,
    recentErrors: `\`sap_logserv_idx_macro\` ${ST_DP} dp_severity="ERROR" | fillnull value="-" dp_function dp_reason | eval Time=strftime(_time, "%Y-%m-%d %H:%M:%S") | table Time, sap_sid, dp_function, dp_reason, host | sort -Time | rename sap_sid as "SID", dp_function as "Function", dp_reason as "Reason"`,

    // ICM async RFC queue depth (build 186 / session 034 deep-dive). icm_tasks
    // and icm_memory are extracted by props.conf; previously unsurfaced in any
    // dashboard. Queue depth signals downstream-system saturation when the
    // RFC stack can't drain to the consumer fast enough.
    asyncRfcQueueTrend: `\`sap_logserv_idx_macro\` ${ST_ICM} icm_request_type="ASYNC_RFC" icm_tasks=* | timechart span=1d avg(icm_tasks) AS "Avg Queue Depth" max(icm_tasks) AS "Max Queue Depth"`,
    topProgramsByTasks: `\`sap_logserv_idx_macro\` ${ST_ICM} icm_program=* icm_tasks=* | stats count AS Calls avg(icm_tasks) AS avg_tasks max(icm_tasks) AS max_tasks max(icm_memory) AS max_mem_kb by icm_program | eval Avg = round(avg_tasks, 1) | sort -max_tasks | head 20 | rename icm_program AS Program max_tasks AS "Max Tasks" max_mem_kb AS "Max Mem (KB)" | table Program Calls Avg "Max Tasks" "Max Mem (KB)"`,
};

interface FirstRow { value: unknown; loading: boolean; error: Error | null; }
const useFirstRowField = (q: string, f: string): FirstRow => {
    const { results, loading, error } = useSearch({ query: q });
    const value = results && results[0] ? (results[0] as Record<string, unknown>)[f] : undefined;
    return { value, loading, error };
};

const TOP_FUNC_COLS: ColumnDef[] = [
    { key: 'Function', label: 'Function' },
    { key: 'Events', label: 'Events', align: 'right', render: (v) => formatInteger(v) },
];
const BY_SID_COLS: ColumnDef[] = [
    { key: 'SID', label: 'SID' },
    { key: 'Instance', label: 'Instance' },
    { key: 'Total Events', label: 'Total Events', align: 'right', render: (v) => formatInteger(v) },
    { key: 'Unique Functions', label: 'Unique Functions', align: 'right', render: (v) => formatInteger(v) },
    { key: 'WP Categories', label: 'WP Categories', align: 'right', render: (v) => formatInteger(v) },
];
const RECENT_ERR_COLS: ColumnDef[] = [
    { key: 'Time', label: 'Time', width: '160px' },
    { key: 'SID', label: 'SID', width: '70px' },
    { key: 'Function', label: 'Function', width: '180px' },
    { key: 'Reason', label: 'Reason' },
    { key: 'host', label: 'Host', width: '180px' },
];

// ICM RFC queue columns (build 186)
const TOP_PROGRAMS_COLS: ColumnDef[] = [
    { key: 'Program', label: 'ABAP Program' },
    { key: 'Calls', label: 'Calls', align: 'right', render: (v) => formatInteger(v) },
    { key: 'Avg', label: 'Avg Tasks', align: 'right' },
    { key: 'Max Tasks', label: 'Max Tasks', align: 'right', render: (v) => formatInteger(v) },
    { key: 'Max Mem (KB)', label: 'Max Mem (KB)', align: 'right', render: (v) => formatInteger(v) },
];

const WorkProcessPerformance: React.FC = () => {
    const total = useFirstRowField(Q.kpiTotal, 'count');
    const sids = useFirstRowField(Q.kpiSids, 'sids');
    const errors = useFirstRowField(Q.kpiErrors, 'count');
    const functions = useFirstRowField(Q.kpiFunctions, 'functions');

    const topFunctions = useSearch({ query: Q.topFunctions });
    const bySid = useSearch({ query: Q.bySid });
    const recentErrors = useSearch({ query: Q.recentErrors });
    const topPrograms = useSearch({ query: Q.topProgramsByTasks });

    const errorTone = Number(errors.value ?? 0) > 0 ? 'critical' : 'neutral';

    /* Drilldowns (build 159 / session 027 task 6). */
    const { timeRange } = useTimeRange();
    const goBySidRow = (row: Record<string, unknown>): void => {
        const sid = String(row.SID ?? '');
        if (!sid) return;
        // Open Host Details with no specific host but pass a SID hint via SPL.
        // Since Host Details accepts ?host= only (per session 027 plan), fall
        // through to splunk-search for SID-level investigation.
        const spl = `\`sap_logserv_idx_macro\` ${ST_WP} sap_sid="${splQuote(sid)}" | sort -_time | table _time host wp_function wp_category_name`;
        openInNewTab(buildSplunkSearchUrl(spl, timeRange.earliest, timeRange.latest));
    };
    const goRecentErrorRow = (row: Record<string, unknown>): void => {
        const host = String(row.host ?? '');
        const sid = String(row.SID ?? '');
        if (host) {
            openInNewTab(buildHostDetailsUrl(host, timeRange.earliest, timeRange.latest));
            return;
        }
        if (!sid) return;
        const spl = `\`sap_logserv_idx_macro\` ${ST_DP} sap_sid="${splQuote(sid)}" dp_severity="ERROR" | sort -_time`;
        openInNewTab(buildSplunkSearchUrl(spl, timeRange.earliest, timeRange.latest));
    };

    return (
        <DashboardLayout
            category="APPLICATIONS"
            title="Work Process Performance"
            subtitle="SAP ABAP work process utilization, dispatcher health, and function-level activity"
        >
            <KpiRow>
                <KpiCard label="Total WP Events" value={total.value} loading={total.loading} error={total.error} formatValue={formatInteger}
                    sparkline={<SparklineFromQuery query={Q.sparkTotal} valueField="count" fill />} />
                <KpiCard label="Active SIDs" value={sids.value} loading={sids.loading} error={sids.error} formatValue={formatInteger}
                    sparkline={<SparklineFromQuery query={Q.sparkSids} valueField="sids" fill />} />
                <KpiCard label="Dispatcher Errors" value={errors.value} loading={errors.loading} error={errors.error} formatValue={formatInteger} tone={errorTone}
                    sparkline={<SparklineFromQuery query={Q.sparkErrors} valueField="count" color={logservTheme.colors.red} fill />} />
                <KpiCard label="Active WP Functions" value={functions.value} loading={functions.loading} error={functions.error} formatValue={formatInteger}
                    sparkline={<SparklineFromQuery query={Q.sparkFunctions} valueField="functions" fill />} />
            </KpiRow>

            <PanelGrid2>
                <FramedPanel title="Work Process Category Trend" subtitle="Daily volume by wp_category_name">
                    <TimeSeriesChart query={Q.categoryTrend} height={280} palette="categorical" />
                </FramedPanel>
                <FramedPanel title="Category Distribution" subtitle="Share of total events by category">
                    <PieChart query={Q.categoryMix} categoryField="wp_category_name" valueField="count" height={280} donut palette="categorical" />
                </FramedPanel>
            </PanelGrid2>

            <PanelGrid2>
                <FramedPanel title="Work Process Functions" subtitle="Functions ranked by event volume">
                    <DataTable columns={TOP_FUNC_COLS} rows={topFunctions.results} loading={topFunctions.loading} error={topFunctions.error} emptyMessage="No work-process events in this time range." />
                </FramedPanel>
                <FramedPanel title="Dispatcher Severity Over Time" subtitle="Dispatcher event severity trend">
                    <TimeSeriesChart query={Q.severityTrend} height={280} palette="status" />
                </FramedPanel>
            </PanelGrid2>

            <FullWidthPanel>
                <FramedPanel title="Activity by SID / Instance" subtitle="Per-SID totals + function/category counts — click a row for that SID's full WP event log">
                    <DataTable columns={BY_SID_COLS} rows={bySid.results} loading={bySid.loading} error={bySid.error} emptyMessage="No work-process events in this time range." initialSortKey="Total Events" initialSortDir="desc" onRowClick={goBySidRow} />
                </FramedPanel>
            </FullWidthPanel>

            <FullWidthPanel>
                <FramedPanel title="Recent Dispatcher Errors" subtitle="Dispatcher ERROR events, most-recent first — click a row to open Host Details">
                    <DataTable columns={RECENT_ERR_COLS} rows={recentErrors.results} loading={recentErrors.loading} error={recentErrors.error} emptyMessage="No dispatcher ERROR events in this time range." initialSortKey="Time" initialSortDir="desc" onRowClick={goRecentErrorRow} />
                </FramedPanel>
            </FullWidthPanel>

            <PanelGrid2>
                <FramedPanel title="Async RFC Queue Depth" subtitle="ICM ASYNC_RFC tasks-in-queue per dispatch (sap:abap:icm `icm_tasks` field) — daily avg + max">
                    <TimeSeriesChart query={Q.asyncRfcQueueTrend} height={280} palette="categorical" chartType="line" />
                </FramedPanel>
                <FramedPanel title="Top Programs by Queue Depth" subtitle="ABAP programs ranked by max queue depth at dispatch — saturated programs surface here">
                    <DataTable columns={TOP_PROGRAMS_COLS} rows={topPrograms.results} loading={topPrograms.loading} error={topPrograms.error} emptyMessage="No ICM ASYNC_RFC events with task counts in this time range." />
                </FramedPanel>
            </PanelGrid2>
        </DashboardLayout>
    );
};

export default WorkProcessPerformance;
