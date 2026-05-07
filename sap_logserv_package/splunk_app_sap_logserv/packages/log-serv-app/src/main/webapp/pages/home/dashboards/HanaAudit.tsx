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
    splQuote,
} from '../utils/drilldownUrls';
import { logservTheme } from '../styles/logservTheme';

/**
 * HANA Audit — honest port of v0.0.4.2 logserv_hana_audit.xml.
 * 16 panels: 3 KPIs + 5 timeline charts + 1 chart over hour + 7 tables.
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
const ST = 'sourcetype=sap:hana:audit';

const Q = {
    kpiTotal: `\`sap_logserv_idx_macro\` ${ST} | stats count`,
    kpiFailures: `\`sap_logserv_idx_macro\` ${ST} status!="SUCCESSFUL" | stats count`,
    kpiUsers: `\`sap_logserv_idx_macro\` ${ST} | stats dc(executing_user) as users`,

    sparkTotal: `\`sap_logserv_idx_macro\` ${ST} | timechart span=1d count`,
    sparkFailures: `\`sap_logserv_idx_macro\` ${ST} status!="SUCCESSFUL" | timechart span=1d count`,
    sparkUsers: `\`sap_logserv_idx_macro\` ${ST} | timechart span=1d dc(executing_user) as users`,

    userAdminTimeline: `\`sap_logserv_idx_macro\` ${ST} | where match(audit_category, "HEC Audit - User Administration") | eval admin_action = case(match(sql_statement, "(?i)reset connect"), "Password Reset", match(sql_statement, "(?i)activate user"), "User Activation", match(sql_statement, "(?i)deactivate user"), "User Deactivation", match(sql_statement, "(?i)disable password"), "Policy Change", 1=1, "Other Admin") | timechart span=1d count by admin_action`,
    securityEventsTimeline: `\`sap_logserv_idx_macro\` ${ST} | where status!="SUCCESSFUL" OR match(action_type, "(?i)(grant|revoke|create|drop)") | eval event_type = case(status!="SUCCESSFUL", "Failed Operation", match(action_type, "(?i)grant"), "Permission Grant", match(action_type, "(?i)revoke"), "Permission Revoke", match(action_type, "(?i)(create|drop)"), "Object Modification", 1=1, "Other Security Event") | timechart span=1d count by event_type`,
    auditCategoryBreakdown: `\`sap_logserv_idx_macro\` ${ST} | stats count by action_category | sort -count`,
    riskTimeline: `\`sap_logserv_idx_macro\` ${ST} risk_level=* | timechart span=1d count by risk_level`,
    afterHours: `\`sap_logserv_idx_macro\` ${ST} | eval hour=strftime(_time, "%H") | eval result=if(status="SUCCESSFUL", "Successes", "Failures") | chart count over hour by result`,

    healthScore: `\`sap_logserv_idx_macro\` ${ST} | eval day = strftime(_time, "%Y-%m-%d") | stats count as daily_events, dc(executing_user) as active_users, sum(eval(if(status!="SUCCESSFUL", 1, 0))) as daily_failures by day | eval success_rate = round(((daily_events - daily_failures)/daily_events)*100, 1) | sort day | table day, daily_events, active_users, daily_failures, success_rate`,
    passwordMgmt: `\`sap_logserv_idx_macro\` ${ST} | where match(sql_statement, "(?i)password") | eval password_action = case(match(sql_statement, "password \\*\\*\\*"), "Password Change", match(sql_statement, "disable password"), "Disable Lifetime", match(sql_statement, "reset.*connect"), "Reset Attempts", 1=1, "Other") | stats count by password_action, target_user, executing_user, client_ip | sort -count, password_action`,
    failedByHost: `\`sap_logserv_idx_macro\` ${ST} | where status!="SUCCESSFUL" | stats count by host | sort -count`,
    topUsers: `\`sap_logserv_idx_macro\` ${ST} | stats count as Events dc(action_type) as ActionTypes sum(eval(if(status!="SUCCESSFUL",1,0))) as Failures by executing_user | sort -Events`,
    clientIps: `\`sap_logserv_idx_macro\` ${ST} client_ip=* | stats count as Events dc(executing_user) as Users sum(eval(if(status!="SUCCESSFUL",1,0))) as Failures latest(_time) as last_seen by client_ip | eval last_seen=strftime(last_seen, "%Y-%m-%d %H:%M") | sort -Events`,
    highRiskEvents: `\`sap_logserv_idx_macro\` ${ST} is_critical=true | eval Time=strftime(_time, "%Y-%m-%d %H:%M:%S") | sort -_time | table Time, executing_user, action_type, action_category, risk_level, status, host, client_ip, sql_statement`,
    afterHoursAdmin: `\`sap_logserv_idx_macro\` ${ST} is_admin_user=true | eval is_weekend=if(strftime(_time,"%w") IN ("0","6"), 1, 0) | where is_business_hours=false OR is_weekend=1 | eval Time=strftime(_time, "%Y-%m-%d %H:%M:%S") | eval Day=strftime(_time, "%a") | eval Hour=strftime(_time, "%H:%M") | eval Period=case(is_weekend=1 AND is_business_hours=false, "Weekend / After Hours", is_weekend=1, "Weekend", 1=1, "After Hours") | sort -_time | table Time, Day, Period, executing_user, action_type, status, host, client_ip`,
};

interface FirstRow { value: unknown; loading: boolean; error: Error | null; }
const useFirstRowField = (q: string, f: string): FirstRow => {
    const { results, loading, error } = useSearch({ query: q });
    const value = results && results[0] ? (results[0] as Record<string, unknown>)[f] : undefined;
    return { value, loading, error };
};

const HEALTH_COLS: ColumnDef[] = [
    { key: 'day', label: 'Day' },
    { key: 'daily_events', label: 'Events', align: 'right', render: (v) => formatInteger(v) },
    { key: 'active_users', label: 'Active Users', align: 'right', render: (v) => formatInteger(v) },
    { key: 'daily_failures', label: 'Failures', align: 'right', render: (v) => formatInteger(v) },
    { key: 'success_rate', label: 'Success %', align: 'right' },
];
const CATEGORY_COLS: ColumnDef[] = [
    { key: 'action_category', label: 'Category' },
    { key: 'count', label: 'Count', align: 'right', render: (v) => formatInteger(v) },
];
const PASSWORD_COLS: ColumnDef[] = [
    { key: 'password_action', label: 'Action' },
    { key: 'target_user', label: 'Target User' },
    { key: 'executing_user', label: 'Exec User' },
    { key: 'client_ip', label: 'Client IP' },
    { key: 'count', label: 'Count', align: 'right', render: (v) => formatInteger(v) },
];
const HOST_COLS: ColumnDef[] = [
    { key: 'host', label: 'Host' },
    { key: 'count', label: 'Failed Ops', align: 'right', render: (v) => formatInteger(v) },
];
const TOP_USER_COLS: ColumnDef[] = [
    { key: 'executing_user', label: 'User' },
    { key: 'Events', label: 'Events', align: 'right', render: (v) => formatInteger(v) },
    { key: 'ActionTypes', label: 'Action Types', align: 'right', render: (v) => formatInteger(v) },
    { key: 'Failures', label: 'Failures', align: 'right', render: (v) => formatInteger(v) },
];
const CLIENT_IP_COLS: ColumnDef[] = [
    { key: 'client_ip', label: 'Client IP' },
    { key: 'Events', label: 'Events', align: 'right', render: (v) => formatInteger(v) },
    { key: 'Users', label: 'Users', align: 'right', render: (v) => formatInteger(v) },
    { key: 'Failures', label: 'Failures', align: 'right', render: (v) => formatInteger(v) },
    { key: 'last_seen', label: 'Last Seen' },
];
const HIGH_RISK_COLS: ColumnDef[] = [
    { key: 'Time', label: 'Time', width: '160px' },
    { key: 'executing_user', label: 'User', width: '140px' },
    { key: 'action_type', label: 'Action', width: '160px' },
    { key: 'action_category', label: 'Category', width: '140px' },
    { key: 'risk_level', label: 'Risk', width: '90px' },
    { key: 'status', label: 'Status', width: '120px' },
    { key: 'host', label: 'Host', width: '160px' },
    { key: 'client_ip', label: 'Client IP', width: '120px' },
    { key: 'sql_statement', label: 'SQL Statement' },
];
const AFTER_HOURS_COLS: ColumnDef[] = [
    { key: 'Time', label: 'Time', width: '160px' },
    { key: 'Day', label: 'Day', width: '60px' },
    { key: 'Period', label: 'Period', width: '160px' },
    { key: 'executing_user', label: 'User', width: '140px' },
    { key: 'action_type', label: 'Action' },
    { key: 'status', label: 'Status', width: '120px' },
    { key: 'host', label: 'Host', width: '160px' },
    { key: 'client_ip', label: 'Client IP', width: '120px' },
];

const HanaAudit: React.FC = () => {
    const total = useFirstRowField(Q.kpiTotal, 'count');
    const failures = useFirstRowField(Q.kpiFailures, 'count');
    const users = useFirstRowField(Q.kpiUsers, 'users');

    const healthScore = useSearch({ query: Q.healthScore });
    const auditCategory = useSearch({ query: Q.auditCategoryBreakdown });
    const passwordMgmt = useSearch({ query: Q.passwordMgmt });
    const failedByHost = useSearch({ query: Q.failedByHost });
    const topUsers = useSearch({ query: Q.topUsers });
    const clientIps = useSearch({ query: Q.clientIps });
    const highRisk = useSearch({ query: Q.highRiskEvents });
    const afterHoursAdmin = useSearch({ query: Q.afterHoursAdmin });

    const failuresTone = Number(failures.value ?? 0) > 0 ? 'critical' : 'neutral';

    /* Drilldowns (build 159 / session 027 task 6).
     * Patterns:
     *   - Failed Ops by Host row → Host Details with ?host=<row.host>
     *   - Users by Activity row → Cross-Stack Authentication dashboard
     *   - Client IP Analysis row → splunk-search filtered to that client_ip
     *   - High-Risk Events row → splunk-search filtered to user + action
     *   - After-Hours Admin row → splunk-search filtered to user + host
     *   - Password Management row → Cross-Stack Authentication dashboard
     */
    const { timeRange } = useTimeRange();
    const goFailedHost = useCallback((row: Record<string, unknown>) => {
        const host = String(row.host ?? '');
        if (!host) return;
        openInNewTab(buildHostDetailsUrl(host, timeRange.earliest, timeRange.latest));
    }, [timeRange.earliest, timeRange.latest]);
    const goCrossStackAuth = useCallback(() => {
        openInNewTab(buildDashboardUrl('cross-stack-authentication', timeRange.earliest, timeRange.latest));
    }, [timeRange.earliest, timeRange.latest]);
    const goClientIpRow = useCallback((row: Record<string, unknown>) => {
        const ip = String(row.client_ip ?? '');
        if (!ip) return;
        const spl = `\`sap_logserv_idx_macro\` sourcetype=sap:hana:audit client_ip="${splQuote(ip)}" | sort -_time`;
        openInNewTab(buildSplunkSearchUrl(spl, timeRange.earliest, timeRange.latest));
    }, [timeRange.earliest, timeRange.latest]);
    const goHighRiskRow = useCallback((row: Record<string, unknown>) => {
        const user = String(row.executing_user ?? '');
        const action = String(row.action_type ?? '');
        if (!user) return;
        const actionClause = action ? ` action_type="${splQuote(action)}"` : '';
        const spl = `\`sap_logserv_idx_macro\` sourcetype=sap:hana:audit is_critical=true executing_user="${splQuote(user)}"${actionClause} | sort -_time | table _time action_type risk_level status host client_ip sql_statement`;
        openInNewTab(buildSplunkSearchUrl(spl, timeRange.earliest, timeRange.latest));
    }, [timeRange.earliest, timeRange.latest]);
    const goAfterHoursRow = useCallback((row: Record<string, unknown>) => {
        const user = String(row.executing_user ?? '');
        const host = String(row.host ?? '');
        if (!user) return;
        const hostClause = host ? ` host="${splQuote(host)}"` : '';
        const spl = `\`sap_logserv_idx_macro\` sourcetype=sap:hana:audit executing_user="${splQuote(user)}"${hostClause} | sort -_time | table _time action_type status host client_ip`;
        openInNewTab(buildSplunkSearchUrl(spl, timeRange.earliest, timeRange.latest));
    }, [timeRange.earliest, timeRange.latest]);

    return (
        <DashboardLayout
            category="APPLICATIONS"
            title="HANA Audit"
            subtitle="SAP HANA audit log analysis — user activity, failed operations, risk-tiered events, and after-hours access patterns"
        >
            <KpiRow>
                <KpiCard label="Total Audit Events" value={total.value} loading={total.loading} error={total.error} formatValue={formatInteger}
                    sparkline={<SparklineFromQuery query={Q.sparkTotal} valueField="count" fill />} />
                <KpiCard label="Failed Operations" value={failures.value} loading={failures.loading} error={failures.error} formatValue={formatInteger} tone={failuresTone}
                    sparkline={<SparklineFromQuery query={Q.sparkFailures} valueField="count" color={logservTheme.colors.red} fill />} />
                <KpiCard label="Active Users" value={users.value} loading={users.loading} error={users.error} formatValue={formatInteger}
                    sparkline={<SparklineFromQuery query={Q.sparkUsers} valueField="users" fill />} />
            </KpiRow>

            <PanelGrid2>
                <FramedPanel title="User Administration Activity Timeline" subtitle="Password resets, activations, deactivations, policy changes">
                    <TimeSeriesChart query={Q.userAdminTimeline} height={260} palette="auth" />
                </FramedPanel>
                <FramedPanel title="Security Events Timeline" subtitle="Failures + grants/revokes/DDL by event type">
                    <TimeSeriesChart
                        query={Q.securityEventsTimeline}
                        height={260}
                        seriesColorsByField={{
                            'Failed Operation': '#b50101',
                            'Object Modification': '#dc4e41',
                            'Permission Grant': '#f1813f',
                        }}
                    />
                </FramedPanel>
            </PanelGrid2>

            <PanelGrid2>
                <FramedPanel title="Audit Category Breakdown" subtitle="Distribution by action_category">
                    <DataTable columns={CATEGORY_COLS} rows={auditCategory.results} loading={auditCategory.loading} error={auditCategory.error} emptyMessage="No HANA audit events in this time range." />
                </FramedPanel>
                <FramedPanel title="Risk-Tiered Event Timeline" subtitle="Daily volume by risk_level">
                    <TimeSeriesChart query={Q.riskTimeline} height={260} palette="status" />
                </FramedPanel>
            </PanelGrid2>

            <FullWidthPanel>
                <FramedPanel title="Daily Security Health Score" subtitle="Per-day totals, active users, failures, success %">
                    <DataTable columns={HEALTH_COLS} rows={healthScore.results} loading={healthScore.loading} error={healthScore.error} emptyMessage="No HANA audit events in this time range." initialSortKey="day" initialSortDir="desc" />
                </FramedPanel>
            </FullWidthPanel>

            <PanelGrid2>
                <FramedPanel title="Password Management Activities" subtitle="Password changes, lifetime disables, reset-attempts — click a row to open Cross-Stack Authentication">
                    <DataTable columns={PASSWORD_COLS} rows={passwordMgmt.results} loading={passwordMgmt.loading} error={passwordMgmt.error} emptyMessage="No password-management activity in this time range." onRowClick={goCrossStackAuth} />
                </FramedPanel>
                <FramedPanel title="Failed Operations by Host" subtitle="Where failures are concentrated — click a row to open Host Details">
                    <DataTable columns={HOST_COLS} rows={failedByHost.results} loading={failedByHost.loading} error={failedByHost.error} emptyMessage="No failed operations in this time range." onRowClick={goFailedHost} />
                </FramedPanel>
            </PanelGrid2>

            <PanelGrid2>
                <FramedPanel title="Users by Activity" subtitle="Executing users with action variety + failure count, ranked by activity — click a row to open Cross-Stack Authentication">
                    <DataTable columns={TOP_USER_COLS} rows={topUsers.results} loading={topUsers.loading} error={topUsers.error} emptyMessage="No HANA audit events in this time range." onRowClick={goCrossStackAuth} />
                </FramedPanel>
                <FramedPanel title="Client IP Analysis" subtitle="Client IPs with users / failures / freshness, ranked by event count — click a row for the IP's full audit trail">
                    <DataTable columns={CLIENT_IP_COLS} rows={clientIps.results} loading={clientIps.loading} error={clientIps.error} emptyMessage="No HANA audit events in this time range." onRowClick={goClientIpRow} />
                </FramedPanel>
            </PanelGrid2>

            <FullWidthPanel>
                <FramedPanel title="Activity by Hour of Day" subtitle="Successes vs Failures by hour">
                    <TimeSeriesChart
                        query={Q.afterHours}
                        height={240}
                        seriesColorsByField={{ Failures: '#dc4e41', Successes: '#009ceb' }}
                    />
                </FramedPanel>
            </FullWidthPanel>

            <FullWidthPanel>
                <FramedPanel title="High-Risk Events" subtitle="Events flagged is_critical=true, most-recent first — click a row to investigate that user + action pattern">
                    <DataTable columns={HIGH_RISK_COLS} rows={highRisk.results} loading={highRisk.loading} error={highRisk.error} emptyMessage="No high-risk HANA audit events in this time range." onRowClick={goHighRiskRow} />
                </FramedPanel>
            </FullWidthPanel>

            <FullWidthPanel>
                <FramedPanel title="After-Hours / Weekend Admin Activity" subtitle="Admin actions outside business hours, most-recent first — click a row to investigate that user's full audit history">
                    <DataTable columns={AFTER_HOURS_COLS} rows={afterHoursAdmin.results} loading={afterHoursAdmin.loading} error={afterHoursAdmin.error} emptyMessage="No after-hours admin activity in this time range." onRowClick={goAfterHoursRow} />
                </FramedPanel>
            </FullWidthPanel>
        </DashboardLayout>
    );
};

export default HanaAudit;
