import React, { useCallback } from 'react';
import styled from 'styled-components';
import KpiCard, { formatInteger } from '../components/KpiCard';
import FramedPanel from '../components/FramedPanel';
import DataTable, { ColumnDef } from '../components/DataTable';
import TimeSeriesChart from '../components/TimeSeriesChart';
import { SparklineFromQuery } from '../components/Sparkline';
import DashboardLayout from '../components/DashboardLayout';
import { useSearch } from '../hooks/useSearch';
import { useHybridSearch, useRoutedQuery } from '../hooks/useHybridSearch';
import { useCloudProvider, mapCloudProviderQueries } from '../state/CloudProviderProvider';
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

/**
 * Dashboard-perf tier #6 (KV-Store precompute, session 050 cont. / build 211).
 * Reads the `logserv_hana_category_rollup` collection (4 metric sub-types) so
 * the panels stop raw-scanning sap:hana:audit. Read idiom: `| inputlookup …
 * where metric=X | addinfo | where bucket_ts range | <agg>`.
 *
 * CRITICAL null-handling (design-review workflow): status is null on ~2,450 of
 * ~20,947 events; the main grain fillnull's 5 dims to "(none)". STRICT-failure
 * reads use `status!="SUCCESSFUL" status!="(none)"` (=335) to exclude the
 * sentinel; afterHours keeps the LOOSE `if(status="SUCCESSFUL",…,"Failures")`
 * so "(none)" lands in Failures (the strict/loose panels differ by 2,450, both
 * byte-exact). dc() reads null-guard the sentinel via dc(eval(if(X="(none)",
 * null(),X))) for executing_user AND action_type. Group-by reads exclude
 * "(none)" to match the raw `stats by`'s implicit null-drop. highRiskEvents +
 * afterHoursAdmin stay RAW (event listings). afterHours hour / healthScore day
 * derive from bucket_ts (exact on whole-hour-offset TZ).
 */
const ROLL = 'logserv_hana_category_rollup';
const RANGE = '| addinfo | where bucket_ts>=info_min_time AND bucket_ts<info_max_time';
const MAIN = `| inputlookup ${ROLL} where metric="main" ${RANGE}`;
const UA = `| inputlookup ${ROLL} where metric="useradmin" ${RANGE}`;
const SEC = `| inputlookup ${ROLL} where metric="security" ${RANGE}`;
const PW = `| inputlookup ${ROLL} where metric="password" ${RANGE}`;
const FAIL = 'status!="SUCCESSFUL" status!="(none)"';
const DCU = 'dc(eval(if(executing_user="(none)",null(),executing_user)))';

const Q_BASE = {
    kpiTotal: `${MAIN} | stats sum(count) as count`,
    kpiFailures: `${MAIN} | search ${FAIL} | stats sum(count) as count`,
    kpiUsers: `${MAIN} | stats ${DCU} as users`,

    sparkTotal: `${MAIN} | eval _time=bucket_ts | timechart span=1d sum(count) as count | fillnull value=0`,
    sparkFailures: `${MAIN} | search ${FAIL} | eval _time=bucket_ts | timechart span=1d sum(count) as count | fillnull value=0`,
    sparkUsers: `${MAIN} | eval _time=bucket_ts | timechart span=1d ${DCU} as users | fillnull value=0`,

    userAdminTimeline: `${UA} | eval _time=bucket_ts | timechart span=1d sum(count) by admin_action | fillnull value=0`,
    securityEventsTimeline: `${SEC} | eval _time=bucket_ts | timechart span=1d sum(count) by event_type | fillnull value=0`,
    auditCategoryBreakdown: `${MAIN} | stats sum(count) as count by action_category | sort -count`,
    riskTimeline: `${MAIN} | eval _time=bucket_ts | timechart span=1d sum(count) by risk_level | fillnull value=0`,
    afterHours: `${MAIN} | eval hour=strftime(bucket_ts, "%H") | eval result=if(status="SUCCESSFUL", "Successes", "Failures") | chart sum(count) over hour by result | fillnull value=0`,

    healthScore: `${MAIN} | eval day = strftime(bucket_ts, "%Y-%m-%d") | stats sum(count) as daily_events, ${DCU} as active_users, sum(eval(if(status!="SUCCESSFUL" AND status!="(none)", count, 0))) as daily_failures by day | eval success_rate = round(((daily_events - daily_failures)/daily_events)*100, 1) | sort day | table day, daily_events, active_users, daily_failures, success_rate`,
    passwordMgmt: `${PW} | search target_user!="(none)" executing_user!="(none)" client_ip!="(none)" | stats sum(count) as count by password_action, target_user, executing_user, client_ip | sort -count, password_action`,
    failedByHost: `${MAIN} | search ${FAIL} host!="(none)" | stats sum(count) as count by host | sort -count`,
    topUsers: `${MAIN} | search executing_user!="(none)" | stats sum(count) as Events, dc(eval(if(action_type="(none)",null(),action_type))) as ActionTypes, sum(eval(if(status!="SUCCESSFUL" AND status!="(none)",count,0))) as Failures by executing_user | sort -Events`,
    clientIps: `${MAIN} | search client_ip!="(none)" | stats sum(count) as Events, ${DCU} as Users, sum(eval(if(status!="SUCCESSFUL" AND status!="(none)",count,0))) as Failures, max(last_seen) as last_seen by client_ip | eval last_seen=strftime(last_seen, "%Y-%m-%d %H:%M") | sort -Events`,
    // highRiskEvents + afterHoursAdmin stay RAW — per-event listings.
    // afterHoursAdmin derives its window INLINE from _time (canonical: hour < 8
    // OR hour > 18 OR weekend) rather than reading the props.conf
    // is_business_hours field. Session 091: the previous `where
    // is_business_hours=false` never matched — in a `where` clause a bare
    // `false` parses as a FIELD reference, not a boolean, so the filter
    // degenerated to `is_weekend=1` and the panel showed weekend-only,
    // omitting every weekday after-hours event (the security-relevant slice)
    // and mislabelling every row "Weekend". Inline _time arithmetic cannot
    // fail silently in either direction. LOCKSTEP LIST — the canonical window
    // (hour < 8 OR hour > 18 OR weekend) is embedded in four places and
    // nothing automated asserts they agree, so change all four together:
    //   1. this query
    //   2. ChangeConfig.tsx ENRICH
    //   3. savedsearches.conf [logserv_compliance_aggregate]
    //   4. savedsearches.conf [logserv_compliance_backfill]
    // props.conf [sap:hana:audit] carries the same window for ad-hoc search
    // and documents the two deliberate exceptions (the ES correlation
    // searches and logserv_hana_after_hours_admin use their own windows).
    // Missing #4 is the dangerous one: the backfill repopulates 30 days of
    // historical rollup rows, so a stale copy silently overwrites corrected
    // history and only shows up as a wide-window vs sub-hour disagreement.
    highRiskEvents: `\`sap_logserv_idx_macro\` ${ST} is_critical=true | head 500 | eval Time=strftime(_time, "%Y-%m-%d %H:%M:%S") | sort -_time | table Time, executing_user, action_type, action_category, risk_level, status, host, client_ip, sql_statement`,
    afterHoursAdmin: `\`sap_logserv_idx_macro\` ${ST} is_admin_user=true | eval is_weekend=if(strftime(_time,"%w") IN ("0","6"), 1, 0) | eval is_after_hours=if(tonumber(strftime(_time,"%H")) < 8 OR tonumber(strftime(_time,"%H")) > 18, 1, 0) | where is_after_hours=1 OR is_weekend=1 | head 500 | eval Time=strftime(_time, "%Y-%m-%d %H:%M:%S") | eval Day=strftime(_time, "%a") | eval Hour=strftime(_time, "%H:%M") | eval Period=case(is_weekend=1 AND is_after_hours=1, "Weekend / After Hours", is_weekend=1, "Weekend", 1=1, "After Hours") | sort -_time | table Time, Day, Period, executing_user, action_type, status, host, client_ip`,
};

/* ---------------------------------------------------------------------------
 * RAW fallbacks for the sub-hour hybrid (session 086). Each is the raw
 * sap:hana:audit scan its rollup metric precomputes (reconstructed from
 * [logserv_hana_aggregate]; action_category + risk_level are always present on
 * this sourcetype, so the main-metric scope == the raw scope). The strict-
 * failure guard `status!="SUCCESSFUL"` already excludes null status on raw
 * (null-comparison is false), matching the cached `status!="(none)"` sentinel
 * exclusion; afterHours keeps the LOOSE `if(status="SUCCESSFUL",…)` (null →
 * Failures on both arms). UA/SEC/PW classifications + the `password \*\*\*`
 * regex are reused verbatim. highRiskEvents/afterHoursAdmin stay raw; sparklines
 * cached. hour/day derive from _time (== hour-aligned bucket_ts on whole-hour TZ).
 * ------------------------------------------------------------------------- */
const RAW_HANA = '`sap_logserv_idx_macro` sourcetype=sap:hana:audit';
const UA_CLASS = 'eval admin_action=case(match(sql_statement,"(?i)reset connect"),"Password Reset", match(sql_statement,"(?i)activate user"),"User Activation", match(sql_statement,"(?i)deactivate user"),"User Deactivation", match(sql_statement,"(?i)disable password"),"Policy Change", 1=1,"Other Admin")';
const SEC_CLASS = 'eval event_type=case(status!="SUCCESSFUL","Failed Operation", match(action_type,"(?i)grant"),"Permission Grant", match(action_type,"(?i)revoke"),"Permission Revoke", match(action_type,"(?i)(create|drop)"),"Object Modification", 1=1,"Other Security Event")';
const PW_CLASS = 'eval password_action=case(match(sql_statement,"password \\*\\*\\*"),"Password Change", match(sql_statement,"disable password"),"Disable Lifetime", match(sql_statement,"reset.*connect"),"Reset Attempts", 1=1,"Other")';
const QRAW_BASE = {
    kpiTotal: `${RAW_HANA} | stats count`,
    kpiFailures: `${RAW_HANA} status!="SUCCESSFUL" | stats count`,
    kpiUsers: `${RAW_HANA} | stats dc(executing_user) as users`,
    userAdminTimeline: `${RAW_HANA} | where match(audit_category,"HEC Audit - User Administration") | ${UA_CLASS} | timechart span=1d count by admin_action | fillnull value=0`,
    securityEventsTimeline: `${RAW_HANA} | where status!="SUCCESSFUL" OR match(action_type,"(?i)(grant|revoke|create|drop)") | ${SEC_CLASS} | timechart span=1d count by event_type | fillnull value=0`,
    auditCategoryBreakdown: `${RAW_HANA} | stats count by action_category | sort -count`,
    riskTimeline: `${RAW_HANA} | timechart span=1d count by risk_level | fillnull value=0`,
    afterHours: `${RAW_HANA} | eval hour=strftime(_time, "%H") | eval result=if(status="SUCCESSFUL", "Successes", "Failures") | chart count over hour by result | fillnull value=0`,
    healthScore: `${RAW_HANA} | eval day = strftime(_time, "%Y-%m-%d") | stats count as daily_events, dc(executing_user) as active_users, sum(eval(if(status!="SUCCESSFUL", 1, 0))) as daily_failures by day | eval success_rate = round(((daily_events - daily_failures)/daily_events)*100, 1) | sort day | table day, daily_events, active_users, daily_failures, success_rate`,
    passwordMgmt: `${RAW_HANA} | where match(sql_statement,"(?i)password") | ${PW_CLASS} | stats count by password_action, target_user, executing_user, client_ip | sort -count, password_action`,
    failedByHost: `${RAW_HANA} status!="SUCCESSFUL" host=* | stats count by host | sort -count`,
    topUsers: `${RAW_HANA} executing_user=* | stats count as Events, dc(action_type) as ActionTypes, sum(eval(if(status!="SUCCESSFUL",1,0))) as Failures by executing_user | sort -Events`,
    clientIps: `${RAW_HANA} client_ip=* | stats count as Events, dc(executing_user) as Users, sum(eval(if(status!="SUCCESSFUL",1,0))) as Failures, max(_time) as last_seen by client_ip | eval last_seen=strftime(last_seen, "%Y-%m-%d %H:%M") | sort -Events`,
};

interface FirstRow {
    value: unknown;
    loading: boolean;
    error: Error | null;
    /** Session 093 — the whole search result, so the KpiCard this feeds
     *  can explain a missing value (see KpiCard’s `search` prop). */
    search: import('../hooks/useSearch').UseSearchResult;
}
const useFirstRowField = (q: string, f: string): FirstRow => {
    const search = useSearch({ query: q });
    const { results, loading, error } = search;
    const value = results && results[0] ? (results[0] as Record<string, unknown>)[f] : undefined;
    return { value, loading, error, search };
};
/** useFirstRowField over a hybrid cached/raw pair (session 086). */
const useFirstRowFieldHybrid = (cached: string, raw: string, f: string): FirstRow => {
    const search = useHybridSearch({ cached, raw });
    const { results, loading, error } = search;
    const value = results && results[0] ? (results[0] as Record<string, unknown>)[f] : undefined;
    return { value, loading, error, search };
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
    const { provider } = useCloudProvider();
    const Q = React.useMemo(() => mapCloudProviderQueries(Q_BASE, provider), [provider]);
    // RAW fallbacks for the sub-hour hybrid (session 086); same cloud mapping so both arms filter identically.
    const QRAW = React.useMemo(() => mapCloudProviderQueries(QRAW_BASE, provider), [provider]);
    const total = useFirstRowFieldHybrid(Q.kpiTotal, QRAW.kpiTotal, 'count');
    const failures = useFirstRowFieldHybrid(Q.kpiFailures, QRAW.kpiFailures, 'count');
    const users = useFirstRowFieldHybrid(Q.kpiUsers, QRAW.kpiUsers, 'users');

    const healthScore = useHybridSearch({ cached: Q.healthScore, raw: QRAW.healthScore });
    const auditCategory = useHybridSearch({ cached: Q.auditCategoryBreakdown, raw: QRAW.auditCategoryBreakdown });
    const passwordMgmt = useHybridSearch({ cached: Q.passwordMgmt, raw: QRAW.passwordMgmt });
    const failedByHost = useHybridSearch({ cached: Q.failedByHost, raw: QRAW.failedByHost });
    const topUsers = useHybridSearch({ cached: Q.topUsers, raw: QRAW.topUsers });
    const clientIps = useHybridSearch({ cached: Q.clientIps, raw: QRAW.clientIps });
    const highRisk = useSearch({ query: Q.highRiskEvents }); // raw listing
    const afterHoursAdmin = useSearch({ query: Q.afterHoursAdmin }); // raw listing

    // Charts take a query string → route once each (sub-hour -> raw).
    const qUserAdminTimeline = useRoutedQuery(Q.userAdminTimeline, QRAW.userAdminTimeline);
    const qSecurityEventsTimeline = useRoutedQuery(Q.securityEventsTimeline, QRAW.securityEventsTimeline);
    const qRiskTimeline = useRoutedQuery(Q.riskTimeline, QRAW.riskTimeline);
    const qAfterHours = useRoutedQuery(Q.afterHours, QRAW.afterHours);

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
                <KpiCard label="Total Audit Events" value={total.value} loading={total.loading} error={total.error} search={total.search} formatValue={formatInteger}
                    sparkline={<SparklineFromQuery query={Q.sparkTotal} valueField="count" fill />} />
                <KpiCard label="Failed Operations" value={failures.value} loading={failures.loading} error={failures.error} search={failures.search} formatValue={formatInteger} tone={failuresTone}
                    sparkline={<SparklineFromQuery query={Q.sparkFailures} valueField="count" color={logservTheme.colors.red} fill />} />
                <KpiCard label="Active Users" value={users.value} loading={users.loading} error={users.error} search={users.search} formatValue={formatInteger}
                    sparkline={<SparklineFromQuery query={Q.sparkUsers} valueField="users" fill />} />
            </KpiRow>

            <PanelGrid2>
                <FramedPanel title="User Administration Activity Timeline" subtitle="Password resets, activations, deactivations, policy changes">
                    <TimeSeriesChart query={qUserAdminTimeline} height={260} palette="auth" />
                </FramedPanel>
                <FramedPanel title="Security Events Timeline" subtitle="Failures + grants/revokes/DDL by event type">
                    <TimeSeriesChart
                        query={qSecurityEventsTimeline}
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
                <FramedPanel search={auditCategory} title="Audit Category Breakdown" subtitle="Distribution by action_category">
                    <DataTable columns={CATEGORY_COLS} rows={auditCategory.results} loading={auditCategory.loading} error={auditCategory.error} emptyMessage="No HANA audit events in this time range." />
                </FramedPanel>
                <FramedPanel title="Risk-Tiered Event Timeline" subtitle="Daily volume by risk_level">
                    <TimeSeriesChart query={qRiskTimeline} height={260} palette="status" />
                </FramedPanel>
            </PanelGrid2>

            <FullWidthPanel>
                <FramedPanel search={healthScore} title="Daily Security Health Score" subtitle="Per-day totals, active users, failures, success %">
                    <DataTable columns={HEALTH_COLS} rows={healthScore.results} loading={healthScore.loading} error={healthScore.error} emptyMessage="No HANA audit events in this time range." initialSortKey="day" initialSortDir="desc" />
                </FramedPanel>
            </FullWidthPanel>

            <PanelGrid2>
                <FramedPanel search={passwordMgmt} title="Password Management Activities" subtitle="Password changes, lifetime disables, reset-attempts — click a row to open Cross-Stack Authentication">
                    <DataTable columns={PASSWORD_COLS} rows={passwordMgmt.results} loading={passwordMgmt.loading} error={passwordMgmt.error} emptyMessage="No password-management activity in this time range." onRowClick={goCrossStackAuth} />
                </FramedPanel>
                <FramedPanel search={failedByHost} title="Failed Operations by Host" subtitle="Where failures are concentrated — click a row to open Host Details">
                    <DataTable columns={HOST_COLS} rows={failedByHost.results} loading={failedByHost.loading} error={failedByHost.error} emptyMessage="No failed operations in this time range." onRowClick={goFailedHost} />
                </FramedPanel>
            </PanelGrid2>

            <PanelGrid2>
                <FramedPanel search={topUsers} title="Users by Activity" subtitle="Executing users with action variety + failure count, ranked by activity — click a row to open Cross-Stack Authentication">
                    <DataTable columns={TOP_USER_COLS} rows={topUsers.results} loading={topUsers.loading} error={topUsers.error} emptyMessage="No HANA audit events in this time range." onRowClick={goCrossStackAuth} />
                </FramedPanel>
                <FramedPanel search={clientIps} title="Client IP Analysis" subtitle="Client IPs with users / failures / freshness, ranked by event count — click a row for the IP's full audit trail">
                    <DataTable columns={CLIENT_IP_COLS} rows={clientIps.results} loading={clientIps.loading} error={clientIps.error} emptyMessage="No HANA audit events in this time range." onRowClick={goClientIpRow} />
                </FramedPanel>
            </PanelGrid2>

            <FullWidthPanel>
                <FramedPanel title="Activity by Hour of Day" subtitle="Successes vs Failures by hour">
                    <TimeSeriesChart
                        query={qAfterHours}
                        height={240}
                        seriesColorsByField={{ Failures: '#dc4e41', Successes: '#009ceb' }}
                    />
                </FramedPanel>
            </FullWidthPanel>

            <FullWidthPanel>
                <FramedPanel search={highRisk} title="High-Risk Events" subtitle="Events flagged is_critical=true, most-recent first — click a row to investigate that user + action pattern">
                    <DataTable columns={HIGH_RISK_COLS} rows={highRisk.results} loading={highRisk.loading} error={highRisk.error} emptyMessage="No high-risk HANA audit events in this time range." onRowClick={goHighRiskRow} />
                </FramedPanel>
            </FullWidthPanel>

            <FullWidthPanel>
                <FramedPanel search={afterHoursAdmin} title="After-Hours / Weekend Admin Activity" subtitle="Admin actions outside business hours, most-recent first — click a row to investigate that user's full audit history">
                    <DataTable columns={AFTER_HOURS_COLS} rows={afterHoursAdmin.results} loading={afterHoursAdmin.loading} error={afterHoursAdmin.error} emptyMessage="No after-hours admin activity in this time range." onRowClick={goAfterHoursRow} />
                </FramedPanel>
            </FullWidthPanel>
        </DashboardLayout>
    );
};

export default HanaAudit;
