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
import { logservTheme } from '../styles/logservTheme';
import { DOCS_ROOT } from '../utils/docsLinks';

/**
 * Multi-Cloud Overview — splits LogServ ingest by cloud provider
 * (AWS / Azure / GCP).
 *
 * Built for v0.0.5.0 Phase 5 of Azure support; GCP added as a third
 * first-class provider in v0.0.6 (build 253). Surfaces the cloud_provider
 * field (indexed at ingest time via `_meta = cloud_provider::azure` /
 * `::gcp`, which the LogServ Azure and GCP add-ons inject on their inputs
 * automatically; defaulted to "aws" for legacy AWS S3 inputs via the
 * `sap_logserv_cloud_provider_default_macro` in macros.conf).
 *
 * Designed to be the answer to "are we ingesting from every cloud we
 * expect, and are they roughly balanced?" Customers running single-cloud
 * see the dashboard collapse cleanly to one provider; multi-cloud
 * customers see comparative KPIs + side-by-side trend.
 */

const KpiRow = styled.div`
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
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

/**
 * Dashboard-perf roadmap tier #6 (KV-Store precompute, session 053 / build 226).
 *
 * All 11 panels read from the `logserv_mc_rollup` KV Store collection (hourly
 * [logserv_mc_aggregate], one-time [logserv_mc_backfill]). 2 metrics:
 *  - count: grain (cloud_provider, sourcetype) + count. The null→aws coalesce
 *    (sap_logserv_cloud_provider_default_macro) is BAKED at aggregate time, so reads
 *    filter cloud_provider directly. NO host → count is multivalue-safe (#30: host is
 *    mv on ~653 events). Serves KPIs/sparks/volume + sourcetype/sourcetypes/event-count
 *    by provider. (kpiTotal sums ALL rows incl the coalesced + any additional provider
 *    value; kpiAws/kpiAzure/kpiGcp filter exactly, matching raw's macro-then-where.)
 *  - hosts: grain (cloud_provider, host) for dc(host) by provider — mv host expands
 *    identically in raw+rollup so the distinct-host SET per provider is exact.
 * sourcetype is fillnull'd "(none)" at aggregate (defensive — stats-by-null drops events);
 * total/by-provider reads include it, the sourcetype-grouped reads exclude/nullify it.
 * All-indexed dashboard, NO RAW panels.
 */
const ROLL = 'logserv_mc_rollup';
const RANGE = '| addinfo | where bucket_ts>=info_min_time AND bucket_ts<info_max_time';
const CNT = `| inputlookup ${ROLL} where metric="count" ${RANGE}`;
const HOSTS = `| inputlookup ${ROLL} where metric="hosts" ${RANGE}`;

const Q = {
    kpiTotal: `${CNT} | stats count as n, sum(count) as count | fillnull value=0 count | fields count`,
    kpiAws: `${CNT} | search cloud_provider="aws" | stats count as n, sum(count) as count | fillnull value=0 count | fields count`,
    kpiAzure: `${CNT} | search cloud_provider="azure" | stats count as n, sum(count) as count | fillnull value=0 count | fields count`,
    kpiGcp: `${CNT} | search cloud_provider="gcp" | stats count as n, sum(count) as count | fillnull value=0 count | fields count`,

    sparkTotal: `${CNT} | eval _time=bucket_ts | timechart span=1d sum(count) as count | fillnull value=0`,
    sparkAws: `${CNT} | search cloud_provider="aws" | eval _time=bucket_ts | timechart span=1d sum(count) as count | fillnull value=0`,
    sparkAzure: `${CNT} | search cloud_provider="azure" | eval _time=bucket_ts | timechart span=1d sum(count) as count | fillnull value=0`,
    sparkGcp: `${CNT} | search cloud_provider="gcp" | eval _time=bucket_ts | timechart span=1d sum(count) as count | fillnull value=0`,

    volumeByProvider: `${CNT} | eval _time=bucket_ts | timechart span=1d sum(count) by cloud_provider | fillnull value=0`,

    sourcetypeByProvider: `${CNT} | search sourcetype!="(none)" | stats sum(count) as count by sourcetype, cloud_provider | xyseries sourcetype cloud_provider count | rename sourcetype as "Sourcetype" aws as "AWS" azure as "Azure" gcp as "GCP" | fillnull value=0 "AWS" "Azure" "GCP" | eval Total = AWS + Azure + GCP | sort -Total | head 30`,

    hostsByProvider: `${HOSTS} | stats dc(eval(if(host="(none)",null(),host))) as hosts by cloud_provider | rename cloud_provider as "Cloud Provider" hosts as "Distinct Hosts"`,
    sourcetypesByProvider: `${CNT} | stats dc(eval(if(sourcetype="(none)",null(),sourcetype))) as sourcetypes by cloud_provider | rename cloud_provider as "Cloud Provider" sourcetypes as "Distinct Sourcetypes"`,
    eventsByProvider: `${CNT} | stats sum(count) as count by cloud_provider | rename cloud_provider as "Cloud Provider" count as "Event Count"`,
};

/* ---------------------------------------------------------------------------
 * RAW fallbacks for the sub-hour hybrid (session 086). Each is the raw scan its
 * rollup metric precomputes, reconstructed from [logserv_mc_aggregate]: the
 * `sap_logserv_cloud_provider_default_macro` bakes the null→aws coalesce, so the
 * raw filters cloud_provider directly (matching the cached). NOT cloud-mapped
 * (this dashboard is noCloudFilter). Only ROLLUP reads are hybridised; the
 * sparklines stay cached (cosmetic). sourcetypeByProvider keeps the GCP column
 * (build 253) — the fillnull-0 creates any absent provider column.
 * ------------------------------------------------------------------------- */
const MACRO = '`sap_logserv_idx_macro`';
const CP = '`sap_logserv_cloud_provider_default_macro`';
const QRAW = {
    kpiTotal: `${MACRO} | stats count`,
    kpiAws: `${MACRO} | ${CP} | where cloud_provider="aws" | stats count`,
    kpiAzure: `${MACRO} | ${CP} | where cloud_provider="azure" | stats count`,
    kpiGcp: `${MACRO} | ${CP} | where cloud_provider="gcp" | stats count`,
    volumeByProvider: `${MACRO} | ${CP} | timechart span=1d count by cloud_provider | fillnull value=0`,
    sourcetypeByProvider: `${MACRO} | ${CP} | stats count by sourcetype cloud_provider | xyseries sourcetype cloud_provider count | rename sourcetype as "Sourcetype" aws as "AWS" azure as "Azure" gcp as "GCP" | fillnull value=0 "AWS" "Azure" "GCP" | eval Total = AWS + Azure + GCP | sort -Total | head 30`,
    hostsByProvider: `${MACRO} | ${CP} | stats dc(host) as hosts by cloud_provider | rename cloud_provider as "Cloud Provider" hosts as "Distinct Hosts"`,
    sourcetypesByProvider: `${MACRO} | ${CP} | stats dc(sourcetype) as sourcetypes by cloud_provider | rename cloud_provider as "Cloud Provider" sourcetypes as "Distinct Sourcetypes"`,
    eventsByProvider: `${MACRO} | ${CP} | stats count by cloud_provider | rename cloud_provider as "Cloud Provider" count as "Event Count"`,
};

interface FirstRow { value: unknown; loading: boolean; error: Error | null; }
const useFirstRowField = (q: string, f: string): FirstRow => {
    const { results, loading, error } = useSearch({ query: q });
    const value = results && results[0] ? (results[0] as Record<string, unknown>)[f] : undefined;
    return { value, loading, error };
};
/** useFirstRowField over a hybrid cached/raw pair (session 086). */
const useFirstRowFieldHybrid = (cached: string, raw: string, f: string): FirstRow => {
    const { results, loading, error } = useHybridSearch({ cached, raw });
    const value = results && results[0] ? (results[0] as Record<string, unknown>)[f] : undefined;
    return { value, loading, error };
};

const sourcetypeColumns: ColumnDef[] = [
    { key: 'Sourcetype', label: 'Sourcetype' },
    { key: 'AWS', label: 'AWS Events', align: 'right', render: (v) => formatInteger(v) },
    { key: 'Azure', label: 'Azure Events', align: 'right', render: (v) => formatInteger(v) },
    { key: 'GCP', label: 'GCP Events', align: 'right', render: (v) => formatInteger(v) },
    { key: 'Total', label: 'Total', align: 'right', render: (v) => formatInteger(v) },
];

const summaryColumns: ColumnDef[] = [
    { key: 'Cloud Provider', label: 'Cloud Provider' },
    { key: 'Distinct Hosts', label: 'Distinct Hosts', align: 'right', render: (v) => formatInteger(v) },
];

const sourcetypeCountColumns: ColumnDef[] = [
    { key: 'Cloud Provider', label: 'Cloud Provider' },
    { key: 'Distinct Sourcetypes', label: 'Distinct Sourcetypes', align: 'right', render: (v) => formatInteger(v) },
];

const eventCountColumns: ColumnDef[] = [
    { key: 'Cloud Provider', label: 'Cloud Provider' },
    { key: 'Event Count', label: 'Event Count', align: 'right', render: (v) => formatInteger(v) },
];

const MultiCloudOverview: React.FC = () => {
    const total = useFirstRowFieldHybrid(Q.kpiTotal, QRAW.kpiTotal, 'count');
    const aws = useFirstRowFieldHybrid(Q.kpiAws, QRAW.kpiAws, 'count');
    const azure = useFirstRowFieldHybrid(Q.kpiAzure, QRAW.kpiAzure, 'count');
    const gcp = useFirstRowFieldHybrid(Q.kpiGcp, QRAW.kpiGcp, 'count');

    // build 234 — keep the full useSearch result objects (not destructured-and-
    // renamed) so each FramedPanel can pass `search={…}` to its toolbar.
    // Sub-hour hybrid (session 086): tables + volume route to raw on short ranges.
    const sourcetypeSearch = useHybridSearch({ cached: Q.sourcetypeByProvider, raw: QRAW.sourcetypeByProvider });
    const hostSearch = useHybridSearch({ cached: Q.hostsByProvider, raw: QRAW.hostsByProvider });
    const stCountSearch = useHybridSearch({ cached: Q.sourcetypesByProvider, raw: QRAW.sourcetypesByProvider });
    const eventCountSearch = useHybridSearch({ cached: Q.eventsByProvider, raw: QRAW.eventsByProvider });
    const qVolumeByProvider = useRoutedQuery(Q.volumeByProvider, QRAW.volumeByProvider);
    const { results: sourcetypeRows, loading: stLoading, error: stError } = sourcetypeSearch;
    const { results: hostRows, loading: hostsLoading, error: hostsError } = hostSearch;
    const { results: stCountRows, loading: stcLoading, error: stcError } = stCountSearch;
    const { results: eventCountRows, loading: eventCountLoading, error: eventCountError } = eventCountSearch;

    return (
        <DashboardLayout
            category="PLATFORM"
            title="Multi-Cloud Overview"
            subtitle="LogServ ingest split by cloud provider — AWS, Azure, and GCP side-by-side"
            noCloudFilter
        >
            <KpiRow>
                <KpiCard
                    label="Total Events"
                    value={total.value as number | string | undefined}
                    loading={total.loading}
                    error={total.error}
                    formatValue={formatInteger}
                    sub={<SparklineFromQuery query={Q.sparkTotal} valueField="count" color={logservTheme.colors.cyanAccent} fill />}
                />
                <KpiCard
                    label="AWS Events"
                    value={aws.value as number | string | undefined}
                    loading={aws.loading}
                    error={aws.error}
                    tone="neutral"
                    formatValue={formatInteger}
                    sub={<SparklineFromQuery query={Q.sparkAws} valueField="count" color={logservTheme.colors.teal} fill />}
                />
                <KpiCard
                    label="Azure Events"
                    value={azure.value as number | string | undefined}
                    loading={azure.loading}
                    error={azure.error}
                    tone="neutral"
                    formatValue={formatInteger}
                    sub={<SparklineFromQuery query={Q.sparkAzure} valueField="count" color={logservTheme.colors.purple} fill />}
                />
                <KpiCard
                    label="GCP Events"
                    value={gcp.value as number | string | undefined}
                    loading={gcp.loading}
                    error={gcp.error}
                    tone="neutral"
                    formatValue={formatInteger}
                    sub={<SparklineFromQuery query={Q.sparkGcp} valueField="count" color={logservTheme.colors.cyanLight} fill />}
                />
            </KpiRow>

            <FullWidthPanel>
                <FramedPanel title="Daily Event Volume by Cloud Provider" subtitle="Stacked daily count, split by provider">
                    <TimeSeriesChart query={qVolumeByProvider} chartType="column" palette="categorical" />
                </FramedPanel>
            </FullWidthPanel>

            <PanelGrid2>
                <FramedPanel title="Event Count by Provider" subtitle="Raw cumulative count" search={eventCountSearch}>
                    <DataTable columns={eventCountColumns} rows={eventCountRows} loading={eventCountLoading} error={eventCountError} pageSize={10} />
                </FramedPanel>
                <FramedPanel title="Distinct Hosts by Provider" subtitle="How many unique hosts reported in each cloud" search={hostSearch}>
                    <DataTable columns={summaryColumns} rows={hostRows} loading={hostsLoading} error={hostsError} pageSize={10} />
                </FramedPanel>
            </PanelGrid2>

            <PanelGrid2>
                <FramedPanel title="Distinct Sourcetypes by Provider" subtitle="Sourcetype diversity per cloud" search={stCountSearch}>
                    <DataTable columns={sourcetypeCountColumns} rows={stCountRows} loading={stcLoading} error={stcError} pageSize={10} />
                </FramedPanel>
                <FramedPanel title="" subtitle="">
                    <div style={{ padding: '12px', color: logservTheme.colors.textMuted, fontSize: logservTheme.fontSize.small }}>
                        <p style={{ margin: '0 0 8px 0' }}>
                            <strong>About the cloud_provider field</strong>
                        </p>
                        <p style={{ margin: '0 0 6px 0' }}>
                            Azure- and GCP-sourced events carry an indexed <code>cloud_provider</code> field (<code>azure</code> / <code>gcp</code>), injected automatically by the LogServ Azure and GCP add-ons on their input stanzas (<code>_meta = cloud_provider::azure</code> / <code>::gcp</code>).
                        </p>
                        <p style={{ margin: '0 0 6px 0' }}>
                            Legacy AWS events without the field are defaulted to <code>aws</code> via the <code>sap_logserv_cloud_provider_default_macro</code> in macros.conf. To attribute new AWS events explicitly, set <code>_meta = cloud_provider::aws</code> on your <code>Splunk_TA_aws</code> SQS-based S3 input stanzas, or use the Data TA&apos;s Configuration → Cloud Provider dropdown on a single-cloud forwarder.
                        </p>
                        <p style={{ margin: '0' }}>
                            See the <a href={`${DOCS_ROOT}/content/install-setup/azure-setup/`} target="_blank" rel="noopener noreferrer" style={{ color: logservTheme.colors.cyanAccent, textDecoration: 'underline' }}>Azure Setup Guide</a> and the <a href={`${DOCS_ROOT}/content/install-setup/gcp-setup/`} target="_blank" rel="noopener noreferrer" style={{ color: logservTheme.colors.cyanAccent, textDecoration: 'underline' }}>GCP Setup Guide</a> for full configuration details.
                        </p>
                    </div>
                </FramedPanel>
            </PanelGrid2>

            <FullWidthPanel>
                <FramedPanel title="Top Sourcetypes by Cloud Provider" subtitle="Event count split by provider for the most-active sourcetypes (top 30)" search={sourcetypeSearch}>
                    <DataTable columns={sourcetypeColumns} rows={sourcetypeRows} loading={stLoading} error={stError} pageSize={10} />
                </FramedPanel>
            </FullWidthPanel>
        </DashboardLayout>
    );
};

export default MultiCloudOverview;
