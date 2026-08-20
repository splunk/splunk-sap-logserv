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
 * SAP Router — honest port of v0.0.4.2 logserv_sap_router.xml.
 *
 * 4 KPIs (Total / Errors / Invalid Data / Unique Peers) + Connection Actions column +
 * Router Errors area + Top Peer IPs table + Return Code pie + Error Detail by Function table +
 * Recent Connection Log table.
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

const ST = 'sourcetype="sap:saprouter"';

/**
 * Dashboard-perf roadmap tier #6 (KV-Store precompute, session 052 / build 216).
 *
 * SAP Router is a single-sourcetype dashboard whose count panels raw-scanned all
 * sap:saprouter events. The 9 aggregatable panels below now read from the
 * `logserv_saprouter_rollup` KV Store collection, populated hourly by
 * [logserv_saprouter_aggregate] (one-time [logserv_saprouter_backfill]). The
 * Recent Connection Log table stays RAW — a rollup can't reconstruct an
 * event-level listing.
 *
 * 2 metrics. `main` grain (action, peer_ip, return_code, is_error,
 * error_function) + count (only 18 combos). All 5 dims are heavily nullable
 * (peer_ip/return_code/error_function ~90% null, action ~27%): the aggregate
 * fillnull's them to "(none)" to preserve TOTAL counts, and reads exclude
 * "(none)" to reproduce the raw `field=*` / dc() / `stats by` drop-null
 * semantics. `errdetail` (error_function + per-bucket latest(error_detail))
 * serves the Error-Detail table's free-text "Last Error Detail" column,
 * left-joined onto the main-derived Count/dc(peer_ip)/values(return_code). The
 * Return-Code pie stores the raw numeric code and decodes it at READ time
 * (RC_DECODE) so the precompute stays code-agnostic.
 *
 * Read idiom: `| inputlookup <coll> where metric=X | addinfo | where bucket_ts
 * range | <agg>`; addinfo carries the global TimeRange picker.
 */
const ROLL = 'logserv_saprouter_rollup';
const RANGE = '| addinfo | where bucket_ts>=info_min_time AND bucket_ts<info_max_time';
const MAIN = `| inputlookup ${ROLL} where metric="main" ${RANGE}`;
const ERRDETAIL = `| inputlookup ${ROLL} where metric="errdetail" ${RANGE}`;

// Decode SAP Router numeric return codes (from NIRC.h — Network Interface
// Return Codes) into "<code> = <description>" labels so the pie chart's slices
// are readable without external lookup. Applied at READ time (the rollup stores
// the raw code). Case-default preserves any unlisted code as "<code> = Other".
const RC_DECODE =
    `eval return_code = case(`
    + `return_code==0, "0 = OK (Success)",`
    + `return_code==-1, "-1 = Timeout",`
    + `return_code==-2, "-2 = Too Many File Descriptors",`
    + `return_code==-3, "-3 = No Free Port",`
    + `return_code==-4, "-4 = Service Unknown",`
    + `return_code==-5, "-5 = Service Already Used",`
    + `return_code==-6, "-6 = No Service Definition",`
    + `return_code==-7, "-7 = No Free Service",`
    + `return_code==-8, "-8 = Select Direction Error",`
    + `return_code==-9, "-9 = Internal Error",`
    + `return_code==-10, "-10 = Ping",`
    + `return_code==-11, "-11 = Dump",`
    + `return_code==-90, "-90 = Connection Broken",`
    + `return_code==-91, "-91 = Own Hostname Lookup Failed",`
    + `return_code==-92, "-92 = Host Unknown (DNS)",`
    + `return_code==-93, "-93 = Connection Refused",`
    + `return_code==-94, "-94 = Host-to-Address Conversion Failed",`
    + `return_code==-95, "-95 = No Connection",`
    + `return_code==-96, "-96 = Select Aborted",`
    + `return_code==-97, "-97 = Sequence Error",`
    + `return_code==-98, "-98 = No Transport List",`
    + `return_code==-99, "-99 = Timeout",`
    + `1=1, return_code . " = Other"`
    + `)`;

const Q_BASE = {
    // Count KPIs use the empty-safe idiom (`stats count as n, …`): an empty
    // `| inputlookup | stats sum(count)` returns 0 ROWS (not count=0), so the
    // `count as n` anchor forces a row → fillnull → clean 0.
    kpiTotal: `${MAIN} | stats count as n, sum(count) as count | fillnull value=0 count | fields count`,
    kpiErrors: `${MAIN} | search is_error="true" | stats count as n, sum(count) as count | fillnull value=0 count | fields count`,
    kpiInval: `${MAIN} | search action="INVAL DATA" | stats count as n, sum(count) as count | fillnull value=0 count | fields count`,
    kpiPeers: `${MAIN} | stats dc(eval(if(peer_ip="(none)",null(),peer_ip))) as peers`,

    sparkTotal: `${MAIN} | eval _time=bucket_ts | timechart span=1d sum(count) as count | fillnull value=0`,
    sparkErrors: `${MAIN} | search is_error="true" | eval _time=bucket_ts | timechart span=1d sum(count) as count | fillnull value=0`,
    sparkInval: `${MAIN} | search action="INVAL DATA" | eval _time=bucket_ts | timechart span=1d sum(count) as count | fillnull value=0`,
    sparkPeers: `${MAIN} | eval _time=bucket_ts | timechart span=1d dc(eval(if(peer_ip="(none)",null(),peer_ip))) as peers | fillnull value=0`,

    connTrend: `${MAIN} | search action!="(none)" | eval _time=bucket_ts | timechart span=1d sum(count) by action | fillnull value=0`,
    errorTrend: `${MAIN} | search is_error="true" | eval _time=bucket_ts | timechart span=1d sum(count) as "Errors" | fillnull value=0`,
    topPeers: `${MAIN} | search peer_ip!="(none)" | stats sum(count) as "Connections" by peer_ip | sort -Connections | rename peer_ip as "Peer IP"`,
    returnCodes: `${MAIN} | search return_code!="(none)" | ${RC_DECODE} | stats sum(count) as count by return_code | sort -count | rename return_code as "Return Code"`,
    // Error-Detail: Count/dc(peer_ip)/values(return_code) from `main`, left-joined
    // to the `errdetail` metric's latest(error_detail) by error_function (only 3
    // functions, so the join is trivial). dc/values exclude the "(none)" sentinel.
    errorDetail: `${MAIN} | search is_error="true" error_function!="(none)" | stats sum(count) as Count, dc(eval(if(peer_ip="(none)",null(),peer_ip))) as "Unique Peers", values(eval(if(return_code="(none)",null(),return_code))) as "Return Codes" by error_function | join type=left error_function [ ${ERRDETAIL} | eval _time=bucket_ts | stats latest(error_detail) as "Last Error Detail" by error_function ] | sort -Count | rename error_function as "Function"`,
    connLog: `\`sap_logserv_idx_macro\` ${ST} is_connection_event="true" | head 500 | eval Time=strftime(_time, "%Y-%m-%d %H:%M:%S") | eval has_error=if(is_error="true", "Yes", "No") | table Time, action, connection_id, peer_ip, src_ip, src_port, has_error | sort -Time | rename peer_ip as "Peer IP", src_ip as "Source IP", src_port as "Source Port", has_error as "Error", connection_id as "Conn ID"`,
};

/* ---------------------------------------------------------------------------
 * RAW fallbacks for the sub-hour hybrid (session 086). Each is the raw
 * sap:saprouter scan its rollup metric precomputes (reconstructed from the
 * [logserv_saprouter_aggregate] definition — action/peer_ip/return_code/
 * is_error/error_function are search-time fields). The "(none)" fillnull
 * sentinels map to raw `field=*` / stats-by null-drop; RC_DECODE is reused;
 * errorDetail is a raw self-join for the latest(error_detail) column. Only
 * connLog stays raw + the sparklines cached (cosmetic).
 * ------------------------------------------------------------------------- */
const SRRAW = `\`sap_logserv_idx_macro\` ${ST}`;
const QRAW_BASE = {
    kpiTotal: `${SRRAW} | stats count`,
    kpiErrors: `${SRRAW} is_error="true" | stats count`,
    kpiInval: `${SRRAW} action="INVAL DATA" | stats count`,
    kpiPeers: `${SRRAW} | stats dc(peer_ip) as peers`,
    connTrend: `${SRRAW} action=* | timechart span=1d count by action | fillnull value=0`,
    errorTrend: `${SRRAW} is_error="true" | timechart span=1d count as "Errors" | fillnull value=0`,
    topPeers: `${SRRAW} peer_ip=* | stats count as "Connections" by peer_ip | sort -Connections | rename peer_ip as "Peer IP"`,
    returnCodes: `${SRRAW} return_code=* | ${RC_DECODE} | stats count by return_code | sort -count | rename return_code as "Return Code"`,
    // Single-pass stats (latest(error_detail) folded into the same aggregation,
    // no join) — byte-equal to the cached errdetail-metric join, avoids join
    // subsearch finalization flakiness at scale.
    errorDetail: `${SRRAW} is_error="true" error_function=* | stats count as Count, dc(peer_ip) as "Unique Peers", values(return_code) as "Return Codes", latest(error_detail) as "Last Error Detail" by error_function | sort -Count | rename error_function as "Function"`,
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
/** useFirstRowField over a hybrid cached/raw pair (session 086). */
const useFirstRowFieldHybrid = (cached: string, raw: string, f: string): FirstRow => {
    const search = useHybridSearch({ cached, raw });
    const { results, loading, error } = search;
    const value = results && results[0] ? (results[0] as Record<string, unknown>)[f] : undefined;
    return { value, loading, error, search };
};

const TOP_PEERS_COLS: ColumnDef[] = [
    { key: 'Peer IP', label: 'Peer IP' },
    { key: 'Connections', label: 'Connections', align: 'right', render: (v) => formatInteger(v) },
];
const ERROR_DETAIL_COLS: ColumnDef[] = [
    { key: 'Function', label: 'Function' },
    { key: 'Count', label: 'Count', align: 'right', render: (v) => formatInteger(v) },
    { key: 'Unique Peers', label: 'Unique Peers', align: 'right', render: (v) => formatInteger(v) },
    { key: 'Return Codes', label: 'Return Codes' },
    { key: 'Last Error Detail', label: 'Last Error Detail' },
];
const CONN_LOG_COLS: ColumnDef[] = [
    { key: 'Time', label: 'Time', width: '160px' },
    { key: 'action', label: 'Action', width: '120px' },
    { key: 'Conn ID', label: 'Conn ID', width: '90px' },
    { key: 'Peer IP', label: 'Peer IP', width: '140px' },
    { key: 'Source IP', label: 'Source IP', width: '140px' },
    { key: 'Source Port', label: 'Source Port', width: '100px' },
    { key: 'Error', label: 'Error', width: '70px' },
];

const SapRouter: React.FC = () => {
    const { provider } = useCloudProvider();
    const Q = React.useMemo(() => mapCloudProviderQueries(Q_BASE, provider), [provider]);
    // RAW fallbacks for the sub-hour hybrid (session 086); same cloud mapping so both arms filter identically.
    const QRAW = React.useMemo(() => mapCloudProviderQueries(QRAW_BASE, provider), [provider]);
    const total = useFirstRowFieldHybrid(Q.kpiTotal, QRAW.kpiTotal, 'count');
    const errors = useFirstRowFieldHybrid(Q.kpiErrors, QRAW.kpiErrors, 'count');
    const inval = useFirstRowFieldHybrid(Q.kpiInval, QRAW.kpiInval, 'count');
    const peers = useFirstRowFieldHybrid(Q.kpiPeers, QRAW.kpiPeers, 'peers');

    const topPeers = useHybridSearch({ cached: Q.topPeers, raw: QRAW.topPeers });
    const errorDetail = useHybridSearch({ cached: Q.errorDetail, raw: QRAW.errorDetail });
    const connLog = useSearch({ query: Q.connLog }); // raw listing

    // Charts / pie take a query string → route once each (sub-hour -> raw).
    const qConnTrend = useRoutedQuery(Q.connTrend, QRAW.connTrend);
    const qErrorTrend = useRoutedQuery(Q.errorTrend, QRAW.errorTrend);
    const qReturnCodes = useRoutedQuery(Q.returnCodes, QRAW.returnCodes);

    const errorTone = Number(errors.value ?? 0) > 0 ? 'critical' : 'neutral';
    const invalTone = Number(inval.value ?? 0) > 0 ? 'warning' : 'neutral';

    /* Drilldowns (build 159 / session 027 task 6). */
    const { timeRange } = useTimeRange();
    const goPeerRow = (row: Record<string, unknown>): void => {
        const ip = String(row['Peer IP'] ?? '');
        if (!ip) return;
        const spl = `\`sap_logserv_idx_macro\` ${ST} peer_ip="${splQuote(ip)}" | sort -_time | table _time action connection_id src_ip return_code`;
        openInNewTab(buildSplunkSearchUrl(spl, timeRange.earliest, timeRange.latest));
    };
    const goErrorFunctionRow = (row: Record<string, unknown>): void => {
        const fn = String(row.Function ?? '');
        if (!fn) return;
        const spl = `\`sap_logserv_idx_macro\` ${ST} is_error="true" error_function="${splQuote(fn)}" | sort -_time`;
        openInNewTab(buildSplunkSearchUrl(spl, timeRange.earliest, timeRange.latest));
    };
    const goConnLogRow = (row: Record<string, unknown>): void => {
        const peer = String(row['Peer IP'] ?? '');
        const src = String(row['Source IP'] ?? '');
        if (!peer && !src) return;
        const peerClause = peer ? `peer_ip="${splQuote(peer)}" ` : '';
        const srcClause = src ? `src_ip="${splQuote(src)}" ` : '';
        const spl = `\`sap_logserv_idx_macro\` ${ST} ${peerClause}${srcClause}| sort -_time`;
        openInNewTab(buildSplunkSearchUrl(spl, timeRange.earliest, timeRange.latest));
    };

    return (
        <DashboardLayout
            category="INTEGRATION"
            title="SAP Router"
            subtitle="SAP Router connection activity, error analysis, and network boundary monitoring"
        >
            <KpiRow>
                <KpiCard label="Total Router Events" value={total.value} loading={total.loading} error={total.error} search={total.search} formatValue={formatInteger}
                    sparkline={<SparklineFromQuery query={Q.sparkTotal} valueField="count" fill />} />
                <KpiCard label="Router Errors" value={errors.value} loading={errors.loading} error={errors.error} search={errors.search} formatValue={formatInteger} tone={errorTone}
                    sparkline={<SparklineFromQuery query={Q.sparkErrors} valueField="count" color={logservTheme.colors.red} fill />} />
                <KpiCard label="Invalid Data Events" value={inval.value} loading={inval.loading} error={inval.error} search={inval.search} formatValue={formatInteger} tone={invalTone}
                    sparkline={<SparklineFromQuery query={Q.sparkInval} valueField="count" color={logservTheme.colors.orange} fill />} />
                <KpiCard label="Unique Peer IPs" value={peers.value} loading={peers.loading} error={peers.error} search={peers.search} formatValue={formatInteger}
                    sparkline={<SparklineFromQuery query={Q.sparkPeers} valueField="peers" fill />} />
            </KpiRow>

            <PanelGrid2>
                <FramedPanel title="Connection Actions Over Time" subtitle="Daily volume by action (CONNECT/DISCONNECT/etc.)">
                    <TimeSeriesChart query={qConnTrend} height={280} palette="volume" />
                </FramedPanel>
                <FramedPanel title="Router Errors Over Time" subtitle="Daily error count">
                    <TimeSeriesChart query={qErrorTrend} height={280} palette="errors" />
                </FramedPanel>
            </PanelGrid2>

            <PanelGrid2>
                <FramedPanel search={topPeers} title="Peer IPs by Connection Volume" subtitle="Peers ranked by connection count">
                    <DataTable columns={TOP_PEERS_COLS} rows={topPeers.results} loading={topPeers.loading} error={topPeers.error} emptyMessage="No router events in this time range." onRowClick={goPeerRow} />
                </FramedPanel>
                <FramedPanel title="Return Code Distribution" subtitle="Share of router events by return code">
                    <PieChart query={qReturnCodes} categoryField="Return Code" valueField="count" height={280} donut />
                </FramedPanel>
            </PanelGrid2>

            <FullWidthPanel>
                <FramedPanel search={errorDetail} title="Error Detail by Function" subtitle="Errors grouped by error_function">
                    <DataTable columns={ERROR_DETAIL_COLS} rows={errorDetail.results} loading={errorDetail.loading} error={errorDetail.error} emptyMessage="No router errors in this time range." initialSortKey="Count" initialSortDir="desc" pageSize={5} onRowClick={goErrorFunctionRow} />
                </FramedPanel>
            </FullWidthPanel>

            <FullWidthPanel>
                <FramedPanel search={connLog} title="Recent Connection Log" subtitle="Connection events with peer/src IPs, most-recent first">
                    <DataTable columns={CONN_LOG_COLS} rows={connLog.results} loading={connLog.loading} error={connLog.error} emptyMessage="No connection events in this time range." initialSortKey="Time" initialSortDir="desc" onRowClick={goConnLogRow} />
                </FramedPanel>
            </FullWidthPanel>
        </DashboardLayout>
    );
};

export default SapRouter;
