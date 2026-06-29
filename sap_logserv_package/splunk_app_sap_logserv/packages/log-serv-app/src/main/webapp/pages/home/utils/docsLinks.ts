import { DashboardInfo, dashboards } from '../routes/dashboardRegistry';

/**
 * Resolves a dashboard's published-docs URL.
 *
 * Docs root is the GitHub Pages site that publishes the v0.1.1 mkdocs
 * output. URL pattern follows the mkdocs `use_directory_urls: true`
 * default — `/<dir>/<page>/` (no .html extension, trailing slash).
 *
 * Most dashboard slugs map mechanically to a docs page at
 * `content/logserv-app/dashboards/<category>/<slug>.md`. Two exceptions
 * use category-only fallback pages because the React app exposes them
 * as their own dashboards but the docs ship them as a single category
 * landing page:
 *
 *  - `home` (Environment Health) → `dashboards/environment-health/`
 *    (file lives at the dashboards/ root, not in a subdir)
 *  - `topology` (Environment Topology) → `dashboards/topology/`
 *    (single topology.md page, no per-dashboard subdir)
 */

export const DOCS_ROOT = 'https://splunk.github.io/splunk-sap-logserv';

/**
 * Static path-to-docs mappings for non-dashboard routes (e.g., the AI
 * Assistant Settings page). Dashboard routes use the dynamic
 * buildDocsUrl() below; everything else falls through to this map.
 */
const STATIC_PATH_DOCS: Record<string, string> = {
    '/settings': `${DOCS_ROOT}/content/ai-assistant/settings/`,
    // alias for the pre-build-245 route, in case the help icon resolves before
    // the AppShell redirect fires.
    '/settings/ai-assistant': `${DOCS_ROOT}/content/ai-assistant/settings/`,
};

/**
 * Convenience constants for surfaces that aren't tied to a React Router
 * pathname (e.g., the AI Assistant chat panel, which is a docked side
 * drawer that overlays whichever route is active).
 */
export const DOCS_AI_ASSISTANT_OVERVIEW = `${DOCS_ROOT}/content/ai-assistant/overview/`;

const buildDocsUrl = (info: DashboardInfo): string => {
    const { category, slug } = info;
    if (category === 'home') {
        return `${DOCS_ROOT}/content/logserv-app/dashboards/${slug}/`;
    }
    if (category === 'topology') {
        return `${DOCS_ROOT}/content/logserv-app/dashboards/topology/`;
    }
    return `${DOCS_ROOT}/content/logserv-app/dashboards/${category}/${slug}/`;
};

/**
 * Returns the docs URL for the dashboard at the given pathname, or for
 * known static (non-dashboard) routes like the Settings page. Returns
 * null for any pathname not in the dashboard registry or the static
 * map, in which case `DocsHelpIcon` renders nothing.
 */
export const resolveDocsUrl = (pathname: string): string | null => {
    const info = dashboards.find((d) => d.path === pathname);
    if (info) return buildDocsUrl(info);
    if (pathname in STATIC_PATH_DOCS) return STATIC_PATH_DOCS[pathname];
    return null;
};
