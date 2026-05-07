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
 * Web and API Performance — honest port of v0.0.4.2 logserv_web_api_performance.xml.
 *
 * 5 KPIs (Total / Error Rate / Avg RT / Auth Failures / Unique URLs) + Four-Stage
 * Timing column + Response Time Percentiles + Top Slow URIs table + HTTP Error Rate
 * vs CC Auth Failure Rate line + TLS Version column + TLS Cipher Suites table +
 * Top Slow Clients table + Recent 500-Level Errors table.
 */

const KpiRow = styled.div`
    display: grid;
    grid-template-columns: repeat(5, minmax(0, 1fr));
    gap: ${logservTheme.elevation.panelGap};
    margin-bottom: ${logservTheme.elevation.panelGap};
    @media (max-width: 1400px) { grid-template-columns: repeat(3, minmax(0, 1fr)); }
    @media (max-width: 900px) { grid-template-columns: 1fr; }
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

const ST_BOTH = '(sourcetype="sap:webdispatcher:access" OR sourcetype="sap:scc:http_access")';
const ST_WD = 'sourcetype="sap:webdispatcher:access"';

const Q = {
    kpiTotal: `\`sap_logserv_idx_macro\` ${ST_BOTH} | stats count`,
    kpiErrorRate: `\`sap_logserv_idx_macro\` ${ST_BOTH} | eval is_err = if(tonumber(status)>=400, 1, 0) | stats sum(is_err) as errs count as total | eval pct = if(total>0, round(errs*100/total, 2), 0) | eval display=tostring(pct)."%"`,
    kpiAvgRt: `\`sap_logserv_idx_macro\` ${ST_BOTH} response_time_ms=* | stats avg(response_time_ms) as avg_ms | eval display=tostring(round(avg_ms, 0))." ms"`,
    kpiAuthFail: `\`sap_logserv_idx_macro\` ((sourcetype="sap:webdispatcher:access" AND (status=401 OR status=403)) OR (sourcetype="sap:scc:http_access" AND (status=401 OR status=403 OR is_authenticated="false"))) | stats count`,
    kpiUniqueUrls: `\`sap_logserv_idx_macro\` ${ST_BOTH} uri=* | stats dc(uri) as urls`,

    sparkTotal: `\`sap_logserv_idx_macro\` ${ST_BOTH} | timechart span=1d count`,
    sparkErrorRate: `\`sap_logserv_idx_macro\` ${ST_BOTH} | eval is_err = if(tonumber(status)>=400, 1, 0) | timechart span=1d count as total_daily, sum(is_err) as err_daily | eval daily = if(total_daily>0, round(err_daily*100/total_daily, 2), 0) | fields _time daily`,
    sparkAvgRt: `\`sap_logserv_idx_macro\` ${ST_BOTH} response_time_ms=* | timechart span=1d avg(response_time_ms) as avg_daily | eval daily = round(avg_daily, 0)`,
    sparkAuthFail: `\`sap_logserv_idx_macro\` ((sourcetype="sap:webdispatcher:access" AND (status=401 OR status=403)) OR (sourcetype="sap:scc:http_access" AND (status=401 OR status=403 OR is_authenticated="false"))) | timechart span=1d count`,
    sparkUniqueUrls: `\`sap_logserv_idx_macro\` ${ST_BOTH} uri=* | timechart span=1d dc(uri) as urls`,

    timing: `\`sap_logserv_idx_macro\` ${ST_WD} dt1_us=* dt2_us=* dt3_us=* dt4_us=* | eval dt1_ms = dt1_us/1000 | eval dt2_ms = dt2_us/1000 | eval dt3_ms = dt3_us/1000 | eval dt4_ms = dt4_us/1000 | timechart span=1d avg(dt1_ms) as "Receive (dt1)", avg(dt2_ms) as "Handler (dt2)", avg(dt3_ms) as "Response (dt3)", avg(dt4_ms) as "Send (dt4)"`,
    percentiles: `\`sap_logserv_idx_macro\` ${ST_BOTH} response_time_ms=* | timechart span=1d perc50(response_time_ms) as p50, perc95(response_time_ms) as p95, perc99(response_time_ms) as p99`,
    slowUris: `\`sap_logserv_idx_macro\` ${ST_BOTH} response_time_ms=* uri=* | eval src_log = if(sourcetype="sap:webdispatcher:access", "WebDisp", "CC") | stats count as events, avg(response_time_ms) as avg_ms, perc95(response_time_ms) as p95_ms, sum(eval(if(tonumber(status)>=400, 1, 0))) as errors by uri, src_log | eval avg_ms = round(avg_ms, 0), p95_ms = round(p95_ms, 0) | sort -avg_ms | rename uri as "URI", src_log as "Source", events as "Events", avg_ms as "Avg (ms)", p95_ms as "p95 (ms)", errors as "Errors"`,
    errorAuth: `\`sap_logserv_idx_macro\` ${ST_BOTH} | eval is_http_err = if(tonumber(status)>=400, 1, 0) | eval is_cc = if(sourcetype="sap:scc:http_access", 1, 0) | eval is_cc_auth_fail = if(sourcetype="sap:scc:http_access" AND (status=401 OR status=403 OR is_authenticated="false"), 1, 0) | timechart span=1d count as total_all, sum(is_http_err) as http_err, sum(is_cc) as total_cc, sum(is_cc_auth_fail) as cc_auth_fail | eval "HTTP Error Rate (%)" = if(total_all>0, round(http_err*100/total_all, 2), 0) | eval "CC Auth Failure Rate (%)" = if(total_cc>0, round(cc_auth_fail*100/total_cc, 2), 0) | fields _time, "HTTP Error Rate (%)", "CC Auth Failure Rate (%)"`,
    tlsVersion: `\`sap_logserv_idx_macro\` ${ST_WD} tls_version=* | stats count by tls_version | sort tls_version`,
    tlsCipher: `\`sap_logserv_idx_macro\` ${ST_WD} cipher_suite=* | stats count by cipher_suite | sort -count | rename cipher_suite as "Cipher Suite"`,
    slowClients: `\`sap_logserv_idx_macro\` ${ST_BOTH} response_time_ms=* clientip=* | stats count as events, avg(response_time_ms) as avg_ms, perc95(response_time_ms) as p95_ms, dc(uri) as unique_uris by clientip | eval avg_ms = round(avg_ms, 0), p95_ms = round(p95_ms, 0) | sort -p95_ms | rename clientip as "Client IP", events as "Events", avg_ms as "Avg (ms)", p95_ms as "p95 (ms)", unique_uris as "Unique URIs"`,
    err500: `\`sap_logserv_idx_macro\` ${ST_BOTH} status>=500 | eval src_log = if(sourcetype="sap:webdispatcher:access", "WebDisp", "CC") | eval resp_time = if(isnotnull(response_time_ms), tostring(response_time_ms) . " ms", "-") | eval Time=strftime(_time, "%Y-%m-%d %H:%M:%S") | sort -_time | table Time, src_log, host, clientip, method, uri, status, resp_time | rename src_log as "Source", host as "Host", clientip as "Client IP", method as "Method", uri as "URI", status as "Status", resp_time as "Response Time"`,
};

interface FirstRow { value: unknown; loading: boolean; error: Error | null; }
const useFirstRowField = (q: string, f: string): FirstRow => {
    const { results, loading, error } = useSearch({ query: q });
    const value = results && results[0] ? (results[0] as Record<string, unknown>)[f] : undefined;
    return { value, loading, error };
};

const SLOW_URI_COLS: ColumnDef[] = [
    { key: 'URI', label: 'URI' },
    { key: 'Source', label: 'Source', width: '90px' },
    { key: 'Events', label: 'Events', align: 'right', render: (v) => formatInteger(v) },
    { key: 'Avg (ms)', label: 'Avg (ms)', align: 'right' },
    { key: 'p95 (ms)', label: 'p95 (ms)', align: 'right' },
    { key: 'Errors', label: 'Errors', align: 'right', render: (v) => formatInteger(v) },
];
const TLS_CIPHER_COLS: ColumnDef[] = [
    { key: 'Cipher Suite', label: 'Cipher Suite' },
    { key: 'count', label: 'Count', align: 'right', render: (v) => formatInteger(v) },
];
const SLOW_CLIENT_COLS: ColumnDef[] = [
    { key: 'Client IP', label: 'Client IP' },
    { key: 'Events', label: 'Events', align: 'right', render: (v) => formatInteger(v) },
    { key: 'Avg (ms)', label: 'Avg (ms)', align: 'right' },
    { key: 'p95 (ms)', label: 'p95 (ms)', align: 'right' },
    { key: 'Unique URIs', label: 'Unique URIs', align: 'right', render: (v) => formatInteger(v) },
];
const ERR500_COLS: ColumnDef[] = [
    { key: 'Time', label: 'Time', width: '160px' },
    { key: 'Source', label: 'Source', width: '90px' },
    { key: 'Host', label: 'Host', width: '160px' },
    { key: 'Client IP', label: 'Client IP', width: '120px' },
    { key: 'Method', label: 'Method', width: '80px' },
    { key: 'URI', label: 'URI' },
    { key: 'Status', label: 'Status', width: '70px' },
    { key: 'Response Time', label: 'Response Time', width: '120px' },
];

const WebApiPerformance: React.FC = () => {
    const total = useFirstRowField(Q.kpiTotal, 'count');
    const errorRate = useFirstRowField(Q.kpiErrorRate, 'display');
    const avgRt = useFirstRowField(Q.kpiAvgRt, 'display');
    const authFail = useFirstRowField(Q.kpiAuthFail, 'count');
    const uniqueUrls = useFirstRowField(Q.kpiUniqueUrls, 'urls');

    const slowUris = useSearch({ query: Q.slowUris });
    const tlsCipher = useSearch({ query: Q.tlsCipher });
    const slowClients = useSearch({ query: Q.slowClients });
    const err500 = useSearch({ query: Q.err500 });

    const errorRateNum = parseFloat(String(errorRate.value ?? '0').replace('%', ''));
    const errorTone = errorRateNum > 5 ? 'critical' : errorRateNum > 1 ? 'warning' : 'positive';
    const authFailTone = Number(authFail.value ?? 0) > 0 ? 'critical' : 'neutral';

    /* Drilldowns (build 159 / session 027 task 6). */
    const { timeRange } = useTimeRange();
    const goErrorRateKpi = (): void => {
        const spl = `\`sap_logserv_idx_macro\` ${ST_BOTH} status>=400 | sort -_time`;
        openInNewTab(buildSplunkSearchUrl(spl, timeRange.earliest, timeRange.latest));
    };
    const goAuthFailKpi = (): void => {
        const spl = '`sap_logserv_idx_macro` ((sourcetype="sap:webdispatcher:access" AND (status=401 OR status=403)) OR (sourcetype="sap:scc:http_access" AND (status=401 OR status=403 OR is_authenticated="false"))) | sort -_time';
        openInNewTab(buildSplunkSearchUrl(spl, timeRange.earliest, timeRange.latest));
    };
    const goSlowUriRow = (row: Record<string, unknown>): void => {
        const uri = String(row.URI ?? '');
        if (!uri) return;
        const spl = `\`sap_logserv_idx_macro\` ${ST_BOTH} uri="${splQuote(uri)}" | sort -response_time_ms | table _time clientip method status response_time_ms uri`;
        openInNewTab(buildSplunkSearchUrl(spl, timeRange.earliest, timeRange.latest));
    };
    const goSlowClientRow = (row: Record<string, unknown>): void => {
        const ip = String(row['Client IP'] ?? '');
        if (!ip) return;
        const spl = `\`sap_logserv_idx_macro\` ${ST_BOTH} clientip="${splQuote(ip)}" | sort -_time`;
        openInNewTab(buildSplunkSearchUrl(spl, timeRange.earliest, timeRange.latest));
    };
    const goErr500Row = (row: Record<string, unknown>): void => {
        const ip = String(row['Client IP'] ?? '');
        const uri = String(row.URI ?? '');
        if (!ip && !uri) return;
        const ipClause = ip ? `clientip="${splQuote(ip)}" ` : '';
        const uriClause = uri ? `uri="${splQuote(uri)}" ` : '';
        const spl = `\`sap_logserv_idx_macro\` ${ST_BOTH} status>=500 ${ipClause}${uriClause}| sort -_time`;
        openInNewTab(buildSplunkSearchUrl(spl, timeRange.earliest, timeRange.latest));
    };

    return (
        <DashboardLayout
            category="INTEGRATION"
            title="Web and API Performance"
            subtitle="Web Dispatcher and Cloud Connector HTTP traffic performance — four-stage request timing, response-time percentiles, TLS posture, and cross-source error correlation"
        >
            <KpiRow>
                <KpiCard label="Total Requests" value={total.value} loading={total.loading} error={total.error} formatValue={formatInteger}
                    sparkline={<SparklineFromQuery query={Q.sparkTotal} valueField="count" fill />} />
                <KpiCard label="HTTP Error Rate" value={errorRate.value} loading={errorRate.loading} error={errorRate.error} tone={errorTone}
                    sparkline={<SparklineFromQuery query={Q.sparkErrorRate} valueField="daily" color={logservTheme.colors.red} fill />}
                    onClick={goErrorRateKpi} clickTitle="Open all 4xx/5xx events in Splunk Search" />
                <KpiCard label="Avg Response Time" value={avgRt.value} loading={avgRt.loading} error={avgRt.error}
                    sparkline={<SparklineFromQuery query={Q.sparkAvgRt} valueField="daily" fill />} />
                <KpiCard label="Auth Failures" value={authFail.value} loading={authFail.loading} error={authFail.error} formatValue={formatInteger} tone={authFailTone}
                    sparkline={<SparklineFromQuery query={Q.sparkAuthFail} valueField="count" color={logservTheme.colors.red} fill />}
                    onClick={goAuthFailKpi} clickTitle="Open auth-failure events in Splunk Search" />
                <KpiCard label="Unique URLs" value={uniqueUrls.value} loading={uniqueUrls.loading} error={uniqueUrls.error} formatValue={formatInteger}
                    sparkline={<SparklineFromQuery query={Q.sparkUniqueUrls} valueField="urls" fill />} />
            </KpiRow>

            <PanelGrid2>
                <FramedPanel title="Four-Stage Request Timing Breakdown (avg ms per stage)" subtitle="Web Dispatcher dt1–dt4 average timing per day">
                    <TimeSeriesChart query={Q.timing} height={280} palette="volume" />
                </FramedPanel>
                <FramedPanel title="Response Time Percentiles Over Time" subtitle="p50 / p95 / p99 across both sources">
                    <TimeSeriesChart query={Q.percentiles} height={280} palette="volume" />
                </FramedPanel>
            </PanelGrid2>

            <FullWidthPanel>
                <FramedPanel title="Slow URIs by Avg Response Time" subtitle="URIs across Web Dispatcher + Cloud Connector ranked by avg response time">
                    <DataTable columns={SLOW_URI_COLS} rows={slowUris.results} loading={slowUris.loading} error={slowUris.error} emptyMessage="No URI timing data in this time range." initialSortKey="Avg (ms)" initialSortDir="desc" onRowClick={goSlowUriRow} />
                </FramedPanel>
            </FullWidthPanel>

            <FullWidthPanel>
                <FramedPanel title="HTTP Error Rate vs Cloud Connector Auth Failure Rate" subtitle="Two correlated rates — daily">
                    <TimeSeriesChart query={Q.errorAuth} height={280} palette="errors" />
                </FramedPanel>
            </FullWidthPanel>

            <PanelGrid2>
                <FramedPanel title="TLS Version Distribution" subtitle="Web Dispatcher TLS protocol mix">
                    <TimeSeriesChart query={Q.tlsVersion} height={260} palette="volume" />
                </FramedPanel>
                <FramedPanel title="TLS Cipher Suite Distribution" subtitle="Negotiated cipher suites ranked by count">
                    <DataTable columns={TLS_CIPHER_COLS} rows={tlsCipher.results} loading={tlsCipher.loading} error={tlsCipher.error} emptyMessage="No TLS cipher data in this time range." />
                </FramedPanel>
            </PanelGrid2>

            <FullWidthPanel>
                <FramedPanel title="Slow Clients by p95 Response Time" subtitle="Client IPs ranked by p95 latency">
                    <DataTable columns={SLOW_CLIENT_COLS} rows={slowClients.results} loading={slowClients.loading} error={slowClients.error} emptyMessage="No client timing data in this time range." initialSortKey="p95 (ms)" initialSortDir="desc" onRowClick={goSlowClientRow} />
                </FramedPanel>
            </FullWidthPanel>

            <FullWidthPanel>
                <FramedPanel title="Recent 500-Level Errors" subtitle="Server errors with source / client / URI, most-recent first">
                    <DataTable columns={ERR500_COLS} rows={err500.results} loading={err500.loading} error={err500.error} emptyMessage="No 500-level errors in this time range." initialSortKey="Time" initialSortDir="desc" onRowClick={goErr500Row} />
                </FramedPanel>
            </FullWidthPanel>
        </DashboardLayout>
    );
};

export default WebApiPerformance;
