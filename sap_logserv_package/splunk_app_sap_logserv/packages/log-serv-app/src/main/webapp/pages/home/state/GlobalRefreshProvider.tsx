import React, {
    createContext,
    useCallback,
    useContext,
    useMemo,
    useState,
    ReactNode,
} from 'react';

/**
 * Global manual-refresh context (session 088).
 *
 * Mounts ONCE at the AppShell level — above both the NavigationBar (which owns
 * the manual Refresh button, right of the time-range picker) and the routed
 * dashboards (whose panels consume it). Clicking the button bumps
 * `globalRefreshNonce`; `useSearch` adds that value to its effective refresh
 * nonce, so every search on the current view re-dispatches with the currently
 * selected time range — no per-dashboard wiring.
 *
 * This is deliberately SEPARATE from the per-dashboard `RefreshProvider`
 * (state/RefreshProvider.tsx), which lives inside each DashboardLayout and drives
 * the auto-refresh-interval cadence. `useSearch` sums both nonces (+ the explicit
 * prop + its own per-panel Refresh-action nonce) additively, so the global manual
 * button, the per-dashboard interval, IntegrationTopology's own Refresh button,
 * and per-panel refresh all coexist.
 */

interface GlobalRefreshContextValue {
    /** Bumped each time the user clicks the nav-bar Refresh button. */
    globalRefreshNonce: number;
    /** Trigger a manual global refresh — re-runs every search on the current view
     *  with the current time range. Stable identity (useCallback). */
    triggerGlobalRefresh: () => void;
}

const GlobalRefreshContext = createContext<GlobalRefreshContextValue | undefined>(undefined);

export const GlobalRefreshProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
    const [globalRefreshNonce, setGlobalRefreshNonce] = useState<number>(0);
    const triggerGlobalRefresh = useCallback(
        () => setGlobalRefreshNonce((n) => n + 1),
        [],
    );
    const value = useMemo<GlobalRefreshContextValue>(
        () => ({ globalRefreshNonce, triggerGlobalRefresh }),
        [globalRefreshNonce, triggerGlobalRefresh],
    );
    return (
        <GlobalRefreshContext.Provider value={value}>{children}</GlobalRefreshContext.Provider>
    );
};

/** Read the global refresh context. Returns a zero-noop default when used
 *  OUTSIDE a GlobalRefreshProvider (tests / standalone rendering), so
 *  `useSearch` never needs the provider to function. */
export const useGlobalRefresh = (): GlobalRefreshContextValue => {
    const ctx = useContext(GlobalRefreshContext);
    if (!ctx) {
        return { globalRefreshNonce: 0, triggerGlobalRefresh: () => undefined };
    }
    return ctx;
};
