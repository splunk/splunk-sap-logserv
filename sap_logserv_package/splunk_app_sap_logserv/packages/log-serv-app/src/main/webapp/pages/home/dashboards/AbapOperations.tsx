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
import { useHybridSearch, useRoutedQuery } from '../hooks/useHybridSearch';
import { useCloudProvider, mapCloudProviderQueries } from '../state/CloudProviderProvider';
import { useTimeRange } from '../state/TimeRangeProvider';
import { buildDashboardUrl, buildSplunkSearchUrl, openInNewTab, splQuote } from '../utils/drilldownUrls';
import { logservTheme } from '../styles/logservTheme';

/**
 * ABAP Operations — honest port of v0.0.4.2 logserv_abap_operations.xml.
 * 10 panels: 3 KPIs + 3 timecharts + 4 tables.
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

/**
 * Dashboard-perf roadmap tier #6 (KV-Store precompute, session 050 cont. /
 * build 208). ABAP Operations is the SECOND dashboard served by the
 * `logserv_wp_perf_rollup` collection (the first was Work Process Performance).
 * It reuses metric="wp" (WP Categories pie) + metric="dp" (Dispatcher Severity,
 * WP Errors KPI) and adds three ABAP-Operations-specific metrics:
 *   metric="abap"      (sourcetype, sap_sid) over the 6 ABAP runtime sourcetypes
 *   metric="abap_wpfn" (wp_function, wp_sub_function) — both present, matching
 *                      the raw `wp_function=* | stats ... by wp_function,
 *                      wp_sub_function` which drops null-sub_function events
 *   metric="uptime"    (sap_sid, sap_instance) + latest uptime per bucket
 * Same read idiom as Work Process Performance: `| inputlookup … | addinfo |
 * where bucket_ts range | <agg>` (respects the global TimeRange picker). The
 * `| fillnull value=0` after timecharts matches raw `count`'s 0-fill; `(none)`
 * is excluded on read to reproduce raw `field=*` / dc() semantics. No panel is
 * left RAW (uptime is rolled up via latest-of-per-bucket-latest).
 */
const ROLL = 'logserv_wp_perf_rollup';
const RANGE = '| addinfo | where bucket_ts>=info_min_time AND bucket_ts<info_max_time';
const ABAP = `| inputlookup ${ROLL} where metric="abap" ${RANGE}`;
const WPFN = `| inputlookup ${ROLL} where metric="abap_wpfn" ${RANGE}`;
const UPTIME = `| inputlookup ${ROLL} where metric="uptime" ${RANGE}`;
const WP = `| inputlookup ${ROLL} where metric="wp" ${RANGE}`;
const DP = `| inputlookup ${ROLL} where metric="dp" ${RANGE}`;

const Q_BASE = {
    kpiTotal: `${ABAP} | stats sum(count) as count`,
    kpiSids: `${ABAP} | stats dc(eval(if(sap_sid="(none)",null(),sap_sid))) as sids`,
    kpiWpErrors: `${DP} | search (dp_severity="ERROR" OR dp_severity="FATAL") | stats sum(count) as count`,

    sparkTotal: `${ABAP} | eval _time=bucket_ts | timechart span=1d sum(count) as count | fillnull value=0`,
    sparkSids: `${ABAP} | eval _time=bucket_ts | timechart span=1d dc(eval(if(sap_sid="(none)",null(),sap_sid))) as sids | fillnull value=0`,
    sparkWpErrors: `${DP} | search (dp_severity="ERROR" OR dp_severity="FATAL") | eval _time=bucket_ts | timechart span=1d sum(count) as count | fillnull value=0`,

    volumeByType: `${ABAP} | eval _time=bucket_ts | timechart span=1d sum(count) by sourcetype | fillnull value=0`,
    dispatcherSeverity: `${DP} | search dp_severity!="(none)" | eval _time=bucket_ts | timechart span=1d sum(count) by dp_severity | fillnull value=0`,
    enqueueTimeline: `${ABAP} | search sourcetype="sap:abap:enqueueserver" | eval _time=bucket_ts | timechart span=1d sum(count) as "Lock Operations" | fillnull value=0`,

    uptime: `${UPTIME} | eval _time=bucket_ts | stats latest(uptime_days) as uptime_days latest(uptime_hours) as uptime_hours by sap_sid, sap_instance | sort sap_sid sap_instance`,
    wpCategories: `${WP} | search wp_category_name!="(none)" | stats sum(count) as count by wp_category_name | sort -count`,
    wpFunctions: `${WPFN} | search wp_sub_function!="(none)" | stats sum(count) as Events by wp_function, wp_sub_function | sort -Events`,
    sidInstance: `${ABAP} | stats sum(count) as count by sap_sid, sourcetype | sort -count`,
};

/* ---------------------------------------------------------------------------
 * RAW fallbacks for the sub-hour hybrid (session 086). Each is the raw ABAP
 * scan its rollup metric precomputes (reconstructed from
 * [logserv_wp_perf_aggregate]). sidInstance groups by the fillnull'd sap_sid
 * (the cached read doesn't exclude "(none)"), so the raw fillnull's it too.
 * uptime is latest-of-per-bucket-latest = latest event uptime. Only the
 * sparklines stay cached.
 * ------------------------------------------------------------------------- */
const RAW_ABAP6 = '`sap_logserv_idx_macro` (sourcetype="sap:abap:dispatcher" OR sourcetype="sap:abap:enqueueserver" OR sourcetype="sap:abap:event" OR sourcetype="sap:abap:messageserver" OR sourcetype="sap:abap:sapstartsrv" OR sourcetype="sap:abap:workprocess")';
const RAW_WP = '`sap_logserv_idx_macro` sourcetype="sap:abap:workprocess"';
const RAW_DP = '`sap_logserv_idx_macro` sourcetype="sap:abap:dispatcher"';
const RAW_ENQ = '`sap_logserv_idx_macro` sourcetype="sap:abap:enqueueserver"';
const RAW_EVENT = '`sap_logserv_idx_macro` sourcetype="sap:abap:event"';
const QRAW_BASE = {
    kpiTotal: `${RAW_ABAP6} | stats count`,
    kpiSids: `${RAW_ABAP6} | stats dc(sap_sid) as sids`,
    kpiWpErrors: `${RAW_DP} (dp_severity="ERROR" OR dp_severity="FATAL") | stats count`,
    volumeByType: `${RAW_ABAP6} | timechart span=1d count by sourcetype | fillnull value=0`,
    dispatcherSeverity: `${RAW_DP} dp_severity=* | timechart span=1d count by dp_severity | fillnull value=0`,
    enqueueTimeline: `${RAW_ENQ} | timechart span=1d count as "Lock Operations" | fillnull value=0`,
    uptime: `${RAW_EVENT} uptime_days=* | stats latest(uptime_days) as uptime_days latest(uptime_hours) as uptime_hours by sap_sid, sap_instance | sort sap_sid sap_instance`,
    wpCategories: `${RAW_WP} wp_category_name=* | stats count by wp_category_name | sort -count`,
    wpFunctions: `${RAW_WP} wp_function=* | stats count as Events by wp_function, wp_sub_function | sort -Events`,
    sidInstance: `${RAW_ABAP6} | fillnull value="(none)" sap_sid | stats count by sap_sid, sourcetype | sort -count`,
};

interface FirstRow {
    value: unknown;
    loading: boolean;
    error: Error | null;
    /** Session 093 — the whole search result, so the KpiCard this feeds
     *  can explain a missing value (see KpiCard’s `search` prop). */
    search: import('../hooks/useSearch').UseSearchResult;
}
const useFirstRowField = (q: string, f: string): FirstRow => {
    const search = useSearch({ query: q });
    const { results, loading, error } = search;
    const value = results && results[0] ? (results[0] as Record<string, unknown>)[f] : undefined;
    return { value, loading, error, search };
};
/** useFirstRowField over a hybrid cached/raw pair (session 086). */
const useFirstRowFieldHybrid = (cached: string, raw: string, f: string): FirstRow => {
    const search = useHybridSearch({ cached, raw });
    const { results, loading, error } = search;
    const value = results && results[0] ? (results[0] as Record<string, unknown>)[f] : undefined;
    return { value, loading, error, search };
};

const UPTIME_COLS: ColumnDef[] = [
    { key: 'sap_sid', label: 'SID' },
    { key: 'sap_instance', label: 'Instance' },
    { key: 'uptime_days', label: 'Uptime (Days)', align: 'right' },
    { key: 'uptime_hours', label: 'Uptime (Hours)', align: 'right' },
];
const FUNCTION_COLS: ColumnDef[] = [
    { key: 'wp_function', label: 'Function' },
    { key: 'wp_sub_function', label: 'Sub-Function' },
    { key: 'Events', label: 'Events', align: 'right', render: (v) => formatInteger(v) },
];
const SID_COLS: ColumnDef[] = [
    { key: 'sap_sid', label: 'SID' },
    { key: 'sourcetype', label: 'Sourcetype' },
    { key: 'count', label: 'Events', align: 'right', render: (v) => formatInteger(v) },
];

const AbapOperations: React.FC = () => {
    const { provider } = useCloudProvider();
    const Q = React.useMemo(() => mapCloudProviderQueries(Q_BASE, provider), [provider]);
    // RAW fallbacks for the sub-hour hybrid (session 086); same cloud mapping so both arms filter identically.
    const QRAW = React.useMemo(() => mapCloudProviderQueries(QRAW_BASE, provider), [provider]);
    const total = useFirstRowFieldHybrid(Q.kpiTotal, QRAW.kpiTotal, 'count');
    const sids = useFirstRowFieldHybrid(Q.kpiSids, QRAW.kpiSids, 'sids');
    const wpErrors = useFirstRowFieldHybrid(Q.kpiWpErrors, QRAW.kpiWpErrors, 'count');

    const uptime = useHybridSearch({ cached: Q.uptime, raw: QRAW.uptime });
    const wpFunctions = useHybridSearch({ cached: Q.wpFunctions, raw: QRAW.wpFunctions });
    const sidInstance = useHybridSearch({ cached: Q.sidInstance, raw: QRAW.sidInstance });

    // Charts / pie take a query string → route once each (sub-hour -> raw).
    const qVolumeByType = useRoutedQuery(Q.volumeByType, QRAW.volumeByType);
    const qDispatcherSeverity = useRoutedQuery(Q.dispatcherSeverity, QRAW.dispatcherSeverity);
    const qEnqueueTimeline = useRoutedQuery(Q.enqueueTimeline, QRAW.enqueueTimeline);
    const qWpCategories = useRoutedQuery(Q.wpCategories, QRAW.wpCategories);

    const wpErrorsTone = Number(wpErrors.value ?? 0) > 0 ? 'critical' : 'neutral';

    /* Drilldowns (build 159 / session 027 task 6). */
    const { timeRange } = useTimeRange();
    const goWpPerformance = (): void => {
        openInNewTab(buildDashboardUrl('work-process-performance', timeRange.earliest, timeRange.latest));
    };
    const goUptimeRow = (): void => {
        // Click row → Work Process Performance for the SID-level drill-down.
        openInNewTab(buildDashboardUrl('work-process-performance', timeRange.earliest, timeRange.latest));
    };
    const goSidActivityRow = (row: Record<string, unknown>): void => {
        const sid = String(row.sap_sid ?? '');
        const st = String(row.sourcetype ?? '');
        if (!sid && !st) return;
        const sidClause = sid ? ` sap_sid="${splQuote(sid)}"` : '';
        const stClause = st ? ` sourcetype="${splQuote(st)}"` : '';
        const spl = `\`sap_logserv_idx_macro\`${stClause}${sidClause} | sort -_time`;
        openInNewTab(buildSplunkSearchUrl(spl, timeRange.earliest, timeRange.latest));
    };

    return (
        <DashboardLayout
            category="APPLICATIONS"
            title="ABAP Operations"
            subtitle="Operational health of SAP ABAP application layer — work processes, dispatcher, enqueue, and instance activity"
        >
            <KpiRow>
                <KpiCard label="Total Events" value={total.value} loading={total.loading} error={total.error} search={total.search} formatValue={formatInteger}
                    sparkline={<SparklineFromQuery query={Q.sparkTotal} valueField="count" fill />} />
                <KpiCard label="Active SIDs" value={sids.value} loading={sids.loading} error={sids.error} search={sids.search} formatValue={formatInteger}
                    sparkline={<SparklineFromQuery query={Q.sparkSids} valueField="sids" fill />} />
                <KpiCard label="Dispatcher Errors" value={wpErrors.value} loading={wpErrors.loading} error={wpErrors.error} search={wpErrors.search} formatValue={formatInteger} tone={wpErrorsTone}
                    sparkline={<SparklineFromQuery query={Q.sparkWpErrors} valueField="count" color={logservTheme.colors.red} fill />} />
            </KpiRow>

            <FullWidthPanel>
                <FramedPanel title="Event Volume by Sourcetype" subtitle="Daily volume across the 6 ABAP runtime sourcetypes">
                    <TimeSeriesChart query={qVolumeByType} height={280} palette="volume" />
                </FramedPanel>
            </FullWidthPanel>

            <PanelGrid2>
                <FramedPanel title="Dispatcher Severity Over Time" subtitle="Daily dp_severity breakdown — click to open Work Process Performance"
                    onClick={goWpPerformance} clickTitle="Open Work Process Performance dashboard">
                    <TimeSeriesChart query={qDispatcherSeverity} height={260} palette="status" />
                </FramedPanel>
                <FramedPanel title="Enqueue Lock Activity" subtitle="Daily lock operation count">
                    <TimeSeriesChart query={qEnqueueTimeline} height={260} palette="volume" />
                </FramedPanel>
            </PanelGrid2>

            <FullWidthPanel>
                <FramedPanel search={uptime} title="System Uptime (Latest)" subtitle="Latest reported uptime per SID + instance — click a row to open Work Process Performance">
                    <DataTable columns={UPTIME_COLS} rows={uptime.results} loading={uptime.loading} error={uptime.error} emptyMessage="No ABAP event uptime data in this time range." initialSortKey="sap_sid" initialSortDir="asc" onRowClick={goUptimeRow} />
                </FramedPanel>
            </FullWidthPanel>

            <PanelGrid2>
                <FramedPanel title="Work Process Categories" subtitle="Share of events by wp_category_name">
                    <PieChart query={qWpCategories} categoryField="wp_category_name" valueField="count" height={320} donut palette="volume" />
                </FramedPanel>
                <FramedPanel search={wpFunctions} title="Work Process Functions" subtitle="wp_function + sub-function combinations ranked by volume">
                    <DataTable columns={FUNCTION_COLS} rows={wpFunctions.results} loading={wpFunctions.loading} error={wpFunctions.error} emptyMessage="No work-process events in this time range." />
                </FramedPanel>
            </PanelGrid2>

            <FullWidthPanel>
                <FramedPanel search={sidInstance} title="Activity by SID / Sourcetype" subtitle="SID × sourcetype combinations ranked by event volume — click a row for the raw events">
                    <DataTable columns={SID_COLS} rows={sidInstance.results} loading={sidInstance.loading} error={sidInstance.error} emptyMessage="No ABAP runtime events in this time range." onRowClick={goSidActivityRow} />
                </FramedPanel>
            </FullWidthPanel>
        </DashboardLayout>
    );
};

export default AbapOperations;
