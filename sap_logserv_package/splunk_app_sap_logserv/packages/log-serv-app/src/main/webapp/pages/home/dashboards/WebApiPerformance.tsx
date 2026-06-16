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

/**
 * Dashboard-perf roadmap tier #6 (KV-Store precompute, session 052 / build 222).
 *
 * Build 232 percentile refactor: this WAS a percentile dashboard where the
 * true-percentile panels stayed RAW (session-051 "option c") because p50/p95/p99
 * do NOT merge byte-exact across hourly buckets. They are now folded into the
 * rollup — p50/p95/p99 are DROPPED and replaced by Avg (= Σsum_rt/Σcnt_rt) + Max
 * (= max-of-per-bucket-max_rt), both byte-exact. Only err500 (event listing,
 * | head 200) stays RAW.
 *
 * 7 metrics (design adversarially reviewed pre-build). `core` per-bucket over
 * ST_BOTH: count + err_count (tonumber(status)>=400 — range test NEEDS tonumber;
 * non-numeric status → not counted) + sum_rt (NATIVE float — WD response_time_ms
 * is fractional, CC integer; NO round) + cnt_rt (count(response_time_ms)) +
 * max_rt (max(response_time_ms), build 232) + authfail_count (WD 401/403 + CC
 * 401/403/is_authenticated="false" — bare string status=, NOT tonumber) +
 * cc_count + cc_authfail_count. `url` (uri). `timing` per-bucket dt1-4 sums +
 * cnt_dt (4-stage avg, UNROUNDED → float-tolerant). `tls` (tls_version) +
 * `cipher` (cipher_suite). `client` (clientip,uri) count+sum_rt+cnt_rt+max_rt —
 * Slow Clients (Unique URIs byte-exact via the 2-dim grain). `slowuri`
 * (uri,src_log) count+sum_rt+cnt_rt+max_rt+err_count — Slow URIs.
 *
 * Read idiom: `| inputlookup <coll> where metric=X | addinfo | where bucket_ts
 * range | <agg>`. Avg = Σsum_rt/Σcnt_rt; Max = max(max_rt); rates =
 * if(denom>0,round(...,2),0). kpiAvgRt empty-window renders "0 ms" (documented
 * deviation from raw's " ms").
 */
const ROLL = 'logserv_web_timing_rollup';
const RANGE = '| addinfo | where bucket_ts>=info_min_time AND bucket_ts<info_max_time';
const CORE = `| inputlookup ${ROLL} where metric="core" ${RANGE}`;
const URL = `| inputlookup ${ROLL} where metric="url" ${RANGE}`;
const TIMING = `| inputlookup ${ROLL} where metric="timing" ${RANGE}`;
const TLS = `| inputlookup ${ROLL} where metric="tls" ${RANGE}`;
const CIPHER = `| inputlookup ${ROLL} where metric="cipher" ${RANGE}`;
const CLIENT = `| inputlookup ${ROLL} where metric="client" ${RANGE}`;
const SLOWURI = `| inputlookup ${ROLL} where metric="slowuri" ${RANGE}`;

const Q = {
    kpiTotal: `${CORE} | stats count as n, sum(count) as count | fillnull value=0 count | fields count`,
    kpiErrorRate: `${CORE} | stats count as n, sum(err_count) as errs, sum(count) as total | fillnull value=0 errs total | eval pct = if(total>0, round(errs*100/total, 2), 0) | eval display=tostring(pct)."%" | fields display`,
    kpiAvgRt: `${CORE} | stats count as n, sum(sum_rt) as s, sum(cnt_rt) as c | fillnull value=0 s c | eval avg_ms = if(c>0, s/c, 0) | eval display=tostring(round(avg_ms, 0))." ms" | fields display`,
    kpiAuthFail: `${CORE} | stats count as n, sum(authfail_count) as count | fillnull value=0 count | fields count`,
    kpiUniqueUrls: `${URL} | stats count as n, dc(uri) as urls | fillnull value=0 urls | fields urls`,

    sparkTotal: `${CORE} | eval _time=bucket_ts | timechart span=1d sum(count) as count | fillnull value=0`,
    sparkErrorRate: `${CORE} | eval _time=bucket_ts | timechart span=1d sum(count) as total_daily, sum(err_count) as err_daily | eval daily = if(total_daily>0, round(err_daily*100/total_daily, 2), 0) | fields _time daily`,
    sparkAvgRt: `${CORE} | eval _time=bucket_ts | timechart span=1d sum(sum_rt) as s, sum(cnt_rt) as c | eval daily = round(s/c, 0) | fields _time daily`,
    sparkAuthFail: `${CORE} | eval _time=bucket_ts | timechart span=1d sum(authfail_count) as count | fillnull value=0`,
    sparkUniqueUrls: `${URL} | eval _time=bucket_ts | timechart span=1d dc(uri) as urls | fillnull value=0`,

    // Four-stage timing: UNROUNDED avg per stage (Σsum_dtN / Σcnt_dt) → verify
    // float-tolerantly (~1e-13 vs raw avg(), invisible on the chart).
    timing: `${TIMING} | eval _time=bucket_ts | timechart span=1d sum(sum_dt1) as s1, sum(sum_dt2) as s2, sum(sum_dt3) as s3, sum(sum_dt4) as s4, sum(cnt_dt) as c | eval "Receive (dt1)" = s1/c | eval "Handler (dt2)" = s2/c | eval "Response (dt3)" = s3/c | eval "Send (dt4)" = s4/c | fields _time, "Receive (dt1)", "Handler (dt2)", "Response (dt3)", "Send (dt4)"`,
    percentiles: `${CORE} | eval _time=bucket_ts | timechart span=1d sum(sum_rt) as s, sum(cnt_rt) as c, max(max_rt) as "Max (ms)" | eval "Avg (ms)" = if(c>0, s/c, 0) | fields _time, "Avg (ms)", "Max (ms)"`,
    slowUris: `${SLOWURI} | stats sum(count) as events, sum(sum_rt) as s, sum(cnt_rt) as c, max(max_rt) as max_ms, sum(err_count) as errors by uri, src_log | eval avg_ms = round(if(c>0, s/c, 0), 0), max_ms = round(max_ms, 0) | sort -avg_ms | rename uri as "URI", src_log as "Source", events as "Events", avg_ms as "Avg (ms)", max_ms as "Max (ms)", errors as "Errors"`,
    // errorAuth: HTTP error rate denom = sum(count) (all ST_BOTH); CC auth-fail
    // rate denom = sum(cc_count) (CC only). Both if(denom>0,...,0)-guarded.
    errorAuth: `${CORE} | eval _time=bucket_ts | timechart span=1d sum(count) as total_all, sum(err_count) as http_err, sum(cc_count) as total_cc, sum(cc_authfail_count) as cc_auth_fail | eval "HTTP Error Rate (%)" = if(total_all>0, round(http_err*100/total_all, 2), 0) | eval "CC Auth Failure Rate (%)" = if(total_cc>0, round(cc_auth_fail*100/total_cc, 2), 0) | fields _time, "HTTP Error Rate (%)", "CC Auth Failure Rate (%)"`,
    tlsVersion: `${TLS} | stats sum(count) as count by tls_version | sort tls_version`,
    tlsCipher: `${CIPHER} | stats sum(count) as count by cipher_suite | sort -count | rename cipher_suite as "Cipher Suite"`,
    slowClients: `${CLIENT} | stats sum(count) as events, sum(sum_rt) as s, sum(cnt_rt) as c, max(max_rt) as max_ms, dc(eval(if(uri="(none)", null(), uri))) as unique_uris by clientip | eval avg_ms = round(if(c>0, s/c, 0), 0), max_ms = round(max_ms, 0) | sort -max_ms | rename clientip as "Client IP", events as "Events", avg_ms as "Avg (ms)", max_ms as "Max (ms)", unique_uris as "Unique URIs"`,
    err500: `\`sap_logserv_idx_macro\` ${ST_BOTH} status>=500 | head 200 | eval src_log = if(sourcetype="sap:webdispatcher:access", "WebDisp", "CC") | eval resp_time = if(isnotnull(response_time_ms), tostring(response_time_ms) . " ms", "-") | eval Time=strftime(_time, "%Y-%m-%d %H:%M:%S") | sort -_time | table Time, src_log, host, clientip, method, uri, status, resp_time | rename src_log as "Source", host as "Host", clientip as "Client IP", method as "Method", uri as "URI", status as "Status", resp_time as "Response Time"`,
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
    { key: 'Max (ms)', label: 'Max (ms)', align: 'right' },
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
    { key: 'Max (ms)', label: 'Max (ms)', align: 'right' },
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
                <FramedPanel title="Response Time (Avg / Max) Over Time" subtitle="Average and peak response time per day across both sources">
                    <TimeSeriesChart query={Q.percentiles} height={280} palette="volume" />
                </FramedPanel>
            </PanelGrid2>

            <FullWidthPanel>
                <FramedPanel search={slowUris} title="Slow URIs by Avg Response Time" subtitle="URIs across Web Dispatcher + Cloud Connector ranked by avg response time">
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
                <FramedPanel search={tlsCipher} title="TLS Cipher Suite Distribution" subtitle="Negotiated cipher suites ranked by count">
                    <DataTable columns={TLS_CIPHER_COLS} rows={tlsCipher.results} loading={tlsCipher.loading} error={tlsCipher.error} emptyMessage="No TLS cipher data in this time range." />
                </FramedPanel>
            </PanelGrid2>

            <FullWidthPanel>
                <FramedPanel search={slowClients} title="Slow Clients by Max Response Time" subtitle="Client IPs ranked by max latency">
                    <DataTable columns={SLOW_CLIENT_COLS} rows={slowClients.results} loading={slowClients.loading} error={slowClients.error} emptyMessage="No client timing data in this time range." initialSortKey="Max (ms)" initialSortDir="desc" onRowClick={goSlowClientRow} />
                </FramedPanel>
            </FullWidthPanel>

            <FullWidthPanel>
                <FramedPanel search={err500} title="Recent 500-Level Errors" subtitle="Server errors with source / client / URI, most-recent first">
                    <DataTable columns={ERR500_COLS} rows={err500.results} loading={err500.loading} error={err500.error} emptyMessage="No 500-level errors in this time range." initialSortKey="Time" initialSortDir="desc" onRowClick={goErr500Row} />
                </FramedPanel>
            </FullWidthPanel>
        </DashboardLayout>
    );
};

export default WebApiPerformance;
