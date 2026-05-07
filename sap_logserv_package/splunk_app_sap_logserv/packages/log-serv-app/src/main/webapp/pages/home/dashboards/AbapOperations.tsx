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
import { buildDashboardUrl, buildSplunkSearchUrl, openInNewTab, splQuote } from '../utils/drilldownUrls';
import { logservTheme } from '../styles/logservTheme';

/**
 * ABAP Operations — honest port of v0.0.4.2 logserv_abap_operations.xml.
 * 10 panels: 3 KPIs + 3 timecharts + 4 tables.
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

const FILTER = 'sourcetype IN ("sap:abap:dispatcher", "sap:abap:enqueueserver", "sap:abap:event", "sap:abap:messageserver", "sap:abap:sapstartsrv", "sap:abap:workprocess")';

const Q = {
    kpiTotal: `\`sap_logserv_idx_macro\` ${FILTER} | stats count`,
    kpiSids: `\`sap_logserv_idx_macro\` ${FILTER} | stats dc(sap_sid) as sids`,
    kpiWpErrors: `\`sap_logserv_idx_macro\` sourcetype="sap:abap:dispatcher" (dp_severity="ERROR" OR dp_severity="FATAL") | stats count`,

    sparkTotal: `\`sap_logserv_idx_macro\` ${FILTER} | timechart span=1d count`,
    sparkSids: `\`sap_logserv_idx_macro\` ${FILTER} | timechart span=1d dc(sap_sid) as sids`,
    sparkWpErrors: `\`sap_logserv_idx_macro\` sourcetype="sap:abap:dispatcher" (dp_severity="ERROR" OR dp_severity="FATAL") | timechart span=1d count`,

    volumeByType: `\`sap_logserv_idx_macro\` ${FILTER} | timechart span=1d count by sourcetype`,
    dispatcherSeverity: `\`sap_logserv_idx_macro\` sourcetype="sap:abap:dispatcher" dp_severity=* | timechart span=1d count by dp_severity`,
    enqueueTimeline: `\`sap_logserv_idx_macro\` sourcetype="sap:abap:enqueueserver" | timechart span=1d count as "Lock Operations"`,

    uptime: `\`sap_logserv_idx_macro\` sourcetype="sap:abap:event" uptime_days=* | stats latest(uptime_days) as uptime_days latest(uptime_hours) as uptime_hours by sap_sid sap_instance | sort sap_sid sap_instance`,
    wpCategories: `\`sap_logserv_idx_macro\` sourcetype="sap:abap:workprocess" wp_category_name=* | stats count by wp_category_name | sort -count`,
    wpFunctions: `\`sap_logserv_idx_macro\` sourcetype="sap:abap:workprocess" wp_function=* | stats count as Events by wp_function wp_sub_function | sort -Events`,
    sidInstance: `\`sap_logserv_idx_macro\` ${FILTER} | stats count by sap_sid sourcetype | sort -count`,
};

interface FirstRow { value: unknown; loading: boolean; error: Error | null; }
const useFirstRowField = (q: string, f: string): FirstRow => {
    const { results, loading, error } = useSearch({ query: q });
    const value = results && results[0] ? (results[0] as Record<string, unknown>)[f] : undefined;
    return { value, loading, error };
};

const UPTIME_COLS: ColumnDef[] = [
    { key: 'sap_sid', label: 'SID' },
    { key: 'sap_instance', label: 'Instance' },
    { key: 'uptime_days', label: 'Uptime (Days)', align: 'right' },
    { key: 'uptime_hours', label: 'Uptime (Hours)', align: 'right' },
];
const FUNCTION_COLS: ColumnDef[] = [
    { key: 'wp_function', label: 'Function' },
    { key: 'wp_sub_function', label: 'Sub-Function' },
    { key: 'Events', label: 'Events', align: 'right', render: (v) => formatInteger(v) },
];
const SID_COLS: ColumnDef[] = [
    { key: 'sap_sid', label: 'SID' },
    { key: 'sourcetype', label: 'Sourcetype' },
    { key: 'count', label: 'Events', align: 'right', render: (v) => formatInteger(v) },
];

const AbapOperations: React.FC = () => {
    const total = useFirstRowField(Q.kpiTotal, 'count');
    const sids = useFirstRowField(Q.kpiSids, 'sids');
    const wpErrors = useFirstRowField(Q.kpiWpErrors, 'count');

    const uptime = useSearch({ query: Q.uptime });
    const wpFunctions = useSearch({ query: Q.wpFunctions });
    const sidInstance = useSearch({ query: Q.sidInstance });

    const wpErrorsTone = Number(wpErrors.value ?? 0) > 0 ? 'critical' : 'neutral';

    /* Drilldowns (build 159 / session 027 task 6). */
    const { timeRange } = useTimeRange();
    const goWpPerformance = (): void => {
        openInNewTab(buildDashboardUrl('work-process-performance', timeRange.earliest, timeRange.latest));
    };
    const goUptimeRow = (): void => {
        // Click row → Work Process Performance for the SID-level drill-down.
        openInNewTab(buildDashboardUrl('work-process-performance', timeRange.earliest, timeRange.latest));
    };
    const goSidActivityRow = (row: Record<string, unknown>): void => {
        const sid = String(row.sap_sid ?? '');
        const st = String(row.sourcetype ?? '');
        if (!sid && !st) return;
        const sidClause = sid ? ` sap_sid="${splQuote(sid)}"` : '';
        const stClause = st ? ` sourcetype="${splQuote(st)}"` : '';
        const spl = `\`sap_logserv_idx_macro\`${stClause}${sidClause} | sort -_time`;
        openInNewTab(buildSplunkSearchUrl(spl, timeRange.earliest, timeRange.latest));
    };

    return (
        <DashboardLayout
            category="APPLICATIONS"
            title="ABAP Operations"
            subtitle="Operational health of SAP ABAP application layer — work processes, dispatcher, enqueue, and instance activity"
        >
            <KpiRow>
                <KpiCard label="Total Events" value={total.value} loading={total.loading} error={total.error} formatValue={formatInteger}
                    sparkline={<SparklineFromQuery query={Q.sparkTotal} valueField="count" fill />} />
                <KpiCard label="Active SIDs" value={sids.value} loading={sids.loading} error={sids.error} formatValue={formatInteger}
                    sparkline={<SparklineFromQuery query={Q.sparkSids} valueField="sids" fill />} />
                <KpiCard label="Dispatcher Errors" value={wpErrors.value} loading={wpErrors.loading} error={wpErrors.error} formatValue={formatInteger} tone={wpErrorsTone}
                    sparkline={<SparklineFromQuery query={Q.sparkWpErrors} valueField="count" color={logservTheme.colors.red} fill />} />
            </KpiRow>

            <FullWidthPanel>
                <FramedPanel title="Event Volume by Sourcetype" subtitle="Daily volume across the 6 ABAP runtime sourcetypes">
                    <TimeSeriesChart query={Q.volumeByType} height={280} palette="volume" />
                </FramedPanel>
            </FullWidthPanel>

            <PanelGrid2>
                <FramedPanel title="Dispatcher Severity Over Time" subtitle="Daily dp_severity breakdown — click to open Work Process Performance"
                    onClick={goWpPerformance} clickTitle="Open Work Process Performance dashboard">
                    <TimeSeriesChart query={Q.dispatcherSeverity} height={260} palette="status" />
                </FramedPanel>
                <FramedPanel title="Enqueue Lock Activity" subtitle="Daily lock operation count">
                    <TimeSeriesChart query={Q.enqueueTimeline} height={260} palette="volume" />
                </FramedPanel>
            </PanelGrid2>

            <FullWidthPanel>
                <FramedPanel title="System Uptime (Latest)" subtitle="Latest reported uptime per SID + instance — click a row to open Work Process Performance">
                    <DataTable columns={UPTIME_COLS} rows={uptime.results} loading={uptime.loading} error={uptime.error} emptyMessage="No ABAP event uptime data in this time range." initialSortKey="sap_sid" initialSortDir="asc" onRowClick={goUptimeRow} />
                </FramedPanel>
            </FullWidthPanel>

            <PanelGrid2>
                <FramedPanel title="Work Process Categories" subtitle="Share of events by wp_category_name">
                    <PieChart query={Q.wpCategories} categoryField="wp_category_name" valueField="count" height={320} donut palette="volume" />
                </FramedPanel>
                <FramedPanel title="Work Process Functions" subtitle="wp_function + sub-function combinations ranked by volume">
                    <DataTable columns={FUNCTION_COLS} rows={wpFunctions.results} loading={wpFunctions.loading} error={wpFunctions.error} emptyMessage="No work-process events in this time range." />
                </FramedPanel>
            </PanelGrid2>

            <FullWidthPanel>
                <FramedPanel title="Activity by SID / Sourcetype" subtitle="SID × sourcetype combinations ranked by event volume — click a row for the raw events">
                    <DataTable columns={SID_COLS} rows={sidInstance.results} loading={sidInstance.loading} error={sidInstance.error} emptyMessage="No ABAP runtime events in this time range." onRowClick={goSidActivityRow} />
                </FramedPanel>
            </FullWidthPanel>
        </DashboardLayout>
    );
};

export default AbapOperations;
