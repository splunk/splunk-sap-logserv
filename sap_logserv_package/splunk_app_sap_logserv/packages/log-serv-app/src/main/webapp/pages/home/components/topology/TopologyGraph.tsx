import React, { forwardRef, useCallback, useImperativeHandle, useRef } from 'react';
import {
    ReactFlow,
    Background,
    BackgroundVariant,
    Controls,
    MiniMap,
    type Node,
    type Edge,
    type NodeTypes,
    type NodeChange,
    type EdgeChange,
    type NodeMouseHandler,
    type EdgeMouseHandler,
    type ReactFlowInstance,
    applyNodeChanges,
    applyEdgeChanges,
    MarkerType,
    useStoreApi,
    type EdgeTypes,
} from '@xyflow/react';
import FloatingEdge from './FloatingEdge';
import '@xyflow/react/dist/style.css';
import styled from 'styled-components';
import { logservTheme } from '../../styles/logservTheme';
import { useThemeMode } from '../../state/ThemeModeProvider';
import SidNode from './nodeTypes/SidNode';
import PartnerNode from './nodeTypes/PartnerNode';
import type { TopologyNode, TopologyEdge, IntegrationType } from '../../topology/types';
import { computeLayout, snapToGrid, type LayoutMode } from '../../topology/layout';
import { edgeStyleFor } from '../../topology/edgeStyle';

/**
 * Wrapper around @xyflow/react that:
 *   - Hosts our two custom node components (SidNode, PartnerNode)
 *   - Computes initial force-directed positions via d3-force
 *   - Honors a saved-layout override (positions from localStorage)
 *   - Applies snap-to-grid on drag-end when enabled
 *   - Passes through node-click events to the parent for the right side panel
 *   - Dims edges whose IntegrationType is not in `enabledTypes`
 */

const FlowWrap = styled.div`
    width: 100%;
    height: 100%;
    background: ${logservTheme.colors.pageBackground};

    /* @xyflow/react overrides for dark theme cohesion. The library uses
     * CSS variables prefixed with --xy-* (v12). These keep the controls,
     * minimap, attribution + edge labels visually consistent with the rest
     * of the app. */
    --xy-background-color: ${logservTheme.colors.pageBackground};
    --xy-edge-stroke: ${logservTheme.colors.cyanAccent};
    --xy-edge-stroke-selected: ${logservTheme.colors.cyanLight};
    --xy-controls-button-background-color: ${logservTheme.colors.panelBackground};
    --xy-controls-button-background-color-hover: ${logservTheme.colors.hoverBackground};
    --xy-controls-button-color: ${logservTheme.colors.textActive};
    --xy-controls-button-color-hover: ${logservTheme.colors.cyanLight};
    --xy-controls-button-border-color: ${logservTheme.colors.panelBorderWeak};
    --xy-minimap-background-color: ${logservTheme.colors.panelBackground};
    /* minimap mask: set via the <MiniMap maskColor> PROP (mode-aware,
     * build 257) — the prop renders inline and always beats this var. */
    --xy-attribution-background-color: transparent;

    /* Edge labels — keep them readable on the dark canvas. */
    .react-flow__edge-text {
        fill: ${logservTheme.colors.textActive};
        font-size: 10px;
        font-weight: 600;
    }
    .react-flow__edge-textbg {
        fill: ${logservTheme.colors.panelBackground};
    }

    /* @xyflow/react v12 default-styles the node element as block-level filling
     * its parent container, which makes our custom JSX wrappers render at
     * full graph-canvas width. Constrain to the wrapper's actual content. */
    .react-flow__node {
        width: max-content;
        /* Build 192 / session 035 layout redesign — glide nodes to their
         * new positions on layout recompute (force-rerun, time-range change,
         * load-saved-layout) at 600 ms with a snappy ease-out curve. The
         * transition is applied to the inline transform ReactFlow sets on
         * each node wrapper. ReactFlow toggles a "dragging" class while the
         * user is actively dragging — disable the transition there so drag
         * stays responsive (no rubber-banding). */
        transition: transform 600ms cubic-bezier(0.4, 0, 0.2, 1);
    }
    .react-flow__node.dragging,
    .react-flow__node.selectable.dragging {
        transition: none;
    }

    .react-flow__attribution {
        font-size: 9px;
        opacity: 0.4;
    }
`;

const nodeTypes: NodeTypes = {
    sid_focused: SidNode,
    sid_secondary: SidNode,
    partner: PartnerNode,
};

/* Build 268 — P4 floating edges: paths run center-to-center clipped at the
 * node's visible shape instead of the fixed top/bottom handles, so
 * arrowheads meet nodes head-on along the actual node-to-node direction
 * (see FloatingEdge.tsx). */
const edgeTypes: EdgeTypes = {
    floating: FloatingEdge,
};

/* Build 264/265 — zoom clamps + fit padding, shared by the ReactFlow props
 * and the manual fit math. minZoom 0.25 -> 0.1: the 262 star-system
 * layout's world bbox (~4300x2500) needs fit zoom ~0.17 on the
 * Live-Activity-expanded canvas; at 0.25 every fit CLAMPED to the floor
 * and the content rendered cropped. */
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 2.5;
const FIT_PADDING = 0.05;

interface TopologyGraphProps {
    nodes: TopologyNode[];
    edges: TopologyEdge[];
    /** Optional saved positions from localStorage; overrides force layout. */
    savedPositions?: { id: string; x: number; y: number }[] | null;
    /** When true, snap drag-end positions to the 20 px grid. */
    snapMode: boolean;
    /** Integration types the user wants visible. Edges not in this set fade to 20% opacity. */
    enabledTypes: Set<IntegrationType>;
    /** Currently selected node id (drives node `selected` flag). */
    selectedNodeId: string | null;
    /** Currently selected edge id (drives edge `selected` flag). Build 202 /
     *  session 036 — mutex with selectedNodeId enforced at the parent
     *  IntegrationTopology level. */
    selectedEdgeId?: string | null;
    /** Layout algorithm to use for initial positioning when no saved layout
     *  applies. 'force' = d3-force (sync), 'layered' = ELK Sugiyama (async,
     *  lazy-loaded), 'tree' = ELK mrtree (async, lazy-loaded). Build 202 /
     *  session 036 added Tree. */
    layoutMode?: LayoutMode;
    /** Returns the target canvas size (CSS px) the layout should design
     *  for — the center canvas AS IF the Live Activity panel is collapsed
     *  (build 262 / session 077 Task 2). Read at layout-compute time (not
     *  a reactive dep) so panel resizes don't churn re-layouts. Null when
     *  measurement isn't available; the layout falls back to defaults. */
    getLayoutWorld?: () => { width: number; height: number } | null;
    /** Notified when the user clicks a node (for the right side panel). */
    onNodeClick?: (nodeId: string) => void;
    /** Notified when the user clicks an edge (for the right side panel's
     *  Edge Details mode). Build 202 / session 036. */
    onEdgeClick?: (edgeId: string) => void;
    /** Notified when the user clicks empty canvas (clear selection). */
    onPaneClick?: () => void;
    /** Notified after the user drops a dragged node — supplies new positions for save-layout. */
    onLayoutChange?: (positions: { id: string; x: number; y: number }[]) => void;
}

/** Imperative handle exposed via React's forwardRef pattern (build 169 /
 *  session 028). Lets the parent capture the current ReactFlow viewport
 *  on Save Layout and re-apply a saved viewport on Load Layout. */
export interface TopologyGraphHandle {
    getViewport(): { x: number; y: number; zoom: number } | null;
    setViewport(v: { x: number; y: number; zoom: number }): void;
    /** Refit the viewport to the current node bbox — used after the Live
     *  Activity panel toggles so the layout actually claims the vertical
     *  space the collapse frees (build 262 / session 077 Task 2). */
    fitView(): void;
}

const TopologyGraph = forwardRef<TopologyGraphHandle, TopologyGraphProps>(({
    nodes,
    edges,
    savedPositions,
    snapMode,
    enabledTypes,
    selectedNodeId,
    selectedEdgeId,
    layoutMode = 'force',
    getLayoutWorld,
    onNodeClick,
    onEdgeClick,
    onPaneClick,
    onLayoutChange,
}, ref) => {
    const flowRef = useRef<ReactFlowInstance | null>(null);
    /* ReactFlow's own zustand store — the authoritative live canvas
     * dimensions (kept current by RF's internal ResizeObserver). Available
     * because IntegrationTopology wraps us in <ReactFlowProvider>. */
    const storeApi = useStoreApi();
    /* Latest measurement callback in a ref so the layout effect reads the
     * current canvas size WITHOUT re-triggering on parent re-renders. */
    const getLayoutWorldRef = useRef(getLayoutWorld);
    getLayoutWorldRef.current = getLayoutWorld;

    /* Build 265/266 — MANUAL fit-to-bounds. Empirically (live on v12.10.2,
     * session 077) every runtime `inst.fitView()` call is a SILENT NO-OP
     * in our setup — the built-in Controls fit button included; only the
     * `fitView` mount prop ever fit the viewport. `setViewport` with
     * duration 0 is the proven-working primitive (build 220/221 minimap
     * navigation), so fit = compute node bounds + centering transform
     * ourselves and set the viewport directly. Canvas dims come from RF's
     * store (266) — NOT a styled-component ref on FlowWrap, whose
     * forwarding is unreliable here (session-036 sticky, re-confirmed live
     * when the 265 ref-based fit silently bailed). Zoom clamps mirror the
     * ReactFlow props below. */
    const manualFitView = useCallback(() => {
        const inst = flowRef.current;
        if (!inst || typeof inst.setViewport !== 'function' || typeof inst.getNodes !== 'function') return;
        /* Prefer a LIVE synchronous canvas measurement over the RF store
         * (Phase-5 sweep, build 272). getBoundingClientRect() forces a
         * style+layout flush and is current even in occluded/backgrounded
         * windows, where RF's ResizeObserver (paint-driven) can lag one
         * paint behind — proven live: after a Live-Activity toggle the
         * store still reported the pre-toggle height while gBCR already
         * returned the final one, so all three staggered fit timers
         * computed a fit for the OLD canvas. The store stays as fallback
         * (single .react-flow instance per page — same querySelector
         * pattern as the build-266 getLayoutWorld fallbacks). */
        const rfEl = document.querySelector('.react-flow');
        const rect = rfEl ? rfEl.getBoundingClientRect() : null;
        const store = storeApi.getState();
        const width = rect && rect.width >= 50 ? rect.width : store.width;
        const height = rect && rect.height >= 50 ? rect.height : store.height;
        if (!width || !height || width < 50 || height < 50) return;
        const rfNodes = inst.getNodes();
        if (rfNodes.length === 0) return;
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        rfNodes.forEach((n) => {
            const w = n.measured?.width ?? n.width ?? 0;
            const h = n.measured?.height ?? n.height ?? 0;
            minX = Math.min(minX, n.position.x);
            minY = Math.min(minY, n.position.y);
            maxX = Math.max(maxX, n.position.x + w);
            maxY = Math.max(maxY, n.position.y + h);
        });
        const bw = Math.max(1, maxX - minX);
        const bh = Math.max(1, maxY - minY);
        const zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.min(
            width / (bw * (1 + 2 * FIT_PADDING)),
            height / (bh * (1 + 2 * FIT_PADDING)),
        )));
        const x = (width - bw * zoom) / 2 - minX * zoom;
        const y = (height - bh * zoom) / 2 - minY * zoom;
        inst.setViewport({ x, y, zoom }, { duration: 0 });
    }, [storeApi]);
    /* Phase 0 Magnetic re-theme (build 246): resolved literal-hex tokens
     * for @xyflow plumbing that can't take CSS var() references —
     * markerEnd.color (SVG marker defs), MiniMap nodeColor (fill
     * attributes), Background dot color. Mode flips re-run the edge-sync
     * effect below via the `tokens` dep. */
    const { tokens, mode } = useThemeMode();

    useImperativeHandle(
        ref,
        () => ({
            getViewport: () => {
                const inst = flowRef.current;
                if (!inst || typeof inst.getViewport !== 'function') return null;
                const v = inst.getViewport();
                return v ? { x: v.x, y: v.y, zoom: v.zoom } : null;
            },
            setViewport: (v) => {
                const inst = flowRef.current;
                if (!inst || typeof inst.setViewport !== 'function') return;
                /* duration: 0 = no animation. Layout-load is meant to feel
                 * instant, like a checkpoint restore — not an animated zoom. */
                inst.setViewport(v, { duration: 0 });
            },
            fitView: manualFitView,
        }),
        [manualFitView],
    );

    /**
     * Initial node positions — saved layout takes priority; otherwise the
     * active layoutMode dispatches to either d3-force (sync) or ELK
     * Layered (async, lazy-loaded). Build 200 / session 035 — converted
     * from synchronous useMemo to async useEffect to accommodate ELK's
     * Promise-returning API. The 600 ms glide animation masks the brief
     * async gap so users see nodes settle into position smoothly
     * regardless of which layout engine produced them.
     */
    const [initialPositions, setInitialPositions] = React.useState<{ x: number; y: number }[]>([]);
    React.useEffect(() => {
        let cancelled = false;
        (async (): Promise<void> => {
            if (savedPositions && savedPositions.length > 0) {
                const map = new Map(savedPositions.map((p) => [p.id, { x: p.x, y: p.y }]));
                const positions = nodes.map((n) => map.get(n.id) ?? { x: 0, y: 0 });
                if (!cancelled) setInitialPositions(positions);
                return;
            }
            try {
                /* Build 262 / session 077 Task 2 — derive the layout world
                 * from the measured canvas (as if Live Activity is
                 * collapsed): hold width at 4000 world units and aspect-
                 * match the height. Absolute numbers don't matter (fitView
                 * normalizes) — the aspect + width feed the slot spread and
                 * vertical mid-line. Clamped so a mid-mount degenerate
                 * measurement can't produce a silly world. */
                const canvas = getLayoutWorldRef.current?.() ?? null;
                let worldW: number | undefined;
                let worldH: number | undefined;
                if (canvas && canvas.width >= 200 && canvas.height >= 150) {
                    const aspect = Math.min(1.2, Math.max(0.22, canvas.height / canvas.width));
                    worldW = 4000;
                    worldH = Math.round(4000 * aspect);
                }
                const positioned = worldW !== undefined && worldH !== undefined
                    ? await computeLayout(layoutMode, nodes, edges, worldW, worldH)
                    : await computeLayout(layoutMode, nodes, edges);
                if (cancelled) return;
                const posMap = new Map(positioned.map((p) => [p.id, { x: p.x, y: p.y }]));
                const positions = nodes.map((n) => posMap.get(n.id) ?? { x: 0, y: 0 });
                setInitialPositions(positions);
            } catch (err) {
                /* ELK can throw on malformed graphs (unlikely with our
                 * schema but defend defensively). Fall back to a flat
                 * grid so the user still sees nodes; surface the error
                 * to console for diagnostics. */
                // eslint-disable-next-line no-console
                console.error('Topology layout failed:', err);
                if (!cancelled) {
                    setInitialPositions(nodes.map(() => ({ x: 0, y: 0 })));
                }
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [nodes, edges, savedPositions, layoutMode]);

    const [flowNodes, setFlowNodes] = React.useState<Node[]>([]);
    const [flowEdges, setFlowEdges] = React.useState<Edge[]>([]);

    /**
     * Sync our (nodes + initialPositions + selection) into ReactFlow node state.
     * We re-run when any input changes; user drags update flowNodes directly
     * via applyNodeChanges, so they're not lost between renders.
     *
     * After layout recompute (initialPositions reference change), fit the
     * viewport so the new arrangement fills the canvas at default zoom.
     * Build 192 / session 035 layout redesign — replaces the prior default-
     * mount-only `fitView` prop behavior. Triggered on time-range change
     * (new node set), force-rerun, and saved-layout load.
     */
    React.useEffect(() => {
        setFlowNodes(
            nodes.map((n, i) => ({
                id: n.id,
                type: n.kind,
                position: initialPositions[i] ?? { x: 0, y: 0 },
                data: { ...n },
                selected: n.id === selectedNodeId,
            })),
        );
        /* Two nested rAFs: first lets React commit the setFlowNodes change,
         * second lets ReactFlow's internals (node sizing, viewport bounds)
         * settle before fitView reads them. Without the double-rAF, fitView
         * occasionally reads pre-layout bounds and over-zooms. */
        window.requestAnimationFrame(() => {
            window.requestAnimationFrame(() => {
                /* Build 194 — padding tightened from 0.12 to 0.05 so default
                 * zoom uses more of the viewport. Build 265 — routed through
                 * the manual fit: the previous inst.fitView() call here was
                 * a silent no-op (see manualFitView above); layout
                 * recomputes without a remount (e.g. time-range changes)
                 * were never actually refitting. */
                manualFitView();
            });
        });
        /* Timer fallback (build 267): rAF freezes in occluded windows —
         * make sure a recompute still refits there. Idempotent. */
        window.setTimeout(manualFitView, 400);
        // Intentionally exclude selectedNodeId from the dep array — selection
        // updates are handled by the second effect below to avoid clobbering
        // user-dragged positions.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [nodes, initialPositions]);

    /** Selection-only updates without re-positioning. */
    React.useEffect(() => {
        setFlowNodes((prev) => prev.map((fn) => ({ ...fn, selected: fn.id === selectedNodeId })));
    }, [selectedNodeId]);

    /** Edge sync — re-run when edges, filter set, edge selection, or theme
     *  mode changes (filter affects opacity; selection affects stroke width
     *  + glow; mode swaps the resolved token palette). Edge colors use the
     *  RESOLVED hex tokens (not logservTheme var() refs) because
     *  `markerEnd.color` flows into @xyflow's SVG <marker> defs and the
     *  label fills flow into SVG text/rect fills — attribute positions
     *  where CSS variables don't resolve. Build 246 / Phase 0. */
    React.useEffect(() => {
        /* Build 268 — P4: mark edges whose REVERSE direction also exists so
         * FloatingEdge can offset the two straight lines apart (they would
         * otherwise overlap exactly). */
        const directions = new Set(edges.map((e) => `${e.source}=>${e.target}`));
        setFlowEdges(
            edges.map((e) => {
                const enabled = enabledTypes.has(e.type);
                const isSelected = e.id === selectedEdgeId;
                const styleBits = edgeStyleFor(e, tokens);
                const hasReverse = directions.has(`${e.target}=>${e.source}`);
                /* Selected edges get a thicker stroke + cyan-light highlight
                 * stroke color so the user can see which edge they picked.
                 * Build 202 / session 036. */
                const stroke = isSelected ? tokens.cyanLight : styleBits.stroke;
                const strokeWidth = isSelected
                    ? Math.max(3, styleBits.strokeWidth + 1.5)
                    : styleBits.strokeWidth;
                return {
                    id: e.id,
                    source: e.source,
                    target: e.target,
                    /* Build 268 — P4 floating edges (center-to-center,
                     * shape-clipped straight paths; see FloatingEdge.tsx). */
                    type: 'floating',
                    label: e.callCount.toLocaleString(),
                    selected: isSelected,
                    style: {
                        stroke,
                        strokeWidth,
                        strokeDasharray: styleBits.strokeDasharray,
                        // 0.55 base opacity keeps edges legible without
                        // overwhelming nodes; animated/high-volume edges go
                        // a bit higher to draw the eye to traffic hot spots.
                        // Selected edges go to full opacity.
                        opacity: isSelected ? 1 : enabled ? (styleBits.animated ? 0.7 : 0.55) : 0.16,
                    },
                    animated: enabled && styleBits.animated,
                    markerEnd: {
                        type: MarkerType.ArrowClosed,
                        color: stroke,
                        width: 16,
                        height: 16,
                    },
                    labelStyle: { fill: tokens.textActive, fontSize: 10, fontWeight: 600 },
                    labelBgStyle: { fill: tokens.panelBackground, fillOpacity: 0.85 },
                    labelBgBorderRadius: 3,
                    labelBgPadding: [4, 6],
                    data: { type: e.type, callCount: e.callCount, direction: e.direction, hasReverse },
                };
            }),
        );
    }, [edges, enabledTypes, selectedEdgeId, tokens]);

    const handleNodesChange = useCallback((changes: NodeChange[]) => {
        setFlowNodes((nds) => applyNodeChanges(changes, nds));
    }, []);

    const handleEdgesChange = useCallback((changes: EdgeChange[]) => {
        setFlowEdges((eds) => applyEdgeChanges(changes, eds));
    }, []);

    const handleNodeDragStop = useCallback<NodeMouseHandler>(
        (_event, node) => {
            // Snap-to-grid on release if the toolbar toggle is on.
            if (snapMode) {
                const snapped = snapToGrid(node.position.x, node.position.y);
                setFlowNodes((nds) =>
                    nds.map((n) => (n.id === node.id ? { ...n, position: snapped } : n)),
                );
            }
            // Always notify upward — the dashboard tracks "dirty layout" + the
            // toolbar's "Save Layout" button serializes whatever we've got.
            if (onLayoutChange) {
                setFlowNodes((nds) => {
                    onLayoutChange(nds.map((n) => ({ id: n.id, x: n.position.x, y: n.position.y })));
                    return nds;
                });
            }
        },
        [snapMode, onLayoutChange],
    );

    const handleNodeClick = useCallback<NodeMouseHandler>(
        (_event, node) => {
            if (onNodeClick) onNodeClick(node.id);
        },
        [onNodeClick],
    );

    const handleEdgeClick = useCallback<EdgeMouseHandler>(
        (_event, edge) => {
            if (onEdgeClick) onEdgeClick(edge.id);
        },
        [onEdgeClick],
    );

    const handlePaneClick = useCallback(() => {
        if (onPaneClick) onPaneClick();
    }, [onPaneClick]);

    /* Build 222 / session 037 — drag-to-pan on the MiniMap.
     *
     * Replaces the build-217-221 click-to-center listener AND the
     * @xyflow `pannable` / `zoomable` props (verified empirically broken
     * in our setup: d3-zoom IS attached to the SVG and __zoom does
     * advance during a synthesized drag, but the propagation from the
     * minimap's d3-zoom to the main canvas's panZoom never fires
     * inst.setViewport / panZoom.setViewportConstrained — main canvas
     * stays put. Documented in SESSION-MEMORY-037.md.)
     *
     * Per user direction: minimap should ONLY drag-to-pan. No
     * click-to-center, no scroll-zoom, no double-click. So we drop
     * the @xyflow `pannable`+`zoomable` props on <MiniMap> and the
     * build-220 click listener; this handler is the only minimap
     * interaction.
     *
     * Implementation: pointerdown on minimap-svg (anywhere except a
     * minimap-node) starts the drag, captures the pointer, and
     * stores the start position. Pointermove during drag computes
     * the cursor delta in screen pixels, scales to world units via
     * `vb.width / minimap.width` (the minimap's viewBox-to-pixel
     * ratio), multiplies by current zoom to get the viewport delta,
     * and calls inst.setViewport with `{ duration: 0 }` (the only
     * working duration in @xyflow v12.10.2 from outside React's
     * event delegation, per build 221). Direction: cursor +dx → vp.x
     * decreases (canvas pans right, cursor's world coord stays under
     * the cursor in minimap space). */
    React.useEffect(() => {
        let dragging = false;
        let lastX = 0;
        let lastY = 0;
        let svg: SVGSVGElement | null = null;
        let pointerId = -1;

        const onPointerDown = (e: PointerEvent): void => {
            if (e.button !== 0) return;
            const target = e.target as HTMLElement | null;
            if (!target) return;
            const found = target.closest('.react-flow__minimap-svg') as SVGSVGElement | null;
            if (!found) return;
            if (target.closest('.react-flow__minimap-node')) return;
            const inst = flowRef.current;
            if (!inst) return;
            dragging = true;
            svg = found;
            pointerId = e.pointerId;
            lastX = e.clientX;
            lastY = e.clientY;
            try {
                found.setPointerCapture(e.pointerId);
            } catch {
                /* setPointerCapture can throw on synthetic events;
                 * window-level pointermove fallback handles that. */
            }
            e.stopPropagation();
            e.preventDefault();
        };

        const onPointerMove = (e: PointerEvent): void => {
            if (!dragging || !svg) return;
            const inst = flowRef.current;
            if (!inst) return;
            const r = svg.getBoundingClientRect();
            const vb = svg.viewBox.baseVal;
            if (!vb || r.width === 0 || r.height === 0) return;
            const dx = e.clientX - lastX;
            const dy = e.clientY - lastY;
            lastX = e.clientX;
            lastY = e.clientY;
            const ux = vb.width / r.width;
            const uy = vb.height / r.height;
            const cur = inst.getViewport();
            const nextX = cur.x - dx * ux * cur.zoom;
            const nextY = cur.y - dy * uy * cur.zoom;
            inst.setViewport({ x: nextX, y: nextY, zoom: cur.zoom }, { duration: 0 });
            e.stopPropagation();
            e.preventDefault();
        };

        const endDrag = (e: PointerEvent): void => {
            if (!dragging) return;
            dragging = false;
            if (svg && pointerId >= 0) {
                try { svg.releasePointerCapture(pointerId); } catch { /* ignore */ }
            }
            svg = null;
            pointerId = -1;
            e.stopPropagation();
        };

        document.addEventListener('pointerdown', onPointerDown, true);
        document.addEventListener('pointermove', onPointerMove, true);
        document.addEventListener('pointerup', endDrag, true);
        document.addEventListener('pointercancel', endDrag, true);
        return () => {
            document.removeEventListener('pointerdown', onPointerDown, true);
            document.removeEventListener('pointermove', onPointerMove, true);
            document.removeEventListener('pointerup', endDrag, true);
            document.removeEventListener('pointercancel', endDrag, true);
        };
    }, []);

    return (
        <FlowWrap>
            <ReactFlow
                nodes={flowNodes}
                edges={flowEdges}
                nodeTypes={nodeTypes}
                edgeTypes={edgeTypes}
                onNodesChange={handleNodesChange}
                onEdgesChange={handleEdgesChange}
                onNodeDragStop={handleNodeDragStop}
                onNodeClick={handleNodeClick}
                onEdgeClick={handleEdgeClick}
                onPaneClick={handlePaneClick}
                onInit={(inst) => { flowRef.current = inst; }}
                fitView
                colorMode={mode}
                attributionPosition="bottom-right"
                proOptions={{ hideAttribution: true }}
                minZoom={MIN_ZOOM}
                maxZoom={MAX_ZOOM}
            >
                {/* Faint Magnetic dot-grid (plan §8, Phase 3 / build 257):
                  * near-invisible texture, not a visible grid — low-alpha
                  * ink per mode instead of a border token (whose light
                  * value is indistinguishable from the page bg). */}
                <Background
                    variant={BackgroundVariant.Dots}
                    gap={20}
                    size={1.2}
                    color={mode === 'light' ? 'rgba(15, 18, 20, 0.07)' : 'rgba(247, 247, 247, 0.06)'}
                />
                <Controls showInteractive={false} />
                {/* Build 222 / session 037 — `pannable` and `zoomable` props
                 * dropped because @xyflow/react v12.10.2's MiniMap pannable
                 * implementation doesn't propagate from minimap d3-zoom to
                 * main canvas panZoom in our setup (verified empirically:
                 * minimap __zoom advances during drag but inst.setViewport
                 * is never called and main DOM transform stays put).
                 * Replaced by the document-level pointerdown/move/up
                 * handler in the useEffect above. */}
                <MiniMap
                    nodeColor={(n) => {
                        const k = (n.data as { kind?: string })?.kind;
                        if (k === 'sid_focused') return tokens.red;
                        if (k === 'sid_secondary') return tokens.cyanLight;
                        return tokens.textMuted;
                    }}
                    // Magnetic minimap mask per mode (plan §8): a light wash
                    // in light mode, the heavy dark scrim in dark mode.
                    maskColor={mode === 'light' ? 'rgba(0, 0, 0, 0.08)' : 'rgba(0, 0, 0, 0.55)'}
                    style={{ width: 140, height: 100, cursor: 'grab' }}
                />
            </ReactFlow>
        </FlowWrap>
    );
});

TopologyGraph.displayName = 'TopologyGraph';

export default TopologyGraph;
