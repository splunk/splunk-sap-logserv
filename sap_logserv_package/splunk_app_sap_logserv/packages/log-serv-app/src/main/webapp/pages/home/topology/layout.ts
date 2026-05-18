import {
    forceSimulation,
    forceLink,
    forceManyBody,
    forceCenter,
    forceCollide,
    forceX,
    forceY,
    type SimulationNodeDatum,
} from 'd3-force';
import type { TopologyNode, TopologyEdge } from './types';

/**
 * Force-directed initial layout via d3-force.
 *
 * Single-canvas simulation: every node participates together with a shared
 * forceCenter. Mirrors the pre-KV-Store visual idiom (build 109+) — focused
 * SID hubs naturally pull partner nodes around them, secondary SIDs fall
 * into orbital relationships with their connected partners, and the whole
 * graph composes into a coherent single image rather than disjoint lobes.
 *
 * Build 193 / session 035 reverted from the lobed L→R layout (which broke
 * the user's expected visual reference). Wider spacing values from that
 * pass are preserved here so the partner crowding from the original blob
 * layout doesn't return.
 *
 * Output positions feed @xyflow/react via TopologyGraph; ReactFlow's
 * `fitView` rescales to the canvas at default zoom, ensuring the entire
 * topology is visible without manual panning.
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

/* Build 198 — SPREAD variant baked in as the canonical defaults after
 * iterating denser-vs-spread variants via URL params (build 197). Wider
 * 4:1 canvas + weak forceX (0.012) + strong forceY (0.13) lets the
 * topology spread horizontally to fill the wide center-pane viewport
 * while keeping vertical compact. Combined with stronger partner charge
 * (-1000) and larger collide (70), partners get plenty of breathing room
 * and edges land at readable lengths.
 *
 * Iteration history (URL-param values that produced the visual pick):
 *   build 197 baseline: w3000, h1000, fx0.025, fy0.10, cp-650, kp52, lmin280, lmax500
 *   build 197 DENSER:   cp-400, kp42, fx0.06, fy0.12, lmin200, lmax350
 *   build 197 SPREAD:   cp-1000, kp70, fx0.012, fy0.13, w4000, lmin380, lmax650
 *
 * Re-tune via URL params at any time — see KNOB_KEY_MAP below for the
 * full key list.
 *
 * Build 234 / session 038 — CLUSTER-AWARE Force defaults. Replaces the
 * single-target forceX (everything pulled toward canvas center) with a
 * per-node forceX target derived from each node's dominant focused-SID
 * neighbor. Result: distinct hub-and-spoke clusters, one per focused SID,
 * spread evenly along the X axis. Each non-focused node gets pulled toward
 * the X coordinate of its strongest-edge focused-SID hub.
 *
 * Tuning bumps that go with the cluster-aware forceX:
 *   chargeFocused: -2800 → -5000 (stronger inter-hub repulsion)
 *   linkStrength: 0.35 → 0.5 (tighter spoke pull keeps partners on their hub)
 *   iterations: 800 → 1500 (more time for clusters to settle cleanly)
 *
 * Cluster-aware forceX strength:
 *   forceXStrength (now applied per-node-target): 0.012 → 0.05
 *   The bump is needed because the per-node target spreads pull across N
 *   different X coordinates instead of all converging on canvas center —
 *   without the bump, charge repulsion overwhelms the cluster pull and the
 *   layout reverts to a blob.
 *
 * URL-param hot-patch system continues to work; the new forceX strength
 * applies whether knobs override the defaults or not. */
const DEFAULT_WIDTH = 4000;
const DEFAULT_HEIGHT = 1000;

const DEFAULT_CHARGE_FOCUSED = -5000;
const DEFAULT_CHARGE_SECONDARY = -1400;
const DEFAULT_CHARGE_PARTNER = -1000;
const DEFAULT_COLLIDE_FOCUSED = 90;
const DEFAULT_COLLIDE_SECONDARY = 65;
const DEFAULT_COLLIDE_PARTNER = 70;
const DEFAULT_FORCE_X_STRENGTH = 0.05;
const DEFAULT_FORCE_Y_STRENGTH = 0.13;
const DEFAULT_LINK_DISTANCE_MIN = 380;
const DEFAULT_LINK_DISTANCE_MAX = 650;
const DEFAULT_LINK_STRENGTH = 0.5;
/* Build 234 — number of d3-force ticks. Bumped from 800 to 1500 so the
 * cluster-aware forceX has more iterations to settle each cluster around
 * its hub before render. */
const DEFAULT_TICKS = 1500;

/**
 * Build 197 hot-patch knobs (URL params).
 *
 * Read layout-tuning overrides from the page URL hash query string so the
 * layout can be iterated without rebuilding the React bundle (~90 s per
 * iteration → ~2 s with a URL change + browser refresh). Format:
 *
 *   #/topology/integration-topology?topo=w3000,h1000,fx0.025,fy0.10,
 *                                       cf-2800,cs-1400,cp-650,
 *                                       kf90,ks60,kp52,
 *                                       lmin280,lmax500,lstr0.35
 *
 * Each comma-separated token is `<key><value>`. Unknown keys are ignored
 * silently. Values invalid as floats fall back to the matching DEFAULT_*
 * constant. Strip the param entirely after the auto-layout is dialed in,
 * then bake the chosen values back into the DEFAULT_* constants above for
 * the canonical baseline.
 */
interface LayoutKnobs {
    width: number;
    height: number;
    chargeFocused: number;
    chargeSecondary: number;
    chargePartner: number;
    collideFocused: number;
    collideSecondary: number;
    collidePartner: number;
    forceXStrength: number;
    forceYStrength: number;
    linkDistanceMin: number;
    linkDistanceMax: number;
    linkStrength: number;
}

const DEFAULT_KNOBS: LayoutKnobs = {
    width: DEFAULT_WIDTH,
    height: DEFAULT_HEIGHT,
    chargeFocused: DEFAULT_CHARGE_FOCUSED,
    chargeSecondary: DEFAULT_CHARGE_SECONDARY,
    chargePartner: DEFAULT_CHARGE_PARTNER,
    collideFocused: DEFAULT_COLLIDE_FOCUSED,
    collideSecondary: DEFAULT_COLLIDE_SECONDARY,
    collidePartner: DEFAULT_COLLIDE_PARTNER,
    forceXStrength: DEFAULT_FORCE_X_STRENGTH,
    forceYStrength: DEFAULT_FORCE_Y_STRENGTH,
    linkDistanceMin: DEFAULT_LINK_DISTANCE_MIN,
    linkDistanceMax: DEFAULT_LINK_DISTANCE_MAX,
    linkStrength: DEFAULT_LINK_STRENGTH,
};

const KNOB_KEY_MAP: Record<string, keyof LayoutKnobs> = {
    w: 'width',
    h: 'height',
    cf: 'chargeFocused',
    cs: 'chargeSecondary',
    cp: 'chargePartner',
    kf: 'collideFocused',
    ks: 'collideSecondary',
    kp: 'collidePartner',
    fx: 'forceXStrength',
    fy: 'forceYStrength',
    lmin: 'linkDistanceMin',
    lmax: 'linkDistanceMax',
    lstr: 'linkStrength',
};

const readLayoutKnobs = (): LayoutKnobs => {
    const knobs: LayoutKnobs = { ...DEFAULT_KNOBS };
    if (typeof window === 'undefined' || !window.location) return knobs;
    /* Splunk's React-page hosts our app under a hash route; query lives
     * inside the hash, e.g. `#/topology/integration-topology?topo=w3000,...`.
     * `URLSearchParams` over the hash query gives clean key/value access. */
    const hash = window.location.hash || '';
    const qmark = hash.indexOf('?');
    if (qmark < 0) return knobs;
    const params = new URLSearchParams(hash.slice(qmark + 1));
    const topo = params.get('topo');
    if (!topo) return knobs;
    /* Tokens are <key><value>. Match the longest key first so `lmin` /
     * `lmax` / `lstr` (4 chars) don't accidentally match the single-char
     * `l` prefix some other key might use later. */
    const keys = Object.keys(KNOB_KEY_MAP).sort((a, b) => b.length - a.length);
    topo.split(',').forEach((tokenRaw) => {
        const token = tokenRaw.trim();
        if (!token) return;
        for (const k of keys) {
            if (token.startsWith(k)) {
                const valStr = token.slice(k.length);
                const valNum = parseFloat(valStr);
                if (Number.isFinite(valNum)) {
                    knobs[KNOB_KEY_MAP[k]] = valNum;
                }
                return;
            }
        }
    });
    return knobs;
};

/* Per-kind charge / collide closures that resolve from the active knob set. */
const chargeFor = (n: SimNode, knobs: LayoutKnobs): number => {
    if (n.kind === 'sid_focused') return knobs.chargeFocused;
    if (n.kind === 'sid_secondary') return knobs.chargeSecondary;
    return knobs.chargePartner;
};

const collideFor = (n: SimNode, knobs: LayoutKnobs): number => {
    if (n.kind === 'sid_focused') return knobs.collideFocused;
    if (n.kind === 'sid_secondary') return knobs.collideSecondary;
    return knobs.collidePartner;
};

/**
 * Build 234 — cluster assignment helper.
 *
 * For each non-focused node, find the focused-SID hub it has the strongest
 * edge to (by callCount). Returns a map nodeId → hubId. Nodes with no
 * focused-SID neighbor are left unmapped (the consumer falls back to
 * canvas-center forceX target).
 *
 * Bidirectional: an edge (n -> hub) and an edge (hub -> n) both count
 * toward n's affinity for that hub.
 */
const computeNodeToHubMap = (
    nodes: TopologyNode[],
    edges: TopologyEdge[],
): Record<string, string> => {
    const focusedIds = new Set(nodes.filter((n) => n.kind === 'sid_focused').map((n) => n.id));
    if (focusedIds.size === 0) return {};

    /* For each (non-focused-node, focused-hub) pair, accumulate edge weight.
     * Then for each non-focused node, pick the hub with the largest weight. */
    const weightByPair: Record<string, Record<string, number>> = {};
    for (const e of edges) {
        const w = e.callCount > 0 ? e.callCount : 1;
        if (focusedIds.has(e.target) && !focusedIds.has(e.source)) {
            (weightByPair[e.source] ??= {})[e.target] = ((weightByPair[e.source] ??= {})[e.target] ?? 0) + w;
        }
        if (focusedIds.has(e.source) && !focusedIds.has(e.target)) {
            (weightByPair[e.target] ??= {})[e.source] = ((weightByPair[e.target] ??= {})[e.source] ?? 0) + w;
        }
    }

    const map: Record<string, string> = {};
    for (const [nodeId, hubWeights] of Object.entries(weightByPair)) {
        let bestHub: string | null = null;
        let bestWeight = 0;
        for (const [hub, w] of Object.entries(hubWeights)) {
            if (w > bestWeight) {
                bestWeight = w;
                bestHub = hub;
            }
        }
        if (bestHub) map[nodeId] = bestHub;
    }
    return map;
};

export const computeForceLayout = (
    nodes: TopologyNode[],
    edges: TopologyEdge[],
    /* Width/height ARGUMENTS (kept for callers that want explicit override)
     * are only used when the URL param `topo=w...,h...` isn't set. The knob
     * reader takes precedence so URL-driven hot-patches always win. */
    _widthArg: number = DEFAULT_WIDTH,
    _heightArg: number = DEFAULT_HEIGHT,
): PositionedNode[] => {
    if (nodes.length === 0) return [];

    /* Read URL-param knobs once per layout call. Defaults if no `?topo=` is
     * present. Build 197 hot-patch infrastructure. */
    const knobs = readLayoutKnobs();
    const width = knobs.width;
    const height = knobs.height;

    const simNodes: SimNode[] = nodes.map((n) => ({ id: n.id, kind: n.kind }));
    const simLinks: SimLink[] = edges.map((e) => ({ source: e.source, target: e.target }));

    /* Link distance scales with the node count: more nodes need more space.
     * Hot-patchable via `?topo=lmin280,lmax500`; default range 280-500. */
    const linkDistance = Math.max(
        knobs.linkDistanceMin,
        Math.min(200 + nodes.length * 5, knobs.linkDistanceMax),
    );

    /* Build 234 — cluster-aware forceX targets.
     *
     * Distribute focused SIDs evenly along the X axis (between 15% and 85%
     * of canvas width). Map each non-focused node to its dominant focused-SID
     * hub (by max edge weight, computed in computeNodeToHubMap). Per-node
     * target X resolves as:
     *   - focused SID: its assigned slot X
     *   - non-focused with a hub mapping: its hub's slot X
     *   - non-focused without a hub mapping: canvas center X
     *
     * The result: each focused SID anchors a distinct vertical band that
     * its incident partners get pulled toward. Combined with the bumped
     * inter-hub repulsion (chargeFocused -5000) + tighter link strength
     * (0.5) and 1500 iterations, the bands resolve into clean hub-and-spoke
     * clusters spread across the wide canvas. */
    const focusedNodes = simNodes.filter((n) => n.kind === 'sid_focused');
    const clusterCenterX: Record<string, number> = {};
    const slotCount = Math.max(1, focusedNodes.length);
    const xStart = width * 0.15;
    const xRange = width * 0.7;
    focusedNodes.forEach((sid, idx) => {
        clusterCenterX[sid.id] = slotCount === 1
            ? width / 2
            : xStart + (xRange / slotCount) * (idx + 0.5);
    });
    const nodeToHub = computeNodeToHubMap(nodes, edges);
    const targetX = (n: SimNode): number => {
        if (n.kind === 'sid_focused') {
            return clusterCenterX[n.id] ?? width / 2;
        }
        const hub = nodeToHub[n.id];
        if (hub && clusterCenterX[hub] !== undefined) {
            return clusterCenterX[hub];
        }
        return width / 2;
    };

    const sim = forceSimulation<SimNode>(simNodes)
        .force(
            'link',
            forceLink<SimNode, SimLink>(simLinks)
                .id((d) => d.id)
                .distance(linkDistance)
                .strength(knobs.linkStrength),
        )
        .force('charge', forceManyBody<SimNode>().strength((d) => chargeFor(d, knobs)))
        .force('center', forceCenter(width / 2, height / 2))
        .force('collide', forceCollide<SimNode>().radius((d) => collideFor(d, knobs)))
        /* Build 234 — per-node forceX target replaces the build-198 single-
         * target forceX (toward canvas center). Each node now gets pulled
         * toward its cluster's anchor X, producing distinct per-hub
         * bands. forceY remains a single-target pull (everything to vertical
         * center) so clusters stay horizontally spread + vertically compact.
         *
         * NOTE: the `forceXStrength` knob now controls the per-node-target
         * pull, not the canvas-center pull. The default bumped from 0.012
         * to 0.05 because per-node targets spread the pull across N different
         * X coordinates instead of all converging on center. */
        .force('x', forceX<SimNode>(targetX).strength(knobs.forceXStrength))
        .force('y', forceY<SimNode>(height / 2).strength(knobs.forceYStrength))
        .stop();

    /* Synchronous tick to a stable state. Build 234 bumped from 800 to
     * DEFAULT_TICKS (1500) — the cluster-aware forceX needs more iterations
     * to settle each cluster around its hub. ~80 ms extra wall time vs 800
     * ticks on a 60-node graph — still imperceptible. */
    for (let i = 0; i < DEFAULT_TICKS; i += 1) {
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
 * enabled in the toolbar — drag-end positions get rounded to the nearest
 * grid intersection.
 */
export const snapToGrid = (x: number, y: number, gridSize: number = 20): { x: number; y: number } => {
    return {
        x: Math.round(x / gridSize) * gridSize,
        y: Math.round(y / gridSize) * gridSize,
    };
};

/* ============================================================================
 * Layout-mode dispatcher (build 200 / session 035)
 *
 * Provides a single async entry point that the React layer calls regardless
 * of which layout algorithm is active. Force mode runs synchronously inside
 * the Promise wrapper (zero latency), Layered mode lazy-loads elkjs and
 * runs Sugiyama with crossing minimization.
 * ============================================================================ */

export type LayoutMode = 'force' | 'layered' | 'tree';

export const ALL_LAYOUT_MODES: ReadonlyArray<LayoutMode> = ['force', 'layered', 'tree'] as const;

export const layoutModeLabel = (mode: LayoutMode): string => {
    if (mode === 'force') return 'Force';
    if (mode === 'layered') return 'Layered';
    if (mode === 'tree') return 'Tree';
    return mode;
};

/**
 * Tooltip / description text per layout mode. Surfaced in the toolbar's
 * layout dropdown so users can hover to read what each mode is good at
 * before picking. Build 202 / session 036.
 */
export const layoutModeDescription = (mode: LayoutMode): string => {
    if (mode === 'force') {
        return 'Force (d3-force) — organic clustering with radial spokes around hubs. Best for small graphs and exploratory views.';
    }
    if (mode === 'layered') {
        return 'Layered (Sugiyama) — top-to-bottom flow with orthogonal edges. Near-zero edge crossings via crossing-minimization. Best for traffic-flow analysis.';
    }
    if (mode === 'tree') {
        return 'Tree (mrtree) — classic top-down tree with hubs at top, spokes radiating downward. Best when topology is approximately hub-and-spoke shaped.';
    }
    return mode;
};

/**
 * Compute initial node positions per the requested layout mode. Async to
 * accommodate the elkjs lazy-load + WASM-style execution model. Force
 * mode resolves synchronously through the Promise wrapper — no perceptible
 * latency vs the prior sync API.
 *
 * Build 202 / session 036 — added Tree mode (ELK mrtree). Both ELK-based
 * modes (Layered + Tree) share the same lazy-loaded elkjs chunk so adding
 * Tree doesn't add a second bundle hit.
 */
export const computeLayout = async (
    mode: LayoutMode,
    nodes: TopologyNode[],
    edges: TopologyEdge[],
    width: number = DEFAULT_WIDTH,
    height: number = DEFAULT_HEIGHT,
): Promise<PositionedNode[]> => {
    if (mode === 'layered') {
        /* Dynamic import — webpack code-splits this into its own chunk
         * (with elkjs as a transitive dep) so Force-mode users never pay
         * the bundle cost. */
        const { computeLayeredLayout } = await import('./layoutLayered');
        return computeLayeredLayout(nodes, edges);
    }
    if (mode === 'tree') {
        /* Same ELK chunk as Layered — adding Tree doesn't add a second
         * bundle hit because both wrappers reuse the cached ElkInstance
         * (declared inside each file, but the elkjs.bundled.js chunk is
         * shared). */
        const { computeMrtreeLayout } = await import('./layoutMrtree');
        return computeMrtreeLayout(nodes, edges);
    }
    return computeForceLayout(nodes, edges, width, height);
};
