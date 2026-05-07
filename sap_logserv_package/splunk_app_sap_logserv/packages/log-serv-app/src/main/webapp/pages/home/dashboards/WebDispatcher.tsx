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
import { useTimeRange } from '../state/TimeRangeProvider';
import { chooseTimechartSpan } from '../utils/timechartSpan';
import { buildSplunkSearchUrl, openInNewTab, splQuote } from '../utils/drilldownUrls';
import { logservTheme } from '../styles/logservTheme';

/**
 * Web Dispatcher Access — honest port of v0.0.4.2 logserv_web_dispatcher.xml
 * + the v0.0.5.0 redesigned widget (TraceWaterfall) and the per-panel filter
 * (P3 demo on Top URIs).
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

// SPL — verbatim from v0.0.4.2 (KPI sums extracted, sparklines re-derived)
const Q = {
    kpiRequests: `\`sap_logserv_idx_macro\` ${ST} | stats count`,
    kpiErrorRate: `\`sap_logserv_idx_macro\` ${ST} | eval is_err=if(tonumber(status)>=400,1,0) | stats sum(is_err) as errors, count as total | eval pct = if(total>0, round(errors/total*100, 1), 0) | table pct`,
    kpiAvgResponse: `\`sap_logserv_idx_macro\` ${ST} | eval response_time_ms=tonumber(total_us)/1000 | stats avg(response_time_ms) as avg_ms | eval avg_ms=round(avg_ms,1)`,

    sparkRequests: `\`sap_logserv_idx_macro\` ${ST} | timechart span=1d count`,
    sparkErrorRate: `\`sap_logserv_idx_macro\` ${ST} | eval is_err=if(tonumber(status)>=400,1,0) | timechart span=1d sum(is_err) as errors_daily count as total_daily | eval daily = round(errors_daily/total_daily*100, 1) | fields _time daily`,
    sparkAvgResponse: `\`sap_logserv_idx_macro\` ${ST} | eval response_time_ms=tonumber(total_us)/1000 | timechart span=1d avg(response_time_ms) as daily | eval daily=round(daily,1)`,

    slowestPages: `\`sap_logserv_idx_macro\` ${ST} | eval response_time_ms = tonumber(total_us)/1000 | stats avg(response_time_ms) as avg_response, count as requests by uri | eval avg_response = round(avg_response, 1) | sort -avg_response | table uri, avg_response, requests`,
    trafficByMethod: `\`sap_logserv_idx_macro\` ${ST} | stats count by method | sort -count`,
    topClients: `\`sap_logserv_idx_macro\` ${ST} | stats count as requests, dc(uri) as unique_pages, avg(tonumber(total_us)/1000) as avg_response_ms by clientip | sort -requests | eval avg_response_ms=round(avg_response_ms,1) | table clientip, requests, unique_pages, avg_response_ms`,
    requestVolumeOverTime: `\`sap_logserv_idx_macro\` ${ST} | timechart span=1d count as Requests`,
    recentErrors: `\`sap_logserv_idx_macro\` ${ST} status>=400 | eval response_time_ms=round(tonumber(total_us)/1000, 1) | table _time clientip method uri status response_time_ms | sort -_time`,
    slowestTraces: `\`sap_logserv_idx_macro\` ${ST} | sort - total_us | table _time, uri, status, method, dt1_us, dt2_us, dt3_us, dt4_us, total_us`,
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
    const { clause } = URI_STATUS_FILTERS[filter];
    const filterPart = clause ? ` ${clause}` : '';
    return `\`sap_logserv_idx_macro\` ${ST}${filterPart} | eval response_time_ms=round(tonumber(total_us)/1000, 1) | stats count as Requests, avg(response_time_ms) as "Avg Response (ms)", dc(clientip) as "Unique Clients" by uri | eval "Avg Response (ms)"=round('Avg Response (ms)', 1) | sort -Requests`;
};

interface FirstRow { value: unknown; loading: boolean; error: Error | null; }
const useFirstRowField = (q: string, f: string): FirstRow => {
    const { results, loading, error } = useSearch({ query: q });
    const value = results && results[0] ? (results[0] as Record<string, unknown>)[f] : undefined;
    return { value, loading, error };
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
    { key: 'Unique Clients', label: 'Unique Clients', align: 'right', render: (v) => formatInteger(v) },
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
    const [uriStatusFilter, setUriStatusFilter] = useState<UriStatusFilter>('all');

    // Dynamic timechart span — recomputed when the time range changes so
    // the per-bin granularity stays readable across "Last 6h" through
    // "Last 90 days" without becoming a wall of bars or a single point.
    const { timeRange } = useTimeRange();
    const span = useMemo(
        () => chooseTimechartSpan(timeRange.earliest, timeRange.latest),
        [timeRange.earliest, timeRange.latest],
    );

    // Traffic by Status Code — multi-line chart so 4xx/5xx trends remain
    // visible alongside the much larger 2xx series instead of getting
    // crushed under stacked bars.
    const trafficByStatusQuery = useMemo(
        () =>
            `\`sap_logserv_idx_macro\` ${ST} ` +
            `| eval status_group = case(tonumber(status) < 300, "Success (2xx)", ` +
            `tonumber(status) < 400, "Redirect (3xx)", ` +
            `tonumber(status) < 500, "Client Error (4xx)", ` +
            `tonumber(status) >= 500, "Server Error (5xx)", ` +
            `1=1, "Other") ` +
            `| timechart span=${span} count by status_group`,
        [span],
    );

    // Response Time Trend — p50/p95/p99 percentile lines (SRE-standard).
    // Average hides the tail latency that actually annoys users; p95/p99
    // surface it. Three lines on the same axis make the spread visible.
    const responseTimeTrendQuery = useMemo(
        () =>
            `\`sap_logserv_idx_macro\` ${ST} ` +
            `| eval response_time_ms = tonumber(total_us)/1000 ` +
            `| timechart span=${span} ` +
            `p50(response_time_ms) as "p50" ` +
            `p95(response_time_ms) as "p95" ` +
            `p99(response_time_ms) as "p99"`,
        [span],
    );

    const requests = useFirstRowField(Q.kpiRequests, 'count');
    const errorRate = useFirstRowField(Q.kpiErrorRate, 'pct');
    const avgResponse = useFirstRowField(Q.kpiAvgResponse, 'avg_ms');

    const slowestPages = useSearch({ query: Q.slowestPages });
    const topClients = useSearch({ query: Q.topClients });
    const topUris = useSearch({ query: buildTopUrisQuery(uriStatusFilter) });
    const recentErrors = useSearch({ query: Q.recentErrors });
    const slowestTraces = useSearch<TraceRow>({ query: Q.slowestTraces });

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
                <KpiCard label="Total Requests" value={requests.value} loading={requests.loading} error={requests.error} formatValue={formatInteger}
                    sparkline={<SparklineFromQuery query={Q.sparkRequests} valueField="count" fill />} />
                <KpiCard label="Error Rate" value={errorRate.value} loading={errorRate.loading} error={errorRate.error} formatValue={formatPercent} tone={errRateTone}
                    sparkline={<SparklineFromQuery query={Q.sparkErrorRate} valueField="daily" color={logservTheme.colors.red} fill />} />
                <KpiCard label="Avg Response Time" value={avgResponse.value} loading={avgResponse.loading} error={avgResponse.error} formatValue={formatLatency}
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
                    subtitle={`Latency percentiles (p50 / p95 / p99) in ms — span ${span}`}
                >
                    <TimeSeriesChart
                        query={responseTimeTrendQuery}
                        height={280}
                        chartType="line"
                        seriesColorsByField={{
                            p50: logservTheme.colors.cyanLight,
                            p95: logservTheme.colors.orange,
                            p99: logservTheme.colors.red,
                        }}
                    />
                </FramedPanel>
            </PanelGrid2>

            <PanelGrid3>
                <FramedPanel title="Slowest Pages" subtitle="URIs ranked by avg response time — click a row for that URI's full latency distribution">
                    <DataTable columns={SLOWEST_PAGE_COLS} rows={slowestPages.results} loading={slowestPages.loading} error={slowestPages.error} emptyMessage="No requests in this time range." onRowClick={goSlowestPagesRow} />
                </FramedPanel>
                <FramedPanel title="Client IPs by Traffic" subtitle="Clients ranked by request count — click a row for that client's full request log">
                    <DataTable columns={TOP_CLIENT_COLS} rows={topClients.results} loading={topClients.loading} error={topClients.error} emptyMessage="No requests in this time range." onRowClick={goTopClientsRow} />
                </FramedPanel>
                <FramedPanel
                    title="Traffic by HTTP Method"
                    subtitle="GET / POST / etc."
                    onClick={goMethodPie}
                    clickTitle="Open method-by-count breakdown in Splunk Search"
                >
                    <PieChart
                        query={Q.trafficByMethod}
                        categoryField="method"
                        valueField="count"
                        height={260}
                        palette="volume"
                    />
                </FramedPanel>
            </PanelGrid3>

            <FullWidthPanel>
                <FramedPanel
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
                <FramedPanel title="Recent Errors (4xx / 5xx)" subtitle="Error responses, most-recent first — click a row to investigate that client + URI's error path">
                    <DataTable columns={RECENT_ERROR_COLS} rows={recentErrors.results} loading={recentErrors.loading} error={recentErrors.error} emptyMessage="No errors in this time range." onRowClick={goRecentErrorsRow} />
                </FramedPanel>
            </FullWidthPanel>

            <FullWidthPanel>
                <FramedPanel
                    title="Slowest Request Traces"
                    subtitle="Top 20 by total response time, broken down by stage (dt1–dt4)"
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
