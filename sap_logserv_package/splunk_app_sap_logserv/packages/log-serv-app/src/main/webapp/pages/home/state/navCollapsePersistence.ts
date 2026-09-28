import { username as splunkUsername } from '@splunk/splunk-utils/config';

/**
 * Per-user persistence for the left rail's collapsed/expanded state
 * (Phase 7 / build 339 — plan `cisco_magnetic_theme_plan_v0.2_20260920.md` §16.5).
 *
 * Backend TODAY: `localStorage` only, keyed by Splunk username.
 *
 * The plan's §16.5 asks for the build-226/230 shape — localStorage as the
 * fast-mount cache with a Splunk KV Store collection as the cross-browser
 * source of truth, behind an async hydration gate. That mirror is a
 * deliberate follow-on, not shipped here; this module exists so adding it
 * is an ADDITION rather than a rewrite. When it lands:
 *
 *   1. add `fetchNavCollapsedFromKvStore(): Promise<boolean | null>` and
 *      `setNavCollapsedInKvStore(v: boolean): Promise<void>` here, modelled
 *      on `state/dashboardRefreshPersistence.ts` (same CSRF + KV_BASE
 *      conventions, `/en-US/splunkd/__raw/servicesNS/nobody/<app>/…`);
 *   2. have `writeCachedNavCollapsed` write through to BOTH;
 *   3. gate the consumer's auto-apply on a `hydrated` boolean that only
 *      flips once the fetch settles — success OR failure. Build 230's
 *      `activeModeHydrated` bug is the precedent and it is subtle: without
 *      the gate, an effect keyed on the synchronous localStorage value runs
 *      before the async KV value arrives and writes the stale value back.
 *
 * Every accessor is total — a browser with storage disabled (private
 * window, blocked site data, the `data:` URL case) throws on access, so
 * both reads and writes are wrapped and the reader falls back to
 * "expanded", which is the state that makes the app navigable.
 */

/** localStorage key prefix. Per-user so two operators sharing a browser
 *  profile do not inherit each other's rail state — same convention as
 *  `logserv.topology.layoutMode` (build 200) and the build-216 per-mode
 *  default-layout keys. */
const KEY_PREFIX = 'logserv.nav.collapsed';

const safeUser = (): string => {
    try {
        const u = (splunkUsername as unknown as string) || '';
        return u.length > 0 ? u : 'anonymous';
    } catch (_e) {
        return 'anonymous';
    }
};

const storageKey = (): string => `${KEY_PREFIX}.${safeUser()}`;

/** Synchronous mount-time read. `false` (expanded) whenever nothing is
 *  stored or storage is unavailable — never throws. */
export const readCachedNavCollapsed = (): boolean => {
    try {
        return window.localStorage.getItem(storageKey()) === '1';
    } catch (_e) {
        return false;
    }
};

/** Best-effort write. Fire-and-forget by design: a UX preference must never
 *  block or fail the interaction that produced it (same rule as
 *  `topology/persistence.ts` `saveLayoutNamed`). */
export const writeCachedNavCollapsed = (collapsed: boolean): void => {
    try {
        window.localStorage.setItem(storageKey(), collapsed ? '1' : '0');
    } catch (_e) {
        /* storage unavailable — the preference simply does not persist */
    }
};
