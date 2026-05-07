import React from 'react';
import styled from 'styled-components';
import KpiCard, { formatInteger } from '../components/KpiCard';
import FramedPanel from '../components/FramedPanel';
import DataTable, { ColumnDef } from '../components/DataTable';
import TimeSeriesChart from '../components/TimeSeriesChart';
import { SparklineFromQuery } from '../components/Sparkline';
import DashboardLayout from '../components/DashboardLayout';
import { useSearch } from '../hooks/useSearch';
import { useTimeRange } from '../state/TimeRangeProvider';
import { buildHostDetailsUrl, buildSplunkSearchUrl, openInNewTab, splQuote } from '../utils/drilldownUrls';
import { logservTheme } from '../styles/logservTheme';

/**
 * Cross-Stack Authentication — honest port of v0.0.4.2 logserv_cross_stack_authentication.xml.
 *
 * 4 KPIs (Total / SAP / HANA / Windows) + Auth Failures Over Time by Layer column +
 * Top Users by Failures table + Auth Failure Source IPs table + HANA Auth Activity by User table +
 * Recent Windows Auth Failures table + Recent SAP Auth Failures table.
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

const ANY_AUTH_FAIL = '((sourcetype="sap:sapstartsrv" is_auth_event="true" auth_result="failure") OR (sourcetype="sap:hana:audit" action_category="Authentication" status!="SUCCESSFUL") OR (sourcetype="XmlWinEventLog" action="failure"))';

const Q = {
    kpiTotal: `\`sap_logserv_idx_macro\` ${ANY_AUTH_FAIL} | stats count`,
    kpiSap: `\`sap_logserv_idx_macro\` sourcetype="sap:sapstartsrv" is_auth_event="true" auth_result="failure" | stats count`,
    kpiHana: `\`sap_logserv_idx_macro\` sourcetype="sap:hana:audit" action_category="Authentication" status!="SUCCESSFUL" | stats count`,
    kpiWin: `\`sap_logserv_idx_macro\` sourcetype="XmlWinEventLog" action="failure" | stats count`,

    sparkTotal: `\`sap_logserv_idx_macro\` ${ANY_AUTH_FAIL} | timechart span=1d count`,
    sparkSap: `\`sap_logserv_idx_macro\` sourcetype="sap:sapstartsrv" is_auth_event="true" auth_result="failure" | timechart span=1d count`,
    sparkHana: `\`sap_logserv_idx_macro\` sourcetype="sap:hana:audit" action_category="Authentication" status!="SUCCESSFUL" | timechart span=1d count`,
    sparkWin: `\`sap_logserv_idx_macro\` sourcetype="XmlWinEventLog" action="failure" | timechart span=1d count`,

    failuresTrend: `\`sap_logserv_idx_macro\` ${ANY_AUTH_FAIL} | eval layer=case(sourcetype="sap:sapstartsrv", "SAP", sourcetype="sap:hana:audit", "HANA", sourcetype="XmlWinEventLog", "Windows") | timechart span=1d count by layer`,
    topUsers: `\`sap_logserv_idx_macro\` ${ANY_AUTH_FAIL} | eval failed_user=coalesce(auth_user, src_user, user) | where isnotnull(failed_user) AND failed_user!="" | stats count as "Failures" by failed_user | sort -Failures | rename failed_user as "User"`,
    sourceIps: `\`sap_logserv_idx_macro\` ${ANY_AUTH_FAIL} | eval src=coalesce(remote_ip, client_ip, src_ip, IpAddress) | where isnotnull(src) AND src!="" AND src!="127.0.0.1" | stats count as "Failures", dc(sourcetype) as "Layers Hit", values(eval(case(sourcetype="sap:sapstartsrv","SAP",sourcetype="sap:hana:audit","HANA",sourcetype="XmlWinEventLog","Windows"))) as "Layers", latest(_time) as last_seen by src | eval "Last Seen"=strftime(last_seen, "%Y-%m-%d %H:%M:%S") | sort -Failures | fields - last_seen | rename src as "Source IP"`,
    hanaUsers: `\`sap_logserv_idx_macro\` sourcetype="sap:hana:audit" action_category="Authentication" | stats count as "Events", dc(action_type) as "Action Types", sum(eval(if(status!="SUCCESSFUL",1,0))) as "Failures", values(risk_level) as "Risk Level", latest(_time) as last_seen by src_user | eval "Last Seen"=strftime(last_seen, "%Y-%m-%d %H:%M:%S") | sort -Failures | fields - last_seen | rename src_user as "User"`,
    windowsEvents: `\`sap_logserv_idx_macro\` sourcetype="XmlWinEventLog" action="failure" | eval logon_type_label=case(Logon_Type="2","Interactive",Logon_Type="3","Network",Logon_Type="4","Batch",Logon_Type="5","Service",Logon_Type="7","Unlock",Logon_Type="8","Network Cleartext",Logon_Type="10","Remote Interactive",1=1,Logon_Type) | eval display_user=coalesce(TargetUserName, SubjectUserName, src_user) | eval Time=strftime(_time, "%Y-%m-%d %H:%M:%S") | table Time, display_user, signature, src_ip, logon_type_label, host | sort -Time | rename display_user as "User", src_ip as "Source IP", logon_type_label as "Logon Type"`,
    sapAuth: `\`sap_logserv_idx_macro\` sourcetype="sap:sapstartsrv" is_auth_event="true" auth_result="failure" | eval Time=strftime(_time, "%Y-%m-%d %H:%M:%S") | table Time, auth_user, remote_ip, source_location, host | sort -Time | rename auth_user as "User", remote_ip as "Remote IP", source_location as "Source Location"`,
};

interface FirstRow { value: unknown; loading: boolean; error: Error | null; }
const useFirstRowField = (q: string, f: string): FirstRow => {
    const { results, loading, error } = useSearch({ query: q });
    const value = results && results[0] ? (results[0] as Record<string, unknown>)[f] : undefined;
    return { value, loading, error };
};

const TOP_USER_COLS: ColumnDef[] = [
    { key: 'User', label: 'User' },
    { key: 'Failures', label: 'Failures', align: 'right', render: (v) => formatInteger(v) },
];
const SOURCE_IP_COLS: ColumnDef[] = [
    { key: 'Source IP', label: 'Source IP' },
    { key: 'Failures', label: 'Failures', align: 'right', render: (v) => formatInteger(v) },
    { key: 'Layers Hit', label: 'Layers Hit', align: 'right', render: (v) => formatInteger(v) },
    { key: 'Layers', label: 'Layers' },
    { key: 'Last Seen', label: 'Last Seen' },
];
const HANA_USER_COLS: ColumnDef[] = [
    { key: 'User', label: 'User' },
    { key: 'Events', label: 'Events', align: 'right', render: (v) => formatInteger(v) },
    { key: 'Action Types', label: 'Action Types', align: 'right', render: (v) => formatInteger(v) },
    { key: 'Failures', label: 'Failures', align: 'right', render: (v) => formatInteger(v) },
    { key: 'Risk Level', label: 'Risk Level' },
    { key: 'Last Seen', label: 'Last Seen' },
];
const WIN_EVENT_COLS: ColumnDef[] = [
    { key: 'Time', label: 'Time', width: '160px' },
    { key: 'User', label: 'User' },
    { key: 'signature', label: 'Signature' },
    { key: 'Source IP', label: 'Source IP', width: '140px' },
    { key: 'Logon Type', label: 'Logon Type', width: '140px' },
    { key: 'host', label: 'Host', width: '160px' },
];
const SAP_AUTH_COLS: ColumnDef[] = [
    { key: 'Time', label: 'Time', width: '160px' },
    { key: 'User', label: 'User' },
    { key: 'Remote IP', label: 'Remote IP', width: '140px' },
    { key: 'Source Location', label: 'Source Location' },
    { key: 'host', label: 'Host', width: '160px' },
];

const CrossStackAuthentication: React.FC = () => {
    const total = useFirstRowField(Q.kpiTotal, 'count');
    const sap = useFirstRowField(Q.kpiSap, 'count');
    const hana = useFirstRowField(Q.kpiHana, 'count');
    const win = useFirstRowField(Q.kpiWin, 'count');

    const topUsers = useSearch({ query: Q.topUsers });
    const sourceIps = useSearch({ query: Q.sourceIps });
    const hanaUsers = useSearch({ query: Q.hanaUsers });
    const winEvents = useSearch({ query: Q.windowsEvents });
    const sapAuth = useSearch({ query: Q.sapAuth });

    const totalTone = Number(total.value ?? 0) > 0 ? 'critical' : 'neutral';
    const sapTone = Number(sap.value ?? 0) > 0 ? 'critical' : 'neutral';
    const hanaTone = Number(hana.value ?? 0) > 0 ? 'critical' : 'neutral';
    const winTone = Number(win.value ?? 0) > 0 ? 'critical' : 'neutral';

    /* Drilldowns (build 159 / session 027 task 6).
     * - Source IPs row → splunk-search filtered to that IP across all 3 layers.
     * - HANA Users row → splunk-search filtered to that HANA user.
     * - Recent Windows / SAP rows → host-details with ?host=<row.host>. */
    const { timeRange } = useTimeRange();
    const goSourceIpRow = (row: Record<string, unknown>): void => {
        const ip = String(row['Source IP'] ?? '');
        if (!ip) return;
        const spl = `\`sap_logserv_idx_macro\` ${ANY_AUTH_FAIL} | eval src=coalesce(remote_ip,client_ip,src_ip,IpAddress) | where src="${splQuote(ip)}" | sort -_time`;
        openInNewTab(buildSplunkSearchUrl(spl, timeRange.earliest, timeRange.latest));
    };
    const goHanaUserRow = (row: Record<string, unknown>): void => {
        const user = String(row.User ?? '');
        if (!user) return;
        const spl = `\`sap_logserv_idx_macro\` sourcetype="sap:hana:audit" action_category="Authentication" src_user="${splQuote(user)}" | sort -_time`;
        openInNewTab(buildSplunkSearchUrl(spl, timeRange.earliest, timeRange.latest));
    };
    const goHostRow = (row: Record<string, unknown>): void => {
        const host = String(row.host ?? '');
        if (!host) return;
        openInNewTab(buildHostDetailsUrl(host, timeRange.earliest, timeRange.latest));
    };

    return (
        <DashboardLayout
            category="SECURITY"
            title="Cross-Stack Authentication"
            subtitle="Unified authentication failure analysis across SAP, HANA, and Windows layers"
        >
            <KpiRow>
                <KpiCard label="Total Auth Failures" value={total.value} loading={total.loading} error={total.error} formatValue={formatInteger} tone={totalTone}
                    sparkline={<SparklineFromQuery query={Q.sparkTotal} valueField="count" color={logservTheme.colors.red} fill />} />
                <KpiCard label="SAP Auth Failures" value={sap.value} loading={sap.loading} error={sap.error} formatValue={formatInteger} tone={sapTone}
                    sparkline={<SparklineFromQuery query={Q.sparkSap} valueField="count" color={logservTheme.colors.red} fill />} />
                <KpiCard label="HANA Auth Failures" value={hana.value} loading={hana.loading} error={hana.error} formatValue={formatInteger} tone={hanaTone}
                    sparkline={<SparklineFromQuery query={Q.sparkHana} valueField="count" color={logservTheme.colors.red} fill />} />
                <KpiCard label="Windows Auth Failures" value={win.value} loading={win.loading} error={win.error} formatValue={formatInteger} tone={winTone}
                    sparkline={<SparklineFromQuery query={Q.sparkWin} valueField="count" color={logservTheme.colors.red} fill />} />
            </KpiRow>

            <FullWidthPanel>
                <FramedPanel title="Auth Failures Over Time by Layer" subtitle="Daily count split SAP / HANA / Windows">
                    <TimeSeriesChart query={Q.failuresTrend} height={300} palette="auth" />
                </FramedPanel>
            </FullWidthPanel>

            <PanelGrid2>
                <FramedPanel title="Users by Auth Failures" subtitle="Failing users (cross-stack) ranked by failure count">
                    <DataTable columns={TOP_USER_COLS} rows={topUsers.results} loading={topUsers.loading} error={topUsers.error} emptyMessage="No auth failures in this time range." initialSortKey="Failures" initialSortDir="desc" />
                </FramedPanel>
                <FramedPanel title="Auth Failure Source IPs" subtitle="Source IPs ranked by failure count + which layers they hit — click a row for that IP's full cross-stack auth history">
                    <DataTable columns={SOURCE_IP_COLS} rows={sourceIps.results} loading={sourceIps.loading} error={sourceIps.error} emptyMessage="No auth failures with source IP in this time range." initialSortKey="Failures" initialSortDir="desc" onRowClick={goSourceIpRow} />
                </FramedPanel>
            </PanelGrid2>

            <FullWidthPanel>
                <FramedPanel title="HANA Auth Activity by User" subtitle="HANA Authentication category — events / action types / failures / risk — click a row for that user's full HANA auth log">
                    <DataTable columns={HANA_USER_COLS} rows={hanaUsers.results} loading={hanaUsers.loading} error={hanaUsers.error} emptyMessage="No HANA authentication activity in this time range." initialSortKey="Failures" initialSortDir="desc" onRowClick={goHanaUserRow} />
                </FramedPanel>
            </FullWidthPanel>

            <PanelGrid2>
                <FramedPanel title="Recent Windows Auth Failures" subtitle="Windows action=failure events with logon type, most-recent first — click a row to open Host Details">
                    <DataTable columns={WIN_EVENT_COLS} rows={winEvents.results} loading={winEvents.loading} error={winEvents.error} emptyMessage="No Windows auth failures in this time range." initialSortKey="Time" initialSortDir="desc" onRowClick={goHostRow} />
                </FramedPanel>
                <FramedPanel title="Recent SAP Auth Failures" subtitle="sapstartsrv auth failures, most-recent first — click a row to open Host Details">
                    <DataTable columns={SAP_AUTH_COLS} rows={sapAuth.results} loading={sapAuth.loading} error={sapAuth.error} emptyMessage="No SAP auth failures in this time range." initialSortKey="Time" initialSortDir="desc" onRowClick={goHostRow} />
                </FramedPanel>
            </PanelGrid2>
        </DashboardLayout>
    );
};

export default CrossStackAuthentication;
