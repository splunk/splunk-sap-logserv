import { DashboardInfo, dashboards } from '../routes/dashboardRegistry';

/**
 * Resolves a dashboard's published-docs URL.
 *
 * Docs root is the GitHub Pages site that publishes the v0.0.5.0 mkdocs
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

const DOCS_ROOT = 'https://splunk.github.io/splunk-sap-logserv';

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
 * Returns the docs URL for the dashboard at the given pathname, or
 * null if the pathname doesn't correspond to a registered dashboard
 * (e.g., the AI Assistant Settings page or any other non-dashboard
 * screen — those don't get a docs link this round).
 */
export const resolveDocsUrl = (pathname: string): string | null => {
    const info = dashboards.find((d) => d.path === pathname);
    if (!info) return null;
    return buildDocsUrl(info);
};
