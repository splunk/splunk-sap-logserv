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

const Q = {
    kpiTotal: `\`sap_logserv_idx_macro\` ${ST} | stats count`,
    kpiCritical: `\`sap_logserv_idx_macro\` ${ST} severity IN ("critical", "error") | stats count`,
    kpiHosts: `\`sap_logserv_idx_macro\` ${ST} | stats dc(host) as hosts`,

    sparkTotal: `\`sap_logserv_idx_macro\` ${ST} | timechart span=1d count`,
    sparkCritical: `\`sap_logserv_idx_macro\` ${ST} severity IN ("critical", "error") | timechart span=1d count`,
    sparkHosts: `\`sap_logserv_idx_macro\` ${ST} | timechart span=1d dc(host) as hosts`,

    volumeByLog: `\`sap_logserv_idx_macro\` ${ST} | timechart span=1d count by source`,
    severity: `\`sap_logserv_idx_macro\` ${ST} | where isnotnull(severity) | timechart span=1d count by severity`,
    topEvents: `\`sap_logserv_idx_macro\` ${ST} | eval log_name = replace(source, "WinEventLog:", "") | stats count as Events, dc(host) as Hosts, first(signature) as Description, first(severity) as Severity, first(log_name) as Source, latest(_time) as last_seen_ts by EventCode | eval "Last Seen" = strftime(last_seen_ts, "%Y-%m-%d %H:%M:%S") | sort -Events | table EventCode, Description, Source, Severity, Events, Hosts, "Last Seen" | rename EventCode as "Event Code"`,
    serviceEvents: `\`sap_logserv_idx_macro\` ${ST} source="WinEventLog:System" EventCode IN (7036, 7034, 7031) | rex field=_raw "<Data Name='param1'>(?<svc_name>[^<]+)</Data>" | rex field=_raw "<Data Name='param2'>(?<svc_state>[^<]+)</Data>" | where isnotnull(svc_name) | stats count as Events latest(svc_state) as "Last State" by svc_name | sort -Events | rename svc_name as "Service Name"`,
    powershell: `\`sap_logserv_idx_macro\` ${ST} source="WinEventLog:Powershell" | timechart span=1d count as "PowerShell Events"`,
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
                <FramedPanel title="Event Codes" subtitle="EventCodes ranked by volume — click a row for that EventCode's full event log">
                    <DataTable columns={TOP_EVENT_COLS} rows={topEvents.results} loading={topEvents.loading} error={topEvents.error} emptyMessage="No Windows events in this time range." onRowClick={goEventCodeRow} />
                </FramedPanel>
            </FullWidthPanel>

            <PanelGrid2>
                <FramedPanel title="Service Events" subtitle="Service start/stop/crash (EventCode 7036/7034/7031) — click a row for that service's lifecycle history">
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
