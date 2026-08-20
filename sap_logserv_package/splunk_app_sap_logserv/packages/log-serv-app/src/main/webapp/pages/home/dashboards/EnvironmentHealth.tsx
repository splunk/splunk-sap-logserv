import React, { useCallback } from 'react';
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
import {
    buildDashboardUrl,
    buildHostDetailsUrl,
    buildSplunkSearchUrl,
    openInNewTab,
} from '../utils/drilldownUrls';
import { logservTheme } from '../styles/logservTheme';

/**
 * Environment Health — honest port of v0.0.4.2 logserv_environment_health.xml.
 *
 * 7 KPIs + 7 trend charts + 1 line + 1 column + 2 tables = 18 panels.
 * Each KPI computes `total` (sum or avg over the time range) and shows a
 * daily sparkline below. Cross-cutting view across all sourcetypes.
 */

const KpiRow4 = styled.div`
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: ${logservTheme.elevation.panelGap};
    margin-bottom: ${logservTheme.elevation.panelGap};
    @media (max-width: 1100px) { grid-template-columns: repeat(2, minmax(0, 1fr)); }
`;
const KpiRow3 = styled.div`
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: ${logservTheme.elevation.panelGap};
    margin-bottom: ${logservTheme.elevation.panelGap};
    @media (max-width: 1100px) { grid-template-columns: 1fr; }
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
    @media (max-width: 1400px) { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    @media (max-width: 800px) { grid-template-columns: 1fr; }
`;
const FullWidthPanel = styled.div`
    margin-bottom: ${logservTheme.elevation.panelGap};
`;

// Dashboard-perf tier #6 (KV-Store precompute, session 050 cont. / build 209).
// The cross-cutting error panels read the logserv_severity_rollup collection —
// 6 metric sub-types precomputing each panel-group's EXACT error classification
// (the panels count different event sets, so no single "errors" metric is
// byte-exact for all). RAW (unchanged): beaconing (streamstats gap analysis) +
// criticalEvents (event listing). tstats-now (build 200, unchanged): the 3 Data
// Pipeline panels. Read idiom: `| inputlookup ... where metric=X | addinfo |
// where bucket_ts range | <agg>` (respects the global TimeRange picker).
const ROLL = 'logserv_severity_rollup';
const RANGE = '| addinfo | where bucket_ts>=info_min_time AND bucket_ts<info_max_time';
const TOTERR = `| inputlookup ${ROLL} where metric="toterr" ${RANGE}`;
const TREND = `| inputlookup ${ROLL} where metric="trend" ${RANGE}`;
const TOPHOST = `| inputlookup ${ROLL} where metric="tophost" ${RANGE}`;
const WEB = `| inputlookup ${ROLL} where metric="web" ${RANGE}`;
const ICMSTAT = `| inputlookup ${ROLL} where metric="icmstat" ${RANGE}`;
const AUTHFAIL = `| inputlookup ${ROLL} where metric="authfail" ${RANGE}`;
// Beaconing now precomputed DAILY into its own KV collection (logserv_beaconing_rollup) by
// logserv_beaconing_aggregate. The per-event streamstats gap-variance detection is too heavy
// to run raw at scale (scanned 37.6M DNS events / ~3.75 min at 335M). Per-DAY grain (day_ts).
const BEACON = `| inputlookup logserv_beaconing_rollup | addinfo | where day_ts>=info_min_time AND day_ts<info_max_time`;
// One error-trend chart = the trend metric filtered to a category, timechart by
// src. `| fillnull value=0` matches raw `count by src`'s 0-fill on empty bins.
const trendChart = (cat: string): string =>
    `${TREND} | search trend_cat="${cat}" | eval _time=bucket_ts | timechart span=1d sum(count) by trend_src | fillnull value=0`;

const Q_BASE = {
    // KPIs (rollup). HANA Failed Ops + Firewall Drops derive from the toterr
    // metric by sourcetype (their conditions ARE toterr's hana/linux subsets).
    totalErrors: `${TOTERR} | stats sum(count) as count`,
    hanaFailures: `${TOTERR} | search sourcetype="sap:hana:audit" | stats sum(count) as count`,
    authFailures: `${AUTHFAIL} | stats sum(count) as count`,
    firewallDrops: `${TOTERR} | search sourcetype="linux_secure" | stats sum(count) as count`,
    webErrorRate: `${WEB} | stats sum(web_err) as errors, sum(web_total) as total | eval pct = if(total>0, round(errors/total*100, 1), 0) | table pct`,
    // beaconing now reads the precomputed daily rollup (logserv_beaconing_rollup).
    beaconing: `${BEACON} | rename day_ts as _time | sort _time | eventstats sum(count) as total`,
    // pipeline KPI stays tstats-now (build 200) — pure tsidx count, already fast.
    pipelineEventsPerDay: `| tstats count WHERE \`sap_logserv_idx_macro\` BY _time span=1d | timechart span=1d sum(count) as daily | stats avg(daily) as total | eval total=round(total, 0)`,

    // KPI sparklines (rollup)
    sparkTotalErrors: `${TOTERR} | eval _time=bucket_ts | timechart span=1d sum(count) as count | fillnull value=0`,
    sparkHanaFailures: `${TOTERR} | search sourcetype="sap:hana:audit" | eval _time=bucket_ts | timechart span=1d sum(count) as count | fillnull value=0`,
    sparkAuthFailures: `${AUTHFAIL} | eval _time=bucket_ts | timechart span=1d sum(count) as count | fillnull value=0`,
    sparkFirewallDrops: `${TOTERR} | search sourcetype="linux_secure" | eval _time=bucket_ts | timechart span=1d sum(count) as count | fillnull value=0`,
    sparkWebErrorRate: `${WEB} | eval _time=bucket_ts | timechart span=1d sum(web_err) as errors_daily, sum(web_total) as total_daily | eval pct = if(total_daily>0, round(errors_daily/total_daily*100, 1), 0) | fields _time pct`,
    // pipeline spark stays tstats-now (build 200)
    sparkPipelineEvents: `| tstats count WHERE \`sap_logserv_idx_macro\` BY _time span=1d | timechart span=1d sum(count) as count`,

    // 6 error-trend charts (rollup, metric="trend")
    errAbap: trendChart('ABAP'),
    errHana: trendChart('HANA'),
    errSecurity: trendChart('Security'),
    errWebnet: trendChart('Web-Network'),
    errOsinfra: trendChart('OS-Infra'),
    errScc: trendChart('Cloud-Connector'),

    // Other charts (rollup). webResponseTime avg = Σrt_sum/Σrt_cnt per day
    // (reproduces raw avg(response_time_ms); ~1e-13 float diff is invisible).
    webResponseTime: `${WEB} | eval _time=bucket_ts | timechart span=1d sum(web_rt_sum) as rt_sum, sum(web_rt_cnt) as rt_cnt | eval "Avg Response Time (ms)"=rt_sum/rt_cnt | fields _time, "Avg Response Time (ms)"`,
    icmStatus: `${ICMSTAT} | eval _time=bucket_ts | timechart span=1d sum(count) by status_cat | fillnull value=0`,
    // pipeline trend stays tstats-now (build 200)
    pipelineTrend: `| tstats count WHERE \`sap_logserv_idx_macro\` BY _time span=1d | timechart span=1d sum(count) as "Events/Day"`,

    // Tables. criticalEvents stays RAW (event listing — needs the actual events) but is
    // | head 200-capped: Splunk's default newest-first event scan short-circuits after 200,
    // so it reads only the most-recent buckets instead of scanning the full 30d (16.4M events
    // / ~2-3 min at 335M). A "most-recent-first" table never needs more than the latest N.
    criticalEvents: `\`sap_logserv_idx_macro\` ((sourcetype="sap:hana:audit" status!="SUCCESSFUL") OR (sourcetype="sap:abap:dispatcher" (dp_severity="ERROR" OR dp_severity="FATAL")) OR (sourcetype="sap:hana:tracelogs" hana_trace_severity="fatal") OR (sourcetype="sap:sapstartsrv" is_auth_event="true" auth_result="failure") OR (sourcetype="XmlWinEventLog" severity="critical")) | head 200 | eval Category=case(sourcetype="sap:hana:audit", "HANA Audit", sourcetype="sap:abap:dispatcher", "ABAP Dispatcher", sourcetype="sap:hana:tracelogs", "HANA Trace", sourcetype="sap:sapstartsrv", "Auth Failure", sourcetype="XmlWinEventLog", "Windows Critical", 1=1, sourcetype) | eval Detail=case(sourcetype="sap:hana:audit", status." - ".action_type." by ".executing_user, sourcetype="sap:abap:dispatcher", dp_severity." - ".coalesce(dp_message, _raw), sourcetype="sap:hana:tracelogs", hana_trace_severity." - ".hana_trace_component, sourcetype="sap:sapstartsrv", "Auth failure for ".coalesce(auth_user, "unknown"), sourcetype="XmlWinEventLog", coalesce(source, "WinEvent")." EventCode=".coalesce(EventCode, "N/A"), 1=1, "") | eval Time=strftime(_time, "%Y-%m-%d %H:%M:%S") | table Time host Category sourcetype Detail | sort -Time`,
    // Affected Hosts matrix (rollup, metric="tophost"). chart over host by
    // error_cat reproduces the raw `chart count by host error_cat | addtotals`.
    topHosts: `${TOPHOST} | chart sum(count) over host by error_cat | fillnull value=0 | addtotals | sort -Total`,
};

/* ---------------------------------------------------------------------------
 * RAW fallbacks for the sub-hour hybrid (session 085).
 *
 * The rollup reads above answer wide 7d/30d/90d ranges fast but are wrong on a
 * sub-hour window (the hourly `bucket_ts` grain reads empty / ~4x-overcounts —
 * see utils/hybridRouting.ts). `useHybridSearch` / `useRoutedQuery` route short
 * ranges to these RAW equivalents instead. Each raw query is the pre-refactor
 * scan (byte-verified equal to its rollup at wide windows) and MUST return the
 * same output columns as its cached counterpart. Not hybridised (left cached):
 * `beaconing` (daily gap-variance detection — no meaningful sub-hour answer, and
 * its raw is a heavy 37.6M-event streamstats) and the `span=1d` sparklines
 * (cosmetic — a daily sparkline is meaningless on a sub-hour window either way).
 * `criticalEvents` + the pipeline tstats panels are already correct at any range.
 * ------------------------------------------------------------------------- */

// Shared raw error-classification base for the 6 error-trend charts — mirrors
// the logserv_severity_aggregate `trend` arm. trendChartRaw() appends the
// per-category filter + daily timechart (matching trendChart() above).
const TREND_RAW_BASE =
    '`sap_logserv_idx_macro` ((sourcetype="sap:abap:dispatcher" (dp_severity="ERROR" OR dp_severity="FATAL")) OR ' +
    '(sourcetype="sap:abap:icm" icm_is_error="true") OR (sourcetype="sap:abap:gateway" gw_error_detail=* gw_error_detail!="") OR ' +
    '(sourcetype="sap:hana:audit" status!="SUCCESSFUL") OR (sourcetype="sap:hana:tracelogs" (hana_trace_severity="error" OR hana_trace_severity="fatal")) OR ' +
    '(sourcetype="sap:sapstartsrv" is_auth_event="true" auth_result="failure") OR (sourcetype="linux_secure" IN_DROP) OR ' +
    '(sourcetype="sap:webdispatcher:access" status>=400) OR (sourcetype="sap:saprouter" is_error="true") OR ' +
    '(sourcetype="squid:access" action="denied") OR (sourcetype="XmlWinEventLog" (severity="high" OR severity="medium")) OR ' +
    '(sourcetype="sap:scc:http_access" status>=400)) ' +
    '| eval trend_cat=case(sourcetype IN ("sap:abap:dispatcher","sap:abap:icm","sap:abap:gateway"), "ABAP", ' +
    'sourcetype IN ("sap:hana:audit","sap:hana:tracelogs"), "HANA", sourcetype IN ("sap:sapstartsrv","linux_secure"), "Security", ' +
    'sourcetype IN ("sap:webdispatcher:access","sap:saprouter","squid:access"), "Web-Network", sourcetype="XmlWinEventLog", "OS-Infra", ' +
    'sourcetype="sap:scc:http_access", "Cloud-Connector") ' +
    '| eval trend_src=case(sourcetype="sap:abap:dispatcher", "Dispatcher", sourcetype="sap:abap:icm", "ICM", ' +
    'sourcetype="sap:abap:gateway", "Gateway", sourcetype="sap:hana:audit", "Audit Failures", sourcetype="sap:hana:tracelogs", "Trace Errors", ' +
    'sourcetype="sap:sapstartsrv", "Auth Failures", sourcetype="linux_secure", "Firewall Drops", sourcetype="sap:webdispatcher:access", "WebDisp 4xx/5xx", ' +
    'sourcetype="sap:saprouter", "Router Errors", sourcetype="squid:access", "Proxy Denied", sourcetype="XmlWinEventLog" AND severity="high", "Windows High", ' +
    'sourcetype="XmlWinEventLog" AND severity="medium", "Windows Medium", sourcetype="sap:scc:http_access" AND status>=500, "5xx Server", ' +
    'sourcetype="sap:scc:http_access" AND status>=400, "4xx Client")';
const trendChartRaw = (cat: string): string =>
    `${TREND_RAW_BASE} | search trend_cat="${cat}" | timechart span=1d count by trend_src | fillnull value=0`;

const QRAW_BASE = {
    totalErrors:
        '`sap_logserv_idx_macro` ((sourcetype="sap:abap:dispatcher" (dp_severity="ERROR" OR dp_severity="FATAL")) OR ' +
        '(sourcetype="sap:abap:icm" icm_is_error="true") OR (sourcetype="sap:abap:gateway" gw_error_detail=* gw_error_detail!="") OR ' +
        '(sourcetype="sap:hana:audit" status!="SUCCESSFUL") OR (sourcetype="sap:hana:tracelogs" hana_trace_severity IN ("error", "fatal")) OR ' +
        '(sourcetype="sap:sapstartsrv" is_auth_event="true" auth_result="failure") OR (sourcetype="sap:scc:audit" scc_audit_type="ACCESS_DENIED") OR ' +
        '(sourcetype="linux_secure" IN_DROP) OR (sourcetype="XmlWinEventLog" severity IN ("critical","error","high")) OR ' +
        '(sourcetype="sap:webdispatcher:access" status>=400) OR (sourcetype="squid:access" action="denied")) | stats count',
    hanaFailures: '`sap_logserv_idx_macro` sourcetype="sap:hana:audit" status!="SUCCESSFUL" | stats count',
    authFailures:
        '`sap_logserv_idx_macro` ((sourcetype="sap:sapstartsrv" is_auth_event="true" auth_result="failure") OR ' +
        '(sourcetype="sap:hana:audit" action_type="CONNECT" status!="SUCCESSFUL")) | stats count',
    firewallDrops: '`sap_logserv_idx_macro` sourcetype="linux_secure" IN_DROP | stats count',
    webErrorRate:
        '`sap_logserv_idx_macro` sourcetype="sap:webdispatcher:access" | eval is_err=if(tonumber(status)>=400,1,0) ' +
        '| stats sum(is_err) as errors, count as total | eval pct=if(total>0,round(errors/total*100,1),0) | table pct',

    errAbap: trendChartRaw('ABAP'),
    errHana: trendChartRaw('HANA'),
    errSecurity: trendChartRaw('Security'),
    errWebnet: trendChartRaw('Web-Network'),
    errOsinfra: trendChartRaw('OS-Infra'),
    errScc: trendChartRaw('Cloud-Connector'),

    // rename the timechart output to the cached read's display column name.
    webResponseTime:
        '`sap_logserv_idx_macro` sourcetype="sap:webdispatcher:access" | eval response_time_ms=tonumber(total_us)/1000 ' +
        '| timechart span=1d avg(response_time_ms) as "Avg Response Time (ms)"',
    icmStatus:
        '`sap_logserv_idx_macro` sourcetype="sap:abap:icm" icm_status_code=* ' +
        '| eval status_cat=case(icm_status_code>=200 AND icm_status_code<300, "2xx", icm_status_code>=300 AND icm_status_code<400, "3xx", ' +
        'icm_status_code>=400 AND icm_status_code<500, "4xx", icm_status_code>=500, "5xx", 1=1, "Other") ' +
        '| timechart span=1d count by status_cat | fillnull value=0',
    // reconstructed from the logserv_severity_aggregate `tophost` arm.
    topHosts:
        '`sap_logserv_idx_macro` ((sourcetype="sap:abap:dispatcher" (dp_severity="ERROR" OR dp_severity="FATAL")) OR ' +
        '(sourcetype="sap:abap:icm" icm_is_error="true") OR (sourcetype="sap:abap:gateway" gw_error_detail=* gw_error_detail!="") OR ' +
        '(sourcetype="sap:hana:audit" status!="SUCCESSFUL") OR (sourcetype="sap:hana:tracelogs" (hana_trace_severity="error" OR hana_trace_severity="fatal")) OR ' +
        '(sourcetype="sap:scc:http_access" is_error="true") OR (sourcetype="sap:sapstartsrv" is_auth_event="true" auth_result="failure") OR ' +
        '(sourcetype="sap:saprouter" is_error="true") OR (sourcetype="squid:access" action="denied") OR (sourcetype="sap:webdispatcher:access") OR ' +
        '(sourcetype="XmlWinEventLog") OR (sourcetype="linux_secure")) ' +
        '| eval is_err=case(sourcetype="sap:webdispatcher:access", if(tonumber(status)>=400, 1, 0), sourcetype="XmlWinEventLog", if(severity IN ("high", "medium"), 1, 0), ' +
        'sourcetype="linux_secure", if(match(_raw, "IN_DROP"), 1, 0), 1=1, 1) | where is_err=1 ' +
        '| eval error_cat=case(sourcetype IN ("sap:abap:dispatcher","sap:abap:icm","sap:abap:gateway"), "ABAP", sourcetype IN ("sap:hana:audit","sap:hana:tracelogs"), "HANA", ' +
        'sourcetype IN ("sap:sapstartsrv","sap:saprouter"), "Services", sourcetype IN ("linux_secure"), "Firewall", 1=1, "Other") ' +
        '| chart count over host by error_cat | fillnull value=0 | addtotals | sort -Total',
};

/** SPL dispatched when the user clicks the "Total Errors" KPI. Cross-cutting
 *  view of errors across all 11 sourcetypes the KPI counts, broken down by
 *  Category + sourcetype with affected-host count + last-seen timestamp.
 *  Ported from v0.0.4.2 logserv_environment_health.xml's
 *  viz_kpi_total_errors drilldown URL. The Splunk Search app is the only
 *  destination broad enough to host this — no single React dashboard owns
 *  the cross-cutting view. Build 157 / session 027 task 4. */
const TOTAL_ERRORS_DRILLDOWN_SPL =
    '`sap_logserv_idx_macro` ((sourcetype="sap:abap:dispatcher" (dp_severity="ERROR" OR dp_severity="FATAL")) OR ' +
    '(sourcetype="sap:abap:icm" icm_is_error="true") OR ' +
    '(sourcetype="sap:abap:gateway" gw_error_detail=* gw_error_detail!="") OR ' +
    '(sourcetype="sap:hana:audit" status!="SUCCESSFUL") OR ' +
    '(sourcetype="sap:hana:tracelogs" hana_trace_severity IN ("error", "fatal")) OR ' +
    '(sourcetype="sap:sapstartsrv" is_auth_event="true" auth_result="failure") OR ' +
    '(sourcetype="sap:scc:audit" scc_audit_type="ACCESS_DENIED") OR ' +
    '(sourcetype="linux_secure" IN_DROP) OR ' +
    '(sourcetype="XmlWinEventLog" severity IN ("critical","error","high")) OR ' +
    '(sourcetype="sap:webdispatcher:access" status>=400) OR ' +
    '(sourcetype="squid:access" action="denied")) ' +
    '| eval Category=case(match(sourcetype,"sap:abap"),"ABAP",match(sourcetype,"sap:hana"),"HANA",' +
    'sourcetype IN ("sap:sapstartsrv","sap:scc:audit","linux_secure"),"Security",' +
    'sourcetype IN ("sap:webdispatcher:access","squid:access"),"Web/Network",' +
    'sourcetype="XmlWinEventLog","OS/Infra",1=1,"Other") ' +
    '| stats count as Errors dc(host) as "Affected Hosts" latest(_time) as lt by Category sourcetype ' +
    '| eval "Last Seen"=strftime(lt,"%Y-%m-%d %H:%M") | fields - lt | sort -Errors';

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
/** useFirstRowField over a hybrid cached/raw pair (session 085) — routes
 *  sub-hour ranges to the raw query, wide ranges to the rollup. */
const useFirstRowFieldHybrid = (cached: string, raw: string, f: string): FirstRow => {
    const search = useHybridSearch({ cached, raw });
    const { results, loading, error } = search;
    const value = results && results[0] ? (results[0] as Record<string, unknown>)[f] : undefined;
    return { value, loading, error, search };
};

const formatPercent = (raw: unknown): string => {
    if (raw === null || typeof raw === 'undefined') return '—';
    const n = typeof raw === 'number' ? raw : parseFloat(String(raw));
    if (Number.isNaN(n)) return String(raw);
    return `${n.toFixed(1)}%`;
};

const CRITICAL_EVENT_COLS: ColumnDef[] = [
    { key: 'Time', label: 'Time', width: '160px' },
    { key: 'host', label: 'Host', width: '180px' },
    { key: 'Category', label: 'Category', width: '160px' },
    { key: 'sourcetype', label: 'Sourcetype', width: '200px' },
    { key: 'Detail', label: 'Detail' },
];

const TOP_HOSTS_COLS: ColumnDef[] = [
    { key: 'host', label: 'Host' },
    { key: 'ABAP', label: 'ABAP', align: 'right', render: (v) => formatInteger(v) },
    { key: 'HANA', label: 'HANA', align: 'right', render: (v) => formatInteger(v) },
    { key: 'Services', label: 'Services', align: 'right', render: (v) => formatInteger(v) },
    { key: 'Firewall', label: 'Firewall', align: 'right', render: (v) => formatInteger(v) },
    { key: 'Other', label: 'Other', align: 'right', render: (v) => formatInteger(v) },
    { key: 'Total', label: 'Total', align: 'right', render: (v) => formatInteger(v) },
];

const EnvironmentHealth: React.FC = () => {
    const { provider } = useCloudProvider();
    const Q = React.useMemo(() => mapCloudProviderQueries(Q_BASE, provider), [provider]);
    // RAW fallbacks for the sub-hour hybrid (session 085); same cloud-provider
    // mapping so both arms filter identically.
    const QRAW = React.useMemo(() => mapCloudProviderQueries(QRAW_BASE, provider), [provider]);
    const totalErrors = useFirstRowFieldHybrid(Q.totalErrors, QRAW.totalErrors, 'count');
    const hanaFailures = useFirstRowFieldHybrid(Q.hanaFailures, QRAW.hanaFailures, 'count');
    const authFailures = useFirstRowFieldHybrid(Q.authFailures, QRAW.authFailures, 'count');
    const firewallDrops = useFirstRowFieldHybrid(Q.firewallDrops, QRAW.firewallDrops, 'count');
    const webErrorRate = useFirstRowFieldHybrid(Q.webErrorRate, QRAW.webErrorRate, 'pct');
    const beaconing = useFirstRowField(Q.beaconing, 'total');
    const pipelineEvents = useFirstRowField(Q.pipelineEventsPerDay, 'total');

    // Chart panels take a query STRING, so route once here (sub-hour -> raw).
    const qErrAbap = useRoutedQuery(Q.errAbap, QRAW.errAbap);
    const qErrHana = useRoutedQuery(Q.errHana, QRAW.errHana);
    const qErrSecurity = useRoutedQuery(Q.errSecurity, QRAW.errSecurity);
    const qErrWebnet = useRoutedQuery(Q.errWebnet, QRAW.errWebnet);
    const qErrOsinfra = useRoutedQuery(Q.errOsinfra, QRAW.errOsinfra);
    const qErrScc = useRoutedQuery(Q.errScc, QRAW.errScc);
    const qWebResponseTime = useRoutedQuery(Q.webResponseTime, QRAW.webResponseTime);
    const qIcmStatus = useRoutedQuery(Q.icmStatus, QRAW.icmStatus);

    const criticalEvents = useSearch({ query: Q.criticalEvents });
    const topHosts = useHybridSearch({ cached: Q.topHosts, raw: QRAW.topHosts });

    const errorsTone = (Number(totalErrors.value ?? 0) > 100) ? 'critical' : (Number(totalErrors.value ?? 0) > 0) ? 'warning' : 'neutral';
    const fwTone = (Number(firewallDrops.value ?? 0) > 1000) ? 'critical' : (Number(firewallDrops.value ?? 0) > 0) ? 'warning' : 'neutral';
    const errRateNum = parseFloat(String(webErrorRate.value ?? 0));
    const errRateTone = errRateNum >= 5 ? 'critical' : errRateNum >= 1 ? 'warning' : 'neutral';

    /* Drilldowns (build 157 / session 027 task 4): every KPI, chart, and
     * table row opens a related dashboard (or Splunk Search app for Total
     * Errors) in a NEW BROWSER TAB with the current TimeRange embedded as
     * `?earliest=…&latest=…` URL params. The destination dashboard's
     * TimeRangeProvider hydrates from those params on first mount, so the
     * source dashboard's selected window is preserved across the navigation.
     * Mapping ported from v0.0.4.2 logserv_environment_health.xml. */
    const { timeRange } = useTimeRange();
    const goTo = useCallback(
        (slug: string) => () => openInNewTab(buildDashboardUrl(slug, timeRange.earliest, timeRange.latest)),
        [timeRange.earliest, timeRange.latest],
    );
    const goToTotalErrorsSearch = useCallback(
        () => openInNewTab(buildSplunkSearchUrl(TOTAL_ERRORS_DRILLDOWN_SPL, timeRange.earliest, timeRange.latest)),
        [timeRange.earliest, timeRange.latest],
    );
    const goToHostDetails = useCallback(
        (row: Record<string, unknown>) => {
            const host = String(row.host ?? '');
            if (!host) return;
            openInNewTab(buildHostDetailsUrl(host, timeRange.earliest, timeRange.latest));
        },
        [timeRange.earliest, timeRange.latest],
    );

    return (
        <DashboardLayout
            category="HOME"
            title="Environment Health"
            subtitle="Cross-cutting operational view — KPIs, error trends by category, critical events, and host health matrix"
        >
            <KpiRow4>
                <KpiCard label="Total Errors" value={totalErrors.value} loading={totalErrors.loading} error={totalErrors.error} search={totalErrors.search} formatValue={formatInteger} tone={errorsTone}
                    sparkline={<SparklineFromQuery query={Q.sparkTotalErrors} valueField="count" color={logservTheme.colors.red} fill />}
                    onClick={goToTotalErrorsSearch}
                    clickTitle="Open the cross-cutting error breakdown in Splunk Search (new tab)" />
                <KpiCard label="HANA Failed Ops" value={hanaFailures.value} loading={hanaFailures.loading} error={hanaFailures.error} search={hanaFailures.search} formatValue={formatInteger} tone={Number(hanaFailures.value ?? 0) > 0 ? 'critical' : 'neutral'}
                    sparkline={<SparklineFromQuery query={Q.sparkHanaFailures} valueField="count" color={logservTheme.colors.red} fill />}
                    onClick={goTo('hana-audit')}
                    clickTitle="Open HANA Audit dashboard (new tab)" />
                <KpiCard label="Auth Failures" value={authFailures.value} loading={authFailures.loading} error={authFailures.error} search={authFailures.search} formatValue={formatInteger} tone={Number(authFailures.value ?? 0) > 0 ? 'warning' : 'neutral'}
                    sparkline={<SparklineFromQuery query={Q.sparkAuthFailures} valueField="count" color={logservTheme.colors.red} fill />}
                    onClick={goTo('sap-services')}
                    clickTitle="Open SAP Services dashboard (new tab)" />
                <KpiCard label="Firewall Drops" value={firewallDrops.value} loading={firewallDrops.loading} error={firewallDrops.error} search={firewallDrops.search} formatValue={formatInteger} tone={fwTone}
                    sparkline={<SparklineFromQuery query={Q.sparkFirewallDrops} valueField="count" color={logservTheme.colors.red} fill />}
                    onClick={goTo('linux')}
                    clickTitle="Open Linux dashboard (new tab)" />
            </KpiRow4>

            <KpiRow3>
                <KpiCard label="Web Error Rate" value={webErrorRate.value} loading={webErrorRate.loading} error={webErrorRate.error} search={webErrorRate.search} formatValue={formatPercent} tone={errRateTone}
                    sparkline={<SparklineFromQuery query={Q.sparkWebErrorRate} valueField="pct" color={logservTheme.colors.red} fill />}
                    onClick={goTo('web-dispatcher')}
                    clickTitle="Open Web Dispatcher dashboard (new tab)" />
                <KpiCard label="Beaconing Domains" value={beaconing.value} loading={beaconing.loading} error={beaconing.error} search={beaconing.search} formatValue={formatInteger}
                    sparkline={<SparklineFromQuery query={Q.beaconing} valueField="count" color={logservTheme.colors.purple} fill />}
                    onClick={goTo('dns-analytics')}
                    clickTitle="Open DNS Analytics dashboard (new tab)" />
                <KpiCard label="Data Pipeline — Events/Day (Avg)" value={pipelineEvents.value} loading={pipelineEvents.loading} error={pipelineEvents.error} search={pipelineEvents.search} formatValue={formatInteger}
                    sparkline={<SparklineFromQuery query={Q.sparkPipelineEvents} valueField="count" fill />}
                    onClick={goTo('data-pipeline-overview')}
                    clickTitle="Open Data Pipeline Overview dashboard (new tab)" />
            </KpiRow3>

            <FullWidthPanel>
                <FramedPanel title="Daily Event Volume Trend" subtitle="Total events per day across all sourcetypes"
                    onClick={goTo('data-pipeline-overview')}
                    clickTitle="Open Data Pipeline Overview dashboard (new tab)">
                    <TimeSeriesChart query={Q.pipelineTrend} height={260} palette="volume" />
                </FramedPanel>
            </FullWidthPanel>

            <PanelGrid3>
                <FramedPanel title="ABAP Error Trend" subtitle="Dispatcher / ICM / Gateway errors"
                    onClick={goTo('abap-security')}
                    clickTitle="Open ABAP Security dashboard (new tab)">
                    <TimeSeriesChart query={qErrAbap} height={240} palette="errors" />
                </FramedPanel>
                <FramedPanel title="HANA Error Trend" subtitle="Audit failures + trace errors"
                    onClick={goTo('hana-audit')}
                    clickTitle="Open HANA Audit dashboard (new tab)">
                    <TimeSeriesChart query={qErrHana} height={240} palette="errors-2" />
                </FramedPanel>
                <FramedPanel title="Security Error Trend" subtitle="Auth failures + firewall drops"
                    onClick={goTo('sap-services')}
                    clickTitle="Open SAP Services dashboard (new tab)">
                    <TimeSeriesChart query={qErrSecurity} height={240} palette="errors-3" />
                </FramedPanel>
            </PanelGrid3>

            <PanelGrid3>
                <FramedPanel title="Web/Network Error Trend" subtitle="Web Disp 4xx/5xx + Router errors + Proxy denied"
                    onClick={goTo('web-dispatcher')}
                    clickTitle="Open Web Dispatcher dashboard (new tab)">
                    <TimeSeriesChart query={qErrWebnet} height={240} palette="errors" />
                </FramedPanel>
                <FramedPanel title="OS/Infra Error Trend" subtitle="Windows high/medium severity events"
                    onClick={goTo('windows')}
                    clickTitle="Open Windows dashboard (new tab)">
                    <TimeSeriesChart query={qErrOsinfra} height={240} palette="errors-2" />
                </FramedPanel>
                <FramedPanel title="Cloud Connector Error Trend" subtitle="SCC HTTP 4xx/5xx"
                    onClick={goTo('cloud-connector')}
                    clickTitle="Open Cloud Connector dashboard (new tab)">
                    <TimeSeriesChart query={qErrScc} height={240} palette="errors-3" />
                </FramedPanel>
            </PanelGrid3>

            <PanelGrid2>
                <FramedPanel title="Web Dispatcher Response Time" subtitle="Daily average response time (ms)"
                    onClick={goTo('web-dispatcher')}
                    clickTitle="Open Web Dispatcher dashboard (new tab)">
                    <TimeSeriesChart query={qWebResponseTime} height={240} palette="volume" />
                </FramedPanel>
                <FramedPanel title="ICM Status Codes" subtitle="ABAP ICM status-class breakdown over time"
                    onClick={goTo('abap-security')}
                    clickTitle="Open ABAP Security dashboard (new tab)">
                    <TimeSeriesChart query={qIcmStatus} height={240} palette="status" />
                </FramedPanel>
            </PanelGrid2>

            <FullWidthPanel>
                <FramedPanel search={criticalEvents} title="Recent Critical Events" subtitle="Critical signals across HANA / ABAP / Auth / Windows, most-recent first">
                    <DataTable
                        columns={CRITICAL_EVENT_COLS}
                        rows={criticalEvents.results}
                        loading={criticalEvents.loading}
                        error={criticalEvents.error}
                        emptyMessage="No critical events in this time range."
                        onRowClick={goToHostDetails}
                    />
                </FramedPanel>
            </FullWidthPanel>

            <FullWidthPanel>
                <FramedPanel search={topHosts} title="Affected Hosts" subtitle="Hosts ranked by error count, broken down by category">
                    <DataTable
                        columns={TOP_HOSTS_COLS}
                        rows={topHosts.results}
                        loading={topHosts.loading}
                        error={topHosts.error}
                        emptyMessage="No errors found in this time range."
                        onRowClick={goToHostDetails}
                    />
                </FramedPanel>
            </FullWidthPanel>
        </DashboardLayout>
    );
};

export default EnvironmentHealth;
