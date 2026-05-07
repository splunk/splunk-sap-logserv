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
import { buildSplunkSearchUrl, openInNewTab, splQuote } from '../utils/drilldownUrls';
import { logservTheme } from '../styles/logservTheme';

/**
 * SAP Services — honest port of v0.0.4.2 logserv_sap_services.xml.
 *
 * 3 KPIs (Total / Auth Failures / SSL Events) + Volume by Service stacked column +
 * Sapstartsrv Auth Events table + SSL Auth Failure Sources table + Host Agent Severity pie.
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
const PanelGrid2Wide = styled.div`
    display: grid;
    grid-template-columns: 2fr 1fr;
    gap: ${logservTheme.elevation.panelGap};
    margin-bottom: ${logservTheme.elevation.panelGap};
    @media (max-width: 1100px) { grid-template-columns: 1fr; }
`;

const Q = {
    kpiTotal: `\`sap_logserv_idx_macro\` sourcetype IN ("sap:sapstartsrv", "sap:saphostexec") | stats count`,
    kpiAuthFail: `\`sap_logserv_idx_macro\` sourcetype="sap:sapstartsrv" is_auth_event="true" auth_result="failure" | stats count`,
    kpiSslEvents: `\`sap_logserv_idx_macro\` sourcetype="sap:sapstartsrv" is_ssl_event="true" | stats count`,

    sparkTotal: `\`sap_logserv_idx_macro\` sourcetype IN ("sap:sapstartsrv", "sap:saphostexec") | timechart span=1d count`,
    sparkAuthFail: `\`sap_logserv_idx_macro\` sourcetype="sap:sapstartsrv" is_auth_event="true" auth_result="failure" | timechart span=1d count`,
    sparkSslEvents: `\`sap_logserv_idx_macro\` sourcetype="sap:sapstartsrv" is_ssl_event="true" | timechart span=1d count`,

    volumeByType: `\`sap_logserv_idx_macro\` sourcetype IN ("sap:sapstartsrv", "sap:saphostexec") | eval is_error_event = case(sourcetype="sap:sapstartsrv" AND is_auth_event="true" AND auth_result="failure", 1, sourcetype="sap:saphostexec" AND severity IN ("ERROR", "WARNING"), 1, 1=1, 0) | eval series = case(sourcetype="sap:sapstartsrv" AND is_error_event=1, "sapstartsrv (errors)", sourcetype="sap:sapstartsrv", "sapstartsrv (normal)", sourcetype="sap:saphostexec" AND is_error_event=1, "saphostexec (errors)", sourcetype="sap:saphostexec", "saphostexec (normal)") | timechart span=1d count by series`,
    authEvents: `\`sap_logserv_idx_macro\` sourcetype="sap:sapstartsrv" is_auth_event="true" | table _time auth_user remote_ip webmethod auth_result | sort -_time | rename auth_user as User remote_ip as "Remote IP" webmethod as Method auth_result as Result`,
    sslEvents: `\`sap_logserv_idx_macro\` sourcetype="sap:sapstartsrv" is_ssl_event="true" auth_result="failure" | stats count as failures, dc(auth_user) as users, values(auth_user) as user_list, latest(_time) as last_seen_ts, earliest(_time) as first_seen_ts by remote_ip | eval first_seen = strftime(first_seen_ts, "%Y-%m-%d %H:%M:%S") | eval last_seen = strftime(last_seen_ts, "%Y-%m-%d %H:%M:%S") | eval span_h = round((last_seen_ts - first_seen_ts)/3600, 1) | sort -failures | table remote_ip, failures, users, user_list, first_seen, last_seen, span_h | rename remote_ip as "Source IP", failures as "Failures", users as "Distinct Users", user_list as "Users Tried", first_seen as "First Seen", last_seen as "Last Seen", span_h as "Activity Span (h)"`,
    hostexecSeverity: `\`sap_logserv_idx_macro\` sourcetype="sap:saphostexec" severity=* | stats count by severity | sort -count`,
};

interface FirstRow { value: unknown; loading: boolean; error: Error | null; }
const useFirstRowField = (q: string, f: string): FirstRow => {
    const { results, loading, error } = useSearch({ query: q });
    const value = results && results[0] ? (results[0] as Record<string, unknown>)[f] : undefined;
    return { value, loading, error };
};

const AUTH_COLS: ColumnDef[] = [
    { key: '_time', label: 'Time', width: '160px', render: (v) => v ? new Date(String(v)).toLocaleString('en-US', { hour12: false }) : '' },
    { key: 'User', label: 'User' },
    { key: 'Remote IP', label: 'Remote IP' },
    { key: 'Method', label: 'Method' },
    { key: 'Result', label: 'Result' },
];
const SSL_COLS: ColumnDef[] = [
    { key: 'Source IP', label: 'Source IP' },
    { key: 'Failures', label: 'Failures', align: 'right', render: (v) => formatInteger(v) },
    { key: 'Distinct Users', label: 'Distinct Users', align: 'right', render: (v) => formatInteger(v) },
    { key: 'Users Tried', label: 'Users Tried' },
    { key: 'First Seen', label: 'First Seen' },
    { key: 'Last Seen', label: 'Last Seen' },
    { key: 'Activity Span (h)', label: 'Span (h)', align: 'right' },
];

const SapServices: React.FC = () => {
    const total = useFirstRowField(Q.kpiTotal, 'count');
    const authFail = useFirstRowField(Q.kpiAuthFail, 'count');
    const sslEvents = useFirstRowField(Q.kpiSslEvents, 'count');

    const authEvents = useSearch({ query: Q.authEvents });
    const sslSources = useSearch({ query: Q.sslEvents });

    const authFailTone = Number(authFail.value ?? 0) > 0 ? 'critical' : 'neutral';
    const sslTone = Number(sslEvents.value ?? 0) > 0 ? 'warning' : 'neutral';

    /* Drilldowns (build 159 / session 027 task 6). */
    const { timeRange } = useTimeRange();
    const goAuthRow = (row: Record<string, unknown>): void => {
        const ip = String(row['Remote IP'] ?? '');
        if (!ip) return;
        const spl = `\`sap_logserv_idx_macro\` sourcetype="sap:sapstartsrv" remote_ip="${splQuote(ip)}" | sort -_time | table _time auth_user auth_result webmethod`;
        openInNewTab(buildSplunkSearchUrl(spl, timeRange.earliest, timeRange.latest));
    };
    const goSslRow = (row: Record<string, unknown>): void => {
        const ip = String(row['Source IP'] ?? '');
        if (!ip) return;
        const spl = `\`sap_logserv_idx_macro\` sourcetype="sap:sapstartsrv" is_ssl_event="true" remote_ip="${splQuote(ip)}" | sort -_time`;
        openInNewTab(buildSplunkSearchUrl(spl, timeRange.earliest, timeRange.latest));
    };
    const goSeverityPie = (): void => {
        const spl = '`sap_logserv_idx_macro` sourcetype="sap:saphostexec" severity=* | stats count by host severity | sort -count';
        openInNewTab(buildSplunkSearchUrl(spl, timeRange.earliest, timeRange.latest));
    };

    return (
        <DashboardLayout
            category="INTEGRATION"
            title="SAP Services"
            subtitle="SAP startup service and host agent — authentication events, SSL/TLS failures, and service health"
        >
            <KpiRow>
                <KpiCard label="Total Events" value={total.value} loading={total.loading} error={total.error} formatValue={formatInteger}
                    sparkline={<SparklineFromQuery query={Q.sparkTotal} valueField="count" fill />} />
                <KpiCard label="Auth Failures" value={authFail.value} loading={authFail.loading} error={authFail.error} formatValue={formatInteger} tone={authFailTone}
                    sparkline={<SparklineFromQuery query={Q.sparkAuthFail} valueField="count" color={logservTheme.colors.red} fill />} />
                <KpiCard label="SSL/TLS Events" value={sslEvents.value} loading={sslEvents.loading} error={sslEvents.error} formatValue={formatInteger} tone={sslTone}
                    sparkline={<SparklineFromQuery query={Q.sparkSslEvents} valueField="count" color={logservTheme.colors.orange} fill />} />
            </KpiRow>

            <FullWidthPanel>
                <FramedPanel title="Event Volume by Service (Normal vs Errors)" subtitle="Daily volume per service / errors split">
                    <TimeSeriesChart
                        query={Q.volumeByType}
                        height={280}
                        seriesColorsByField={{
                            'saphostexec (errors)': '#b50101',
                            'saphostexec (normal)': '#009ceb',
                            'sapstartsrv (errors)': '#dc4e41',
                            'sapstartsrv (normal)': '#7b56db',
                        }}
                    />
                </FramedPanel>
            </FullWidthPanel>

            <PanelGrid2Wide>
                <FramedPanel title="Sapstartsrv Authentication Events" subtitle="SOAP auth attempts, most-recent first — click a row for that remote IP's full auth log">
                    <DataTable columns={AUTH_COLS} rows={authEvents.results} loading={authEvents.loading} error={authEvents.error} emptyMessage="No authentication events in this time range." onRowClick={goAuthRow} />
                </FramedPanel>
                <FramedPanel title="Host Agent Severity" subtitle="saphostexec severity distribution"
                    onClick={goSeverityPie} clickTitle="Open severity-by-host breakdown in Splunk Search">
                    <PieChart query={Q.hostexecSeverity} categoryField="severity" valueField="count" height={300} donut palette="status" />
                </FramedPanel>
            </PanelGrid2Wide>

            <FullWidthPanel>
                <FramedPanel title="SSL Authentication Failure Sources" subtitle="Source IPs failing SSL auth, ranked by failure count — click a row for that IP's full SSL event log">
                    <DataTable columns={SSL_COLS} rows={sslSources.results} loading={sslSources.loading} error={sslSources.error} emptyMessage="No SSL auth failures in this time range." onRowClick={goSslRow} />
                </FramedPanel>
            </FullWidthPanel>
        </DashboardLayout>
    );
};

export default SapServices;
