import React, { useEffect, useMemo, useRef, useState } from 'react';
import styled from 'styled-components';
import Select from '@splunk/react-ui/Select';
import Multiselect from '@splunk/react-ui/Multiselect';
import LinkGraph from '@splunk/visualizations/LinkGraph';
import KpiCard, { formatInteger } from '../components/KpiCard';
import FramedPanel from '../components/FramedPanel';
import DataTable, { ColumnDef } from '../components/DataTable';
import TimeSeriesChart from '../components/TimeSeriesChart';
import TabbedLayout from '../components/TabbedLayout';
import { SparklineFromQuery } from '../components/Sparkline';
import DashboardLayout from '../components/DashboardLayout';
import { useSearch } from '../hooks/useSearch';
import { useTimeRange } from '../state/TimeRangeProvider';
import { chooseTimechartSpan } from '../utils/timechartSpan';
import { buildHostDetailsUrl, buildSplunkSearchUrl, openInNewTab, splQuote } from '../utils/drilldownUrls';
import { logservTheme } from '../styles/logservTheme';

/** Top-N choices for the host-filter Top-N picker. `all` resolves to "no
 *  host limit". Numeric values become a `[search ...| top N host | fields
 *  host]` subsearch in the SPL builder. The picker is disabled in the UI
 *  when one or more specific hosts are selected via the Multiselect. */
const TOP_N_CHOICES: Array<{ value: string; label: string }> = [
    { value: 'all', label: 'All hosts' },
    { value: '5', label: 'Top 5' },
    { value: '10', label: 'Top 10' },
    { value: '20', label: 'Top 20' },
    { value: '50', label: 'Top 50' },
];

/**
 * Build the SPL search-filter fragment that combines explicit host selection
 * + Top-N picker, used by every SPL on this dashboard. Identical pattern to
 * HostDetails' `combinedHostFilter` (build 161). Spliced as
 * `\`sap_logserv_idx_macro\` ${HOST_FILTER} | …`.
 *
 *  - 1 host selected            → `host="X"`
 *  - 2+ hosts selected          → `host IN ("X","Y","Z")`
 *  - 0 selected + topN === 'all'→ ''                   (no host filter)
 *  - 0 selected + topN === 'N'  → `[search …| top N host | fields host] `
 */
const splEscapeHost = (h: string): string => h.replace(/"/g, '\\"');
const combinedHostFilter = (selectedHosts: string[], topN: string): string => {
    if (selectedHosts.length === 1) return `host="${splEscapeHost(selectedHosts[0])}"`;
    if (selectedHosts.length > 1) {
        return `host IN (${selectedHosts.map((h) => `"${splEscapeHost(h)}"`).join(',')})`;
    }
    if (topN === 'all') return '';
    return `[search \`sap_logserv_idx_macro\` | top limit=${topN} host | fields host] `;
};

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
const PanelGrid = styled.div`
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: ${logservTheme.elevation.panelGap};
    @media (max-width: 1100px) { grid-template-columns: 1fr; }
`;

/** Inline-aligned controls that fit naturally in a FramedPanel `actions` slot. */
const PanelControls = styled.div`
    display: inline-flex;
    align-items: center;
    gap: ${logservTheme.spacing.sm};
`;

// Wrapper around Splunk's LinkGraph that suppresses every horizontal
// scrollbar inside the viz. Splunk renders an `overflow: auto` div around
// its 3-column body (class hash currently `.cDbQQq`); even with our outer
// container using `overflow-x: hidden`, that inner element still draws
// its own scrollbar. Cascading `overflow-x: hidden !important` to every
// descendant kills it while leaving vertical scrolling intact.
const LinkGraphContainer = styled.div<{ $height: number }>`
    width: 100%;
    height: ${(p) => p.$height}px;
    overflow-x: hidden;

    & * {
        overflow-x: hidden !important;
    }
`;

/**
 * Build the dashboard-wide query set, parameterized by the host-filter
 * fragment. Build 162 / session 028: the filter is now applied to every SPL
 * on the dashboard, not just the Events-by-Host chart panel — so the KPIs,
 * Sourcetype Summary, Host Latest Activity, and Linked Graph all narrow
 * with the picker.
 *
 * The `HOST` fragment is spliced after the index macro and before any other
 * search clause; an empty string means "no filter, all hosts". The `eventsByHost`
 * SPL is still built ad-hoc inside OverviewTab so it can pick up the dynamic
 * timechart span.
 */
const buildQueries = (HOST: string) => ({
    totalEvents: `\`sap_logserv_idx_macro\` ${HOST} | stats count`,
    activeHosts: `\`sap_logserv_idx_macro\` ${HOST} | stats dc(host) AS hosts`,
    activeSourcetypes: `\`sap_logserv_idx_macro\` ${HOST} | stats dc(sourcetype) AS st`,
    eventsPerDay: `\`sap_logserv_idx_macro\` ${HOST} | stats count by date_mday | stats avg(count) AS perday`,

    sparkTotal: `\`sap_logserv_idx_macro\` ${HOST} | timechart span=1d count`,
    sparkHosts: `\`sap_logserv_idx_macro\` ${HOST} | timechart span=1d dc(host) AS hosts`,
    sparkSt: `\`sap_logserv_idx_macro\` ${HOST} | timechart span=1d dc(sourcetype) AS st`,
    sparkPerday: `\`sap_logserv_idx_macro\` ${HOST} | timechart span=1d count`,

    // eventsByHost is built dynamically inside OverviewTab so the timechart
    // span tracks the user's selected time range (avoids 700+ point bars).

    sourcetypeSummary: `\`sap_logserv_idx_macro\` ${HOST} | stats count, dc(host) AS hosts, latest(_time) AS last_seen by sourcetype | sort - count | eval last_seen=strftime(last_seen, "%Y-%m-%d %H:%M:%S")`,
    hostLatestActivity: `\`sap_logserv_idx_macro\` ${HOST} | stats count, dc(sourcetype) AS sts, latest(_time) AS last_seen by host | sort - last_seen | eval last_seen=strftime(last_seen, "%Y-%m-%d %H:%M:%S")`,

    // Linked graph: 3-column flow sourcetype → source → host (verbatim from
    // v0.0.4.2 logserv_overview.xml `ds_qvNrhKle`). The implicit count (no
    // comma after `sourcetype`) is intentional — Splunk treats it as
    // `stats count by sourcetype, source, host`. The trailing
    // `| fields - count` drops the count column so the link graph renders
    // pure entity-to-entity-to-entity edges.
    linkGraph: `\`sap_logserv_idx_macro\` ${HOST} | fields source, sourcetype, host | dedup host, source, sourcetype | stats count by sourcetype source, host | fields - count`,
});

interface FirstRow { value: unknown; loading: boolean; error: Error | null; }
const useFirstRowField = (q: string, f: string): FirstRow => {
    const { results, loading, error } = useSearch({ query: q });
    const value = results && results[0] ? (results[0] as Record<string, unknown>)[f] : undefined;
    return { value, loading, error };
};

const SOURCETYPE_COLS: ColumnDef[] = [
    { key: 'sourcetype', label: 'Sourcetype' },
    { key: 'count', label: 'Events', align: 'right', render: (v) => formatInteger(v) },
    { key: 'hosts', label: 'Hosts', align: 'right', render: (v) => formatInteger(v) },
    { key: 'last_seen', label: 'Last Seen', width: '200px' },
];

const HOST_COLS: ColumnDef[] = [
    { key: 'host', label: 'Host' },
    { key: 'count', label: 'Events', align: 'right', render: (v) => formatInteger(v) },
    { key: 'sts', label: 'Sourcetypes', align: 'right', render: (v) => formatInteger(v) },
    { key: 'last_seen', label: 'Last Seen', width: '200px' },
];

interface TabProps {
    /** Hosts the user has explicitly picked via the title-row Multiselect.
     *  Empty array means "no specific pick — fall back to Top-N". */
    selectedHosts: string[];
    /** Top-N value: `'all'` or a numeric string. Ignored when `selectedHosts`
     *  is non-empty (the explicit pick is the more constrained intent). */
    topN: string;
    /** Total host count at the dashboard scope — used in the chart subtitle's
     *  "N of M selected" / "All hosts (M)" wording so the user can see the
     *  size of the universe even after filtering. */
    totalHostCount: number;
}

const OverviewTab: React.FC<TabProps> = ({ selectedHosts, topN, totalHostCount }) => {
    // HOST is the build-162 filter fragment shared with every SPL on this
    // tab. When the user picks specific hosts via the title-row picker, this
    // becomes `host="X"` or `host IN (...)`; with no specific pick it falls
    // back to the Top-N subsearch (or no filter when topN === 'all').
    const HOST = useMemo(() => combinedHostFilter(selectedHosts, topN), [selectedHosts, topN]);
    const Q = useMemo(() => buildQueries(HOST), [HOST]);

    const total = useFirstRowField(Q.totalEvents, 'count');
    const hosts = useFirstRowField(Q.activeHosts, 'hosts');
    const sts = useFirstRowField(Q.activeSourcetypes, 'st');
    const perDay = useFirstRowField(Q.eventsPerDay, 'perday');

    // Dynamic timechart span keeps the per-host line chart readable across
    // any selected time range (a hard-coded `span=1h` produces 700+ pts on
    // a 30-day window).
    const { timeRange } = useTimeRange();
    const span = useMemo(
        () => chooseTimechartSpan(timeRange.earliest, timeRange.latest),
        [timeRange.earliest, timeRange.latest],
    );

    // Compose the per-host chart query using the same filter fragment as the
    // rest of the dashboard. The chart's `limit=N` honors the Top-N picker
    // when no specific hosts are selected; otherwise `limit=0` (all selected
    // hosts get a series) since the explicit pick is the more constrained
    // intent.
    const eventsByHostQuery = useMemo(() => {
        const hasHostPick = selectedHosts.length > 0;
        const limitVal = hasHostPick ? '0' : (topN === 'all' ? '0' : topN);
        return `\`sap_logserv_idx_macro\` ${HOST} | timechart span=${span} count by host limit=${limitVal} useother=false`;
    }, [span, topN, selectedHosts, HOST]);

    const chartSubtitle = useMemo<string>(() => {
        if (selectedHosts.length > 0) {
            return `${selectedHosts.length} of ${totalHostCount} hosts selected — span ${span}`;
        }
        if (topN === 'all') {
            return `All hosts (${totalHostCount}) by event count — span ${span}`;
        }
        return `Top ${topN} hosts by event count — span ${span}`;
    }, [span, topN, selectedHosts, totalHostCount]);

    const sourcetypeSummary = useSearch({ query: Q.sourcetypeSummary });
    const hostLatest = useSearch({ query: Q.hostLatestActivity });

    /* Drilldowns (build 159 / session 027 task 6).
     * - Sourcetype Summary row → Splunk Search filtered to sourcetype.
     * - Host Latest Activity row → Host Details with ?host=<row.host>. */
    const goSourcetypeRow = (row: Record<string, unknown>): void => {
        const st = String(row.sourcetype ?? '');
        if (!st) return;
        const spl = `\`sap_logserv_idx_macro\` sourcetype="${splQuote(st)}" | sort -_time`;
        openInNewTab(buildSplunkSearchUrl(spl, timeRange.earliest, timeRange.latest));
    };
    const goHostRow = (row: Record<string, unknown>): void => {
        const host = String(row.host ?? '');
        if (!host) return;
        openInNewTab(buildHostDetailsUrl(host, timeRange.earliest, timeRange.latest));
    };

    return (
        <>
            <KpiRow>
                <KpiCard label="Total Events" value={total.value} loading={total.loading} error={total.error} formatValue={formatInteger}
                    sparkline={<SparklineFromQuery query={Q.sparkTotal} valueField="count" fill />} />
                <KpiCard label="Active Hosts" value={hosts.value} loading={hosts.loading} error={hosts.error} formatValue={formatInteger}
                    sparkline={<SparklineFromQuery query={Q.sparkHosts} valueField="hosts" fill />} />
                <KpiCard label="Active Sourcetypes" value={sts.value} loading={sts.loading} error={sts.error} formatValue={formatInteger}
                    sparkline={<SparklineFromQuery query={Q.sparkSt} valueField="st" fill />} />
                <KpiCard label="Events / Day (Avg)" value={perDay.value} loading={perDay.loading} error={perDay.error} formatValue={formatInteger}
                    sparkline={<SparklineFromQuery query={Q.sparkPerday} valueField="count" fill />} />
            </KpiRow>
            <FullWidthPanel>
                <FramedPanel title="Events Over Time by Host" subtitle={chartSubtitle}>
                    <TimeSeriesChart
                        query={eventsByHostQuery}
                        height={300}
                        chartType="line"
                        palette="categorical"
                    />
                </FramedPanel>
            </FullWidthPanel>
            <PanelGrid>
                <FramedPanel title="Sourcetype Summary" subtitle="Per-sourcetype event count, distinct hosts, freshness — click a row for that sourcetype's full event log">
                    <DataTable columns={SOURCETYPE_COLS} rows={sourcetypeSummary.results} loading={sourcetypeSummary.loading} error={sourcetypeSummary.error} emptyMessage="No data in this time range." onRowClick={goSourcetypeRow} />
                </FramedPanel>
                <FramedPanel title="Host Latest Activity" subtitle="Most-recently-active hosts — click a row to open Host Details">
                    <DataTable columns={HOST_COLS} rows={hostLatest.results} loading={hostLatest.loading} error={hostLatest.error} emptyMessage="No data in this time range." onRowClick={goHostRow} />
                </FramedPanel>
            </PanelGrid>
        </>
    );
};

interface LinkGraphResult {
    sourcetype?: string;
    source?: string;
    host?: string;
}

/** Canvas height for the link graph — matches v0.0.4.2 layout_2 (~3260 px),
 *  large enough that the tallest column (typically `host`) can render every
 *  row without the viz's internal scrollbar appearing. */
const LINK_GRAPH_HEIGHT = 3260;

/** Horizontal spacing between the three columns. Stays at v0.0.4.2's value. */
const LINK_GRAPH_NODE_SPACING_X = 100;

/** Pixels reserved beyond `3*nodeWidth + 2*spacing` so we never trigger
 *  the LinkGraph's internal horizontal scrollbar. Empirically tuned —
 *  Splunk's LinkGraph adds substantial inner padding around each node
 *  (~70-80 px per column) on top of the `nodeWidth` value we pass, so a
 *  small reservation isn't enough. The container also has `overflow-x:
 *  hidden` as a hard guarantee that no scrollbar can ever appear even if
 *  this estimate undershoots. */
const LINK_GRAPH_WIDTH_SAFETY_MARGIN = 280;

/** Fallback nodeWidth used on the very first render before the
 *  ResizeObserver fires. Sized for a typical 1920 px viewport. */
const LINK_GRAPH_NODE_WIDTH_FALLBACK = 540;

const LinkedGraphTab: React.FC<TabProps> = ({ selectedHosts, topN }) => {
    // Apply the same dashboard-wide host filter to the linked graph SPL —
    // build 162 makes the picker affect every panel on this dashboard, on
    // both tabs.
    const HOST = useMemo(() => combinedHostFilter(selectedHosts, topN), [selectedHosts, topN]);
    const Q = useMemo(() => buildQueries(HOST), [HOST]);

    // count: 0 = "all rows" — the link graph needs every unique
    // sourcetype/source/host combination, which can easily exceed the
    // default 100-row cap and silently drop hosts.
    const { results, loading, error } = useSearch<LinkGraphResult>({
        query: Q.linkGraph,
        count: 0,
    });

    // Measure the container width and compute nodeWidth dynamically so the
    // three columns + their two gaps fit exactly inside the panel — no
    // horizontal scrollbar, no wasted whitespace.
    const containerRef = useRef<HTMLDivElement>(null);
    const [nodeWidth, setNodeWidth] = useState<number>(LINK_GRAPH_NODE_WIDTH_FALLBACK);

    useEffect(() => {
        const el = containerRef.current;
        if (!el) return undefined;

        const compute = (cw: number): number => {
            // 3N + 2 * spacing + safety <= cw  →  N <= (cw - 2*spacing - safety) / 3
            const raw = Math.floor(
                (cw - 2 * LINK_GRAPH_NODE_SPACING_X - LINK_GRAPH_WIDTH_SAFETY_MARGIN) / 3
            );
            // Empirical 10% shrink — Splunk's LinkGraph still renders wider
            // than the math suggests, so bias toward "definitely narrower
            // than container" rather than "exactly fits".
            const n = Math.floor(raw * 0.9);
            return Math.max(180, n); // never go absurdly narrow
        };

        const observer = new ResizeObserver((entries) => {
            const cw = entries[0]?.contentRect.width;
            if (typeof cw === 'number' && cw > 0) {
                setNodeWidth((prev) => {
                    const next = compute(cw);
                    return next === prev ? prev : next;
                });
            }
        });
        observer.observe(el);
        // Initial sync
        const initial = compute(el.getBoundingClientRect().width);
        if (initial > 0) setNodeWidth(initial);

        return () => observer.disconnect();
    }, []);

    const dataSources = useMemo(() => {
        if (!results || results.length === 0) return null;
        const sourcetypeCol = results.map((r) => String(r.sourcetype ?? ''));
        const sourceCol = results.map((r) => String(r.source ?? ''));
        const hostCol = results.map((r) => String(r.host ?? ''));
        return {
            primary: {
                data: {
                    fields: [{ name: 'sourcetype' }, { name: 'source' }, { name: 'host' }],
                    columns: [sourcetypeCol, sourceCol, hostCol],
                },
                meta: { totalCount: results.length, sid: '', app: '' },
                requestParams: { count: results.length, offset: 0 },
            },
        };
    }, [results]);

    if (error) return <div style={{ padding: 32, color: logservTheme.colors.red }}>{error.message || 'Search failed'}</div>;
    if (loading && !dataSources) return <div style={{ padding: 32, color: logservTheme.colors.textMuted, textAlign: 'center' }}>Loading link graph…</div>;
    if (!dataSources) return <div style={{ padding: 32, color: logservTheme.colors.textMuted, textAlign: 'center' }}>No data in this time range.</div>;

    return (
        <FullWidthPanel>
            <FramedPanel title="Source to sourcetype mapping" subtitle="sourcetype → source → host edges, deduped by host/source/sourcetype">
                <LinkGraphContainer ref={containerRef} $height={LINK_GRAPH_HEIGHT}>
                    <LinkGraph
                        dataSources={dataSources}
                        width="100%"
                        height={LINK_GRAPH_HEIGHT}
                        options={{
                            backgroundColor: 'transparent',
                            nodeColor: '#0877a6',
                            nodeHeight: 23,
                            nodeSpacingX: LINK_GRAPH_NODE_SPACING_X,
                            nodeSpacingY: 21,
                            nodeWidth,
                            showValueCounts: false,
                            showProgressBar: false,
                            showLastUpdated: false,
                        }}
                    />
                </LinkGraphContainer>
            </FramedPanel>
        </FullWidthPanel>
    );
};

/* Dashboard-wide host filter controls (build 162 / session 028).
 *
 * Lifted up from OverviewTab's panel actions slot so a single Multiselect +
 * Top-N pair drives the filtering for every SPL on every tab. The state lives
 * here at the top-level component; both tabs receive `selectedHosts` and
 * `topN` as props and rebuild their query set when either changes.
 *
 * Identical UX to HostDetails (build 161): per-host checkboxes, filter input
 * that narrows the dropdown, "Select all" auto-renames to "Select all matches"
 * when the filter is active. Top-N picker is disabled when one or more
 * specific hosts are selected.
 */
const DataPipelineOverview: React.FC = () => {
    const [topN, setTopN] = useState<string>('all');
    const [selectedHosts, setSelectedHosts] = useState<string[]>([]);

    // Host options for the Multiselect — sorted by descending event count
    // so the dropdown's first items are the busiest hosts (most useful).
    const hostListSearch = useSearch<{ host?: string; count?: string | number }>({
        query: '`sap_logserv_idx_macro` | stats count by host | sort -count',
    });
    const hostOptions = useMemo<string[]>(() => {
        const rows = hostListSearch.results ?? [];
        return rows
            .map((r) => (typeof r.host === 'string' ? r.host : ''))
            .filter((h): h is string => h.length > 0);
    }, [hostListSearch.results]);

    const filterControls = (
        <PanelControls>
            <Multiselect
                compact
                inline
                filter
                selectAllAppearance="checkbox"
                showSelectedValuesFirst="nextOpen"
                placeholder={
                    selectedHosts.length === 0
                        ? `Filter hosts (${hostOptions.length})`
                        : undefined
                }
                values={selectedHosts}
                onChange={(_e, { values }) =>
                    setSelectedHosts(values.map((v) => String(v)))
                }
                style={{ minWidth: 220, maxWidth: 360 }}
            >
                {hostOptions.map((h) => (
                    <Multiselect.Option key={h} label={h} value={h} />
                ))}
            </Multiselect>
            <Select
                inline
                value={topN}
                onChange={(_e, { value }) => {
                    if (typeof value === 'string') setTopN(value);
                }}
                disabled={selectedHosts.length > 0}
            >
                {TOP_N_CHOICES.map((c) => (
                    <Select.Option key={c.value} value={c.value} label={c.label} />
                ))}
            </Select>
        </PanelControls>
    );

    return (
        <DashboardLayout
            category="PLATFORM"
            title="Data Pipeline Overview"
            subtitle="End-to-end LogServ ingest health: events, hosts, sourcetypes, source-to-sourcetype linkage"
            titleRowActions={filterControls}
        >
            <TabbedLayout
                tabs={[
                    {
                        id: 'overview',
                        label: 'Overview',
                        content: (
                            <OverviewTab
                                selectedHosts={selectedHosts}
                                topN={topN}
                                totalHostCount={hostOptions.length}
                            />
                        ),
                    },
                    {
                        id: 'linked-graph',
                        label: 'Sourcetype Mapping',
                        content: (
                            <LinkedGraphTab
                                selectedHosts={selectedHosts}
                                topN={topN}
                                totalHostCount={hostOptions.length}
                            />
                        ),
                    },
                ]}
            />
        </DashboardLayout>
    );
};

export default DataPipelineOverview;
