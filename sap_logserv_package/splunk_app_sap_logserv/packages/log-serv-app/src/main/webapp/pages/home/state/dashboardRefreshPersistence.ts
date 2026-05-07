import { username as splunkUsername } from '@splunk/splunk-utils/config';

/**
 * Per-user per-dashboard refresh-interval persistence (build 155 / session 027).
 *
 * Backend: Splunk KV Store collection `logserv_dashboard_refresh`. One
 * record per (user, dashboard_id) pair. Records are keyed by
 * `<username>::<dashboard_id>` so a single GET returns the user's saved
 * cadence for that dashboard.
 *
 * Modeled on `topology/persistence.ts` — same CSRF + headers conventions.
 * Simpler than the topology layout persistence: no schema versioning,
 * no localStorage fast-path (the picker tolerates a one-tick async
 * hydrate; refresh starts at "Never" until the saved value loads, which
 * is the safe default).
 *
 * `interval_ms` semantics:
 *   0      → "Never" (no auto-refresh)
 *   30000  → "30s"
 *   60000  → "1m"
 *   300000 → "5m"
 *   900000 → "15m"
 *   1800000 → "30m"
 *   3600000 → "1hr"
 *
 * KV Store unreachable (or user has no saved record) → callers see
 * `null`, which the provider treats as "default to Never".
 */

const APP_NAMESPACE = 'splunk_app_sap_logserv';
const COLLECTION = 'logserv_dashboard_refresh';
const KV_BASE =
    `/en-US/splunkd/__raw/servicesNS/nobody/${APP_NAMESPACE}` +
    `/storage/collections/data/${COLLECTION}`;

const safeUser = (): string => {
    try {
        const u = (splunkUsername as unknown as string) || '';
        return u.length > 0 ? u : 'anonymous';
    } catch (_e) {
        return 'anonymous';
    }
};

const recordKey = (dashboardId: string): string => `${safeUser()}::${dashboardId}`;

// ---- CSRF / auth helpers (mirror topology/persistence.ts) ----

const readCsrfToken = (): string => {
    const m = (`; ${document.cookie}`).match(
        /; splunkweb_csrf_token_\d+=([^;]+)/,
    );
    return m ? decodeURIComponent(m[1]) : '';
};

const sharedHeaders = (): Record<string, string> => ({
    'X-Requested-With': 'XMLHttpRequest',
});

const mutatingHeaders = (): Record<string, string> => ({
    ...sharedHeaders(),
    'Content-Type': 'application/json',
    'X-Splunk-Form-Key': readCsrfToken(),
});

interface KvStoreRecord {
    _key: string;
    username: string;
    dashboard_id: string;
    interval_ms: number;
    updated_at: string;
}

/** Convert a hash-router pathname (e.g. "/platform/host-details", "/") to a
 *  KV-Store-key-safe dashboard id ("platform-host-details", "home"). Used by
 *  RefreshProvider to derive the id from useLocation() so per-dashboard
 *  changes are zero. */
export const dashboardIdFromPath = (pathname: string): string => {
    if (!pathname || pathname === '/') return 'home';
    const trimmed = pathname.replace(/^\/+|\/+$/g, '');
    return trimmed
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60);
};

/** Load this user's saved interval for the given dashboard. Returns null
 *  on missing record / KV Store unreachable / parse failure (caller treats
 *  null as "Never"). */
export const loadDashboardInterval = async (
    dashboardId: string,
): Promise<number | null> => {
    if (!dashboardId) return null;
    try {
        const url = `${KV_BASE}/${encodeURIComponent(recordKey(dashboardId))}?output_mode=json`;
        const resp = await fetch(url, {
            credentials: 'same-origin',
            headers: sharedHeaders(),
        });
        if (!resp.ok) return null;
        const record = (await resp.json()) as KvStoreRecord;
        const n = Number(record.interval_ms);
        return Number.isFinite(n) && n >= 0 ? n : null;
    } catch (_e) {
        return null;
    }
};

/** Persist this user's chosen interval for the given dashboard. Two-step
 *  write modeled on saveLayoutNamed: POST /<key> first; on 404 fall back
 *  to a collection-level POST.
 *
 *  Returns true on success, false on failure. Failures are silently
 *  tolerated — the in-memory state stays correct for this tab even if
 *  the persist fails (no UX block). */
export const saveDashboardInterval = async (
    dashboardId: string,
    intervalMs: number,
): Promise<boolean> => {
    if (!dashboardId) return false;
    if (!Number.isFinite(intervalMs) || intervalMs < 0) return false;

    const u = safeUser();
    const key = recordKey(dashboardId);
    const record: KvStoreRecord = {
        _key: key,
        username: u,
        dashboard_id: dashboardId,
        interval_ms: intervalMs,
        updated_at: new Date().toISOString(),
    };
    try {
        let resp = await fetch(`${KV_BASE}/${encodeURIComponent(key)}`, {
            method: 'POST',
            credentials: 'same-origin',
            headers: mutatingHeaders(),
            body: JSON.stringify(record),
        });
        if (resp.status === 404) {
            resp = await fetch(KV_BASE, {
                method: 'POST',
                credentials: 'same-origin',
                headers: mutatingHeaders(),
                body: JSON.stringify(record),
            });
        }
        return resp.ok;
    } catch (_e) {
        return false;
    }
};
