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
import { buildHostDetailsUrl, buildSplunkSearchUrl, openInNewTab, splQuote } from '../utils/drilldownUrls';
import { logservTheme } from '../styles/logservTheme';

/**
 * Linux System & Security — honest port of v0.0.4.2 logserv_linux.xml.
 *
 * 4-KPI row: Total Events / Firewall Drops / Top Drop Source / Active Hosts.
 * Row 2 (2 panels): Event Volume by Sourcetype | SAP Application Activity (stacked).
 * Row 3 (3 panels): SAP Instance Distribution | Firewall Drops Over Time | Kernel Event Types (donut).
 * Row 4 (2 panels): Top Blocked Sources | Top Blocked Destination Ports.
 */

const KpiRow = styled.div`
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: ${logservTheme.elevation.panelGap};
    margin-bottom: ${logservTheme.elevation.panelGap};
    @media (max-width: 1100px) { grid-template-columns: repeat(2, minmax(0, 1fr)); }
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

/**
 * Dashboard-perf roadmap tier #6 (KV-Store precompute, session 052 / build 221).
 *
 * All 22 panels are count/sum/dc/max/values/avg aggregations (no streamstats /
 * percentile / event-listing), so the whole dashboard reads from the
 * `logserv_linux_rollup` KV Store collection, populated hourly by
 * [logserv_linux_aggregate] (one-time [logserv_linux_backfill]). 0 RAW panels.
 *
 * 8 metrics (design adversarially reviewed pre-build; verdict: ship). `total`
 * (sourcetype, host) over ST_ALL — kpiTotal/kpiHosts + sparks + volumeByType +
 * fwTimeline (derived via sourcetype="linux_secure"). `fw` (fw_action/src/dst/
 * dpt/proto/host over linux_secure, rex from _raw) — IDENTICAL shape to the
 * Network Perimeter `fw` metric; serves kpiFwDrops (fw_action=IN_DROP),
 * kpiTopDropSrc / fwTopSources (all-secure-with-src, NO IN_DROP filter), fwTopPorts.
 * The Linux DataTables key on the RAW field names (fw_src/fw_dpt/fw_proto/Targets/
 * Protocol) so these reads must NOT apply NP's renames. `kernel` (kernel_event).
 * `sapapp` (sap_app, sap_sid) — plain stats, NOT a timechart. `sapinst` (sap_sid,
 * sap_inst, sap_cid, host). `oom`/`lockup`/`tcpoom` (resource pressure; max-of-max
 * + avg-from-sum/count reconstruction; group-by host fillnull'd → reads add
 * `| search host!="(none)"` to restore raw's null-host drop).
 *
 * Read idiom: `| inputlookup <coll> where metric=X | addinfo | where bucket_ts
 * range | <agg>`. Count KPIs empty-safe; COUNT/dc timecharts append fillnull-0;
 * sapAppActivity (plain stats fed to a chart) does NOT.
 */
const ROLL = 'logserv_linux_rollup';
const RANGE = '| addinfo | where bucket_ts>=info_min_time AND bucket_ts<info_max_time';
const TOTAL = `| inputlookup ${ROLL} where metric="total" ${RANGE}`;
// hosts is a separate metric (grain host) from total (grain sourcetype): some
// linux_messages_syslog events carry a multivalue host, so combining count-by-
// sourcetype with dc(host) in one grain would inflate the count. dc(host) here
// is mv-host-correct; the count field is unused.
const HOSTS = `| inputlookup ${ROLL} where metric="hosts" ${RANGE}`;
const FW = `| inputlookup ${ROLL} where metric="fw" ${RANGE}`;
const KERNEL = `| inputlookup ${ROLL} where metric="kernel" ${RANGE}`;
const SAPAPP = `| inputlookup ${ROLL} where metric="sapapp" ${RANGE}`;
const SAPINST = `| inputlookup ${ROLL} where metric="sapinst" ${RANGE}`;
const OOM = `| inputlookup ${ROLL} where metric="oom" ${RANGE}`;
const LOCKUP = `| inputlookup ${ROLL} where metric="lockup" ${RANGE}`;
const TCPOOM = `| inputlookup ${ROLL} where metric="tcpoom" ${RANGE}`;

const Q_BASE = {
    // KPIs (count KPIs use the empty-safe idiom; kpiHosts is a dc, kpiTopDropSrc
    // reconstructs the "ip (N,NNN)" display string char-for-char).
    kpiTotal: `${TOTAL} | stats count as n, sum(count) as count | fillnull value=0 count | fields count`,
    kpiFwDrops: `${FW} | search fw_action="IN_DROP" | stats count as n, sum(count) as count | fillnull value=0 count | fields count`,
    kpiTopDropSrc: `${FW} | search fw_src!="(none)" | stats sum(count) as drops by fw_src | sort -drops | head 1 | eval display = fw_src . " (" . tostring(drops, "commas") . ")" | table display`,
    kpiHosts: `${HOSTS} | stats dc(eval(if(host="(none)",null(),host))) as hosts`,

    // Sparklines (COUNT + dc timecharts 0-fill empty bins via fillnull-0)
    sparkTotal: `${TOTAL} | eval _time=bucket_ts | timechart span=1d sum(count) as count | fillnull value=0`,
    sparkFwDrops: `${FW} | search fw_action="IN_DROP" | eval _time=bucket_ts | timechart span=1d sum(count) as count | fillnull value=0`,
    sparkHosts: `${HOSTS} | eval _time=bucket_ts | timechart span=1d dc(eval(if(host="(none)",null(),host))) AS hosts | fillnull value=0`,

    // Charts
    volumeByType: `${TOTAL} | eval _time=bucket_ts | timechart span=1d sum(count) by sourcetype | fillnull value=0`,
    // sapAppActivity — plain stats (no _time axis) rendered as a HORIZONTAL bar
    // chart of the top-15 (sap_app / sap_sid) combinations by volume. The combo
    // label sits on the roomy y-axis so long app names (ICINGA_PROXY,
    // HANA_X_MDC_NODE, …) stay readable — a vertical column chart clipped all 26
    // long x-axis labels to "…". `sort count` (ascending) after the top-15 cut
    // puts the largest bar at the top of the chart.
    sapAppActivity: `${SAPAPP} | search sap_sid!="(none)" | stats sum(count) as count by sap_app, sap_sid | eval combo=sap_app." / ".sap_sid | sort -count | head 15 | sort count | fields combo count`,
    // fwTimeline counts ALL linux_secure (no IN_DROP filter) — derived from `total`.
    fwTimeline: `${TOTAL} | search sourcetype="linux_secure" | eval _time=bucket_ts | timechart span=1d sum(count) AS "Firewall Events" | fillnull value=0`,
    kernelEvents: `${KERNEL} | stats sum(count) as count by kernel_event | sort -count`,

    // Tables (sapInstances restores raw's null-group drop on sap_inst AND sap_cid;
    // fwTopSources/fwTopPorts keep the RAW field keys — no NP-style renames).
    sapInstances: `${SAPINST} | search sap_inst!="(none)" sap_cid!="(none)" | stats sum(count) as Events, dc(eval(if(host="(none)",null(),host))) as Hosts by sap_sid, sap_inst, sap_cid | sort -Events`,
    fwTopSources: `${FW} | search fw_src!="(none)" | stats sum(count) as Drops, dc(eval(if(fw_dst="(none)",null(),fw_dst))) as Targets, values(eval(if(fw_proto="(none)",null(),fw_proto))) as Protocol by fw_src | sort -Drops`,
    fwTopPorts: `${FW} | search fw_dpt!="(none)" fw_proto!="(none)" | stats sum(count) as Drops, dc(eval(if(host="(none)",null(),host))) as Hosts by fw_dpt, fw_proto | sort -Drops`,

    // Resource Pressure (build 186 / session 034). max-of-max + avg-from-sum/count
    // reconstruction; oomByHost/cpuLockups/tcpOomTimeline group by host (fillnull'd)
    // so add `| search host!="(none)"` to restore raw's null-host drop.
    oomByHost: `${OOM} | search host!="(none)" | stats sum(count) AS Kills, values(eval(if(oom_proc="(none)",null(),oom_proc))) AS Victims, max(max_rss) AS MaxRssKb, max(max_vm) AS MaxVmKb by host | eval "Max RSS (MB)" = round(MaxRssKb / 1024, 0) | eval "Max VM (MB)" = round(MaxVmKb / 1024, 0) | fields - MaxRssKb, MaxVmKb | sort -Kills`,
    oomByVictim: `${OOM} | search oom_proc!="(none)" | stats sum(count) AS Kills, dc(eval(if(host="(none)",null(),host))) AS Hosts, max(max_rss) AS MaxRssKb by oom_proc | eval "Max RSS (MB)" = round(MaxRssKb / 1024, 0) | fields - MaxRssKb | sort -Kills`,
    cpuLockups: `${LOCKUP} | search host!="(none)" | stats sum(count) AS Lockups, dc(eval(if(lockup_cpu="(none)",null(),lockup_cpu))) AS "CPUs", max(max_dur) AS "Max (sec)", sum(sum_dur) AS tot_dur by host | eval "Avg (sec)" = round(tot_dur / Lockups, 1) | fields - tot_dur | sort -Lockups`,
    tcpOomTimeline: `${TCPOOM} | search host!="(none)" | eval _time=bucket_ts | timechart span=1d sum(count) by host | fillnull value=0`,
};

/* ---------------------------------------------------------------------------
 * RAW fallbacks for the sub-hour hybrid (session 086). Each is the raw linux
 * scan its rollup metric precomputes, reconciled to the cached read's exact
 * output columns (byte-verified equal at wide windows — the lx_v_* staged
 * pairs). fw_* / kernel_event are rex'd from _raw (same patterns). COUNT/dc
 * split timecharts append `| fillnull value=0`; the "(none)" fillnull sentinels
 * map to raw `field=*` / stats-by null-drop. Only sparklines stay cached.
 * ------------------------------------------------------------------------- */
const ST_ALL = '(sourcetype="linux_messages_syslog" OR sourcetype="linux:cron" OR sourcetype="linux:warn" OR sourcetype="linux:sudolog" OR sourcetype="linux:slapd" OR sourcetype="syslog" OR sourcetype="linux_secure")';
const RAW_ALL = `\`sap_logserv_idx_macro\` ${ST_ALL}`;
const RAW_LSEC = '`sap_logserv_idx_macro` sourcetype="linux_secure"';
const RAW_LMSG = '`sap_logserv_idx_macro` sourcetype="linux_messages_syslog"';
const RAW_OOM = '`sap_logserv_idx_macro` (sourcetype="linux:warn" OR sourcetype="syslog")';
const QRAW_BASE = {
    kpiTotal: `${RAW_ALL} | stats count`,
    kpiFwDrops: `${RAW_LSEC} | rex field=_raw "(?<fw_action>IN_DROP|IN_ACCEPT)" | where fw_action="IN_DROP" | stats count`,
    kpiTopDropSrc: `${RAW_LSEC} | rex field=_raw "SRC=(?<fw_src>[^ ]+)" | where isnotnull(fw_src) AND fw_src!="" | stats count as drops by fw_src | sort -drops | head 1 | eval display = fw_src . " (" . tostring(drops, "commas") . ")" | table display`,
    kpiHosts: `${RAW_ALL} | stats dc(host) as hosts`,
    volumeByType: `${RAW_ALL} | timechart span=1d count by sourcetype | fillnull value=0`,
    sapAppActivity: `${RAW_LMSG} sap_app=* | stats count by sap_app, sap_sid | eval combo=sap_app." / ".sap_sid | sort -count | head 15 | sort count | fields combo count`,
    fwTimeline: `${RAW_LSEC} | timechart span=1d count AS "Firewall Events" | fillnull value=0`,
    kernelEvents: `${RAW_LSEC} | rex field=_raw "kernel:.*?\\]\\s+(?<kernel_event>[A-Z_]+)" | where isnotnull(kernel_event) | stats count by kernel_event | sort -count`,
    sapInstances: `${RAW_LMSG} sap_sid=* | stats count as Events dc(host) as Hosts by sap_sid, sap_inst, sap_cid | sort -Events`,
    fwTopSources: `${RAW_LSEC} | rex field=_raw "SRC=(?<fw_src>[^ ]+)" | rex field=_raw "DST=(?<fw_dst>[^ ]+)" | rex field=_raw "PROTO=(?<fw_proto>[^ ]+)" | where isnotnull(fw_src) | stats count as Drops dc(fw_dst) as Targets values(fw_proto) as Protocol by fw_src | sort -Drops`,
    fwTopPorts: `${RAW_LSEC} | rex field=_raw "DPT=(?<fw_dpt>[^ ]+)" | rex field=_raw "PROTO=(?<fw_proto>[^ ]+)" | where isnotnull(fw_dpt) | stats count as Drops dc(host) as Hosts by fw_dpt, fw_proto | sort -Drops`,
    oomByHost: `${RAW_OOM} "Out of memory: Killed process" | stats count AS Kills, values(oom_proc) AS Victims, max(oom_rss_kb) AS MaxRssKb, max(oom_vm_kb) AS MaxVmKb by host | eval "Max RSS (MB)" = round(MaxRssKb / 1024, 0) | eval "Max VM (MB)" = round(MaxVmKb / 1024, 0) | fields - MaxRssKb, MaxVmKb | sort -Kills`,
    oomByVictim: `${RAW_OOM} "Out of memory: Killed process" oom_proc=* | stats count AS Kills, dc(host) AS Hosts, max(oom_rss_kb) AS MaxRssKb by oom_proc | eval "Max RSS (MB)" = round(MaxRssKb / 1024, 0) | fields - MaxRssKb | sort -Kills`,
    cpuLockups: `${RAW_OOM} "soft lockup" | stats count AS Lockups, dc(lockup_cpu) AS "CPUs", max(lockup_duration_s) AS "Max (sec)", avg(lockup_duration_s) AS avg_s by host | eval "Avg (sec)" = round(avg_s, 1) | fields - avg_s | sort -Lockups`,
    tcpOomTimeline: `${RAW_OOM} "TCP: out of memory" host=* | timechart span=1d count by host | fillnull value=0`,
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

const SAP_INSTANCE_COLS: ColumnDef[] = [
    { key: 'sap_sid', label: 'SID' },
    { key: 'sap_inst', label: 'Instance' },
    { key: 'sap_cid', label: 'CID' },
    { key: 'Events', label: 'Events', align: 'right', render: (v) => formatInteger(v) },
    { key: 'Hosts', label: 'Hosts', align: 'right', render: (v) => formatInteger(v) },
];

const FW_SRC_COLS: ColumnDef[] = [
    { key: 'fw_src', label: 'Source IP' },
    { key: 'Drops', label: 'Drops', align: 'right', render: (v) => formatInteger(v) },
    { key: 'Targets', label: 'Targets', align: 'right', render: (v) => formatInteger(v) },
    { key: 'Protocol', label: 'Protocol' },
];

const FW_PORT_COLS: ColumnDef[] = [
    { key: 'fw_dpt', label: 'Dest Port' },
    { key: 'fw_proto', label: 'Protocol' },
    { key: 'Drops', label: 'Drops', align: 'right', render: (v) => formatInteger(v) },
    { key: 'Hosts', label: 'Hosts', align: 'right', render: (v) => formatInteger(v) },
];

// Resource Pressure column definitions (build 186)
const OOM_HOST_COLS: ColumnDef[] = [
    { key: 'host', label: 'Host' },
    { key: 'Kills', label: 'OOM Kills', align: 'right', render: (v) => formatInteger(v) },
    { key: 'Victims', label: 'Victim Processes' },
    { key: 'Max RSS (MB)', label: 'Max RSS (MB)', align: 'right', render: (v) => formatInteger(v) },
    { key: 'Max VM (MB)', label: 'Max VM (MB)', align: 'right', render: (v) => formatInteger(v) },
];

const OOM_VICTIM_COLS: ColumnDef[] = [
    { key: 'oom_proc', label: 'Victim Process' },
    { key: 'Kills', label: 'OOM Kills', align: 'right', render: (v) => formatInteger(v) },
    { key: 'Hosts', label: 'Hosts', align: 'right', render: (v) => formatInteger(v) },
    { key: 'Max RSS (MB)', label: 'Max RSS (MB)', align: 'right', render: (v) => formatInteger(v) },
];

const CPU_LOCKUP_COLS: ColumnDef[] = [
    { key: 'host', label: 'Host' },
    { key: 'Lockups', label: 'Lockups', align: 'right', render: (v) => formatInteger(v) },
    { key: 'CPUs', label: 'CPUs', align: 'right', render: (v) => formatInteger(v) },
    { key: 'Max (sec)', label: 'Max (sec)', align: 'right', render: (v) => formatInteger(v) },
    { key: 'Avg (sec)', label: 'Avg (sec)', align: 'right' },
];

const Linux: React.FC = () => {
    const { provider } = useCloudProvider();
    const Q = React.useMemo(() => mapCloudProviderQueries(Q_BASE, provider), [provider]);
    // RAW fallbacks for the sub-hour hybrid (session 086); same cloud mapping so both arms filter identically.
    const QRAW = React.useMemo(() => mapCloudProviderQueries(QRAW_BASE, provider), [provider]);
    const total = useFirstRowFieldHybrid(Q.kpiTotal, QRAW.kpiTotal, 'count');
    const fwDrops = useFirstRowFieldHybrid(Q.kpiFwDrops, QRAW.kpiFwDrops, 'count');
    const topDropSrc = useFirstRowFieldHybrid(Q.kpiTopDropSrc, QRAW.kpiTopDropSrc, 'display');
    const hosts = useFirstRowFieldHybrid(Q.kpiHosts, QRAW.kpiHosts, 'hosts');

    const sapInstances = useHybridSearch({ cached: Q.sapInstances, raw: QRAW.sapInstances });
    const fwTopSources = useHybridSearch({ cached: Q.fwTopSources, raw: QRAW.fwTopSources });
    const fwTopPorts = useHybridSearch({ cached: Q.fwTopPorts, raw: QRAW.fwTopPorts });
    const oomByHost = useHybridSearch({ cached: Q.oomByHost, raw: QRAW.oomByHost });
    const oomByVictim = useHybridSearch({ cached: Q.oomByVictim, raw: QRAW.oomByVictim });
    const cpuLockups = useHybridSearch({ cached: Q.cpuLockups, raw: QRAW.cpuLockups });

    // Charts / pie take a query string → route once each (sub-hour -> raw).
    const qVolumeByType = useRoutedQuery(Q.volumeByType, QRAW.volumeByType);
    const qSapAppActivity = useRoutedQuery(Q.sapAppActivity, QRAW.sapAppActivity);
    const qFwTimeline = useRoutedQuery(Q.fwTimeline, QRAW.fwTimeline);
    const qKernelEvents = useRoutedQuery(Q.kernelEvents, QRAW.kernelEvents);
    const qTcpOomTimeline = useRoutedQuery(Q.tcpOomTimeline, QRAW.tcpOomTimeline);

    const fwDropsNum = Number(fwDrops.value ?? 0);
    const fwTone = fwDropsNum > 1000 ? 'critical' : fwDropsNum > 0 ? 'warning' : 'neutral';
    const dropSrcTone = topDropSrc.value ? 'critical' : 'neutral';

    /* Drilldowns (build 159 / session 027 task 6). */
    const { timeRange } = useTimeRange();
    const goSapInstanceRow = (row: Record<string, unknown>): void => {
        // SAP Instance row → Host Details (no specific host but useful for SID-level investigation)
        const sid = String(row.sap_sid ?? '');
        if (!sid) return;
        const spl = `\`sap_logserv_idx_macro\` sourcetype="linux_messages_syslog" sap_sid="${splQuote(sid)}" | sort -_time | table _time host sap_app sap_inst`;
        openInNewTab(buildSplunkSearchUrl(spl, timeRange.earliest, timeRange.latest));
    };
    const goFwSrcRow = (row: Record<string, unknown>): void => {
        const ip = String(row.fw_src ?? '');
        if (!ip) return;
        const spl = `\`sap_logserv_idx_macro\` sourcetype="linux_secure" "SRC=${splQuote(ip)}" | sort -_time`;
        openInNewTab(buildSplunkSearchUrl(spl, timeRange.earliest, timeRange.latest));
    };
    const goFwPortRow = (row: Record<string, unknown>): void => {
        const port = String(row.fw_dpt ?? '');
        if (!port) return;
        const spl = `\`sap_logserv_idx_macro\` sourcetype="linux_secure" "DPT=${splQuote(port)}" | sort -_time`;
        openInNewTab(buildSplunkSearchUrl(spl, timeRange.earliest, timeRange.latest));
    };
    const goOomHostRow = (row: Record<string, unknown>): void => {
        const h = String(row.host ?? '');
        if (!h) return;
        openInNewTab(buildHostDetailsUrl(h, timeRange.earliest, timeRange.latest));
    };
    const goOomVictimRow = (row: Record<string, unknown>): void => {
        const p = String(row.oom_proc ?? '');
        if (!p) return;
        const spl = `\`sap_logserv_idx_macro\` sourcetype="linux_messages_syslog" "Killed process" "(${splQuote(p)})" | sort -_time`;
        openInNewTab(buildSplunkSearchUrl(spl, timeRange.earliest, timeRange.latest));
    };
    const goLockupRow = (row: Record<string, unknown>): void => {
        const h = String(row.host ?? '');
        if (!h) return;
        openInNewTab(buildHostDetailsUrl(h, timeRange.earliest, timeRange.latest));
    };

    return (
        <DashboardLayout
            category="PLATFORM"
            title="Linux System & Security"
            subtitle="Linux operational signals — SAP application activity, firewall drops, kernel events, and instance distribution"
        >
            <KpiRow>
                <KpiCard
                    label="Total Events"
                    value={total.value}
                    loading={total.loading}
                    error={total.error}
                    search={total.search}
                    formatValue={formatInteger}
                    sparkline={<SparklineFromQuery query={Q.sparkTotal} valueField="count" fill />}
                />
                <KpiCard
                    label="Firewall Drops"
                    value={fwDrops.value}
                    loading={fwDrops.loading}
                    error={fwDrops.error}
                    search={fwDrops.search}
                    formatValue={formatInteger}
                    tone={fwTone}
                    sparkline={
                        <SparklineFromQuery
                            query={Q.sparkFwDrops}
                            valueField="count"
                            color={logservTheme.colors.red}
                            fill
                        />
                    }
                />
                <KpiCard
                    label="Top Drop Source"
                    value={topDropSrc.value}
                    loading={topDropSrc.loading}
                    error={topDropSrc.error}
                    search={topDropSrc.search}
                    tone={dropSrcTone}
                />
                <KpiCard
                    label="Active Hosts"
                    value={hosts.value}
                    loading={hosts.loading}
                    error={hosts.error}
                    search={hosts.search}
                    formatValue={formatInteger}
                    sparkline={<SparklineFromQuery query={Q.sparkHosts} valueField="hosts" fill />}
                />
            </KpiRow>

            <PanelGrid2>
                <FramedPanel title="Event Volume by Sourcetype" subtitle="Daily count: linux_messages_syslog, syslog, linux_secure">
                    <TimeSeriesChart query={qVolumeByType} height={300} palette="volume" />
                </FramedPanel>
                <FramedPanel title="SAP Application Activity" subtitle="Top 15 sap_app / sap_sid combinations by event volume">
                    <TimeSeriesChart query={qSapAppActivity} height={300} palette="volume" chartType="bar" />
                </FramedPanel>
            </PanelGrid2>

            <PanelGrid3>
                <FramedPanel search={sapInstances} title="SAP Instance Distribution" subtitle="Events and host count by SID / instance / CID — click a row for that SID's full Linux activity">
                    <DataTable
                        columns={SAP_INSTANCE_COLS}
                        rows={sapInstances.results}
                        loading={sapInstances.loading}
                        error={sapInstances.error}
                        emptyMessage="No SAP-tagged Linux events in this time range."
                        onRowClick={goSapInstanceRow}
                    />
                </FramedPanel>
                <FramedPanel title="Firewall Drops Over Time" subtitle="Daily linux_secure event volume">
                    <TimeSeriesChart query={qFwTimeline} height={280} palette="errors" />
                </FramedPanel>
                <FramedPanel title="Kernel Event Types" subtitle="Kernel event categories ranked by count">
                    <PieChart query={qKernelEvents} categoryField="kernel_event" valueField="count" height={280} donut palette="errors" />
                </FramedPanel>
            </PanelGrid3>

            <PanelGrid2>
                <FramedPanel search={fwTopSources} title="Blocked Sources" subtitle="Source IPs ranked by firewall-drop count — click a row for that source's full firewall log">
                    <DataTable
                        columns={FW_SRC_COLS}
                        rows={fwTopSources.results}
                        loading={fwTopSources.loading}
                        error={fwTopSources.error}
                        emptyMessage="No firewall drop events in this time range."
                        pageSize={5}
                        onRowClick={goFwSrcRow}
                    />
                </FramedPanel>
                <FramedPanel search={fwTopPorts} title="Blocked Destination Ports" subtitle="Destination ports being blocked at the firewall, ranked by drop count — click a row for events to that port">
                    <DataTable
                        columns={FW_PORT_COLS}
                        rows={fwTopPorts.results}
                        loading={fwTopPorts.loading}
                        error={fwTopPorts.error}
                        emptyMessage="No firewall drop events in this time range."
                        pageSize={5}
                        onRowClick={goFwPortRow}
                    />
                </FramedPanel>
            </PanelGrid2>

            <PanelGrid2>
                <FramedPanel search={oomByHost} title="OOM Kills by Host" subtitle="Kernel OOM-killer events grouped by host, with victim processes and max RSS/VM observed — click a row to drill into Host Details">
                    <DataTable
                        columns={OOM_HOST_COLS}
                        rows={oomByHost.results}
                        loading={oomByHost.loading}
                        error={oomByHost.error}
                        emptyMessage="No OOM-killer events in this time range."
                        pageSize={5}
                        onRowClick={goOomHostRow}
                    />
                </FramedPanel>
                <FramedPanel search={oomByVictim} title="OOM Kills by Victim Process" subtitle="Process names targeted by the OOM killer with affected host count and max RSS — click a row for that process's full kill log">
                    <DataTable
                        columns={OOM_VICTIM_COLS}
                        rows={oomByVictim.results}
                        loading={oomByVictim.loading}
                        error={oomByVictim.error}
                        emptyMessage="No OOM-killer events in this time range."
                        pageSize={5}
                        onRowClick={goOomVictimRow}
                    />
                </FramedPanel>
            </PanelGrid2>

            <PanelGrid2>
                <FramedPanel search={cpuLockups} title="CPU Soft-Lockups" subtitle="NMI watchdog detections of stuck kernel-space CPUs — signals VM overcommit, hypervisor starvation, or noisy-neighbor; click a row to drill into Host Details">
                    <DataTable
                        columns={CPU_LOCKUP_COLS}
                        rows={cpuLockups.results}
                        loading={cpuLockups.loading}
                        error={cpuLockups.error}
                        emptyMessage="No CPU soft-lockup events in this time range."
                        pageSize={5}
                        onRowClick={goLockupRow}
                    />
                </FramedPanel>
                <FramedPanel title="TCP Memory Pressure Over Time" subtitle="Daily count of TCP socket-buffer exhaustion warnings, by host — sustained activity suggests tcp_mem tuning needed">
                    <TimeSeriesChart query={qTcpOomTimeline} height={280} palette="errors" chartType="line" />
                </FramedPanel>
            </PanelGrid2>
        </DashboardLayout>
    );
};

export default Linux;
