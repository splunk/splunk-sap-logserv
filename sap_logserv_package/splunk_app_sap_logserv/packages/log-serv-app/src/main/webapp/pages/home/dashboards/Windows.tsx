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
 * Windows Events — honest port of v0.0.4.2 logserv_windows.xml.
 *
 * 3 KPIs (Total / Critical-Error / Active Hosts) + Volume by Log line + Severity stacked column +
 * Top Event Codes table + Service Events table + PowerShell Activity line.
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

const ST = 'sourcetype="XmlWinEventLog"';

/**
 * Dashboard-perf roadmap tier #6 (KV-Store precompute, session 053 / build 224).
 *
 * All 11 panels read from the `logserv_windows_rollup` KV Store collection (hourly
 * [logserv_windows_aggregate], one-time [logserv_windows_backfill]). 2 metrics:
 *  - main: grain (EventCode, source, severity, signature, host) fillnull "(none)" +
 *    count + last_seen(=max(_time) per bucket). Serves the 10 main panels.
 *  - svc: rex svc_name/svc_state from _raw (XML Data fields) on source=System
 *    EventCode IN (7036,7034,7031); per-bucket count + latest(svc_state). Serves serviceEvents.
 *
 * topEvents reconstructs raw first(signature)/first(severity)/first(log_name) via
 * latest(eval(nullify-sentinel ...)) with _time=last_seen — each first() skips nulls,
 * so each latest() nullifies "(none)" independently (per-field, matching raw).
 * NOTE: raw first(signature) is INPUT-ORDER (non-deterministic across bucket merges);
 * the rollup's latest(non-null signature) is the deterministic true-newest (an
 * improvement, stable across refreshes). Counts/Hosts/Last-Seen are byte-exact.
 * severity is CIM vocab (Splunk_TA_windows maps the Windows XML <Level>: 1→critical,
 * 2→high, 3→medium, 4→informational). The Critical KPI counts `severity IN
 * ("critical","high")` — i.e. Windows Critical (Level 1) + Error (Level 2) events.
 * PowerShell events arrive under source `XmlWinEventLog:Microsoft-Windows-PowerShell/
 * Operational` (demo) or `WinEventLog:Powershell` (real S3), so the powershell read
 * matches both via `(?i)powershell` rather than an exact source string.
 */
const ROLL = 'logserv_windows_rollup';
const RANGE = '| addinfo | where bucket_ts>=info_min_time AND bucket_ts<info_max_time';
const MAIN = `| inputlookup ${ROLL} where metric="main" ${RANGE}`;
const SVC = `| inputlookup ${ROLL} where metric="svc" ${RANGE}`;

const Q_BASE = {
    kpiTotal: `${MAIN} | stats count as n, sum(count) as count | fillnull value=0 count | fields count`,
    kpiCritical: `${MAIN} | search severity IN ("critical", "high") | stats count as n, sum(count) as count | fillnull value=0 count | fields count`,
    kpiHosts: `${MAIN} | stats count as n, dc(eval(if(host="(none)",null(),host))) as hosts | fillnull value=0 hosts | fields hosts`,

    sparkTotal: `${MAIN} | eval _time=bucket_ts | timechart span=1d sum(count) as count | fillnull value=0`,
    sparkCritical: `${MAIN} | search severity IN ("critical", "high") | eval _time=bucket_ts | timechart span=1d sum(count) as count | fillnull value=0`,
    sparkHosts: `${MAIN} | eval _time=bucket_ts | timechart span=1d dc(eval(if(host="(none)",null(),host))) as hosts | fillnull value=0`,

    volumeByLog: `${MAIN} | search source!="(none)" | eval _time=bucket_ts | timechart span=1d sum(count) by source | fillnull value=0`,
    severity: `${MAIN} | search severity!="(none)" | eval _time=bucket_ts | timechart span=1d sum(count) by severity | fillnull value=0`,
    topEvents: `${MAIN} | eval _time=last_seen, log_name=replace(source,"WinEventLog:","") | stats sum(count) as Events, dc(eval(if(host="(none)",null(),host))) as Hosts, latest(eval(if(signature="(none)",null(),signature))) as Description, latest(eval(if(severity="(none)",null(),severity))) as Severity, latest(eval(if(log_name="(none)",null(),log_name))) as Source, max(last_seen) as last_seen_ts by EventCode | eval "Last Seen" = strftime(last_seen_ts, "%Y-%m-%d %H:%M:%S") | sort -Events | table EventCode, Description, Source, Severity, Events, Hosts, "Last Seen" | rename EventCode as "Event Code"`,
    serviceEvents: `${SVC} | eval _time=bucket_ts | stats sum(count) as Events, latest(svc_state) as "Last State" by svc_name | sort -Events | rename svc_name as "Service Name"`,
    powershell: `${MAIN} | where match(source, "(?i)powershell") | eval _time=bucket_ts | timechart span=1d sum(count) as "PowerShell Events" | fillnull value=0`,
};

/* ---------------------------------------------------------------------------
 * RAW fallbacks for the sub-hour hybrid (session 086). Each is the raw
 * XmlWinEventLog scan its rollup metric precomputes, reconciled to the CURRENT
 * cached read (the win_v_* staged pairs are build-224-era and stale on two
 * points fixed here: kpiCritical uses the CIM vocab `severity IN
 * ("critical","high")` (build 258), and powershell/serviceEvents use the
 * demo+S3 source forms `(?i)powershell` / `source IN ("WinEventLog:System",
 * "XmlWinEventLog:System")`). topEvents mirrors the cached latest(non-null)
 * (deterministic-newest, not the staged first()). Description/Severity/Source
 * (topEvents) + Last State (serviceEvents) are latest-value columns — byte-exact
 * on real distinct-timestamp data, tie-ambiguous on the bulk-loaded demo.
 * ------------------------------------------------------------------------- */
const RAW_WIN = '`sap_logserv_idx_macro` sourcetype="XmlWinEventLog"';
const QRAW_BASE = {
    kpiTotal: `${RAW_WIN} | stats count`,
    kpiCritical: `${RAW_WIN} severity IN ("critical","high") | stats count`,
    kpiHosts: `${RAW_WIN} | stats dc(host) as hosts`,
    volumeByLog: `${RAW_WIN} | timechart span=1d count by source | fillnull value=0`,
    severity: `${RAW_WIN} | where isnotnull(severity) | timechart span=1d count by severity | fillnull value=0`,
    topEvents: `${RAW_WIN} | eval log_name = replace(source, "WinEventLog:", "") | stats count as Events, dc(host) as Hosts, latest(signature) as Description, latest(severity) as Severity, latest(log_name) as Source, latest(_time) as last_seen_ts by EventCode | eval "Last Seen" = strftime(last_seen_ts, "%Y-%m-%d %H:%M:%S") | sort -Events | table EventCode, Description, Source, Severity, Events, Hosts, "Last Seen" | rename EventCode as "Event Code"`,
    serviceEvents: `${RAW_WIN} source IN ("WinEventLog:System","XmlWinEventLog:System") EventCode IN (7036, 7034, 7031) | rex field=_raw "<Data Name='param1'>(?<svc_name>[^<]+)</Data>" | rex field=_raw "<Data Name='param2'>(?<svc_state>[^<]+)</Data>" | where isnotnull(svc_name) | stats count as Events latest(svc_state) as "Last State" by svc_name | sort -Events | rename svc_name as "Service Name"`,
    powershell: `${RAW_WIN} | where match(source, "(?i)powershell") | timechart span=1d count as "PowerShell Events" | fillnull value=0`,
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

const TOP_EVENT_COLS: ColumnDef[] = [
    { key: 'Event Code', label: 'Event Code', width: '110px' },
    { key: 'Description', label: 'Description' },
    { key: 'Source', label: 'Source', width: '140px' },
    { key: 'Severity', label: 'Severity', width: '100px' },
    { key: 'Events', label: 'Events', align: 'right', render: (v) => formatInteger(v) },
    { key: 'Hosts', label: 'Hosts', align: 'right', render: (v) => formatInteger(v) },
    { key: 'Last Seen', label: 'Last Seen', width: '160px' },
];
const SERVICE_COLS: ColumnDef[] = [
    { key: 'Service Name', label: 'Service Name' },
    { key: 'Events', label: 'Events', align: 'right', render: (v) => formatInteger(v) },
    { key: 'Last State', label: 'Last State' },
];

const Windows: React.FC = () => {
    const { provider } = useCloudProvider();
    const Q = React.useMemo(() => mapCloudProviderQueries(Q_BASE, provider), [provider]);
    // RAW fallbacks for the sub-hour hybrid (session 086); same cloud mapping so both arms filter identically.
    const QRAW = React.useMemo(() => mapCloudProviderQueries(QRAW_BASE, provider), [provider]);
    const total = useFirstRowFieldHybrid(Q.kpiTotal, QRAW.kpiTotal, 'count');
    const critical = useFirstRowFieldHybrid(Q.kpiCritical, QRAW.kpiCritical, 'count');
    const hosts = useFirstRowFieldHybrid(Q.kpiHosts, QRAW.kpiHosts, 'hosts');

    const topEvents = useHybridSearch({ cached: Q.topEvents, raw: QRAW.topEvents });
    const serviceEvents = useHybridSearch({ cached: Q.serviceEvents, raw: QRAW.serviceEvents });

    // Charts take a query string → route once each (sub-hour -> raw).
    const qVolumeByLog = useRoutedQuery(Q.volumeByLog, QRAW.volumeByLog);
    const qSeverity = useRoutedQuery(Q.severity, QRAW.severity);
    const qPowershell = useRoutedQuery(Q.powershell, QRAW.powershell);

    const criticalTone = Number(critical.value ?? 0) > 0 ? 'critical' : 'neutral';

    /* Drilldowns (build 159 / session 027 task 6). */
    const { timeRange } = useTimeRange();
    const goEventCodeRow = (row: Record<string, unknown>): void => {
        const ec = String(row['Event Code'] ?? '');
        if (!ec) return;
        const spl = `\`sap_logserv_idx_macro\` ${ST} EventCode=${splQuote(ec)} | sort -_time | table _time host EventCode signature severity _raw`;
        openInNewTab(buildSplunkSearchUrl(spl, timeRange.earliest, timeRange.latest));
    };
    const goServiceRow = (row: Record<string, unknown>): void => {
        const svc = String(row['Service Name'] ?? '');
        if (!svc) return;
        const spl = `\`sap_logserv_idx_macro\` ${ST} source="WinEventLog:System" "${splQuote(svc)}" EventCode IN (7036,7034,7031) | sort -_time`;
        openInNewTab(buildSplunkSearchUrl(spl, timeRange.earliest, timeRange.latest));
    };

    return (
        <DashboardLayout
            category="PLATFORM"
            title="Windows Events"
            subtitle="Windows operational health — event severity trends, top event codes, service state changes, and PowerShell activity"
        >
            <KpiRow>
                <KpiCard label="Total Events" value={total.value} loading={total.loading} error={total.error} search={total.search} formatValue={formatInteger}
                    sparkline={<SparklineFromQuery query={Q.sparkTotal} valueField="count" fill />} />
                <KpiCard label="Critical / Error" value={critical.value} loading={critical.loading} error={critical.error} search={critical.search} formatValue={formatInteger} tone={criticalTone}
                    sparkline={<SparklineFromQuery query={Q.sparkCritical} valueField="count" color={logservTheme.colors.red} fill />} />
                <KpiCard label="Active Hosts" value={hosts.value} loading={hosts.loading} error={hosts.error} search={hosts.search} formatValue={formatInteger}
                    sparkline={<SparklineFromQuery query={Q.sparkHosts} valueField="hosts" fill />} />
            </KpiRow>

            <PanelGrid2>
                <FramedPanel title="Event Volume by Log" subtitle="Daily counts split by WinEventLog source">
                    <TimeSeriesChart query={qVolumeByLog} height={280} palette="volume" />
                </FramedPanel>
                <FramedPanel title="Severity Distribution Over Time" subtitle="Stacked daily volume by severity">
                    <TimeSeriesChart query={qSeverity} height={280} palette="status" />
                </FramedPanel>
            </PanelGrid2>

            <FullWidthPanel>
                <FramedPanel search={topEvents} title="Event Codes" subtitle="EventCodes ranked by volume — click a row for that EventCode's full event log">
                    <DataTable columns={TOP_EVENT_COLS} rows={topEvents.results} loading={topEvents.loading} error={topEvents.error} emptyMessage="No Windows events in this time range." onRowClick={goEventCodeRow} />
                </FramedPanel>
            </FullWidthPanel>

            <PanelGrid2>
                <FramedPanel search={serviceEvents} title="Service Events" subtitle="Service start/stop/crash (EventCode 7036/7034/7031) — click a row for that service's lifecycle history">
                    <DataTable columns={SERVICE_COLS} rows={serviceEvents.results} loading={serviceEvents.loading} error={serviceEvents.error} emptyMessage="No service events in this time range." onRowClick={goServiceRow} />
                </FramedPanel>
                <FramedPanel title="PowerShell Activity" subtitle="Daily volume of PowerShell operational events">
                    <TimeSeriesChart query={qPowershell} height={280} palette="volume" />
                </FramedPanel>
            </PanelGrid2>
        </DashboardLayout>
    );
};

export default Windows;
