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

const Q = {
    kpiFw: `\`sap_logserv_idx_macro\` sourcetype="linux_secure" | rex field=_raw "(?<fw_action>IN_DROP|IN_ACCEPT)" | where fw_action="IN_DROP" | stats count`,
    kpiProxy: `\`sap_logserv_idx_macro\` sourcetype="squid:access" | stats count`,
    kpiDns: `\`sap_logserv_idx_macro\` tag=dns message_type="Query" | stats count`,
    kpiBeacon: `\`sap_logserv_idx_macro\` tag=dns message_type="Query" | bucket _time span=1d as day | fields day, _time, query | streamstats current=f last(_time) as last_time by query, day | eval gap=last_time - _time | stats count, avg(gap) AS avg_gap, var(gap) AS var_gap BY query, day | where var_gap < 60 AND count > 2 AND avg_gap > 1 | stats dc(query) as count`,
    kpiDenied: `\`sap_logserv_idx_macro\` sourcetype="squid:access" (status=403 OR vendor_action="TCP_DENIED") | stats count`,
    kpiBw: `\`sap_logserv_idx_macro\` sourcetype="squid:access" bytes_out=* | stats sum(bytes_out) as total_bytes | eval display = case(total_bytes >= 1073741824, tostring(round(total_bytes/1073741824, 2)) . " GB", total_bytes >= 1048576, tostring(round(total_bytes/1048576, 1)) . " MB", total_bytes >= 1024, tostring(round(total_bytes/1024, 0)) . " KB", 1=1, tostring(total_bytes) . " B")`,

    sparkFw: `\`sap_logserv_idx_macro\` sourcetype="linux_secure" | rex field=_raw "(?<fw_action>IN_DROP|IN_ACCEPT)" | where fw_action="IN_DROP" | timechart span=1d count`,
    sparkProxy: `\`sap_logserv_idx_macro\` sourcetype="squid:access" | timechart span=1d count`,
    sparkDns: `\`sap_logserv_idx_macro\` tag=dns message_type="Query" | timechart span=1d count`,
    sparkBeacon: `\`sap_logserv_idx_macro\` tag=dns message_type="Query" | bucket _time span=1d as day | fields day, _time, query | streamstats current=f last(_time) as last_time by query, day | eval gap=last_time - _time | stats count, avg(gap) AS avg_gap, var(gap) AS var_gap BY query, day | where var_gap < 60 AND count > 2 AND avg_gap > 1 | stats dc(query) as daily by day | rename day as _time`,
    sparkDenied: `\`sap_logserv_idx_macro\` sourcetype="squid:access" (status=403 OR vendor_action="TCP_DENIED") | timechart span=1d count`,
    sparkBw: `\`sap_logserv_idx_macro\` sourcetype="squid:access" bytes_out=* | timechart span=1d sum(bytes_out) as bytes_daily | eval daily = round(bytes_daily/1048576, 2)`,

    activity: `\`sap_logserv_idx_macro\` (sourcetype="linux_secure" OR sourcetype="squid:access" OR (tag=dns message_type="Query")) | eval source_type = case(sourcetype="linux_secure" AND match(_raw, "IN_DROP"), "Firewall Drops", sourcetype="squid:access", "Proxy Requests", sourcetype="isc:bind:query", "DNS Queries", 1=1, "other") | where source_type != "other" | timechart span=1d count by source_type`,
    blockedSrc: `\`sap_logserv_idx_macro\` sourcetype="linux_secure" | rex field=_raw "SRC=(?<fw_src>[^ ]+)" | rex field=_raw "DST=(?<fw_dst>[^ ]+)" | rex field=_raw "PROTO=(?<fw_proto>[^ ]+)" | where isnotnull(fw_src) | stats count as Drops, dc(fw_dst) as "Unique Targets", values(fw_proto) as Protocols by fw_src | sort -Drops | rename fw_src as "Source IP"`,
    blockedPort: `\`sap_logserv_idx_macro\` sourcetype="linux_secure" | rex field=_raw "DPT=(?<fw_dpt>[^ ]+)" | rex field=_raw "PROTO=(?<fw_proto>[^ ]+)" | where isnotnull(fw_dpt) | stats count as Drops, dc(host) as Hosts by fw_dpt, fw_proto | sort -Drops | rename fw_dpt as "Dest Port", fw_proto as Protocol`,
    fwProto: `\`sap_logserv_idx_macro\` sourcetype="linux_secure" | rex field=_raw "(?<fw_action>IN_DROP|IN_ACCEPT)" | where fw_action="IN_DROP" | rex field=_raw "PROTO=(?<fw_proto>[^ ]+)" | where isnotnull(fw_proto) | eval proto_name = case(fw_proto="TCP" OR fw_proto="6", "TCP", fw_proto="UDP" OR fw_proto="17", "UDP", fw_proto="ICMP" OR fw_proto="1", "ICMP", 1=1, fw_proto) | timechart span=1d count by proto_name`,
    proxyDenied: `\`sap_logserv_idx_macro\` sourcetype="squid:access" (status=403 OR vendor_action="TCP_DENIED") | timechart span=1d count as "Denied Requests"`,
    outDomains: `\`sap_logserv_idx_macro\` sourcetype="squid:access" url_domain=* bytes_out=* | stats count as Requests, sum(bytes_out) as bytes, dc(src_ip) as "Unique Clients" by url_domain | eval Bandwidth = case(bytes >= 1073741824, tostring(round(bytes/1073741824, 2)) . " GB", bytes >= 1048576, tostring(round(bytes/1048576, 1)) . " MB", bytes >= 1024, tostring(round(bytes/1024, 0)) . " KB", 1=1, tostring(bytes) . " B") | sort -bytes | table url_domain, Requests, Bandwidth, "Unique Clients" | rename url_domain as "Domain"`,
    dnsType: `\`sap_logserv_idx_macro\` tag=dns message_type="Query" query_type=* | eval query_type_label = case(query_type="A", "A (IPv4 Address)", query_type="AAAA", "AAAA (IPv6 Address)", query_type="CNAME", "CNAME (Canonical Name)", query_type="MX", "MX (Mail Exchange)", query_type="NS", "NS (Name Server)", query_type="PTR", "PTR (Reverse DNS)", query_type="SOA", "SOA (Start of Authority)", query_type="SRV", "SRV (Service)", query_type="TXT", "TXT (Text)", query_type="HINFO", "HINFO (Host Info)", query_type="ANY", "ANY (Any Type)", query_type="NAPTR", "NAPTR (Naming Authority Pointer)", query_type="DS", "DS (Delegation Signer)", query_type="DNSKEY", "DNSKEY (DNS Key)", query_type="RRSIG", "RRSIG (Resource Record Signature)", query_type="NSEC", "NSEC (Next Secure)", query_type="CAA", "CAA (Certificate Authority Authorization)", 1=1, query_type) | stats count by query_type_label | sort -count | rename query_type_label as "Query Type"`,
    queried: `\`sap_logserv_idx_macro\` tag=dns message_type="Query" query=* | stats count as Queries, dc(src) as "Unique Clients", sum(eval(if(query_type="TXT", 1, 0))) as txt_count, sum(eval(if(query_type="MX", 1, 0))) as mx_count by query | eval pct_txt = tostring(round(txt_count*100/Queries, 1)) . "%" | eval pct_mx = tostring(round(mx_count*100/Queries, 1)) . "%" | sort -Queries | table query, Queries, "Unique Clients", pct_txt, pct_mx | rename query as "Domain", pct_txt as "%TXT", pct_mx as "%MX"`,
    suspicious: `\`sap_logserv_idx_macro\` tag=dns message_type="Query" src=* | fields _time, src, query | streamstats current=f last(_time) as last_time by query | eval gap=last_time - _time | stats count AS beacon_query_count, avg(gap) AS avg_gap, var(gap) AS var_gap BY query, src | where var_gap < 60 AND avg_gap > 0 AND beacon_query_count > 2 | stats dc(query) as beacon_domains, sum(beacon_query_count) as beacon_queries by src | append [ search \`sap_logserv_idx_macro\` sourcetype="squid:access" (status=403 OR vendor_action="TCP_DENIED") src_ip=* | stats count as denied_requests by src_ip | rename src_ip as src ] | stats max(beacon_domains) as beacon_domains, max(beacon_queries) as beacon_queries, max(denied_requests) as denied_requests by src | fillnull value=0 beacon_domains beacon_queries denied_requests | eval signal_score = (beacon_domains * 3) + denied_requests | where signal_score > 0 | sort -signal_score | rename src as "Host", beacon_domains as "Beaconing Domains", beacon_queries as "Beaconing Queries", denied_requests as "Denied Proxy Requests", signal_score as "Signal Score"`,
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
                <FramedPanel title="Blocked Source IPs" subtitle="Source IPs being dropped by firewall, ranked by drop count">
                    <DataTable columns={BLOCKED_SRC_COLS} rows={blockedSrc.results} loading={blockedSrc.loading} error={blockedSrc.error} emptyMessage="No firewall drops in this time range." initialSortKey="Drops" initialSortDir="desc" pageSize={10} onRowClick={goBlockedSrc} />
                </FramedPanel>
                <FramedPanel title="Blocked Destination Ports" subtitle="Destination ports being dropped, ranked by drop count">
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
                <FramedPanel title="Outbound Domains by Volume & Bytes" subtitle="Outbound domains ranked by bandwidth">
                    <DataTable columns={OUT_DOMAIN_COLS} rows={outDomains.results} loading={outDomains.loading} error={outDomains.error} emptyMessage="No proxy outbound traffic in this time range." initialSortKey="Requests" initialSortDir="desc" onRowClick={goOutDomain} />
                </FramedPanel>
            </FullWidthPanel>

            <PanelGrid30_70>
                <FramedPanel title="DNS Query Type Distribution" subtitle="Share of total DNS queries by record type">
                    <PieChart query={Q.dnsType} categoryField="Query Type" valueField="count" height={300} donut />
                </FramedPanel>
                <FramedPanel title="Queried Domains" subtitle="Domains with %TXT and %MX columns (DNS exfil heuristic), ranked by query count">
                    <DataTable columns={QUERIED_COLS} rows={queried.results} loading={queried.loading} error={queried.error} emptyMessage="No DNS queries in this time range." initialSortKey="Queries" initialSortDir="desc" onRowClick={goQueried} />
                </FramedPanel>
            </PanelGrid30_70>

            <FullWidthPanel>
                <FramedPanel title="Suspicious Activity Indicator (Beaconing DNS + Denied Proxy, by Host)" subtitle="Synthesis: signal_score = beacon_domains * 3 + denied_requests">
                    <DataTable columns={SUSPICIOUS_COLS} rows={suspicious.results} loading={suspicious.loading} error={suspicious.error} emptyMessage="No suspicious activity detected in this time range." initialSortKey="Signal Score" initialSortDir="desc" onRowClick={goSuspicious} />
                </FramedPanel>
            </FullWidthPanel>
        </DashboardLayout>
    );
};

export default NetworkPerimeter;
