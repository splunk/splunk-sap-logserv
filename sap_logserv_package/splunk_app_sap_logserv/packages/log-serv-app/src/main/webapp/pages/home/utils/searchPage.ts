/**
 * Where the App sends a user to Splunk's search page and Job Inspector
 * (build 399).
 *
 * Every link opens in this app's own namespace, never in Splunk's `search`
 * app: some sites disable the Search app (one app per department, for
 * example), and every Open in Search link, Splunk Search drilldown, AI
 * Assistant "Run SPL" chip and Inspect button then led to an error page.
 * The app ships its own `search` view (default/data/ui/views/search.xml,
 * export = none in metadata/default.meta), so the search page does not
 * depend on the Search app's view either.
 *
 * No imports: utils/drilldownUrls.ts and hooks/useAIAssistant.ts both use
 * these, and the hook must not pull in the dashboard registry.
 * Pinned by searchLinks.consistency-test.ts.
 */

/** This app's ID, the namespace every search link opens in. */
export const SEARCH_LINK_APP = 'splunk_app_sap_logserv';

/** Splunk's search page inside this app. */
export const SEARCH_PAGE_PATH = `/en-US/app/${SEARCH_LINK_APP}/search`;

/** Splunk's Job Inspector inside this app. */
export const JOB_INSPECTOR_PATH = `/en-US/manager/${SEARCH_LINK_APP}/job_inspector`;
