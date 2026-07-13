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
import { useHybridSearch, useRoutedQuery } from '../hooks/useHybridSearch';
import { shouldUseRawSource } from '../utils/hybridRouting';
import { useCloudProvider, mapCloudProviderQueries } from '../state/CloudProviderProvider';
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
 *
 * Performance tiering (session 049 CIM; rebuilt build 232 → KV-Store rollup). The
 * CIM Network_Resolution tier fell back to a RAW full-scan when unaccelerated, so
 * the 11 query/client/domain/record-type panels now read the always-fast
 * `logserv_dns_rollup` collection (2 metrics): main (host,query,src — queries,
 * clients, Queried Domains, Diversity, Resolvers, the Clients chart + populator) and
 * rtype (record_type — Query Type pie + chart).
 *   - Beaconing KPI + sparkline reuse `logserv_beaconing_rollup` (per-day dc(query),
 *     byte-identical to the kpiBeaconing computation).
 *   - The 2 BEACONING DETAIL tables (Beaconing Activity, Hosts to Beaconing) stay
 *     RAW — streamstats per-event gap analysis can't roll up byte-exact.
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
/** Inline-aligned controls that fit naturally in a FramedPanel `actions` slot. */
const PanelControls = styled.div`
    display: inline-flex;
    align-items: center;
    gap: ${logservTheme.spacing.sm};
`;

const DNS_BASE = 'tag=dns message_type="Query"';

// --- KV-Store rollup reads (build 232 — replaces the CIM Network_Resolution tier).
// main (host,query,src) + rtype (record_type). dc() distinct columns reconstruct
// across buckets because the dims are in the grain; the "(none)" fillnull sentinel
// is nulled on read. Beaconing kpi+spark read the per-day logserv_beaconing_rollup.
const ROLL = 'logserv_dns_rollup';
const RANGE = '| addinfo | where bucket_ts>=info_min_time AND bucket_ts<info_max_time';
const MAIN = `| inputlookup ${ROLL} where metric="main" ${RANGE}`;
const RTYPE = `| inputlookup ${ROLL} where metric="rtype" ${RANGE}`;
const BEACON = '| inputlookup logserv_beaconing_rollup | addinfo | where day_ts>=info_min_time AND day_ts<info_max_time';
// Build 237 — per-day beaconing DETAIL rollup (qs metric: query,src gap-stats).
// Approximate (per-day gaps miss the midnight-boundary gap) but picker-responsive.
// avg=Σsum/Σn, var=(Σsumsq-Σsum²/Σn)/(Σn-1) reconstruct over the picked day range.
const BCN_QS = '| inputlookup logserv_beaconing_detail_rollup where metric="qs" | addinfo | where day_ts>=info_min_time AND day_ts<info_max_time';

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

const Q_BASE = {
    // --- KV-Store rollup: main (queries / clients / domains / resolvers) -----
    kpiQueries: `${MAIN} | stats count as n, sum(count) as count | fillnull value=0 count | fields count`,
    kpiClients: `${MAIN} | stats count as n, dc(eval(if(src="(none)",null(),src))) as clients | fillnull value=0 clients | fields clients`,

    sparkQueries: `${MAIN} | eval _time=bucket_ts | timechart span=1d sum(count) as count | fillnull value=0`,
    sparkClients: `${MAIN} | eval _time=bucket_ts | timechart span=1d dc(eval(if(src="(none)",null(),src))) as clients | fillnull value=0`,

    topDomains: `${MAIN} | search query!="(none)" | stats sum(count) as Queries, dc(eval(if(src="(none)",null(),src))) as "Unique Clients" by query | sort -Queries | rename query as Domain`,
    nxDomain: `${MAIN} | search src!="(none)" | stats sum(count) as Queries, dc(eval(if(query="(none)",null(),query))) as "Unique Domains" by src | eval "Queries per Domain"=round(Queries/'Unique Domains', 1) | sort -"Unique Domains" | rename src as "Client IP"`,
    queryTypes: `${RTYPE} | search record_type!="(none)" | ${RECORD_TYPE_RELABEL} | stats sum(count) as count by record_type | sort -count`,
    topResolvers: `${MAIN} | search host!="(none)" | stats sum(count) as Queries, dc(eval(if(query="(none)",null(),query))) as "Unique Domains", dc(eval(if(src="(none)",null(),src))) as "Unique Clients" by host | sort -Queries | rename host as "Resolver"`,

    // --- beaconing KPI + spark reuse logserv_beaconing_rollup (per-day dc(query)) --
    kpiBeaconing: `${BEACON} | stats count as n, sum(count) as count | fillnull value=0 count | fields count`,
    sparkBeaconing: `${BEACON} | eval _time=day_ts | timechart span=1d sum(count) as daily | fillnull value=0`,

    // --- stays RAW: streamstats beaconing DETAIL tables (per-event gap analysis;
    //     can't roll up byte-exact — streamstats over the per-event stream).
    // Build 237: reconstructed from the per-day beaconing detail rollup (qs).
    // sum over src gives the per-query event count + gap-stats; avg/var rebuilt
    // from Σsum_gap/Σn_gap + the sample-variance form. Approximate (per-day gaps).
    beaconingActivity: `${BCN_QS} | stats sum(cnt) as count, sum(n_gap) as ng, sum(sum_gap) as sg, sum(sumsq_gap) as ssg by query | eval AverageBeaconTime=round(if(ng>0,sg/ng,0),3), VarianceBeaconTime=round(if(ng>1,(ssg - sg*sg/ng)/(ng-1),0),3) | sort -count | where VarianceBeaconTime < 60 AND count > 2 AND AverageBeaconTime>1.000 | table query VarianceBeaconTime count AverageBeaconTime`,
    hostsToBeaconing: `${BCN_QS} | stats sum(cnt) as count, dc(eval(if(src="(none)",null(),src))) AS NumHosts, sum(n_gap) as ng, sum(sum_gap) as sg, sum(sumsq_gap) as ssg by query | eval AverageBeaconTime=round(if(ng>0,sg/ng,0),3), VarianceBeaconTime=round(if(ng>1,(ssg - sg*sg/ng)/(ng-1),0),3) | sort -count | where VarianceBeaconTime < 60 AND AverageBeaconTime > 0 | table query count NumHosts AverageBeaconTime VarianceBeaconTime`,
};

/* ---------------------------------------------------------------------------
 * RAW fallbacks for the sub-hour hybrid (session 086). DNS query events are the
 * raw base (tag=dns message_type="Query"); the logserv_dns_rollup `main`/`rtype`
 * measures map to raw as sum(count)->count, dc(eval(if(x="(none)",null,x)))->dc(x)
 * (the "(none)" fillnull sentinel drops on raw — stats-by drops nulls). Only the
 * `logserv_dns_rollup` reads are hybridised; the BEACONING KPI/tables (daily
 * streamstats gap-variance — no meaningful sub-hour answer + heavy raw) + the
 * sparklines stay cached. The two dynamic timechart memos (topClientsQuery /
 * recordTypesQuery) route in-line via shouldUseRawSource, using `eval cnt=1 |
 * timechart sum(cnt)` so empty (split,bin) cells stay NULL like the cached
 * `sum(count)` (a plain `count` would 0-fill and diverge on sparse series).
 * ------------------------------------------------------------------------- */
const DNS_RAW = '`sap_logserv_idx_macro` tag=dns message_type="Query"';
const QRAW_BASE = {
    kpiQueries: `${DNS_RAW} | stats count`,
    kpiClients: `${DNS_RAW} | stats dc(src) as clients`,
    topDomains: `${DNS_RAW} | stats count as Queries, dc(src) as "Unique Clients" by query | sort -Queries | rename query as Domain`,
    nxDomain: `${DNS_RAW} | stats count as Queries, dc(query) as "Unique Domains" by src | eval "Queries per Domain"=round(Queries/'Unique Domains', 1) | sort -"Unique Domains" | rename src as "Client IP"`,
    topResolvers: `${DNS_RAW} | stats count as Queries, dc(query) as "Unique Domains", dc(src) as "Unique Clients" by host | sort -Queries | rename host as "Resolver"`,
    queryTypes: `${DNS_RAW} record_type=* | ${RECORD_TYPE_RELABEL} | stats count as count by record_type | sort -count`,
};

interface FirstRow { value: unknown; loading: boolean; error: Error | null; }
const useFirstRowField = (q: string, f: string): FirstRow => {
    const { results, loading, error } = useSearch({ query: q });
    const value = results && results[0] ? (results[0] as Record<string, unknown>)[f] : undefined;
    return { value, loading, error };
};
/** useFirstRowField over a hybrid cached/raw pair (session 085). */
const useFirstRowFieldHybrid = (cached: string, raw: string, f: string): FirstRow => {
    const { results, loading, error } = useHybridSearch({ cached, raw });
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
    const { provider } = useCloudProvider();
    const Q = React.useMemo(() => mapCloudProviderQueries(Q_BASE, provider), [provider]);
    // RAW fallbacks for the sub-hour hybrid (session 086); same cloud mapping.
    const QRAW = React.useMemo(() => mapCloudProviderQueries(QRAW_BASE, provider), [provider]);
    const queries = useFirstRowFieldHybrid(Q.kpiQueries, QRAW.kpiQueries, 'count');
    const clients = useFirstRowFieldHybrid(Q.kpiClients, QRAW.kpiClients, 'clients');
    const beaconing = useFirstRowField(Q.kpiBeaconing, 'count');

    const beaconingActivity = useSearch({ query: Q.beaconingActivity });
    const hostsToBeaconing = useSearch({ query: Q.hostsToBeaconing });
    const topDomains = useHybridSearch({ cached: Q.topDomains, raw: QRAW.topDomains });
    const nxDomain = useHybridSearch({ cached: Q.nxDomain, raw: QRAW.nxDomain });
    const topResolvers = useHybridSearch({ cached: Q.topResolvers, raw: QRAW.topResolvers });
    const qQueryTypes = useRoutedQuery(Q.queryTypes, QRAW.queryTypes);

    const { timeRange } = useTimeRange();
    // Sub-hour routing decision for the dynamic timechart memos below (they
    // build their SPL in a useMemo, so they can't call the useRoutedQuery hook).
    const useRawSrc = shouldUseRawSource(timeRange.earliest, timeRange.latest);

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
    // volume so the dropdown's first items are the busiest clients. Hybrid so a
    // sub-hour range populates the dropdown from the raw index, not the empty
    // hourly buckets. (Not cloud-filtered — matches the pre-hybrid behavior of
    // this dropdown populator and the dynamic chart memos below.)
    const clientListSearch = useHybridSearch<{ src?: string; count?: string | number }>({
        cached: `${MAIN} | search src!="(none)" | stats sum(count) as count by src | sort -count`,
        raw: `${DNS_RAW} | stats count by src | sort -count`,
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
            ? ` | search (${selectedClients.map((c) => `src="${c.replace(/"/g, '\\"')}"`).join(' OR ')})`
            : '';
        const limitVal = hasClientPick ? '0' : (topN === 'all' ? '0' : topN);
        if (useRawSrc) {
            // Sub-hour: raw DNS events at the real (sub-hour) span. `eval cnt=1 |
            // sum(cnt)` null-fills empty (src,bin) cells to match the cached
            // `sum(count)` (a plain `count` would 0-fill and diverge on sparse series).
            return (
                `${DNS_RAW}${clientFilterClause} | eval cnt=1 ` +
                `| timechart span=${span} limit=${limitVal} usenull=f useother=f sum(cnt) AS Requests by src`
            );
        }
        return (
            `${MAIN}${clientFilterClause} | search src!="(none)" | eval _time=bucket_ts ` +
            `| timechart span=${span} limit=${limitVal} usenull=f useother=f sum(count) AS Requests by src`
        );
    }, [span, topN, selectedClients, useRawSrc]);

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
            useRawSrc
                ? `${DNS_RAW} record_type=* | ${RECORD_TYPE_RELABEL} | eval cnt=1 `
                  + `| timechart span=${span} usenull=f useother=f sum(cnt) BY record_type`
                : `${RTYPE} | search record_type!="(none)" | ${RECORD_TYPE_RELABEL} | eval _time=bucket_ts `
                  + `| timechart span=${span} usenull=f useother=f sum(count) BY record_type`,
        [span, useRawSrc],
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
                <FramedPanel search={beaconingActivity} title="Beaconing Activity" subtitle="Domains with low beacon variance + steady cadence (suspicious)">
                    <DataTable columns={BEACONING_COLS} rows={beaconingActivity.results} loading={beaconingActivity.loading} error={beaconingActivity.error} emptyMessage="No beaconing patterns detected in this time range." initialSortKey="count" initialSortDir="desc" onRowClick={goBeaconingRow} />
                </FramedPanel>
                <FramedPanel search={hostsToBeaconing} title="Hosts to Beaconing Domains" subtitle="Domains beaconed to + how many hosts contacted them">
                    <DataTable columns={HOSTS_BEACONING_COLS} rows={hostsToBeaconing.results} loading={hostsToBeaconing.loading} error={hostsToBeaconing.error} emptyMessage="No host-to-beaconing patterns in this time range." initialSortKey="count" initialSortDir="desc" onRowClick={goHostsToBeaconingRow} />
                </FramedPanel>
            </PanelGrid2>

            <PanelGrid3>
                <FramedPanel search={topDomains} title="Queried Domains" subtitle="Domains ranked by query volume">
                    <DataTable columns={TOP_DOM_COLS} rows={topDomains.results} loading={topDomains.loading} error={topDomains.error} emptyMessage="No DNS queries in this time range." onRowClick={goTopDomainsRow} />
                </FramedPanel>
                <FramedPanel search={nxDomain} title="Clients by Domain Diversity" subtitle="Clients ranked by unique domains queried">
                    <DataTable columns={NX_DOM_COLS} rows={nxDomain.results} loading={nxDomain.loading} error={nxDomain.error} emptyMessage="No DNS queries in this time range." onRowClick={goClientDiversityRow} />
                </FramedPanel>
                <FramedPanel title="Query Type Distribution" subtitle="Share of total queries by record type">
                    <PieChart query={qQueryTypes} categoryField="record_type" valueField="count" height={300} donut />
                </FramedPanel>
            </PanelGrid3>

            <FullWidthPanel>
                <FramedPanel search={topResolvers} title="DNS Resolvers" subtitle="Resolvers (BIND hosts) ranked by query volume">
                    <DataTable columns={RESOLVER_COLS} rows={topResolvers.results} loading={topResolvers.loading} error={topResolvers.error} emptyMessage="No DNS resolvers in this time range." pageSize={5} onRowClick={goResolverRow} />
                </FramedPanel>
            </FullWidthPanel>
        </DashboardLayout>
    );
};

export default DnsAnalytics;
