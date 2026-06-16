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
 * kpiCritical `severity IN ("critical","error")` = 0 on demo data (severity vocab is
 * high/informational/medium); replicated EXACTLY — correct on real Windows data.
 */
const ROLL = 'logserv_windows_rollup';
const RANGE = '| addinfo | where bucket_ts>=info_min_time AND bucket_ts<info_max_time';
const MAIN = `| inputlookup ${ROLL} where metric="main" ${RANGE}`;
const SVC = `| inputlookup ${ROLL} where metric="svc" ${RANGE}`;

const Q = {
    kpiTotal: `${MAIN} | stats count as n, sum(count) as count | fillnull value=0 count | fields count`,
    kpiCritical: `${MAIN} | search severity IN ("critical", "error") | stats count as n, sum(count) as count | fillnull value=0 count | fields count`,
    kpiHosts: `${MAIN} | stats count as n, dc(eval(if(host="(none)",null(),host))) as hosts | fillnull value=0 hosts | fields hosts`,

    sparkTotal: `${MAIN} | eval _time=bucket_ts | timechart span=1d sum(count) as count | fillnull value=0`,
    sparkCritical: `${MAIN} | search severity IN ("critical", "error") | eval _time=bucket_ts | timechart span=1d sum(count) as count | fillnull value=0`,
    sparkHosts: `${MAIN} | eval _time=bucket_ts | timechart span=1d dc(eval(if(host="(none)",null(),host))) as hosts | fillnull value=0`,

    volumeByLog: `${MAIN} | search source!="(none)" | eval _time=bucket_ts | timechart span=1d sum(count) by source | fillnull value=0`,
    severity: `${MAIN} | search severity!="(none)" | eval _time=bucket_ts | timechart span=1d sum(count) by severity | fillnull value=0`,
    topEvents: `${MAIN} | eval _time=last_seen, log_name=replace(source,"WinEventLog:","") | stats sum(count) as Events, dc(eval(if(host="(none)",null(),host))) as Hosts, latest(eval(if(signature="(none)",null(),signature))) as Description, latest(eval(if(severity="(none)",null(),severity))) as Severity, latest(eval(if(log_name="(none)",null(),log_name))) as Source, max(last_seen) as last_seen_ts by EventCode | eval "Last Seen" = strftime(last_seen_ts, "%Y-%m-%d %H:%M:%S") | sort -Events | table EventCode, Description, Source, Severity, Events, Hosts, "Last Seen" | rename EventCode as "Event Code"`,
    serviceEvents: `${SVC} | eval _time=bucket_ts | stats sum(count) as Events, latest(svc_state) as "Last State" by svc_name | sort -Events | rename svc_name as "Service Name"`,
    powershell: `${MAIN} | search source="WinEventLog:Powershell" | eval _time=bucket_ts | timechart span=1d sum(count) as "PowerShell Events" | fillnull value=0`,
};

interface FirstRow { value: unknown; loading: boolean; error: Error | null; }
const useFirstRowField = (q: string, f: string): FirstRow => {
    const { results, loading, error } = useSearch({ query: q });
    const value = results && results[0] ? (results[0] as Record<string, unknown>)[f] : undefined;
    return { value, loading, error };
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
    const total = useFirstRowField(Q.kpiTotal, 'count');
    const critical = useFirstRowField(Q.kpiCritical, 'count');
    const hosts = useFirstRowField(Q.kpiHosts, 'hosts');

    const topEvents = useSearch({ query: Q.topEvents });
    const serviceEvents = useSearch({ query: Q.serviceEvents });

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
                <KpiCard label="Total Events" value={total.value} loading={total.loading} error={total.error} formatValue={formatInteger}
                    sparkline={<SparklineFromQuery query={Q.sparkTotal} valueField="count" fill />} />
                <KpiCard label="Critical / Error" value={critical.value} loading={critical.loading} error={critical.error} formatValue={formatInteger} tone={criticalTone}
                    sparkline={<SparklineFromQuery query={Q.sparkCritical} valueField="count" color={logservTheme.colors.red} fill />} />
                <KpiCard label="Active Hosts" value={hosts.value} loading={hosts.loading} error={hosts.error} formatValue={formatInteger}
                    sparkline={<SparklineFromQuery query={Q.sparkHosts} valueField="hosts" fill />} />
            </KpiRow>

            <PanelGrid2>
                <FramedPanel title="Event Volume by Log" subtitle="Daily counts split by WinEventLog source">
                    <TimeSeriesChart query={Q.volumeByLog} height={280} palette="volume" />
                </FramedPanel>
                <FramedPanel title="Severity Distribution Over Time" subtitle="Stacked daily volume by severity">
                    <TimeSeriesChart query={Q.severity} height={280} palette="status" />
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
                <FramedPanel title="PowerShell Activity" subtitle="Daily volume of WinEventLog:Powershell events">
                    <TimeSeriesChart query={Q.powershell} height={280} palette="volume" />
                </FramedPanel>
            </PanelGrid2>
        </DashboardLayout>
    );
};

export default Windows;
