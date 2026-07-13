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
import { buildSplunkSearchUrl, openInNewTab, splQuote } from '../utils/drilldownUrls';
import { logservTheme } from '../styles/logservTheme';

/**
 * Cloud Connector — honest port of v0.0.4.2 logserv_cloud_connector.xml.
 *
 * 4 KPIs (Requests / Error Rate / Audit / Access Denied) + Request Volume line +
 * Status Codes column + Top URIs table + Average Response Time line + Top Clients table +
 * HTTP Methods pie + Audit Log table.
 *
 * Performance tiering (session 049 CIM; rebuilt build 232 → KV-Store rollup). The
 * CIM Web/Authentication tier was slow whenever the customer hadn't accelerated the
 * models (summariesonly=false fell back to a RAW full-scan), so every CIM panel now
 * reads the always-fast `logserv_cloudconn_rollup` collection (5 metrics):
 *   - tstats-now (unchanged): pure counts — Total Requests, Audit Events, Request Volume.
 *   - http  (per-bucket count/err_count/sum_rt/cnt_rt) → HTTP Error Rate + Avg Response.
 *   - status (status) → Status Code Distribution (status_cat decoded at read).
 *   - method (method) → HTTP Methods pie.
 *   - client (clientip,uri: count/sum_rt/cnt_rt/bytes_sum) → Top Clients (by clientip)
 *     AND Top URIs (by uri). audit (scc_audit_type) → Access Denied KPI+spark.
 *   - RAW (unchanged): the audit-log listing (| head 200).
 * HTTP Error Rate = status>=400 fraction (the session-050 fix: props.conf's is_error
 * is the STRING "true"/"false", so the old `is_error=1` numeric test read a constant
 * 0%; status>=400 is the intended semantics). Read idiom: inputlookup metric=X |
 * bucket_ts range | <agg>. Avg = Σsum_rt/Σcnt_rt.
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

// Pure-count panels read default-indexed dims via tstats-now (macro re-pins the
// customer's index, honoring con1/jaclyn local/macros.conf overrides).
const TS_WHERE_HTTP = `WHERE \`sap_logserv_idx_macro\` ${ST_HTTP}`;
const TS_WHERE_AUDIT = `WHERE \`sap_logserv_idx_macro\` ${ST_AUDIT}`;
// KV-Store rollup reads (build 232 — replaces the CIM Web/Authentication tier).
const ROLL = 'logserv_cloudconn_rollup';
const RANGE = '| addinfo | where bucket_ts>=info_min_time AND bucket_ts<info_max_time';
const R_HTTP = `| inputlookup ${ROLL} where metric="http" ${RANGE}`;
const R_STATUS = `| inputlookup ${ROLL} where metric="status" ${RANGE}`;
const R_METHOD = `| inputlookup ${ROLL} where metric="method" ${RANGE}`;
const R_CLIENT = `| inputlookup ${ROLL} where metric="client" ${RANGE}`;
const R_AUDIT = `| inputlookup ${ROLL} where metric="audit" ${RANGE}`;

const formatPercent = (raw: unknown): string => {
    if (raw === null || typeof raw === 'undefined') return '—';
    const n = typeof raw === 'number' ? raw : parseFloat(String(raw));
    if (Number.isNaN(n)) return String(raw);
    return `${n.toFixed(1)}%`;
};

const Q_BASE = {
    // --- tstats-now (pure counts on default-indexed fields) ------------------
    kpiRequests: `| tstats count ${TS_WHERE_HTTP}`,
    kpiAudit: `| tstats count ${TS_WHERE_AUDIT}`,
    sparkRequests: `| tstats count ${TS_WHERE_HTTP} BY _time span=1d | timechart span=1d sum(count) AS count`,
    sparkAudit: `| tstats count ${TS_WHERE_AUDIT} BY _time span=1d | timechart span=1d sum(count) AS count`,
    requestVolume: `| tstats count ${TS_WHERE_HTTP} BY _time span=1d | timechart span=1d sum(count) AS Requests`,

    // --- KV-Store rollup: audit (scc:audit ACCESS_DENIED) -------------------
    kpiAccessDenied: `${R_AUDIT} | search scc_audit_type="ACCESS_DENIED" | stats count as n, sum(count) as count | fillnull value=0 count | fields count`,
    sparkAccessDenied: `${R_AUDIT} | search scc_audit_type="ACCESS_DENIED" | eval _time=bucket_ts | timechart span=1d sum(count) AS count | fillnull value=0`,

    // --- KV-Store rollup: status / method / client --------------------------
    statusCodes: `${R_STATUS} | eval status_cat=case(tonumber(status)>=200 AND tonumber(status)<300, "Success (2xx)", tonumber(status)>=300 AND tonumber(status)<400, "Redirect (3xx)", tonumber(status)>=400 AND tonumber(status)<500, "Client Error (4xx)", tonumber(status)>=500, "Server Error (5xx)", 1=1, "Other") | eval _time=bucket_ts | timechart span=1d sum(count) by status_cat | fillnull value=0`,
    httpMethods: `${R_METHOD} | search method!="(none)" | stats sum(count) as count by method | sort -count`,
    topClients: `${R_CLIENT} | search clientip!="(none)" | stats sum(count) as Requests, sum(bytes_sum) as "Total Bytes", dc(eval(if(uri="(none)",null(),uri))) as "Unique URIs" by clientip | sort -Requests | rename clientip as "Client IP"`,
    // HTTP Error Rate = status>=400 fraction (session-050 fix; props.conf is_error is
    // the STRING "true"/"false" so the old is_error=1 numeric test read a constant 0%).
    kpiErrorRate: `${R_HTTP} | stats count as n, sum(err_count) as errs, sum(count) as total | eval pct=if(total>0, round(errs/total*100, 1), 0) | table pct`,
    sparkErrorRate: `${R_HTTP} | eval _time=bucket_ts | timechart span=1d sum(err_count) as ed, sum(count) as td | eval daily=if(td>0, round(ed/td*100, 1), 0) | fields _time daily`,

    // --- KV-Store rollup: client metric serves Top URIs (by uri) + Avg Response
    topUris: `${R_CLIENT} | search uri!="(none)" | stats sum(count) as Requests, sum(sum_rt) as s, sum(cnt_rt) as c, sum(bytes_sum) as "Total Bytes" by uri | eval "Avg Response (ms)"=round(if(c>0,s/c,0),1) | sort -Requests | rename uri as URI | table URI, Requests, "Avg Response (ms)", "Total Bytes"`,
    responseTime: `${R_HTTP} | eval _time=bucket_ts | timechart span=1d sum(sum_rt) as s, sum(cnt_rt) as c | eval "Avg Response Time (ms)"=s/c | fields _time, "Avg Response Time (ms)"`,
    auditLog: `\`sap_logserv_idx_macro\` ${ST_AUDIT} | head 200 | table _time scc_audit_type scc_account_id | sort -_time | rename scc_audit_type as "Audit Type" scc_account_id as "Account ID"`,
};

/* ---------------------------------------------------------------------------
 * RAW fallbacks for the sub-hour hybrid (session 086). Each is the raw scc
 * scan its rollup metric precomputes, reconciled to the cached read's output
 * columns (byte-verified equal at wide windows). Rollup measures map to raw:
 * bytes_sum -> sum(bytes); sum(count) -> count; err_count -> status>=400
 * indicator; sum_rt/cnt_rt -> avg(response_time_ms); "(none)" sentinels drop.
 * Only ROLLUP reads are hybridised; the tstats KPIs/volume + the auditLog
 * (| head 200 listing) are already correct at any range; sparklines stay cached.
 * ------------------------------------------------------------------------- */
const CC_HTTP = '`sap_logserv_idx_macro` sourcetype="sap:scc:http_access"';
const CC_AUDIT = '`sap_logserv_idx_macro` sourcetype="sap:scc:audit"';
const QRAW_BASE = {
    kpiAccessDenied: `${CC_AUDIT} scc_audit_type="ACCESS_DENIED" | stats count`,
    kpiErrorRate: `${CC_HTTP} | stats count as total, sum(eval(if(tonumber(status)>=400,1,0))) as errs | eval pct=if(total>0, round(errs/total*100, 1), 0) | table pct`,
    statusCodes: `${CC_HTTP} | eval status_cat=case(tonumber(status)>=200 AND tonumber(status)<300, "Success (2xx)", tonumber(status)>=300 AND tonumber(status)<400, "Redirect (3xx)", tonumber(status)>=400 AND tonumber(status)<500, "Client Error (4xx)", tonumber(status)>=500, "Server Error (5xx)", 1=1, "Other") | timechart span=1d count by status_cat | fillnull value=0`,
    httpMethods: `${CC_HTTP} method=* | stats count by method | sort -count`,
    topClients: `${CC_HTTP} clientip=* | stats count as Requests, sum(bytes) as "Total Bytes", dc(uri) as "Unique URIs" by clientip | sort -Requests | rename clientip as "Client IP"`,
    topUris: `${CC_HTTP} uri=* | stats count as Requests, avg(response_time_ms) as "Avg Response (ms)", sum(bytes) as "Total Bytes" by uri | eval "Avg Response (ms)"=round('Avg Response (ms)',1) | sort -Requests | rename uri as URI | table URI, Requests, "Avg Response (ms)", "Total Bytes"`,
    responseTime: `${CC_HTTP} | timechart span=1d avg(response_time_ms) as "Avg Response Time (ms)" | fields _time, "Avg Response Time (ms)"`,
};

interface FirstRow { value: unknown; loading: boolean; error: Error | null; }
const useFirstRowField = (q: string, f: string): FirstRow => {
    const { results, loading, error } = useSearch({ query: q });
    const value = results && results[0] ? (results[0] as Record<string, unknown>)[f] : undefined;
    return { value, loading, error };
};
/** useFirstRowField over a hybrid cached/raw pair (session 085) — sub-hour
 *  ranges read the raw query, wide ranges the rollup. */
const useFirstRowFieldHybrid = (cached: string, raw: string, f: string): FirstRow => {
    const { results, loading, error } = useHybridSearch({ cached, raw });
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
    const { provider } = useCloudProvider();
    const Q = React.useMemo(() => mapCloudProviderQueries(Q_BASE, provider), [provider]);
    // RAW fallbacks for the sub-hour hybrid (session 086); same cloud mapping.
    const QRAW = React.useMemo(() => mapCloudProviderQueries(QRAW_BASE, provider), [provider]);
    const requests = useFirstRowField(Q.kpiRequests, 'count');
    const errorRate = useFirstRowFieldHybrid(Q.kpiErrorRate, QRAW.kpiErrorRate, 'pct');
    const audit = useFirstRowField(Q.kpiAudit, 'count');
    const accessDenied = useFirstRowFieldHybrid(Q.kpiAccessDenied, QRAW.kpiAccessDenied, 'count');

    const topUris = useHybridSearch({ cached: Q.topUris, raw: QRAW.topUris });
    const topClients = useHybridSearch({ cached: Q.topClients, raw: QRAW.topClients });
    const auditLog = useSearch({ query: Q.auditLog });

    // Chart panels take a query STRING → route once here (sub-hour -> raw).
    const qStatusCodes = useRoutedQuery(Q.statusCodes, QRAW.statusCodes);
    const qHttpMethods = useRoutedQuery(Q.httpMethods, QRAW.httpMethods);
    const qResponseTime = useRoutedQuery(Q.responseTime, QRAW.responseTime);

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
                    <TimeSeriesChart query={qStatusCodes} height={280} palette="status" />
                </FramedPanel>
            </PanelGrid2>

            <PanelGrid3>
                <FramedPanel search={topUris} title="URIs by Request Count" subtitle="URIs ranked by request count — click a row for that URI's full request log">
                    <DataTable columns={TOP_URI_COLS} rows={topUris.results} loading={topUris.loading} error={topUris.error} emptyMessage="No SCC HTTP requests in this time range." onRowClick={goUriRow} />
                </FramedPanel>
                <FramedPanel search={topClients} title="Clients" subtitle="Client IPs ranked by request count — click a row for that client's full request log">
                    <DataTable columns={TOP_CLIENT_COLS} rows={topClients.results} loading={topClients.loading} error={topClients.error} emptyMessage="No SCC HTTP requests in this time range." onRowClick={goClientRow} />
                </FramedPanel>
                <FramedPanel
                    title="HTTP Methods"
                    subtitle="Request method distribution"
                    onClick={goMethodPie}
                    clickTitle="Open method-by-count breakdown in Splunk Search"
                >
                    <PieChart query={qHttpMethods} categoryField="method" valueField="count" height={300} donut />
                </FramedPanel>
            </PanelGrid3>

            <PanelGrid2>
                <FramedPanel title="Average Response Time" subtitle="Daily mean response time (ms)">
                    <TimeSeriesChart query={qResponseTime} height={280} palette="volume" />
                </FramedPanel>
                <FramedPanel search={auditLog} title="Cloud Connector Audit Log" subtitle="SCC audit events, most-recent first">
                    <DataTable columns={AUDIT_COLS} rows={auditLog.results} loading={auditLog.loading} error={auditLog.error} emptyMessage="No SCC audit events in this time range." onRowClick={goAuditRow} />
                </FramedPanel>
            </PanelGrid2>
        </DashboardLayout>
    );
};

export default CloudConnector;
