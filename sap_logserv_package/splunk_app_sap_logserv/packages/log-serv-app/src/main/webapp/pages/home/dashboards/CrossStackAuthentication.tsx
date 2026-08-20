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
import { useCloudProvider, mapCloudProviderQueries } from '../state/CloudProviderProvider';
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

/**
 * Dashboard-perf roadmap tier #6 (KV-Store precompute, session 052 / build 219).
 *
 * The cross-source auth-failure panels raw-scanned 3 sourcetypes (sapstartsrv /
 * hana:audit / XmlWinEventLog); the HANA Users table raw-scanned the full
 * hana:audit Authentication population. The 12 aggregatable panels below now read
 * from the `logserv_xstack_auth_rollup` KV Store collection, populated hourly by
 * [logserv_xstack_auth_aggregate] (one-time [logserv_xstack_auth_backfill]). The
 * 2 Recent-* event-listing tables (windowsEvents, sapAuth) stay RAW — a rollup
 * can't reconstruct a per-event listing.
 *
 * 3 metrics (design adversarially reviewed pre-build; verdict: ship): `fail`
 * grain (layer, failed_user) serves the 4 KPIs + 4 sparks + Failures-by-Layer
 * trend + Top Users — KPIs partition by layer (a clean partition of the
 * ANY_AUTH_FAIL set), topUsers groups by failed_user excluding the "(none)"
 * sentinel (failed_user=coalesce(auth_user,src_user,user) fillnull'd null AND
 * empty so KPIs sum over ALL rows incl "(none)"). `failip` grain (src,
 * sourcetype) + last_seen serves Source IPs — the raw src filter (coalesce +
 * isnotnull + !="" + !="127.0.0.1") is applied in the aggregate (failip is the
 * sole consumer), and layer is derived at READ from sourcetype (decode-at-read)
 * to reproduce values(eval(case())) and dc(sourcetype). `hanauser` grain
 * (src_user, action_type, status, risk_level) + last_seen serves HANA Users over
 * the FULL Authentication population (incl successes — a separate arm, NOT the
 * failure-only fail metric) with the STRICT Failures guard (status!="SUCCESSFUL"
 * AND status!="(none)") so a customer null-status event with a valid src_user is
 * +1 Events / +0 Failures (sticky #16).
 *
 * Read idiom: `| inputlookup <coll> where metric=X | addinfo | where bucket_ts
 * range | <agg>`; addinfo carries the global TimeRange picker. Count KPIs use the
 * empty-safe idiom and timecharts append `| fillnull value=0` (rollup sum(count)
 * null-fills empty bins; raw count 0-fills). ANY_AUTH_FAIL is kept for the
 * Source-IPs row drilldown (a link out to the raw Search app).
 */
const ROLL = 'logserv_xstack_auth_rollup';
const RANGE = '| addinfo | where bucket_ts>=info_min_time AND bucket_ts<info_max_time';
const FAIL = `| inputlookup ${ROLL} where metric="fail" ${RANGE}`;
const FAILIP = `| inputlookup ${ROLL} where metric="failip" ${RANGE}`;
const HANAUSER = `| inputlookup ${ROLL} where metric="hanauser" ${RANGE}`;
const LAYER_DECODE = 'eval layer=case(sourcetype="sap:sapstartsrv","SAP",sourcetype="sap:hana:audit","HANA",sourcetype="XmlWinEventLog","Windows")';

const Q_BASE = {
    // Count KPIs use the empty-safe idiom (`stats count as n, …`): an empty
    // `| inputlookup | stats sum(count)` returns 0 ROWS (not count=0), so the
    // `count as n` anchor forces a row → fillnull → clean 0 (per-layer KPIs can
    // legitimately be empty over a narrow window).
    kpiTotal: `${FAIL} | stats count as n, sum(count) as count | fillnull value=0 count | fields count`,
    kpiSap: `${FAIL} | search layer="SAP" | stats count as n, sum(count) as count | fillnull value=0 count | fields count`,
    kpiHana: `${FAIL} | search layer="HANA" | stats count as n, sum(count) as count | fillnull value=0 count | fields count`,
    kpiWin: `${FAIL} | search layer="Windows" | stats count as n, sum(count) as count | fillnull value=0 count | fields count`,

    sparkTotal: `${FAIL} | eval _time=bucket_ts | timechart span=1d sum(count) as count | fillnull value=0`,
    sparkSap: `${FAIL} | search layer="SAP" | eval _time=bucket_ts | timechart span=1d sum(count) as count | fillnull value=0`,
    sparkHana: `${FAIL} | search layer="HANA" | eval _time=bucket_ts | timechart span=1d sum(count) as count | fillnull value=0`,
    sparkWin: `${FAIL} | search layer="Windows" | eval _time=bucket_ts | timechart span=1d sum(count) as count | fillnull value=0`,

    failuresTrend: `${FAIL} | eval _time=bucket_ts | timechart span=1d sum(count) by layer | fillnull value=0`,
    topUsers: `${FAIL} | search failed_user!="(none)" | stats sum(count) as "Failures" by failed_user | sort -Failures | rename failed_user as "User"`,
    // Source IPs: failip grain (src, sourcetype) + last_seen. Layer derived at
    // read from sourcetype reproduces raw values(eval(case())) (Layers) +
    // dc(sourcetype) (Layers Hit); max(last_seen) = the raw latest(_time).
    sourceIps: `${FAILIP} | ${LAYER_DECODE} | stats sum(count) as "Failures", dc(sourcetype) as "Layers Hit", values(layer) as "Layers", max(last_seen) as last_seen by src | eval "Last Seen"=strftime(last_seen, "%Y-%m-%d %H:%M:%S") | sort -Failures | fields - last_seen | rename src as "Source IP"`,
    // HANA Users: hanauser over the full Authentication population. src_user
    // excludes "(none)" (raw stats-by drops null). Failures uses the STRICT guard
    // so null-status events (status="(none)") count toward Events but NOT Failures
    // — matching raw's eval if(status!="SUCCESSFUL",…) null-is-0 semantics.
    hanaUsers: `${HANAUSER} | search src_user!="(none)" | stats sum(count) as "Events", dc(eval(if(action_type="(none)",null(),action_type))) as "Action Types", sum(eval(if(status!="SUCCESSFUL" AND status!="(none)", count, 0))) as "Failures", values(eval(if(risk_level="(none)",null(),risk_level))) as "Risk Level", max(last_seen) as last_seen by src_user | eval "Last Seen"=strftime(last_seen, "%Y-%m-%d %H:%M:%S") | sort -Failures | fields - last_seen | rename src_user as "User"`,

    windowsEvents: `\`sap_logserv_idx_macro\` sourcetype="XmlWinEventLog" action="failure" | head 200 | eval logon_type_label=case(Logon_Type="2","Interactive",Logon_Type="3","Network",Logon_Type="4","Batch",Logon_Type="5","Service",Logon_Type="7","Unlock",Logon_Type="8","Network Cleartext",Logon_Type="10","Remote Interactive",1=1,Logon_Type) | eval display_user=coalesce(TargetUserName, SubjectUserName, src_user) | eval Time=strftime(_time, "%Y-%m-%d %H:%M:%S") | table Time, display_user, signature, src_ip, logon_type_label, host | sort -Time | rename display_user as "User", src_ip as "Source IP", logon_type_label as "Logon Type"`,
    sapAuth: `\`sap_logserv_idx_macro\` sourcetype="sap:sapstartsrv" is_auth_event="true" auth_result="failure" | head 200 | eval Time=strftime(_time, "%Y-%m-%d %H:%M:%S") | table Time, auth_user, remote_ip, source_location, host | sort -Time | rename auth_user as "User", remote_ip as "Remote IP", source_location as "Source Location"`,
};

/* ---------------------------------------------------------------------------
 * RAW fallbacks for the sub-hour hybrid (session 086). Each is the raw cross-
 * source auth-failure scan its rollup metric precomputes, reconciled to the
 * cached read's exact output columns (byte-verified equal at wide windows — the
 * xa_v_* staged pairs). The hanaUsers raw `if(status!="SUCCESSFUL",1,0)` is
 * null-is-0-equivalent to the cached STRICT guard (status!="(none)"). Only
 * ROLLUP reads are hybridised; windowsEvents/sapAuth are already raw and the
 * sparklines stay cached (cosmetic).
 * ------------------------------------------------------------------------- */
const AAF = `\`sap_logserv_idx_macro\` ${ANY_AUTH_FAIL}`;
const QRAW_BASE = {
    kpiTotal: `${AAF} | stats count`,
    kpiSap: `\`sap_logserv_idx_macro\` sourcetype="sap:sapstartsrv" is_auth_event="true" auth_result="failure" | stats count`,
    kpiHana: `\`sap_logserv_idx_macro\` sourcetype="sap:hana:audit" action_category="Authentication" status!="SUCCESSFUL" | stats count`,
    kpiWin: `\`sap_logserv_idx_macro\` sourcetype="XmlWinEventLog" action="failure" | stats count`,
    failuresTrend: `${AAF} | eval layer=case(sourcetype="sap:sapstartsrv", "SAP", sourcetype="sap:hana:audit", "HANA", sourcetype="XmlWinEventLog", "Windows") | timechart span=1d count by layer | fillnull value=0`,
    topUsers: `${AAF} | eval failed_user=coalesce(auth_user, src_user, user) | where isnotnull(failed_user) AND failed_user!="" | stats count as "Failures" by failed_user | sort -Failures | rename failed_user as "User"`,
    sourceIps: `${AAF} | eval src=coalesce(remote_ip, client_ip, src_ip, IpAddress) | where isnotnull(src) AND src!="" AND src!="127.0.0.1" | stats count as "Failures", dc(sourcetype) as "Layers Hit", values(eval(case(sourcetype="sap:sapstartsrv","SAP",sourcetype="sap:hana:audit","HANA",sourcetype="XmlWinEventLog","Windows"))) as "Layers", latest(_time) as last_seen by src | eval "Last Seen"=strftime(last_seen, "%Y-%m-%d %H:%M:%S") | sort -Failures | fields - last_seen | rename src as "Source IP"`,
    hanaUsers: `\`sap_logserv_idx_macro\` sourcetype="sap:hana:audit" action_category="Authentication" | stats count as "Events", dc(action_type) as "Action Types", sum(eval(if(status!="SUCCESSFUL",1,0))) as "Failures", values(risk_level) as "Risk Level", latest(_time) as last_seen by src_user | eval "Last Seen"=strftime(last_seen, "%Y-%m-%d %H:%M:%S") | sort -Failures | fields - last_seen | rename src_user as "User"`,
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
    const { provider } = useCloudProvider();
    const Q = React.useMemo(() => mapCloudProviderQueries(Q_BASE, provider), [provider]);
    // RAW fallbacks for the sub-hour hybrid (session 086); same cloud mapping so both arms filter identically.
    const QRAW = React.useMemo(() => mapCloudProviderQueries(QRAW_BASE, provider), [provider]);
    const total = useFirstRowFieldHybrid(Q.kpiTotal, QRAW.kpiTotal, 'count');
    const sap = useFirstRowFieldHybrid(Q.kpiSap, QRAW.kpiSap, 'count');
    const hana = useFirstRowFieldHybrid(Q.kpiHana, QRAW.kpiHana, 'count');
    const win = useFirstRowFieldHybrid(Q.kpiWin, QRAW.kpiWin, 'count');

    const topUsers = useHybridSearch({ cached: Q.topUsers, raw: QRAW.topUsers });
    const sourceIps = useHybridSearch({ cached: Q.sourceIps, raw: QRAW.sourceIps });
    const hanaUsers = useHybridSearch({ cached: Q.hanaUsers, raw: QRAW.hanaUsers });
    const winEvents = useSearch({ query: Q.windowsEvents }); // raw listing
    const sapAuth = useSearch({ query: Q.sapAuth }); // raw listing

    // Chart takes a query string → route once (sub-hour -> raw).
    const qFailuresTrend = useRoutedQuery(Q.failuresTrend, QRAW.failuresTrend);

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
                <KpiCard label="Total Auth Failures" value={total.value} loading={total.loading} error={total.error} search={total.search} formatValue={formatInteger} tone={totalTone}
                    sparkline={<SparklineFromQuery query={Q.sparkTotal} valueField="count" color={logservTheme.colors.red} fill />} />
                <KpiCard label="SAP Auth Failures" value={sap.value} loading={sap.loading} error={sap.error} search={sap.search} formatValue={formatInteger} tone={sapTone}
                    sparkline={<SparklineFromQuery query={Q.sparkSap} valueField="count" color={logservTheme.colors.red} fill />} />
                <KpiCard label="HANA Auth Failures" value={hana.value} loading={hana.loading} error={hana.error} search={hana.search} formatValue={formatInteger} tone={hanaTone}
                    sparkline={<SparklineFromQuery query={Q.sparkHana} valueField="count" color={logservTheme.colors.red} fill />} />
                <KpiCard label="Windows Auth Failures" value={win.value} loading={win.loading} error={win.error} search={win.search} formatValue={formatInteger} tone={winTone}
                    sparkline={<SparklineFromQuery query={Q.sparkWin} valueField="count" color={logservTheme.colors.red} fill />} />
            </KpiRow>

            <FullWidthPanel>
                <FramedPanel title="Auth Failures Over Time by Layer" subtitle="Daily count split SAP / HANA / Windows">
                    <TimeSeriesChart query={qFailuresTrend} height={300} palette="auth" />
                </FramedPanel>
            </FullWidthPanel>

            <PanelGrid2>
                <FramedPanel search={topUsers} title="Users by Auth Failures" subtitle="Failing users (cross-stack) ranked by failure count">
                    <DataTable columns={TOP_USER_COLS} rows={topUsers.results} loading={topUsers.loading} error={topUsers.error} emptyMessage="No auth failures in this time range." initialSortKey="Failures" initialSortDir="desc" />
                </FramedPanel>
                <FramedPanel search={sourceIps} title="Auth Failure Source IPs" subtitle="Source IPs ranked by failure count + which layers they hit — click a row for that IP's full cross-stack auth history">
                    <DataTable columns={SOURCE_IP_COLS} rows={sourceIps.results} loading={sourceIps.loading} error={sourceIps.error} emptyMessage="No auth failures with source IP in this time range." initialSortKey="Failures" initialSortDir="desc" onRowClick={goSourceIpRow} />
                </FramedPanel>
            </PanelGrid2>

            <FullWidthPanel>
                <FramedPanel search={hanaUsers} title="HANA Auth Activity by User" subtitle="HANA Authentication category — events / action types / failures / risk — click a row for that user's full HANA auth log">
                    <DataTable columns={HANA_USER_COLS} rows={hanaUsers.results} loading={hanaUsers.loading} error={hanaUsers.error} emptyMessage="No HANA authentication activity in this time range." initialSortKey="Failures" initialSortDir="desc" onRowClick={goHanaUserRow} />
                </FramedPanel>
            </FullWidthPanel>

            <PanelGrid2>
                <FramedPanel search={winEvents} title="Recent Windows Auth Failures" subtitle="Windows action=failure events with logon type, most-recent first — click a row to open Host Details">
                    <DataTable columns={WIN_EVENT_COLS} rows={winEvents.results} loading={winEvents.loading} error={winEvents.error} emptyMessage="No Windows auth failures in this time range." initialSortKey="Time" initialSortDir="desc" onRowClick={goHostRow} />
                </FramedPanel>
                <FramedPanel search={sapAuth} title="Recent SAP Auth Failures" subtitle="sapstartsrv auth failures, most-recent first — click a row to open Host Details">
                    <DataTable columns={SAP_AUTH_COLS} rows={sapAuth.results} loading={sapAuth.loading} error={sapAuth.error} emptyMessage="No SAP auth failures in this time range." initialSortKey="Time" initialSortDir="desc" onRowClick={goHostRow} />
                </FramedPanel>
            </PanelGrid2>
        </DashboardLayout>
    );
};

export default CrossStackAuthentication;
