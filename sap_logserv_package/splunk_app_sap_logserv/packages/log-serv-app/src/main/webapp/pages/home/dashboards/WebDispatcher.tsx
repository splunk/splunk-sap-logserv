import React, { useCallback, useMemo, useState } from 'react';
import styled from 'styled-components';
import Select from '@splunk/react-ui/Select';
import KpiCard, { formatInteger } from '../components/KpiCard';
import FramedPanel from '../components/FramedPanel';
import DataTable, { ColumnDef } from '../components/DataTable';
import TimeSeriesChart from '../components/TimeSeriesChart';
import PieChart from '../components/PieChart';
import TraceWaterfall, { TraceRow } from '../components/TraceWaterfall';
import { SparklineFromQuery } from '../components/Sparkline';
import DashboardLayout from '../components/DashboardLayout';
import { useSearch } from '../hooks/useSearch';
import { useHybridSearch, useRoutedQuery } from '../hooks/useHybridSearch';
import { shouldUseRawSource } from '../utils/hybridRouting';
import { recordRawTwin } from '../utils/rawTwin';
import { useCloudProvider, mapCloudProviderQueries, withCloudProvider } from '../state/CloudProviderProvider';
import { useTimeRange } from '../state/TimeRangeProvider';
import { chooseTimechartSpan } from '../utils/timechartSpan';
import { buildSplunkSearchUrl, openInNewTab, splQuote } from '../utils/drilldownUrls';
import { logservTheme } from '../styles/logservTheme';
import { useThemeMode } from '../state/ThemeModeProvider';

/**
 * Web Dispatcher Access — honest port of v0.0.4.2 logserv_web_dispatcher.xml
 * + the v0.0.5.0 redesigned widget (TraceWaterfall) and the per-panel filter
 * (P3 demo on Top URIs).
 *
 * Performance tiering (session 049 CIM; rebuilt build 232 → KV-Store rollup):
 *   - Pure-count panels (Total Requests / Request Volume / sparkline) → tstats-now.
 *   - Everything else reads the shared `logserv_web_timing_rollup` collection via
 *     webdispatcher-scoped wd_* metrics (build 232) — the CIM Web tier was slow
 *     when the customer hadn't accelerated the model (summariesonly=false fell back
 *     to a RAW full-scan). The percentile Response Time Trend is now Avg+Max
 *     (Σsum_rt/Σcnt_rt + max_rt) — p50/p95/p99 don't merge across buckets.
 *   - wd_core (per-bucket: count/err_count/sum_rt/cnt_rt/max_rt) → Error Rate +
 *     Avg Response + Response Time Trend. wd_status (status_group, chart buckets) →
 *     Traffic by Status. wd_method (method) → Traffic by Method. wd_uristat
 *     (uri,status_group filter-buckets) → Slowest Pages + Top URIs. wd_client
 *     (clientip,uri) → Client IPs by Traffic.
 *   - recentErrors + slowestTraces stay RAW (per-event listings; total_us/dt1-4 are
 *     individual extreme-event detail that can't roll up). response_time_ms is
 *     computed fresh as tonumber(total_us)/1000 (matches the prior RAW panels).
 * NOTE: Top URIs dropped its "Unique Clients" (dc(clientip)) column — a (uri,
 * status_group,clientip) grain would explode at scale; the 2-dim grain is bounded.
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
    @media (max-width: 1400px) { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    @media (max-width: 800px) { grid-template-columns: 1fr; }
`;

const ST = 'sourcetype=sap:webdispatcher:access';

// --- Acceleration tiers (session 049 — CIM data-model acceleration) ----------
// Mirror of Proxy.tsx; see that file's header for the full data-model contract.
// Pure-count panels read default-indexed dims via tstats-now (macro re-pins the
// customer's index, honoring con1/jaclyn local/macros.conf overrides).
const TS_WHERE = `WHERE \`sap_logserv_idx_macro\` ${ST}`;
// KV-Store rollup reads (build 232) — webdispatcher-scoped wd_* metrics on the
// shared logserv_web_timing_rollup. Read idiom: inputlookup metric=X | bucket_ts
// range | <agg>. Avg = Σsum_rt/Σcnt_rt; Max = max(max_rt). response_time_ms was
// computed at aggregate time as tonumber(total_us)/1000 (matches the RAW panels).
const ROLL = 'logserv_web_timing_rollup';
const RANGE = '| addinfo | where bucket_ts>=info_min_time AND bucket_ts<info_max_time';
const WD_CORE = `| inputlookup ${ROLL} where metric="wd_core" ${RANGE}`;
const WD_STATUS = `| inputlookup ${ROLL} where metric="wd_status" ${RANGE}`;
const WD_METHOD = `| inputlookup ${ROLL} where metric="wd_method" ${RANGE}`;
const WD_URISTAT = `| inputlookup ${ROLL} where metric="wd_uristat" ${RANGE}`;
const WD_CLIENT = `| inputlookup ${ROLL} where metric="wd_client" ${RANGE}`;

const Q_BASE = {
    // --- tstats-now (pure counts on default-indexed fields) ------------------
    kpiRequests: `| tstats count ${TS_WHERE}`,
    sparkRequests: `| tstats count ${TS_WHERE} BY _time span=1d | timechart span=1d sum(count) AS count`,
    requestVolumeOverTime: `| tstats count ${TS_WHERE} BY _time span=1d | timechart span=1d sum(count) AS Requests`,

    // --- KV-Store rollup: wd_core (error rate + avg response) ----------------
    kpiErrorRate: `${WD_CORE} | stats sum(err_count) as errors, sum(count) as total | eval pct = if(total>0, round(errors/total*100, 1), 0) | table pct`,
    sparkErrorRate: `${WD_CORE} | eval _time=bucket_ts | timechart span=1d sum(err_count) as ed, sum(count) as td | eval daily = if(td>0, round(ed/td*100, 1), 0) | fields _time daily`,
    kpiAvgResponse: `${WD_CORE} | stats sum(sum_rt) as s, sum(cnt_rt) as c | eval avg_ms = if(c>0, round(s/c, 1), 0) | table avg_ms`,
    sparkAvgResponse: `${WD_CORE} | eval _time=bucket_ts | timechart span=1d sum(sum_rt) as s, sum(cnt_rt) as c | eval daily = round(s/c, 1) | fields _time daily`,

    // --- KV-Store rollup: wd_method / wd_uristat / wd_client -----------------
    trafficByMethod: `${WD_METHOD} | search method!="(none)" | stats sum(count) as count by method | sort -count`,
    slowestPages: `${WD_URISTAT} | search uri!="(none)" | stats sum(count) as requests, sum(sum_rt) as s, sum(cnt_rt) as c by uri | eval avg_response = round(if(c>0, s/c, 0), 1) | sort -avg_response | table uri, avg_response, requests`,
    topClients: `${WD_CLIENT} | search clientip!="(none)" | stats sum(count) as requests, dc(eval(if(uri="(none)",null(),uri))) as unique_pages, sum(sum_rt) as s, sum(cnt_rt) as c by clientip | eval avg_response_ms = round(if(c>0, s/c, 0), 1) | sort -requests | table clientip, requests, unique_pages, avg_response_ms`,

    // --- recentErrors stays RAW (recent-N event listing, head-200 bounded) ---
    recentErrors: `\`sap_logserv_idx_macro\` ${ST} status>=400 | head 200 | eval response_time_ms=round(tonumber(total_us)/1000, 1) | table _time clientip method uri status response_time_ms | sort -_time`,
    // Build 236: slowestTraces reads the per-hour top-20 rollup instead of a raw
    // `| sort 20 - total_us` full-scan of webdispatcher. Byte-exact — the global
    // 20 slowest over the range are each within their own hour's top-20, so
    // re-sorting the union of per-hour top-20s + head 20 = the global top-20.
    slowestTraces: `| inputlookup logserv_webdisp_slowtrace_rollup | addinfo | where bucket_ts>=info_min_time AND bucket_ts<info_max_time | sort 20 - total_us | eval _time=event_time | table _time, uri, status, method, dt1_us, dt2_us, dt3_us, dt4_us, total_us`,
};

/* ---------------------------------------------------------------------------
 * RAW fallbacks for the sub-hour hybrid (session 086). Each is the raw
 * sap:webdispatcher:access scan its rollup metric precomputes, reconciled to
 * the cached read's exact output columns (byte-verified equal at wide windows —
 * the _v2_wd_*_{r,x} staged pairs). Only ROLLUP reads are hybridised;
 * kpiRequests/requestVolume (tstats) are correct at any range, recentErrors is
 * already raw, and the sparklines stay cached (cosmetic). response_time_ms =
 * tonumber(total_us)/1000 (the aggregate-time definition of sum_rt/cnt_rt). The
 * two span-parametrised charts + topUris route inline (they build SPL in a
 * useMemo / from filter state, so can't call the useRoutedQuery hook).
 * ------------------------------------------------------------------------- */
const WRAW = '`sap_logserv_idx_macro` sourcetype=sap:webdispatcher:access';
const QRAW_BASE = {
    kpiErrorRate: `${WRAW} | stats count as total, sum(eval(if(tonumber(status)>=400,1,0))) as errors | eval pct=if(total>0,round(errors/total*100,1),0) | table pct`,
    kpiAvgResponse: `${WRAW} | eval response_time_ms=tonumber(total_us)/1000 | stats avg(response_time_ms) as avg_ms | eval avg_ms=round(avg_ms,1) | table avg_ms`,
    trafficByMethod: `${WRAW} method=* | stats count by method | sort -count`,
    slowestPages: `${WRAW} uri=* | eval response_time_ms=tonumber(total_us)/1000 | stats avg(response_time_ms) as avg_response, count as requests by uri | eval avg_response=round(avg_response,1) | sort -avg_response | table uri, avg_response, requests`,
    topClients: `${WRAW} clientip=* | eval response_time_ms=tonumber(total_us)/1000 | stats count as requests, dc(uri) as unique_pages, avg(response_time_ms) as avg_response_ms by clientip | eval avg_response_ms=round(avg_response_ms,1) | sort -requests | table clientip, requests, unique_pages, avg_response_ms`,
    slowestTraces: `${WRAW} | sort 20 - total_us | table _time, uri, status, method, dt1_us, dt2_us, dt3_us, dt4_us, total_us`,
};

// Per-panel filter for Top URIs (P3 demo)
const URI_STATUS_FILTERS = {
    all: { label: 'All status codes', clause: '' },
    '2xx': { label: '2xx success', clause: 'status>=200 status<300' },
    '3xx': { label: '3xx redirect', clause: 'status>=300 status<400' },
    '4xx': { label: '4xx client error', clause: 'status>=400 status<500' },
    '5xx': { label: '5xx server error', clause: 'status>=500 status<600' },
};
type UriStatusFilter = keyof typeof URI_STATUS_FILTERS;
const buildTopUrisQuery = (filter: UriStatusFilter): string => {
    // wd_uristat status_group uses the Top URIs filter buckets ("2xx".."5xx"/"other").
    const sg = filter === 'all' ? '' : `| search status_group="${filter}"`;
    return `${WD_URISTAT} ${sg} | search uri!="(none)" | stats sum(count) as Requests, sum(sum_rt) as s, sum(cnt_rt) as c by uri | eval "Avg Response (ms)"=round(if(c>0,s/c,0),1) | sort -Requests | table uri, Requests, "Avg Response (ms)"`;
};
/** RAW twin of buildTopUrisQuery for the sub-hour hybrid (session 086). The
 *  status range clause reuses URI_STATUS_FILTERS[filter].clause (the same
 *  status>=NNN status<MMM the rollup's status_group buckets were built from),
 *  reconciled to the cached read's exact columns. Both builders return an
 *  un-cloud-mapped query; the call site wraps them in withCloudProvider so the
 *  global Cloud Provider filter applies (build 298 / task_1dae8924). */
const buildTopUrisRawQuery = (filter: UriStatusFilter): string => {
    const clause = filter === 'all' ? '' : ` ${URI_STATUS_FILTERS[filter].clause}`;
    return `${WRAW}${clause} uri=* | eval response_time_ms=tonumber(total_us)/1000 | stats count as Requests, avg(response_time_ms) as "Avg Response (ms)" by uri | eval "Avg Response (ms)"=round('Avg Response (ms)',1) | sort -Requests | table uri, Requests, "Avg Response (ms)"`;
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
/** useFirstRowField over a hybrid cached/raw pair (session 086) — sub-hour
 *  ranges read the raw query, wide ranges the rollup. */
const useFirstRowFieldHybrid = (cached: string, raw: string, f: string): FirstRow => {
    const search = useHybridSearch({ cached, raw });
    const { results, loading, error } = search;
    const value = results && results[0] ? (results[0] as Record<string, unknown>)[f] : undefined;
    return { value, loading, error, search };
};

const formatPercent = (raw: unknown): string => {
    if (raw === null || typeof raw === 'undefined') return '—';
    const n = typeof raw === 'number' ? raw : parseFloat(String(raw));
    return Number.isNaN(n) ? String(raw) : `${n.toFixed(1)}%`;
};
const formatLatency = (raw: unknown): string => {
    if (raw === null || typeof raw === 'undefined') return '—';
    const n = typeof raw === 'number' ? raw : parseFloat(String(raw));
    return Number.isNaN(n) ? String(raw) : `${n.toFixed(0)} ms`;
};

const SLOWEST_PAGE_COLS: ColumnDef[] = [
    { key: 'uri', label: 'URI' },
    { key: 'avg_response', label: 'Avg Response (ms)', align: 'right' },
    { key: 'requests', label: 'Requests', align: 'right', render: (v) => formatInteger(v) },
];
const TOP_CLIENT_COLS: ColumnDef[] = [
    { key: 'clientip', label: 'Client IP' },
    { key: 'requests', label: 'Requests', align: 'right', render: (v) => formatInteger(v) },
    { key: 'unique_pages', label: 'Unique Pages', align: 'right', render: (v) => formatInteger(v) },
    { key: 'avg_response_ms', label: 'Avg Response (ms)', align: 'right' },
];
const TOP_URIS_COLS: ColumnDef[] = [
    { key: 'uri', label: 'URI' },
    { key: 'Requests', label: 'Requests', align: 'right', render: (v) => formatInteger(v) },
    { key: 'Avg Response (ms)', label: 'Avg Response (ms)', align: 'right' },
];
const RECENT_ERROR_COLS: ColumnDef[] = [
    { key: '_time', label: 'Time', width: '160px', render: (v) => v ? new Date(String(v)).toLocaleString('en-US', { hour12: false }) : '' },
    { key: 'clientip', label: 'Client IP', width: '140px' },
    { key: 'method', label: 'Method', width: '90px' },
    { key: 'uri', label: 'URI' },
    { key: 'status', label: 'Status', width: '80px', align: 'right' },
    { key: 'response_time_ms', label: 'Response (ms)', align: 'right', width: '120px' },
];

const WebDispatcher: React.FC = () => {
    const { provider } = useCloudProvider();
    const Q = React.useMemo(() => mapCloudProviderQueries(Q_BASE, provider), [provider]);
    // RAW fallbacks for the sub-hour hybrid (session 086); same cloud mapping so both arms filter identically.
    const QRAW = React.useMemo(() => mapCloudProviderQueries(QRAW_BASE, provider), [provider]);
    const [uriStatusFilter, setUriStatusFilter] = useState<UriStatusFilter>('all');
    /* Resolved hex tokens — seriesColorsByField flows into
     * @splunk/visualizations (SVG fills), where logservTheme's var(--lsv-*)
     * references don't resolve. Build 246 / Phase 0. */
    const { tokens } = useThemeMode();

    // Dynamic timechart span — recomputed when the time range changes so
    // the per-bin granularity stays readable across "Last 6h" through
    // "Last 90 days" without becoming a wall of bars or a single point.
    const { timeRange } = useTimeRange();
    const span = useMemo(
        () => chooseTimechartSpan(timeRange.earliest, timeRange.latest),
        [timeRange.earliest, timeRange.latest],
    );
    // Sub-hour hybrid (session 086): the two span-parametrised charts build SPL
    // in a useMemo, so route inline via the pure fn rather than the hook.
    const useRawSrc = shouldUseRawSource(timeRange.earliest, timeRange.latest);

    // Traffic by Status Code — multi-line chart so 4xx/5xx trends remain
    // visible alongside the much larger 2xx series instead of getting
    // crushed under stacked bars.
    const trafficByStatusQuery = useMemo(
        () => {
            const rawQ = withCloudProvider(
                `${WRAW} | eval status_group=case(tonumber(status)<300,"Success (2xx)",tonumber(status)<400,"Redirect (3xx)",tonumber(status)<500,"Client Error (4xx)",tonumber(status)>=500,"Server Error (5xx)",1==1,"Other") ` +
                    `| timechart span=${span} count by status_group | fillnull value=0`,
                provider,
            );
            const cachedQ = withCloudProvider(
                `${WD_STATUS} | eval _time=bucket_ts ` +
                    `| timechart span=${span} sum(count) by status_group | fillnull value=0`,
                provider,
            );
            recordRawTwin(cachedQ, rawQ); // §17.8a-17
            return useRawSrc ? rawQ : cachedQ;
        },
        [span, useRawSrc, provider],
    );

    // Response Time Trend — Avg + Max per bucket (build 232). Percentiles
    // (p50/p95/p99) were RAW and don't merge byte-exact across hourly buckets,
    // so they are replaced by Avg (=Σsum_rt/Σcnt_rt) + Max (=max-of-per-bucket-max).
    // The raw twin uses sum/count/max (not avg) so empty-bin behavior (Avg=0,
    // Max=null) matches the cached arm byte-for-byte.
    const responseTimeTrendQuery = useMemo(
        () => {
            const rawQ = withCloudProvider(
                `${WRAW} | eval response_time_ms=tonumber(total_us)/1000 ` +
                    `| timechart span=${span} sum(response_time_ms) as s, count(response_time_ms) as c, max(response_time_ms) as "Max (ms)" ` +
                    `| eval "Avg (ms)" = if(c>0, round(s/c, 1), 0) | fields _time, "Avg (ms)", "Max (ms)"`,
                provider,
            );
            const cachedQ = withCloudProvider(
                `${WD_CORE} | eval _time=bucket_ts ` +
                    `| timechart span=${span} sum(sum_rt) as s, sum(cnt_rt) as c, max(max_rt) as "Max (ms)" ` +
                    `| eval "Avg (ms)" = if(c>0, round(s/c, 1), 0) | fields _time, "Avg (ms)", "Max (ms)"`,
                provider,
            );
            recordRawTwin(cachedQ, rawQ); // §17.8a-17
            return useRawSrc ? rawQ : cachedQ;
        },
        [span, useRawSrc, provider],
    );

    const requests = useFirstRowField(Q.kpiRequests, 'count');
    const errorRate = useFirstRowFieldHybrid(Q.kpiErrorRate, QRAW.kpiErrorRate, 'pct');
    const avgResponse = useFirstRowFieldHybrid(Q.kpiAvgResponse, QRAW.kpiAvgResponse, 'avg_ms');

    const slowestPages = useHybridSearch({ cached: Q.slowestPages, raw: QRAW.slowestPages });
    const topClients = useHybridSearch({ cached: Q.topClients, raw: QRAW.topClients });
    const topUris = useHybridSearch({
        cached: withCloudProvider(buildTopUrisQuery(uriStatusFilter), provider),
        raw: withCloudProvider(buildTopUrisRawQuery(uriStatusFilter), provider),
    });
    const recentErrors = useSearch({ query: Q.recentErrors });
    const slowestTraces = useHybridSearch<TraceRow>({ cached: Q.slowestTraces, raw: QRAW.slowestTraces });

    // trafficByMethod PieChart takes a query string → route once (sub-hour -> raw).
    const qTrafficByMethod = useRoutedQuery(Q.trafficByMethod, QRAW.trafficByMethod);

    /* Drilldowns (build 159 / session 027 task 6).
     * Pattern: every drilldown opens Splunk Search in a new tab with a
     * pre-filled SPL filtered to the row's context (URI / clientip). The
     * Top URIs row drilldown INHERITS the inline `uriStatusFilter` state
     * so clicking a row while the user has 4xx selected yields a search
     * scoped to "this URI AND status>=400". */
    const goSlowestPagesRow = useCallback((row: Record<string, unknown>) => {
        const uri = String(row.uri ?? '');
        if (!uri) return;
        const spl = `\`sap_logserv_idx_macro\` ${ST} uri="${splQuote(uri)}" | eval response_time_ms=round(tonumber(total_us)/1000, 1) | table _time clientip status response_time_ms method | sort -response_time_ms`;
        openInNewTab(buildSplunkSearchUrl(spl, timeRange.earliest, timeRange.latest));
    }, [timeRange.earliest, timeRange.latest]);
    const goTopClientsRow = useCallback((row: Record<string, unknown>) => {
        const ip = String(row.clientip ?? '');
        if (!ip) return;
        const spl = `\`sap_logserv_idx_macro\` ${ST} clientip="${splQuote(ip)}" | sort -_time`;
        openInNewTab(buildSplunkSearchUrl(spl, timeRange.earliest, timeRange.latest));
    }, [timeRange.earliest, timeRange.latest]);
    const goTopUrisRow = useCallback((row: Record<string, unknown>) => {
        const uri = String(row.uri ?? '');
        if (!uri) return;
        // Inherit current status filter into the drilldown SPL so the user
        // sees "this URI AND the status class they're currently filtered to"
        const { clause } = URI_STATUS_FILTERS[uriStatusFilter];
        const filterPart = clause ? ` ${clause}` : '';
        const spl = `\`sap_logserv_idx_macro\` ${ST} uri="${splQuote(uri)}"${filterPart} | sort -_time`;
        openInNewTab(buildSplunkSearchUrl(spl, timeRange.earliest, timeRange.latest));
    }, [uriStatusFilter, timeRange.earliest, timeRange.latest]);
    const goRecentErrorsRow = useCallback((row: Record<string, unknown>) => {
        const ip = String(row.clientip ?? '');
        const uri = String(row.uri ?? '');
        if (!ip && !uri) return;
        const ipClause = ip ? `clientip="${splQuote(ip)}" ` : '';
        const uriClause = uri ? `uri="${splQuote(uri)}" ` : '';
        const spl = `\`sap_logserv_idx_macro\` ${ST} ${ipClause}${uriClause}status>=400 | sort -_time`;
        openInNewTab(buildSplunkSearchUrl(spl, timeRange.earliest, timeRange.latest));
    }, [timeRange.earliest, timeRange.latest]);
    const goSlowestTracesRow = useCallback((row: Record<string, unknown>) => {
        const uri = String(row.uri ?? '');
        if (!uri) return;
        const spl = `\`sap_logserv_idx_macro\` ${ST} uri="${splQuote(uri)}" | sort - total_us | table _time uri status dt1_us dt2_us dt3_us dt4_us total_us`;
        openInNewTab(buildSplunkSearchUrl(spl, timeRange.earliest, timeRange.latest));
    }, [timeRange.earliest, timeRange.latest]);
    const goMethodPie = useCallback(() => {
        const spl = `\`sap_logserv_idx_macro\` ${ST} | stats count by method | sort -count`;
        openInNewTab(buildSplunkSearchUrl(spl, timeRange.earliest, timeRange.latest));
    }, [timeRange.earliest, timeRange.latest]);

    const errRateNum = parseFloat(String(errorRate.value ?? 0));
    const errRateTone = errRateNum >= 5 ? 'critical' : errRateNum >= 1 ? 'warning' : 'neutral';

    return (
        <DashboardLayout
            category="INTEGRATION"
            title="Web Dispatcher Access"
            subtitle="SAP Web Dispatcher HTTP traffic — request volume, error rates, top URIs, and recent errors"
        >
            <KpiRow>
                <KpiCard label="Total Requests" value={requests.value} loading={requests.loading} error={requests.error} search={requests.search} formatValue={formatInteger}
                    sparkline={<SparklineFromQuery query={Q.sparkRequests} valueField="count" fill />} />
                <KpiCard label="Error Rate" value={errorRate.value} loading={errorRate.loading} error={errorRate.error} search={errorRate.search} formatValue={formatPercent} tone={errRateTone}
                    sparkline={<SparklineFromQuery query={Q.sparkErrorRate} valueField="daily" color={logservTheme.colors.red} fill />} />
                <KpiCard label="Avg Response Time" value={avgResponse.value} loading={avgResponse.loading} error={avgResponse.error} search={avgResponse.search} formatValue={formatLatency}
                    sparkline={<SparklineFromQuery query={Q.sparkAvgResponse} valueField="daily" color={logservTheme.colors.orange} fill />} />
            </KpiRow>

            <FullWidthPanel>
                <FramedPanel title="Request Volume Over Time" subtitle="Daily HTTP request count">
                    <TimeSeriesChart query={Q.requestVolumeOverTime} height={260} palette="volume" />
                </FramedPanel>
            </FullWidthPanel>

            <PanelGrid2>
                <FramedPanel
                    title="Traffic by Status Code"
                    subtitle={`Volume per status class (2xx/3xx/4xx/5xx) — span ${span}`}
                >
                    <TimeSeriesChart
                        query={trafficByStatusQuery}
                        height={280}
                        palette="status"
                        chartType="line"
                    />
                </FramedPanel>
                <FramedPanel
                    title="Response Time Trend"
                    subtitle={`Average and peak latency (ms) — span ${span}`}
                >
                    <TimeSeriesChart
                        query={responseTimeTrendQuery}
                        height={280}
                        chartType="line"
                        seriesColorsByField={{
                            'Avg (ms)': tokens.cyanLight,
                            'Max (ms)': tokens.orange,
                        }}
                    />
                </FramedPanel>
            </PanelGrid2>

            <PanelGrid3>
                <FramedPanel search={slowestPages} title="Slowest Pages" subtitle="URIs ranked by avg response time — click a row for that URI's full latency distribution">
                    <DataTable columns={SLOWEST_PAGE_COLS} rows={slowestPages.results} loading={slowestPages.loading} error={slowestPages.error} emptyMessage="No requests in this time range." onRowClick={goSlowestPagesRow} />
                </FramedPanel>
                <FramedPanel search={topClients} title="Client IPs by Traffic" subtitle="Clients ranked by request count — click a row for that client's full request log">
                    <DataTable columns={TOP_CLIENT_COLS} rows={topClients.results} loading={topClients.loading} error={topClients.error} emptyMessage="No requests in this time range." onRowClick={goTopClientsRow} />
                </FramedPanel>
                <FramedPanel
                    title="Traffic by HTTP Method"
                    subtitle="GET / POST / etc."
                    onClick={goMethodPie}
                    clickTitle="Open method-by-count breakdown in Splunk Search"
                >
                    <PieChart
                        query={qTrafficByMethod}
                        categoryField="method"
                        valueField="count"
                        height={260}
                        palette="volume"
                    />
                </FramedPanel>
            </PanelGrid3>

            <FullWidthPanel>
                <FramedPanel search={topUris}
                    title="URIs by Request Count"
                    subtitle={`URIs ranked by request count (${URI_STATUS_FILTERS[uriStatusFilter].label}) — click a row to drill into that URI within the current status filter`}
                    actions={
                        <Select
                            value={uriStatusFilter}
                            onChange={(_e, { value }) => {
                                if (typeof value === 'string' && value in URI_STATUS_FILTERS) {
                                    setUriStatusFilter(value as UriStatusFilter);
                                }
                            }}
                            inline
                        >
                            {(Object.keys(URI_STATUS_FILTERS) as UriStatusFilter[]).map((key) => (
                                <Select.Option key={key} value={key} label={URI_STATUS_FILTERS[key].label} />
                            ))}
                        </Select>
                    }
                >
                    <DataTable columns={TOP_URIS_COLS} rows={topUris.results} loading={topUris.loading} error={topUris.error} emptyMessage="No requests in this time range." onRowClick={goTopUrisRow} />
                </FramedPanel>
            </FullWidthPanel>

            <FullWidthPanel>
                <FramedPanel search={recentErrors} title="Recent Errors (4xx / 5xx)" subtitle="Error responses, most-recent first — click a row to investigate that client + URI's error path">
                    <DataTable columns={RECENT_ERROR_COLS} rows={recentErrors.results} loading={recentErrors.loading} error={recentErrors.error} emptyMessage="No errors in this time range." onRowClick={goRecentErrorsRow} />
                </FramedPanel>
            </FullWidthPanel>

            <FullWidthPanel>
                <FramedPanel
                    title="Slowest Request Traces"
                    subtitle="Top 20 by total response time, broken down by stage (dt1–dt4)"
                    search={slowestTraces}
                    onClick={() => {
                        const spl = `\`sap_logserv_idx_macro\` ${ST} | sort - total_us | table _time uri status method dt1_us dt2_us dt3_us dt4_us total_us | head 100`;
                        openInNewTab(buildSplunkSearchUrl(spl, timeRange.earliest, timeRange.latest));
                    }}
                    clickTitle="Open the slowest-traces SPL in Splunk Search"
                >
                    <TraceWaterfall rows={slowestTraces.results as TraceRow[] | null} loading={slowestTraces.loading} error={slowestTraces.error} />
                </FramedPanel>
            </FullWidthPanel>
        </DashboardLayout>
    );
};

export default WebDispatcher;
