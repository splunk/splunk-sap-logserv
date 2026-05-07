import React, {
    createContext,
    useContext,
    useEffect,
    useMemo,
    useRef,
    useState,
    ReactNode,
} from 'react';
import {
    loadDashboardInterval,
    saveDashboardInterval,
} from './dashboardRefreshPersistence';

/**
 * Per-dashboard auto-refresh context (build 155 / session 027).
 *
 * Mounts inside `DashboardLayout` (one provider per dashboard). On mount,
 * loads this user's saved interval for the active dashboard from KV Store.
 * Until the load resolves, defaults to `0` ("Never"). When the user picks
 * a new interval via `RefreshIntervalPicker`, `setIntervalMs` updates
 * local state and writes back to KV Store (best-effort; failures don't
 * block the UI).
 *
 * `refreshNonce` ticks at the chosen interval. `useSearch` reads this
 * value and combines it with any explicit `refreshNonce` prop the
 * caller passed (additive sum) — so dashboards like
 * IntegrationTopology that drive their own manual Refresh button via
 * `setRefreshNonce` continue to work alongside the global picker.
 *
 * Per-dashboard isolation: when the user navigates to a different
 * dashboard, DashboardLayout's `dashboardId` changes, the provider
 * re-mounts, the previous interval is forgotten in-memory, and the new
 * dashboard's saved interval loads fresh.
 *
 * Hydrate-loading: `loading` is true while the initial KV Store fetch is
 * in flight. The picker uses this to render a disabled placeholder so
 * the user can't pick + write a value before the saved value arrives
 * (which would cause a flicker if the saved value differed).
 */

interface RefreshContextValue {
    /** Currently chosen interval in ms. 0 = "Never". */
    intervalMs: number;
    /** Set a new interval. Persists to KV Store + updates local state. */
    setIntervalMs: (ms: number) => void;
    /** Tick counter — bumped every `intervalMs` ms while interval > 0.
     *  Wired through `useSearch` so all subscribed dashboards re-run on tick. */
    refreshNonce: number;
    /** True until the initial KV Store fetch resolves. */
    loading: boolean;
}

const RefreshContext = createContext<RefreshContextValue | undefined>(undefined);

interface ProviderProps {
    /** Stable per-dashboard identifier (URL slug). Forms the KV Store key
     *  with the current user. Provider re-mounts when this changes, so
     *  React Router will give us a fresh context per dashboard
     *  automatically as long as DashboardLayout passes the location-derived
     *  id and includes it in the key. */
    dashboardId: string;
    children: ReactNode;
}

export const RefreshProvider: React.FC<ProviderProps> = ({ dashboardId, children }) => {
    const [intervalMs, setLocalIntervalMs] = useState<number>(0);
    const [refreshNonce, setRefreshNonce] = useState<number>(0);
    const [loading, setLoading] = useState<boolean>(true);

    // Track the dashboardId the loaded value belongs to — guards against
    // a slow load returning AFTER the user has already navigated away
    // (we'd otherwise stamp the wrong dashboard's saved value into the
    // new dashboard's state).
    const lastLoadedDashboardId = useRef<string | null>(null);

    // Load the saved interval whenever dashboardId changes. Failures
    // resolve to null → default to 0 ("Never"). Cancelled flag prevents
    // setState after unmount during hot route changes.
    useEffect(() => {
        let cancelled = false;
        setLoading(true);
        // Reset refreshNonce so a route change doesn't leak the prior
        // dashboard's tick count into the new one. Doesn't trigger a
        // re-fetch by itself (useSearch's deps include refreshNonce, but
        // the route change already remounts the dashboard component
        // tree, which re-runs every useSearch from scratch).
        setRefreshNonce(0);
        (async (): Promise<void> => {
            const saved = await loadDashboardInterval(dashboardId);
            if (cancelled) return;
            const next = saved ?? 0;
            setLocalIntervalMs(next);
            lastLoadedDashboardId.current = dashboardId;
            setLoading(false);
        })();
        return () => {
            cancelled = true;
        };
    }, [dashboardId]);

    // Tick the nonce on the chosen interval. setInterval restarts whenever
    // intervalMs changes (picker move). 0 disables the timer entirely.
    useEffect(() => {
        if (!intervalMs || intervalMs <= 0) return undefined;
        const id = window.setInterval(() => {
            setRefreshNonce((n) => n + 1);
        }, intervalMs);
        return () => window.clearInterval(id);
    }, [intervalMs]);

    // Public setter: optimistic local state update + best-effort persist.
    const setIntervalMs = useMemo(
        () => (ms: number): void => {
            setLocalIntervalMs(ms);
            // Fire-and-forget; persist failures are silent.
            saveDashboardInterval(dashboardId, ms).catch(() => undefined);
        },
        [dashboardId],
    );

    const value = useMemo<RefreshContextValue>(
        () => ({ intervalMs, setIntervalMs, refreshNonce, loading }),
        [intervalMs, setIntervalMs, refreshNonce, loading],
    );

    return <RefreshContext.Provider value={value}>{children}</RefreshContext.Provider>;
};

/** Read the refresh context. Returns a zero-noop default when NOT inside a
 *  RefreshProvider — this lets `useSearch` work in tests / standalone
 *  rendering without forcing every consumer to wrap their tree. */
export const useRefreshContext = (): RefreshContextValue => {
    const ctx = useContext(RefreshContext);
    if (!ctx) {
        return {
            intervalMs: 0,
            setIntervalMs: () => undefined,
            refreshNonce: 0,
            loading: false,
        };
    }
    return ctx;
};
