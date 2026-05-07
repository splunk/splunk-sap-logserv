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
import { buildSplunkSearchUrl, openInNewTab, splQuote } from '../utils/drilldownUrls';
import { logservTheme } from '../styles/logservTheme';

/**
 * Cloud Connector — honest port of v0.0.4.2 logserv_cloud_connector.xml.
 *
 * 4 KPIs (Requests / Error Rate / Audit / Access Denied) + Request Volume line +
 * Status Codes column + Top URIs table + Average Response Time line + Top Clients table +
 * HTTP Methods pie + Audit Log table.
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
const PanelGrid3 = styled.div`
    display: grid;
    grid-template-columns: 2fr 2fr 1fr;
    gap: ${logservTheme.elevation.panelGap};
    margin-bottom: ${logservTheme.elevation.panelGap};
    @media (max-width: 1400px) { grid-template-columns: 1fr; }
`;

const ST_HTTP = 'sourcetype="sap:scc:http_access"';
const ST_AUDIT = 'sourcetype="sap:scc:audit"';

const formatPercent = (raw: unknown): string => {
    if (raw === null || typeof raw === 'undefined') return '—';
    const n = typeof raw === 'number' ? raw : parseFloat(String(raw));
    if (Number.isNaN(n)) return String(raw);
    return `${n.toFixed(1)}%`;
};

const Q = {
    kpiRequests: `\`sap_logserv_idx_macro\` ${ST_HTTP} | stats count`,
    kpiErrorRate: `\`sap_logserv_idx_macro\` ${ST_HTTP} | eval is_err=if(is_error=1,1,0) | stats sum(is_err) as errs count as total | eval pct=round(errs/total*100, 1)`,
    kpiAudit: `\`sap_logserv_idx_macro\` ${ST_AUDIT} | stats count`,
    kpiAccessDenied: `\`sap_logserv_idx_macro\` ${ST_AUDIT} scc_audit_type="ACCESS_DENIED" | stats count`,

    sparkRequests: `\`sap_logserv_idx_macro\` ${ST_HTTP} | timechart span=1d count`,
    sparkErrorRate: `\`sap_logserv_idx_macro\` ${ST_HTTP} | eval is_err=if(is_error=1,1,0) | timechart span=1d sum(is_err) as errors_daily count as total_daily | eval daily = round(errors_daily/total_daily*100, 1) | fields _time daily`,
    sparkAudit: `\`sap_logserv_idx_macro\` ${ST_AUDIT} | timechart span=1d count`,
    sparkAccessDenied: `\`sap_logserv_idx_macro\` ${ST_AUDIT} scc_audit_type="ACCESS_DENIED" | timechart span=1d count`,

    requestVolume: `\`sap_logserv_idx_macro\` ${ST_HTTP} | timechart span=1d count as Requests`,
    statusCodes: `\`sap_logserv_idx_macro\` ${ST_HTTP} | eval status_cat=case(status>=200 AND status<300, "Success (2xx)", status>=300 AND status<400, "Redirect (3xx)", status>=400 AND status<500, "Client Error (4xx)", status>=500, "Server Error (5xx)", 1=1, "Other") | timechart span=1d count by status_cat`,
    topUris: `\`sap_logserv_idx_macro\` ${ST_HTTP} | stats count as Requests avg(response_time_ms) as "Avg Response (ms)" sum(bytes) as "Total Bytes" by uri | eval "Avg Response (ms)"=round('Avg Response (ms)', 1) | sort -Requests | rename uri as URI`,
    responseTime: `\`sap_logserv_idx_macro\` ${ST_HTTP} | timechart span=1d avg(response_time_ms) as "Avg Response Time (ms)"`,
    topClients: `\`sap_logserv_idx_macro\` ${ST_HTTP} | stats count as Requests sum(bytes) as "Total Bytes" dc(uri) as "Unique URIs" by clientip | sort -Requests | rename clientip as "Client IP"`,
    httpMethods: `\`sap_logserv_idx_macro\` ${ST_HTTP} method=* | stats count by method | sort -count`,
    auditLog: `\`sap_logserv_idx_macro\` ${ST_AUDIT} | table _time scc_audit_type scc_account_id | sort -_time | rename scc_audit_type as "Audit Type" scc_account_id as "Account ID"`,
};

interface FirstRow { value: unknown; loading: boolean; error: Error | null; }
const useFirstRowField = (q: string, f: string): FirstRow => {
    const { results, loading, error } = useSearch({ query: q });
    const value = results && results[0] ? (results[0] as Record<string, unknown>)[f] : undefined;
    return { value, loading, error };
};

const TOP_URI_COLS: ColumnDef[] = [
    { key: 'URI', label: 'URI' },
    { key: 'Requests', label: 'Requests', align: 'right', render: (v) => formatInteger(v) },
    { key: 'Avg Response (ms)', label: 'Avg Response (ms)', align: 'right' },
    { key: 'Total Bytes', label: 'Total Bytes', align: 'right', render: (v) => formatInteger(v) },
];
const TOP_CLIENT_COLS: ColumnDef[] = [
    { key: 'Client IP', label: 'Client IP' },
    { key: 'Requests', label: 'Requests', align: 'right', render: (v) => formatInteger(v) },
    { key: 'Total Bytes', label: 'Total Bytes', align: 'right', render: (v) => formatInteger(v) },
    { key: 'Unique URIs', label: 'Unique URIs', align: 'right', render: (v) => formatInteger(v) },
];
const AUDIT_COLS: ColumnDef[] = [
    { key: '_time', label: 'Time', width: '160px', render: (v) => v ? new Date(String(v)).toLocaleString('en-US', { hour12: false }) : '' },
    { key: 'Audit Type', label: 'Audit Type' },
    { key: 'Account ID', label: 'Account ID' },
];

const CloudConnector: React.FC = () => {
    const requests = useFirstRowField(Q.kpiRequests, 'count');
    const errorRate = useFirstRowField(Q.kpiErrorRate, 'pct');
    const audit = useFirstRowField(Q.kpiAudit, 'count');
    const accessDenied = useFirstRowField(Q.kpiAccessDenied, 'count');

    const topUris = useSearch({ query: Q.topUris });
    const topClients = useSearch({ query: Q.topClients });
    const auditLog = useSearch({ query: Q.auditLog });

    const errorRateNum = Number(errorRate.value ?? 0);
    const errorTone = errorRateNum > 5 ? 'critical' : errorRateNum > 1 ? 'warning' : 'positive';
    const deniedTone = Number(accessDenied.value ?? 0) > 0 ? 'critical' : 'neutral';

    /* Drilldowns (build 159 / session 027 task 6). */
    const { timeRange } = useTimeRange();
    const goUriRow = (row: Record<string, unknown>): void => {
        const uri = String(row.URI ?? '');
        if (!uri) return;
        const spl = `\`sap_logserv_idx_macro\` ${ST_HTTP} uri="${splQuote(uri)}" | sort -_time`;
        openInNewTab(buildSplunkSearchUrl(spl, timeRange.earliest, timeRange.latest));
    };
    const goClientRow = (row: Record<string, unknown>): void => {
        const ip = String(row['Client IP'] ?? '');
        if (!ip) return;
        const spl = `\`sap_logserv_idx_macro\` ${ST_HTTP} clientip="${splQuote(ip)}" | sort -_time`;
        openInNewTab(buildSplunkSearchUrl(spl, timeRange.earliest, timeRange.latest));
    };
    const goMethodPie = (): void => {
        const spl = `\`sap_logserv_idx_macro\` ${ST_HTTP} method=* | stats count by method | sort -count`;
        openInNewTab(buildSplunkSearchUrl(spl, timeRange.earliest, timeRange.latest));
    };
    const goAuditRow = (row: Record<string, unknown>): void => {
        const t = String(row['Audit Type'] ?? '');
        if (!t) return;
        const spl = `\`sap_logserv_idx_macro\` ${ST_AUDIT} scc_audit_type="${splQuote(t)}" | sort -_time`;
        openInNewTab(buildSplunkSearchUrl(spl, timeRange.earliest, timeRange.latest));
    };

    return (
        <DashboardLayout
            category="INTEGRATION"
            title="Cloud Connector"
            subtitle="SAP Cloud Connector tunnel activity — HTTP traffic, status codes, response times, and audit log"
        >
            <KpiRow>
                <KpiCard label="Total Requests" value={requests.value} loading={requests.loading} error={requests.error} formatValue={formatInteger}
                    sparkline={<SparklineFromQuery query={Q.sparkRequests} valueField="count" fill />} />
                <KpiCard label="HTTP Error Rate" value={errorRate.value} loading={errorRate.loading} error={errorRate.error} formatValue={formatPercent} tone={errorTone}
                    sparkline={<SparklineFromQuery query={Q.sparkErrorRate} valueField="daily" color={logservTheme.colors.red} fill />} />
                <KpiCard label="Audit Events" value={audit.value} loading={audit.loading} error={audit.error} formatValue={formatInteger}
                    sparkline={<SparklineFromQuery query={Q.sparkAudit} valueField="count" fill />} />
                <KpiCard label="Access Denied Events" value={accessDenied.value} loading={accessDenied.loading} error={accessDenied.error} formatValue={formatInteger} tone={deniedTone}
                    sparkline={<SparklineFromQuery query={Q.sparkAccessDenied} valueField="count" color={logservTheme.colors.red} fill />} />
            </KpiRow>

            <PanelGrid2>
                <FramedPanel title="Request Volume Over Time" subtitle="Daily SCC HTTP request count">
                    <TimeSeriesChart query={Q.requestVolume} height={280} palette="volume" />
                </FramedPanel>
                <FramedPanel title="Status Code Distribution" subtitle="Daily volume bucketed 2xx/3xx/4xx/5xx">
                    <TimeSeriesChart query={Q.statusCodes} height={280} palette="status" />
                </FramedPanel>
            </PanelGrid2>

            <PanelGrid3>
                <FramedPanel title="URIs by Request Count" subtitle="URIs ranked by request count — click a row for that URI's full request log">
                    <DataTable columns={TOP_URI_COLS} rows={topUris.results} loading={topUris.loading} error={topUris.error} emptyMessage="No SCC HTTP requests in this time range." onRowClick={goUriRow} />
                </FramedPanel>
                <FramedPanel title="Clients" subtitle="Client IPs ranked by request count — click a row for that client's full request log">
                    <DataTable columns={TOP_CLIENT_COLS} rows={topClients.results} loading={topClients.loading} error={topClients.error} emptyMessage="No SCC HTTP requests in this time range." onRowClick={goClientRow} />
                </FramedPanel>
                <FramedPanel
                    title="HTTP Methods"
                    subtitle="Request method distribution"
                    onClick={goMethodPie}
                    clickTitle="Open method-by-count breakdown in Splunk Search"
                >
                    <PieChart query={Q.httpMethods} categoryField="method" valueField="count" height={300} donut />
                </FramedPanel>
            </PanelGrid3>

            <PanelGrid2>
                <FramedPanel title="Average Response Time" subtitle="Daily mean response time (ms)">
                    <TimeSeriesChart query={Q.responseTime} height={280} palette="volume" />
                </FramedPanel>
                <FramedPanel title="Cloud Connector Audit Log" subtitle="SCC audit events, most-recent first">
                    <DataTable columns={AUDIT_COLS} rows={auditLog.results} loading={auditLog.loading} error={auditLog.error} emptyMessage="No SCC audit events in this time range." onRowClick={goAuditRow} />
                </FramedPanel>
            </PanelGrid2>
        </DashboardLayout>
    );
};

export default CloudConnector;
