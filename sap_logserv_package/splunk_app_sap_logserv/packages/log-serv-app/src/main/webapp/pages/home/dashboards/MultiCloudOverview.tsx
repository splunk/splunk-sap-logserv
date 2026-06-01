import React from 'react';
import styled from 'styled-components';
import KpiCard, { formatInteger } from '../components/KpiCard';
import FramedPanel from '../components/FramedPanel';
import DataTable, { ColumnDef } from '../components/DataTable';
import TimeSeriesChart from '../components/TimeSeriesChart';
import { SparklineFromQuery } from '../components/Sparkline';
import DashboardLayout from '../components/DashboardLayout';
import { useSearch } from '../hooks/useSearch';
import { logservTheme } from '../styles/logservTheme';

/**
 * Multi-Cloud Overview — splits LogServ ingest by cloud provider (AWS / Azure).
 *
 * Built for v0.0.5.0 Phase 5 of Azure support. Surfaces the cloud_provider
 * field (indexed at ingest time via the Splunk add-on's `_meta = cloud_provider::azure`
 * setting for Azure inputs; defaulted to "aws" for legacy AWS S3 inputs via the
 * `sap_logserv_cloud_provider_default_macro` in macros.conf).
 *
 * Designed to be the answer to "are we ingesting from both clouds, and are
 * they roughly balanced?" Customers running single-cloud see the dashboard
 * collapse cleanly to one provider; multi-cloud customers see comparative
 * KPIs + side-by-side trend.
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

const CP_NORM = '`sap_logserv_cloud_provider_default_macro`';

const Q = {
    kpiTotal: `\`sap_logserv_idx_macro\` | stats count`,
    kpiAws: `\`sap_logserv_idx_macro\` | ${CP_NORM} | where cloud_provider="aws" | stats count`,
    kpiAzure: `\`sap_logserv_idx_macro\` | ${CP_NORM} | where cloud_provider="azure" | stats count`,

    sparkTotal: `\`sap_logserv_idx_macro\` | timechart span=1d count`,
    sparkAws: `\`sap_logserv_idx_macro\` | ${CP_NORM} | where cloud_provider="aws" | timechart span=1d count`,
    sparkAzure: `\`sap_logserv_idx_macro\` | ${CP_NORM} | where cloud_provider="azure" | timechart span=1d count`,

    volumeByProvider: `\`sap_logserv_idx_macro\` | ${CP_NORM} | timechart span=1d count by cloud_provider`,

    sourcetypeByProvider: `\`sap_logserv_idx_macro\` | ${CP_NORM} | stats count by sourcetype cloud_provider | xyseries sourcetype cloud_provider count | rename sourcetype as "Sourcetype" aws as "AWS" azure as "Azure" | fillnull value=0 "AWS" "Azure" | eval Total = AWS + Azure | sort -Total | head 30`,

    hostsByProvider: `\`sap_logserv_idx_macro\` | ${CP_NORM} | stats dc(host) as hosts by cloud_provider | rename cloud_provider as "Cloud Provider" hosts as "Distinct Hosts"`,
    sourcetypesByProvider: `\`sap_logserv_idx_macro\` | ${CP_NORM} | stats dc(sourcetype) as sourcetypes by cloud_provider | rename cloud_provider as "Cloud Provider" sourcetypes as "Distinct Sourcetypes"`,
    eventsByProvider: `\`sap_logserv_idx_macro\` | ${CP_NORM} | stats count by cloud_provider | rename cloud_provider as "Cloud Provider" count as "Event Count"`,
};

interface FirstRow { value: unknown; loading: boolean; error: Error | null; }
const useFirstRowField = (q: string, f: string): FirstRow => {
    const { results, loading, error } = useSearch({ query: q });
    const value = results && results[0] ? (results[0] as Record<string, unknown>)[f] : undefined;
    return { value, loading, error };
};

const sourcetypeColumns: ColumnDef[] = [
    { key: 'Sourcetype', label: 'Sourcetype' },
    { key: 'AWS', label: 'AWS Events', align: 'right', render: (v) => formatInteger(v) },
    { key: 'Azure', label: 'Azure Events', align: 'right', render: (v) => formatInteger(v) },
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
    const total = useFirstRowField(Q.kpiTotal, 'count');
    const aws = useFirstRowField(Q.kpiAws, 'count');
    const azure = useFirstRowField(Q.kpiAzure, 'count');

    const { results: sourcetypeRows, loading: stLoading, error: stError } = useSearch({ query: Q.sourcetypeByProvider });
    const { results: hostRows, loading: hostsLoading, error: hostsError } = useSearch({ query: Q.hostsByProvider });
    const { results: stCountRows, loading: stcLoading, error: stcError } = useSearch({ query: Q.sourcetypesByProvider });
    const { results: eventCountRows, loading: eventCountLoading, error: eventCountError } = useSearch({ query: Q.eventsByProvider });

    return (
        <DashboardLayout
            category="PLATFORM"
            title="Multi-Cloud Overview"
            subtitle="LogServ ingest split by cloud provider — AWS + Azure side-by-side"
        >
            <KpiRow>
                <KpiCard
                    label="Total Events"
                    value={total.value as number | string | undefined}
                    loading={total.loading}
                    error={total.error}
                    formatValue={formatInteger}
                    sub={<SparklineFromQuery query={Q.sparkTotal} valueField="count" />}
                />
                <KpiCard
                    label="AWS Events"
                    value={aws.value as number | string | undefined}
                    loading={aws.loading}
                    error={aws.error}
                    tone="neutral"
                    formatValue={formatInteger}
                    sub={<SparklineFromQuery query={Q.sparkAws} valueField="count" />}
                />
                <KpiCard
                    label="Azure Events"
                    value={azure.value as number | string | undefined}
                    loading={azure.loading}
                    error={azure.error}
                    tone="neutral"
                    formatValue={formatInteger}
                    sub={<SparklineFromQuery query={Q.sparkAzure} valueField="count" />}
                />
            </KpiRow>

            <FullWidthPanel>
                <FramedPanel title="Daily Event Volume by Cloud Provider" subtitle="Stacked daily count, split AWS vs Azure">
                    <TimeSeriesChart query={Q.volumeByProvider} chartType="column" palette="categorical" />
                </FramedPanel>
            </FullWidthPanel>

            <PanelGrid2>
                <FramedPanel title="Event Count by Provider" subtitle="Raw cumulative count">
                    <DataTable columns={eventCountColumns} rows={eventCountRows} loading={eventCountLoading} error={eventCountError} pageSize={10} />
                </FramedPanel>
                <FramedPanel title="Distinct Hosts by Provider" subtitle="How many unique hosts reported in each cloud">
                    <DataTable columns={summaryColumns} rows={hostRows} loading={hostsLoading} error={hostsError} pageSize={10} />
                </FramedPanel>
            </PanelGrid2>

            <PanelGrid2>
                <FramedPanel title="Distinct Sourcetypes by Provider" subtitle="Sourcetype diversity per cloud">
                    <DataTable columns={sourcetypeCountColumns} rows={stCountRows} loading={stcLoading} error={stcError} pageSize={10} />
                </FramedPanel>
                <FramedPanel title="" subtitle="">
                    <div style={{ padding: '12px', color: logservTheme.colors.textMuted, fontSize: logservTheme.fontSize.small }}>
                        <p style={{ margin: '0 0 8px 0' }}>
                            <strong>About the cloud_provider field</strong>
                        </p>
                        <p style={{ margin: '0 0 6px 0' }}>
                            Azure-sourced events carry an indexed <code>cloud_provider=azure</code> field via the Splunk Add-on for Microsoft Cloud Services input config (<code>_meta = cloud_provider::azure</code>).
                        </p>
                        <p style={{ margin: '0 0 6px 0' }}>
                            Legacy AWS events without the field are defaulted to <code>aws</code> via the <code>sap_logserv_cloud_provider_default_macro</code> in macros.conf. To attribute new AWS events explicitly, set <code>_meta = cloud_provider::aws</code> on your <code>Splunk_TA_aws</code> SQS-based S3 input stanzas.
                        </p>
                        <p style={{ margin: '0' }}>
                            See <a href="/en-US/app/splunk_app_sap_logserv/static/help/install-setup/azure-setup.html" target="_blank" rel="noopener noreferrer" style={{ color: '#ff9100', textDecoration: 'underline' }}>Azure Setup Guide</a> for full configuration details.
                        </p>
                    </div>
                </FramedPanel>
            </PanelGrid2>

            <FullWidthPanel>
                <FramedPanel title="Top Sourcetypes by Cloud Provider" subtitle="Event count split AWS vs Azure for the most-active sourcetypes (top 30)">
                    <DataTable columns={sourcetypeColumns} rows={sourcetypeRows} loading={stLoading} error={stError} pageSize={10} />
                </FramedPanel>
            </FullWidthPanel>
        </DashboardLayout>
    );
};

export default MultiCloudOverview;
