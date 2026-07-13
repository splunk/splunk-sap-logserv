import React from 'react';
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
import { buildHostDetailsUrl, buildSplunkSearchUrl, openInNewTab, splQuote } from '../utils/drilldownUrls';
import { logservTheme } from '../styles/logservTheme';

/**
 * Proxy Analytics — honest port of v0.0.4.2 logserv_proxy.xml.
 *
 * 3 KPIs (Total / Bandwidth / Denied) + Request Volume line + Status Codes column +
 * Top Domains table + Top Clients table + Client Domain Diversity table + Cache
 * Action Distribution column + Bandwidth Timeline + Top Domains by Bytes table +
 * Bandwidth by Domain (Top 5) line.
 *
 * Performance tiering (session 049 CIM; rebuilt build 232 → KV-Store rollup). The
 * CIM Web tier fell back to a RAW full-scan when the customer hadn't accelerated
 * Web, so every field-bearing panel now reads the always-fast `logserv_proxy_rollup`
 * collection (6 metrics):
 *   - tstats-now (unchanged): Total Requests, Request Volume.
 *   - core (count/denied_count/bytes_sum) → Bandwidth + Denied KPIs + Bandwidth chart.
 *   - status → Status Codes. domain (url_domain,src) → Top Domains/Clients/Diversity/
 *     Bytes + Bandwidth-by-domain. cacheaction → Cache Action Distribution.
 *   - dur/destdur (per-bucket + per-dest) → Response Time + Slowest Destinations: the
 *     RAW perc50/perc95 panels become Avg(=Σsum_dur/Σcnt_dur)+Max(=max-of-max), since
 *     percentiles don't merge byte-exact across buckets. duration is the Squid
 *     pretrained access.log field (scope source="*access.log*" duration=*).
 * Read idiom: inputlookup metric=X | bucket_ts range | <agg>.
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

// --- Acceleration tiers (session 049 — CIM data-model acceleration) ----------
// Pure-count panels read default-indexed dims via tstats-now: fast today, exact,
// no model/acceleration dependency. The macro re-pins the customer's index so
// scope matches the raw dashboard and honors con1/jaclyn local/macros.conf overrides.
const TS_WHERE = `WHERE \`sap_logserv_idx_macro\` ${ST}`;

// KV-Store rollup reads (build 232 — replaces the CIM Web tier). dc() distinct
// columns put both dims in the metric grain (url_domain,src) so dc reconstructs
// across buckets; the "(none)" fillnull sentinel is nulled out on read.
const ROLL = 'logserv_proxy_rollup';
const RANGE = '| addinfo | where bucket_ts>=info_min_time AND bucket_ts<info_max_time';
const R_CORE = `| inputlookup ${ROLL} where metric="core" ${RANGE}`;
const R_STATUS = `| inputlookup ${ROLL} where metric="status" ${RANGE}`;
const R_DOMAIN = `| inputlookup ${ROLL} where metric="domain" ${RANGE}`;
const R_CACHE = `| inputlookup ${ROLL} where metric="cacheaction" ${RANGE}`;
const R_DUR = `| inputlookup ${ROLL} where metric="dur" ${RANGE}`;
const R_DESTDUR = `| inputlookup ${ROLL} where metric="destdur" ${RANGE}`;

const formatBytes = (raw: unknown): string => {
    if (raw === null || typeof raw === 'undefined') return '—';
    const n = typeof raw === 'number' ? raw : parseFloat(String(raw).replace(/,/g, ''));
    if (Number.isNaN(n)) return String(raw);
    if (n >= 1073741824) return `${(n / 1073741824).toFixed(1)} GB`;
    if (n >= 1048576) return `${(n / 1048576).toFixed(1)} MB`;
    if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${n} B`;
};

const Q_BASE = {
    // --- tstats-now (pure counts on default-indexed fields) ------------------
    kpiTotal: `| tstats count ${TS_WHERE}`,

    sparkTotal: `| tstats count ${TS_WHERE} BY _time span=1d | timechart span=1d sum(count) AS count`,
    requestVolume: `| tstats count ${TS_WHERE} BY _time span=1d | timechart span=1d sum(count) AS Requests`,

    // --- KV-Store rollup: core (bandwidth / denied) -------------------------
    kpiBandwidth: `${R_CORE} | stats count as n, sum(bytes_sum) as total_bytes | fillnull value=0 total_bytes | eval total = case(total_bytes >= 1073741824, round(total_bytes/1073741824, 1) . " GB", total_bytes >= 1048576, round(total_bytes/1048576, 1) . " MB", total_bytes >= 1024, round(total_bytes/1024, 1) . " KB", 1=1, tostring(total_bytes) . " B")`,
    kpiDenied: `${R_CORE} | stats count as n, sum(denied_count) as count | fillnull value=0 count | fields count`,

    sparkBandwidth: `${R_CORE} | eval _time=bucket_ts | timechart span=1d sum(bytes_sum) as bytes_daily | eval daily = round(bytes_daily/1048576, 2) | fields _time daily`,
    sparkDenied: `${R_CORE} | eval _time=bucket_ts | timechart span=1d sum(denied_count) as count | fillnull value=0`,

    statusCodes: `${R_STATUS} | eval status_cat=case(tonumber(status)>=200 AND tonumber(status)<300, "2xx", tonumber(status)>=300 AND tonumber(status)<400, "3xx", tonumber(status)>=400 AND tonumber(status)<500, "4xx", tonumber(status)>=500, "5xx", 1=1, "Other") | eval _time=bucket_ts | timechart span=1d sum(count) by status_cat | fillnull value=0`,

    // dc() distinct columns reconstruct across buckets because both dims are in the
    // domain metric grain (url_domain,src); the "(none)" fillnull sentinel is nulled.
    topDomains: `${R_DOMAIN} | search url_domain!="(none)" | stats sum(count) as Requests, sum(bytes_sum) as "Total Bytes", dc(eval(if(src="(none)",null(),src))) as "Unique Clients" by url_domain | sort -Requests | rename url_domain as Domain`,
    topClients: `${R_DOMAIN} | search src!="(none)" | stats sum(count) as Requests, sum(bytes_sum) as "Total Bytes", dc(eval(if(url_domain="(none)",null(),url_domain))) as "Unique Domains" by src | sort -Requests | rename src as "Client IP"`,
    clientDomainDiversity: `${R_DOMAIN} | search src!="(none)" | stats dc(eval(if(url_domain="(none)",null(),url_domain))) as "Unique Domains" by src | sort -"Unique Domains" | rename src as "Client IP"`,

    bandwidthTimeline: `${R_CORE} | eval _time=bucket_ts | timechart span=1d sum(bytes_sum) as "Bytes Out" | fillnull value=0`,
    topDomainsByBytes: `${R_DOMAIN} | search url_domain!="(none)" | stats sum(bytes_sum) as bytes_out by url_domain | eval mb_out = round(bytes_out/1048576, 2) | sort -mb_out | rename url_domain as "Domain", mb_out as "MB Out" | table "Domain", "MB Out"`,
    bandwidthByDomain: `${R_DOMAIN} | search url_domain!="(none)" | eval _time=bucket_ts | timechart span=1d sum(bytes_sum) by url_domain limit=5 useother=f`,

    // --- KV-Store rollup: cacheaction ---------------------------------------
    contentTypes: `${R_CACHE} | search vendor_action!="(none)" | stats sum(count) as Events by vendor_action | sort -Events | rename vendor_action as "Cache Action"`,

    // --- KV-Store rollup: dur / destdur (was RAW percentiles -> Avg+Max) -----
    // The Squid pretrained `duration` field exists only on the access.log subset
    // (store.log shares the sourcetype with no duration); aggregate scope mirrors that.
    slowDestinations: `${R_DESTDUR} | search dest!="(none)" | stats sum(sum_dur) as s, sum(cnt_dur) as c, max(max_dur) as max_ms, sum(count) as Requests by dest | eval "Avg (ms)" = round(if(c>0, s/c, 0), 0), "Max (ms)" = round(max_ms, 0) | sort -"Max (ms)" | head 20 | rename dest AS Destination | table Destination, Requests, "Avg (ms)", "Max (ms)"`,
    responseTimeTrend: `${R_DUR} | eval _time=bucket_ts | timechart span=1d sum(sum_dur) as s, sum(cnt_dur) as c, max(max_dur) as "Max (ms)" | eval "Avg (ms)" = if(c>0, round(s/c, 0), 0) | fields _time, "Avg (ms)", "Max (ms)"`,
};

/* ---------------------------------------------------------------------------
 * RAW fallbacks for the sub-hour hybrid (session 085/086). Each is the raw
 * squid:access scan that its rollup metric precomputes, reconciled to the
 * cached read's exact output columns (byte-verified equal at wide windows).
 * The rollup measures map to raw as: bytes_sum -> sum(bytes_out); sum(count)
 * -> count; denied_count -> the action="denied" filter; sum_dur/cnt_dur/max_dur
 * -> sum/count/max(duration) over the access.log+duration=* subset. The
 * "(none)" fillnull sentinels don't exist on raw (stats-by drops nulls). Only
 * the ROLLUP reads are hybridised; kpiTotal/requestVolume (tstats) are already
 * correct at any range and the sparklines stay cached (cosmetic).
 * ------------------------------------------------------------------------- */
const SQRAW = '`sap_logserv_idx_macro` sourcetype="squid:access"';
const QRAW_BASE = {
    kpiBandwidth: `${SQRAW} | stats count as n, sum(bytes_out) as total_bytes | fillnull value=0 total_bytes | eval total = case(total_bytes >= 1073741824, round(total_bytes/1073741824, 1) . " GB", total_bytes >= 1048576, round(total_bytes/1048576, 1) . " MB", total_bytes >= 1024, round(total_bytes/1024, 1) . " KB", 1=1, tostring(total_bytes) . " B")`,
    kpiDenied: `${SQRAW} action="denied" | stats count`,
    statusCodes: `${SQRAW} | eval status_cat=case(tonumber(status)>=200 AND tonumber(status)<300, "2xx", tonumber(status)>=300 AND tonumber(status)<400, "3xx", tonumber(status)>=400 AND tonumber(status)<500, "4xx", tonumber(status)>=500, "5xx", 1=1, "Other") | timechart span=1d count by status_cat | fillnull value=0`,
    topDomains: `${SQRAW} url_domain=* | stats count as Requests, sum(bytes_out) as "Total Bytes", dc(src) as "Unique Clients" by url_domain | sort -Requests | rename url_domain as Domain`,
    topClients: `${SQRAW} src=* | stats count as Requests, sum(bytes_out) as "Total Bytes", dc(url_domain) as "Unique Domains" by src | sort -Requests | rename src as "Client IP"`,
    clientDomainDiversity: `${SQRAW} src=* | stats dc(url_domain) as "Unique Domains" by src | sort -"Unique Domains" | rename src as "Client IP"`,
    contentTypes: `${SQRAW} vendor_action=* | stats count as Events by vendor_action | sort -Events | rename vendor_action as "Cache Action"`,
    topDomainsByBytes: `${SQRAW} url_domain=* | stats sum(bytes_out) as bytes_out by url_domain | eval mb_out = round(bytes_out/1048576, 2) | sort -mb_out | rename url_domain as "Domain", mb_out as "MB Out" | table "Domain", "MB Out"`,
    slowDestinations: `${SQRAW} source="*access.log*" duration=* | stats sum(duration) as s, count(duration) as c, max(duration) as max_ms, count as Requests by dest | eval "Avg (ms)" = round(if(c>0, s/c, 0), 0), "Max (ms)" = round(max_ms, 0) | sort -"Max (ms)" | head 20 | rename dest AS Destination | table Destination, Requests, "Avg (ms)", "Max (ms)"`,
    bandwidthTimeline: `${SQRAW} | timechart span=1d sum(bytes_out) as "Bytes Out" | fillnull value=0`,
    bandwidthByDomain: `${SQRAW} url_domain=* | timechart span=1d sum(bytes_out) by url_domain limit=5 useother=f`,
    responseTimeTrend: `${SQRAW} source="*access.log*" duration=* | timechart span=1d avg(duration) as "Avg (ms)", max(duration) as "Max (ms)" | eval "Avg (ms)"=round('Avg (ms)',0), "Max (ms)"=round('Max (ms)',0) | fields _time, "Avg (ms)", "Max (ms)"`,
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

// Response time columns (build 186)
const SLOW_DEST_COLS: ColumnDef[] = [
    { key: 'Destination', label: 'Destination' },
    { key: 'Requests', label: 'Requests', align: 'right', render: (v) => formatInteger(v) },
    { key: 'Avg (ms)', label: 'Avg (ms)', align: 'right', render: (v) => formatInteger(v) },
    { key: 'Max (ms)', label: 'Max (ms)', align: 'right', render: (v) => formatInteger(v) },
];

const Proxy: React.FC = () => {
    const { provider } = useCloudProvider();
    const Q = React.useMemo(() => mapCloudProviderQueries(Q_BASE, provider), [provider]);
    // RAW fallbacks for the sub-hour hybrid (session 085/086); same cloud mapping
    // so both arms filter identically.
    const QRAW = React.useMemo(() => mapCloudProviderQueries(QRAW_BASE, provider), [provider]);
    const total = useFirstRowField(Q.kpiTotal, 'count');
    const bandwidth = useFirstRowFieldHybrid(Q.kpiBandwidth, QRAW.kpiBandwidth, 'total');
    const denied = useFirstRowFieldHybrid(Q.kpiDenied, QRAW.kpiDenied, 'count');

    const topDomains = useHybridSearch({ cached: Q.topDomains, raw: QRAW.topDomains });
    const topClients = useHybridSearch({ cached: Q.topClients, raw: QRAW.topClients });
    const clientDiversity = useHybridSearch({ cached: Q.clientDomainDiversity, raw: QRAW.clientDomainDiversity });
    const cacheActions = useHybridSearch({ cached: Q.contentTypes, raw: QRAW.contentTypes });
    const topDomBytes = useHybridSearch({ cached: Q.topDomainsByBytes, raw: QRAW.topDomainsByBytes });
    const slowDestinations = useHybridSearch({ cached: Q.slowDestinations, raw: QRAW.slowDestinations });

    // Chart panels take a query STRING → route once here (sub-hour -> raw).
    const qStatusCodes = useRoutedQuery(Q.statusCodes, QRAW.statusCodes);
    const qBandwidthTimeline = useRoutedQuery(Q.bandwidthTimeline, QRAW.bandwidthTimeline);
    const qBandwidthByDomain = useRoutedQuery(Q.bandwidthByDomain, QRAW.bandwidthByDomain);
    const qResponseTimeTrend = useRoutedQuery(Q.responseTimeTrend, QRAW.responseTimeTrend);

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
                    <TimeSeriesChart query={qStatusCodes} height={280} palette="status" />
                </FramedPanel>
            </PanelGrid2>

            <PanelGrid3>
                <FramedPanel search={topDomains} title="Domains" subtitle="Domains ranked by request count — click a row for that domain's full proxy log">
                    <DataTable columns={TOP_DOM_COLS} rows={topDomains.results} loading={topDomains.loading} error={topDomains.error} emptyMessage="No proxy events in this time range." onRowClick={goDomainRow} />
                </FramedPanel>
                <FramedPanel search={topClients} title="Clients" subtitle="Client IPs ranked by request count — click a row to open Host Details">
                    <DataTable columns={TOP_CLIENT_COLS} rows={topClients.results} loading={topClients.loading} error={topClients.error} emptyMessage="No proxy events in this time range." onRowClick={goClientRow} />
                </FramedPanel>
                <FramedPanel search={clientDiversity} title="Clients by Domain Diversity" subtitle="Clients ranked by unique domains visited — click a row to open Host Details">
                    <DataTable columns={CLIENT_DIVERSITY_COLS} rows={clientDiversity.results} loading={clientDiversity.loading} error={clientDiversity.error} emptyMessage="No proxy events in this time range." onRowClick={goClientRow} />
                </FramedPanel>
            </PanelGrid3>

            <PanelGrid2>
                <FramedPanel search={cacheActions} title="Cache Action Distribution" subtitle="Squid cache actions ranked by count">
                    <DataTable columns={CACHE_COLS} rows={cacheActions.results} loading={cacheActions.loading} error={cacheActions.error} emptyMessage="No proxy events in this time range." />
                </FramedPanel>
                <FramedPanel title="Bandwidth Over Time" subtitle="Daily bytes-out volume">
                    <TimeSeriesChart query={qBandwidthTimeline} height={280} palette="volume" />
                </FramedPanel>
            </PanelGrid2>

            <PanelGrid2>
                <FramedPanel search={topDomBytes} title="URL Domains by Bytes Out" subtitle="Domains ranked by MB delivered — click a row for that domain's full proxy log">
                    <DataTable columns={TOP_DOM_BYTES_COLS} rows={topDomBytes.results} loading={topDomBytes.loading} error={topDomBytes.error} emptyMessage="No proxy events in this time range." initialSortKey="MB Out" initialSortDir="desc" onRowClick={goDomainRow} />
                </FramedPanel>
                <FramedPanel title="Bandwidth Over Time by Domain (Top 5)" subtitle="Daily bytes by top 5 domains">
                    <TimeSeriesChart query={qBandwidthByDomain} height={280} palette="volume" />
                </FramedPanel>
            </PanelGrid2>

            <PanelGrid2>
                <FramedPanel search={slowDestinations} title="Slowest Destinations" subtitle="Top 20 destinations by max response time (ms) — Squid access.log duration field">
                    <DataTable columns={SLOW_DEST_COLS} rows={slowDestinations.results} loading={slowDestinations.loading} error={slowDestinations.error} emptyMessage="No access.log events with duration in this time range." initialSortKey="Max (ms)" initialSortDir="desc" />
                </FramedPanel>
                <FramedPanel title="Response Time (Avg / Max)" subtitle="Daily average and peak response time (ms) — Squid access.log duration field">
                    <TimeSeriesChart query={qResponseTimeTrend} height={280} palette="categorical" chartType="line" />
                </FramedPanel>
            </PanelGrid2>
        </DashboardLayout>
    );
};

export default Proxy;
