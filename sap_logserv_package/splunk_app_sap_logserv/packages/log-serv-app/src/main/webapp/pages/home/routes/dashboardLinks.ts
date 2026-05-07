import { dashboards } from './dashboardRegistry';

/**
 * Dashboard-link helpers (build 156 / session 027).
 *
 * The AI Assistant chat citation parser and the right-pane ToolResultPanel
 * both need to convert a dashboard slug (e.g. "hana-audit") to:
 *   - an absolute Splunk-Web URL the user can open in a new tab
 *   - a human-readable label for the link text / tooltip
 *
 * Why a dedicated module: both consumers need the SAME mapping, and the
 * URL pattern (`/en-US/app/splunk_app_sap_logserv/home#<route>`) is a
 * project-wide convention worth centralizing. Keeps the lookup O(1) at
 * call time (lookup map built once at module init).
 */

const APP_NAMESPACE = 'splunk_app_sap_logserv';

interface DashboardLinkInfo {
    slug: string;
    name: string;
    url: string;
}

/** slug → { name, url } lookup, built once at module init. */
const SLUG_LOOKUP: Record<string, DashboardLinkInfo> = (() => {
    const out: Record<string, DashboardLinkInfo> = {};
    for (const d of dashboards) {
        out[d.slug] = {
            slug: d.slug,
            name: d.name,
            // HashRouter URL — relative so it works regardless of host /
            // port. Splunk Web's URL pattern for an app's React page is
            // `/en-US/app/<app>/home#<react-route>`. The `home` segment is
            // the page id under `appserver/templates/home.html` that
            // bootstraps the React app.
            url: `/en-US/app/${APP_NAMESPACE}/home#${d.path}`,
        };
    }
    return out;
})();

/** Resolve a slug to its link info, or null when the slug isn't registered.
 *  Callers should treat null as "skip rendering the link" — the intent map's
 *  consistency test guarantees every emitted slug is valid, so a null at
 *  runtime indicates either (a) a slug from a future intent-map version we
 *  haven't shipped a registry update for, or (b) a programmer bug. Both
 *  cases benefit from silently skipping rather than rendering a broken
 *  link. */
export const resolveDashboardLink = (slug: string): DashboardLinkInfo | null => {
    if (!slug) return null;
    return SLUG_LOOKUP[slug] ?? null;
};

/** Resolve a single slug or an array of slugs to a non-empty array of
 *  link infos. Filters out unresolvable slugs. Returns [] when nothing
 *  resolves — caller should treat as "no dashboard link to render". */
export const resolveDashboardLinks = (
    slugs: string | string[] | undefined,
): DashboardLinkInfo[] => {
    if (!slugs) return [];
    const arr = Array.isArray(slugs) ? slugs : [slugs];
    const out: DashboardLinkInfo[] = [];
    for (const slug of arr) {
        const info = resolveDashboardLink(slug);
        if (info) out.push(info);
    }
    return out;
};

export type { DashboardLinkInfo };
