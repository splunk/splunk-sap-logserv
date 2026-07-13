import React from 'react';
import styled from 'styled-components';
import KpiCard, { formatInteger } from '../components/KpiCard';
import FramedPanel from '../components/FramedPanel';
import DataTable, { ColumnDef } from '../components/DataTable';
import TimeSeriesChart from '../components/TimeSeriesChart';
import { SparklineFromQuery } from '../components/Sparkline';
import DashboardLayout from '../components/DashboardLayout';
import { useSearch } from '../hooks/useSearch';
import { useHybridSearch, useRoutedQuery } from '../hooks/useHybridSearch';
import { useCloudProvider, mapCloudProviderQueries } from '../state/CloudProviderProvider';
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

/**
 * Dashboard-perf roadmap tier #6 (KV-Store precompute, session 053 / build 223).
 *
 * The count/dc/values/latest panels read from the `logserv_hana_trace_rollup` KV
 * Store collection (hourly [logserv_hana_trace_aggregate], one-time
 * [logserv_hana_trace_backfill]). Build 232 folded the former-RAW duration panels
 * into two new metrics: durationPercentiles (was perc50/95/max — percentiles don't
 * merge byte-exact across buckets) is now Avg(=Σsum_dur/Σcnt_dur)+Max(=max-of-per-
 * bucket-max_dur) from the `dur` metric; slowestOps (was a per-event head-sort
 * listing) is now top operations by Max/Avg from the `durop` (hana_op,sap_sid)
 * metric — per-event _time/host are DROPPED (cannot survive a rollup). Only
 * errorDetail (event listing, | head 500) stays RAW.
 *
 * main grain (all fillnull "(none)"): sap_sid, hana_instance, component,
 * source_file, source_line, severity + count + last_seen (=max(_time) per bucket).
 * Reads exclude "(none)" wherever raw used `field=*` or grouped/filtered by that dim
 * (raw drops nulls there); dc()/values()/latest() nullify the sentinel. Read idiom:
 * `| inputlookup <coll> where metric=X | addinfo | where bucket_ts range | <agg>`.
 */
const ROLL = 'logserv_hana_trace_rollup';
const RANGE = '| addinfo | where bucket_ts>=info_min_time AND bucket_ts<info_max_time';
const MAIN = `| inputlookup ${ROLL} where metric="main" ${RANGE}`;
const DUR = `| inputlookup ${ROLL} where metric="dur" ${RANGE}`;
const DUROP = `| inputlookup ${ROLL} where metric="durop" ${RANGE}`;
// COMP_GUARD = raw COMP_FILTER (component-junk exclusion) + the "(none)" exclusion
// that reproduces raw `hana_trace_component=*` (len("(none)")=6 passes len>3, so the
// sentinel must be excluded explicitly). Applied on topComponents/componentSeverity/
// sourceHotspots reads.
const COMP_GUARD = 'hana_trace_component!="(none)" AND len(hana_trace_component)>3 AND hana_trace_component!="INFO" AND hana_trace_component!="of" AND hana_trace_component!="service:"';

const Q_BASE = {
    // count KPIs use the anchored empty-window idiom (#19): reads 0, not blank.
    kpiTotal: `${MAIN} | stats count as n, sum(count) as count | fillnull value=0 count | fields count`,
    // kpiErrors/sparkErrors: the case-insensitive match against stored "ERROR" relies on
    // the `| search ... IN` COMMAND. Do NOT rewrite as `| where ... IN` or `eval(... IN ...)`
    // — both are case-SENSITIVE and would silently return 0 against the uppercase value.
    kpiErrors: `${MAIN} | search hana_trace_severity IN ("error", "fatal") | stats count as n, sum(count) as count | fillnull value=0 count | fields count`,
    kpiComponents: `${MAIN} | stats count as n, dc(eval(if(hana_trace_component="(none)",null(),hana_trace_component))) as components | fillnull value=0 components | fields components`,

    sparkTotal: `${MAIN} | eval _time=bucket_ts | timechart span=1d sum(count) as count | fillnull value=0`,
    sparkErrors: `${MAIN} | search hana_trace_severity IN ("error", "fatal") | eval _time=bucket_ts | timechart span=1d sum(count) as count | fillnull value=0`,
    sparkComponents: `${MAIN} | eval _time=bucket_ts | timechart span=1d dc(eval(if(hana_trace_component="(none)",null(),hana_trace_component))) as components | fillnull value=0`,

    traceVolume: `${MAIN} | eval _time=bucket_ts | timechart span=1d sum(count) as "Trace Events" | fillnull value=0`,
    bySeverity: `${MAIN} | search hana_trace_severity!="(none)" | eval _time=bucket_ts | timechart span=1d sum(count) by hana_trace_severity | fillnull value=0`,
    topComponents: `${MAIN} | where ${COMP_GUARD} | stats sum(count) as Events, dc(eval(if(hana_trace_source_file="(none)",null(),hana_trace_source_file))) as "Source Files", values(eval(if(hana_trace_severity="(none)",null(),hana_trace_severity))) as Severities by hana_trace_component | sort -Events | rename hana_trace_component as Component`,
    componentSeverity: `${MAIN} | where ${COMP_GUARD} AND hana_trace_severity!="(none)" | stats sum(count) as count by hana_trace_component, hana_trace_severity | sort -count | chart sum(count) over hana_trace_component by hana_trace_severity | sort -info | rename hana_trace_component as Component`,
    sourceHotspots: `${MAIN} | where hana_trace_source_file!="(none)" AND ${COMP_GUARD} | eval _time=last_seen | stats sum(count) as Events, dc(eval(if(hana_trace_source_line="(none)",null(),hana_trace_source_line))) as "Unique Lines", latest(eval(if(hana_trace_severity="(none)",null(),hana_trace_severity))) as "Latest Severity" by hana_trace_source_file, hana_trace_component | sort -Events | rename hana_trace_source_file as "Source File" hana_trace_component as Component`,
    sidInstance: `${MAIN} | search sap_sid!="(none)" hana_instance!="(none)" | stats sum(count) as count by sap_sid, hana_instance | sort -count | rename sap_sid as SID hana_instance as Instance`,

    // RAW (event listing — not rolled up).
    errorDetail: `\`sap_logserv_idx_macro\` ${ST} hana_trace_severity IN ("error", "fatal") | head 500 | table _time sap_sid hana_instance hana_trace_component hana_trace_source_file hana_trace_source_line hana_trace_severity | sort -_time | rename sap_sid as SID hana_instance as Instance hana_trace_component as Component hana_trace_source_file as "Source File" hana_trace_source_line as Line hana_trace_severity as Severity`,

    // SQL operation duration (build 186 / session 034; rolled up build 232). The
    // dur metric (per-bucket sum_dur/cnt_dur/max_dur) drives the Avg+Max chart;
    // the durop metric (per hana_op,sap_sid) drives the top-operations table.
    // 14.6% of trace events carry a "<float> msec" duration field. NOTE: slowestOps
    // changed semantics — it now ranks OPERATIONS by max/avg duration (was the
    // top-20 individual slowest events); per-event _time/host are dropped.
    slowestOps: `${DUROP} | search hana_op!="(none)" | stats sum(sum_dur) as s, sum(cnt_dur) as c, max(max_dur) as max_ms, sum(count) as events by hana_op, sap_sid | eval "Avg (ms)" = round(if(c>0, s/c, 0), 2), "Max (ms)" = round(max_ms, 2) | sort - "Max (ms)" | head 20 | rename sap_sid AS SID, hana_op AS Operation, events AS Events | table Operation, SID, Events, "Avg (ms)", "Max (ms)"`,
    durationPercentiles: `${DUR} | eval _time=bucket_ts | timechart span=1d sum(sum_dur) as s, sum(cnt_dur) as c, max(max_dur) as "Max (ms)" | eval "Avg (ms)" = if(c>0, round(s/c, 2), 0) | fields _time, "Avg (ms)", "Max (ms)"`,
};

/* ---------------------------------------------------------------------------
 * RAW fallbacks for the sub-hour hybrid (session 086). Each is the raw
 * sap:hana:tracelogs scan its rollup metric precomputes, reconciled to the
 * cached read's exact output columns (byte-verified equal at wide windows — the
 * ht_v_* / _v2_ht_* staged pairs). The "(none)" fillnull sentinels don't exist
 * on raw (stats-by / field=* drop nulls; the len()/junk COMP guards match).
 * slowestOps/durationPercentiles keep the cached's rounded Avg + sum/count form
 * so empty-bin behavior matches. Only ROLLUP reads are hybridised; errorDetail
 * is already raw and the sparklines stay cached (cosmetic).
 * ------------------------------------------------------------------------- */
const HRAW = '`sap_logserv_idx_macro` sourcetype="sap:hana:tracelogs"';
const QRAW_BASE = {
    kpiTotal: `${HRAW} | stats count`,
    kpiErrors: `${HRAW} hana_trace_severity IN ("error", "fatal") | stats count`,
    kpiComponents: `${HRAW} | stats dc(hana_trace_component) as components`,
    traceVolume: `${HRAW} | timechart span=1d count as "Trace Events" | fillnull value=0`,
    bySeverity: `${HRAW} hana_trace_severity=* | timechart span=1d count by hana_trace_severity | fillnull value=0`,
    topComponents: `${HRAW} hana_trace_component=* | where len(hana_trace_component) > 3 AND hana_trace_component!="INFO" AND hana_trace_component!="of" AND hana_trace_component!="service:" | stats count as Events dc(hana_trace_source_file) as "Source Files" values(hana_trace_severity) as Severities by hana_trace_component | sort -Events | rename hana_trace_component as Component`,
    componentSeverity: `${HRAW} hana_trace_component=* hana_trace_severity=* | where len(hana_trace_component) > 3 AND hana_trace_component!="INFO" AND hana_trace_component!="of" AND hana_trace_component!="service:" | stats count by hana_trace_component hana_trace_severity | sort -count | chart sum(count) over hana_trace_component by hana_trace_severity | sort -info | rename hana_trace_component as Component`,
    sourceHotspots: `${HRAW} hana_trace_source_file=* | where len(hana_trace_component) > 3 AND hana_trace_component!="INFO" AND hana_trace_component!="of" AND hana_trace_component!="service:" | stats count as Events dc(hana_trace_source_line) as "Unique Lines" latest(hana_trace_severity) as "Latest Severity" by hana_trace_source_file hana_trace_component | sort -Events | rename hana_trace_source_file as "Source File" hana_trace_component as Component`,
    sidInstance: `${HRAW} | stats count by sap_sid hana_instance | sort -count | rename sap_sid as SID hana_instance as Instance`,
    slowestOps: `${HRAW} hana_op_duration_ms=* | rex field=_raw "^\\"(?<hana_op>[^\\"]+)\\"" | fillnull value="(none)" hana_op sap_sid | stats avg(hana_op_duration_ms) as avg_ms, max(hana_op_duration_ms) as max_ms, count as events by hana_op, sap_sid | search hana_op!="(none)" | eval "Avg (ms)"=round(avg_ms,2), "Max (ms)"=round(max_ms,2) | sort - "Max (ms)" | head 20 | rename sap_sid AS SID, hana_op AS Operation, events AS Events | table Operation, SID, Events, "Avg (ms)", "Max (ms)"`,
    durationPercentiles: `${HRAW} hana_op_duration_ms=* | timechart span=1d sum(hana_op_duration_ms) as s, count(hana_op_duration_ms) as c, max(hana_op_duration_ms) as "Max (ms)" | eval "Avg (ms)" = if(c>0, round(s/c, 2), 0) | fields _time, "Avg (ms)", "Max (ms)"`,
};

interface FirstRow { value: unknown; loading: boolean; error: Error | null; }
const useFirstRowField = (q: string, f: string): FirstRow => {
    const { results, loading, error } = useSearch({ query: q });
    const value = results && results[0] ? (results[0] as Record<string, unknown>)[f] : undefined;
    return { value, loading, error };
};
/** useFirstRowField over a hybrid cached/raw pair (session 086). */
const useFirstRowFieldHybrid = (cached: string, raw: string, f: string): FirstRow => {
    const { results, loading, error } = useHybridSearch({ cached, raw });
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
    { key: 'Operation', label: 'Operation' },
    { key: 'SID', label: 'SID', width: '70px' },
    { key: 'Events', label: 'Events', align: 'right', render: (v) => formatInteger(v) },
    { key: 'Avg (ms)', label: 'Avg (ms)', align: 'right' },
    { key: 'Max (ms)', label: 'Max (ms)', align: 'right' },
];

const HanaTrace: React.FC = () => {
    const { provider } = useCloudProvider();
    const Q = React.useMemo(() => mapCloudProviderQueries(Q_BASE, provider), [provider]);
    // RAW fallbacks for the sub-hour hybrid (session 086); same cloud mapping so both arms filter identically.
    const QRAW = React.useMemo(() => mapCloudProviderQueries(QRAW_BASE, provider), [provider]);
    const total = useFirstRowFieldHybrid(Q.kpiTotal, QRAW.kpiTotal, 'count');
    const errors = useFirstRowFieldHybrid(Q.kpiErrors, QRAW.kpiErrors, 'count');
    const components = useFirstRowFieldHybrid(Q.kpiComponents, QRAW.kpiComponents, 'components');

    const topComponents = useHybridSearch({ cached: Q.topComponents, raw: QRAW.topComponents });
    const sourceHotspots = useHybridSearch({ cached: Q.sourceHotspots, raw: QRAW.sourceHotspots });
    const errorDetail = useSearch({ query: Q.errorDetail });
    const slowestOps = useHybridSearch({ cached: Q.slowestOps, raw: QRAW.slowestOps });

    // Charts take a query string → route once each (sub-hour -> raw).
    const qTraceVolume = useRoutedQuery(Q.traceVolume, QRAW.traceVolume);
    const qBySeverity = useRoutedQuery(Q.bySeverity, QRAW.bySeverity);
    const qComponentSeverity = useRoutedQuery(Q.componentSeverity, QRAW.componentSeverity);
    const qSidInstance = useRoutedQuery(Q.sidInstance, QRAW.sidInstance);
    const qDurationPercentiles = useRoutedQuery(Q.durationPercentiles, QRAW.durationPercentiles);

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
                    <TimeSeriesChart query={qTraceVolume} height={280} palette="volume" />
                </FramedPanel>
                <FramedPanel title="Trace Events by Severity" subtitle="Stacked daily volume by severity">
                    <TimeSeriesChart query={qBySeverity} height={280} palette="status" />
                </FramedPanel>
            </PanelGrid2>

            <PanelGrid2>
                <FramedPanel search={topComponents} title="Components" subtitle="HANA components ranked by event volume">
                    <DataTable columns={TOP_COMP_COLS} rows={topComponents.results} loading={topComponents.loading} error={topComponents.error} emptyMessage="No HANA trace events in this time range." onRowClick={goComponentRow} />
                </FramedPanel>
                <FramedPanel title="Component by Severity" subtitle="Severity mix per component">
                    <TimeSeriesChart query={qComponentSeverity} height={280} palette="status" />
                </FramedPanel>
            </PanelGrid2>

            <PanelGrid2>
                <FramedPanel search={sourceHotspots} title="Source File Hotspots" subtitle="Source files ranked by trace event count">
                    <DataTable columns={SOURCE_HOTSPOT_COLS} rows={sourceHotspots.results} loading={sourceHotspots.loading} error={sourceHotspots.error} emptyMessage="No HANA trace events in this time range." onRowClick={goSourceFileRow} />
                </FramedPanel>
                <FramedPanel title="Activity by SID / Instance" subtitle="Trace volume by HANA SID + instance">
                    <TimeSeriesChart query={qSidInstance} height={280} palette="volume" />
                </FramedPanel>
            </PanelGrid2>

            <PanelGrid2>
                <FramedPanel search={slowestOps} title="Slowest SQL Operations" subtitle="Top 20 SQL operations by max duration (msec) — with avg + event count per operation">
                    <DataTable columns={SLOWEST_OPS_COLS} rows={slowestOps.results} loading={slowestOps.loading} error={slowestOps.error} emptyMessage="No trace events with duration field in this time range." initialSortKey="Max (ms)" initialSortDir="desc" />
                </FramedPanel>
                <FramedPanel title="Operation Duration (Avg / Max)" subtitle="Daily average and peak HANA SQL operation duration (msec) — only events that carry the duration field">
                    <TimeSeriesChart query={qDurationPercentiles} height={280} palette="categorical" chartType="line" />
                </FramedPanel>
            </PanelGrid2>

            <FullWidthPanel>
                <FramedPanel search={errorDetail} title="Recent Errors / Fatal Events" subtitle="Error/fatal severity events, most-recent first">
                    <DataTable columns={ERROR_DETAIL_COLS} rows={errorDetail.results} loading={errorDetail.loading} error={errorDetail.error} emptyMessage="No HANA error/fatal events in this time range." onRowClick={goErrorDetailRow} />
                </FramedPanel>
            </FullWidthPanel>
        </DashboardLayout>
    );
};

export default HanaTrace;
