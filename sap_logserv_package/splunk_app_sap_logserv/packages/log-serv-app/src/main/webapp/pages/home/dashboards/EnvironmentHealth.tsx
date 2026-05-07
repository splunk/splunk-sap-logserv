import React, { useCallback } from 'react';
import styled from 'styled-components';
import KpiCard, { formatInteger } from '../components/KpiCard';
import FramedPanel from '../components/FramedPanel';
import DataTable, { ColumnDef } from '../components/DataTable';
import TimeSeriesChart from '../components/TimeSeriesChart';
import { SparklineFromQuery } from '../components/Sparkline';
import DashboardLayout from '../components/DashboardLayout';
import { useSearch } from '../hooks/useSearch';
import { useTimeRange } from '../state/TimeRangeProvider';
import {
    buildDashboardUrl,
    buildHostDetailsUrl,
    buildSplunkSearchUrl,
    openInNewTab,
} from '../utils/drilldownUrls';
import { logservTheme } from '../styles/logservTheme';

/**
 * Environment Health — honest port of v0.0.4.2 logserv_environment_health.xml.
 *
 * 7 KPIs + 7 trend charts + 1 line + 1 column + 2 tables = 18 panels.
 * Each KPI computes `total` (sum or avg over the time range) and shows a
 * daily sparkline below. Cross-cutting view across all sourcetypes.
 */

const KpiRow4 = styled.div`
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: ${logservTheme.elevation.panelGap};
    margin-bottom: ${logservTheme.elevation.panelGap};
    @media (max-width: 1100px) { grid-template-columns: repeat(2, minmax(0, 1fr)); }
`;
const KpiRow3 = styled.div`
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: ${logservTheme.elevation.panelGap};
    margin-bottom: ${logservTheme.elevation.panelGap};
    @media (max-width: 1100px) { grid-template-columns: 1fr; }
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
    @media (max-width: 1400px) { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    @media (max-width: 800px) { grid-template-columns: 1fr; }
`;
const FullWidthPanel = styled.div`
    margin-bottom: ${logservTheme.elevation.panelGap};
`;

// SPL queries — verbatim from v0.0.4.2 logserv_environment_health.xml dataSources.
const Q = {
    // KPIs
    totalErrors: `\`sap_logserv_idx_macro\` ((sourcetype="sap:abap:dispatcher" (dp_severity="ERROR" OR dp_severity="FATAL")) OR (sourcetype="sap:abap:icm" icm_is_error=1) OR (sourcetype="sap:abap:gateway" gw_error_detail=* gw_error_detail!="") OR (sourcetype="sap:hana:audit" status!="SUCCESSFUL") OR (sourcetype="sap:hana:tracelogs" hana_trace_severity IN ("error", "fatal")) OR (sourcetype="sap:sapstartsrv" is_auth_event="true" auth_result="failure") OR (sourcetype="sap:scc:audit" scc_audit_type="ACCESS_DENIED") OR (sourcetype="linux_secure" IN_DROP) OR (sourcetype="XmlWinEventLog" severity IN ("critical","error","high")) OR (sourcetype="sap:webdispatcher:access" status>=400) OR (sourcetype="squid:access" action="denied")) | stats count`,
    hanaFailures: `\`sap_logserv_idx_macro\` sourcetype="sap:hana:audit" status!="SUCCESSFUL" | stats count`,
    authFailures: `\`sap_logserv_idx_macro\` ((sourcetype="sap:sapstartsrv" is_auth_event="true" auth_result="failure") OR (sourcetype="sap:hana:audit" audit_action="CONNECT" status!="SUCCESSFUL")) | stats count`,
    firewallDrops: `\`sap_logserv_idx_macro\` sourcetype="linux_secure" IN_DROP | stats count`,
    webErrorRate: `\`sap_logserv_idx_macro\` sourcetype="sap:webdispatcher:access" | eval is_err=if(tonumber(status)>=400,1,0) | stats sum(is_err) as errors, count as total | eval pct = if(total>0, round(errors/total*100, 1), 0) | table pct`,
    beaconing: `\`sap_logserv_idx_macro\` tag=dns message_type="Query" | bucket _time span=1d as day | fields day, _time, query | streamstats current=f last(_time) as last_time by query, day | eval gap=last_time - _time | stats count, avg(gap) AS avg_gap, var(gap) AS var_gap BY query, day | where var_gap < 60 AND count > 2 AND avg_gap > 1 | stats dc(query) as count by day | rename day as _time | eventstats sum(count) as total`,
    pipelineEventsPerDay: `\`sap_logserv_idx_macro\` | timechart span=1d count as daily | stats avg(daily) as total | eval total=round(total, 0)`,

    // KPI sparklines (daily trends)
    sparkTotalErrors: `\`sap_logserv_idx_macro\` ((sourcetype="sap:abap:dispatcher" (dp_severity="ERROR" OR dp_severity="FATAL")) OR (sourcetype="sap:abap:icm" icm_is_error=1) OR (sourcetype="sap:abap:gateway" gw_error_detail=* gw_error_detail!="") OR (sourcetype="sap:hana:audit" status!="SUCCESSFUL") OR (sourcetype="sap:hana:tracelogs" hana_trace_severity IN ("error", "fatal")) OR (sourcetype="sap:sapstartsrv" is_auth_event="true" auth_result="failure") OR (sourcetype="sap:scc:audit" scc_audit_type="ACCESS_DENIED") OR (sourcetype="linux_secure" IN_DROP) OR (sourcetype="XmlWinEventLog" severity IN ("critical","error","high")) OR (sourcetype="sap:webdispatcher:access" status>=400) OR (sourcetype="squid:access" action="denied")) | timechart span=1d count`,
    sparkHanaFailures: `\`sap_logserv_idx_macro\` sourcetype="sap:hana:audit" status!="SUCCESSFUL" | timechart span=1d count`,
    sparkAuthFailures: `\`sap_logserv_idx_macro\` ((sourcetype="sap:sapstartsrv" is_auth_event="true" auth_result="failure") OR (sourcetype="sap:hana:audit" audit_action="CONNECT" status!="SUCCESSFUL")) | timechart span=1d count`,
    sparkFirewallDrops: `\`sap_logserv_idx_macro\` sourcetype="linux_secure" IN_DROP | timechart span=1d count`,
    sparkWebErrorRate: `\`sap_logserv_idx_macro\` sourcetype="sap:webdispatcher:access" | eval is_err=if(tonumber(status)>=400,1,0) | timechart span=1d sum(is_err) as errors_daily count as total_daily | eval pct = if(total_daily>0, round(errors_daily/total_daily*100, 1), 0) | fields _time pct`,
    sparkPipelineEvents: `\`sap_logserv_idx_macro\` | timechart span=1d count`,

    // Trend charts — 6 column charts by category
    errAbap: `\`sap_logserv_idx_macro\` ((sourcetype="sap:abap:dispatcher" (dp_severity="ERROR" OR dp_severity="FATAL")) OR (sourcetype="sap:abap:icm" icm_is_error=1) OR (sourcetype="sap:abap:gateway" gw_error_detail=* gw_error_detail!="")) | eval src=case(sourcetype="sap:abap:dispatcher", "Dispatcher", sourcetype="sap:abap:icm", "ICM", sourcetype="sap:abap:gateway", "Gateway") | timechart span=1d count by src`,
    errHana: `\`sap_logserv_idx_macro\` ((sourcetype="sap:hana:audit" status!="SUCCESSFUL") OR (sourcetype="sap:hana:tracelogs" (hana_trace_severity="error" OR hana_trace_severity="fatal"))) | eval src=case(sourcetype="sap:hana:audit", "Audit Failures", sourcetype="sap:hana:tracelogs", "Trace Errors") | timechart span=1d count by src`,
    errSecurity: `\`sap_logserv_idx_macro\` ((sourcetype="sap:sapstartsrv" is_auth_event="true" auth_result="failure") OR (sourcetype="linux_secure" IN_DROP)) | eval src=case(sourcetype="sap:sapstartsrv", "Auth Failures", sourcetype="linux_secure", "Firewall Drops") | timechart span=1d count by src`,
    errWebnet: `\`sap_logserv_idx_macro\` ((sourcetype="sap:webdispatcher:access") OR (sourcetype="sap:saprouter" is_error="true") OR (sourcetype="squid:access" action="denied")) | eval is_err=case(sourcetype="sap:webdispatcher:access", if(tonumber(status)>=400, 1, 0), 1=1, 1) | where is_err=1 | eval src=case(sourcetype="sap:webdispatcher:access", "WebDisp 4xx/5xx", sourcetype="sap:saprouter", "Router Errors", sourcetype="squid:access", "Proxy Denied") | timechart span=1d count by src`,
    errOsinfra: `\`sap_logserv_idx_macro\` sourcetype="XmlWinEventLog" (severity="high" OR severity="medium") | eval src=case(severity="high", "Windows High", severity="medium", "Windows Medium") | timechart span=1d count by src`,
    errScc: `\`sap_logserv_idx_macro\` sourcetype="sap:scc:http_access" status>=400 | eval src=case(status>=500, "5xx Server", status>=400, "4xx Client") | timechart span=1d count by src`,

    // Other charts
    webResponseTime: `\`sap_logserv_idx_macro\` sourcetype="sap:webdispatcher:access" | eval response_time_ms=tonumber(total_us)/1000 | timechart span=1d avg(response_time_ms) as "Avg Response Time (ms)"`,
    icmStatus: `\`sap_logserv_idx_macro\` sourcetype="sap:abap:icm" icm_status_code=* | eval status_cat=case(icm_status_code>=200 AND icm_status_code<300, "2xx", icm_status_code>=300 AND icm_status_code<400, "3xx", icm_status_code>=400 AND icm_status_code<500, "4xx", icm_status_code>=500, "5xx", 1=1, "Other") | timechart span=1d count by status_cat`,
    pipelineTrend: `\`sap_logserv_idx_macro\` | timechart span=1d count as "Events/Day"`,

    // Tables
    criticalEvents: `\`sap_logserv_idx_macro\` ((sourcetype="sap:hana:audit" status!="SUCCESSFUL") OR (sourcetype="sap:abap:dispatcher" (dp_severity="ERROR" OR dp_severity="FATAL")) OR (sourcetype="sap:hana:tracelogs" hana_trace_severity="fatal") OR (sourcetype="sap:sapstartsrv" is_auth_event="true" auth_result="failure") OR (sourcetype="XmlWinEventLog" severity="critical")) | eval Category=case(sourcetype="sap:hana:audit", "HANA Audit", sourcetype="sap:abap:dispatcher", "ABAP Dispatcher", sourcetype="sap:hana:tracelogs", "HANA Trace", sourcetype="sap:sapstartsrv", "Auth Failure", sourcetype="XmlWinEventLog", "Windows Critical", 1=1, sourcetype) | eval Detail=case(sourcetype="sap:hana:audit", status." - ".audit_action." by ".executing_user, sourcetype="sap:abap:dispatcher", dp_severity." - ".coalesce(dp_message, _raw), sourcetype="sap:hana:tracelogs", hana_trace_severity." - ".hana_trace_component, sourcetype="sap:sapstartsrv", "Auth failure for ".coalesce(auth_user, "unknown"), sourcetype="XmlWinEventLog", coalesce(source, "WinEvent")." EventCode=".coalesce(EventCode, "N/A"), 1=1, "") | eval Time=strftime(_time, "%Y-%m-%d %H:%M:%S") | table Time host Category sourcetype Detail | sort -Time`,
    topHosts: `\`sap_logserv_idx_macro\` ((sourcetype="sap:abap:dispatcher" (dp_severity="ERROR" OR dp_severity="FATAL")) OR (sourcetype="sap:abap:icm" icm_is_error=1) OR (sourcetype="sap:abap:gateway" gw_error_detail=* gw_error_detail!="") OR (sourcetype="sap:hana:audit" status!="SUCCESSFUL") OR (sourcetype="sap:hana:tracelogs" (hana_trace_severity="error" OR hana_trace_severity="fatal")) OR (sourcetype="sap:scc:http_access" is_error="true") OR (sourcetype="sap:sapstartsrv" is_auth_event="true" auth_result="failure") OR (sourcetype="sap:saprouter" is_error="true") OR (sourcetype="squid:access" action="denied") OR (sourcetype="sap:webdispatcher:access") OR (sourcetype="XmlWinEventLog") OR (sourcetype="linux_secure")) | eval is_err=case(sourcetype="sap:webdispatcher:access", if(tonumber(status)>=400, 1, 0), sourcetype="XmlWinEventLog", if(severity IN ("high", "medium"), 1, 0), sourcetype="linux_secure", if(match(_raw, "IN_DROP"), 1, 0), 1=1, 1) | where is_err=1 | eval error_cat=case(sourcetype IN ("sap:abap:dispatcher","sap:abap:icm","sap:abap:gateway"), "ABAP", sourcetype IN ("sap:hana:audit","sap:hana:tracelogs"), "HANA", sourcetype IN ("sap:sapstartsrv","sap:saprouter"), "Services", sourcetype IN ("linux_secure"), "Firewall", 1=1, "Other") | chart count by host error_cat | addtotals | sort -Total`,
};

/** SPL dispatched when the user clicks the "Total Errors" KPI. Cross-cutting
 *  view of errors across all 11 sourcetypes the KPI counts, broken down by
 *  Category + sourcetype with affected-host count + last-seen timestamp.
 *  Ported from v0.0.4.2 logserv_environment_health.xml's
 *  viz_kpi_total_errors drilldown URL. The Splunk Search app is the only
 *  destination broad enough to host this — no single React dashboard owns
 *  the cross-cutting view. Build 157 / session 027 task 4. */
const TOTAL_ERRORS_DRILLDOWN_SPL =
    '`sap_logserv_idx_macro` ((sourcetype="sap:abap:dispatcher" (dp_severity="ERROR" OR dp_severity="FATAL")) OR ' +
    '(sourcetype="sap:abap:icm" icm_is_error=1) OR ' +
    '(sourcetype="sap:abap:gateway" gw_error_detail=* gw_error_detail!="") OR ' +
    '(sourcetype="sap:hana:audit" status!="SUCCESSFUL") OR ' +
    '(sourcetype="sap:hana:tracelogs" hana_trace_severity IN ("error", "fatal")) OR ' +
    '(sourcetype="sap:sapstartsrv" is_auth_event="true" auth_result="failure") OR ' +
    '(sourcetype="sap:scc:audit" scc_audit_type="ACCESS_DENIED") OR ' +
    '(sourcetype="linux_secure" IN_DROP) OR ' +
    '(sourcetype="XmlWinEventLog" severity IN ("critical","error","high")) OR ' +
    '(sourcetype="sap:webdispatcher:access" status>=400) OR ' +
    '(sourcetype="squid:access" action="denied")) ' +
    '| eval Category=case(match(sourcetype,"sap:abap"),"ABAP",match(sourcetype,"sap:hana"),"HANA",' +
    'sourcetype IN ("sap:sapstartsrv","sap:scc:audit","linux_secure"),"Security",' +
    'sourcetype IN ("sap:webdispatcher:access","squid:access"),"Web/Network",' +
    'sourcetype="XmlWinEventLog","OS/Infra",1=1,"Other") ' +
    '| stats count as Errors dc(host) as "Affected Hosts" latest(_time) as lt by Category sourcetype ' +
    '| eval "Last Seen"=strftime(lt,"%Y-%m-%d %H:%M") | fields - lt | sort -Errors';

interface FirstRow { value: unknown; loading: boolean; error: Error | null; }
const useFirstRowField = (q: string, f: string): FirstRow => {
    const { results, loading, error } = useSearch({ query: q });
    const value = results && results[0] ? (results[0] as Record<string, unknown>)[f] : undefined;
    return { value, loading, error };
};

const formatPercent = (raw: unknown): string => {
    if (raw === null || typeof raw === 'undefined') return '—';
    const n = typeof raw === 'number' ? raw : parseFloat(String(raw));
    if (Number.isNaN(n)) return String(raw);
    return `${n.toFixed(1)}%`;
};

const CRITICAL_EVENT_COLS: ColumnDef[] = [
    { key: 'Time', label: 'Time', width: '160px' },
    { key: 'host', label: 'Host', width: '180px' },
    { key: 'Category', label: 'Category', width: '160px' },
    { key: 'sourcetype', label: 'Sourcetype', width: '200px' },
    { key: 'Detail', label: 'Detail' },
];

const TOP_HOSTS_COLS: ColumnDef[] = [
    { key: 'host', label: 'Host' },
    { key: 'ABAP', label: 'ABAP', align: 'right', render: (v) => formatInteger(v) },
    { key: 'HANA', label: 'HANA', align: 'right', render: (v) => formatInteger(v) },
    { key: 'Services', label: 'Services', align: 'right', render: (v) => formatInteger(v) },
    { key: 'Firewall', label: 'Firewall', align: 'right', render: (v) => formatInteger(v) },
    { key: 'Other', label: 'Other', align: 'right', render: (v) => formatInteger(v) },
    { key: 'Total', label: 'Total', align: 'right', render: (v) => formatInteger(v) },
];

const EnvironmentHealth: React.FC = () => {
    const totalErrors = useFirstRowField(Q.totalErrors, 'count');
    const hanaFailures = useFirstRowField(Q.hanaFailures, 'count');
    const authFailures = useFirstRowField(Q.authFailures, 'count');
    const firewallDrops = useFirstRowField(Q.firewallDrops, 'count');
    const webErrorRate = useFirstRowField(Q.webErrorRate, 'pct');
    const beaconing = useFirstRowField(Q.beaconing, 'total');
    const pipelineEvents = useFirstRowField(Q.pipelineEventsPerDay, 'total');

    const criticalEvents = useSearch({ query: Q.criticalEvents });
    const topHosts = useSearch({ query: Q.topHosts });

    const errorsTone = (Number(totalErrors.value ?? 0) > 100) ? 'critical' : (Number(totalErrors.value ?? 0) > 0) ? 'warning' : 'neutral';
    const fwTone = (Number(firewallDrops.value ?? 0) > 1000) ? 'critical' : (Number(firewallDrops.value ?? 0) > 0) ? 'warning' : 'neutral';
    const errRateNum = parseFloat(String(webErrorRate.value ?? 0));
    const errRateTone = errRateNum >= 5 ? 'critical' : errRateNum >= 1 ? 'warning' : 'neutral';

    /* Drilldowns (build 157 / session 027 task 4): every KPI, chart, and
     * table row opens a related dashboard (or Splunk Search app for Total
     * Errors) in a NEW BROWSER TAB with the current TimeRange embedded as
     * `?earliest=…&latest=…` URL params. The destination dashboard's
     * TimeRangeProvider hydrates from those params on first mount, so the
     * source dashboard's selected window is preserved across the navigation.
     * Mapping ported from v0.0.4.2 logserv_environment_health.xml. */
    const { timeRange } = useTimeRange();
    const goTo = useCallback(
        (slug: string) => () => openInNewTab(buildDashboardUrl(slug, timeRange.earliest, timeRange.latest)),
        [timeRange.earliest, timeRange.latest],
    );
    const goToTotalErrorsSearch = useCallback(
        () => openInNewTab(buildSplunkSearchUrl(TOTAL_ERRORS_DRILLDOWN_SPL, timeRange.earliest, timeRange.latest)),
        [timeRange.earliest, timeRange.latest],
    );
    const goToHostDetails = useCallback(
        (row: Record<string, unknown>) => {
            const host = String(row.host ?? '');
            if (!host) return;
            openInNewTab(buildHostDetailsUrl(host, timeRange.earliest, timeRange.latest));
        },
        [timeRange.earliest, timeRange.latest],
    );

    return (
        <DashboardLayout
            category="HOME"
            title="Environment Health"
            subtitle="Cross-cutting operational view — KPIs, error trends by category, critical events, and host health matrix"
        >
            <KpiRow4>
                <KpiCard label="Total Errors" value={totalErrors.value} loading={totalErrors.loading} error={totalErrors.error} formatValue={formatInteger} tone={errorsTone}
                    sparkline={<SparklineFromQuery query={Q.sparkTotalErrors} valueField="count" color={logservTheme.colors.red} fill />}
                    onClick={goToTotalErrorsSearch}
                    clickTitle="Open the cross-cutting error breakdown in Splunk Search (new tab)" />
                <KpiCard label="HANA Failed Ops" value={hanaFailures.value} loading={hanaFailures.loading} error={hanaFailures.error} formatValue={formatInteger} tone={Number(hanaFailures.value ?? 0) > 0 ? 'critical' : 'neutral'}
                    sparkline={<SparklineFromQuery query={Q.sparkHanaFailures} valueField="count" color={logservTheme.colors.red} fill />}
                    onClick={goTo('hana-audit')}
                    clickTitle="Open HANA Audit dashboard (new tab)" />
                <KpiCard label="Auth Failures" value={authFailures.value} loading={authFailures.loading} error={authFailures.error} formatValue={formatInteger} tone={Number(authFailures.value ?? 0) > 0 ? 'warning' : 'neutral'}
                    sparkline={<SparklineFromQuery query={Q.sparkAuthFailures} valueField="count" color={logservTheme.colors.red} fill />}
                    onClick={goTo('sap-services')}
                    clickTitle="Open SAP Services dashboard (new tab)" />
                <KpiCard label="Firewall Drops" value={firewallDrops.value} loading={firewallDrops.loading} error={firewallDrops.error} formatValue={formatInteger} tone={fwTone}
                    sparkline={<SparklineFromQuery query={Q.sparkFirewallDrops} valueField="count" color={logservTheme.colors.red} fill />}
                    onClick={goTo('linux')}
                    clickTitle="Open Linux dashboard (new tab)" />
            </KpiRow4>

            <KpiRow3>
                <KpiCard label="Web Error Rate" value={webErrorRate.value} loading={webErrorRate.loading} error={webErrorRate.error} formatValue={formatPercent} tone={errRateTone}
                    sparkline={<SparklineFromQuery query={Q.sparkWebErrorRate} valueField="pct" color={logservTheme.colors.red} fill />}
                    onClick={goTo('web-dispatcher')}
                    clickTitle="Open Web Dispatcher dashboard (new tab)" />
                <KpiCard label="Beaconing Domains" value={beaconing.value} loading={beaconing.loading} error={beaconing.error} formatValue={formatInteger}
                    sparkline={<SparklineFromQuery query={Q.beaconing} valueField="count" color={logservTheme.colors.purple} fill />}
                    onClick={goTo('dns-analytics')}
                    clickTitle="Open DNS Analytics dashboard (new tab)" />
                <KpiCard label="Data Pipeline — Events/Day (Avg)" value={pipelineEvents.value} loading={pipelineEvents.loading} error={pipelineEvents.error} formatValue={formatInteger}
                    sparkline={<SparklineFromQuery query={Q.sparkPipelineEvents} valueField="count" fill />}
                    onClick={goTo('data-pipeline-overview')}
                    clickTitle="Open Data Pipeline Overview dashboard (new tab)" />
            </KpiRow3>

            <FullWidthPanel>
                <FramedPanel title="Daily Event Volume Trend" subtitle="Total events per day across all sourcetypes"
                    onClick={goTo('data-pipeline-overview')}
                    clickTitle="Open Data Pipeline Overview dashboard (new tab)">
                    <TimeSeriesChart query={Q.pipelineTrend} height={260} palette="volume" />
                </FramedPanel>
            </FullWidthPanel>

            <PanelGrid3>
                <FramedPanel title="ABAP Error Trend" subtitle="Dispatcher / ICM / Gateway errors"
                    onClick={goTo('abap-security')}
                    clickTitle="Open ABAP Security dashboard (new tab)">
                    <TimeSeriesChart query={Q.errAbap} height={240} palette="errors" />
                </FramedPanel>
                <FramedPanel title="HANA Error Trend" subtitle="Audit failures + trace errors"
                    onClick={goTo('hana-audit')}
                    clickTitle="Open HANA Audit dashboard (new tab)">
                    <TimeSeriesChart query={Q.errHana} height={240} palette="errors-2" />
                </FramedPanel>
                <FramedPanel title="Security Error Trend" subtitle="Auth failures + firewall drops"
                    onClick={goTo('sap-services')}
                    clickTitle="Open SAP Services dashboard (new tab)">
                    <TimeSeriesChart query={Q.errSecurity} height={240} palette="errors-3" />
                </FramedPanel>
            </PanelGrid3>

            <PanelGrid3>
                <FramedPanel title="Web/Network Error Trend" subtitle="Web Disp 4xx/5xx + Router errors + Proxy denied"
                    onClick={goTo('web-dispatcher')}
                    clickTitle="Open Web Dispatcher dashboard (new tab)">
                    <TimeSeriesChart query={Q.errWebnet} height={240} palette="errors" />
                </FramedPanel>
                <FramedPanel title="OS/Infra Error Trend" subtitle="Windows high/medium severity events"
                    onClick={goTo('windows')}
                    clickTitle="Open Windows dashboard (new tab)">
                    <TimeSeriesChart query={Q.errOsinfra} height={240} palette="errors-2" />
                </FramedPanel>
                <FramedPanel title="Cloud Connector Error Trend" subtitle="SCC HTTP 4xx/5xx"
                    onClick={goTo('cloud-connector')}
                    clickTitle="Open Cloud Connector dashboard (new tab)">
                    <TimeSeriesChart query={Q.errScc} height={240} palette="errors-3" />
                </FramedPanel>
            </PanelGrid3>

            <PanelGrid2>
                <FramedPanel title="Web Dispatcher Response Time" subtitle="Daily average response time (ms)"
                    onClick={goTo('web-dispatcher')}
                    clickTitle="Open Web Dispatcher dashboard (new tab)">
                    <TimeSeriesChart query={Q.webResponseTime} height={240} palette="volume" />
                </FramedPanel>
                <FramedPanel title="ICM Status Codes" subtitle="ABAP ICM status-class breakdown over time"
                    onClick={goTo('abap-security')}
                    clickTitle="Open ABAP Security dashboard (new tab)">
                    <TimeSeriesChart query={Q.icmStatus} height={240} palette="status" />
                </FramedPanel>
            </PanelGrid2>

            <FullWidthPanel>
                <FramedPanel title="Recent Critical Events" subtitle="Critical signals across HANA / ABAP / Auth / Windows, most-recent first">
                    <DataTable
                        columns={CRITICAL_EVENT_COLS}
                        rows={criticalEvents.results}
                        loading={criticalEvents.loading}
                        error={criticalEvents.error}
                        emptyMessage="No critical events in this time range."
                        onRowClick={goToHostDetails}
                    />
                </FramedPanel>
            </FullWidthPanel>

            <FullWidthPanel>
                <FramedPanel title="Affected Hosts" subtitle="Hosts ranked by error count, broken down by category">
                    <DataTable
                        columns={TOP_HOSTS_COLS}
                        rows={topHosts.results}
                        loading={topHosts.loading}
                        error={topHosts.error}
                        emptyMessage="No errors found in this time range."
                        onRowClick={goToHostDetails}
                    />
                </FramedPanel>
            </FullWidthPanel>
        </DashboardLayout>
    );
};

export default EnvironmentHealth;
