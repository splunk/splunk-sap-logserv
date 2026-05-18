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

// Path B (build 145): cron/warn/sudolog/slapd events were previously routed
// to sourcetype=syslog; new events go to dedicated linux:cron / linux:warn /
// linux:sudolog / linux:slapd sourcetypes. The "syslog" entry stays in this
// OR clause so historical events ingested before the migration remain visible.
const ST_ALL = '(sourcetype="linux_messages_syslog" OR sourcetype="linux:cron" OR sourcetype="linux:warn" OR sourcetype="linux:sudolog" OR sourcetype="linux:slapd" OR sourcetype="syslog" OR sourcetype="linux_secure")';

const Q = {
    // KPIs
    kpiTotal: `\`sap_logserv_idx_macro\` ${ST_ALL} | stats count`,
    kpiFwDrops: `\`sap_logserv_idx_macro\` sourcetype="linux_secure" | rex field=_raw "(?<fw_action>IN_DROP|IN_ACCEPT)" | where fw_action="IN_DROP" | stats count`,
    kpiTopDropSrc: `\`sap_logserv_idx_macro\` sourcetype="linux_secure" | rex field=_raw "SRC=(?<fw_src>[^ ]+)" | where isnotnull(fw_src) AND fw_src!="" | stats count as drops by fw_src | sort -drops | head 1 | eval display = fw_src . " (" . tostring(drops, "commas") . ")" | table display`,
    kpiHosts: `\`sap_logserv_idx_macro\` ${ST_ALL} | stats dc(host) as hosts`,

    // Sparklines
    sparkTotal: `\`sap_logserv_idx_macro\` ${ST_ALL} | timechart span=1d count`,
    sparkFwDrops: `\`sap_logserv_idx_macro\` sourcetype="linux_secure" | rex field=_raw "(?<fw_action>IN_DROP|IN_ACCEPT)" | where fw_action="IN_DROP" | timechart span=1d count`,
    sparkHosts: `\`sap_logserv_idx_macro\` ${ST_ALL} | timechart span=1d dc(host) AS hosts`,

    // Charts
    volumeByType: `\`sap_logserv_idx_macro\` ${ST_ALL} | timechart span=1d count by sourcetype`,
    sapAppActivity: `\`sap_logserv_idx_macro\` sourcetype="linux_messages_syslog" sap_app=* | stats count by sap_app sap_sid | sort -count`,
    fwTimeline: `\`sap_logserv_idx_macro\` sourcetype="linux_secure" | timechart span=1d count AS "Firewall Events"`,
    kernelEvents: `\`sap_logserv_idx_macro\` sourcetype="linux_secure" | rex field=_raw "kernel:.*?\\]\\s+(?<kernel_event>[A-Z_]+)" | where isnotnull(kernel_event) | stats count by kernel_event | sort -count`,

    // Tables
    sapInstances: `\`sap_logserv_idx_macro\` sourcetype="linux_messages_syslog" sap_sid=* | stats count as Events dc(host) as Hosts by sap_sid, sap_inst, sap_cid | sort -Events`,
    fwTopSources: `\`sap_logserv_idx_macro\` sourcetype="linux_secure" | rex field=_raw "SRC=(?<fw_src>[^ ]+)" | rex field=_raw "DST=(?<fw_dst>[^ ]+)" | rex field=_raw "PROTO=(?<fw_proto>[^ ]+)" | where isnotnull(fw_src) | stats count as Drops dc(fw_dst) as Targets values(fw_proto) as Protocol by fw_src | sort -Drops`,
    fwTopPorts: `\`sap_logserv_idx_macro\` sourcetype="linux_secure" | rex field=_raw "DPT=(?<fw_dpt>[^ ]+)" | rex field=_raw "PROTO=(?<fw_proto>[^ ]+)" | where isnotnull(fw_dpt) | stats count as Drops dc(host) as Hosts by fw_dpt, fw_proto | sort -Drops`,

    // Resource Pressure (build 186 / session 034 deep-dive). Kernel OOM/lockup/
    // tcp-mem events live on (linux:warn) for current data + (syslog) for legacy
    // pre-Path-B-migration data; both stanzas carry the same EXTRACTs in props.conf
    // so the structured fields populate uniformly.
    oomByHost: `\`sap_logserv_idx_macro\` (sourcetype="linux:warn" OR sourcetype="syslog") "Out of memory: Killed process" | stats count AS Kills, values(oom_proc) AS Victims, max(oom_rss_kb) AS MaxRssKb, max(oom_vm_kb) AS MaxVmKb by host | eval "Max RSS (MB)" = round(MaxRssKb / 1024, 0) | eval "Max VM (MB)" = round(MaxVmKb / 1024, 0) | fields - MaxRssKb, MaxVmKb | sort -Kills`,
    oomByVictim: `\`sap_logserv_idx_macro\` (sourcetype="linux:warn" OR sourcetype="syslog") "Out of memory: Killed process" oom_proc=* | stats count AS Kills, dc(host) AS Hosts, max(oom_rss_kb) AS MaxRssKb by oom_proc | eval "Max RSS (MB)" = round(MaxRssKb / 1024, 0) | fields - MaxRssKb | sort -Kills`,
    cpuLockups: `\`sap_logserv_idx_macro\` (sourcetype="linux:warn" OR sourcetype="syslog") "soft lockup" | stats count AS Lockups, dc(lockup_cpu) AS "CPUs", max(lockup_duration_s) AS "Max (sec)", avg(lockup_duration_s) AS avg_s by host | eval "Avg (sec)" = round(avg_s, 1) | fields - avg_s | sort -Lockups`,
    tcpOomTimeline: `\`sap_logserv_idx_macro\` (sourcetype="linux:warn" OR sourcetype="syslog") "TCP: out of memory" | timechart span=1d count by host`,
};

interface FirstRow { value: unknown; loading: boolean; error: Error | null; }
const useFirstRowField = (q: string, f: string): FirstRow => {
    const { results, loading, error } = useSearch({ query: q });
    const value = results && results[0] ? (results[0] as Record<string, unknown>)[f] : undefined;
    return { value, loading, error };
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
    const total = useFirstRowField(Q.kpiTotal, 'count');
    const fwDrops = useFirstRowField(Q.kpiFwDrops, 'count');
    const topDropSrc = useFirstRowField(Q.kpiTopDropSrc, 'display');
    const hosts = useFirstRowField(Q.kpiHosts, 'hosts');

    const sapInstances = useSearch({ query: Q.sapInstances });
    const fwTopSources = useSearch({ query: Q.fwTopSources });
    const fwTopPorts = useSearch({ query: Q.fwTopPorts });
    const oomByHost = useSearch({ query: Q.oomByHost });
    const oomByVictim = useSearch({ query: Q.oomByVictim });
    const cpuLockups = useSearch({ query: Q.cpuLockups });

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
                    formatValue={formatInteger}
                    sparkline={<SparklineFromQuery query={Q.sparkTotal} valueField="count" fill />}
                />
                <KpiCard
                    label="Firewall Drops"
                    value={fwDrops.value}
                    loading={fwDrops.loading}
                    error={fwDrops.error}
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
                    tone={dropSrcTone}
                />
                <KpiCard
                    label="Active Hosts"
                    value={hosts.value}
                    loading={hosts.loading}
                    error={hosts.error}
                    formatValue={formatInteger}
                    sparkline={<SparklineFromQuery query={Q.sparkHosts} valueField="hosts" fill />}
                />
            </KpiRow>

            <PanelGrid2>
                <FramedPanel title="Event Volume by Sourcetype" subtitle="Daily count: linux_messages_syslog, syslog, linux_secure">
                    <TimeSeriesChart query={Q.volumeByType} height={300} palette="volume" />
                </FramedPanel>
                <FramedPanel title="SAP Application Activity" subtitle="sap_app + sap_sid combinations ranked by event volume">
                    <TimeSeriesChart query={Q.sapAppActivity} height={300} palette="volume" />
                </FramedPanel>
            </PanelGrid2>

            <PanelGrid3>
                <FramedPanel title="SAP Instance Distribution" subtitle="Events and host count by SID / instance / CID — click a row for that SID's full Linux activity">
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
                    <TimeSeriesChart query={Q.fwTimeline} height={280} palette="errors" />
                </FramedPanel>
                <FramedPanel title="Kernel Event Types" subtitle="Kernel event categories ranked by count">
                    <PieChart query={Q.kernelEvents} categoryField="kernel_event" valueField="count" height={280} donut palette="errors" />
                </FramedPanel>
            </PanelGrid3>

            <PanelGrid2>
                <FramedPanel title="Blocked Sources" subtitle="Source IPs ranked by firewall-drop count — click a row for that source's full firewall log">
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
                <FramedPanel title="Blocked Destination Ports" subtitle="Destination ports being blocked at the firewall, ranked by drop count — click a row for events to that port">
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
                <FramedPanel title="OOM Kills by Host" subtitle="Kernel OOM-killer events grouped by host, with victim processes and max RSS/VM observed — click a row to drill into Host Details">
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
                <FramedPanel title="OOM Kills by Victim Process" subtitle="Process names targeted by the OOM killer with affected host count and max RSS — click a row for that process's full kill log">
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
                <FramedPanel title="CPU Soft-Lockups" subtitle="NMI watchdog detections of stuck kernel-space CPUs — signals VM overcommit, hypervisor starvation, or noisy-neighbor; click a row to drill into Host Details">
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
                    <TimeSeriesChart query={Q.tcpOomTimeline} height={280} palette="errors" chartType="line" />
                </FramedPanel>
            </PanelGrid2>
        </DashboardLayout>
    );
};

export default Linux;
