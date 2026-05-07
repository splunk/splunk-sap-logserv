import React, { forwardRef, useCallback, useImperativeHandle, useMemo, useRef } from 'react';
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
import { computeForceLayout, snapToGrid } from '../../topology/layout';
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
    /** Notified when the user clicks a node (for the right side panel). */
    onNodeClick?: (nodeId: string) => void;
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
    onNodeClick,
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
     * Initial node positions — saved layout takes priority over force.
     * Computed once per (nodes, edges, savedPositions) reference change.
     */
    const initialPositions = useMemo(() => {
        if (savedPositions && savedPositions.length > 0) {
            const map = new Map(savedPositions.map((p) => [p.id, { x: p.x, y: p.y }]));
            return nodes.map((n) => map.get(n.id) ?? { x: 0, y: 0 });
        }
        const positioned = computeForceLayout(nodes, edges);
        const posMap = new Map(positioned.map((p) => [p.id, { x: p.x, y: p.y }]));
        return nodes.map((n) => posMap.get(n.id) ?? { x: 0, y: 0 });
    }, [nodes, edges, savedPositions]);

    const [flowNodes, setFlowNodes] = React.useState<Node[]>([]);
    const [flowEdges, setFlowEdges] = React.useState<Edge[]>([]);

    /**
     * Sync our (nodes + initialPositions + selection) into ReactFlow node state.
     * We re-run when any input changes; user drags update flowNodes directly
     * via applyNodeChanges, so they're not lost between renders.
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
        // Intentionally exclude selectedNodeId from the dep array — selection
        // updates are handled by the second effect below to avoid clobbering
        // user-dragged positions.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [nodes, initialPositions]);

    /** Selection-only updates without re-positioning. */
    React.useEffect(() => {
        setFlowNodes((prev) => prev.map((fn) => ({ ...fn, selected: fn.id === selectedNodeId })));
    }, [selectedNodeId]);

    /** Edge sync — re-run when edges or filter set changes (filter affects opacity). */
    React.useEffect(() => {
        setFlowEdges(
            edges.map((e) => {
                const enabled = enabledTypes.has(e.type);
                const styleBits = edgeStyleFor(e);
                return {
                    id: e.id,
                    source: e.source,
                    target: e.target,
                    label: e.callCount.toLocaleString(),
                    style: {
                        stroke: styleBits.stroke,
                        strokeWidth: styleBits.strokeWidth,
                        strokeDasharray: styleBits.strokeDasharray,
                        // 0.55 base opacity keeps edges legible without
                        // overwhelming nodes; animated/high-volume edges go
                        // a bit higher to draw the eye to traffic hot spots.
                        opacity: enabled ? (styleBits.animated ? 0.7 : 0.55) : 0.16,
                    },
                    animated: enabled && styleBits.animated,
                    markerEnd: {
                        type: MarkerType.ArrowClosed,
                        color: styleBits.stroke,
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
    }, [edges, enabledTypes]);

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

    const handlePaneClick = useCallback(() => {
        if (onPaneClick) onPaneClick();
    }, [onPaneClick]);

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
                <MiniMap
                    pannable
                    zoomable
                    nodeColor={(n) => {
                        const k = (n.data as { kind?: string })?.kind;
                        if (k === 'sid_focused') return logservTheme.colors.red;
                        if (k === 'sid_secondary') return logservTheme.colors.cyanLight;
                        return logservTheme.colors.textMuted;
                    }}
                    maskColor="rgba(0, 0, 0, 0.55)"
                    style={{ width: 140, height: 100 }}
                />
            </ReactFlow>
        </FlowWrap>
    );
});

TopologyGraph.displayName = 'TopologyGraph';

export default TopologyGraph;
