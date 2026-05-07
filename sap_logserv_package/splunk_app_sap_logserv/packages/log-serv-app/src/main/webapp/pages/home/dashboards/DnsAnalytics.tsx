import React, { useMemo, useState } from 'react';
import styled from 'styled-components';
import Select from '@splunk/react-ui/Select';
import Multiselect from '@splunk/react-ui/Multiselect';
import KpiCard, { formatInteger } from '../components/KpiCard';
import FramedPanel from '../components/FramedPanel';
import DataTable, { ColumnDef } from '../components/DataTable';
import TimeSeriesChart from '../components/TimeSeriesChart';
import PieChart from '../components/PieChart';
import { SparklineFromQuery } from '../components/Sparkline';
import DashboardLayout from '../components/DashboardLayout';
import { useSearch } from '../hooks/useSearch';
import { useTimeRange } from '../state/TimeRangeProvider';
import { chooseTimechartSpan } from '../utils/timechartSpan';
import { buildHostDetailsUrl, buildSplunkSearchUrl, openInNewTab, splQuote } from '../utils/drilldownUrls';
import { logservTheme } from '../styles/logservTheme';

/** Top-N choices for the Clients chart's "Show top N" picker.
 *  `all` resolves to `limit=0` (no rollup) at SPL build time. */
const TOP_N_CHOICES: Array<{ value: string; label: string }> = [
    { value: 'all', label: 'All clients' },
    { value: '5', label: 'Top 5' },
    { value: '10', label: 'Top 10' },
    { value: '20', label: 'Top 20' },
    { value: '50', label: 'Top 50' },
];

/**
 * DNS Analytics — honest port of v0.0.4.2 logserv_dns_analytics.xml.
 *
 * 3 KPIs (Queries / Clients / Beaconing) + Top 10 Clients line +
 * Beaconing Activity table (was bubble chart) + Requests by Record Type line +
 * Hosts to Beaconing Domains table (was bubble chart) + Top Domains table +
 * Top Clients by Domain Diversity table + Query Type pie + Top DNS Resolvers table.
 *
 * Note: v0.0.4.2 used `splunk.bubble` for "Beaconing Activity" and "Hosts to
 * Beaconing Domains". React port renders these as sortable tables since we don't
 * yet have a Bubble primitive — same SPL, more legible for the underlying data.
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
/** Inline-aligned controls that fit naturally in a FramedPanel `actions` slot. */
const PanelControls = styled.div`
    display: inline-flex;
    align-items: center;
    gap: ${logservTheme.spacing.sm};
`;

const DNS_BASE = 'tag=dns message_type="Query"';

// SPL fragment that rewrites the raw DNS `record_type` code (A, AAAA, MX, …)
// into a human-readable label of the form `"<code> = <description>"`.
// The case-default (`1=1, record_type`) preserves any code not listed below
// (rare types, vendor-specific extensions) as-is so we never silently drop
// data. Drop into a query before the stats / timechart that groups by
// record_type.
const RECORD_TYPE_RELABEL = `eval record_type = case(`
    + `record_type=="A", "A = IPv4 Address",`
    + `record_type=="AAAA", "AAAA = IPv6 Address",`
    + `record_type=="CNAME", "CNAME = Canonical Name",`
    + `record_type=="MX", "MX = Mail Exchange",`
    + `record_type=="NS", "NS = Name Server",`
    + `record_type=="PTR", "PTR = Reverse Lookup",`
    + `record_type=="SOA", "SOA = Start of Authority",`
    + `record_type=="SRV", "SRV = Service Locator",`
    + `record_type=="TXT", "TXT = Text Record",`
    + `record_type=="AXFR", "AXFR = Zone Transfer",`
    + `record_type=="CAA", "CAA = Certificate Authority",`
    + `record_type=="DS", "DS = Delegation Signer",`
    + `record_type=="DNSKEY", "DNSKEY = DNSSEC Key",`
    + `record_type=="RRSIG", "RRSIG = DNSSEC Signature",`
    + `record_type=="NSEC", "NSEC = Next Secure",`
    + `record_type=="HTTPS", "HTTPS = Service Binding",`
    + `record_type=="SVCB", "SVCB = Service Binding",`
    + `record_type=="ANY", "ANY = All Records",`
    + `1=1, record_type`
    + `)`;

const Q = {
    kpiQueries: `\`sap_logserv_idx_macro\` ${DNS_BASE} | stats count`,
    kpiClients: `\`sap_logserv_idx_macro\` ${DNS_BASE} | stats dc(src) as clients`,
    kpiBeaconing: `\`sap_logserv_idx_macro\` ${DNS_BASE} | bucket _time span=1d as day | fields day, _time, query | streamstats current=f last(_time) as last_time by query, day | eval gap=last_time - _time | stats count, avg(gap) AS avg_gap, var(gap) AS var_gap BY query, day | where var_gap < 60 AND count > 2 AND avg_gap > 1 | stats dc(query) as count`,

    sparkQueries: `\`sap_logserv_idx_macro\` ${DNS_BASE} | timechart span=1d count`,
    sparkClients: `\`sap_logserv_idx_macro\` ${DNS_BASE} | timechart span=1d dc(src) as clients`,
    sparkBeaconing: `\`sap_logserv_idx_macro\` ${DNS_BASE} | bucket _time span=1d as day | fields day, _time, query | streamstats current=f last(_time) as last_time by query, day | eval gap=last_time - _time | stats count, avg(gap) AS avg_gap, var(gap) AS var_gap BY query, day | where var_gap < 60 AND count > 2 AND avg_gap > 1 | stats dc(query) as daily by day | rename day as _time`,

    beaconingActivity: `\`sap_logserv_idx_macro\` ${DNS_BASE} | fields _time, query | streamstats current=f last(_time) as last_time by query | eval gap=last_time - _time | stats count avg(gap) AS AverageBeaconTime var(gap) AS VarianceBeaconTime BY query | eval AverageBeaconTime=round(AverageBeaconTime,3), VarianceBeaconTime=round(VarianceBeaconTime,3) | sort -count | where VarianceBeaconTime < 60 AND count > 2 AND AverageBeaconTime>1.000 | table query VarianceBeaconTime count AverageBeaconTime`,
    hostsToBeaconing: `\`sap_logserv_idx_macro\` ${DNS_BASE} | fields _time, src, query | streamstats current=f last(_time) as last_time by query | eval gap=last_time - _time | stats count dc(src) AS NumHosts avg(gap) AS AverageBeaconTime var(gap) AS VarianceBeaconTime BY query | eval AverageBeaconTime=round(AverageBeaconTime,3), VarianceBeaconTime=round(VarianceBeaconTime,3) | sort -count | where VarianceBeaconTime < 60 AND AverageBeaconTime > 0`,
    topDomains: `\`sap_logserv_idx_macro\` ${DNS_BASE} | stats count as Queries dc(src) as "Unique Clients" by query | sort -Queries | rename query as Domain`,
    nxDomain: `\`sap_logserv_idx_macro\` ${DNS_BASE} | stats count as Queries dc(query) as "Unique Domains" by src | eval "Queries per Domain"=round(Queries/'Unique Domains', 1) | sort -"Unique Domains" | rename src as "Client IP"`,
    queryTypes: `\`sap_logserv_idx_macro\` ${DNS_BASE} record_type=* | ${RECORD_TYPE_RELABEL} | stats count by record_type | sort -count`,
    topResolvers: `\`sap_logserv_idx_macro\` ${DNS_BASE} | stats count as Queries, dc(query) as "Unique Domains", dc(src) as "Unique Clients" by host | sort -Queries | rename host as "Resolver"`,
};

interface FirstRow { value: unknown; loading: boolean; error: Error | null; }
const useFirstRowField = (q: string, f: string): FirstRow => {
    const { results, loading, error } = useSearch({ query: q });
    const value = results && results[0] ? (results[0] as Record<string, unknown>)[f] : undefined;
    return { value, loading, error };
};

const BEACONING_COLS: ColumnDef[] = [
    { key: 'query', label: 'Query (domain)' },
    { key: 'count', label: 'Count', align: 'right', render: (v) => formatInteger(v) },
    { key: 'AverageBeaconTime', label: 'Avg Beacon (s)', align: 'right' },
    { key: 'VarianceBeaconTime', label: 'Variance', align: 'right' },
];
const HOSTS_BEACONING_COLS: ColumnDef[] = [
    { key: 'query', label: 'Query (domain)' },
    { key: 'NumHosts', label: 'Hosts', align: 'right', render: (v) => formatInteger(v) },
    { key: 'count', label: 'Count', align: 'right', render: (v) => formatInteger(v) },
    { key: 'AverageBeaconTime', label: 'Avg Beacon (s)', align: 'right' },
    { key: 'VarianceBeaconTime', label: 'Variance', align: 'right' },
];
const TOP_DOM_COLS: ColumnDef[] = [
    { key: 'Domain', label: 'Domain' },
    { key: 'Queries', label: 'Queries', align: 'right', render: (v) => formatInteger(v) },
    { key: 'Unique Clients', label: 'Unique Clients', align: 'right', render: (v) => formatInteger(v) },
];
const NX_DOM_COLS: ColumnDef[] = [
    { key: 'Client IP', label: 'Client IP' },
    { key: 'Queries', label: 'Queries', align: 'right', render: (v) => formatInteger(v) },
    { key: 'Unique Domains', label: 'Unique Domains', align: 'right', render: (v) => formatInteger(v) },
    { key: 'Queries per Domain', label: 'Queries / Domain', align: 'right' },
];
const RESOLVER_COLS: ColumnDef[] = [
    { key: 'Resolver', label: 'Resolver' },
    { key: 'Queries', label: 'Queries', align: 'right', render: (v) => formatInteger(v) },
    { key: 'Unique Domains', label: 'Unique Domains', align: 'right', render: (v) => formatInteger(v) },
    { key: 'Unique Clients', label: 'Unique Clients', align: 'right', render: (v) => formatInteger(v) },
];

const DnsAnalytics: React.FC = () => {
    const queries = useFirstRowField(Q.kpiQueries, 'count');
    const clients = useFirstRowField(Q.kpiClients, 'clients');
    const beaconing = useFirstRowField(Q.kpiBeaconing, 'count');

    const beaconingActivity = useSearch({ query: Q.beaconingActivity });
    const hostsToBeaconing = useSearch({ query: Q.hostsToBeaconing });
    const topDomains = useSearch({ query: Q.topDomains });
    const nxDomain = useSearch({ query: Q.nxDomain });
    const topResolvers = useSearch({ query: Q.topResolvers });

    const { timeRange } = useTimeRange();

    /* Drilldowns (build 159 / session 027 task 6).
     * - Beaconing rows / Hosts-to-Beaconing rows: splunk-search timechart
     *   for that suspicious domain to inspect the cadence pattern.
     * - Top Domains rows: splunk-search timechart for that domain.
     * - Clients-by-Diversity rows + DNS Resolvers rows: Host Details with
     *   ?host=<row.[Client IP|Resolver]> for that endpoint's full activity. */
    const goBeaconingRow = (row: Record<string, unknown>): void => {
        const q = String(row.query ?? '');
        if (!q) return;
        const spl = `\`sap_logserv_idx_macro\` tag=dns message_type="Query" query="${splQuote(q)}" | timechart span=1h count`;
        openInNewTab(buildSplunkSearchUrl(spl, timeRange.earliest, timeRange.latest));
    };
    const goHostsToBeaconingRow = (row: Record<string, unknown>): void => {
        const q = String(row.query ?? '');
        if (!q) return;
        const spl = `\`sap_logserv_idx_macro\` tag=dns query="${splQuote(q)}" | stats count by src host | sort -count`;
        openInNewTab(buildSplunkSearchUrl(spl, timeRange.earliest, timeRange.latest));
    };
    const goTopDomainsRow = (row: Record<string, unknown>): void => {
        const q = String(row.Domain ?? '');
        if (!q) return;
        const spl = `\`sap_logserv_idx_macro\` tag=dns query="${splQuote(q)}" | timechart span=1h count`;
        openInNewTab(buildSplunkSearchUrl(spl, timeRange.earliest, timeRange.latest));
    };
    const goClientDiversityRow = (row: Record<string, unknown>): void => {
        const ip = String(row['Client IP'] ?? '');
        if (!ip) return;
        openInNewTab(buildHostDetailsUrl(ip, timeRange.earliest, timeRange.latest));
    };
    const goResolverRow = (row: Record<string, unknown>): void => {
        const host = String(row.Resolver ?? '');
        if (!host) return;
        openInNewTab(buildHostDetailsUrl(host, timeRange.earliest, timeRange.latest));
    };
    const span = useMemo(
        () => chooseTimechartSpan(timeRange.earliest, timeRange.latest),
        [timeRange.earliest, timeRange.latest],
    );

    // ── Clients chart filter state ────────────────────────────────────────
    //
    // Two orthogonal controls in the panel header (mirrors the
    // Events-Over-Time-by-Host pattern on Data Pipeline Overview):
    //
    //   topN              — quick "show busiest N" picker. 'all' → no limit.
    //   selectedClients   — explicit per-client-IP picker. Wins over topN
    //                       when set (an explicit pick is the more specific
    //                       intent).
    //
    // Both default to "show everything" so the chart's behavior matches the
    // user's prior experience on first load.
    const [topN, setTopN] = useState<string>('all');
    const [selectedClients, setSelectedClients] = useState<string[]>([]);

    // Client-IP options for the Multiselect — sorted by descending request
    // volume so the dropdown's first items are the busiest clients.
    const clientListSearch = useSearch<{ src?: string; count?: string | number }>({
        query: `\`sap_logserv_idx_macro\` ${DNS_BASE} | stats count by src | sort -count`,
    });
    const clientOptions = useMemo<string[]>(() => {
        const rows = clientListSearch.results ?? [];
        return rows
            .map((r) => (typeof r.src === 'string' ? r.src : ''))
            .filter((s): s is string => s.length > 0);
    }, [clientListSearch.results]);

    // Compose the chart query. When the user has picked specific client IPs,
    // we add a `src IN (...)` filter and ignore the topN limit (their pick is
    // the more specific intent). Otherwise, apply topN.
    const topClientsQuery = useMemo(() => {
        const hasClientPick = selectedClients.length > 0;
        const clientFilterClause = hasClientPick
            ? `src IN (${selectedClients.map((c) => `"${c.replace(/"/g, '\\"')}"`).join(',')}) `
            : '';
        const limitVal = hasClientPick ? '0' : (topN === 'all' ? '0' : topN);
        return (
            `\`sap_logserv_idx_macro\` ${DNS_BASE} ${clientFilterClause}` +
            `| timechart span=${span} limit=${limitVal} usenull=f useother=f count AS Requests by src`
        );
    }, [span, topN, selectedClients]);

    const clientsChartSubtitle = useMemo<string>(() => {
        const total = clientOptions.length;
        if (selectedClients.length > 0) {
            return `${selectedClients.length} of ${total} clients selected — span ${span}`;
        }
        if (topN === 'all') {
            return `All clients (${total}) by request volume — span ${span}`;
        }
        return `Top ${topN} clients by request volume — span ${span}`;
    }, [span, topN, selectedClients, clientOptions.length]);

    const recordTypesQuery = useMemo(
        () =>
            `\`sap_logserv_idx_macro\` ${DNS_BASE} | ${RECORD_TYPE_RELABEL} | timechart span=${span} usenull=f useother=f count BY record_type`,
        [span],
    );

    const beaconingTone = Number(beaconing.value ?? 0) > 0 ? 'warning' : 'neutral';

    return (
        <DashboardLayout
            category="PLATFORM"
            title="DNS Analytics"
            subtitle="BIND DNS query activity — top clients, record types, beaconing detection, and resolver health"
        >
            <KpiRow>
                <KpiCard label="Total Queries" value={queries.value} loading={queries.loading} error={queries.error} formatValue={formatInteger}
                    sparkline={<SparklineFromQuery query={Q.sparkQueries} valueField="count" fill />} />
                <KpiCard label="Unique Clients" value={clients.value} loading={clients.loading} error={clients.error} formatValue={formatInteger}
                    sparkline={<SparklineFromQuery query={Q.sparkClients} valueField="clients" fill />} />
                <KpiCard label="Beaconing Domains" value={beaconing.value} loading={beaconing.loading} error={beaconing.error} formatValue={formatInteger} tone={beaconingTone}
                    sparkline={<SparklineFromQuery query={Q.sparkBeaconing} valueField="daily" color={logservTheme.colors.orange} fill />} />
            </KpiRow>

            <PanelGrid2>
                <FramedPanel
                    title="Clients - Request Volume"
                    subtitle={clientsChartSubtitle}
                    actions={
                        <PanelControls>
                            <Multiselect
                                compact
                                inline
                                placeholder={
                                    selectedClients.length === 0
                                        ? `Filter clients (${clientOptions.length})`
                                        : undefined
                                }
                                values={selectedClients}
                                onChange={(_e, { values }) =>
                                    setSelectedClients(values.map((v) => String(v)))
                                }
                                style={{ minWidth: 180, maxWidth: 320 }}
                            >
                                {clientOptions.map((c) => (
                                    <Multiselect.Option key={c} label={c} value={c} />
                                ))}
                            </Multiselect>
                            <Select
                                inline
                                value={topN}
                                onChange={(_e, { value }) => {
                                    if (typeof value === 'string') setTopN(value);
                                }}
                                disabled={selectedClients.length > 0}
                            >
                                {TOP_N_CHOICES.map((c) => (
                                    <Select.Option key={c.value} value={c.value} label={c.label} />
                                ))}
                            </Select>
                        </PanelControls>
                    }
                >
                    <TimeSeriesChart query={topClientsQuery} height={280} palette="categorical" chartType="line" />
                </FramedPanel>
                <FramedPanel
                    title="Requests by Record Type"
                    subtitle={`Query mix by record type — span ${span}`}
                >
                    <TimeSeriesChart query={recordTypesQuery} height={280} palette="categorical" chartType="line" />
                </FramedPanel>
            </PanelGrid2>

            <PanelGrid2>
                <FramedPanel title="Beaconing Activity" subtitle="Domains with low beacon variance + steady cadence (suspicious)">
                    <DataTable columns={BEACONING_COLS} rows={beaconingActivity.results} loading={beaconingActivity.loading} error={beaconingActivity.error} emptyMessage="No beaconing patterns detected in this time range." initialSortKey="count" initialSortDir="desc" onRowClick={goBeaconingRow} />
                </FramedPanel>
                <FramedPanel title="Hosts to Beaconing Domains" subtitle="Domains beaconed to + how many hosts contacted them">
                    <DataTable columns={HOSTS_BEACONING_COLS} rows={hostsToBeaconing.results} loading={hostsToBeaconing.loading} error={hostsToBeaconing.error} emptyMessage="No host-to-beaconing patterns in this time range." initialSortKey="count" initialSortDir="desc" onRowClick={goHostsToBeaconingRow} />
                </FramedPanel>
            </PanelGrid2>

            <PanelGrid3>
                <FramedPanel title="Queried Domains" subtitle="Domains ranked by query volume">
                    <DataTable columns={TOP_DOM_COLS} rows={topDomains.results} loading={topDomains.loading} error={topDomains.error} emptyMessage="No DNS queries in this time range." onRowClick={goTopDomainsRow} />
                </FramedPanel>
                <FramedPanel title="Clients by Domain Diversity" subtitle="Clients ranked by unique domains queried">
                    <DataTable columns={NX_DOM_COLS} rows={nxDomain.results} loading={nxDomain.loading} error={nxDomain.error} emptyMessage="No DNS queries in this time range." onRowClick={goClientDiversityRow} />
                </FramedPanel>
                <FramedPanel title="Query Type Distribution" subtitle="Share of total queries by record type">
                    <PieChart query={Q.queryTypes} categoryField="record_type" valueField="count" height={300} donut />
                </FramedPanel>
            </PanelGrid3>

            <FullWidthPanel>
                <FramedPanel title="DNS Resolvers" subtitle="Resolvers (BIND hosts) ranked by query volume">
                    <DataTable columns={RESOLVER_COLS} rows={topResolvers.results} loading={topResolvers.loading} error={topResolvers.error} emptyMessage="No DNS resolvers in this time range." pageSize={5} onRowClick={goResolverRow} />
                </FramedPanel>
            </FullWidthPanel>
        </DashboardLayout>
    );
};

export default DnsAnalytics;
