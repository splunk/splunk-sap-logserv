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

/**
 * Dashboard-perf roadmap tier #6 (KV-Store precompute, session 050 / build 206).
 *
 * Work Process Performance is HIGH-VOL and has NO CIM data-model path
 * (workprocess / dispatcher / icm are not CIM-tagged), so the tstats-now (#1)
 * and CIM-DMA (#4) tiers can't accelerate it. The aggregatable panels below
 * now read from the `logserv_wp_perf_rollup` KV Store collection, populated
 * hourly by the [logserv_wp_perf_aggregate] scheduled search (one-time
 * backfill via [logserv_wp_perf_backfill]). The Recent Dispatcher Errors panel
 * stays on a RAW search — a rollup can't reconstruct an event-level listing.
 *
 * Read idiom: `| inputlookup logserv_wp_perf_rollup where metric=<X> | addinfo
 * | where bucket_ts>=info_min_time AND bucket_ts<info_max_time | <agg>`.
 *  - The inputlookup `where metric=` filter hits the collection's
 *    {metric,bucket_ts} accelerator.
 *  - `addinfo` injects info_min_time/info_max_time from the dispatched job's
 *    earliest/latest, so the panel respects the GLOBAL TimeRange picker
 *    (useSearch sets earliest_time/latest_time on every dispatch). bucket_ts
 *    is hour-aligned, so day-aligned picker ranges match the raw scope exactly.
 *  - Sentinel handling: events without wp_function / wp_category_name were
 *    fillnull'd to "(none)" so the rollup preserves TOTAL counts; reads
 *    exclude "(none)" to reproduce the raw `field=*` / dc() semantics.
 *  - Timecharts `eval _time=bucket_ts` first so span=1d bins by the bucket
 *    hour (zero-filled across the picker range, same as the old raw timechart).
 *  - ICM avg(icm_tasks) is reconstructed as sum(sum_tasks)/sum(count) — exact.
 */
const ROLL = 'logserv_wp_perf_rollup';
const RANGE = '| addinfo | where bucket_ts>=info_min_time AND bucket_ts<info_max_time';
const WP = `| inputlookup ${ROLL} where metric="wp" ${RANGE}`;
const DP = `| inputlookup ${ROLL} where metric="dp" ${RANGE}`;
const ICM = `| inputlookup ${ROLL} where metric="icm" ${RANGE}`;

const Q = {
    kpiTotal: `${WP} | stats sum(count) as count`,
    kpiSids: `${WP} | stats dc(eval(if(sap_sid="(none)",null(),sap_sid))) as sids`,
    kpiErrors: `${DP} | search dp_severity="ERROR" | stats sum(count) as count`,
    kpiFunctions: `${WP} | search wp_function!="(none)" | stats dc(wp_function) as functions`,

    // Timecharts append `| fillnull value=0`: raw `count by X` zero-fills empty
    // series-bins with 0, but the rollup's `sum(count)` yields null for an empty
    // bin (sum of zero rows = null). fillnull restores raw's 0-fill so the
    // charts render identically to the pre-refactor dashboard.
    sparkTotal: `${WP} | eval _time=bucket_ts | timechart span=1d sum(count) as count | fillnull value=0`,
    sparkSids: `${WP} | eval _time=bucket_ts | timechart span=1d dc(eval(if(sap_sid="(none)",null(),sap_sid))) as sids | fillnull value=0`,
    sparkErrors: `${DP} | search dp_severity="ERROR" | eval _time=bucket_ts | timechart span=1d sum(count) as count | fillnull value=0`,
    sparkFunctions: `${WP} | search wp_function!="(none)" | eval _time=bucket_ts | timechart span=1d dc(wp_function) as functions | fillnull value=0`,

    categoryTrend: `${WP} | search wp_category_name!="(none)" | eval _time=bucket_ts | timechart span=1d sum(count) by wp_category_name limit=14 | fillnull value=0`,
    categoryMix: `${WP} | search wp_category_name!="(none)" | stats sum(count) as count by wp_category_name | sort -count`,
    topFunctions: `${WP} | search wp_function!="(none)" | stats sum(count) as count by wp_function | sort -count | rename wp_function as "Function", count as "Events"`,
    severityTrend: `${DP} | search dp_severity!="(none)" | eval _time=bucket_ts | timechart span=1d sum(count) by dp_severity | fillnull value=0`,
    bySid: `${WP} | stats sum(count) as "Total Events", dc(eval(if(wp_function="(none)",null(),wp_function))) as "Unique Functions", dc(eval(if(wp_category_name="(none)",null(),wp_category_name))) as "WP Categories" by sap_sid, sap_instance | sort -"Total Events" | rename sap_sid as "SID", sap_instance as "Instance"`,

    // Recent Dispatcher Errors stays RAW — an event-level listing the rollup
    // can't reconstruct. Bounded by the picker, so cost is acceptable.
    recentErrors: `\`sap_logserv_idx_macro\` ${ST_DP} dp_severity="ERROR" | head 200 | fillnull value="-" dp_function dp_reason | eval Time=strftime(_time, "%Y-%m-%d %H:%M:%S") | table Time, sap_sid, dp_function, dp_reason, host | sort -Time | rename sap_sid as "SID", dp_function as "Function", dp_reason as "Reason"`,

    // ICM async RFC queue depth (build 186 / session 034 deep-dive). Rolled up
    // per (icm_program, icm_request_type) with sum/max(icm_tasks) + max(icm_memory)
    // over task-bearing (icm_tasks=*) events. Daily avg = Σ(sum_tasks)/Σ(count).
    // Avg Queue Depth = Σ(sum_tasks)/Σ(count) reproduces raw avg(icm_tasks)
    // exactly — kept full-precision (NOT round()ed) to match the raw chart's
    // unrounded avg. Empty days stay null in both raw and rollup (no fillnull).
    asyncRfcQueueTrend: `${ICM} | search icm_request_type="ASYNC_RFC" | eval _time=bucket_ts | timechart span=1d sum(sum_tasks) as st, sum(count) as ct, max(max_tasks) as "Max Queue Depth" | eval "Avg Queue Depth"=st/ct | fields _time, "Avg Queue Depth", "Max Queue Depth"`,
    topProgramsByTasks: `${ICM} | search icm_program!="(none)" | stats sum(count) as Calls, sum(sum_tasks) as st, max(max_tasks) as "Max Tasks", max(max_mem) as "Max Mem (KB)" by icm_program | eval Avg = round(st/Calls, 1) | sort -"Max Tasks" | head 20 | rename icm_program AS Program | table Program Calls Avg "Max Tasks" "Max Mem (KB)"`,
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
                <FramedPanel search={topFunctions} title="Work Process Functions" subtitle="Functions ranked by event volume">
                    <DataTable columns={TOP_FUNC_COLS} rows={topFunctions.results} loading={topFunctions.loading} error={topFunctions.error} emptyMessage="No work-process events in this time range." />
                </FramedPanel>
                <FramedPanel title="Dispatcher Severity Over Time" subtitle="Dispatcher event severity trend">
                    <TimeSeriesChart query={Q.severityTrend} height={280} palette="status" />
                </FramedPanel>
            </PanelGrid2>

            <FullWidthPanel>
                <FramedPanel search={bySid} title="Activity by SID / Instance" subtitle="Per-SID totals + function/category counts — click a row for that SID's full WP event log">
                    <DataTable columns={BY_SID_COLS} rows={bySid.results} loading={bySid.loading} error={bySid.error} emptyMessage="No work-process events in this time range." initialSortKey="Total Events" initialSortDir="desc" onRowClick={goBySidRow} />
                </FramedPanel>
            </FullWidthPanel>

            <FullWidthPanel>
                <FramedPanel search={recentErrors} title="Recent Dispatcher Errors" subtitle="Dispatcher ERROR events, most-recent first — click a row to open Host Details">
                    <DataTable columns={RECENT_ERR_COLS} rows={recentErrors.results} loading={recentErrors.loading} error={recentErrors.error} emptyMessage="No dispatcher ERROR events in this time range." initialSortKey="Time" initialSortDir="desc" onRowClick={goRecentErrorRow} />
                </FramedPanel>
            </FullWidthPanel>

            <PanelGrid2>
                <FramedPanel title="Async RFC Queue Depth" subtitle="ICM ASYNC_RFC tasks-in-queue per dispatch (sap:abap:icm `icm_tasks` field) — daily avg + max">
                    <TimeSeriesChart query={Q.asyncRfcQueueTrend} height={280} palette="categorical" chartType="line" />
                </FramedPanel>
                <FramedPanel search={topPrograms} title="Top Programs by Queue Depth" subtitle="ABAP programs ranked by max queue depth at dispatch — saturated programs surface here">
                    <DataTable columns={TOP_PROGRAMS_COLS} rows={topPrograms.results} loading={topPrograms.loading} error={topPrograms.error} emptyMessage="No ICM ASYNC_RFC events with task counts in this time range." />
                </FramedPanel>
            </PanelGrid2>
        </DashboardLayout>
    );
};

export default WorkProcessPerformance;
