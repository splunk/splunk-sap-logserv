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
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import styled from 'styled-components';
import { logservTheme } from '../../styles/logservTheme';
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
    --xy-minimap-mask-background-color: rgba(0, 0, 0, 0.6);
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
    onNodeClick,
    onEdgeClick,
    onPaneClick,
    onLayoutChange,
}, ref) => {
    const flowRef = useRef<ReactFlowInstance | null>(null);

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
        }),
        [],
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
                const positioned = await computeLayout(layoutMode, nodes, edges);
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
                const inst = flowRef.current;
                if (!inst || typeof inst.fitView !== 'function') return;
                /* Build 194 — padding tightened from 0.12 to 0.05 so default
                 * zoom uses more of the viewport. Combined with the layered
                 * forceX/forceY centering pull in layout.ts, outlier
                 * clusters are tugged in and the dense main clusters get
                 * proportionally more pixels at the auto-fit zoom level. */
                inst.fitView({ duration: 600, padding: 0.05 });
            });
        });
        // Intentionally exclude selectedNodeId from the dep array — selection
        // updates are handled by the second effect below to avoid clobbering
        // user-dragged positions.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [nodes, initialPositions]);

    /** Selection-only updates without re-positioning. */
    React.useEffect(() => {
        setFlowNodes((prev) => prev.map((fn) => ({ ...fn, selected: fn.id === selectedNodeId })));
    }, [selectedNodeId]);

    /** Edge sync — re-run when edges, filter set, or edge selection changes
     *  (filter affects opacity; selection affects stroke width + glow). */
    React.useEffect(() => {
        setFlowEdges(
            edges.map((e) => {
                const enabled = enabledTypes.has(e.type);
                const isSelected = e.id === selectedEdgeId;
                const styleBits = edgeStyleFor(e);
                /* Selected edges get a thicker stroke + cyan-light highlight
                 * stroke color so the user can see which edge they picked.
                 * Build 202 / session 036. */
                const stroke = isSelected ? logservTheme.colors.cyanLight : styleBits.stroke;
                const strokeWidth = isSelected
                    ? Math.max(3, styleBits.strokeWidth + 1.5)
                    : styleBits.strokeWidth;
                return {
                    id: e.id,
                    source: e.source,
                    target: e.target,
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
                    labelStyle: { fill: logservTheme.colors.textActive, fontSize: 10, fontWeight: 600 },
                    labelBgStyle: { fill: logservTheme.colors.panelBackground, fillOpacity: 0.85 },
                    labelBgBorderRadius: 3,
                    labelBgPadding: [4, 6],
                    data: { type: e.type, callCount: e.callCount, direction: e.direction },
                };
            }),
        );
    }, [edges, enabledTypes, selectedEdgeId]);

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
                onNodesChange={handleNodesChange}
                onEdgesChange={handleEdgesChange}
                onNodeDragStop={handleNodeDragStop}
                onNodeClick={handleNodeClick}
                onEdgeClick={handleEdgeClick}
                onPaneClick={handlePaneClick}
                onInit={(inst) => { flowRef.current = inst; }}
                fitView
                colorMode="dark"
                attributionPosition="bottom-right"
                proOptions={{ hideAttribution: true }}
                minZoom={0.25}
                maxZoom={2.5}
            >
                <Background
                    variant={BackgroundVariant.Dots}
                    gap={20}
                    size={1.2}
                    color={logservTheme.colors.panelBorderWeak}
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
                        if (k === 'sid_focused') return logservTheme.colors.red;
                        if (k === 'sid_secondary') return logservTheme.colors.cyanLight;
                        return logservTheme.colors.textMuted;
                    }}
                    maskColor="rgba(0, 0, 0, 0.55)"
                    style={{ width: 140, height: 100, cursor: 'grab' }}
                />
            </ReactFlow>
        </FlowWrap>
    );
});

TopologyGraph.displayName = 'TopologyGraph';

export default TopologyGraph;
