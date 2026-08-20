import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import styled from 'styled-components';
import { ReactFlowProvider } from '@xyflow/react';
import DashboardLayout from '../components/DashboardLayout';
import Spinner from '../components/Spinner';
import TopologyGraph, { type TopologyGraphHandle } from '../components/topology/TopologyGraph';
import TopologyToolbar from '../components/topology/TopologyToolbar';
import TopologyLeftSidebar from '../components/topology/TopologyLeftSidebar';
import TopologyRightSidebar, { type RightTab, type EdgeRightTab } from '../components/topology/TopologyRightSidebar';
import TopologyBottomPanel from '../components/topology/TopologyBottomPanel';
import LayoutNameModal from '../components/topology/LayoutNameModal';
import ManageLayoutsModal from '../components/topology/ManageLayoutsModal';
import { logservTheme } from '../styles/logservTheme';
import { useTopologyData, resolveTimeSpec } from '../hooks/useTopologyData';
import { useNodeData } from '../hooks/useNodeData';
import { useEdgeData } from '../hooks/useEdgeData';
import { useSearch } from '../hooks/useSearch';
import { useTimeRange } from '../state/TimeRangeProvider';
import { SEARCH_NODE_HOST_COUNTS } from '../topology/searches';
import HostCountContext from '../components/topology/HostCountContext';
import IpEnrichmentContext from '../components/topology/IpEnrichmentContext';
import { useIpEnrichment } from '../hooks/useIpEnrichment';
import { ALL_INTEGRATION_TYPES } from '../topology/edgeStyle';
import type { TrafficRow } from '../topology/panelFacts';
import {
    loadCachedLayout,
    saveLayoutNamed,
    loadLayoutBySlug,
    listLayouts,
    deleteLayout as deleteLayoutFromStore,
    clearCachedActiveLayout,
    migrateLegacyLocalStorageLayout,
    slugifyLayoutName,
    getDefaultLayoutSlug,
    setDefaultLayoutSlug,
    getAllDefaultLayoutSlugs,
    setDefaultLayoutInKvStore,
    fetchDefaultLayoutSlugsFromKvStore,
    migrateLegacyLocalStorageDefaultLayouts,
    fetchActiveLayoutModeFromKvStore,
    setActiveLayoutModeInKvStore,
    migrateLegacyLocalStorageActiveMode,
    type LayoutSummary,
} from '../topology/persistence';
import {
    DEFAULT_PANEL_LAYOUT,
    type IntegrationType,
    type SavedLayout,
    type PanelLayoutState,
} from '../topology/types';
import { type LayoutMode } from '../topology/layout';

/* localStorage key for the user's preferred layout algorithm. Persists
 * the toolbar's Force / Layered toggle across page loads. Build 200. */
const LAYOUT_MODE_STORAGE_KEY = 'logserv.topology.layoutMode';

/** Stable identity for "this node has no traffic rows" (build 322). */
const EMPTY_TRAFFIC_ROWS: TrafficRow[] = [];

const readPersistedLayoutMode = (): LayoutMode => {
    try {
        const v = window.localStorage.getItem(LAYOUT_MODE_STORAGE_KEY);
        if (v === 'layered' || v === 'force' || v === 'tree') return v;
    } catch (_e) { /* ignore */ }
    return 'force';
};

const writePersistedLayoutMode = (mode: LayoutMode): void => {
    try {
        window.localStorage.setItem(LAYOUT_MODE_STORAGE_KEY, mode);
    } catch (_e) { /* ignore */ }
};

/**
 * Environment Topology — Phase 1 prototype dashboard.
 * (Component file is named IntegrationTopology.tsx + URL slug
 * `integration-topology` for backward compat with saved layouts;
 * user-visible label was renamed in build 116.)
 *
 * Layout: 4-zone shell wrapping the @xyflow/react graph in the center.
 *   - Top: TopologyToolbar (title, stats, mode toggles, save/reset/export)
 *   - Left: TopologyLeftSidebar (systems list, integration-type filter chips,
 *     business-process filter chips). Resizable + collapsible.
 *   - Center: TopologyGraph (the @xyflow/react canvas). Always visible.
 *   - Right: TopologyRightSidebar (selected-node detail w/ inline charts).
 *     Resizable + collapsible.
 *   - Bottom: TopologyBottomPanel (live activity table + sparkline).
 *     Resizable + collapsible.
 *
 * Resize: drag handles between zones, mouse-captured, persisted on Save.
 * Collapse: each zone has a header chevron; collapsed zone shrinks to a
 *   thin tab with an expand chevron.
 *
 * Data: real SPL aggregations via `useTopologyData` hook (Phase 2 / s023).
 *   - Inventory query (sap:abap:gateway L= field + Splunk host field)
 *     produces canonical IP/host -> SID resolutions.
 *   - 5 edge-source searches (RFC, HANA cross-stack, web dispatcher, plus
 *     activity table and calls-per-hour sparkline) feed nodes + edges.
 *   - All 6 searches respect the global TimeRangeProvider via useSearch.
 * Persistence: per-Splunk-user via localStorage v2 schema (nodes + panels).
 */

const LEFT_MIN = 180;
const LEFT_MAX = 480;
const RIGHT_MIN = 220;
const RIGHT_MAX = 520;
const BOTTOM_MIN = 120;
const BOTTOM_MAX = 640;
const COLLAPSED_W = 26;
const COLLAPSED_H = 28;

const PageColumn = styled.div`
    display: flex;
    flex-direction: column;
    gap: ${logservTheme.spacing.md};
    /* Page header (DashboardLayout title + category eyebrow) consumes ~150 px;
     * subtract that plus a small breathing margin from the viewport.
     * (A session-081 attempt to replace this with a live-measured viewport
     * budget + negative bottom margin regressed into page scrolling on the
     * user's setup — build 280 restores the fixed budget. The Live
     * Activity panel instead completes its outline at any height via
     * FramedPanel fillHeight + internal table scroll.) */
    height: calc(100vh - 170px);
    min-height: 720px;
`;

const ColumnRow = styled.div`
    display: flex;
    flex: 1 1 auto;
    gap: ${logservTheme.spacing.md};
    min-height: 0;
`;

const ZoneScroll = styled.div`
    overflow: auto;
    height: 100%;
    /* Build 197 — reserve scrollbar gutter so the cyan FramedPanel border
     * isn't visually clipped by the overlay scrollbar. The "stable" value
     * adds a permanent gutter even when the scrollbar is hidden, keeping
     * content + the panel right edge consistently positioned. Used by the
     * left sidebar (Systems + Integration types panels), where the right
     * edge of the cyan border sits inside the page and needs the gutter
     * to keep it visually crisp.
     */
    scrollbar-gutter: stable;
`;

/* Build 233 / session 038 — variant of ZoneScroll for the right sidebar.
 * Drops scrollbar-gutter because the right panel's right edge IS the
 * page's right edge: a reserved gutter would push the cyan FramedPanel
 * border inward by ~16 px, breaking right-alignment with the chrome above
 * (Refresh-interval picker, help icon). When a scrollbar IS needed inside
 * the right sidebar, the overlay scrollbar (macOS / Windows 10+ default)
 * floats over the panel border without taking width — acceptable trade
 * vs. the constant misalignment.
 */
const RightZoneScroll = styled.div`
    overflow: auto;
    height: 100%;
`;

const LeftZone = styled.div<{ $w: number; $collapsed: boolean }>`
    width: ${(p) => (p.$collapsed ? `${COLLAPSED_W}px` : `${p.$w}px`)};
    flex-shrink: 0;
    min-width: 0;
    overflow: hidden;
    transition: width 180ms ease-out;
`;

const RightZone = styled.div<{ $w: number; $collapsed: boolean }>`
    width: ${(p) => (p.$collapsed ? `${COLLAPSED_W}px` : `${p.$w}px`)};
    flex-shrink: 0;
    min-width: 0;
    overflow: hidden;
    transition: width 180ms ease-out;
`;

const CenterZone = styled.div`
    flex: 1 1 auto;
    min-width: 0;
    min-height: 0;
`;

const CenterFrame = styled.div`
    background: ${logservTheme.colors.panelBackground};
    border: 1px solid ${logservTheme.colors.panelBorder};
    border-radius: ${logservTheme.radius.small};
    height: 100%;
    overflow: hidden;
    contain: layout paint;
    /* Build 166: position context for the CanvasLoadingOverlay child. */
    position: relative;
`;

const BottomZone = styled.div<{ $h: number; $collapsed: boolean }>`
    height: ${(p) => (p.$collapsed ? `${COLLAPSED_H}px` : `${p.$h}px`)};
    flex-shrink: 0;
    overflow: hidden;
    transition: height 180ms ease-out;
`;

const VDivider = styled.div`
    width: 6px;
    flex-shrink: 0;
    cursor: col-resize;
    background: ${logservTheme.colors.panelBorderWeak};
    border-radius: 3px;
    transition: background-color 80ms ease-out;
    /* Make the click target slightly bigger than the visual without
     * shifting layout — invisible padding via box-shadow inset. */
    &:hover {
        background: ${logservTheme.colors.cyanAccent};
    }
    &:active {
        background: ${logservTheme.colors.cyanLight};
    }
`;

const HDivider = styled.div`
    height: 6px;
    flex-shrink: 0;
    cursor: row-resize;
    background: ${logservTheme.colors.panelBorderWeak};
    border-radius: 3px;
    transition: background-color 80ms ease-out;
    &:hover {
        background: ${logservTheme.colors.cyanAccent};
    }
    &:active {
        background: ${logservTheme.colors.cyanLight};
    }
`;

const StatusBanner = styled.div<{ $kind: 'loading' | 'error' | 'empty' }>`
    background: ${(p) =>
        p.$kind === 'error'
            ? logservTheme.colors.tableHeaderBackground
            : logservTheme.colors.panelBackground};
    color: ${(p) =>
        p.$kind === 'error'
            ? logservTheme.colors.red
            : p.$kind === 'empty'
              ? logservTheme.colors.textMuted
              : logservTheme.colors.cyanLight};
    border: 1px solid ${(p) =>
        p.$kind === 'error'
            ? logservTheme.colors.red
            : logservTheme.colors.panelBorderWeak};
    border-radius: ${logservTheme.radius.small};
    padding: 6px ${logservTheme.spacing.md};
    font-size: ${logservTheme.fontSize.small};
    display: flex;
    align-items: center;
    gap: ${logservTheme.spacing.sm};
`;

/* Build 166 / session 028 — the legacy 12 px cyan-arc spinner was
 * replaced with the shared `Spinner` component (Win11-style 8 orange
 * dots) so the topology dashboard speaks the same "in flight" visual
 * language as the AI Assistant. The StatusBanner uses the default
 * (small) size; the canvas overlay below uses a larger radius. */

/** Canvas overlay positioning for the lazy-loading spinner. Sits in the
 *  top-left corner of the CenterFrame so the user sees an animated
 *  indicator that data + layout are still being fetched, even while
 *  the existing StatusBanner above the canvas conveys the same signal
 *  in text form. Build 166 / session 028 — added per user request.
 *  Build 168 — dropped the cyan-accent border, dark background, and
 *  padding so the spinner + text sit naturally in the canvas corner;
 *  text color switched from `cyanLight` to `textMuted` so the label
 *  blends into the canvas background and the orange spinner dots
 *  carry the visual weight. */
const CanvasLoadingOverlay = styled.div`
    position: absolute;
    top: 8px;
    left: 8px;
    display: inline-flex;
    align-items: center;
    gap: ${logservTheme.spacing.sm};
    /* Build 168 — fully transparent: no border, no background, no
     * padding. Just the spinner + muted-text label sitting directly on
     * the canvas. */
    background: transparent;
    border: none;
    padding: 0;
    color: ${logservTheme.colors.textMuted};
    font-size: ${logservTheme.fontSize.small};
    pointer-events: none;
    z-index: 10;
`;

const CollapsedTab = styled.button<{ $orient: 'left' | 'right' | 'bottom' }>`
    width: 100%;
    height: 100%;
    background: ${logservTheme.colors.panelBackground};
    color: ${logservTheme.colors.cyanLight};
    border: 1px solid ${logservTheme.colors.panelBorder};
    border-radius: ${logservTheme.radius.small};
    cursor: pointer;
    font-family: inherit;
    font-size: 13px;
    font-weight: ${logservTheme.fontWeight.semibold};
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    transition: background-color 80ms ease-out, border-color 80ms ease-out;

    &:hover {
        background: ${logservTheme.colors.hoverBackground};
        border-color: ${logservTheme.colors.cyanAccent};
        color: ${logservTheme.colors.cyanAccent};
    }

    &:focus {
        outline: 2px solid ${logservTheme.colors.cyanAccent};
        outline-offset: -2px;
    }
`;

const IntegrationTopology: React.FC = () => {
    // ---- Selection (mutex: at most one of selectedNodeId / selectedEdgeId
    //      is non-null at any time. Build 202 / session 036.) ----
    const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
    const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);

    // ---- Filters ----
    const [enabledTypes, setEnabledTypes] = useState<Set<IntegrationType>>(
        () => new Set(ALL_INTEGRATION_TYPES),
    );

    // ---- Toolbar mode flags ----
    const [snapMode, setSnapMode] = useState(false);

    /* Active layout algorithm — Force (d3-force), Layered (ELK Sugiyama),
     * or Tree (ELK mrtree). Persisted to localStorage so user choice
     * survives page reloads. Build 200 / session 035. Build 229 / Option C —
     * also persisted to KV Store for cross-browser parity. */
    const [layoutMode, setLayoutMode] = useState<LayoutMode>(() => readPersistedLayoutMode());
    /* Build 229 / session 037 / Option C — gates the auto-load effect
     * from firing until the async KV Store fetch for the active layout
     * mode completes. Without this gate, on a fresh-browser load the
     * auto-load effect would race the hydration and load the default
     * for the localStorage-cached mode (typically Force fallback) before
     * the KV Store value (e.g. Layered) had a chance to set the state.
     * Initial value `false`; flipped to `true` once the mount effect
     * has fetched (or attempted to fetch) the active mode from KV Store. */
    const [activeModeHydrated, setActiveModeHydrated] = useState<boolean>(false);
    /* Build 216 / session 036 — guards the auto-load effect from
     * re-firing on every refreshLayouts() call after the user has
     * already manually picked a different layout. Stores `${mode}::${defaultSlug}`
     * for the mode whose default has been auto-attempted; reset when
     * the user switches modes. Declared near layoutMode so it's in
     * scope for handleSetLayoutMode below. */
    const autoLoadAttemptedFor = useRef<string | null>(null);
    const handleSetLayoutMode = useCallback((mode: LayoutMode) => {
        setLayoutMode(mode);
        writePersistedLayoutMode(mode);
        /* Build 231 / session 037 — DROPDOWN mode changes are session-
         * only (writes to localStorage cache for fast remount, but does
         * NOT write to KV Store). The cross-browser default-mode is
         * controlled explicitly via the Manage Layouts modal's
         * "Open in this mode by default" checkbox per section. This
         * decouples "what mode am I using right now" from "what mode
         * should every browser default to". Build 229 had write-through
         * here; build 231 reverted that in favor of explicit user
         * control. */
        /* Switching layout invalidates any drag-positions the user made
         * under the previous algorithm — bump forceRerunKey so the graph
         * remounts with fresh ELK/d3-force positions. */
        setForceRerunKey((k) => k + 1);
        setLatestPositions(null);
        /* Build 215 / session 036 — DROP the savedLayout so its
         * positions (captured under the OLD mode) don't get applied to
         * the NEW mode's fresh layout pass. The auto-load effect (added
         * in build 216) will replace it with the new mode's default
         * layout if one is configured. */
        setSavedLayout(null);
        setCurrentLayoutName(null);
        clearCachedActiveLayout();
        /* Build 216 — reset the auto-load guard so the effect can fire
         * for the NEW mode's default. Without this reset, switching
         * back to a previously-loaded mode wouldn't re-load its default. */
        autoLoadAttemptedFor.current = null;
    }, []);

    /* Right-sidebar active tab — lifted from TopologyRightSidebar (build 169 /
     * session 028) so a saved layout's `rightTabId` can be applied on load.
     * Defaults to 'overview'. The sidebar itself still falls back to its own
     * internal state if no `tab` prop is passed (e.g. tests or future
     * non-IntegrationTopology consumers). */
    const [rightTab, setRightTab] = useState<RightTab>('overview');
    /* Right-sidebar edge tab — separate from the node tab so swapping
     * selection between node and edge doesn't clobber the user's preferred
     * tab in the OTHER mode. Defaults to 'overview'. Build 202 / session 036. */
    const [edgeRightTab, setEdgeRightTab] = useState<EdgeRightTab>('overview');

    /* Imperative handle into TopologyGraph — used to capture the current
     * ReactFlow viewport on Save Layout and re-apply a saved viewport on
     * Load Layout. Build 169 / session 028. */
    const topologyGraphRef = useRef<TopologyGraphHandle | null>(null);

    // ---- Layout persistence (lazy first read from local cache) ----
    const [savedLayout, setSavedLayout] = useState<SavedLayout | null>(() => loadCachedLayout());
    /** Force-rerun-from-scratch counter — bumped to make the graph re-mount with no saved positions. */
    const [forceRerunKey, setForceRerunKey] = useState(0);
    /** Refresh counter — bumped to re-run all topology SPL queries while keeping the saved layout. */
    const [refreshNonce, setRefreshNonce] = useState(0);
    /** True when nodes have been moved or panels resized/collapsed since the last save. */
    const [layoutDirty, setLayoutDirty] = useState(false);
    /** Latest node positions (from drag-stop callback). */
    const [latestPositions, setLatestPositions] = useState<{ id: string; x: number; y: number }[] | null>(null);

    // ---- Named layouts (build 121 / A.4) ----
    /** User-visible name of the currently-loaded layout, or null when nothing
     *  is loaded (e.g. fresh user, or after Reset). Hydrated from the cache
     *  layoutName on mount. */
    const [currentLayoutName, setCurrentLayoutName] = useState<string | null>(
        () => loadCachedLayout()?.layoutName ?? null,
    );
    /** Slug of the currently-loaded layout. Derived from currentLayoutName via
     *  slugifyLayoutName so the dropdown's "current" highlight tracks. */
    const currentLayoutSlug = useMemo(
        () => (currentLayoutName ? slugifyLayoutName(currentLayoutName) : null),
        [currentLayoutName],
    );
    const [availableLayouts, setAvailableLayouts] = useState<LayoutSummary[]>([]);
    const [layoutsLoading, setLayoutsLoading] = useState<boolean>(false);
    const [nameModalOpen, setNameModalOpen] = useState<boolean>(false);
    /** Set of slugs derived from availableLayouts — fed to the modal so it
     *  can detect overwrite vs. fresh save and toggle the warning hint. */
    const existingLayoutSlugs = useMemo(
        () => new Set(availableLayouts.map((l) => l.slug)),
        [availableLayouts],
    );

    /** Build 216 / session 036 — Manage Layouts modal state + per-mode
     *  default-layout slug map. Build 226 / session 037 / Path F migrated
     *  storage from localStorage to KV Store (cross-browser persistence)
     *  while keeping localStorage as a synchronous fast-mount cache. The
     *  modal reads `defaultSlugs` for its radio-checked state and calls
     *  `handleSetDefault` which writes through to BOTH the cache and the
     *  KV Store. The async `fetchDefaultLayoutSlugsFromKvStore` mount
     *  effect (further down) hydrates the cache from KV Store + updates
     *  state if the two diverge — this is what gives cross-browser
     *  defaults their "follow me" behavior. */
    const [manageModalOpen, setManageModalOpen] = useState<boolean>(false);
    const [defaultSlugs, setDefaultSlugs] = useState<{
        force: string | null;
        layered: string | null;
        tree: string | null;
    }>(() => getAllDefaultLayoutSlugs());
    const handleSetDefault = useCallback(
        (mode: 'force' | 'layered' | 'tree', slug: string | null): void => {
            // Optimistic update — local state + cache reflect the click
            // immediately even if the KV Store write is in flight.
            setDefaultLayoutSlug(mode, slug);
            setDefaultSlugs((prev) => ({ ...prev, [mode]: slug }));
            // Async write-through to KV Store. Refresh the layouts list on
            // success so summaries' `isDefault` flags reflect the change.
            void (async (): Promise<void> => {
                const ok = await setDefaultLayoutInKvStore(mode, slug);
                if (ok) {
                    void refreshLayouts();
                } else {
                    /* Best-effort: keep the local-state pick. The next mount
                     * will reconcile from KV Store via fetchDefaultLayoutSlugsFromKvStore. */
                }
            })();
        },
        // refreshLayouts is declared in the same component scope below.
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [],
    );

    /* Build 231 / session 037 — user's explicit default-mode preference,
     *  decoupled from the active session mode. Stored in KV Store via
     *  setActiveLayoutModeInKvStore (or null = no preference, fall back
     *  to localStorage cache). Initial state is the localStorage value;
     *  the mount effect's hydration overwrites with the KV Store value
     *  if it exists. */
    const [defaultMode, setDefaultMode] = useState<LayoutMode | null>(null);
    const handleSetDefaultMode = useCallback((mode: LayoutMode | null): void => {
        // Optimistic update.
        setDefaultMode(mode);
        // Also switch the active session mode immediately so the user
        // sees the result of their pick. Same handler the LAYOUT
        // dropdown uses (drops savedLayout, resets autoLoadAttemptedFor,
        // bumps forceRerunKey). On uncheck (mode === null), leave the
        // current session mode alone — the user is just declaring "no
        // explicit default", not requesting a switch.
        if (mode != null) {
            handleSetLayoutMode(mode);
        }
        // Async write-through to KV Store.
        void setActiveLayoutModeInKvStore(mode);
    }, [handleSetLayoutMode]);

    /** Refresh the list of saved layouts from KV Store. Called on mount and
     *  after every successful Save / Delete. */
    const refreshLayouts = useCallback(async (): Promise<void> => {
        setLayoutsLoading(true);
        try {
            const list = await listLayouts();
            setAvailableLayouts(list);
        } finally {
            setLayoutsLoading(false);
        }
    }, []);

    // On mount: migrate legacy localStorage entries to KV Store (one-time
    // per user; idempotent), refresh the layouts list, hydrate per-mode
    // default-layout slugs from KV Store, AND hydrate the active layout
    // mode preference from KV Store. Best-effort — failures don't block
    // the UI. Build 226 (Path F) added the default-layout migration +
    // hydrate step; build 229 (Option C) added the active-mode migration
    // + hydrate step.
    useEffect(() => {
        let cancelled = false;
        (async (): Promise<void> => {
            await migrateLegacyLocalStorageLayout();
            if (cancelled) return;
            await migrateLegacyLocalStorageDefaultLayouts();
            if (cancelled) return;
            await migrateLegacyLocalStorageActiveMode();
            if (cancelled) return;
            await refreshLayouts();
            if (cancelled) return;
            const remoteDefaults = await fetchDefaultLayoutSlugsFromKvStore();
            if (cancelled) return;
            if (remoteDefaults) {
                setDefaultSlugs((prev) => {
                    if (prev.force === remoteDefaults.force
                        && prev.layered === remoteDefaults.layered
                        && prev.tree === remoteDefaults.tree) {
                        return prev;
                    }
                    return remoteDefaults;
                });
            }
            // Build 229 — hydrate active layout mode from KV Store. The
            // localStorage cache (`logserv.topology.layoutMode`) was used
            // for the synchronous initial state; KV Store is the source
            // of truth for cross-browser parity. Update mode + cache only
            // when KV Store value differs from current state. After the
            // fetch resolves (success OR failure), flip
            // `activeModeHydrated` so the auto-load effect can proceed —
            // the gate prevents auto-load from racing the hydration on a
            // fresh-browser load.
            const remoteMode = await fetchActiveLayoutModeFromKvStore();
            if (cancelled) return;
            if (remoteMode) {
                setDefaultMode(remoteMode);
                setLayoutMode((prev) => {
                    if (prev === remoteMode) return prev;
                    writePersistedLayoutMode(remoteMode);
                    /* Reset the auto-load guard so the auto-load effect fires
                     * once for the newly-hydrated mode (matches handleSetLayoutMode
                     * behavior). Without this reset, the guard's previous
                     * `${oldMode}::${slug}` key prevents the new mode's
                     * default from auto-loading. */
                    autoLoadAttemptedFor.current = null;
                    return remoteMode;
                });
            } else {
                /* Build 231 — null KV Store row means user has NOT picked
                 * an explicit default mode. The session mode stays at
                 * the localStorage-cached value (Force fallback). */
                setDefaultMode(null);
            }
            // Always flip the gate, even if KV Store had no row — the
            // auto-load effect should proceed with the localStorage-cached
            // mode in that case (the fallback behavior).
            setActiveModeHydrated(true);
        })();
        return () => {
            cancelled = true;
        };
    }, [refreshLayouts]);

    // ---- Panel state (hydrated from saved layout if present, else defaults) ----
    const [panels, setPanels] = useState<PanelLayoutState>(
        () => savedLayout?.panels ?? { ...DEFAULT_PANEL_LAYOUT },
    );

    /** Mark layout dirty + propagate the panels delta. */
    const updatePanels = useCallback((patch: Partial<PanelLayoutState>) => {
        setPanels((prev) => ({ ...prev, ...patch }));
        setLayoutDirty(true);
    }, []);

    // ---- Drag-resize handlers ----
    const startResize = useCallback(
        (which: 'left' | 'right' | 'bottom') => (e: React.MouseEvent) => {
            e.preventDefault();
            const startX = e.clientX;
            const startY = e.clientY;
            const startLeft = panels.leftWidth;
            const startRight = panels.rightWidth;
            const startBottom = panels.bottomHeight;
            const onMove = (m: MouseEvent): void => {
                if (which === 'left') {
                    const next = Math.max(LEFT_MIN, Math.min(LEFT_MAX, startLeft + (m.clientX - startX)));
                    updatePanels({ leftWidth: next });
                } else if (which === 'right') {
                    // Right divider: dragging LEFT increases right width.
                    const next = Math.max(RIGHT_MIN, Math.min(RIGHT_MAX, startRight - (m.clientX - startX)));
                    updatePanels({ rightWidth: next });
                } else if (which === 'bottom') {
                    // Bottom divider: dragging UP increases bottom height.
                    const next = Math.max(BOTTOM_MIN, Math.min(BOTTOM_MAX, startBottom - (m.clientY - startY)));
                    updatePanels({ bottomHeight: next });
                }
            };
            const onUp = (): void => {
                window.removeEventListener('mousemove', onMove);
                window.removeEventListener('mouseup', onUp);
                document.body.style.cursor = '';
                document.body.style.userSelect = '';
            };
            document.body.style.cursor = which === 'bottom' ? 'row-resize' : 'col-resize';
            document.body.style.userSelect = 'none';
            window.addEventListener('mousemove', onMove);
            window.addEventListener('mouseup', onUp);
        },
        [panels, updatePanels],
    );

    // ---- Real data from Splunk via useTopologyData ----
    const topology = useTopologyData(refreshNonce);
    const liveEdges = topology.edges;
    const liveActivity = topology.activity;
    const liveCallsPerHour = topology.callsPerHour;

    /* Build 325 / session 110 (plan item D1) — ONE bulk windowed read for
     * per-node distinct host counts: `scope -> dc(host)` over the same
     * node_host rollup metric the Hosts tab reads, so the tooltip/facts
     * number and that tab's `host_total` agree for the same node + window
     * (dispatch timing across an hourly-aggregate boundary can briefly
     * differ — this read resolves at page load, the tab at select time).
     * The query carries a COARSE bucket_ts pushdown (JS-resolved window ± a
     * margin) so mongod streams only the window's rows, not the whole
     * 365-day retention; the precise trim stays the read's own `| addinfo`
     * range (review fold, session 110). The query string changes with the
     * picker, which is what re-dispatches useSearch; refreshNonce re-runs
     * it alongside the KV fetches.
     *
     * The map deliberately EMPTIES while a (re-)dispatch is in flight:
     * useSearch keeps the previous results across re-dispatch and KV rows
     * land before SPL results, so without the guard a window change would
     * present the PREVIOUS window's counts as current-window facts for a
     * few seconds. An absent row is honest; a stale number is not.
     *
     * Delivery is via HostCountContext + the sidebar's nodeHostCount prop —
     * NOT via the node objects — so the late-arriving result cannot touch
     * the node-array identity TopologyGraph's layout effect keys on
     * (re-running d3-force + manualFitView over the user's viewport). */
    const { timeRange } = useTimeRange();
    const hostCountsQuery = useMemo(
        () => SEARCH_NODE_HOST_COUNTS(
            resolveTimeSpec(timeRange.earliest),
            resolveTimeSpec(timeRange.latest),
        ),
        [timeRange.earliest, timeRange.latest],
    );
    const hostCountsResult = useSearch<{ scope: string; hosts: string | number }>({
        query: hostCountsQuery,
        refreshNonce,
    });
    /* Build 329 / session 112 — the IP enrichment index (hostname + user
     * names for IP partner squares). Same delivery discipline as the host
     * counts: context + sidebar prop, never the node arrays. NOT
     * picker-bound (latest-known semantics) — only the Refresh nonce
     * re-fetches it. */
    const ipEnrichment = useIpEnrichment(refreshNonce);

    const hostCountByLabel = useMemo(() => {
        const map = new Map<string, number>();
        if (hostCountsResult.loading) return map;
        (hostCountsResult.results ?? []).forEach((r) => {
            const n = typeof r.hosts === 'number' ? r.hosts : Number(r.hosts);
            if (r.scope && Number.isFinite(n) && n > 0) map.set(r.scope, n);
        });
        return map;
    }, [hostCountsResult.results, hostCountsResult.loading]);

    /* Build 206 / session 036 — augment each node with `callBuckets`
     * derived from its incident edges. Drives the thin outer ring on
     * SidNode showing normal / warning / error call counts.
     *
     * Per-edge classification rule:
     *   - errorRate = errorCount / callCount (or 0 if no calls)
     *   - normal_calls (always): callCount - errorCount
     *   - errorCount routing:
     *       errorRate <  10%  → warning (sporadic, edge mostly healthy)
     *       errorRate >= 10%  → error   (systematic, edge degraded)
     *
     * Threshold = 10% chosen empirically: in our dataset HTTP error rates
     * cluster either near 0% (healthy) or above 25% (broken backend);
     * 10% cleanly separates "occasional 4xx noise" from "endpoint down". */
    const liveNodes = useMemo(() => {
        if (topology.nodes.length === 0) return topology.nodes;
        /* Group edges by node id once so we don't re-filter the array per node
         * (was O(N*E); now O(N+E)). */
        const incidentByNodeId = new Map<string, typeof topology.edges>();
        topology.edges.forEach((e) => {
            const srcList = incidentByNodeId.get(e.source) ?? [];
            srcList.push(e);
            incidentByNodeId.set(e.source, srcList);
            if (e.target !== e.source) {
                const tgtList = incidentByNodeId.get(e.target) ?? [];
                tgtList.push(e);
                incidentByNodeId.set(e.target, tgtList);
            }
        });
        return topology.nodes.map((n) => {
            const incident = incidentByNodeId.get(n.id) ?? [];
            let normal = 0;
            let warning = 0;
            let error = 0;
            /* Build 224 / session 037 — HANA-tagged nodes get a vendor-
             * specific warning signal: tenant SQL events with severity=
             * WARNING OR duration > 1000 ms (excluding ERROR/FATAL events).
             * Pre-computed at SPL aggregation time as `warning_count` on
             * each hana_tenant edge bucket row; summed across the time
             * window in useTopologyData. Replaces the build-211 heuristic
             * (which moved 25% of clean calls to warning when hanaOpMaxMs
             * > 1000) — that heuristic was a per-edge approximation; this
             * is the actual count.
             *
             * For Oracle / MSSQL / Postgres / DB2 partner DBs there's no
             * parallel warning_count field today (the KV Store edge
             * schema only carries HANA Tenant duration fields). Other DB
             * vendors fall through to the generic errorCount + 10%
             * rate-threshold heuristic — which still routes their high-
             * error edges to the red bucket and low-error edges to the
             * green/orange bucket as appropriate. */
            /* Build 224 / session 037 — replaced the build-211 "25% of clean
             * calls move to warning when hanaOpMaxMs > 1000" heuristic with
             * the first-class warningCount field, computed at SPL aggregation
             * time as: count of events where hana_trace_severity="WARNING"
             * OR (hana_op_duration_ms > 1000 AND severity not in ERROR/FATAL).
             * The warningCount is only emitted on hana_tenant edges, but
             * adding it unconditionally is null-safe (`?? 0`). */
            incident.forEach((e) => {
                const total = e.callCount;
                const errs = e.errorCount ?? 0;
                const tenantWarnings = e.warningCount ?? 0;
                /* Clean calls = total minus the error+warning combined. Cap
                 * at 0 in case the SPL emits warningCount that overlaps with
                 * an event that's also routed elsewhere (defense-in-depth;
                 * the SPL guards against ERROR+WARNING double-count, but
                 * future extensions might not). */
                const cleanCalls = Math.max(0, total - errs - tenantWarnings);
                normal += cleanCalls;
                warning += tenantWarnings;
                const rate = total > 0 ? errs / total : 0;
                if (rate < 0.10) {
                    warning += errs;
                } else {
                    error += errs;
                }
            });
            /* Build 325 note: the D1 host count is deliberately NOT attached
             * here — this memo's output feeds TopologyGraph's layout effect,
             * and the count arrives seconds after the KV render (see the
             * hostCountByLabel comment above). */
            return { ...n, callBuckets: { normal, warning, error } };
        });
    }, [topology.nodes, topology.edges]);

    // ---- Per-node hourly call counts for the right sidebar's bar chart ----
    /* Build 203 / session 036 — pass the node's CANONICAL VALUE (label),
     * not its SHA1[:16] id. The KV Store rewrite (build 191) made node ids
     * opaque hashes, so spliced into SPL like `sap_sid="<hash>"` they
     * never match raw events. The label IS the canonical_value (e.g. "XCP",
     * "10.186.72.127", "hec53v013858") which IS what gateway / hana / web
     * dispatcher events were tagged with. */
    const selectedNodeLabel = useMemo(
        () => (selectedNodeId
            ? (liveNodes.find((n) => n.id === selectedNodeId)?.label ?? null)
            : null),
        [selectedNodeId, liveNodes],
    );
    const nodeData = useNodeData(selectedNodeLabel, refreshNonce);

    // ---- Per-edge data for the right sidebar's 5-tab Edge Details panel.
    //      Lookups happen against the in-memory liveEdges array; the hook
    //      only fires SPL searches when an edge is selected. Build 202 /
    //      session 036. ----
    const selectedEdge = useMemo(
        () => (selectedEdgeId ? liveEdges.find((e) => e.id === selectedEdgeId) ?? null : null),
        [selectedEdgeId, liveEdges],
    );
    const edgeData = useEdgeData(selectedEdge, refreshNonce);

    // ---- Stats ----
    const totalCalls = useMemo(
        () => liveEdges.reduce((s, e) => s + e.callCount, 0),
        [liveEdges],
    );
    /* Build 205 / session 036 — collect by canonical LABEL (not SHA1[:16]
     * id). The bottom Live Activity table compares against `sourceSid`
     * which is also a label (see useTopologyData's labelForId resolution
     * for the activity rows). Pre-build-205 this used `n.id` and the
     * highlight never matched, so all focused SID rows rendered the
     * "secondary" (cyan) pill style instead of the focused (red) style. */
    const focusedSidIds = useMemo(
        () => new Set(liveNodes.filter((n) => n.kind === 'sid_focused').map((n) => n.label)),
        [liveNodes],
    );
    const statsLine = useMemo(() => {
        if (topology.loading) return 'Loading topology data from Splunk…';
        if (liveNodes.length === 0) {
            return 'No topology data found in the current time range.';
        }
        const inv = topology.inventoryStatus;
        const resolvedPct = inv.totalEndpoints > 0
            ? Math.round((inv.resolved / inv.totalEndpoints) * 100)
            : 0;
        return `${liveNodes.length} nodes · ${liveEdges.length} edges · ${totalCalls.toLocaleString()} calls · ${resolvedPct}% endpoints resolved to SID`;
    }, [topology.loading, liveNodes, liveEdges, totalCalls, topology.inventoryStatus]);

    // ---- Selection handlers (build 202 / session 036 — enforce mutex
    //      between node + edge selection at the dashboard level so the
    //      right sidebar always shows EITHER node-detail tabs OR
    //      edge-detail tabs, never both.) ----
    const handleNodeClick = useCallback((nodeId: string) => {
        setSelectedNodeId(nodeId);
        setSelectedEdgeId(null);
    }, []);
    const handleEdgeClick = useCallback((edgeId: string) => {
        setSelectedEdgeId(edgeId);
        setSelectedNodeId(null);
    }, []);
    const handlePaneClick = useCallback(() => {
        setSelectedNodeId(null);
        setSelectedEdgeId(null);
    }, []);

    // ---- Filter handlers ----
    /* Build 223 / session 037 — when the user un-toggles an integration
     * type AND the currently-selected edge is of that type, clear
     * `selectedEdgeId` so the right pane drops back to the empty-state
     * prompt instead of showing stale Edge Details for a dimmed edge.
     * Same rationale for `handleToggleAllTypes(false)` — every edge is
     * dimmed so any selection is stale. */
    const handleToggleType = useCallback((t: IntegrationType) => {
        const wasEnabled = enabledTypes.has(t);
        setEnabledTypes((prev) => {
            const next = new Set(prev);
            if (next.has(t)) next.delete(t); else next.add(t);
            return next;
        });
        if (wasEnabled && selectedEdge && selectedEdge.type === t) {
            setSelectedEdgeId(null);
        }
    }, [enabledTypes, selectedEdge]);
    const handleToggleAllTypes = useCallback((enable: boolean) => {
        setEnabledTypes(enable ? new Set(ALL_INTEGRATION_TYPES) : new Set());
        if (!enable) setSelectedEdgeId(null);
    }, []);

    // ---- Layout (graph) handlers ----
    const handleLayoutChange = useCallback((positions: { id: string; x: number; y: number }[]) => {
        setLatestPositions(positions);
        setLayoutDirty(true);
    }, []);

    /** Open the LayoutNameModal — Save Layout toolbar button entry point. */
    const handleOpenSaveModal = useCallback(() => {
        setNameModalOpen(true);
    }, []);

    /** User entered a layout name and clicked Save in the modal. Persists to
     *  KV Store (and updates the local cache via saveLayoutNamed), updates
     *  the current-layout chip, refreshes the dropdown list. */
    const handleConfirmSaveName = useCallback(
        async (layoutName: string): Promise<void> => {
            const positions = latestPositions ?? savedLayout?.nodes ?? [];
            /* Build 169 / session 028 — capture the current viewport + view-
             * state controls so a load fully restores the user's session. */
            const viewport = topologyGraphRef.current?.getViewport() ?? undefined;
            const enabledTypesArr = Array.from(enabledTypes);
            const result = await saveLayoutNamed(layoutName, {
                nodes: positions,
                panels,
                viewport,
                enabledTypes: enabledTypesArr,
                selectedNodeId: selectedNodeId,
                selectedEdgeId: selectedEdgeId,
                rightTabId: rightTab,
                snapMode,
                /* Build 215 / session 036 — pin the layout mode at save
                 * time so loading restores the right algorithm + the
                 * saved positions only apply to that mode. */
                layoutMode,
            });
            if (!result.ok) {
                // KV Store write failure — log to console; keep modal open so
                // the user sees nothing happened. (Error UI surfacing can be
                // added later if this becomes a frequent failure mode.)
                // eslint-disable-next-line no-console
                console.error('Layout save failed:', result.reason);
                return;
            }
            setSavedLayout({
                version: 5,
                savedAt: new Date().toISOString(),
                layoutName,
                nodes: positions,
                panels: { ...panels },
                viewport,
                enabledTypes: enabledTypesArr,
                selectedNodeId,
                selectedEdgeId,
                rightTabId: rightTab,
                snapMode,
                layoutMode,
            });
            setCurrentLayoutName(layoutName);
            setLayoutDirty(false);
            setNameModalOpen(false);
            await refreshLayouts();
        },
        [latestPositions, panels, savedLayout, refreshLayouts, enabledTypes, selectedNodeId, selectedEdgeId, rightTab, snapMode, layoutMode],
    );

    const handleCancelSaveModal = useCallback(() => {
        setNameModalOpen(false);
    }, []);

    /** Load a named layout by slug from KV Store. Updates savedLayout +
     *  currentLayoutName + clears dirty flag. Layout positions feed into
     *  TopologyGraph via the savedLayout prop. */
    const handleLoadLayout = useCallback(
        async (slug: string): Promise<void> => {
            const layout = await loadLayoutBySlug(slug);
            if (!layout) {
                // eslint-disable-next-line no-console
                console.error(`Failed to load layout slug "${slug}".`);
                return;
            }
            setSavedLayout(layout);
            setCurrentLayoutName(layout.layoutName ?? null);
            setLatestPositions(null);
            setPanels({ ...layout.panels });
            setLayoutDirty(false);
            // Force the graph to re-mount so saved positions take effect on
            // the existing nodes (otherwise xyflow keeps the previous run's
            // drag positions in its internal state).
            setForceRerunKey((k) => k + 1);

            /* Build 169 / session 028 — apply v4 fields when present.
             * Each field guards on `undefined` so a v3 layout (loaded via
             * the v3-to-v4 migration in persistence.ts) leaves the live
             * state at its current dashboard default. */
            if (layout.enabledTypes && layout.enabledTypes.length > 0) {
                /* Filter to known IntegrationType values defensively — a
                 * future schema bump that retires a type shouldn't crash
                 * the load. */
                const knownSet = new Set<string>(ALL_INTEGRATION_TYPES);
                const filtered = layout.enabledTypes.filter((t) => knownSet.has(t)) as IntegrationType[];
                setEnabledTypes(new Set(filtered));
            }
            if (typeof layout.snapMode === 'boolean') {
                setSnapMode(layout.snapMode);
            }
            if (layout.selectedNodeId !== undefined) {
                setSelectedNodeId(layout.selectedNodeId);
            }
            if (layout.selectedEdgeId !== undefined) {
                setSelectedEdgeId(layout.selectedEdgeId);
            }
            /* Build 215 / session 036 — restore the layout mode the
             * saved positions were captured under. Pre-215 records
             * have no layoutMode field; default to 'force' since
             * that was the only mode at the time those layouts were
             * created (Tree mode shipped in build 200, but the v5
             * schema didn't capture mode until build 215). */
            const savedMode: LayoutMode = (layout.layoutMode as LayoutMode | undefined) ?? 'force';
            setLayoutMode(savedMode);
            writePersistedLayoutMode(savedMode);
            if (layout.rightTabId) {
                /* Type-narrow: rightTabId is `string | undefined` on the wire
                 * but we know our own RightTab values. Trust + cast since the
                 * sidebar itself defaults gracefully on an unknown value. */
                setRightTab(layout.rightTabId as RightTab);
            }
            /* Viewport applies AFTER the graph re-mounts. The forceRerunKey
             * bump above triggers a fresh ReactFlow mount; setViewport on the
             * old instance would be a no-op. requestAnimationFrame lets the
             * mount commit first, then we apply. Two nested rAFs is overkill
             * for most browsers but defends against edge cases where layout
             * settles in a second paint. */
            if (layout.viewport) {
                const v = layout.viewport;
                window.requestAnimationFrame(() => {
                    window.requestAnimationFrame(() => {
                        topologyGraphRef.current?.setViewport(v);
                    });
                });
            }
        },
        [],
    );

    /** Build 216 / session 036 — auto-load the per-mode default layout
     *  when (a) the layout list arrives + a default is set for the
     *  current layoutMode, OR (b) the user switches to a different
     *  layoutMode that has a default. The effect runs whenever
     *  layoutMode or availableLayouts change.
     *
     *  Guards:
     *   - Only runs after `availableLayouts` is non-empty (avoids racing
     *     with the KV Store fetch on first mount).
     *   - Skips load if the default slug doesn't exist in availableLayouts
     *     anymore (e.g. user deleted it but the localStorage default is
     *     stale).
     *   - Skips if the currentLayoutSlug ALREADY matches the default
     *     (no work needed).
     *   - `autoLoadAttemptedFor` ref guards against re-loading on every
     *     refreshLayouts() call after an explicit user load. Declared
     *     up where layoutMode lives. */
    useEffect(() => {
        /* Build 229 / Option C — block until the async active-mode KV
         * Store fetch has completed (success OR failure). Without this
         * gate, the auto-load effect fires for the localStorage-cached
         * mode FIRST, calling handleLoadLayout(forceDefault) which then
         * writes 'force' back to localStorage via the saved-layout's
         * mode tag — overriding any subsequent setLayoutMode('layered')
         * from hydration. */
        if (!activeModeHydrated) return;
        if (availableLayouts.length === 0) return;
        const defaultSlug = defaultSlugs[layoutMode];
        if (!defaultSlug) return;
        const exists = availableLayouts.some((l) => l.slug === defaultSlug);
        if (!exists) return;
        if (currentLayoutSlug === defaultSlug) return;
        const attemptKey = `${layoutMode}::${defaultSlug}`;
        if (autoLoadAttemptedFor.current === attemptKey) return;
        autoLoadAttemptedFor.current = attemptKey;
        handleLoadLayout(defaultSlug);
    }, [layoutMode, availableLayouts, defaultSlugs, currentLayoutSlug, handleLoadLayout, activeModeHydrated]);

    /** Delete a named layout from KV Store. If the deleted layout was the
     *  currently-loaded one, also clear the local cache + chip. */
    const handleDeleteLayout = useCallback(
        async (slug: string): Promise<void> => {
            const ok = await deleteLayoutFromStore(slug);
            if (!ok) {
                // eslint-disable-next-line no-console
                console.error(`Failed to delete layout slug "${slug}".`);
                return;
            }
            if (currentLayoutSlug === slug) {
                clearCachedActiveLayout();
                setSavedLayout(null);
                setCurrentLayoutName(null);
                setLayoutDirty(false);
            }
            await refreshLayouts();
        },
        [currentLayoutSlug, refreshLayouts],
    );


    const handleRefresh = useCallback(() => {
        // Re-run all topology SPL queries (useTopologyData + useNodeData) while
        // keeping the user's saved layout intact. Different from Reset, which
        // also wipes the saved positions and re-rolls d3-force.
        setRefreshNonce((n) => n + 1);
    }, []);

    // ---- Right-sidebar selection edges ----
    const selectedNode = useMemo(
        () => liveNodes.find((n) => n.id === selectedNodeId) ?? null,
        [selectedNodeId, liveNodes],
    );
    const incomingEdges = useMemo(
        () => (selectedNodeId ? liveEdges.filter((e) => e.target === selectedNodeId) : []),
        [selectedNodeId, liveEdges],
    );
    const outgoingEdges = useMemo(
        () => (selectedNodeId ? liveEdges.filter((e) => e.source === selectedNodeId) : []),
        [selectedNodeId, liveEdges],
    );
    /* Build 322 — resolve the selected node's traffic rows in a memo rather
     * than with a `?? []` in the JSX, which would hand the sidebar a fresh
     * array identity on every render. */
    const selectedNodeTraffic = useMemo(
        () => (selectedNodeId ? topology.hostTrafficByNode[selectedNodeId] ?? EMPTY_TRAFFIC_ROWS : EMPTY_TRAFFIC_ROWS),
        [selectedNodeId, topology.hostTrafficByNode],
    );
    /* Build 325 (plan item D1) — the selected node's window host count for
     * the Overview "Hosts (in range)" facts row. SID + tenant nodes only:
     * on a partner IP the label-scoped count would headline far-end hosts
     * the node does not own (the session-108 misread). The sidebar hedges
     * the tenant label collision next to the row. */
    const selectedNodeHostCount = useMemo(() => {
        if (!selectedNode) return undefined;
        const eligible = selectedNode.kind === 'sid_focused'
            || selectedNode.kind === 'sid_secondary'
            || selectedNode.tag === 'TENANT';
        return eligible ? hostCountByLabel.get(selectedNode.label) : undefined;
    }, [selectedNode, hostCountByLabel]);

    // ---- Trigger graph layout recompute when zone widths change so the
    //      ReactFlow canvas notices the new viewport and refits. We bump a
    //      key on the wrapper div which lets @xyflow's resize observer pick
    //      up the new dimensions naturally; no key bump on the graph itself
    //      so the user's drag positions survive the resize. ----
    const centerWrapRef = useRef<HTMLDivElement | null>(null);
    useEffect(() => {
        // Force a synchronous DOM reflow so ReactFlow's ResizeObserver fires.
        if (centerWrapRef.current) {
            centerWrapRef.current.getBoundingClientRect();
        }
    }, [panels.leftWidth, panels.rightWidth, panels.leftCollapsed, panels.rightCollapsed, panels.bottomHeight, panels.bottomCollapsed]);

    /* ---- Build 262 / session 077 Task 2 — viewport-aware layout world ----
     * The Force layout designs for the center canvas AS IF the Live
     * Activity panel is collapsed (the taller canvas is the design target,
     * so fitView doesn't letterbox and vertical space is actually used).
     * Read at layout-compute time via a stable callback + panels ref so
     * panel drags/toggles never churn re-layouts. */
    const panelsRef = useRef(panels);
    panelsRef.current = panels;
    const getLayoutWorld = useCallback((): { width: number; height: number } | null => {
        /* querySelector fallback (build 266): styled-component ref
         * forwarding is unreliable for these wrappers (session-036 sticky)
         * — the page renders exactly one topology canvas, so the class
         * selector is unambiguous. */
        const el = centerWrapRef.current ?? document.querySelector('.react-flow');
        if (!el) return null;
        const rect = el.getBoundingClientRect();
        if (rect.width < 200 || rect.height < 150) return null;
        const p = panelsRef.current;
        /* Collapsing the bottom panel frees its height above COLLAPSED_H
         * plus the HDivider (6 px) + one flex gap (12 px) that unmount with
         * it — verified against live measurements (450 -> 660 px on a
         * 945 px-tall viewport with the then-default 220 px panel; the
         * default is 300 px since build 280). */
        const extraH = p.bottomCollapsed ? 0 : Math.max(0, p.bottomHeight - COLLAPSED_H) + 18;
        return { width: rect.width, height: rect.height + extraH };
    }, []);

    // ---- Collapse toggles ----
    const toggleLeft = useCallback(() => updatePanels({ leftCollapsed: !panels.leftCollapsed }), [panels.leftCollapsed, updatePanels]);
    const toggleRight = useCallback(() => updatePanels({ rightCollapsed: !panels.rightCollapsed }), [panels.rightCollapsed, updatePanels]);
    const toggleBottom = useCallback(() => {
        /* Session 081 (build 280) — expanding guarantees a useful height:
         * layouts saved before this build carry the old cramped 220 px
         * default, so the expand gesture floors the height at the current
         * default (300 px). Collapsing never touches the height, and a
         * user-dragged taller height is preserved. */
        const expanding = panels.bottomCollapsed;
        updatePanels({
            bottomCollapsed: !panels.bottomCollapsed,
            ...(expanding && panels.bottomHeight < DEFAULT_PANEL_LAYOUT.bottomHeight
                ? { bottomHeight: DEFAULT_PANEL_LAYOUT.bottomHeight }
                : {}),
        });
        /* Build 262..267 — refit after the panel's 180 ms height transition
         * so the graph actually claims (or gracefully yields) the vertical
         * space; without this, collapsing Live Activity just reveals empty
         * canvas below the old viewport. STAGGERED PLAIN TIMERS, not a
         * requestAnimationFrame loop: rAF freezes entirely in occluded /
         * backgrounded windows (caught live in the build-266 verify — the
         * rAF settle-loop never ticked, so no fit ever fired), while
         * setTimeout still fires (throttled to ~1 s at worst). The fit is
         * duration-0 + idempotent, so firing it three times costs nothing:
         * 250 ms covers the focused-window case (transition done at 180 ms
         * + ResizeObserver ingest), 700 ms covers slow frames, 1500 ms
         * covers throttled/occluded windows. */
        const fit = (): void => topologyGraphRef.current?.fitView();
        window.setTimeout(fit, 250);
        window.setTimeout(fit, 700);
        window.setTimeout(fit, 1500);
    }, [panels.bottomCollapsed, panels.bottomHeight, updatePanels]);

    return (
        <DashboardLayout
            category="Topology"
            title="Environment Topology"
            subtitle={statsLine}
            noCloudFilter
        >
            <PageColumn>
                <TopologyToolbar
                    layoutSavedAt={savedLayout?.savedAt ?? null}
                    layoutDirty={layoutDirty}
                    snapMode={snapMode}
                    layoutMode={layoutMode}
                    refreshing={topology.loading}
                    currentLayoutName={currentLayoutName}
                    currentLayoutSlug={currentLayoutSlug}
                    availableLayouts={availableLayouts}
                    layoutsLoading={layoutsLoading}
                    onOpenSaveLayoutModal={handleOpenSaveModal}
                    onRefresh={handleRefresh}
                    onToggleSnap={() => setSnapMode((s) => !s)}
                    onSetLayoutMode={handleSetLayoutMode}
                    onLoadLayout={handleLoadLayout}
                    onDeleteLayout={handleDeleteLayout}
                    onOpenManageLayouts={() => setManageModalOpen(true)}
                />

                {topology.loading && (
                    <StatusBanner $kind="loading">
                        <Spinner radius={7} dotSize={2.5} label="Loading topology" />
                        Loading topology data from KV Store for the current time range…
                    </StatusBanner>
                )}
                {!topology.loading && topology.errors.length > 0 && (
                    <StatusBanner $kind="error" role="alert">
                        Topology KV Store query had {topology.errors.length} error(s):{' '}
                        {topology.errors.map((e) => `${e.search}: ${e.message}`).join(' · ')}
                    </StatusBanner>
                )}
                {!topology.loading && topology.errors.length === 0 && topology.isEmpty && (
                    <StatusBanner $kind="empty">
                        No topology data available for the current time range. If this is a fresh
                        install, run the one-time 30-day backfill from
                        Settings → AI Assistant → Topology. Otherwise the hourly aggregation may
                        not have populated this window yet — try a wider time range, or check
                        that the scheduled saved searches are enabled.
                    </StatusBanner>
                )}
                {!topology.loading && topology.errors.length === 0 && !topology.isEmpty && topology.staleness?.isStale && (
                    <StatusBanner $kind="empty">
                        Topology data is stale — the most-recent bucket is{' '}
                        {topology.staleness.ageHours.toFixed(1)} hours old (threshold: 6h).
                        The hourly aggregation saved searches may be disabled or failing.
                        Check Settings → AI Assistant → Topology and the Splunk Job Monitor.
                    </StatusBanner>
                )}

                <ColumnRow>
                    <LeftZone $w={panels.leftWidth} $collapsed={panels.leftCollapsed}>
                        {panels.leftCollapsed ? (
                            <CollapsedTab
                                type="button"
                                $orient="left"
                                onClick={toggleLeft}
                                title="Expand systems / filters"
                                aria-label="Expand systems and filters panel"
                            >
                                {'›'}
                            </CollapsedTab>
                        ) : (
                            <ZoneScroll>
                                <TopologyLeftSidebar
                                    nodes={liveNodes}
                                    edges={liveEdges}
                                    totalCalls={totalCalls}
                                    enabledTypes={enabledTypes}
                                    onToggleType={handleToggleType}
                                    onToggleAllTypes={handleToggleAllTypes}
                                    selectedNodeId={selectedNodeId}
                                    onSelectNode={handleNodeClick}
                                    onCollapse={toggleLeft}
                                />
                            </ZoneScroll>
                        )}
                    </LeftZone>

                    {!panels.leftCollapsed && (
                        <VDivider
                            onMouseDown={startResize('left')}
                            role="separator"
                            aria-orientation="vertical"
                            aria-label="Resize left panel"
                        />
                    )}

                    <CenterZone ref={centerWrapRef}>
                        <CenterFrame>
                            {/* Build 166 / session 028 — canvas-overlay
                              * spinner shown only while topology data + layout
                              * are still being lazy-loaded. Sits in the
                              * top-left corner of the canvas (above the
                              * graph) so the user has a visual indicator
                              * even before any nodes have rendered. The
                              * StatusBanner above the canvas conveys the
                              * same "loading" state in text — this overlay
                              * is the in-canvas companion the user
                              * requested. */}
                            {topology.loading && (
                                <CanvasLoadingOverlay aria-hidden>
                                    <Spinner radius={11} dotSize={3.5} label="Loading topology" />
                                    <span>Loading data &amp; layout…</span>
                                </CanvasLoadingOverlay>
                            )}
                            {/* Build 325 — the host-count map travels by context
                              * so its late arrival re-renders node COMPONENTS
                              * (cheap) without touching the nodes array the
                              * layout effect keys on. Build 329 — the IP
                              * enrichment index travels the same way. */}
                            <HostCountContext.Provider value={hostCountByLabel}>
                            <IpEnrichmentContext.Provider value={ipEnrichment}>
                                <ReactFlowProvider>
                                    <TopologyGraph
                                        ref={topologyGraphRef}
                                        key={forceRerunKey}
                                        nodes={liveNodes}
                                        edges={liveEdges}
                                        savedPositions={savedLayout?.nodes ?? null}
                                        snapMode={snapMode}
                                        enabledTypes={enabledTypes}
                                        selectedNodeId={selectedNodeId}
                                        selectedEdgeId={selectedEdgeId}
                                        layoutMode={layoutMode}
                                        getLayoutWorld={getLayoutWorld}
                                        onNodeClick={handleNodeClick}
                                        onEdgeClick={handleEdgeClick}
                                        onPaneClick={handlePaneClick}
                                        onLayoutChange={handleLayoutChange}
                                    />
                                </ReactFlowProvider>
                            </IpEnrichmentContext.Provider>
                            </HostCountContext.Provider>
                        </CenterFrame>
                    </CenterZone>

                    {!panels.rightCollapsed && (
                        <VDivider
                            onMouseDown={startResize('right')}
                            role="separator"
                            aria-orientation="vertical"
                            aria-label="Resize right panel"
                        />
                    )}

                    <RightZone $w={panels.rightWidth} $collapsed={panels.rightCollapsed}>
                        {panels.rightCollapsed ? (
                            <CollapsedTab
                                type="button"
                                $orient="right"
                                onClick={toggleRight}
                                title="Expand details panel"
                                aria-label="Expand details panel"
                            >
                                {'‹'}
                            </CollapsedTab>
                        ) : (
                            <RightZoneScroll>
                                <TopologyRightSidebar
                                    selectedNode={selectedNode}
                                    selectedNodeIncomingEdges={incomingEdges}
                                    selectedNodeOutgoingEdges={outgoingEdges}
                                    nodeHourly={nodeData.hourly}
                                    nodeHourlyLoading={nodeData.hourlyLoading}
                                    nodePrograms={nodeData.programs}
                                    nodeProgramsLoading={nodeData.programsLoading}
                                    nodeErrors={nodeData.errors}
                                    nodeErrorsLoading={nodeData.errorsLoading}
                                    nodeHosts={nodeData.hosts}
                                    nodeHostsLoading={nodeData.hostsLoading}
                                    nodeHostTotal={nodeData.hostTotal}
                                    nodeHostCount={selectedNodeHostCount}
                                    ipEnrichment={ipEnrichment}
                                    nodeTraffic={selectedNodeTraffic}
                                    endpointAttribution={topology.endpointAttribution}
                                    hostOwnerByValue={topology.inventoryOwnerByValue}
                                    selectedEdge={selectedEdge}
                                    edgeNodes={liveNodes}
                                    edgeData={edgeData}
                                    onCollapse={toggleRight}
                                    tab={rightTab}
                                    onTabChange={setRightTab}
                                    edgeTab={edgeRightTab}
                                    onEdgeTabChange={setEdgeRightTab}
                                />
                            </RightZoneScroll>
                        )}
                    </RightZone>
                </ColumnRow>

                {!panels.bottomCollapsed && (
                    <HDivider
                        onMouseDown={startResize('bottom')}
                        role="separator"
                        aria-orientation="horizontal"
                        aria-label="Resize bottom panel"
                    />
                )}

                <BottomZone $h={panels.bottomHeight} $collapsed={panels.bottomCollapsed}>
                    {panels.bottomCollapsed ? (
                        <CollapsedTab
                            type="button"
                            $orient="bottom"
                            onClick={toggleBottom}
                            title="Expand live activity panel"
                            aria-label="Expand live activity panel"
                        >
                            {'⌃ Live Activity'}
                        </CollapsedTab>
                    ) : (
                        <TopologyBottomPanel
                            rows={liveActivity}
                            callsPerHour={liveCallsPerHour.length > 0 ? liveCallsPerHour : [0]}
                            focusedSidIds={focusedSidIds}
                            rangeLabel="from current time range"
                            open
                            onToggleOpen={toggleBottom}
                        />
                    )}
                </BottomZone>
            </PageColumn>
            <LayoutNameModal
                open={nameModalOpen}
                defaultValue={currentLayoutName ?? ''}
                existingSlugs={existingLayoutSlugs}
                onSubmit={handleConfirmSaveName}
                onCancel={handleCancelSaveModal}
            />
            {/* Build 216 / session 036 — Manage Layouts modal lets the
              * user pick a default layout for each layout mode. Defaults
              * auto-load on mount + on mode switch via the effect below. */}
            <ManageLayoutsModal
                open={manageModalOpen}
                layouts={availableLayouts}
                defaultSlugs={defaultSlugs}
                onSetDefault={handleSetDefault}
                defaultMode={defaultMode}
                onSetDefaultMode={handleSetDefaultMode}
                onClose={() => setManageModalOpen(false)}
            />
        </DashboardLayout>
    );
};

export default IntegrationTopology;
