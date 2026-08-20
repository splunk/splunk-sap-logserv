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
import { buildDashboardUrl, buildSplunkSearchUrl, openInNewTab, splQuote } from '../utils/drilldownUrls';
import { logservTheme } from '../styles/logservTheme';

/**
 * ABAP Network & Security — honest port of v0.0.4.2 logserv_abap_security.xml.
 *
 * 3 KPIs (Total / ICM Errors / Gateway Errors) + Volume by Sourcetype line +
 * ICM Status Codes column + ICM Peers table + ICM Request Types pie + Gateway
 * Hosts table + Gateway Errors line + SID/Instance column.
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
    grid-template-columns: 2fr 1fr 2fr;
    gap: ${logservTheme.elevation.panelGap};
    margin-bottom: ${logservTheme.elevation.panelGap};
    @media (max-width: 1400px) { grid-template-columns: 1fr; }
`;
const PieStack = styled.div`
    display: flex;
    flex-direction: column;
    gap: ${logservTheme.elevation.panelGap};
`;

/**
 * Dashboard-perf roadmap tier #6 (KV-Store precompute, session 052 / build 217).
 *
 * ABAP Network & Security spans 3 sourcetypes (sap:abap:audit/gateway/icm) and
 * has 11 aggregatable panels (no RAW listings). All now read from the
 * `logserv_abapnet_rollup` KV Store collection, populated hourly by
 * [logserv_abapnet_aggregate] (one-time [logserv_abapnet_backfill]). The schema
 * was adversarially design-reviewed pre-build.
 *
 * 7 metrics: `vol` (sourcetype/sid/instance) → Total KPI + Volume-by-Sourcetype
 * + SID/Instance (sid+instance fillnull'd so the KPI/volume panels sum over ALL
 * rows — raw doesn't group by sid; only sidInstance excludes "(none)"); `icmstat`
 * (status_cat, classified in-aggregate) → ICM Status timechart+pie; `icmreq`
 * (raw request_type, decoded at READ) → ICM Request Types pie; `icmpeer`
 * (peer_ip/txn/protocol) → ICM Peers (dc/values); `icmerr` (per-bucket count,
 * `icm_is_error="true"` — build-218 fix of the original `=1` string-vs-number
 * bug; props.conf EVAL sets icm_is_error="true" iff icm_status_code is 4xx/5xx;
 * 0 on data with no 4xx/5xx ICM events, real count otherwise; task_7e242b2b)
 * → ICM Errors KPI; `gwhost`
 * (rhost/func/svc) → Gateway Hosts Events + Services; `gwlatest` (rhost/func +
 * count + latest(error_detail), error events only) → Gateway Errors KPI/timeline
 * + the Gateway Hosts "Last Error" column (left-joined on rhost+func).
 *
 * Read idiom: `| inputlookup <coll> where metric=X | addinfo | where bucket_ts
 * range | <agg>`; nullable dims fillnull'd to "(none)", reads exclude it.
 */
const ROLL = 'logserv_abapnet_rollup';
const RANGE = '| addinfo | where bucket_ts>=info_min_time AND bucket_ts<info_max_time';
const VOL = `| inputlookup ${ROLL} where metric="vol" ${RANGE}`;
const ICMSTAT = `| inputlookup ${ROLL} where metric="icmstat" ${RANGE}`;
const ICMREQ = `| inputlookup ${ROLL} where metric="icmreq" ${RANGE}`;
const ICMPEER = `| inputlookup ${ROLL} where metric="icmpeer" ${RANGE}`;
const ICMERR = `| inputlookup ${ROLL} where metric="icmerr" ${RANGE}`;
const GWHOST = `| inputlookup ${ROLL} where metric="gwhost" ${RANGE}`;
const GWLATEST = `| inputlookup ${ROLL} where metric="gwlatest" ${RANGE}`;

const Q_BASE = {
    // Count KPIs use the empty-safe `stats count as n, …` idiom (icmerr is a
    // 0-row metric → kpiIcmErrors must read 0, not blank).
    kpiTotal: `${VOL} | stats count as n, sum(count) as count | fillnull value=0 count | fields count`,
    kpiIcmErrors: `${ICMERR} | stats count as n, sum(count) as count | fillnull value=0 count | fields count`,
    kpiGwErrors: `${GWLATEST} | stats count as n, sum(count) as count | fillnull value=0 count | fields count`,

    sparkTotal: `${VOL} | eval _time=bucket_ts | timechart span=1d sum(count) as count | fillnull value=0`,
    sparkIcmErrors: `${ICMERR} | eval _time=bucket_ts | timechart span=1d sum(count) as count | fillnull value=0`,
    sparkGwErrors: `${GWLATEST} | eval _time=bucket_ts | timechart span=1d sum(count) as count | fillnull value=0`,

    volumeByType: `${VOL} | eval _time=bucket_ts | timechart span=1d sum(count) by sourcetype | fillnull value=0`,
    icmStatus: `${ICMSTAT} | eval _time=bucket_ts | timechart span=1d sum(count) by status_cat | fillnull value=0`,
    icmStatusPie: `${ICMSTAT} | stats sum(count) as count by status_cat | sort status_cat`,
    icmPeers: `${ICMPEER} | stats sum(count) as Requests, dc(eval(if(icm_transaction_id="(none)",null(),icm_transaction_id))) as Transactions, values(eval(if(icm_protocol="(none)",null(),icm_protocol))) as Protocols by icm_peer_ip | sort -Requests | rename icm_peer_ip as "Peer IP"`,
    // Decode ICM request type codes (ASYNC_RFC / HTTP_NORMAL / INTERNAL → plain
    // English) at READ — the rollup stores the raw code (code-agnostic precompute).
    icmRequestTypes: `${ICMREQ} `
        + `| eval icm_request_type = case(`
        + `icm_request_type=="ASYNC_RFC", "Asynchronous RFC",`
        + `icm_request_type=="HTTP_NORMAL", "HTTP Request",`
        + `icm_request_type=="INTERNAL", "Internal Call",`
        + `1=1, icm_request_type`
        + `) `
        + `| stats sum(count) as count by icm_request_type | sort -count`,
    // Two-metric panel: Events + Services from `gwhost` (both dims (none)-excluded,
    // mirroring raw `by rhost func` null-drop), left-joined to `gwlatest`'s
    // latest(gw_error_detail) for the "Last Error" column.
    gwHosts: `${GWHOST} | stats sum(count) as Events, values(eval(if(gw_service="(none)",null(),gw_service))) as Services by gw_remote_host gw_function | search gw_remote_host!="(none)" gw_function!="(none)" | join type=left gw_remote_host gw_function [ ${GWLATEST} | eval _time=bucket_ts | stats latest(gw_error_detail) as "Last Error" by gw_remote_host gw_function | search gw_remote_host!="(none)" gw_function!="(none)" ] | sort -Events | rename gw_remote_host as "Remote Host" gw_function as "Function"`,
    gwErrorsTimeline: `${GWLATEST} | eval _time=bucket_ts | timechart span=1d sum(count) as "Gateway Errors" | fillnull value=0`,
    sidInstance: `${VOL} | search sap_sid!="(none)" sap_instance!="(none)" | stats sum(count) as count by sap_sid sap_instance | sort -count`,
};

/* ---------------------------------------------------------------------------
 * RAW fallbacks for the sub-hour hybrid (session 086). Each is the raw ABAP
 * scan its rollup metric precomputes (reconstructed from
 * [logserv_abapnet_aggregate] — status_cat + the ICM request-type decode are
 * reused). "(none)" sentinels map to raw `field=*` / stats-by null-drop. gwHosts
 * folds latest(gw_error_detail) into one pass (latest = latest NON-NULL, and
 * gw_error_detail is null on non-error events, so it = the latest error detail —
 * no join needed). "Last Error" is a latest-value column (byte-exact on real
 * distinct-timestamp data, tie-ambiguous on the bulk-loaded demo).
 * ------------------------------------------------------------------------- */
const RAW_ABAP3 = '`sap_logserv_idx_macro` sourcetype IN ("sap:abap:audit","sap:abap:gateway","sap:abap:icm")';
const RAW_ICM = '`sap_logserv_idx_macro` sourcetype="sap:abap:icm"';
const RAW_GW = '`sap_logserv_idx_macro` sourcetype="sap:abap:gateway"';
const STATUS_CAT = 'eval status_cat=case(icm_status_code>=200 AND icm_status_code<300, "2xx", icm_status_code>=300 AND icm_status_code<400, "3xx", icm_status_code>=400 AND icm_status_code<500, "4xx", icm_status_code>=500, "5xx", 1=1, "Other")';
const ICM_REQ_DECODE = 'eval icm_request_type = case(icm_request_type=="ASYNC_RFC", "Asynchronous RFC", icm_request_type=="HTTP_NORMAL", "HTTP Request", icm_request_type=="INTERNAL", "Internal Call", 1=1, icm_request_type)';
const QRAW_BASE = {
    kpiTotal: `${RAW_ABAP3} | stats count`,
    kpiIcmErrors: `${RAW_ICM} icm_is_error="true" | stats count`,
    kpiGwErrors: `${RAW_GW} gw_error_detail=* gw_error_detail!="" | stats count`,
    volumeByType: `${RAW_ABAP3} | timechart span=1d count by sourcetype | fillnull value=0`,
    icmStatus: `${RAW_ICM} icm_status_code=* | ${STATUS_CAT} | timechart span=1d count by status_cat | fillnull value=0`,
    icmStatusPie: `${RAW_ICM} icm_status_code=* | ${STATUS_CAT} | stats count by status_cat | sort status_cat`,
    icmPeers: `${RAW_ICM} icm_peer_ip=* | stats count as Requests, dc(icm_transaction_id) as Transactions, values(icm_protocol) as Protocols by icm_peer_ip | sort -Requests | rename icm_peer_ip as "Peer IP"`,
    icmRequestTypes: `${RAW_ICM} icm_request_type=* | ${ICM_REQ_DECODE} | stats count by icm_request_type | sort -count`,
    gwHosts: `${RAW_GW} | stats count as Events, values(gw_service) as Services, latest(gw_error_detail) as "Last Error" by gw_remote_host gw_function | sort -Events | rename gw_remote_host as "Remote Host" gw_function as "Function"`,
    gwErrorsTimeline: `${RAW_GW} gw_error_detail=* gw_error_detail!="" | timechart span=1d count as "Gateway Errors" | fillnull value=0`,
    sidInstance: `${RAW_ABAP3} | stats count by sap_sid sap_instance | sort -count`,
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

const ICM_PEER_COLS: ColumnDef[] = [
    { key: 'Peer IP', label: 'Peer IP' },
    { key: 'Requests', label: 'Requests', align: 'right', render: (v) => formatInteger(v) },
    { key: 'Transactions', label: 'Transactions', align: 'right', render: (v) => formatInteger(v) },
    { key: 'Protocols', label: 'Protocols' },
];
const GW_HOST_COLS: ColumnDef[] = [
    { key: 'Remote Host', label: 'Remote Host' },
    { key: 'Function', label: 'Function' },
    { key: 'Events', label: 'Events', align: 'right', render: (v) => formatInteger(v) },
    { key: 'Services', label: 'Services' },
    { key: 'Last Error', label: 'Last Error' },
];

const AbapSecurity: React.FC = () => {
    const { provider } = useCloudProvider();
    const Q = React.useMemo(() => mapCloudProviderQueries(Q_BASE, provider), [provider]);
    // RAW fallbacks for the sub-hour hybrid (session 086); same cloud mapping so both arms filter identically.
    const QRAW = React.useMemo(() => mapCloudProviderQueries(QRAW_BASE, provider), [provider]);
    const total = useFirstRowFieldHybrid(Q.kpiTotal, QRAW.kpiTotal, 'count');
    const icmErrors = useFirstRowFieldHybrid(Q.kpiIcmErrors, QRAW.kpiIcmErrors, 'count');
    const gwErrors = useFirstRowFieldHybrid(Q.kpiGwErrors, QRAW.kpiGwErrors, 'count');

    const icmPeers = useHybridSearch({ cached: Q.icmPeers, raw: QRAW.icmPeers });
    const gwHosts = useHybridSearch({ cached: Q.gwHosts, raw: QRAW.gwHosts });

    // Charts / pies take a query string → route once each (sub-hour -> raw).
    const qVolumeByType = useRoutedQuery(Q.volumeByType, QRAW.volumeByType);
    const qIcmStatus = useRoutedQuery(Q.icmStatus, QRAW.icmStatus);
    const qIcmStatusPie = useRoutedQuery(Q.icmStatusPie, QRAW.icmStatusPie);
    const qIcmRequestTypes = useRoutedQuery(Q.icmRequestTypes, QRAW.icmRequestTypes);
    const qGwErrorsTimeline = useRoutedQuery(Q.gwErrorsTimeline, QRAW.gwErrorsTimeline);
    const qSidInstance = useRoutedQuery(Q.sidInstance, QRAW.sidInstance);

    const icmTone = Number(icmErrors.value ?? 0) > 0 ? 'critical' : 'neutral';
    const gwTone = Number(gwErrors.value ?? 0) > 0 ? 'critical' : 'neutral';

    /* Drilldowns (build 159 / session 027 task 6). */
    const { timeRange } = useTimeRange();
    const goSidInstanceChart = (): void => {
        openInNewTab(buildDashboardUrl('abap-operations', timeRange.earliest, timeRange.latest));
    };
    const goIcmPeerRow = (row: Record<string, unknown>): void => {
        const ip = String(row['Peer IP'] ?? '');
        if (!ip) return;
        const spl = `\`sap_logserv_idx_macro\` sourcetype="sap:abap:icm" icm_peer_ip="${splQuote(ip)}" | sort -_time`;
        openInNewTab(buildSplunkSearchUrl(spl, timeRange.earliest, timeRange.latest));
    };
    const goGwHostRow = (row: Record<string, unknown>): void => {
        const host = String(row['Remote Host'] ?? '');
        if (!host) return;
        const spl = `\`sap_logserv_idx_macro\` sourcetype="sap:abap:gateway" gw_remote_host="${splQuote(host)}" | sort -_time`;
        openInNewTab(buildSplunkSearchUrl(spl, timeRange.earliest, timeRange.latest));
    };

    return (
        <DashboardLayout
            category="APPLICATIONS"
            title="ABAP Network & Security"
            subtitle="Network-facing ABAP components — ICM connections, gateway remote hosts, and security audit events"
        >
            <KpiRow>
                <KpiCard label="Total Events" value={total.value} loading={total.loading} error={total.error} search={total.search} formatValue={formatInteger}
                    sparkline={<SparklineFromQuery query={Q.sparkTotal} valueField="count" fill />} />
                <KpiCard label="ICM Errors" value={icmErrors.value} loading={icmErrors.loading} error={icmErrors.error} search={icmErrors.search} formatValue={formatInteger} tone={icmTone}
                    sparkline={<SparklineFromQuery query={Q.sparkIcmErrors} valueField="count" color={logservTheme.colors.red} fill />} />
                <KpiCard label="Gateway Errors" value={gwErrors.value} loading={gwErrors.loading} error={gwErrors.error} search={gwErrors.search} formatValue={formatInteger} tone={gwTone}
                    sparkline={<SparklineFromQuery query={Q.sparkGwErrors} valueField="count" color={logservTheme.colors.red} fill />} />
            </KpiRow>

            <PanelGrid2>
                <FramedPanel title="Event Volume by Sourcetype" subtitle="Daily volume across audit / gateway / ICM">
                    <TimeSeriesChart query={qVolumeByType} height={280} palette="volume" />
                </FramedPanel>
                <FramedPanel title="ICM Status Codes Over Time" subtitle="Daily ICM responses bucketed 2xx/3xx/4xx/5xx">
                    <TimeSeriesChart query={qIcmStatus} height={280} palette="status" />
                </FramedPanel>
            </PanelGrid2>

            <PanelGrid3>
                <FramedPanel search={icmPeers} title="ICM Peer Connections" subtitle="ICM peer IPs ranked by request count — click a row for that peer's full ICM event log">
                    <DataTable columns={ICM_PEER_COLS} rows={icmPeers.results} loading={icmPeers.loading} error={icmPeers.error} emptyMessage="No ICM peer activity in this time range." pageSize={17} onRowClick={goIcmPeerRow} />
                </FramedPanel>
                <PieStack>
                    <FramedPanel title="ICM Request Types" subtitle="Distribution by HTTP method">
                        <PieChart query={qIcmRequestTypes} categoryField="icm_request_type" valueField="count" height={310} donut />
                    </FramedPanel>
                    <FramedPanel title="ICM Status Code Distribution" subtitle="Overall mix of 2xx / 3xx / 4xx / 5xx responses">
                        <PieChart query={qIcmStatusPie} categoryField="status_cat" valueField="count" height={310} donut palette="status" />
                    </FramedPanel>
                </PieStack>
                <FramedPanel search={gwHosts} title="Gateway Remote Hosts" subtitle="Gateway peer hosts + functions ranked by event count — click a row for that host's full gateway event log">
                    <DataTable columns={GW_HOST_COLS} rows={gwHosts.results} loading={gwHosts.loading} error={gwHosts.error} emptyMessage="No gateway events in this time range." pageSize={17} onRowClick={goGwHostRow} />
                </FramedPanel>
            </PanelGrid3>

            <PanelGrid2>
                <FramedPanel title="Gateway Errors Over Time" subtitle="Daily gateway error count">
                    <TimeSeriesChart query={qGwErrorsTimeline} height={280} palette="errors" />
                </FramedPanel>
                <FramedPanel title="Activity by SID / Instance" subtitle="SID + instance combos ranked by event volume — click to open ABAP Operations"
                    onClick={goSidInstanceChart} clickTitle="Open ABAP Operations dashboard">
                    <TimeSeriesChart query={qSidInstance} height={280} palette="volume" />
                </FramedPanel>
            </PanelGrid2>
        </DashboardLayout>
    );
};

export default AbapSecurity;
