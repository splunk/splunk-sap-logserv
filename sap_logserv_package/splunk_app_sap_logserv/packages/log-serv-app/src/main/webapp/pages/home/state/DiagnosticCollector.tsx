import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef } from 'react';

/**
 * DiagnosticCollector — a page-level registry of every search a dashboard
 * dispatched (session 093, Phase 1 of the Missing-Data Diagnostic).
 *
 * WHY INSTRUMENT `useSearch` RATHER THAN THE PANELS
 * -------------------------------------------------
 * The obvious place to collect "what did this panel run" is `FramedPanel` —
 * and it is the wrong place. `FramedPanel` never sees:
 *   - KPI cards (each dashboard's local `useFirstRowField` helper),
 *   - sparklines (`SparklineFromQuery`),
 *   - the topology right-pane hooks,
 *   - and, worst, `ConditionalPanel`, which renders `null` when its search is
 *     loading, errored, or empty — i.e. it unmounts the panel PRECISELY in the
 *     situation the diagnostic exists to explain.
 *
 * Every one of those paths funnels through `hooks/useSearch.ts` (339 runtime
 * invocations across the app; `useHybridSearch` delegates to it, each
 * dashboard's `useFirstRowField*` delegates to that, and the chart components
 * call it directly). Registering there is two files for 100% coverage and zero
 * per-dashboard edits.
 *
 * WHY A REF, NOT STATE
 * --------------------
 * This registry sits in the hot path of ~339 hook invocations per page. If the
 * store were `useState`, every search transition (dispatch, results, refresh
 * tick, time-range change) would re-render the whole dashboard subtree — the
 * diagnostic would become the outage it is meant to diagnose (design doc,
 * Risk 5). A `useRef`-backed `Map` makes registration a pure side-effect that
 * triggers no render at all. Consumers read it on demand via `getSnapshot()`.
 *
 * Consequence, deliberately accepted: a component cannot *subscribe* to the
 * registry. Phase 1 does not need to — the empty-state hint is computed from
 * the panel's own search state, locally. A future diagnostics UI reads the
 * snapshot when the user opens it, which is exactly when it matters.
 *
 * The context default is a NO-OP, mirroring `PanelMetaContext`, so a
 * `useSearch` call rendered outside a `DashboardLayout` (tests, the Settings
 * page, standalone rendering) registers into the void instead of throwing.
 */

export interface SearchRegistration {
    /** Stable per hook instance for the lifetime of the component. */
    id: string;
    /** The dispatched SPL, verbatim. */
    spl: string;
    /** Dispatched job SID; undefined until it resolves (or if never dispatched). */
    sid?: string;
    /** Epoch-ms of the last dispatch. */
    dispatchedAt?: number;
    /** The time window the search ACTUALLY ran over — the caller's explicit
     *  earliest/latest when given, otherwise the global picker's. "0 rows" is
     *  meaningless without this, and it is not the picker's current value for
     *  the handful of panels that override the range (the topology right pane
     *  pins `-24h`). */
    earliest: string;
    latest: string;
    /** False when the hook was mounted but deliberately dispatched nothing
     *  (`enabled: false`, or an empty query). Distinguishes "never ran" from
     *  "ran and found nothing" — the hook's early return leaves the previous
     *  results in place, so `rowCount` alone cannot tell them apart. */
    dispatched: boolean;
    loading: boolean;
    /** Error message, or null. */
    errorMessage: string | null;
    /** Row count, or null when no result has arrived yet. */
    rowCount: number | null;
}

interface DiagnosticCollectorCtx {
    /** Upsert (entry) or remove (null) a registration. Stable identity. */
    register: (id: string, entry: SearchRegistration | null) => void;
    /** Every currently-mounted search on this page. Ordered by registration. */
    getSnapshot: () => SearchRegistration[];
}

const NOOP_CTX: DiagnosticCollectorCtx = {
    register: () => undefined,
    getSnapshot: () => [],
};

const DiagnosticCollectorContext = createContext<DiagnosticCollectorCtx>(NOOP_CTX);

export const DiagnosticCollectorProvider: React.FC<{ children: React.ReactNode }> = ({
    children,
}) => {
    // A Map preserves insertion order, which is roughly top-to-bottom panel
    // order on the page — a useful default ordering for a future report.
    const storeRef = useRef<Map<string, SearchRegistration>>(new Map());

    const register = useCallback((id: string, entry: SearchRegistration | null): void => {
        if (entry === null) storeRef.current.delete(id);
        else storeRef.current.set(id, entry);
    }, []);

    const getSnapshot = useCallback(
        (): SearchRegistration[] => Array.from(storeRef.current.values()),
        [],
    );

    /* Session 095 (reports) — mirror the ACTIVE page's snapshot into a
     * module-level slot. The "Diagnose this dashboard" action lives in
     * `ActionsDropdown`, which is mounted in the NavigationBar — OUTSIDE this
     * per-page provider — so through React context alone it would read the
     * NO-OP default and see an empty page forever. Exactly one DashboardLayout
     * (and therefore one provider) is mounted at a time, so a singleton
     * mirror is sound; it follows the `beginDiagnosis` active-runner pattern.
     * Cleared on unmount so a route without a DashboardLayout reads []. */
    useEffect(() => {
        activeSnapshotFn = getSnapshot;
        return () => {
            if (activeSnapshotFn === getSnapshot) activeSnapshotFn = null;
        };
    }, [getSnapshot]);

    // Both callbacks are `[]`-stable, so this value never changes identity and
    // the registering effect in `useSearch` never re-fires because of it.
    const value = useMemo<DiagnosticCollectorCtx>(
        () => ({ register, getSnapshot }),
        [register, getSnapshot],
    );

    return (
        <DiagnosticCollectorContext.Provider value={value}>
            {children}
        </DiagnosticCollectorContext.Provider>
    );
};

export const useDiagnosticCollector = (): DiagnosticCollectorCtx =>
    useContext(DiagnosticCollectorContext);

/** The active page's snapshot function — see the mount effect above. */
let activeSnapshotFn: (() => SearchRegistration[]) | null = null;

/** Every search the CURRENTLY MOUNTED dashboard page has registered, readable
 *  from outside the provider tree (the nav-bar Actions menu). Empty when no
 *  DashboardLayout is mounted (Settings, or between routes). */
export const getActivePageSnapshot = (): SearchRegistration[] =>
    activeSnapshotFn ? activeSnapshotFn() : [];

/** Monotonic id source for `useSearch` instances. Module-scoped so ids stay
 *  unique across every provider on the page. */
let idCounter = 0;
export const nextSearchInstanceId = (): string => {
    idCounter += 1;
    return `s${idCounter}`;
};
