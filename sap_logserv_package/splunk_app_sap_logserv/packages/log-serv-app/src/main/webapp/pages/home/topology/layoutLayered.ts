import type { TopologyNode, TopologyEdge } from './types';
import type { PositionedNode } from './layout';

/**
 * ELK layered (Sugiyama) layout — async lazy-loaded wrapper.
 *
 * Build 200 / session 035 — adds an alternative to d3-force for users who
 * prefer the strict left-to-right traffic-flow visual character. Edges
 * route orthogonally (right-angled) and Sugiyama's crossing-minimization
 * pass produces near-zero edge crossings within and between layers.
 *
 * elkjs is dynamically imported (≈280 KB gzip) so the bundle hit only
 * applies to users who actually pick this layout from the toolbar — Force
 * mode users see no bundle change.
 *
 * The function signature matches `computeForceLayout` modulo the Promise
 * wrapper so the dispatcher in `layout.ts` can swap implementations
 * without changing call sites.
 */

/* Cache the ELK instance across calls so we only pay the ~280 KB bundle
 * load + WASM init cost once. The instance is stateless w.r.t. layout
 * runs — same instance can layout many graphs in parallel. */
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
    /* Dynamic import keeps elkjs out of the main bundle. Webpack splits
     * this into its own chunk that's fetched only when the user first
     * picks Layered mode. The `.bundled.js` file includes the worker
     * inlined — no separate worker request, no CORS hassle, no Splunk
     * static-asset routing concerns. */
    const elkModule = await import(
        /* webpackChunkName: "elkjs-bundled" */
        'elkjs/lib/elk.bundled.js'
    );
    const ElkCtor = (elkModule.default || elkModule) as new () => ElkInstance;
    elkInstance = new ElkCtor();
    return elkInstance;
};

/**
 * Per-kind node sizing for the layered layout. ELK uses these to decide
 * inter-node spacing within a layer.
 *
 * Build 202 / session 036 — bumped height values to account for the
 * LABEL TEXT rendered BELOW each node.
 *
 * Build 209 / session 036 — bumped WIDTH and HEIGHT to match the
 * post-build-207/208 actual visual extent including the call-bucket
 * health ring (SidNode) or outline (PartnerNode) plus label margin.
 *
 * Visual extent breakdown:
 *   - sid_focused: disc 100 + ring 19.5 px each side = 139 wide;
 *     ring 19.5 below + 22 label margin + 14 label = 55.5 below disc;
 *     total height ~159. Pad to 145 x 175.
 *   - sid_secondary: disc 68 + ring 19.5 each side = 107 wide;
 *     ring 19.5 + 22 + 14 = 55.5 below; total ~125. Pad to 115 x 145.
 *   - partner: square 53 + outline 17 each side = 87 wide;
 *     outline 17 + 20 label margin + 14 label + 2 + 10 tag = 63
 *     below; total ~133. Pad to 95 x 145.
 *
 * Without this update ELK packed nodes by their UNDERSIZED bounding
 * boxes (50/60/70 wide), so the new larger rings overlapped neighbors
 * in the leftmost column of the Layered layout — see user-reported
 * crowding screenshot in session 036.
 */
const sizeForNode = (n: TopologyNode): { width: number; height: number } => {
    if (n.kind === 'sid_focused') return { width: 145, height: 175 };
    if (n.kind === 'sid_secondary') return { width: 115, height: 145 };
    return { width: 95, height: 145 };
};

export const computeLayeredLayout = async (
    nodes: TopologyNode[],
    edges: TopologyEdge[],
): Promise<PositionedNode[]> => {
    if (nodes.length === 0) return [];

    const elk = await getElk();

    /* Filter edges to those whose endpoints are both in the node set —
     * defends against orphaned edge references that would crash ELK with
     * "Could not find node X". */
    const nodeIdSet = new Set(nodes.map((n) => n.id));
    const safeEdges = edges.filter(
        (e) => nodeIdSet.has(e.source) && nodeIdSet.has(e.target),
    );

    const graph: ElkGraphInput = {
        id: 'root',
        layoutOptions: {
            'elk.algorithm': 'layered',
            /* Build 201 — DOWN direction (top-to-bottom flow). Initial RIGHT
             * direction in build 200 produced a tall+narrow layout (1660 ×
             * 2573 px) because each layer column had ~40 nodes stacked
             * vertically. With DOWN, layers become horizontal rows and
             * within-layer nodes spread horizontally — a much better fit
             * for our wide viewport (3:1 aspect). Sources end up at top,
             * targets at bottom. */
            'elk.direction': 'DOWN',
            /* Build 202 / session 036 — bumped row spacing 110 → 160 so
             * partner nodes in adjacent rows have visual breathing room and
             * the labels under each node don't bump against the next row's
             * outline. */
            'elk.layered.spacing.nodeNodeBetweenLayers': '160',
            /* Build 202 — bumped horizontal nodeNode spacing 55 → 110.
             * Earlier value left partner-heavy rows (20+ partner leaves
             * fanning out from a hub) packed shoulder-to-shoulder with
             * labels overlapping. Doubling the spacing widens those rows
             * past the visible viewport bounds (the user can pan with
             * MiniMap or zoom out to see the whole graph) but eliminates
             * the cramped feel within a row. */
            'elk.spacing.nodeNode': '110',
            /* Build 202 — explicit edge-routing channel spacing controls
             * so orthogonal segments don't crowd against node boundaries. */
            'elk.layered.spacing.edgeNodeBetweenLayers': '50',
            'elk.layered.spacing.edgeEdgeBetweenLayers': '25',
            /* Crossing-minimization thoroughness — 15 is good balance for
             * <100 node graphs (<50 ms typical). */
            'elk.layered.thoroughness': '15',
            'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
            /* Build 202 — node placement strategy. BRANDES_KOEPF spreads
             * nodes more evenly within each layer than the default LINEAR
             * (which packs them tight against the upstream parent), which
             * pairs well with the bumped horizontal spacing to give the
             * graph a more deliberately-spaced feel. */
            'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
            /* Orthogonal edges = canonical Sugiyama presentation. ReactFlow
             * may bezier-smooth the actual visual but ELK's routing
             * decisions still produce the cleanest channel assignments. */
            'elk.edgeRouting': 'ORTHOGONAL',
            /* LONGEST_PATH layering instead of NETWORK_SIMPLEX — produces
             * fewer total layers (typically 3-5 for a hub-and-spoke graph
             * vs 7-9 for NETWORK_SIMPLEX), which means rows have more nodes
             * and the layout is wider than tall. Better fit for our viewport. */
            'elk.layered.layering.strategy': 'LONGEST_PATH',
            /* Padding around the whole layout. Bumped to 60 so the outer
             * nodes don't sit flush against the canvas edge. */
            'elk.padding': '[top=60, left=60, bottom=60, right=60]',
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

    /* ELK returns x/y as the TOP-LEFT corner of the node's bounding box.
     * ReactFlow also expects top-left positioning, so no offset adjustment
     * needed — the position values flow through as-is. */
    return out.map((c) => ({
        id: c.id,
        x: typeof c.x === 'number' ? c.x : 0,
        y: typeof c.y === 'number' ? c.y : 0,
    }));
};
