import {
    forceSimulation,
    forceLink,
    forceManyBody,
    forceCenter,
    forceCollide,
    type SimulationNodeDatum,
} from 'd3-force';
import type { TopologyNode, TopologyEdge } from './types';

/**
 * Force-directed initial layout via d3-force.
 *
 * Runs synchronously to a stable state on mount, then hands the resulting
 * (x, y) positions to @xyflow/react. After mount, dragging is handled by
 * @xyflow/react and we no longer touch the simulation — it's purely an
 * initial-position helper.
 *
 * The simulation is configured for ~18 nodes / ~24 edges (the prototype
 * fixture); parameters may need tuning when session 024 swaps in real data
 * with potentially 70-200 nodes.
 */

interface SimNode extends SimulationNodeDatum {
    id: string;
    kind: TopologyNode['kind'];
}

interface SimLink {
    source: string;
    target: string;
}

export interface PositionedNode {
    id: string;
    x: number;
    y: number;
}

const DEFAULT_WIDTH = 1200;
const DEFAULT_HEIGHT = 720;

export const computeForceLayout = (
    nodes: TopologyNode[],
    edges: TopologyEdge[],
    width: number = DEFAULT_WIDTH,
    height: number = DEFAULT_HEIGHT,
): PositionedNode[] => {
    const simNodes: SimNode[] = nodes.map((n) => ({ id: n.id, kind: n.kind }));
    const simLinks: SimLink[] = edges.map((e) => ({ source: e.source, target: e.target }));

    // Stronger repulsion for focused SIDs so they sit centrally; partner
    // nodes get lighter repulsion so they cluster near the SID they connect to.
    const charge = (n: SimNode): number => {
        if (n.kind === 'sid_focused') return -1400;
        if (n.kind === 'sid_secondary') return -700;
        return -250;
    };

    // Larger collision radius for focused SIDs (visually bigger circles).
    const collide = (n: SimNode): number => {
        if (n.kind === 'sid_focused') return 70;
        if (n.kind === 'sid_secondary') return 45;
        return 32;
    };

    const sim = forceSimulation<SimNode>(simNodes)
        .force(
            'link',
            forceLink<SimNode, SimLink>(simLinks)
                .id((d) => d.id)
                .distance(180)
                .strength(0.4),
        )
        .force('charge', forceManyBody<SimNode>().strength((d) => charge(d)))
        .force('center', forceCenter(width / 2, height / 2))
        .force('collide', forceCollide<SimNode>().radius((d) => collide(d)))
        .stop();

    // Synchronous tick to a stable state. 300 ticks is plenty for <50 nodes.
    for (let i = 0; i < 300; i += 1) {
        sim.tick();
    }

    return simNodes.map((n) => ({
        id: n.id,
        x: typeof n.x === 'number' ? n.x : width / 2,
        y: typeof n.y === 'number' ? n.y : height / 2,
    }));
};

/**
 * Snap a node position to a fixed grid. Used when the user has snap-mode
 * enabled in the toolbar — drag-end positions get rounded to the nearest grid
 * intersection.
 */
export const snapToGrid = (x: number, y: number, gridSize: number = 20): { x: number; y: number } => {
    return {
        x: Math.round(x / gridSize) * gridSize,
        y: Math.round(y / gridSize) * gridSize,
    };
};
