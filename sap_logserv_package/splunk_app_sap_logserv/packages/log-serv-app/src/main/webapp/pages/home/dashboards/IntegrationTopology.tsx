import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import styled from 'styled-components';
import { ReactFlowProvider } from '@xyflow/react';
import DashboardLayout from '../components/DashboardLayout';
import Spinner from '../components/Spinner';
import TopologyGraph, { type TopologyGraphHandle } from '../components/topology/TopologyGraph';
import TopologyToolbar from '../components/topology/TopologyToolbar';
import TopologyLeftSidebar from '../components/topology/TopologyLeftSidebar';
import TopologyRightSidebar, { type RightTab } from '../components/topology/TopologyRightSidebar';
import TopologyBottomPanel from '../components/topology/TopologyBottomPanel';
import LayoutNameModal from '../components/topology/LayoutNameModal';
import { logservTheme } from '../styles/logservTheme';
import { useTopologyData } from '../hooks/useTopologyData';
import { useNodeData } from '../hooks/useNodeData';
import { ALL_INTEGRATION_TYPES } from '../topology/edgeStyle';
import {
    loadCachedLayout,
    saveLayoutNamed,
    loadLayoutBySlug,
    listLayouts,
    deleteLayout as deleteLayoutFromStore,
    clearCachedActiveLayout,
    migrateLegacyLocalStorageLayout,
    slugifyLayoutName,
    type LayoutSummary,
} from '../topology/persistence';
import {
    DEFAULT_PANEL_LAYOUT,
    type IntegrationType,
    type SavedLayout,
    type PanelLayoutState,
} from '../topology/types';

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
const BOTTOM_MAX = 480;
const COLLAPSED_W = 26;
const COLLAPSED_H = 28;

const PageColumn = styled.div`
    display: flex;
    flex-direction: column;
    gap: ${logservTheme.spacing.md};
    /* Page header (DashboardLayout title + category eyebrow) consumes ~150 px;
     * subtract that plus a small breathing margin from the viewport. */
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
    // ---- Selection ----
    const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

    // ---- Filters ----
    const [enabledTypes, setEnabledTypes] = useState<Set<IntegrationType>>(
        () => new Set(ALL_INTEGRATION_TYPES),
    );

    // ---- Toolbar mode flags ----
    const [snapMode, setSnapMode] = useState(false);
    const [liveMode, setLiveMode] = useState(false);

    /* Right-sidebar active tab — lifted from TopologyRightSidebar (build 169 /
     * session 028) so a saved layout's `rightTabId` can be applied on load.
     * Defaults to 'overview'. The sidebar itself still falls back to its own
     * internal state if no `tab` prop is passed (e.g. tests or future
     * non-IntegrationTopology consumers). */
    const [rightTab, setRightTab] = useState<RightTab>('overview');

    /* Imperative handle into TopologyGraph — used to capture the current
     * ReactFlow viewport on Save Layout and re-apply a saved viewport on
     * Load Layout. Build 169 / session 028. */
    const topologyGraphRef = useRef<TopologyGraphHandle | null>(null);

    /** Live-mode polling interval in milliseconds. Hardcoded for v1 (build 125
     *  / A.6) — could be made admin-configurable via ai_assistant_settings.conf
     *  if real demand emerges. 30s balances freshness against Splunk search-job
     *  load (each tick re-dispatches ~9 searches across the topology +
     *  per-node hooks). */
    const LIVE_REFRESH_MS = 30_000;

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

    // On mount: migrate legacy localStorage entry to KV Store (one-time per
    // user; idempotent), then refresh the list. Best-effort — failures don't
    // block the UI.
    useEffect(() => {
        let cancelled = false;
        (async (): Promise<void> => {
            await migrateLegacyLocalStorageLayout();
            if (cancelled) return;
            await refreshLayouts();
        })();
        return () => {
            cancelled = true;
        };
    }, [refreshLayouts]);

    // Live-mode polling (build 125 / A.6): when the toolbar's Live | Lookup
    // toggle is on Live, re-run all topology queries every LIVE_REFRESH_MS
    // by bumping refreshNonce. Uses the same nonce mechanism as the manual
    // Refresh button — `useTopologyData` and `useNodeData` both observe it
    // via their `useSearch` deps. Saved layout intact across ticks.
    useEffect(() => {
        if (!liveMode) return undefined;
        const id = window.setInterval(() => {
            setRefreshNonce((n) => n + 1);
        }, LIVE_REFRESH_MS);
        return () => window.clearInterval(id);
    }, [liveMode]);

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
    const liveNodes = topology.nodes;
    const liveEdges = topology.edges;
    const liveActivity = topology.activity;
    const liveCallsPerHour = topology.callsPerHour;

    // ---- Per-node hourly call counts for the right sidebar's bar chart ----
    const nodeData = useNodeData(selectedNodeId, refreshNonce);

    // ---- Stats ----
    const totalCalls = useMemo(
        () => liveEdges.reduce((s, e) => s + e.callCount, 0),
        [liveEdges],
    );
    const focusedSidIds = useMemo(
        () => new Set(liveNodes.filter((n) => n.kind === 'sid_focused').map((n) => n.id)),
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

    // ---- Selection handlers ----
    const handleNodeClick = useCallback((nodeId: string) => {
        setSelectedNodeId(nodeId);
    }, []);
    const handlePaneClick = useCallback(() => {
        setSelectedNodeId(null);
    }, []);

    // ---- Filter handlers ----
    const handleToggleType = useCallback((t: IntegrationType) => {
        setEnabledTypes((prev) => {
            const next = new Set(prev);
            if (next.has(t)) next.delete(t); else next.add(t);
            return next;
        });
    }, []);
    const handleToggleAllTypes = useCallback((enable: boolean) => {
        setEnabledTypes(enable ? new Set(ALL_INTEGRATION_TYPES) : new Set());
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
                rightTabId: rightTab,
                snapMode,
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
                version: 4,
                savedAt: new Date().toISOString(),
                layoutName,
                nodes: positions,
                panels: { ...panels },
                viewport,
                enabledTypes: enabledTypesArr,
                selectedNodeId,
                rightTabId: rightTab,
                snapMode,
            });
            setCurrentLayoutName(layoutName);
            setLayoutDirty(false);
            setNameModalOpen(false);
            await refreshLayouts();
        },
        [latestPositions, panels, savedLayout, refreshLayouts, enabledTypes, selectedNodeId, rightTab, snapMode],
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

    // ---- Collapse toggles ----
    const toggleLeft = useCallback(() => updatePanels({ leftCollapsed: !panels.leftCollapsed }), [panels.leftCollapsed, updatePanels]);
    const toggleRight = useCallback(() => updatePanels({ rightCollapsed: !panels.rightCollapsed }), [panels.rightCollapsed, updatePanels]);
    const toggleBottom = useCallback(() => updatePanels({ bottomCollapsed: !panels.bottomCollapsed }), [panels.bottomCollapsed, updatePanels]);

    return (
        <DashboardLayout
            category="Topology"
            title="Environment Topology"
            subtitle={statsLine}
        >
            <PageColumn>
                <TopologyToolbar
                    layoutSavedAt={savedLayout?.savedAt ?? null}
                    layoutDirty={layoutDirty}
                    snapMode={snapMode}
                    liveMode={liveMode}
                    refreshing={topology.loading}
                    currentLayoutName={currentLayoutName}
                    currentLayoutSlug={currentLayoutSlug}
                    availableLayouts={availableLayouts}
                    layoutsLoading={layoutsLoading}
                    onOpenSaveLayoutModal={handleOpenSaveModal}
                    onRefresh={handleRefresh}
                    onToggleSnap={() => setSnapMode((s) => !s)}
                    onToggleLiveMode={() => setLiveMode((m) => !m)}
                    onLoadLayout={handleLoadLayout}
                    onDeleteLayout={handleDeleteLayout}
                />

                {topology.loading && (
                    <StatusBanner $kind="loading">
                        <Spinner radius={7} dotSize={2.5} label="Loading topology" />
                        Loading topology data from Splunk for the current time range…
                    </StatusBanner>
                )}
                {!topology.loading && topology.errors.length > 0 && (
                    <StatusBanner $kind="error" role="alert">
                        Topology query had {topology.errors.length} error(s):{' '}
                        {topology.errors.map((e) => `${e.search}: ${e.message}`).join(' · ')}
                    </StatusBanner>
                )}
                {!topology.loading && topology.errors.length === 0 && liveNodes.length === 0 && (
                    <StatusBanner $kind="empty">
                        No SAP integration traffic in the current time range. Try a wider window
                        (e.g., Last 7 days) or check that the relevant sourcetypes are indexed.
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
                                    onNodeClick={handleNodeClick}
                                    onPaneClick={handlePaneClick}
                                    onLayoutChange={handleLayoutChange}
                                />
                            </ReactFlowProvider>
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
                            <ZoneScroll>
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
                                    onCollapse={toggleRight}
                                    tab={rightTab}
                                    onTabChange={setRightTab}
                                />
                            </ZoneScroll>
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
        </DashboardLayout>
    );
};

export default IntegrationTopology;
