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
import { buildHostDetailsUrl, buildSplunkSearchUrl, openInNewTab, splQuote } from '../utils/drilldownUrls';
import { logservTheme } from '../styles/logservTheme';

/**
 * Network Perimeter — honest port of v0.0.4.2 logserv_network_perimeter.xml.
 *
 * 6 KPIs (FW Drops / Proxy / DNS / Beaconing / Denied / Bandwidth) + Activity Over Time +
 * Top Blocked Source IPs + Top Blocked Dest Ports + Firewall Drops by Protocol +
 * Proxy Denied Traffic + Top Outbound Domains + DNS Query Type pie + Top Queried Domains +
 * Suspicious Activity Indicator (synthesis).
 */

const KpiRow = styled.div`
    display: grid;
    grid-template-columns: repeat(6, minmax(0, 1fr));
    gap: ${logservTheme.elevation.panelGap};
    margin-bottom: ${logservTheme.elevation.panelGap};
    @media (max-width: 1500px) { grid-template-columns: repeat(3, minmax(0, 1fr)); }
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
/** 30 / 70 split: pie left + table right. */
const PanelGrid30_70 = styled.div`
    display: grid;
    grid-template-columns: 3fr 7fr;
    gap: ${logservTheme.elevation.panelGap};
    margin-bottom: ${logservTheme.elevation.panelGap};
    @media (max-width: 1100px) { grid-template-columns: 1fr; }
`;

/**
 * Dashboard-perf roadmap tier #6 (KV-Store precompute, session 052 / build 220).
 *
 * Network Perimeter is a cross-source firewall + proxy + DNS synthesis. The 18
 * aggregatable count/sum/dc panels below now read from the `logserv_perimeter_rollup`
 * KV Store collection, populated hourly by [logserv_perimeter_aggregate] (one-time
 * [logserv_perimeter_backfill]). Beaconing KPI + sparkline (build 232) reuse the
 * per-day `logserv_beaconing_rollup` (byte-identical to the kpiBeacon streamstats
 * dc(query) computation). Only the `suspicious` synthesis table stays RAW —
 * per-event streamstats inter-arrival gap-variance analysis over the (query,src)
 * stream cannot be reconstructed byte-exact from additive hourly count buckets.
 *
 * 7 metrics (design adversarially reviewed pre-build; verdict: ship). `fw`
 * (fw_action, fw_src, fw_dst, fw_dpt, fw_proto, host) over ALL linux_secure (rex
 * from _raw, all fillnull'd) — MERGES the IN_DROP-scoped KPIs (read filters
 * fw_action="IN_DROP") with the all-secure-scoped block tables (NO IN_DROP filter
 * — a latent dashboard imprecision REPLICATED, not fixed). `proxy` per-bucket
 * count/denied_count/bytes_sum. `proxydom` (url_domain, src_ip) for outDomains.
 * `dnscount` (full tag=dns/Query scope) for kpiDns/sparkDns. `dnstype`
 * (query_type) for dnsType. `dnsq` (query, src)+txt/mx measures for queried.
 * `activity` (source_type) kept SEPARATE (different filter forms / event
 * populations than the KPIs).
 *
 * Read idiom: `| inputlookup <coll> where metric=X | addinfo | where bucket_ts
 * range | <agg>`. Count KPIs use the empty-safe idiom; COUNT timecharts append
 * `| fillnull value=0` (raw count 0-fills, rollup sum(count) null-fills) — but
 * sparkBw (a sum-measure timechart) does NOT (both null-fill empty bins).
 * decode-at-read for proto_name / query_type_label.
 */
const ROLL = 'logserv_perimeter_rollup';
const RANGE = '| addinfo | where bucket_ts>=info_min_time AND bucket_ts<info_max_time';
const FW = `| inputlookup ${ROLL} where metric="fw" ${RANGE}`;
const PROXY = `| inputlookup ${ROLL} where metric="proxy" ${RANGE}`;
const PROXYDOM = `| inputlookup ${ROLL} where metric="proxydom" ${RANGE}`;
const DNSCOUNT = `| inputlookup ${ROLL} where metric="dnscount" ${RANGE}`;
const DNSTYPE = `| inputlookup ${ROLL} where metric="dnstype" ${RANGE}`;
const DNSQ = `| inputlookup ${ROLL} where metric="dnsq" ${RANGE}`;
const ACTIVITY = `| inputlookup ${ROLL} where metric="activity" ${RANGE}`;
// Beaconing KPI + spark reuse the per-day beaconing rollup (build 232).
const BEACON = '| inputlookup logserv_beaconing_rollup | addinfo | where day_ts>=info_min_time AND day_ts<info_max_time';
// Build 237 — per-day beaconing DETAIL rollup (qs gap-stats + denied counts).
// Approximate (per-day gaps), picker-responsive. Drives the Suspicious table.
const BCN_QS = '| inputlookup logserv_beaconing_detail_rollup where metric="qs" | addinfo | where day_ts>=info_min_time AND day_ts<info_max_time';
const BCN_DENIED = '| inputlookup logserv_beaconing_detail_rollup where metric="denied" | addinfo | where day_ts>=info_min_time AND day_ts<info_max_time';
// Byte-size formatter (raw GB/MB/KB/B case), reused for kpiBw + outDomains.
const bytesFmt = (f: string): string =>
    `case(${f} >= 1073741824, tostring(round(${f}/1073741824, 2)) . " GB", ${f} >= 1048576, tostring(round(${f}/1048576, 1)) . " MB", ${f} >= 1024, tostring(round(${f}/1024, 0)) . " KB", 1=1, tostring(${f}) . " B")`;
const PROTO_NAME = 'case(fw_proto="TCP" OR fw_proto="6", "TCP", fw_proto="UDP" OR fw_proto="17", "UDP", fw_proto="ICMP" OR fw_proto="1", "ICMP", 1=1, fw_proto)';
const QTYPE_LABEL = 'case(query_type="A", "A (IPv4 Address)", query_type="AAAA", "AAAA (IPv6 Address)", query_type="CNAME", "CNAME (Canonical Name)", query_type="MX", "MX (Mail Exchange)", query_type="NS", "NS (Name Server)", query_type="PTR", "PTR (Reverse DNS)", query_type="SOA", "SOA (Start of Authority)", query_type="SRV", "SRV (Service)", query_type="TXT", "TXT (Text)", query_type="HINFO", "HINFO (Host Info)", query_type="ANY", "ANY (Any Type)", query_type="NAPTR", "NAPTR (Naming Authority Pointer)", query_type="DS", "DS (Delegation Signer)", query_type="DNSKEY", "DNSKEY (DNS Key)", query_type="RRSIG", "RRSIG (Resource Record Signature)", query_type="NSEC", "NSEC (Next Secure)", query_type="CAA", "CAA (Certificate Authority Authorization)", 1=1, query_type)';

const Q = {
    kpiFw: `${FW} | search fw_action="IN_DROP" | stats count as n, sum(count) as count | fillnull value=0 count | fields count`,
    kpiProxy: `${PROXY} | stats count as n, sum(count) as count | fillnull value=0 count | fields count`,
    kpiDns: `${DNSCOUNT} | stats count as n, sum(count) as count | fillnull value=0 count | fields count`,
    kpiBeacon: `${BEACON} | stats count as n, sum(count) as count | fillnull value=0 count | fields count`,
    kpiDenied: `${PROXY} | stats count as n, sum(denied_count) as count | fillnull value=0 count | fields count`,
    kpiBw: `${PROXY} | stats count as n, sum(bytes_sum) as total_bytes | fillnull value=0 total_bytes | eval display = ${bytesFmt('total_bytes')} | fields display`,

    sparkFw: `${FW} | search fw_action="IN_DROP" | eval _time=bucket_ts | timechart span=1d sum(count) as count | fillnull value=0`,
    sparkProxy: `${PROXY} | eval _time=bucket_ts | timechart span=1d sum(count) as count | fillnull value=0`,
    sparkDns: `${DNSCOUNT} | eval _time=bucket_ts | timechart span=1d sum(count) as count | fillnull value=0`,
    sparkBeacon: `${BEACON} | eval _time=day_ts | timechart span=1d sum(count) as daily | fillnull value=0`,
    sparkDenied: `${PROXY} | eval _time=bucket_ts | timechart span=1d sum(denied_count) as count | fillnull value=0`,
    // sparkBw is a SUM-measure timechart -> NO fillnull-0 (both raw and rollup
    // null-fill empty bins; the count-spark 0-fill rule does NOT apply here).
    sparkBw: `${PROXY} | eval _time=bucket_ts | timechart span=1d sum(bytes_sum) as bytes_daily | eval daily = round(bytes_daily/1048576, 2)`,

    activity: `${ACTIVITY} | eval _time=bucket_ts | timechart span=1d sum(count) by source_type | fillnull value=0`,
    blockedSrc: `${FW} | search fw_src!="(none)" | stats sum(count) as Drops, dc(eval(if(fw_dst="(none)",null(),fw_dst))) as "Unique Targets", values(eval(if(fw_proto="(none)",null(),fw_proto))) as Protocols by fw_src | sort -Drops | rename fw_src as "Source IP"`,
    // blockedPort adds fw_proto!="(none)" because raw `stats by fw_dpt, fw_proto`
    // drops a null-proto group (a DPT-present-but-PROTO-absent event).
    blockedPort: `${FW} | search fw_dpt!="(none)" fw_proto!="(none)" | stats sum(count) as Drops, dc(eval(if(host="(none)",null(),host))) as Hosts by fw_dpt, fw_proto | sort -Drops | rename fw_dpt as "Dest Port", fw_proto as Protocol`,
    fwProto: `${FW} | search fw_action="IN_DROP" fw_proto!="(none)" | eval proto_name = ${PROTO_NAME} | eval _time=bucket_ts | timechart span=1d sum(count) by proto_name | fillnull value=0`,
    proxyDenied: `${PROXY} | eval _time=bucket_ts | timechart span=1d sum(denied_count) as "Denied Requests" | fillnull value=0`,
    outDomains: `${PROXYDOM} | stats sum(count) as Requests, sum(bytes_sum) as bytes, dc(eval(if(src_ip="(none)",null(),src_ip))) as "Unique Clients" by url_domain | eval Bandwidth = ${bytesFmt('bytes')} | sort -bytes | table url_domain, Requests, Bandwidth, "Unique Clients" | rename url_domain as "Domain"`,
    dnsType: `${DNSTYPE} | eval query_type_label = ${QTYPE_LABEL} | stats sum(count) as count by query_type_label | sort -count | rename query_type_label as "Query Type"`,
    queried: `${DNSQ} | stats sum(count) as Queries, dc(eval(if(src="(none)",null(),src))) as "Unique Clients", sum(txt_count) as txt_count, sum(mx_count) as mx_count by query | eval pct_txt = tostring(round(txt_count*100/Queries, 1)) . "%" | eval pct_mx = tostring(round(mx_count*100/Queries, 1)) . "%" | sort -Queries | table query, Queries, "Unique Clients", pct_txt, pct_mx | rename query as "Domain", pct_txt as "%TXT", pct_mx as "%MX"`,
    // Build 237: reconstructed from the per-day beaconing detail rollup. qs gives
    // per-(query,src) gap-stats (avg/var rebuilt via Σ) → flag beaconing (query,src)
    // → dc(query)+sum by src; denied metric replaces the squid-denied append.
    // Approximate (per-day gaps), picker-responsive. Output columns unchanged.
    suspicious: `${BCN_QS} | search src!="(none)" | stats sum(cnt) as beacon_query_count, sum(n_gap) as ng, sum(sum_gap) as sg, sum(sumsq_gap) as ssg by query, src | eval avg_gap=if(ng>0,sg/ng,0), var_gap=if(ng>1,(ssg - sg*sg/ng)/(ng-1),null()) | where var_gap < 60 AND avg_gap > 0 AND beacon_query_count > 2 | stats dc(query) as beacon_domains, sum(beacon_query_count) as beacon_queries by src | append [ ${BCN_DENIED} | search src!="(none)" | stats sum(denied_count) as denied_requests by src ] | stats max(beacon_domains) as beacon_domains, max(beacon_queries) as beacon_queries, max(denied_requests) as denied_requests by src | fillnull value=0 beacon_domains beacon_queries denied_requests | eval signal_score = (beacon_domains * 3) + denied_requests | where signal_score > 0 | sort -signal_score | rename src as "Host", beacon_domains as "Beaconing Domains", beacon_queries as "Beaconing Queries", denied_requests as "Denied Proxy Requests", signal_score as "Signal Score"`,
};

interface FirstRow { value: unknown; loading: boolean; error: Error | null; }
const useFirstRowField = (q: string, f: string): FirstRow => {
    const { results, loading, error } = useSearch({ query: q });
    const value = results && results[0] ? (results[0] as Record<string, unknown>)[f] : undefined;
    return { value, loading, error };
};

const BLOCKED_SRC_COLS: ColumnDef[] = [
    { key: 'Source IP', label: 'Source IP' },
    { key: 'Drops', label: 'Drops', align: 'right', render: (v) => formatInteger(v) },
    { key: 'Unique Targets', label: 'Unique Targets', align: 'right', render: (v) => formatInteger(v) },
    { key: 'Protocols', label: 'Protocols' },
];
const BLOCKED_PORT_COLS: ColumnDef[] = [
    { key: 'Dest Port', label: 'Dest Port' },
    { key: 'Protocol', label: 'Protocol' },
    { key: 'Drops', label: 'Drops', align: 'right', render: (v) => formatInteger(v) },
    { key: 'Hosts', label: 'Hosts', align: 'right', render: (v) => formatInteger(v) },
];
const OUT_DOMAIN_COLS: ColumnDef[] = [
    { key: 'Domain', label: 'Domain' },
    { key: 'Requests', label: 'Requests', align: 'right', render: (v) => formatInteger(v) },
    { key: 'Bandwidth', label: 'Bandwidth', align: 'right' },
    { key: 'Unique Clients', label: 'Unique Clients', align: 'right', render: (v) => formatInteger(v) },
];
const QUERIED_COLS: ColumnDef[] = [
    { key: 'Domain', label: 'Domain' },
    { key: 'Queries', label: 'Queries', align: 'right', render: (v) => formatInteger(v) },
    { key: 'Unique Clients', label: 'Unique Clients', align: 'right', render: (v) => formatInteger(v) },
    { key: '%TXT', label: '%TXT', align: 'right' },
    { key: '%MX', label: '%MX', align: 'right' },
];
const SUSPICIOUS_COLS: ColumnDef[] = [
    { key: 'Host', label: 'Host' },
    { key: 'Beaconing Domains', label: 'Beaconing Domains', align: 'right', render: (v) => formatInteger(v) },
    { key: 'Beaconing Queries', label: 'Beaconing Queries', align: 'right', render: (v) => formatInteger(v) },
    { key: 'Denied Proxy Requests', label: 'Denied Proxy Requests', align: 'right', render: (v) => formatInteger(v) },
    { key: 'Signal Score', label: 'Signal Score', align: 'right', render: (v) => formatInteger(v) },
];

const NetworkPerimeter: React.FC = () => {
    const fw = useFirstRowField(Q.kpiFw, 'count');
    const proxy = useFirstRowField(Q.kpiProxy, 'count');
    const dns = useFirstRowField(Q.kpiDns, 'count');
    const beacon = useFirstRowField(Q.kpiBeacon, 'count');
    const denied = useFirstRowField(Q.kpiDenied, 'count');
    const bw = useFirstRowField(Q.kpiBw, 'display');

    const blockedSrc = useSearch({ query: Q.blockedSrc });
    const blockedPort = useSearch({ query: Q.blockedPort });
    const outDomains = useSearch({ query: Q.outDomains });
    const queried = useSearch({ query: Q.queried });
    const suspicious = useSearch({ query: Q.suspicious });

    const fwTone = Number(fw.value ?? 0) > 1000 ? 'critical' : Number(fw.value ?? 0) > 0 ? 'warning' : 'neutral';
    const beaconTone = Number(beacon.value ?? 0) > 0 ? 'critical' : 'neutral';
    const deniedTone = Number(denied.value ?? 0) > 0 ? 'warning' : 'neutral';

    /* Drilldowns (build 159 / session 027 task 6). */
    const { timeRange } = useTimeRange();
    const goDeniedKpi = (): void => {
        const spl = '`sap_logserv_idx_macro` sourcetype=squid:access (status=403 OR vendor_action="TCP_DENIED") | sort -_time';
        openInNewTab(buildSplunkSearchUrl(spl, timeRange.earliest, timeRange.latest));
    };
    const goBlockedSrc = (row: Record<string, unknown>): void => {
        const ip = String(row['Source IP'] ?? '');
        if (!ip) return;
        const spl = `\`sap_logserv_idx_macro\` sourcetype=linux_secure "SRC=${splQuote(ip)}" | sort -_time`;
        openInNewTab(buildSplunkSearchUrl(spl, timeRange.earliest, timeRange.latest));
    };
    const goOutDomain = (row: Record<string, unknown>): void => {
        const dom = String(row.Domain ?? '');
        if (!dom) return;
        const spl = `\`sap_logserv_idx_macro\` sourcetype=squid:access url_domain="${splQuote(dom)}" | sort -_time`;
        openInNewTab(buildSplunkSearchUrl(spl, timeRange.earliest, timeRange.latest));
    };
    const goQueried = (row: Record<string, unknown>): void => {
        const dom = String(row.Domain ?? '');
        if (!dom) return;
        const spl = `\`sap_logserv_idx_macro\` tag=dns message_type="Query" query="${splQuote(dom)}" | sort -_time`;
        openInNewTab(buildSplunkSearchUrl(spl, timeRange.earliest, timeRange.latest));
    };
    const goSuspicious = (row: Record<string, unknown>): void => {
        const host = String(row.Host ?? '');
        if (!host) return;
        openInNewTab(buildHostDetailsUrl(host, timeRange.earliest, timeRange.latest));
    };

    return (
        <DashboardLayout
            category="SECURITY"
            title="Network Perimeter"
            subtitle="Unified network-boundary view — firewall drops (inbound rejections), proxy outbound traffic, DNS resolution, and cross-source suspicious-activity correlation"
        >
            <KpiRow>
                <KpiCard label="Firewall Drops" value={fw.value} loading={fw.loading} error={fw.error} formatValue={formatInteger} tone={fwTone}
                    sparkline={<SparklineFromQuery query={Q.sparkFw} valueField="count" color={logservTheme.colors.red} fill />} />
                <KpiCard label="Proxy Requests" value={proxy.value} loading={proxy.loading} error={proxy.error} formatValue={formatInteger}
                    sparkline={<SparklineFromQuery query={Q.sparkProxy} valueField="count" fill />} />
                <KpiCard label="DNS Queries" value={dns.value} loading={dns.loading} error={dns.error} formatValue={formatInteger}
                    sparkline={<SparklineFromQuery query={Q.sparkDns} valueField="count" fill />} />
                <KpiCard label="Beaconing Domains" value={beacon.value} loading={beacon.loading} error={beacon.error} formatValue={formatInteger} tone={beaconTone}
                    sparkline={<SparklineFromQuery query={Q.sparkBeacon} valueField="daily" color={logservTheme.colors.red} fill />} />
                <KpiCard label="Denied Requests" value={denied.value} loading={denied.loading} error={denied.error} formatValue={formatInteger} tone={deniedTone}
                    sparkline={<SparklineFromQuery query={Q.sparkDenied} valueField="count" color={logservTheme.colors.orange} fill />}
                    onClick={goDeniedKpi} clickTitle="Open denied-traffic SPL in Splunk Search" />
                <KpiCard label="Outbound Bandwidth" value={bw.value} loading={bw.loading} error={bw.error}
                    sparkline={<SparklineFromQuery query={Q.sparkBw} valueField="daily" fill />} />
            </KpiRow>

            <FullWidthPanel>
                <FramedPanel title="Perimeter Activity Over Time (log scale)" subtitle="Firewall + proxy + DNS daily counts overlaid">
                    <TimeSeriesChart
                        query={Q.activity}
                        height={300}
                        seriesColorsByField={{
                            'Firewall Drops': '#b50101',
                            'Proxy Requests': '#dc4e41',
                            'DNS Queries': '#f1813f',
                        }}
                    />
                </FramedPanel>
            </FullWidthPanel>

            <PanelGrid2>
                <FramedPanel search={blockedSrc} title="Blocked Source IPs" subtitle="Source IPs being dropped by firewall, ranked by drop count">
                    <DataTable columns={BLOCKED_SRC_COLS} rows={blockedSrc.results} loading={blockedSrc.loading} error={blockedSrc.error} emptyMessage="No firewall drops in this time range." initialSortKey="Drops" initialSortDir="desc" pageSize={10} onRowClick={goBlockedSrc} />
                </FramedPanel>
                <FramedPanel search={blockedPort} title="Blocked Destination Ports" subtitle="Destination ports being dropped, ranked by drop count">
                    <DataTable columns={BLOCKED_PORT_COLS} rows={blockedPort.results} loading={blockedPort.loading} error={blockedPort.error} emptyMessage="No firewall drops in this time range." initialSortKey="Drops" initialSortDir="desc" pageSize={10} />
                </FramedPanel>
            </PanelGrid2>

            <PanelGrid2>
                <FramedPanel title="Firewall Drops by Protocol" subtitle="Daily protocol mix (TCP / UDP / ICMP)">
                    <TimeSeriesChart query={Q.fwProto} height={280} palette="errors" />
                </FramedPanel>
                <FramedPanel title="Proxy Denied Traffic Over Time" subtitle="Daily denied request count">
                    <TimeSeriesChart query={Q.proxyDenied} height={280} palette="errors" />
                </FramedPanel>
            </PanelGrid2>

            <FullWidthPanel>
                <FramedPanel search={outDomains} title="Outbound Domains by Volume & Bytes" subtitle="Outbound domains ranked by bandwidth">
                    <DataTable columns={OUT_DOMAIN_COLS} rows={outDomains.results} loading={outDomains.loading} error={outDomains.error} emptyMessage="No proxy outbound traffic in this time range." initialSortKey="Requests" initialSortDir="desc" onRowClick={goOutDomain} />
                </FramedPanel>
            </FullWidthPanel>

            <PanelGrid30_70>
                <FramedPanel title="DNS Query Type Distribution" subtitle="Share of total DNS queries by record type">
                    <PieChart query={Q.dnsType} categoryField="Query Type" valueField="count" height={300} donut />
                </FramedPanel>
                <FramedPanel search={queried} title="Queried Domains" subtitle="Domains with %TXT and %MX columns (DNS exfil heuristic), ranked by query count">
                    <DataTable columns={QUERIED_COLS} rows={queried.results} loading={queried.loading} error={queried.error} emptyMessage="No DNS queries in this time range." initialSortKey="Queries" initialSortDir="desc" onRowClick={goQueried} />
                </FramedPanel>
            </PanelGrid30_70>

            <FullWidthPanel>
                <FramedPanel search={suspicious} title="Suspicious Activity Indicator (Beaconing DNS + Denied Proxy, by Host)" subtitle="Synthesis: signal_score = beacon_domains * 3 + denied_requests">
                    <DataTable columns={SUSPICIOUS_COLS} rows={suspicious.results} loading={suspicious.loading} error={suspicious.error} emptyMessage="No suspicious activity detected in this time range." initialSortKey="Signal Score" initialSortDir="desc" onRowClick={goSuspicious} />
                </FramedPanel>
            </FullWidthPanel>
        </DashboardLayout>
    );
};

export default NetworkPerimeter;
