import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
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
import { useSearch, UseSearchResult } from '../hooks/useSearch';
import { useTimeRange } from '../state/TimeRangeProvider';
import { chooseTimechartSpan } from '../utils/timechartSpan';
import {
    buildDashboardUrl,
    buildSplunkSearchUrl,
    openInNewTab,
    sourcetypeToDashboardSlug,
    splQuote,
} from '../utils/drilldownUrls';
import { logservTheme } from '../styles/logservTheme';

const KpiRow = styled.div`
    display: grid;
    grid-template-columns: repeat(5, minmax(0, 1fr));
    gap: ${logservTheme.elevation.panelGap};
    margin-bottom: ${logservTheme.elevation.panelGap};
    @media (max-width: 1400px) { grid-template-columns: repeat(3, minmax(0, 1fr)); }
    @media (max-width: 800px) { grid-template-columns: repeat(2, minmax(0, 1fr)); }
`;
const FullWidthPanel = styled.div`
    margin-bottom: ${logservTheme.elevation.panelGap};
`;

/** Inventory panel footnote — small muted caption rendered above the table
 *  to explain when the visible row count doesn't match the user's expectation
 *  (see the `inventoryFootnote` memo in OverviewTab for the wording rules).
 *  Build 164 / session 028. */
const InventoryFootnote = styled.div`
    color: ${logservTheme.colors.textMuted};
    font-size: ${logservTheme.fontSize.small};
    margin-bottom: ${logservTheme.spacing.sm};
    font-style: italic;
`;
const PanelGrid = styled.div`
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: ${logservTheme.elevation.panelGap};
    margin-bottom: ${logservTheme.elevation.panelGap};
    @media (max-width: 1100px) { grid-template-columns: 1fr; }
`;

/**
 * Auto-flow grid that reshuffles when panels are conditionally hidden.
 * This is the v0.0.5.0 P2 demo — DS v2's `hideWhenNoData` left empty gaps;
 * here `dense` packing + conditional rendering = panels reflow.
 */
const ReshuffleGrid = styled.div`
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(420px, 1fr));
    grid-auto-flow: row dense;
    gap: ${logservTheme.elevation.panelGap};
    margin-bottom: ${logservTheme.elevation.panelGap};
`;

/** Wrapper around Splunk's LinkGraph that suppresses every horizontal
 *  scrollbar inside the viz. Splunk renders an `overflow: auto` div around
 *  its 3-column body; even with our outer container using `overflow-x:
 *  hidden`, that inner element still draws its own scrollbar. Cascading
 *  `overflow-x: hidden !important` to every descendant kills it while
 *  leaving vertical scrolling intact. Mirrors the implementation in
 *  DataPipelineOverview (Linked Graph tab). */
const LinkGraphContainer = styled.div<{ $height: number }>`
    width: 100%;
    height: ${(p) => p.$height}px;
    overflow-x: hidden;

    & * {
        overflow-x: hidden !important;
    }
`;

/** Canvas height for the link graph — matches v0.0.4.2 layout_2 (~3260 px),
 *  large enough that the tallest column (typically `host`) can render every
 *  row without the viz's internal scrollbar appearing. Same value used on
 *  the Linked Graph tab in DataPipelineOverview. */
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

interface FirstRow { value: unknown; loading: boolean; error: Error | null; }
const useFirstRowField = (q: string, f: string): FirstRow => {
    const { results, loading, error } = useSearch({ query: q });
    const value = results && results[0] ? (results[0] as Record<string, unknown>)[f] : undefined;
    return { value, loading, error };
};

const colsForKey = (key: string, label: string): ColumnDef[] => [
    { key, label },
    { key: 'count', label: 'Count', align: 'right', render: (v) => formatInteger(v) },
    { key: 'percent', label: '%', align: 'right', render: (v) => (v ? `${parseFloat(String(v)).toFixed(1)}%` : '—') },
];

interface ConditionalProps {
    title: string;
    subtitle?: string;
    search: UseSearchResult;
    children: React.ReactNode;
}

const ConditionalPanel: React.FC<ConditionalProps> = ({ title, subtitle, search, children }) => {
    if (search.loading || search.error) return null;
    if (!search.results || search.results.length === 0) return null;
    return <FramedPanel title={title} subtitle={subtitle} search={search}>{children}</FramedPanel>;
};

// =====================================================================================
// Host picker
// =====================================================================================

/**
 * Selected hosts model — empty array means "no host filter, all hosts in the
 * index". One element behaves identically to the legacy single-host pick;
 * 2+ elements emit a `host IN (...)` SPL clause.
 *
 * Build 161 / session 028 task: replaced the legacy single-string `ALL_HOSTS = '*'`
 * sentinel with a string[] state so the user can multi-select hosts via the
 * `@splunk/react-ui/Multiselect` component (filter input + per-row checkboxes
 * + filter-aware "Select all").
 */

/** localStorage key — JSON-encoded string[] (build 161 schema). The legacy
 *  single-host string format is migrated on read. */
const STORAGE_KEY = 'logserv_host_details_selected_hosts';
/** Legacy localStorage key from build 160 and earlier (single host string).
 *  Read once for migration, then cleared. */
const LEGACY_STORAGE_KEY = 'logserv_host_details_last_host';

/** Compact inline cluster — matches DataPipelineOverview's title-row
 *  control strip exactly so the Host / Top-N / Refresh trio reads as a
 *  coherent right-edge cluster. Build 165 / session 028: dropped the
 *  prior column-label PickerBlock + PickerLabel + TopHostsBlock pattern
 *  per user request to match the Pipeline dash. */
const PickerRow = styled.div`
    display: inline-flex;
    align-items: center;
    gap: ${logservTheme.spacing.sm};
`;

/** Top-N choices for the Host Details "Top Hosts" picker. `all` resolves
 *  to "no host limit" — when paired with no specific host selection (empty
 *  selectedHosts array), every host's events contribute. Numeric values
 *  become a `[search ... | top N host | fields host]` subsearch in the
 *  per-tab queries. The picker is disabled when one or more specific hosts
 *  are selected (a specific pick is the more constrained intent). */
const TOP_HOSTS_CHOICES: Array<{ value: string; label: string }> = [
    { value: 'all', label: 'All hosts' },
    { value: '5', label: 'Top 5' },
    { value: '10', label: 'Top 10' },
    { value: '20', label: 'Top 20' },
    { value: '50', label: 'Top 50' },
];

interface HostPickerProps {
    selectedHosts: string[];
    onChange: (hosts: string[]) => void;
    topHosts: string;
    onTopHostsChange: (topHosts: string) => void;
    /** Count-sorted host list (descending by event count), lifted to the
     *  parent so the SAME ordering drives both the Multiselect options and
     *  the parent's `resolvedTopHosts` Top-N slice. */
    hosts: string[];
    hostsLoading: boolean;
}

const HostPicker: React.FC<HostPickerProps> = ({ selectedHosts, onChange, topHosts, onTopHostsChange, hosts, hostsLoading }) => {
    /* Top Hosts is disabled when ANY specific hosts are selected — the
     * explicit pick is always the more specific intent and the Top N
     * resolution would be ignored anyway (see combinedHostFilter). */
    const topHostsDisabled = selectedHosts.length > 0;

    /* Multiselect placeholder — shown when no specific hosts are selected
     * (i.e. "All Hosts" intent). Matches DataPipelineOverview's
     * "Filter hosts (N)" wording so the two dashboards' title-row clusters
     * read identically. */
    const emptyPlaceholder = hostsLoading ? 'Loading hosts…' : `Filter hosts (${hosts.length})`;

    return (
        <PickerRow>
            <Multiselect
                compact
                inline
                filter
                selectAllAppearance="checkbox"
                showSelectedValuesFirst="nextOpen"
                placeholder={selectedHosts.length === 0 ? emptyPlaceholder : undefined}
                values={selectedHosts}
                onChange={(_e, { values }) => onChange(values.map((v) => String(v)))}
                style={{ minWidth: 220, maxWidth: 360 }}
            >
                {hosts.map((h) => (
                    <Multiselect.Option key={h} label={h} value={h} />
                ))}
            </Multiselect>
            <Select
                inline
                value={topHosts}
                onChange={(_e, { value }) => {
                    if (typeof value === 'string') onTopHostsChange(value);
                }}
                disabled={topHostsDisabled}
            >
                {TOP_HOSTS_CHOICES.map((c) => (
                    <Select.Option key={c.value} value={c.value} label={c.label} />
                ))}
            </Select>
        </PickerRow>
    );
};

// =====================================================================================
// Helpers — build the per-tab SPL filter for a host selection (zero, one, or many)
// =====================================================================================

/** Escape a host name for SPL inclusion inside double quotes. The same
 *  pattern as DataPipelineOverview's per-host filter — guards against the
 *  unlikely-but-possible double-quote in a hostname. */
const splEscapeHost = (h: string): string => h.replace(/"/g, '\\"');

const hostFilter = (hosts: string[]): string => {
    if (hosts.length === 0) return '';
    if (hosts.length === 1) return `host="${splEscapeHost(hosts[0])}"`;
    return `host IN (${hosts.map((h) => `"${splEscapeHost(h)}"`).join(',')})`;
};

/** Human-readable label for the current host selection — used in panel
 *  subtitles, empty-state messages, and drilldown context. */
const hostLabel = (hosts: string[]): string => {
    if (hosts.length === 0) return 'all hosts';
    if (hosts.length === 1) return hosts[0];
    return `${hosts.length} hosts`;
};

/**
 * Returns the SPL search-filter fragment that combines the explicit host
 * picker and the Top Hosts picker. Spliced into the search-position of any
 * dashboard query as `\`sap_logserv_idx_macro\` ${HOST} | …`.
 *
 *  - 1 host selected            → `host="X"`                   (Top N ignored)
 *  - 2+ hosts selected          → `host IN ("X","Y","Z")`      (Top N ignored)
 *  - 0 selected + topHosts='all'→ ''                           (no host filter)
 *  - 0 selected + topHosts='N'  → `[search …| top N host | fields host] `
 *
 * The Top N branch uses a Splunk subsearch — the outer search picks up the
 * top-N hosts (by event count over the current time range) as an implicit
 * `(host=X1 OR host=X2 OR …)` filter. Subsearch is bounded by Splunk's
 * default 60s timeout / 10K row limit, neither of which we approach for a
 * 5–50 row aggregate.
 */
const combinedHostFilter = (hosts: string[], topHosts: string): string => {
    if (hosts.length > 0) return hostFilter(hosts);
    if (topHosts === 'all') return '';
    return `[search \`sap_logserv_idx_macro\` | top limit=${topHosts} host | fields host] `;
};

// =====================================================================================
// tstats host-filter dialect — mirrors the validated DataPipelineOverview
// build-198 pattern. tstats `WHERE` does NOT accept the `host IN (...)`
// operator nor a `[search …]` subsearch reliably across Splunk versions, so
// the tstats dialect expands the host selection to an explicit
// `(host="X" OR host="Y")` fragment.
// =====================================================================================

/** OR-expand a host selection for a tstats WHERE clause. Reuses the in-file
 *  `splEscapeHost` (same convention as `hostFilter`/`combinedHostFilter`). */
const hostsToOrFragment = (hosts: string[]): string => {
    if (hosts.length === 0) return '';
    if (hosts.length === 1) return `host="${splEscapeHost(hosts[0])}"`;
    return `(${hosts.map((h) => `host="${splEscapeHost(h)}"`).join(' OR ')})`;
};

/**
 * tstats variant of `combinedHostFilter`. The Top-N branch is PRE-RESOLVED:
 * the parent component slices the already-count-sorted host list down to the
 * top N and threads it in as `resolvedTopHosts`, which is then OR-expanded
 * (NOT emitted as a subsearch — a tstats WHERE can't host a subsearch). Both
 * the original subsearch and this pre-resolved slice inherit the global time
 * range, so the semantics are equivalent.
 *
 *  - 1+ hosts selected           → `(host="X" OR …)`            (Top N ignored)
 *  - 0 selected + topHosts='all' → ''                           (no host filter)
 *  - 0 selected + topHosts='N'   → `(host="T1" OR host="T2" …)` (pre-resolved)
 */
const combinedHostFilterTstats = (
    hosts: string[],
    topHosts: string,
    resolvedTopHosts: string[],
): string => {
    if (hosts.length > 0) return hostsToOrFragment(hosts);
    if (topHosts === 'all') return '';
    return hostsToOrFragment(resolvedTopHosts);
};

// =====================================================================================
// Build-233 Host Details KV-Store rollup (logserv_hostdetails_rollup). The
// Overview-tab DATA VOLUME (sum len(_raw)), ERRORS/CRITICALS, and AUTH FAILURES
// KPIs + their sparklines were raw full-scans (~162s / 29s / 38s at 76M / -7d;
// minutes at full volume). They now read 3 hourly-aggregated metrics keyed by
// (host, bucket): vol (count + sum_bytes), err (count over the errors/criticals
// filter), auth (count over the auth-failure filter). Read idiom:
//   <R_X> [| search <host OR-fragment>] | <agg>
// The host fragment is the SAME tstats dialect (HOST_TS); empty = all hosts.
// eventsBySource moved to tstats (sourcetype is indexed); TOTAL EVENTS / ACTIVE
// SOURCETYPES / topSources / dataFreshness were already tstats. Host Inventory
// (osquery, narrow) + the per-host Role Activity tab stay RAW.
const HD_ROLL = 'logserv_hostdetails_rollup';
const HD_RANGE = '| addinfo | where bucket_ts>=info_min_time AND bucket_ts<info_max_time';
const R_VOL = `| inputlookup ${HD_ROLL} where metric="vol" ${HD_RANGE}`;
const R_ERR = `| inputlookup ${HD_ROLL} where metric="err" ${HD_RANGE}`;
const R_AUTH = `| inputlookup ${HD_ROLL} where metric="auth" ${HD_RANGE}`;

// =====================================================================================
// Tab 1 — Overview
// =====================================================================================

const OverviewTab: React.FC<{ hosts: string[]; topHosts: string; resolvedTopHosts: string[] }> = ({ hosts, topHosts, resolvedTopHosts }) => {
    // Two host dialects coexist in this tab:
    //   - HOST     → search-language fragment (host="X" / host IN(...) /
    //                subsearch) for RAW panels (len(_raw), full-text
    //                severity/auth, osquery rex, timechart-by-split).
    //   - HOST_TS  → tstats WHERE fragment ((host="X" OR …), pre-resolved
    //                Top-N) for the default-indexed-dim panels rewritten to
    //                | tstats. See combinedHostFilterTstats.
    // The macro is spliced INSIDE the tstats WHERE (via `W`) so per-customer
    // local/macros.conf index overrides keep working — search macros expand
    // textually before parse, including inside tstats WHERE.
    const HOST = useMemo(() => combinedHostFilter(hosts, topHosts), [hosts, topHosts]);
    const HOST_TS = useMemo(
        () => combinedHostFilterTstats(hosts, topHosts, resolvedTopHosts),
        [hosts, topHosts, resolvedTopHosts],
    );
    // tstats WHERE clause: macro + optional host fragment. When HOST_TS is
    // empty the trailing space collapses to just the macro.
    const W = useMemo(
        () => (HOST_TS ? `\`sap_logserv_idx_macro\` ${HOST_TS}` : `\`sap_logserv_idx_macro\``),
        [HOST_TS],
    );
    // Host filter for the build-233 rollup inputlookup reads: the HOST_TS
    // OR-fragment as a post-inputlookup `| search` clause (empty = all hosts).
    const HOST_ROLL = useMemo(() => (HOST_TS ? `| search ${HOST_TS} ` : ''), [HOST_TS]);
    const Q = useMemo(() => ({
        totalEvents: `| tstats count WHERE ${W}`,
        dataVolume: `${R_VOL} ${HOST_ROLL}| stats sum(sum_bytes) AS total_bytes`,
        activeSourcetypes: `| tstats dc(sourcetype) AS sts WHERE ${W}`,
        errorsCriticals: `${R_ERR} ${HOST_ROLL}| stats sum(count) AS count`,
        authFailures: `${R_AUTH} ${HOST_ROLL}| stats sum(count) AS count`,
        // sparkTotal/sparkSts: rewritten to | tstats. tstats BY _time span=1d
        // does NOT zero-fill empty days (unlike the legacy `timechart`), which
        // would leave gaps on sparse per-host data. The trailing
        // `| timechart span=1d <agg>` re-fills zero-event days so the
        // sparkline keeps its previous continuous baseline. Same pattern as
        // the validated DataPipelineOverview build-198 sparklines.
        sparkTotal: `| tstats count WHERE ${W} BY _time span=1d | timechart span=1d sum(count) AS count`,
        // sparkVolume/sparkErrors/sparkAuth now read the build-233 rollup (eval
        // _time=bucket_ts then daily timechart). sparkErrors/sparkAuth are ALIGNED
        // to the KPI's err/auth filter (the pre-build sparks used a narrower filter
        // than the KPI — a pre-existing inconsistency, now consistent).
        sparkVolume: `${R_VOL} ${HOST_ROLL}| eval _time=bucket_ts | timechart span=1d sum(sum_bytes) AS total_bytes`,
        sparkSts: `| tstats dc(sourcetype) AS sts WHERE ${W} BY _time span=1d | timechart span=1d max(sts) AS sts`,
        sparkErrors: `${R_ERR} ${HOST_ROLL}| eval _time=bucket_ts | timechart span=1d sum(count) AS count`,
        sparkAuth: `${R_AUTH} ${HOST_ROLL}| eval _time=bucket_ts | timechart span=1d sum(count) AS count`,
        // eventsBySource now built dynamically below so the timechart span
        // tracks the user's selected time range — see `eventsBySourceQuery`
        // memo. Hardcoded `span=1h` produced 700+ bars on a 30-day window.
        // topSources: `top limit=0 source` emits source/count/percent; the
        // tstats rewrite re-synthesizes the per-row `percent` (consumed by
        // colsForKey('source','Source')) via eventstats so all three consumer
        // fields are preserved.
        topSources: `| tstats count WHERE ${W} BY source | sort -count | eventstats sum(count) AS _tot | eval percent=round(count/_tot*100, 1) | fields - _tot`,
        dataFreshness: `| tstats count, max(_time) AS last_seen WHERE ${W} BY sourcetype | sort - last_seen | eval last_seen=strftime(last_seen, "%Y-%m-%d %H:%M:%S")`,
        // Host Inventory — restored in build 160 (session 027 task 7) per
        // v0.0.4.2 logserv_host_details.xml `ds_host_inventory`. Pulls
        // hardware/OS/cloud facts from osqueryd events embedded in
        // linux_messages_syslog. Rendered ONLY when a specific host is
        // selected (not "All Hosts") AND the SPL returns at least one row
        // — matches the v0.0.4.2 `hideWhenNoData: true` semantics so a
        // host without an osquery agent simply doesn't see the panel.
        //
        // Regex notes:
        //   - All field rex'es use `[^,]+` because each value sits between
        //     `key: VALUE, ` separators inside its osquery section.
        //   - Exception: `zone` (last field of cloud_info section) needs
        //     `[^,#]+` because the next character is `#012` (the section
        //     separator), not a comma. The v0.0.4.2 SPL had this bug; we
        //     fix it here so AZ doesn't bleed into the next section.
        hostInventory:
            `\`sap_logserv_idx_macro\` ${HOST} sourcetype=linux_messages_syslog osqueryd cpu_brand` +
            ` | rex field=_raw "cpu_brand:\\s*(?<cpu_brand>[^,]+)"` +
            ` | rex field=_raw "cpu_logical_cores:\\s*(?<cpu_cores>[^,]+)"` +
            ` | rex field=_raw "physical_memory:\\s*(?<phys_mem>[^,]+)"` +
            ` | rex field=_raw "hardware_model:\\s*(?<hw_model>[^,]+)"` +
            ` | rex field=_raw "pretty_name:\\s*(?<os_name>[^,]+)"` +
            ` | rex field=_raw "region:\\s*(?<aws_region>[^,]+)"` +
            ` | rex field=_raw "zone:\\s*(?<aws_az>[^,#]+)"` +
            ` | rex field=_raw "id:\\s*(?<instance_id>i-[a-f0-9]+)"` +
            ` | where isnotnull(cpu_brand)` +
            ` | eval memory_gb = round(phys_mem/1073741824, 1) . " GB"` +
            ` | stats latest(cpu_brand) AS CPU` +
            ` latest(cpu_cores) AS Cores` +
            ` latest(memory_gb) AS RAM` +
            ` latest(hw_model) AS "Instance Type"` +
            ` latest(os_name) AS "Operating System"` +
            ` latest(aws_region) AS Region` +
            ` latest(aws_az) AS AZ` +
            ` latest(instance_id) AS "Instance ID"` +
            ` by host` +
            ` | rename host AS Host`,
    }), [HOST, W, HOST_ROLL]);

    const total = useFirstRowField(Q.totalEvents, 'count');
    const volume = useFirstRowField(Q.dataVolume, 'total_bytes');
    const sts = useFirstRowField(Q.activeSourcetypes, 'sts');
    const errors = useFirstRowField(Q.errorsCriticals, 'count');
    const auth = useFirstRowField(Q.authFailures, 'count');
    const topSources = useSearch({ query: Q.topSources });
    const dataFreshness = useSearch({ query: Q.dataFreshness });
    // Host Inventory — always fetched (build 163 / session 028 task: user
    // requested the panel show in the All-Hosts case too). The SPL produces
    // one row per host that has osquery data, regardless of whether the
    // user explicitly picked specific hosts or left the picker on All
    // Hosts. Pagination on the DataTable keeps the panel manageable when
    // many hosts have data. Hosts without osquery data simply don't
    // appear — per-row hideWhenNoData semantic.
    const inventoryEnabled = true;
    const hostInventory = useSearch({ query: Q.hostInventory, enabled: inventoryEnabled });

    // Total host count for the inventory footnote denominator (build 164 /
    // session 028 task). Estate-wide `dc(host)` is the denominator when in
    // All-Hosts mode; in specific-hosts mode the denominator is just
    // `hosts.length`. This query is intentionally NOT host-filtered — it
    // always reports the full count of hosts the user could have picked.
    const totalHostsAcrossEstate = useFirstRowField(
        '| tstats dc(host) AS hosts WHERE `sap_logserv_idx_macro`',
        'hosts',
    );

    // Dynamic timechart span keeps the per-sourcetype line chart readable
    // across any selected time range (a hard-coded `span=1h` produced 700+
    // bars on a 30-day window).
    const { timeRange } = useTimeRange();
    const span = useMemo(
        () => chooseTimechartSpan(timeRange.earliest, timeRange.latest),
        [timeRange.earliest, timeRange.latest],
    );
    // limit=0 → no sourcetype rollup, all sourcetypes visible. With the
    // combined HOST filter (specific host OR Top Hosts subsearch when "All
    // Hosts" + Top N is selected) and the picked time range, the chart
    // reflects the full set of sourcetypes that contributed events; the
    // side legend handles scrolling when there are more series than fit
    // vertically.
    // Build 233: rewritten to | tstats (sourcetype is indexed) — was a raw
    // timechart-by-sourcetype full-scan (~165s at 76M / -7d). tstats reads the
    // tsidx (~5.6s). `${W}` is the tstats WHERE (macro + host OR-fragment);
    // BY sourcetype, _time span=<span> then timechart re-aggregates, mirroring
    // the validated DataPipelineOverview build-198 pattern.
    const eventsBySourceQuery = useMemo(
        () =>
            `| tstats count WHERE ${W} BY sourcetype, _time span=${span} | timechart span=${span} sum(count) by sourcetype limit=0 useother=false`,
        [W, span],
    );

    const formatBytes = (raw: unknown): string => {
        if (raw === null || typeof raw === 'undefined') return '—';
        const n = typeof raw === 'number' ? raw : parseFloat(String(raw));
        if (Number.isNaN(n)) return String(raw);
        if (n < 1024) return `${n.toFixed(0)} B`;
        if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
        if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
        return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
    };

    const errorsNum = Number(errors.value ?? 0);
    const errorsTone = errorsNum > 100 ? 'critical' : errorsNum > 0 ? 'warning' : 'neutral';
    const authNum = Number(auth.value ?? 0);
    const authTone = authNum > 100 ? 'critical' : authNum > 0 ? 'warning' : 'neutral';

    /* Drilldowns (build 159 / session 027 task 6, updated build 161 for multi-host):
     * Host Details is a hub destination for OTHER dashboards; inside it we
     * route OUT to specialist dashboards based on the row's sourcetype, NOT
     * back into Host Details. The Data Freshness table's sourcetype column
     * resolves via `sourcetypeToDashboardSlug()`; unmapped sourcetypes fall
     * through to a splunk-search drilldown so the user always has SOME
     * deep-dive path.
     *
     * Multi-host handling:
     *   - 1 host selected → drilldown URL includes `?host=<that host>` so the
     *     destination dashboard pre-filters on it. Same UX as build 160.
     *   - 2+ or 0 selected → drilldown drops the host param entirely (no
     *     destination dashboard supports a multi-host URL filter today). For
     *     splunk-search drilldowns we still build a host clause that mirrors
     *     the local selection so the resulting search is constrained the
     *     same way the source dashboard was.
     */
    const isSingleHost = hosts.length === 1;
    const isMultiHost = hosts.length > 1;
    const splHostClause = (): string => {
        if (hosts.length === 0) return '';
        if (hosts.length === 1) return `host="${splQuote(hosts[0])}" `;
        return `host IN (${hosts.map((h) => `"${splQuote(h)}"`).join(',')}) `;
    };
    const goToFreshnessRow = (row: Record<string, unknown>): void => {
        const st = String(row.sourcetype ?? '');
        if (!st) return;
        const slug = sourcetypeToDashboardSlug(st);
        if (slug) {
            // Route OUT to the specialist dashboard. Pass `?host=<host>` only
            // when exactly one host is selected — destinations don't support
            // multi-host URL params.
            const url = isSingleHost
                ? `${buildDashboardUrl(slug, timeRange.earliest, timeRange.latest)}&host=${encodeURIComponent(hosts[0])}`
                : buildDashboardUrl(slug, timeRange.earliest, timeRange.latest);
            openInNewTab(url);
            return;
        }
        // Unmapped sourcetype — fall through to a splunk-search filtered to
        // host(s) + sourcetype.
        const spl = `\`sap_logserv_idx_macro\` ${splHostClause()}sourcetype="${splQuote(st)}" | sort -_time`;
        openInNewTab(buildSplunkSearchUrl(spl, timeRange.earliest, timeRange.latest));
    };
    const goToSourcesRow = (row: Record<string, unknown>): void => {
        const src = String(row.source ?? '');
        if (!src) return;
        const spl = `\`sap_logserv_idx_macro\` ${splHostClause()}source="${splQuote(src)}" | sort -_time`;
        openInNewTab(buildSplunkSearchUrl(spl, timeRange.earliest, timeRange.latest));
    };

    // Avoid the unused-var warning when isMultiHost isn't directly read; it's
    // declared above for readability and used by future drilldown handlers.
    void isMultiHost;

    const empty = `No events for ${hostLabel(hosts)}.`;

    /* Host Inventory column set (build 160). Same shape as v0.0.4.2's
     * `viz_inventory` table: Host / CPU / Cores / RAM / Instance Type /
     * OS / Region / AZ / Instance ID. Widths tuned for the typical osquery
     * inventory shape: long strings (CPU brand, OS name) get auto-width;
     * short categorical fields (Cores, RAM, Region) get fixed widths. */
    const HOST_INVENTORY_COLS: ColumnDef[] = [
        { key: 'Host', label: 'Host', width: '180px' },
        { key: 'CPU', label: 'CPU' },
        { key: 'Cores', label: 'Cores', align: 'right', width: '70px' },
        { key: 'RAM', label: 'RAM', width: '90px' },
        { key: 'Instance Type', label: 'Instance Type', width: '130px' },
        { key: 'Operating System', label: 'Operating System' },
        { key: 'Region', label: 'Region', width: '110px' },
        { key: 'AZ', label: 'AZ', width: '120px' },
        { key: 'Instance ID', label: 'Instance ID', width: '180px' },
    ];
    const inventoryRows = hostInventory.results ?? [];
    const showInventory = inventoryEnabled && inventoryRows.length > 0;

    /* Inventory footnote — build 164 / session 028. Tells the user when
     * the table is showing fewer hosts than they might expect. Two cases:
     *
     *   - All Hosts mode (hosts.length === 0):
     *       "Showing 5 of 46 hosts — 41 have no osquery agent reporting
     *        cpu_brand events"
     *
     *   - Specific hosts mode (hosts.length > 0):
     *       "Showing 1 of 2 selected hosts — 1 has no osquery agent
     *        reporting cpu_brand events"
     *
     * Suppressed entirely when the row count matches the denominator
     * (every host in scope has inventory data) — no need for a "0 missing"
     * footnote. Also suppressed during the brief moment before the
     * total-hosts query lands (denominator unknown → no useful message). */
    const inventoryFootnote = useMemo<string | null>(() => {
        const shown = inventoryRows.length;
        const denominator = hosts.length > 0
            ? hosts.length
            : Number(totalHostsAcrossEstate.value ?? NaN);
        if (!Number.isFinite(denominator) || denominator <= 0) return null;
        const missing = denominator - shown;
        if (missing <= 0) return null;
        const scopeWord = hosts.length > 0
            ? `${denominator} selected ${denominator === 1 ? 'host' : 'hosts'}`
            : `${denominator} hosts`;
        const verb = missing === 1 ? 'has' : 'have';
        return `Showing ${shown} of ${scopeWord} — ${missing} ${verb} no osquery agent reporting cpu_brand events`;
    }, [inventoryRows.length, hosts.length, totalHostsAcrossEstate.value]);

    return (
        <>
            <KpiRow>
                <KpiCard label="Total Events" value={total.value} loading={total.loading} error={total.error} formatValue={formatInteger}
                    sparkline={<SparklineFromQuery query={Q.sparkTotal} valueField="count" fill />} />
                <KpiCard label="Data Volume" value={volume.value} loading={volume.loading} error={volume.error} formatValue={formatBytes}
                    sparkline={<SparklineFromQuery query={Q.sparkVolume} valueField="total_bytes" fill />} />
                <KpiCard label="Active Sourcetypes" value={sts.value} loading={sts.loading} error={sts.error} formatValue={formatInteger}
                    sparkline={<SparklineFromQuery query={Q.sparkSts} valueField="sts" fill />} />
                <KpiCard label="Errors / Criticals" value={errors.value} loading={errors.loading} error={errors.error} formatValue={formatInteger} tone={errorsTone}
                    sparkline={<SparklineFromQuery query={Q.sparkErrors} valueField="count" color={logservTheme.colors.red} fill />} />
                <KpiCard label="Auth Failures" value={auth.value} loading={auth.loading} error={auth.error} formatValue={formatInteger} tone={authTone}
                    sparkline={<SparklineFromQuery query={Q.sparkAuth} valueField="count" color={logservTheme.colors.red} fill />} />
            </KpiRow>
            <FullWidthPanel>
                <FramedPanel
                    title="Event Count by Sourcetype"
                    subtitle={
                        hosts.length === 0 && topHosts !== 'all'
                            ? `Volume for top ${topHosts} hosts, by sourcetype — span ${span}`
                            : `Volume for ${hostLabel(hosts)}, by sourcetype — span ${span}`
                    }
                >
                    <TimeSeriesChart
                        query={eventsBySourceQuery}
                        height={280}
                        chartType="line"
                        palette="categorical"
                    />
                </FramedPanel>
            </FullWidthPanel>
            {showInventory && (
                <FullWidthPanel>
                    <FramedPanel
                        title="Host Inventory"
                        subtitle={`Hardware, OS, and cloud facts for ${hostLabel(hosts)} — sourced from osqueryd events`}
                        search={hostInventory}
                    >
                        {/* Footnote (build 164): rendered above the table so
                          * the user reads it before scanning rows. Suppressed
                          * when every host in scope has inventory or when the
                          * denominator hasn't loaded yet. */}
                        {inventoryFootnote && (
                            <InventoryFootnote>{inventoryFootnote}</InventoryFootnote>
                        )}
                        {/* Build 163 / session 028: pageSize={10} replaces the
                          * earlier `paginationDisabled` flag. With multi-host
                          * selection (build 161), the SPL produces one row per
                          * selected host that has osquery data, so the table
                          * grows from 1 row (legacy single-host case) up to N.
                          * Fixed pageSize keeps the layout predictable: ≤10
                          * hosts → all rows visible with no footer; >10 →
                          * paginated 10-per-page. */}
                        <DataTable
                            columns={HOST_INVENTORY_COLS}
                            rows={inventoryRows}
                            loading={hostInventory.loading}
                            error={hostInventory.error}
                            pageSize={10}
                        />
                    </FramedPanel>
                </FullWidthPanel>
            )}
            <PanelGrid>
                <FramedPanel search={topSources} title="Sources" subtitle={`Sources contributing events for ${hostLabel(hosts)}, ranked by event count`}>
                    <DataTable columns={colsForKey('source', 'Source')} rows={topSources.results} loading={topSources.loading} error={topSources.error} emptyMessage={empty} onRowClick={goToSourcesRow} />
                </FramedPanel>
                <FramedPanel search={dataFreshness} title="Data Freshness" subtitle="Per-sourcetype event count and last-seen timestamp — click a row to open the related specialist dashboard">
                    <DataTable
                        columns={[
                            { key: 'sourcetype', label: 'Sourcetype' },
                            { key: 'count', label: 'Count', align: 'right', render: (v) => formatInteger(v) },
                            { key: 'last_seen', label: 'Last Seen', width: '200px' },
                        ]}
                        rows={dataFreshness.results}
                        loading={dataFreshness.loading}
                        error={dataFreshness.error}
                        emptyMessage={empty}
                        onRowClick={goToFreshnessRow}
                    />
                </FramedPanel>
            </PanelGrid>
        </>
    );
};

// =====================================================================================
// Tab 2 — Role Activity (with hideWhenNoData reshuffle)
// =====================================================================================

const RoleActivityTab: React.FC<{ hosts: string[]; topHosts: string }> = ({ hosts, topHosts }) => {
    const HOST = combinedHostFilter(hosts, topHosts);

    const hanaAudit = useSearch({ query: `\`sap_logserv_idx_macro\` ${HOST} sourcetype=sap:hana:audit | top limit=0 action_type` });
    const abapWp = useSearch({ query: `\`sap_logserv_idx_macro\` ${HOST} sourcetype=sap:abap:workprocess | top limit=0 wp_type` });
    const webDisp = useSearch({ query: `\`sap_logserv_idx_macro\` ${HOST} sourcetype=sap:webdispatcher:access | top limit=0 status` });
    const sapRouter = useSearch({ query: `\`sap_logserv_idx_macro\` ${HOST} sourcetype=sap:saprouter | top limit=0 peer_ip` });
    const winEvents = useSearch({ query: `\`sap_logserv_idx_macro\` ${HOST} sourcetype=XmlWinEventLog* | top limit=0 EventCode` });
    const sudo = useSearch({ query: `\`sap_logserv_idx_macro\` ${HOST} sourcetype=linux_messages_syslog "sudo" | rex "sudo:\\s+(?<sudo_user>[^\\s:]+)" | top limit=0 sudo_user` });
    const dns = useSearch({ query: `\`sap_logserv_idx_macro\` ${HOST} sourcetype=isc:bind:query | top limit=0 query` });

    const allEmpty =
        (!hanaAudit.results || hanaAudit.results.length === 0) &&
        (!abapWp.results || abapWp.results.length === 0) &&
        (!webDisp.results || webDisp.results.length === 0) &&
        (!sapRouter.results || sapRouter.results.length === 0) &&
        (!winEvents.results || winEvents.results.length === 0) &&
        (!sudo.results || sudo.results.length === 0) &&
        (!dns.results || dns.results.length === 0);

    return (
        <>
            <ReshuffleGrid>
                <ConditionalPanel title="HANA Audit — Top Actions" subtitle="sap:hana:audit" search={hanaAudit}>
                    <DataTable columns={colsForKey('action_type', 'Action')} rows={hanaAudit.results} />
                </ConditionalPanel>
                <ConditionalPanel title="ABAP Work Process Mix" subtitle="sap:abap:workprocess" search={abapWp}>
                    <DataTable columns={colsForKey('wp_type', 'WP Type')} rows={abapWp.results} />
                </ConditionalPanel>
                <ConditionalPanel title="Web Dispatcher Traffic" subtitle="sap:webdispatcher:access by status" search={webDisp}>
                    <DataTable columns={colsForKey('status', 'Status')} rows={webDisp.results} />
                </ConditionalPanel>
                <ConditionalPanel title="SAP Router Peers" subtitle="sap:saprouter" search={sapRouter}>
                    <DataTable columns={colsForKey('peer_ip', 'Peer IP')} rows={sapRouter.results} />
                </ConditionalPanel>
                <ConditionalPanel title="Windows Event Codes" subtitle="XmlWinEventLog top 15" search={winEvents}>
                    <DataTable columns={colsForKey('EventCode', 'Event Code')} rows={winEvents.results} />
                </ConditionalPanel>
                <ConditionalPanel title="Sudo Commands" subtitle="linux_messages_syslog" search={sudo}>
                    <DataTable columns={colsForKey('sudo_user', 'User')} rows={sudo.results} />
                </ConditionalPanel>
                <ConditionalPanel title="DNS Top Queries" subtitle="isc:bind:query" search={dns}>
                    <DataTable columns={colsForKey('query', 'Query')} rows={dns.results} />
                </ConditionalPanel>
            </ReshuffleGrid>
            {allEmpty && (
                <div style={{ padding: 32, color: logservTheme.colors.textMuted, textAlign: 'center', fontSize: logservTheme.fontSize.body }}>
                    No role-specific activity for {hostLabel(hosts)} in this time range. Panels appear here only for roles the host is actively running.
                </div>
            )}
        </>
    );
};

// =====================================================================================
// Tab 3 — Sourcetype Mapping (Linked Graph — same shape and sizing as the
// Linked Graph tab on Data Pipeline Overview)
// =====================================================================================

interface LinkGraphResult {
    sourcetype?: string;
    source?: string;
    host?: string;
}

const SourcetypeMappingTab: React.FC<{ hosts: string[]; topHosts: string; resolvedTopHosts: string[] }> = ({ hosts, topHosts, resolvedTopHosts }) => {
    const HOST_TS = combinedHostFilterTstats(hosts, topHosts, resolvedTopHosts);
    const W = HOST_TS ? `\`sap_logserv_idx_macro\` ${HOST_TS}` : `\`sap_logserv_idx_macro\``;

    // count: 0 → "all rows". The link graph needs every unique
    // sourcetype/source/host combination, which can easily exceed the
    // default 100-row cap and silently drop hosts. `| tstats … BY a, b, c`
    // already yields one row per distinct tuple (dedup is implicit in the BY
    // grouping), so the trailing `| fields - count` drops the aggregate just
    // like the legacy form. All three dims are default-indexed.
    const { results, loading, error } = useSearch<LinkGraphResult>({
        query: `| tstats count WHERE ${W} BY sourcetype, source, host | fields - count`,
        count: 0,
    });

    // Measure the container width and compute nodeWidth dynamically so the
    // three columns + their two gaps fit exactly inside the panel — no
    // horizontal scrollbar, no wasted whitespace. Same compute logic as
    // DataPipelineOverview's LinkedGraphTab.
    const containerRef = useRef<HTMLDivElement>(null);
    const [nodeWidth, setNodeWidth] = useState<number>(LINK_GRAPH_NODE_WIDTH_FALLBACK);

    useEffect(() => {
        const el = containerRef.current;
        if (!el) return undefined;

        const compute = (cw: number): number => {
            const raw = Math.floor(
                (cw - 2 * LINK_GRAPH_NODE_SPACING_X - LINK_GRAPH_WIDTH_SAFETY_MARGIN) / 3
            );
            // Empirical 10% shrink — Splunk's LinkGraph still renders wider
            // than the math suggests, so bias toward "definitely narrower
            // than container" rather than "exactly fits".
            const n = Math.floor(raw * 0.9);
            return Math.max(180, n);
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
    if (!dataSources) return <div style={{ padding: 32, color: logservTheme.colors.textMuted, textAlign: 'center' }}>No source/sourcetype data for {hostLabel(hosts)}.</div>;

    return (
        <FullWidthPanel>
            <FramedPanel
                title="Source to sourcetype mapping"
                subtitle={`sourcetype → source → host edges for ${hostLabel(hosts)}, deduped by host/source/sourcetype`}
            >
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

// =====================================================================================
// Top-level dashboard
// =====================================================================================

/**
 * Read selected hosts from localStorage with build-160 single-host migration.
 *
 * Build-161 schema is JSON-encoded `string[]` under `STORAGE_KEY`. If the key
 * is absent, fall back to the legacy `LEGACY_STORAGE_KEY` (a single host
 * string from build 160 and earlier) and migrate it. The legacy key is
 * cleared after a successful migration so we don't keep reading it.
 */
const readStoredHosts = (): string[] => {
    try {
        const v161 = window.localStorage.getItem(STORAGE_KEY);
        if (v161) {
            const parsed = JSON.parse(v161) as unknown;
            if (Array.isArray(parsed)) {
                return parsed.filter((x): x is string => typeof x === 'string' && x.length > 0);
            }
        }
        const legacy = window.localStorage.getItem(LEGACY_STORAGE_KEY);
        if (legacy && legacy.length > 0 && legacy !== '*') {
            // Migrate the single-host string into the new array schema and
            // clear the legacy key so this branch only runs once per browser.
            window.localStorage.setItem(STORAGE_KEY, JSON.stringify([legacy]));
            window.localStorage.removeItem(LEGACY_STORAGE_KEY);
            return [legacy];
        }
        if (legacy === '*') {
            // Legacy "All Hosts" sentinel → empty array. Clear key.
            window.localStorage.removeItem(LEGACY_STORAGE_KEY);
        }
    } catch {
        // ignore storage errors (private mode, quota, malformed JSON, etc.)
    }
    return [];
};

/** Parse hosts from the URL search params. Supports both the build-160
 *  legacy `?host=<single>` and the build-161 `?hosts=<csv>` forms. */
const parseHostsFromUrl = (params: URLSearchParams): string[] => {
    const csv = params.get('hosts');
    if (csv && csv.length > 0) {
        return csv.split(',').map((s) => s.trim()).filter(Boolean);
    }
    const single = params.get('host');
    if (single && single.length > 0 && single !== '*') {
        return [single];
    }
    return [];
};

/** Compare two host arrays for value-equality (order-insensitive). Used
 *  inside the URL-sync effect to avoid scheduling redundant re-renders
 *  on every external param change. */
const hostsEqual = (a: string[], b: string[]): boolean => {
    if (a.length !== b.length) return false;
    if (a.length === 0) return true;
    const sa = [...a].sort();
    const sb = [...b].sort();
    return sa.every((h, i) => h === sb[i]);
};

const HostDetails: React.FC = () => {
    const [searchParams, setSearchParams] = useSearchParams();
    const urlHosts = useMemo(() => parseHostsFromUrl(searchParams), [searchParams]);

    // Resolve the initial selection: URL param takes priority, then
    // localStorage, then "All Hosts" (empty array).
    const [selectedHosts, setSelectedHosts] = useState<string[]>(() => {
        if (urlHosts.length > 0) return urlHosts;
        return readStoredHosts();
    });

    // Top Hosts filter — restricts the data feeding the Event Count chart
    // (and any other top-N-host-aware queries) to events from the busiest N
    // hosts in the current time range. Default is "all" (no restriction).
    // The picker is disabled in the UI when ANY specific hosts are selected.
    const [topHosts, setTopHosts] = useState<string>('all');

    // Count-sorted host list — lifted out of HostPicker so the SAME ordering
    // drives both the Multiselect options AND the tstats Top-N resolution
    // (resolvedTopHosts). Rewritten to | tstats: `host` is a default-indexed
    // dim and `count` is tstats-native. The macro inside WHERE preserves
    // per-customer index overrides.
    const hostListSearch = useSearch({
        query: '| tstats count WHERE `sap_logserv_idx_macro` BY host | sort -count',
    });
    const hostOptions = useMemo<string[]>(() => {
        if (!hostListSearch.results) return [];
        return hostListSearch.results
            .map((r) => String((r as Record<string, unknown>).host ?? ''))
            .filter(Boolean);
    }, [hostListSearch.results]);

    // Pre-resolve the Top-N host slice for the tstats dialect. When the user
    // leaves the picker on "All Hosts" + a numeric Top-N, this slice of the
    // already-count-sorted list is OR-expanded inside tstats WHERE (a tstats
    // WHERE can't carry a subsearch). When 'all' or a specific host pick is
    // active, the slice is unused by combinedHostFilterTstats.
    const resolvedTopHosts = useMemo<string[]>(() => {
        if (topHosts === 'all') return [];
        const n = parseInt(topHosts, 10);
        if (!Number.isFinite(n) || n <= 0) return [];
        return hostOptions.slice(0, n);
    }, [topHosts, hostOptions]);

    // If an externally-driven URL change happens (e.g., browser back/forward,
    // a drilldown landing here with `?host=…` from another dashboard), reflect
    // it in component state.
    useEffect(() => {
        if (!hostsEqual(urlHosts, selectedHosts)) {
            setSelectedHosts(urlHosts);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [searchParams]);

    // On first mount, sync the URL with the resolved selection so deep links
    // / refreshes capture the restored state. Only runs once.
    useEffect(() => {
        if (urlHosts.length === 0 && selectedHosts.length > 0) {
            const next = new URLSearchParams(searchParams);
            applySelectionToParams(next, selectedHosts);
            setSearchParams(next, { replace: true });
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    /** Mutate a `URLSearchParams` in place to reflect the given selection.
     *  - 0 hosts → drop both `host` and `hosts` params
     *  - 1 host  → set `host=` (back-compat with build-160 deep links)
     *  - 2+      → set `hosts=h1,h2,h3` */
    function applySelectionToParams(params: URLSearchParams, hosts: string[]): void {
        params.delete('host');
        params.delete('hosts');
        if (hosts.length === 1) {
            params.set('host', hosts[0]);
        } else if (hosts.length > 1) {
            params.set('hosts', hosts.join(','));
        }
    }

    const setHosts = (next: string[]) => {
        setSelectedHosts(next);
        try {
            window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
        } catch {
            // ignore storage errors (private mode, quota, etc.)
        }
        const params = new URLSearchParams(searchParams);
        applySelectionToParams(params, next);
        setSearchParams(params, { replace: false });
    };

    const subtitle =
        selectedHosts.length === 0
            ? 'Drill-down view across all hosts — inventory, activity, severity, authentication, role-specific analytics, and event distribution'
            : selectedHosts.length === 1
                ? `Per-host drill-down for ${selectedHosts[0]} — inventory, activity, severity, authentication, role-specific analytics, and event distribution`
                : `Drill-down across ${selectedHosts.length} selected hosts — inventory, activity, severity, authentication, role-specific analytics, and event distribution`;

    return (
        <DashboardLayout
            category="PLATFORM"
            title="Host Details"
            subtitle={subtitle}
            titleRowActions={
                <HostPicker
                    selectedHosts={selectedHosts}
                    onChange={setHosts}
                    topHosts={topHosts}
                    onTopHostsChange={setTopHosts}
                    hosts={hostOptions}
                    hostsLoading={hostListSearch.loading}
                />
            }
        >
            <TabbedLayout
                tabs={[
                    { id: 'overview', label: 'Overview', content: <OverviewTab hosts={selectedHosts} topHosts={topHosts} resolvedTopHosts={resolvedTopHosts} /> },
                    { id: 'role-activity', label: 'Role Activity', content: <RoleActivityTab hosts={selectedHosts} topHosts={topHosts} /> },
                    { id: 'sourcetype-mapping', label: 'Sourcetype Mapping', content: <SourcetypeMappingTab hosts={selectedHosts} topHosts={topHosts} resolvedTopHosts={resolvedTopHosts} /> },
                ]}
            />
        </DashboardLayout>
    );
};

export default HostDetails;
