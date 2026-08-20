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
import { useHybridSearch, useRoutedQuery } from '../hooks/useHybridSearch';
import { useCloudProvider, mapCloudProviderQueries } from '../state/CloudProviderProvider';
import { useTimeRange } from '../state/TimeRangeProvider';
import { buildSplunkSearchUrl, openInNewTab, splQuote } from '../utils/drilldownUrls';
import { logservTheme } from '../styles/logservTheme';

/**
 * Change & Configuration Activity — honest port of v0.0.4.2 logserv_change_config.xml.
 *
 * 6 KPIs (Total / User Changes / Permission Grants / Password / After-Hours / Operators) +
 * Activity Over Time by source column + Category pie + Top Operators bar +
 * HANA Audit Change Events + Windows Account/Group Mods + Linux Sudo & Commands +
 * Recent Privileged Changes + Recent After-Hours Changes.
 *
 * The change-event filter is a 3-source synthesis (HANA / Windows / Linux). The base
 * filter and the operator/category enrichment are verbatim from v0.0.4.2 — extracted
 * to constants for readability. The after-hours decoration was rewritten in session
 * 091 (see the ENRICH comment): one inline `_time` window for every source, 08:00–18:59
 * business hours, replacing a per-sourcetype case() that read dead props.conf fields.
 */

const KpiRow = styled.div`
    display: grid;
    grid-template-columns: repeat(6, minmax(0, 1fr));
    gap: ${logservTheme.elevation.panelGap};
    margin-bottom: ${logservTheme.elevation.panelGap};
    @media (max-width: 1500px) { grid-template-columns: repeat(3, minmax(0, 1fr)); }
    @media (max-width: 900px) { grid-template-columns: 1fr; }
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

// All change events across HANA / Windows / Linux. Path B (build 145):
// the Linux clauses now include linux:cron / linux:warn / linux:sudolog /
// linux:slapd alongside the legacy `syslog` sourcetype. The new sourcetypes
// receive new events post-migration; `syslog` stays in the OR clause so
// historical data ingested before the migration remains visible.
const CHANGE_FILTER = `( (sourcetype="sap:hana:audit" (action_category IN ("User Management","User Creation","User Deletion","Permission Grant","Permission Revoke","Password Management","Account Status Change","Password Reset") OR action_type IN ("CREATE TABLE","ALTER TABLE","DROP TABLE","CREATE VIEW","ALTER VIEW","DROP VIEW","CREATE SCHEMA","ALTER SCHEMA","DROP SCHEMA","CREATE FUNCTION","ALTER FUNCTION","DROP FUNCTION","CREATE PROCEDURE","ALTER PROCEDURE","DROP PROCEDURE","AUDIT POLICY","CREATE AUDIT POLICY","ALTER AUDIT POLICY","DROP AUDIT POLICY"))) OR (sourcetype="XmlWinEventLog" EventCode IN (4720,4722,4724,4725,4726,4738,4740,4767,4781,4728,4729,4732,4733,4756,4757)) OR ((sourcetype="linux_messages_syslog" OR sourcetype="linux_secure" OR sourcetype="linux:cron" OR sourcetype="linux:warn" OR sourcetype="linux:sudolog" OR sourcetype="linux:slapd" OR sourcetype="syslog") ("COMMAND=" OR useradd OR usermod OR userdel OR groupadd OR groupmod OR groupdel OR passwd)) )`;

// Source-prefixed operator + category + after-hours derivation.
// The operator/category classification is verbatim from v0.0.4.2. The
// after-hours decoration is NOT: session 091 replaced a per-sourcetype
// case() — which routed sap:hana:audit to the props.conf is_business_hours /
// is_weekend fields — with the single inline `_time` expression below.
// Those props fields were pinned to the dead constant "false" by an
// EVAL -> EVAL chain, so the quoted comparison matched EVERY HANA event and
// the KPI reported 50,000 of 50,000 as after-hours. Both branches are now
// identical by construction, so the case() is gone. Canonical window:
// after-hours = hour < 8 OR hour > 18 OR weekend (08:00-18:59 = business).
// Keep in lockstep with props.conf [sap:hana:audit], HanaAudit's
// afterHoursAdmin, and the [logserv_compliance_aggregate] / _backfill arms
// in savedsearches.conf — those two confs embed this exact expression.
const ENRICH = `eval change_source = case(sourcetype="sap:hana:audit", "HANA", sourcetype="XmlWinEventLog", "Windows", 1=1, "Linux") | rex field=_raw "sudo:\\s+(?<sudo_op>\\w+)\\s*:" | rex field=_raw "\\((?<paren_op>\\w+)\\)" | eval operator = case(sourcetype="sap:hana:audit", "HANA:" . executing_user, sourcetype="XmlWinEventLog", "Windows:" . coalesce(SubjectUserName, user, "unknown"), 1=1, "Linux:" . coalesce(sudo_op, paren_op, os_user, "unknown")) | eval category = case(sourcetype="sap:hana:audit" AND action_category="Permission Grant", "Permission Grant", sourcetype="sap:hana:audit" AND action_category="Permission Revoke", "Permission Revoke", sourcetype="sap:hana:audit" AND action_category IN ("User Creation","User Deletion","User Management"), "User Management", sourcetype="sap:hana:audit" AND action_category IN ("Password Management","Password Reset"), "Password Change", sourcetype="sap:hana:audit" AND action_category="Account Status Change", "Account Status", sourcetype="sap:hana:audit", "DDL / Config", sourcetype="XmlWinEventLog" AND EventCode IN (4720,4722,4725,4726,4738,4781), "User Management", sourcetype="XmlWinEventLog" AND EventCode=4724, "Password Change", sourcetype="XmlWinEventLog" AND EventCode IN (4728,4729,4732,4733,4756,4757), "Group Membership", sourcetype="XmlWinEventLog" AND EventCode IN (4740,4767), "Account Status", match(_raw, "(?i)passwd\\b"), "Password Change", match(_raw, "(?i)(useradd|usermod|userdel)"), "User Management", match(_raw, "(?i)(groupadd|groupmod|groupdel)"), "Group Membership", match(_raw, "COMMAND="), "Sudo Command", 1=1, "Other") | eval hr = tonumber(strftime(_time, "%H")) | eval dw = strftime(_time, "%A") | eval is_after_hours = if(hr < 8 OR hr > 18 OR match(dw, "(?i)(saturday|sunday)"), 1, 0)`;

/**
 * Dashboard-perf roadmap tier #6 (KV-Store precompute, session 051 / build 212).
 *
 * Change & Configuration Activity is a cross-stack compliance dashboard (HANA /
 * Windows / Linux change synthesis) commonly run over WIDE time ranges, with a
 * per-event ENRICH classification (change_source / category / operator /
 * is_after_hours) that raw-scanned every panel. The 9 aggregatable panels below
 * now read from the `logserv_compliance_rollup` KV Store collection, populated
 * hourly by [logserv_compliance_aggregate] (one-time backfill via
 * [logserv_compliance_backfill]). The 5 per-event audit-trail tables (HANA /
 * Windows / Linux / Privileged / After-Hours) stay RAW — a rollup can't
 * reconstruct an event-level listing; `priv` + `ah` still use CHANGE_FILTER /
 * ENRICH above.
 *
 * 4 metrics. `main` (change_source/category/operator/is_after_hours grain)
 * serves the Total/After-Hours/Operators KPIs+sparks, the Activity chart, the
 * Category pie, and the Operators table. `userchg`/`permgrant`/`password` are
 * per-bucket counts that replicate each KPI's EXACT filter — those filters are
 * NOT simple subsets of main's `category` dim (e.g. permGrants counts Windows
 * group-add EventCodes that main classifies "Group Membership"). The
 * userchg/password arms apply their Linux `match(_raw, ...)` regex in a
 * post-base `| where` (session-051 follow-up): match() in BASE-search position
 * silently returns 0, which previously UNDER-COUNTED the Linux clause (e.g.
 * `kpiPassword` read 0 while the Category pie showed the same 21 linux:sudolog
 * passwd events). The rollup now counts them correctly — byte-identical to the
 * Category pie's regex classification on any data. operator is the
 * one nullable dim (HANA null executing_user -> "HANA:"+null = null): the
 * aggregate fillnull's it to "(none)" to preserve TOTAL counts, and reads
 * exclude "(none)" to reproduce the raw stats-by-operator / dc(operator)
 * drop-null semantics.
 *
 * Read idiom: `| inputlookup <coll> where metric=X | addinfo | where bucket_ts
 * range | <agg>`. addinfo carries the global TimeRange picker (useSearch sets
 * the dispatch earliest/latest) into the generating inputlookup. bucket_ts is
 * hour-aligned, so day-aligned picker ranges match the raw scope exactly.
 */
const ROLL = 'logserv_compliance_rollup';
const RANGE = '| addinfo | where bucket_ts>=info_min_time AND bucket_ts<info_max_time';
const MAIN = `| inputlookup ${ROLL} where metric="main" ${RANGE}`;
const USERCHG = `| inputlookup ${ROLL} where metric="userchg" ${RANGE}`;
const PERMGRANT = `| inputlookup ${ROLL} where metric="permgrant" ${RANGE}`;
const PASSWORD = `| inputlookup ${ROLL} where metric="password" ${RANGE}`;

const Q_BASE = {
    // KPIs read precomputed per-bucket counts. The `stats count as n, ...`
    // forces a result row even when the metric has ZERO rows (an empty
    // `| inputlookup | stats sum(count)` returns 0 rows, unlike a raw event
    // search's `| stats count` which always returns count=0); `n` is a throwaway
    // row-anchor that `| fields count` drops (a non-underscore field, so fields
    // removes it — an underscore-prefixed name would survive), and
    // `fillnull value=0 count` then yields a clean 0. This matches raw
    // `stats count`=0 for an all-zero metric (a metric with no matching events
    // in the picker range — e.g. permGrants on an estate with no Windows logs).
    kpiTotal: `${MAIN} | stats count as n, sum(count) as count | fillnull value=0 count | fields count`,
    kpiUserChanges: `${USERCHG} | stats count as n, sum(count) as count | fillnull value=0 count | fields count`,
    kpiPermGrants: `${PERMGRANT} | stats count as n, sum(count) as count | fillnull value=0 count | fields count`,
    kpiPassword: `${PASSWORD} | stats count as n, sum(count) as count | fillnull value=0 count | fields count`,
    kpiAfterHours: `${MAIN} | search is_after_hours=1 | stats count as n, sum(count) as count | fillnull value=0 count | fields count`,
    kpiOperators: `${MAIN} | stats dc(eval(if(operator="(none)",null(),operator))) as operators`,

    // Timecharts: `eval _time=bucket_ts` then `| fillnull value=0` — raw `count`
    // zero-fills empty series-bins, rollup `sum(count)` nulls them.
    sparkTotal: `${MAIN} | eval _time=bucket_ts | timechart span=1d sum(count) as count | fillnull value=0`,
    sparkUserChanges: `${USERCHG} | eval _time=bucket_ts | timechart span=1d sum(count) as count | fillnull value=0`,
    sparkPermGrants: `${PERMGRANT} | eval _time=bucket_ts | timechart span=1d sum(count) as count | fillnull value=0`,
    sparkPassword: `${PASSWORD} | eval _time=bucket_ts | timechart span=1d sum(count) as count | fillnull value=0`,
    sparkAfterHours: `${MAIN} | search is_after_hours=1 | eval _time=bucket_ts | timechart span=1d sum(count) as count | fillnull value=0`,
    sparkOperators: `${MAIN} | eval _time=bucket_ts | timechart span=1d dc(eval(if(operator="(none)",null(),operator))) as operators | fillnull value=0`,

    activity: `${MAIN} | eval _time=bucket_ts | timechart span=1d sum(count) by change_source | fillnull value=0`,
    category: `${MAIN} | stats sum(count) as count by category | sort -count`,
    operators: `${MAIN} | search operator!="(none)" | stats sum(count) as count by operator | sort -count | rename operator as "Operator", count as "Change Events"`,

    hana: `\`sap_logserv_idx_macro\` sourcetype="sap:hana:audit" (action_category IN ("User Management","User Creation","User Deletion","Permission Grant","Permission Revoke","Password Management","Account Status Change","Password Reset") OR action_type IN ("CREATE TABLE","ALTER TABLE","DROP TABLE","CREATE VIEW","ALTER VIEW","DROP VIEW","CREATE SCHEMA","ALTER SCHEMA","DROP SCHEMA","CREATE FUNCTION","ALTER FUNCTION","DROP FUNCTION","CREATE PROCEDURE","ALTER PROCEDURE","DROP PROCEDURE","AUDIT POLICY","CREATE AUDIT POLICY","ALTER AUDIT POLICY","DROP AUDIT POLICY")) | head 500 | eval Time = strftime(_time, "%Y-%m-%d %H:%M:%S") | sort -_time | table Time, executing_user, target_user, action_category, action_type, status, audit_hostname | rename executing_user as "Operator", target_user as "Target", action_category as "Category", action_type as "Action", status as "Status", audit_hostname as "Host"`,
    windows: `\`sap_logserv_idx_macro\` sourcetype="XmlWinEventLog" EventCode IN (4720,4722,4724,4725,4726,4738,4740,4767,4781,4728,4729,4732,4733,4756,4757) | head 500 | eval Time = strftime(_time, "%Y-%m-%d %H:%M:%S") | eval Description = case(EventCode=4720, "Account Created", EventCode=4722, "Account Enabled", EventCode=4724, "Password Reset", EventCode=4725, "Account Disabled", EventCode=4726, "Account Deleted", EventCode=4738, "Account Modified", EventCode=4740, "Account Locked Out", EventCode=4767, "Account Unlocked", EventCode=4781, "Account Renamed", EventCode=4728, "Added to Global Group", EventCode=4729, "Removed from Global Group", EventCode=4732, "Added to Local Group", EventCode=4733, "Removed from Local Group", EventCode=4756, "Added to Universal Group", EventCode=4757, "Removed from Universal Group", 1=1, "Other") | sort -_time | table Time, EventCode, Description, SubjectUserName, TargetUserName, host | rename EventCode as "Event", SubjectUserName as "Operator", TargetUserName as "Target", host as "Computer"`,
    linux: `\`sap_logserv_idx_macro\` (sourcetype="linux_messages_syslog" OR sourcetype="linux_secure" OR sourcetype="linux:cron" OR sourcetype="linux:warn" OR sourcetype="linux:sudolog" OR sourcetype="linux:slapd" OR sourcetype="syslog") ("COMMAND=" OR useradd OR usermod OR userdel OR groupadd OR groupmod OR groupdel OR passwd) | head 500 | eval Time = strftime(_time, "%Y-%m-%d %H:%M:%S") | rex field=_raw "sudo:\\s+(?<sudo_op>\\w+)\\s*:" | rex field=_raw "\\((?<paren_op>\\w+)\\)" | rex field=_raw "COMMAND=(?<cmd>[^\\s]+(?:\\s[^\\s]+){0,4})" | eval Operator = coalesce(sudo_op, paren_op, os_user, "unknown") | eval Type = case(match(_raw, "(?i)useradd"), "useradd", match(_raw, "(?i)usermod"), "usermod", match(_raw, "(?i)userdel"), "userdel", match(_raw, "(?i)groupadd"), "groupadd", match(_raw, "(?i)groupmod"), "groupmod", match(_raw, "(?i)groupdel"), "groupdel", match(_raw, "(?i)passwd\\b"), "passwd", match(_raw, "COMMAND="), "sudo", 1=1, "other") | sort -_time | table Time, Operator, Type, cmd, host | rename cmd as "Command", host as "Host"`,

    priv: `\`sap_logserv_idx_macro\` ( (sourcetype="sap:hana:audit" (action_category IN ("Permission Grant","User Creation") OR action_type IN ("AUDIT POLICY","CREATE AUDIT POLICY","ALTER AUDIT POLICY","DROP AUDIT POLICY"))) OR (sourcetype="XmlWinEventLog" EventCode IN (4720,4722,4724,4732)) OR ((sourcetype="linux_messages_syslog" OR sourcetype="linux_secure" OR sourcetype="linux:cron" OR sourcetype="linux:warn" OR sourcetype="linux:sudolog" OR sourcetype="linux:slapd" OR sourcetype="syslog") (useradd OR visudo OR usermod OR userdel)) ) | head 500 | ${ENRICH} | eval Time = strftime(_time, "%Y-%m-%d %H:%M:%S") | eval Target = case(sourcetype="sap:hana:audit", target_user, sourcetype="XmlWinEventLog", TargetUserName, 1=1, "-") | eval Action = case(sourcetype="sap:hana:audit", action_type, sourcetype="XmlWinEventLog" AND EventCode=4720, "User Created (EventCode 4720)", sourcetype="XmlWinEventLog" AND EventCode=4722, "User Enabled (EventCode 4722)", sourcetype="XmlWinEventLog" AND EventCode=4724, "Password Reset (EventCode 4724)", sourcetype="XmlWinEventLog" AND EventCode=4732, "Added to Local Group (EventCode 4732)", sourcetype="XmlWinEventLog", "EventCode " . EventCode, 1=1, substr(_raw, 1, 120)) | sort -_time | table Time, change_source, category, operator, Target, Action | rename change_source as "Source", category as "Category", operator as "Operator"`,
    ah: `\`sap_logserv_idx_macro\` ${CHANGE_FILTER} | ${ENRICH} | where is_after_hours=1 | head 500 | eval Time = strftime(_time, "%Y-%m-%d %H:%M:%S") | eval Target = case(sourcetype="sap:hana:audit", target_user, sourcetype="XmlWinEventLog", TargetUserName, 1=1, "-") | eval Action = case(sourcetype="sap:hana:audit", action_type, sourcetype="XmlWinEventLog", "EventCode " . EventCode, 1=1, substr(_raw, 1, 120)) | eval Day = strftime(_time, "%a %H:%M") | sort -_time | table Time, Day, change_source, category, operator, Target, Action | rename change_source as "Source", category as "Category", operator as "Operator"`,
};

/* ---------------------------------------------------------------------------
 * RAW fallbacks for the sub-hour hybrid (session 087). Each is the raw
 * change-event scan its rollup metric precomputes, reconstructed from the
 * [logserv_compliance_aggregate] arms. The main-scope panels (Total/AfterHours/
 * Operators KPIs, Activity chart, Category pie, Operators table) reuse
 * CHANGE_FILTER + ENRICH; the per-metric KPIs replicate each aggregate arm's
 * EXACT filter. The userchg/password arms apply their Linux match(_raw,...)
 * regex in a post-base `| where` (the session-051 match()-in-base fix — match()
 * in base-search position silently counts 0), NOT the base search; permgrant's
 * base IS its exact filter (no where). The "(none)" operator sentinel maps to
 * raw stats-by null-drop (operator never fillnull'd in the raw ENRICH). Only the
 * sparklines stay cached (cosmetic span=1d) + the 5 event-listing tables
 * (hana/windows/linux/priv/ah) stay raw. De-risked 9/9 byte-equal on the box.
 * ------------------------------------------------------------------------- */
const CCRAW = `\`sap_logserv_idx_macro\``;
const LINUX_ST = `(sourcetype="linux_messages_syslog" OR sourcetype="linux_secure" OR sourcetype="linux:cron" OR sourcetype="linux:warn" OR sourcetype="linux:sudolog" OR sourcetype="linux:slapd" OR sourcetype="syslog")`;
const QRAW_BASE = {
    kpiTotal: `${CCRAW} ${CHANGE_FILTER} | stats count`,
    kpiUserChanges: `${CCRAW} ( (sourcetype="sap:hana:audit" action_category IN ("User Creation","User Deletion","User Management")) OR (sourcetype="XmlWinEventLog" EventCode IN (4720,4722,4725,4726,4738,4781)) OR ${LINUX_ST} ) | where (sourcetype="sap:hana:audit" AND action_category IN ("User Creation","User Deletion","User Management")) OR (sourcetype="XmlWinEventLog" AND EventCode IN (4720,4722,4725,4726,4738,4781)) OR (${LINUX_ST} AND match(_raw, "(?i)(useradd|usermod|userdel)")) | stats count`,
    kpiPermGrants: `${CCRAW} ( (sourcetype="sap:hana:audit" action_category="Permission Grant") OR (sourcetype="XmlWinEventLog" EventCode IN (4728,4732,4756)) ) | stats count`,
    kpiPassword: `${CCRAW} ( (sourcetype="sap:hana:audit" action_category IN ("Password Management","Password Reset")) OR (sourcetype="XmlWinEventLog" EventCode=4724) OR ${LINUX_ST} ) | where (sourcetype="sap:hana:audit" AND action_category IN ("Password Management","Password Reset")) OR (sourcetype="XmlWinEventLog" AND EventCode=4724) OR (${LINUX_ST} AND match(_raw, "(?i)passwd\\b")) | stats count`,
    kpiAfterHours: `${CCRAW} ${CHANGE_FILTER} | ${ENRICH} | where is_after_hours=1 | stats count`,
    kpiOperators: `${CCRAW} ${CHANGE_FILTER} | ${ENRICH} | stats dc(operator) as operators`,
    activity: `${CCRAW} ${CHANGE_FILTER} | ${ENRICH} | timechart span=1d count by change_source | fillnull value=0`,
    category: `${CCRAW} ${CHANGE_FILTER} | ${ENRICH} | stats count by category | sort -count`,
    operators: `${CCRAW} ${CHANGE_FILTER} | ${ENRICH} | stats count by operator | sort -count | rename operator as "Operator", count as "Change Events"`,
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
/** useFirstRowField over a hybrid cached/raw pair (session 087). */
const useFirstRowFieldHybrid = (cached: string, raw: string, f: string): FirstRow => {
    const search = useHybridSearch({ cached, raw });
    const { results, loading, error } = search;
    const value = results && results[0] ? (results[0] as Record<string, unknown>)[f] : undefined;
    return { value, loading, error, search };
};

const OPERATOR_COLS: ColumnDef[] = [
    { key: 'Operator', label: 'Operator (source-prefixed)' },
    { key: 'Change Events', label: 'Change Events', align: 'right', render: (v) => formatInteger(v) },
];
const HANA_COLS: ColumnDef[] = [
    { key: 'Time', label: 'Time', width: '160px' },
    { key: 'Operator', label: 'Operator' },
    { key: 'Target', label: 'Target' },
    { key: 'Category', label: 'Category' },
    { key: 'Action', label: 'Action' },
    { key: 'Status', label: 'Status', width: '120px' },
    { key: 'Host', label: 'Host', width: '160px' },
];
const WIN_COLS: ColumnDef[] = [
    { key: 'Time', label: 'Time', width: '160px' },
    { key: 'Event', label: 'Event', width: '80px' },
    { key: 'Description', label: 'Description' },
    { key: 'Operator', label: 'Operator' },
    { key: 'Target', label: 'Target' },
    { key: 'Computer', label: 'Computer', width: '160px' },
];
const LINUX_COLS: ColumnDef[] = [
    { key: 'Time', label: 'Time', width: '160px' },
    { key: 'Operator', label: 'Operator' },
    { key: 'Type', label: 'Type', width: '110px' },
    { key: 'Command', label: 'Command' },
    { key: 'Host', label: 'Host', width: '160px' },
];
const PRIV_COLS: ColumnDef[] = [
    { key: 'Time', label: 'Time', width: '160px' },
    { key: 'Source', label: 'Source', width: '90px' },
    { key: 'Category', label: 'Category', width: '160px' },
    { key: 'Operator', label: 'Operator' },
    { key: 'Target', label: 'Target' },
    { key: 'Action', label: 'Action' },
];
const AH_COLS: ColumnDef[] = [
    { key: 'Time', label: 'Time', width: '160px' },
    { key: 'Day', label: 'Day', width: '90px' },
    { key: 'Source', label: 'Source', width: '90px' },
    { key: 'Category', label: 'Category', width: '160px' },
    { key: 'Operator', label: 'Operator' },
    { key: 'Target', label: 'Target' },
    { key: 'Action', label: 'Action' },
];

const ChangeConfig: React.FC = () => {
    const { provider } = useCloudProvider();
    const Q = React.useMemo(() => mapCloudProviderQueries(Q_BASE, provider), [provider]);
    // RAW fallbacks for the sub-hour hybrid (session 087); same cloud mapping so both arms filter identically.
    const QRAW = React.useMemo(() => mapCloudProviderQueries(QRAW_BASE, provider), [provider]);
    const total = useFirstRowFieldHybrid(Q.kpiTotal, QRAW.kpiTotal, 'count');
    const userChanges = useFirstRowFieldHybrid(Q.kpiUserChanges, QRAW.kpiUserChanges, 'count');
    const permGrants = useFirstRowFieldHybrid(Q.kpiPermGrants, QRAW.kpiPermGrants, 'count');
    const password = useFirstRowFieldHybrid(Q.kpiPassword, QRAW.kpiPassword, 'count');
    const afterHours = useFirstRowFieldHybrid(Q.kpiAfterHours, QRAW.kpiAfterHours, 'count');
    const operatorsKpi = useFirstRowFieldHybrid(Q.kpiOperators, QRAW.kpiOperators, 'operators');

    const operators = useHybridSearch({ cached: Q.operators, raw: QRAW.operators });
    const hana = useSearch({ query: Q.hana });
    const windows = useSearch({ query: Q.windows });
    const linux = useSearch({ query: Q.linux });
    const priv = useSearch({ query: Q.priv });
    const ah = useSearch({ query: Q.ah });

    // Charts / pie take a query string → route once each (sub-hour -> raw).
    const qActivity = useRoutedQuery(Q.activity, QRAW.activity);
    const qCategory = useRoutedQuery(Q.category, QRAW.category);

    const ahTone = Number(afterHours.value ?? 0) > 0 ? 'warning' : 'neutral';

    /* Drilldowns (build 159 / session 027 task 6).
     * Compliance audit-trail tables (After-Hours Changes, Recent Privileged
     * Changes) intentionally have NO drilldown — clicking through to raw
     * events from a compliance report risks polluting the audit trail with
     * the reviewer's own activity. The HANA Audit / Windows / Linux tables
     * support drilldown by Operator + Target since those are not the
     * compliance trail itself but per-source detail views. */
    const { timeRange } = useTimeRange();
    const goHanaRow = (row: Record<string, unknown>): void => {
        const op = String(row.Operator ?? '');
        const tgt = String(row.Target ?? '');
        const opClause = op ? ` executing_user="${splQuote(op)}"` : '';
        const tgtClause = tgt ? ` target_user="${splQuote(tgt)}"` : '';
        if (!op && !tgt) return;
        const spl = `\`sap_logserv_idx_macro\` sourcetype="sap:hana:audit"${opClause}${tgtClause} | sort -_time`;
        openInNewTab(buildSplunkSearchUrl(spl, timeRange.earliest, timeRange.latest));
    };
    const goWinRow = (row: Record<string, unknown>): void => {
        const computer = String(row.Computer ?? '');
        const ec = String(row.Event ?? '');
        if (!computer && !ec) return;
        const computerClause = computer ? `host="${splQuote(computer)}" ` : '';
        const ecClause = ec ? `EventCode=${ec} ` : '';
        const spl = `\`sap_logserv_idx_macro\` sourcetype="XmlWinEventLog" ${computerClause}${ecClause}| sort -_time`;
        openInNewTab(buildSplunkSearchUrl(spl, timeRange.earliest, timeRange.latest));
    };
    const goLinuxRow = (row: Record<string, unknown>): void => {
        const host = String(row.Host ?? '');
        if (!host) return;
        const spl = `\`sap_logserv_idx_macro\` (sourcetype="linux_messages_syslog" OR sourcetype="linux_secure" OR sourcetype="linux:cron" OR sourcetype="linux:warn" OR sourcetype="linux:sudolog" OR sourcetype="linux:slapd" OR sourcetype="syslog") host="${splQuote(host)}" ("COMMAND=" OR useradd OR usermod OR userdel OR groupadd OR groupmod OR groupdel OR passwd) | sort -_time`;
        openInNewTab(buildSplunkSearchUrl(spl, timeRange.earliest, timeRange.latest));
    };

    return (
        <DashboardLayout
            category="SECURITY"
            title="Change & Configuration Activity"
            subtitle="Cross-stack audit trail — HANA user/role/privilege changes, Windows account and group modifications, Linux sudo and user-management activity, with compliance-focused privileged and after-hours views"
        >
            <KpiRow>
                <KpiCard label="Total Change Events" value={total.value} loading={total.loading} error={total.error} search={total.search} formatValue={formatInteger}
                    sparkline={<SparklineFromQuery query={Q.sparkTotal} valueField="count" fill />} />
                <KpiCard label="User Account Changes" value={userChanges.value} loading={userChanges.loading} error={userChanges.error} search={userChanges.search} formatValue={formatInteger}
                    sparkline={<SparklineFromQuery query={Q.sparkUserChanges} valueField="count" fill />} />
                <KpiCard label="Permission Grants" value={permGrants.value} loading={permGrants.loading} error={permGrants.error} search={permGrants.search} formatValue={formatInteger}
                    sparkline={<SparklineFromQuery query={Q.sparkPermGrants} valueField="count" fill />} />
                <KpiCard label="Password Events" value={password.value} loading={password.loading} error={password.error} search={password.search} formatValue={formatInteger}
                    sparkline={<SparklineFromQuery query={Q.sparkPassword} valueField="count" fill />} />
                <KpiCard label="After-Hours Changes" value={afterHours.value} loading={afterHours.loading} error={afterHours.error} search={afterHours.search} formatValue={formatInteger} tone={ahTone}
                    sparkline={<SparklineFromQuery query={Q.sparkAfterHours} valueField="count" color={logservTheme.colors.orange} fill />} />
                <KpiCard label="Unique Operators" value={operatorsKpi.value} loading={operatorsKpi.loading} error={operatorsKpi.error} search={operatorsKpi.search} formatValue={formatInteger}
                    sparkline={<SparklineFromQuery query={Q.sparkOperators} valueField="operators" fill />} />
            </KpiRow>

            <PanelGrid2>
                <FramedPanel title="Change Activity Over Time (by Source)" subtitle="Daily volume — HANA / Windows / Linux">
                    <TimeSeriesChart query={qActivity} height={300} palette="auth" />
                </FramedPanel>
                <FramedPanel title="Change Events by Category" subtitle="Permission Grant / User Mgmt / DDL / Password / etc.">
                    <PieChart query={qCategory} categoryField="category" valueField="count" height={300} donut palette="auth" />
                </FramedPanel>
            </PanelGrid2>

            <FullWidthPanel>
                <FramedPanel search={operators} title="Operators by Change Count (Source-Prefixed)" subtitle="Operator IDs across all 3 stacks ranked by change events">
                    <DataTable columns={OPERATOR_COLS} rows={operators.results} loading={operators.loading} error={operators.error} emptyMessage="No change activity in this time range." initialSortKey="Change Events" initialSortDir="desc" />
                </FramedPanel>
            </FullWidthPanel>

            <FullWidthPanel>
                <FramedPanel search={hana} title="HANA Audit — Change Events" subtitle="HANA user/permission/DDL audit trail, most-recent first">
                    <DataTable columns={HANA_COLS} rows={hana.results} loading={hana.loading} error={hana.error} emptyMessage="No HANA audit change events in this time range." initialSortKey="Time" initialSortDir="desc" onRowClick={goHanaRow} />
                </FramedPanel>
            </FullWidthPanel>

            <FullWidthPanel>
                <FramedPanel search={windows} title="Windows — Account & Group Modifications" subtitle="EventCodes 4720-4781 / 4728-4757 with friendly description, most-recent first">
                    <DataTable columns={WIN_COLS} rows={windows.results} loading={windows.loading} error={windows.error} emptyMessage="No Windows account events in this time range." initialSortKey="Time" initialSortDir="desc" onRowClick={goWinRow} />
                </FramedPanel>
            </FullWidthPanel>

            <FullWidthPanel>
                <FramedPanel search={linux} title="Linux — Sudo & Command Activity" subtitle="useradd / usermod / passwd / sudo COMMAND= extraction, most-recent first">
                    <DataTable columns={LINUX_COLS} rows={linux.results} loading={linux.loading} error={linux.error} emptyMessage="No Linux change activity in this time range." initialSortKey="Time" initialSortDir="desc" onRowClick={goLinuxRow} />
                </FramedPanel>
            </FullWidthPanel>

            <PanelGrid2>
                <FramedPanel search={priv} title="Recent Privileged Changes (Compliance Focus)" subtitle="High-privilege subset for compliance review, most-recent first">
                    <DataTable columns={PRIV_COLS} rows={priv.results} loading={priv.loading} error={priv.error} emptyMessage="No privileged changes in this time range." initialSortKey="Time" initialSortDir="desc" />
                </FramedPanel>
                <FramedPanel search={ah} title="Recent After-Hours Changes (Outside Business Hours)" subtitle="Changes outside 8am–7pm or on weekends, most-recent first">
                    <DataTable columns={AH_COLS} rows={ah.results} loading={ah.loading} error={ah.error} emptyMessage="No after-hours changes in this time range." initialSortKey="Time" initialSortDir="desc" />
                </FramedPanel>
            </PanelGrid2>
        </DashboardLayout>
    );
};

export default ChangeConfig;
