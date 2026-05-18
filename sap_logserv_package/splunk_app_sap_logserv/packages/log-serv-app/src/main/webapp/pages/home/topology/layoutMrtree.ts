import type { TopologyNode, TopologyEdge } from './types';
import type { PositionedNode } from './layout';

/**
 * ELK mrtree (Mr Tree) layout — async lazy-loaded wrapper.
 *
 * Build 202 / session 036 — adds a third layout option alongside Force
 * (d3-force) and Layered (ELK Sugiyama). mrtree produces classic tree-shaped
 * arrangements with hubs at the top and spokes radiating downward. For our
 * SAP-integration topologies (which are mostly hub-and-spoke with a few SID
 * focal hubs and many partner leaves), this often produces the cleanest
 * visual when the user wants a "what does this SID's neighborhood look like"
 * perspective.
 *
 * Differences from Layered:
 *   - mrtree treats the graph as a (possibly non-strict) tree and lays out
 *     parent-child levels; doesn't enforce strict layered Sugiyama crossings
 *     minimization but works well when graph IS approximately tree-shaped.
 *   - For graphs with many cross-cluster edges, Layered may still be cleaner;
 *     for hub-and-spoke, Tree often reads better.
 *
 * The function signature matches `computeLayeredLayout` modulo the algorithm
 * parameter so the dispatcher in `layout.ts` can swap implementations without
 * changing call sites. Reuses the same lazy-loaded ElkInstance from
 * `layoutLayered.ts`.
 */

type ElkInstance = {
    layout: (graph: ElkGraphInput) => Promise<ElkGraphOutput>;
};

interface ElkChild {
    id: string;
    width: number;
    height: number;
    x?: number;
    y?: number;
}

interface ElkEdge {
    id: string;
    sources: string[];
    targets: string[];
}

interface ElkGraphInput {
    id: string;
    layoutOptions: Record<string, string>;
    children: ElkChild[];
    edges: ElkEdge[];
}

interface ElkGraphOutput {
    children?: ElkChild[];
}

let elkInstance: ElkInstance | null = null;

const getElk = async (): Promise<ElkInstance> => {
    if (elkInstance) return elkInstance;
    const elkModule = await import(
        /* webpackChunkName: "elkjs-bundled" */
        'elkjs/lib/elk.bundled.js'
    );
    const ElkCtor = (elkModule.default || elkModule) as new () => ElkInstance;
    elkInstance = new ElkCtor();
    return elkInstance;
};

/**
 * Per-kind node sizing — kept in lockstep with layoutLayered.ts. Build 209
 * bumped values to match the actual visual extent of nodes after the
 * call-bucket ring + outline additions in builds 207/208. See
 * layoutLayered.ts sizeForNode for the visual-extent breakdown.
 */
const sizeForNode = (n: TopologyNode): { width: number; height: number } => {
    if (n.kind === 'sid_focused') return { width: 145, height: 175 };
    if (n.kind === 'sid_secondary') return { width: 115, height: 145 };
    return { width: 95, height: 145 };
};

export const computeMrtreeLayout = async (
    nodes: TopologyNode[],
    edges: TopologyEdge[],
): Promise<PositionedNode[]> => {
    if (nodes.length === 0) return [];

    const elk = await getElk();

    /* Filter edges to those whose endpoints are both in the node set —
     * defends against orphaned edge references. */
    const nodeIdSet = new Set(nodes.map((n) => n.id));
    const safeEdges = edges.filter(
        (e) => nodeIdSet.has(e.source) && nodeIdSet.has(e.target),
    );

    const graph: ElkGraphInput = {
        id: 'root',
        layoutOptions: {
            'elk.algorithm': 'mrtree',
            /* DOWN = parents at top, children below. Matches our wide
             * viewport's natural orientation: SID hubs span the top row,
             * partner leaves fan out below. */
            'elk.direction': 'DOWN',
            /* Spacing controls — mrtree uses a single nodeNode spacing for
             * both within-level and between-level gaps. 90 px gives partner
             * leaves room to breathe without making the tree feel sparse. */
            'elk.spacing.nodeNode': '90',
            /* Padding around the whole tree. */
            'elk.padding': '[top=30, left=30, bottom=30, right=30]',
        },
        children: nodes.map((n) => ({
            id: n.id,
            ...sizeForNode(n),
        })),
        edges: safeEdges.map((e) => ({
            id: e.id,
            sources: [e.source],
            targets: [e.target],
        })),
    };

    const result = await elk.layout(graph);
    const out = result.children || [];

    return out.map((c) => ({
        id: c.id,
        x: typeof c.x === 'number' ? c.x : 0,
        y: typeof c.y === 'number' ? c.y : 0,
    }));
};
