import { dashboards } from '../routes/dashboardRegistry';

/**
 * Drilldown URL builders (build 157 / session 027 task 4).
 *
 * Three flavors:
 *   - `buildDashboardUrl(slug, earliest, latest)` → opens another dashboard
 *     in the same React app, with the global TimeRange pre-applied.
 *   - `buildHostDetailsUrl(host, earliest, latest)` → Host Details with
 *     `?host=<name>` so the page mounts pre-filtered to that host. The
 *     React HostDetails dashboard already reads `?host=` via
 *     `useSearchParams()`.
 *   - `buildSplunkSearchUrl(spl, earliest, latest)` → Splunk's stock Search
 *     app with the SPL pre-populated. Used for cross-cutting drills (e.g.,
 *     Environment Health's "Total Errors" KPI runs an 11-sourcetype OR
 *     across the whole estate; no single dashboard owns it).
 *
 * Time range preservation: every drilldown URL embeds `?earliest=` and
 * `?latest=` query params. When opened in a new tab, the React
 * `TimeRangeProvider` parses the hash query string on mount and hydrates
 * its initial state from those values (overriding the default
 * `-30d@d` / `now`). For Splunk's Search app, those names are the
 * standard params Splunk's own Search UI uses.
 *
 * URL pattern for in-app dashboard (HashRouter):
 *   `/en-US/app/splunk_app_sap_logserv/home#<route>?earliest=...&latest=...`
 *
 * URL pattern for Splunk Search app:
 *   `/en-US/app/search/search?q=search%20<encoded-spl>&earliest=...&latest=...`
 *
 * `openInNewTab` is a small wrapper around `window.open(url, '_blank',
 * 'noopener,noreferrer')` so callers don't have to remember the security
 * flags. Always use this — never `window.open(url, '_blank')` alone (the
 * resulting popup retains an `opener` reference unless `noopener` is set,
 * a known reverse-tabnabbing vector).
 */

const APP_NAMESPACE = 'splunk_app_sap_logserv';

/** slug → path lookup, built once at module init. */
const SLUG_PATH_LOOKUP: Record<string, string> = (() => {
    const out: Record<string, string> = {};
    for (const d of dashboards) {
        out[d.slug] = d.path;
    }
    return out;
})();

/** Append `?earliest=...&latest=...` (or merge into existing query string)
 *  to the given URL. Pass-through when both are empty. */
const withTimeRange = (url: string, earliest?: string, latest?: string): string => {
    if (!earliest && !latest) return url;
    const sep = url.includes('?') ? '&' : '?';
    const params: string[] = [];
    if (earliest) params.push(`earliest=${encodeURIComponent(earliest)}`);
    if (latest) params.push(`latest=${encodeURIComponent(latest)}`);
    return `${url}${sep}${params.join('&')}`;
};

/** Build a URL that lands in the dashboard identified by `slug` with the
 *  given time range pre-applied. Returns null when slug is unknown — the
 *  caller should treat null as "skip rendering the link". */
export const buildDashboardUrl = (
    slug: string,
    earliest?: string,
    latest?: string,
): string | null => {
    const path = SLUG_PATH_LOOKUP[slug];
    if (!path) return null;
    // HashRouter convention: query string lives AFTER the hash route.
    const base = `/en-US/app/${APP_NAMESPACE}/home#${path}`;
    return withTimeRange(base, earliest, latest);
};

/** Build a Host Details URL filtered to the given host. */
export const buildHostDetailsUrl = (
    host: string,
    earliest?: string,
    latest?: string,
): string | null => {
    if (!host) return null;
    const base = `/en-US/app/${APP_NAMESPACE}/home#/platform/host-details?host=${encodeURIComponent(host)}`;
    return withTimeRange(base, earliest, latest);
};

/** Build a Splunk Search app URL with the given SPL pre-populated. The
 *  caller's SPL string is wrapped with a leading `search ` so it dispatches
 *  as a normal events search; if the SPL already has its own root command,
 *  that's typically harmless for `search` (it gets prepended verbatim). */
export const buildSplunkSearchUrl = (
    spl: string,
    earliest?: string,
    latest?: string,
): string => {
    // Splunk's Search app ignores duplicated `search` commands — `search search ...`
    // is normalized internally. We always prepend so callers can pass either a
    // bare expression or one starting with a generating command.
    const q = `search ${spl}`;
    const base = `/en-US/app/search/search?q=${encodeURIComponent(q)}`;
    return withTimeRange(base, earliest, latest);
};

/** Build a Splunk Search app URL for a panel's EXACT dispatched SPL (build 234,
 *  panel toolbar "Open in Search"). Unlike buildSplunkSearchUrl this does NOT
 *  blindly prepend `search ` — a panel query may start with a generating
 *  command (`| tstats …`, `| inputlookup …`), where `search | tstats` is
 *  invalid. Normalizes per the session-055 rule: leave leading `|` or `search `
 *  alone; otherwise prepend `search `. */
export const buildOpenInSearchUrl = (
    spl: string,
    earliest?: string,
    latest?: string,
): string => {
    const trimmed = spl.trim();
    const q = /^(\||search\b)/i.test(trimmed) ? trimmed : `search ${trimmed}`;
    const base = `/en-US/app/search/search?q=${encodeURIComponent(q)}`;
    return withTimeRange(base, earliest, latest);
};

/** Build a Splunk Job Inspector URL for a dispatched search-job SID (build 234,
 *  panel toolbar "Inspect"). Opens Splunk's native job inspector (execution
 *  costs / search.log / per-command timing) in a new tab. */
export const buildJobInspectorUrl = (sid: string): string =>
    `/en-US/manager/search/job_inspector?sid=${encodeURIComponent(sid)}`;

/** Build a results-export URL for a dispatched SID (build 234, panel toolbar
 *  "Download"). Hits the REST results endpoint through Splunk Web's proxy;
 *  opening it in a new tab streams the panel's results as CSV. */
export const buildResultsExportUrl = (
    sid: string,
    format: 'csv' | 'json' = 'csv',
): string =>
    `/en-US/splunkd/__raw/services/search/jobs/${encodeURIComponent(
        sid,
    )}/results?output_mode=${format}&count=0`;

/** Format an epoch-ms dispatch time as a compact relative "last run" string
 *  ("<1m ago", "5m ago", "2h ago", "3d ago") for the panel toolbar. */
export const formatLastRun = (dispatchedAtMs?: number): string | null => {
    if (!dispatchedAtMs) return null;
    const s = Math.max(0, Math.round((Date.now() - dispatchedAtMs) / 1000));
    if (s < 60) return '<1m ago';
    const m = Math.round(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.round(m / 60);
    if (h < 24) return `${h}h ago`;
    return `${Math.round(h / 24)}d ago`;
};

/** Open a URL in a new browser tab with the standard reverse-tabnabbing
 *  guard (`noopener,noreferrer`). Centralized so every drilldown call site
 *  doesn't have to remember the flags. */
export const openInNewTab = (url: string | null | undefined): void => {
    if (!url) return;
    window.open(url, '_blank', 'noopener,noreferrer');
};

/** Escape a row-context value for safe inclusion inside a quoted SPL string.
 *  Backslashes get doubled first, then double-quotes get backslash-escaped.
 *  Use whenever a row value (clientip, URI, peer_ip, query, etc.) is
 *  spliced into SPL like `field="${splQuote(row.URI)}"`. Build 159 / session
 *  027 task 6.
 *
 *  NB: this is for SPL value escaping, NOT URL encoding. The URL-encoding
 *  of the resulting SPL string happens later inside `buildSplunkSearchUrl`
 *  via `encodeURIComponent`. */
export const splQuote = (val: unknown): string => {
    const s = String(val ?? '');
    return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
};

/** Sourcetype → dashboard-slug lookup, used by HostDetails to route OUT
 *  to specialist dashboards (per the session 027 task 6 plan: HostDetails
 *  is a hub, not a source — drilldowns should NEVER loop back into
 *  HostDetails). Returns null when the sourcetype isn't mapped to a
 *  dashboard (caller can fall back to a `splunk-search` drilldown).
 *
 *  Build 159 / session 027 task 6. */
const SOURCETYPE_TO_DASHBOARD_SLUG: Record<string, string> = {
    'sap:hana:audit': 'hana-audit',
    'sap:hana:tracelogs': 'hana-trace',
    'sap:abap:audit': 'abap-security',
    'sap:abap:gateway': 'abap-security',
    'sap:abap:icm': 'abap-security',
    'sap:abap:dispatcher': 'abap-operations',
    'sap:abap:enqueueserver': 'abap-operations',
    'sap:abap:event': 'abap-operations',
    'sap:abap:messageserver': 'abap-operations',
    'sap:abap:sapstartsrv': 'abap-operations',
    'sap:abap:workprocess': 'work-process-performance',
    'sap:webdispatcher:access': 'web-dispatcher',
    'sap:scc:audit': 'cloud-connector',
    'sap:scc:http_access': 'cloud-connector',
    'sap:saprouter': 'sap-router',
    'sap:sapstartsrv': 'sap-services',
    'sap:saphostexec': 'sap-services',
    'XmlWinEventLog': 'windows',
    'XmlWinEventLog:Application': 'windows',
    'XmlWinEventLog:Security': 'windows',
    'XmlWinEventLog:System': 'windows',
    'XmlWinEventLog:Powershell': 'windows',
    'linux_secure': 'linux',
    'linux_messages_syslog': 'linux',
    'linux:cron': 'linux',
    'linux:warn': 'linux',
    'linux:sudolog': 'linux',
    'linux:slapd': 'linux',
    'syslog': 'linux',
    'squid:access': 'proxy',
    'isc:bind:query': 'dns-analytics',
    'isc:bind:network': 'dns-analytics',
    'isc:bind:transfer': 'dns-analytics',
    'isc:bind:lameserver': 'dns-analytics',
};

export const sourcetypeToDashboardSlug = (sourcetype: string): string | null => {
    if (!sourcetype) return null;
    return SOURCETYPE_TO_DASHBOARD_SLUG[sourcetype] ?? null;
};
