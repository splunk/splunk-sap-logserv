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
import { buildHostDetailsUrl, buildSplunkSearchUrl, openInNewTab, splQuote } from '../utils/drilldownUrls';
import { logservTheme } from '../styles/logservTheme';

/**
 * Proxy Analytics — honest port of v0.0.4.2 logserv_proxy.xml.
 *
 * 3 KPIs (Total / Bandwidth / Denied) + Request Volume line + Status Codes column +
 * Top Domains table + Top Clients table + Client Domain Diversity table + Cache
 * Action Distribution column + Bandwidth Timeline + Top Domains by Bytes table +
 * Bandwidth by Domain (Top 5) line.
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
const PanelGrid3 = styled.div`
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: ${logservTheme.elevation.panelGap};
    margin-bottom: ${logservTheme.elevation.panelGap};
    @media (max-width: 1400px) { grid-template-columns: 1fr; }
`;

const ST = 'sourcetype="squid:access"';

const formatBytes = (raw: unknown): string => {
    if (raw === null || typeof raw === 'undefined') return '—';
    const n = typeof raw === 'number' ? raw : parseFloat(String(raw).replace(/,/g, ''));
    if (Number.isNaN(n)) return String(raw);
    if (n >= 1073741824) return `${(n / 1073741824).toFixed(1)} GB`;
    if (n >= 1048576) return `${(n / 1048576).toFixed(1)} MB`;
    if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${n} B`;
};

const Q = {
    kpiTotal: `\`sap_logserv_idx_macro\` ${ST} | stats count`,
    kpiBandwidth: `\`sap_logserv_idx_macro\` ${ST} | stats sum(bytes_out) as total_bytes | eval total = case(total_bytes >= 1073741824, round(total_bytes/1073741824, 1) . " GB", total_bytes >= 1048576, round(total_bytes/1048576, 1) . " MB", total_bytes >= 1024, round(total_bytes/1024, 1) . " KB", 1=1, tostring(total_bytes) . " B")`,
    kpiDenied: `\`sap_logserv_idx_macro\` ${ST} action="denied" | stats count`,

    sparkTotal: `\`sap_logserv_idx_macro\` ${ST} | timechart span=1d count`,
    sparkBandwidth: `\`sap_logserv_idx_macro\` ${ST} | timechart span=1d sum(bytes_out) as bytes_daily | eval daily = round(bytes_daily/1048576, 2)`,
    sparkDenied: `\`sap_logserv_idx_macro\` ${ST} action="denied" | timechart span=1d count`,

    requestVolume: `\`sap_logserv_idx_macro\` ${ST} | timechart span=1d count as Requests`,
    statusCodes: `\`sap_logserv_idx_macro\` ${ST} status=* | eval status_cat=case(status>=200 AND status<300, "2xx", status>=300 AND status<400, "3xx", status>=400 AND status<500, "4xx", status>=500, "5xx", 1=1, "Other") | timechart span=1d count by status_cat`,
    topDomains: `\`sap_logserv_idx_macro\` ${ST} url_domain=* | stats count as Requests sum(bytes_out) as "Total Bytes" dc(src_ip) as "Unique Clients" by url_domain | sort -Requests | rename url_domain as Domain`,
    topClients: `\`sap_logserv_idx_macro\` ${ST} src_ip=* | stats count as Requests sum(bytes_out) as "Total Bytes" dc(url_domain) as "Unique Domains" by src_ip | sort -Requests | rename src_ip as "Client IP"`,
    clientDomainDiversity: `\`sap_logserv_idx_macro\` ${ST} src_ip=* url_domain=* | stats dc(url_domain) as "Unique Domains" by src_ip | sort -"Unique Domains" | rename src_ip as "Client IP"`,
    contentTypes: `\`sap_logserv_idx_macro\` ${ST} vendor_action=* | stats count as Events by vendor_action | sort -Events | rename vendor_action as "Cache Action"`,
    bandwidthTimeline: `\`sap_logserv_idx_macro\` ${ST} | timechart span=1d sum(bytes_out) as "Bytes Out"`,
    topDomainsByBytes: `\`sap_logserv_idx_macro\` ${ST} url_domain=* | stats sum(bytes_out) as bytes_out by url_domain | eval mb_out = round(bytes_out/1048576, 2) | sort -mb_out | table url_domain, mb_out | rename url_domain as "Domain", mb_out as "MB Out"`,
    bandwidthByDomain: `\`sap_logserv_idx_macro\` ${ST} url_domain=* | timechart span=1d sum(bytes_out) by url_domain limit=5 useother=f`,
};

interface FirstRow { value: unknown; loading: boolean; error: Error | null; }
const useFirstRowField = (q: string, f: string): FirstRow => {
    const { results, loading, error } = useSearch({ query: q });
    const value = results && results[0] ? (results[0] as Record<string, unknown>)[f] : undefined;
    return { value, loading, error };
};

const TOP_DOM_COLS: ColumnDef[] = [
    { key: 'Domain', label: 'Domain' },
    { key: 'Requests', label: 'Requests', align: 'right', render: (v) => formatInteger(v) },
    { key: 'Total Bytes', label: 'Total Bytes', align: 'right', render: (v) => formatBytes(v) },
    { key: 'Unique Clients', label: 'Unique Clients', align: 'right', render: (v) => formatInteger(v) },
];
const TOP_CLIENT_COLS: ColumnDef[] = [
    { key: 'Client IP', label: 'Client IP' },
    { key: 'Requests', label: 'Requests', align: 'right', render: (v) => formatInteger(v) },
    { key: 'Total Bytes', label: 'Total Bytes', align: 'right', render: (v) => formatBytes(v) },
    { key: 'Unique Domains', label: 'Unique Domains', align: 'right', render: (v) => formatInteger(v) },
];
const CLIENT_DIVERSITY_COLS: ColumnDef[] = [
    { key: 'Client IP', label: 'Client IP' },
    { key: 'Unique Domains', label: 'Unique Domains', align: 'right', render: (v) => formatInteger(v) },
];
const CACHE_COLS: ColumnDef[] = [
    { key: 'Cache Action', label: 'Cache Action' },
    { key: 'Events', label: 'Events', align: 'right', render: (v) => formatInteger(v) },
];
const TOP_DOM_BYTES_COLS: ColumnDef[] = [
    { key: 'Domain', label: 'Domain' },
    { key: 'MB Out', label: 'MB Out', align: 'right' },
];

const Proxy: React.FC = () => {
    const total = useFirstRowField(Q.kpiTotal, 'count');
    const bandwidth = useFirstRowField(Q.kpiBandwidth, 'total');
    const denied = useFirstRowField(Q.kpiDenied, 'count');

    const topDomains = useSearch({ query: Q.topDomains });
    const topClients = useSearch({ query: Q.topClients });
    const clientDiversity = useSearch({ query: Q.clientDomainDiversity });
    const cacheActions = useSearch({ query: Q.contentTypes });
    const topDomBytes = useSearch({ query: Q.topDomainsByBytes });

    const deniedTone = Number(denied.value ?? 0) > 0 ? 'warning' : 'neutral';

    /* Drilldowns (build 159 / session 027 task 6). */
    const { timeRange } = useTimeRange();
    const goDomainRow = (row: Record<string, unknown>): void => {
        const dom = String(row.Domain ?? '');
        if (!dom) return;
        const spl = `\`sap_logserv_idx_macro\` ${ST} url_domain="${splQuote(dom)}" | sort -_time`;
        openInNewTab(buildSplunkSearchUrl(spl, timeRange.earliest, timeRange.latest));
    };
    const goClientRow = (row: Record<string, unknown>): void => {
        const ip = String(row['Client IP'] ?? '');
        if (!ip) return;
        openInNewTab(buildHostDetailsUrl(ip, timeRange.earliest, timeRange.latest));
    };

    return (
        <DashboardLayout
            category="PLATFORM"
            title="Proxy Analytics"
            subtitle="Squid proxy traffic — request volume, status codes, top domains, and bandwidth-by-domain trends"
        >
            <KpiRow>
                <KpiCard label="Total Requests" value={total.value} loading={total.loading} error={total.error} formatValue={formatInteger}
                    sparkline={<SparklineFromQuery query={Q.sparkTotal} valueField="count" fill />} />
                <KpiCard label="Total Bandwidth" value={bandwidth.value} loading={bandwidth.loading} error={bandwidth.error}
                    sparkline={<SparklineFromQuery query={Q.sparkBandwidth} valueField="daily" fill />} />
                <KpiCard label="Denied Requests" value={denied.value} loading={denied.loading} error={denied.error} formatValue={formatInteger} tone={deniedTone}
                    sparkline={<SparklineFromQuery query={Q.sparkDenied} valueField="count" color={logservTheme.colors.orange} fill />} />
            </KpiRow>

            <PanelGrid2>
                <FramedPanel title="Request Volume Over Time" subtitle="Daily proxy request count">
                    <TimeSeriesChart query={Q.requestVolume} height={280} palette="volume" />
                </FramedPanel>
                <FramedPanel title="Status Code Distribution" subtitle="Daily volume bucketed 2xx/3xx/4xx/5xx">
                    <TimeSeriesChart query={Q.statusCodes} height={280} palette="status" />
                </FramedPanel>
            </PanelGrid2>

            <PanelGrid3>
                <FramedPanel title="Domains" subtitle="Domains ranked by request count — click a row for that domain's full proxy log">
                    <DataTable columns={TOP_DOM_COLS} rows={topDomains.results} loading={topDomains.loading} error={topDomains.error} emptyMessage="No proxy events in this time range." onRowClick={goDomainRow} />
                </FramedPanel>
                <FramedPanel title="Clients" subtitle="Client IPs ranked by request count — click a row to open Host Details">
                    <DataTable columns={TOP_CLIENT_COLS} rows={topClients.results} loading={topClients.loading} error={topClients.error} emptyMessage="No proxy events in this time range." onRowClick={goClientRow} />
                </FramedPanel>
                <FramedPanel title="Clients by Domain Diversity" subtitle="Clients ranked by unique domains visited — click a row to open Host Details">
                    <DataTable columns={CLIENT_DIVERSITY_COLS} rows={clientDiversity.results} loading={clientDiversity.loading} error={clientDiversity.error} emptyMessage="No proxy events in this time range." onRowClick={goClientRow} />
                </FramedPanel>
            </PanelGrid3>

            <PanelGrid2>
                <FramedPanel title="Cache Action Distribution" subtitle="Squid cache actions ranked by count">
                    <DataTable columns={CACHE_COLS} rows={cacheActions.results} loading={cacheActions.loading} error={cacheActions.error} emptyMessage="No proxy events in this time range." />
                </FramedPanel>
                <FramedPanel title="Bandwidth Over Time" subtitle="Daily bytes-out volume">
                    <TimeSeriesChart query={Q.bandwidthTimeline} height={280} palette="volume" />
                </FramedPanel>
            </PanelGrid2>

            <PanelGrid2>
                <FramedPanel title="URL Domains by Bytes Out" subtitle="Domains ranked by MB delivered — click a row for that domain's full proxy log">
                    <DataTable columns={TOP_DOM_BYTES_COLS} rows={topDomBytes.results} loading={topDomBytes.loading} error={topDomBytes.error} emptyMessage="No proxy events in this time range." initialSortKey="MB Out" initialSortDir="desc" onRowClick={goDomainRow} />
                </FramedPanel>
                <FramedPanel title="Bandwidth Over Time by Domain (Top 5)" subtitle="Daily bytes by top 5 domains">
                    <TimeSeriesChart query={Q.bandwidthByDomain} height={280} palette="volume" />
                </FramedPanel>
            </PanelGrid2>
        </DashboardLayout>
    );
};

export default Proxy;
