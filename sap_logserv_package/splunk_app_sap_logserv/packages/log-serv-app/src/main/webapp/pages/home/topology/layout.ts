import {
    forceSimulation,
    forceLink,
    forceManyBody,
    forceCollide,
    forceX,
    forceY,
    type SimulationNodeDatum,
} from 'd3-force';
import type { TopologyNode, TopologyEdge } from './types';

/**
 * Force-directed initial layout via d3-force.
 *
 * Single-canvas simulation: every node participates together, anchored by
 * per-node targets (slot hubs / satellite anchors / ring seats — build
 * 262). Mirrors the pre-KV-Store visual idiom (build 109+) — SID star
 * hubs naturally pull partner nodes around them, smaller SIDs fall into
 * satellite relationships with their connected systems, and the whole
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
/* Build 262 — DEFAULT_HEIGHT raised 1000 -> 2160 to match the center
 * canvas's aspect with the Live Activity panel COLLAPSED (the design
 * target per session 077). TopologyGraph normally passes viewport-derived
 * dimensions, so this default only applies when measurement is
 * unavailable. Since the build-262 anchor architecture the world height
 * only positions the vertical mid-line + orphan ring (the bbox emerges
 * from ring radii + slots), so legacy `?topo=h...` URLs stay harmless. */
const DEFAULT_HEIGHT = 2160;

const DEFAULT_CHARGE_FOCUSED = -5000;
const DEFAULT_CHARGE_SECONDARY = -1400;
const DEFAULT_CHARGE_PARTNER = -1000;
/* Build 262 — collide radii bumped 110/85/85 -> 130/100/100 (the session
 * 077 "more padding" directive; min node-center separation = 2x these).
 * Build 277 — collideSecondary 100 -> 120: secondary SID discs enlarged
 * to 90% of focused (visual ring radius ~53.5 -> ~64.5), so the collide
 * radius scales to keep the same padding ratio (~1.87x visual radius)
 * as focused (130/69) and partner (100/53.5). */
const DEFAULT_COLLIDE_FOCUSED = 130;
const DEFAULT_COLLIDE_SECONDARY = 120;
const DEFAULT_COLLIDE_PARTNER = 100;
const DEFAULT_FORCE_X_STRENGTH = 0.05;
const DEFAULT_FORCE_Y_STRENGTH = 0.13;
const DEFAULT_LINK_DISTANCE_MIN = 380;
const DEFAULT_LINK_DISTANCE_MAX = 650;
const DEFAULT_LINK_STRENGTH = 0.5;
/* Build 234 — number of d3-force ticks. Bumped from 800 to 1500 so the
 * cluster-aware forceX has more iterations to settle each cluster around
 * its hub before render. */
const DEFAULT_TICKS = 1500;

/* Build 260 — density-scaled "star system" layout (P1-P3 of
 * topology_force_layout_plan_v0.1_20260706.md).
 *   leafPitch: ring circumference each leaf needs (px) — drives ringRadius.
 *   minRingRadius: floor so tiny hubs still read as star systems.
 *   hubClearance: guaranteed empty space between two hub territories.
 *   chargeDegreeFactor: charge multiplier 1 + f*sqrt(degree) — denser hubs
 *     repel harder, reinforcing territory separation.
 *
 * Build 262 — session 077 "more padding + more inter-cluster distance"
 * re-tune (leafPitch 100 -> 130, minRingRadius 280 -> 360, hubClearance
 * 220 -> 420, chargeDegreeFactor 0.08 -> 0.10), validated offline against
 * the live sh-idxr dataset via a d3-force harness before baking. */
const DEFAULT_LEAF_PITCH = 130;
const DEFAULT_MIN_RING_RADIUS = 360;
const DEFAULT_HUB_CLEARANCE = 420;
const DEFAULT_CHARGE_DEGREE_FACTOR = 0.1;
/* Build 262 — clearance between a hub's ring and each satellite SID's own
 * ring (was satelliteYOffset — the vertical-stagger scheme it fed is
 * replaced by radial satellite fans; the `saty` URL knob still maps here). */
const DEFAULT_SATELLITE_GAP = 200;
/* Build 262 — universal star-hub slotting (session 077 structural fix).
 *   slotLeafThreshold: a secondary SID with at least this many edges to
 *     partner (leaf) nodes owns a star system and gets its own X slot.
 *     Previously ONLY sid_focused hubs got slots; on datasets where the
 *     biggest hub is a synthesized secondary SID (e.g. XCJ on sh-idxr,
 *     34 leaves vs the focused hub's 13) that hub fell back to a
 *     canvas-center pull and interpenetrated the focused hub's territory.
 *   tinyRingFactor: ring shrink for tiny (degree <= 2) systems so
 *     satellite mini-systems stay compact.
 *   hubPinStrength / satPinStrength: anchor-force strength for slot hubs /
 *     satellite SIDs. These pin the layout's SKELETON firmly so springs +
 *     charge relax leaves around a stable geometry instead of dragging
 *     whole systems off their territory (leaves keep the soft build-261
 *     seat-holding strengths fx/fy). */
const DEFAULT_SLOT_LEAF_THRESHOLD = 3;
const DEFAULT_TINY_RING_FACTOR = 0.55;
const DEFAULT_HUB_PIN_STRENGTH = 0.25;
const DEFAULT_SAT_PIN_STRENGTH = 0.3;

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
    leafPitch: number;
    minRingRadius: number;
    hubClearance: number;
    chargeDegreeFactor: number;
    satelliteGap: number;
    slotLeafThreshold: number;
    tinyRingFactor: number;
    hubPinStrength: number;
    satPinStrength: number;
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
    leafPitch: DEFAULT_LEAF_PITCH,
    minRingRadius: DEFAULT_MIN_RING_RADIUS,
    hubClearance: DEFAULT_HUB_CLEARANCE,
    chargeDegreeFactor: DEFAULT_CHARGE_DEGREE_FACTOR,
    satelliteGap: DEFAULT_SATELLITE_GAP,
    slotLeafThreshold: DEFAULT_SLOT_LEAF_THRESHOLD,
    tinyRingFactor: DEFAULT_TINY_RING_FACTOR,
    hubPinStrength: DEFAULT_HUB_PIN_STRENGTH,
    satPinStrength: DEFAULT_SAT_PIN_STRENGTH,
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
    /* lmin/lmax are legacy (build<260 uniform distance); kept for URL compat. */
    lmin: 'linkDistanceMin',
    lmax: 'linkDistanceMax',
    lstr: 'linkStrength',
    pitch: 'leafPitch',
    minr: 'minRingRadius',
    hubgap: 'hubClearance',
    degf: 'chargeDegreeFactor',
    /* saty is the legacy key (pre-262 satellite Y offset) — kept for URL
     * compat; satgap is the current name for the same knob. */
    saty: 'satelliteGap',
    satgap: 'satelliteGap',
    slotn: 'slotLeafThreshold',
    tinyf: 'tinyRingFactor',
    hubpin: 'hubPinStrength',
    satpin: 'satPinStrength',
};

interface LayoutKnobRead {
    knobs: LayoutKnobs;
    /** Keys the URL explicitly set — lets width/height args from the
     *  viewport-measuring caller win when the URL doesn't override them
     *  (build 262 / session 077 Task 2). */
    explicit: Set<keyof LayoutKnobs>;
}

const readLayoutKnobs = (): LayoutKnobRead => {
    const knobs: LayoutKnobs = { ...DEFAULT_KNOBS };
    const explicit = new Set<keyof LayoutKnobs>();
    if (typeof window === 'undefined' || !window.location) return { knobs, explicit };
    /* Splunk's React-page hosts our app under a hash route; query lives
     * inside the hash, e.g. `#/topology/integration-topology?topo=w3000,...`.
     * `URLSearchParams` over the hash query gives clean key/value access. */
    const hash = window.location.hash || '';
    const qmark = hash.indexOf('?');
    if (qmark < 0) return { knobs, explicit };
    const params = new URLSearchParams(hash.slice(qmark + 1));
    const topo = params.get('topo');
    if (!topo) return { knobs, explicit };
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
                    explicit.add(KNOB_KEY_MAP[k]);
                }
                return;
            }
        }
    });
    return { knobs, explicit };
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
 * Build 234 — cluster assignment helper. Build 262 — generalized from
 * "focused hubs" to an arbitrary hub id set (the slot hubs, which now
 * include big secondary star hubs).
 *
 * For each non-hub node, find the hub it has the strongest edge to (by
 * callCount). Returns a map nodeId → hubId. Nodes with no hub neighbor
 * are left unmapped (the consumer falls back to satellite/orphan anchors).
 *
 * Bidirectional: an edge (n -> hub) and an edge (hub -> n) both count
 * toward n's affinity for that hub.
 */
const computeNodeToHubMap = (
    edges: TopologyEdge[],
    hubIds: Set<string>,
): Record<string, string> => {
    if (hubIds.size === 0) return {};

    /* For each (non-hub-node, hub) pair, accumulate edge weight. Then for
     * each non-hub node, pick the hub with the largest weight. */
    const weightByPair: Record<string, Record<string, number>> = {};
    for (const e of edges) {
        const w = e.callCount > 0 ? e.callCount : 1;
        if (hubIds.has(e.target) && !hubIds.has(e.source)) {
            (weightByPair[e.source] ??= {})[e.target] = ((weightByPair[e.source] ??= {})[e.target] ?? 0) + w;
        }
        if (hubIds.has(e.source) && !hubIds.has(e.target)) {
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
    /* Width/height arguments come from the viewport-measuring caller
     * (TopologyGraph passes world dimensions aspect-matched to the center
     * canvas as if the Live Activity panel is collapsed — build 262 /
     * session 077 Task 2). URL `topo=w...,h...` knobs still take top
     * precedence for hot-patch tuning. */
    widthArg: number = DEFAULT_WIDTH,
    heightArg: number = DEFAULT_HEIGHT,
): PositionedNode[] => {
    if (nodes.length === 0) return [];

    /* Read URL-param knobs once per layout call. Defaults if no `?topo=` is
     * present. Build 197 hot-patch infrastructure. */
    const { knobs, explicit } = readLayoutKnobs();
    const width = explicit.has('width') ? knobs.width : widthArg;
    const height = explicit.has('height') ? knobs.height : heightArg;

    const simNodes: SimNode[] = nodes.map((n) => ({ id: n.id, kind: n.kind }));
    const simLinks: SimLink[] = edges.map((e) => ({ source: e.source, target: e.target }));

    /* ================= Build 260/262 — density-scaled star systems ========
     * (P1-P3 of topology_force_layout_plan_v0.1_20260706.md; build 262
     * upgraded P2 to UNIVERSAL star-hub slotting — session 077.)
     *
     * P1 — degree model + per-EDGE link distance: each hub's leaves sit on a
     *   ring whose radius grows linearly with the hub's connection count
     *   (ringRadius = degree*leafPitch/2pi, floored) — denser hubs fan out
     *   further; hub<->hub edges get the SUM of both ring radii plus a
     *   clearance so territories cannot overlap. Charge scales with
     *   sqrt(degree) so dense hubs also repel harder.
     * P2 (262) — universal star-hub slots + satellite anchors: EVERY SID
     *   that owns a star system (all focused hubs + secondaries with >=
     *   slotLeafThreshold leaf edges) gets a proportional X slot; the
     *   remaining small SIDs anchor as satellites of their most-affine slot
     *   hub (direct edge -> shared-leaf bridge -> round-robin) on
     *   vertical-biased fans that use the canvas's vertical space. Slot
     *   hubs + satellites are PINNED firmly (hubPinStrength /
     *   satPinStrength) — they form the layout's skeleton; nothing defaults
     *   to a canvas-center pull anymore (which previously piled the big
     *   synth-SID systems onto the focused hub's territory).
     * P3 — direction-aware ANGULAR SEEDING (circular star-system idiom):
     *   each hub's leaves are pre-placed on its ring — edges INTO the hub
     *   seed on the left arc, edges OUT of the hub on the right arc, evenly
     *   spaced — so bezier edges approach near-radially and the arrowhead
     *   attaches with minimal curve. The simulation then only relaxes an
     *   already-correct arrangement. */

    /* Degree model. */
    const deg: Record<string, number> = {};
    edges.forEach((e) => {
        deg[e.source] = (deg[e.source] ?? 0) + 1;
        deg[e.target] = (deg[e.target] ?? 0) + 1;
    });
    const degOf = (id: string): number => deg[id] ?? 0;
    const ringRadius = (d: number): number =>
        Math.max(knobs.minRingRadius, (d * knobs.leafPitch) / (2 * Math.PI));
    /* Deterministic per-string jitter in [-1, 1] (keeps rings organic and
     * reproducible — no Math.random, layouts stay stable across refreshes). */
    const hash01 = (str: string): number => {
        let h = 2166136261;
        for (let i = 0; i < str.length; i += 1) {
            h ^= str.charCodeAt(i);
            h = Math.imul(h, 16777619);
        }
        return ((h >>> 0) % 1000) / 500 - 1;
    };
    const isSidKind = (k: SimNode['kind']): boolean => k === 'sid_focused' || k === 'sid_secondary';
    const isSid = (n: SimNode): boolean => isSidKind(n.kind);
    const kindOf: Record<string, SimNode['kind']> = {};
    simNodes.forEach((n) => { kindOf[n.id] = n.kind; });

    /* === Build 262 — universal star-hub slotting (session 077) ===
     * Slot hubs = every focused SID + every secondary SID with enough LEAF
     * edges (edges to partner nodes) to own a star system. Previously only
     * sid_focused nodes got X slots; on datasets where the biggest hub is
     * a secondary (synth) SID, that hub fell back to a canvas-center pull
     * and interpenetrated the focused hub's territory. */
    const leafDeg: Record<string, number> = {};
    edges.forEach((e) => {
        const sSid = isSidKind(kindOf[e.source]);
        const tSid = isSidKind(kindOf[e.target]);
        if (sSid && !tSid) leafDeg[e.source] = (leafDeg[e.source] ?? 0) + 1;
        if (tSid && !sSid) leafDeg[e.target] = (leafDeg[e.target] ?? 0) + 1;
    });
    const sidNodes = simNodes.filter(isSid);
    const slotHubs = sidNodes.filter(
        (n) => n.kind === 'sid_focused' || (leafDeg[n.id] ?? 0) >= knobs.slotLeafThreshold,
    );
    /* Order: focused hubs first (desc ring radius), then secondary hubs
     * (desc ring radius); ties by id — deterministic. */
    slotHubs.sort((a, b) => {
        if (a.kind !== b.kind) return a.kind === 'sid_focused' ? -1 : 1;
        const dr = ringRadius(degOf(b.id)) - ringRadius(degOf(a.id));
        return dr !== 0 ? dr : a.id.localeCompare(b.id);
    });
    const slotHubIdSet = new Set(slotHubs.map((h) => h.id));

    /* P1 — per-edge distance + strength (index-aligned with simLinks).
     * Tiny systems (hub side degree <= 2) ring at a fraction of the floor
     * radius so satellite mini-systems stay compact. */
    const bothSids = (e: TopologyEdge): boolean =>
        isSidKind(kindOf[e.source]) && isSidKind(kindOf[e.target]);
    const linkDistArr = edges.map((e) => {
        if (bothSids(e)) {
            return ringRadius(degOf(e.source)) + ringRadius(degOf(e.target)) + knobs.hubClearance;
        }
        const hubDeg = Math.max(degOf(e.source), degOf(e.target));
        const r = hubDeg <= 2 ? ringRadius(hubDeg) * knobs.tinyRingFactor : ringRadius(hubDeg);
        return r * (1 + 0.06 * hash01(e.source + '|' + e.target));
    });
    /* Hub<->hub springs are WEAK so the clearance distance is advisory and
     * charge can still push systems apart; hub<->leaf springs stay firm so
     * leaves hold their ring. */
    const linkStrArr = edges.map((e) => (bothSids(e) ? 0.15 : knobs.linkStrength));

    /* P2 — proportional slots for ALL star hubs. Scale floor 1.0 (262):
     * never compress slots below ring-territory needs — overlap is worse
     * than a wider-than-world bbox (ReactFlow's fitView normalizes). */
    const clusterCenterX: Record<string, number> = {};
    if (slotHubs.length > 0) {
        const radii = slotHubs.map((h) => ringRadius(degOf(h.id)));
        const needed = radii.reduce((a, r) => a + 2 * r, 0)
            + knobs.hubClearance * Math.max(0, slotHubs.length - 1);
        const usable = width * 0.88;
        const scale = Math.min(1.4, Math.max(1.0, usable / Math.max(1, needed)));
        let cursor = (width - needed * scale) / 2;
        slotHubs.forEach((h, i) => {
            clusterCenterX[h.id] = cursor + radii[i] * scale;
            cursor += (2 * radii[i] + knobs.hubClearance) * scale;
        });
    }
    const nodeToHub = computeNodeToHubMap(edges, slotHubIdSet);

    /* P2 — edge-weighted slot-hub affinities for shared leaves (mean-anchor). */
    const hubWeights: Record<string, Record<string, number>> = {};
    edges.forEach((e) => {
        const w = e.callCount > 0 ? e.callCount : 1;
        if (slotHubIdSet.has(e.target) && !slotHubIdSet.has(e.source)) {
            (hubWeights[e.source] ??= {})[e.target] = ((hubWeights[e.source] ?? {})[e.target] ?? 0) + w;
        }
        if (slotHubIdSet.has(e.source) && !slotHubIdSet.has(e.target)) {
            (hubWeights[e.target] ??= {})[e.source] = ((hubWeights[e.target] ?? {})[e.source] ?? 0) + w;
        }
    });

    /* === Build 262 — satellite anchors for EVERY non-slot secondary SID ===
     * Affinity: direct edge to a slot hub -> shared-leaf bridge (a partner
     * with edges to both) -> round-robin across slot hubs. Placement:
     * angular fans biased VERTICAL (the horizontal axis is consumed by the
     * hub slots; the vertical space is what the Live-Activity-collapsed
     * canvas gains) — edge hubs spill their diagonals outward. */
    const adjacency: Record<string, Array<{ other: string; w: number }>> = {};
    edges.forEach((e) => {
        const w = e.callCount > 0 ? e.callCount : 1;
        (adjacency[e.source] ??= []).push({ other: e.target, w });
        (adjacency[e.target] ??= []).push({ other: e.source, w });
    });
    const satHubFor = (satId: string, rrIndex: number): string | undefined => {
        if (nodeToHub[satId]) return nodeToHub[satId];
        const scores: Record<string, number> = {};
        (adjacency[satId] ?? []).forEach(({ other: leaf, w: wSat }) => {
            if (isSidKind(kindOf[leaf])) return;
            (adjacency[leaf] ?? []).forEach(({ other: hub, w: wHub }) => {
                if (!slotHubIdSet.has(hub)) return;
                scores[hub] = (scores[hub] ?? 0) + Math.min(wSat, wHub);
            });
        });
        let best: string | undefined;
        let bestW = 0;
        for (const [hub, w] of Object.entries(scores)) {
            if (w > bestW) { bestW = w; best = hub; }
        }
        if (best) return best;
        return slotHubs.length > 0 ? slotHubs[rrIndex % slotHubs.length].id : undefined;
    };
    const slotIndexOf: Record<string, number> = {};
    slotHubs.forEach((h, i) => { slotIndexOf[h.id] = i; });
    /* Fan angle sequences (degrees, y-down): straight down/up first, then
     * diagonals — outward-biased for the first/last slot hub. */
    const satAngle = (slotIdx: number, k: number): number => {
        const mid = [90, -90, 132, -132, 48, -48];
        const first = [90, -90, 132, -132, 156, -156];
        const last = [90, -90, 48, -48, 24, -24];
        const seq = slotHubs.length <= 1 ? mid
            : slotIdx === 0 ? first
                : slotIdx === slotHubs.length - 1 ? last
                    : mid;
        return (seq[k % seq.length] * Math.PI) / 180;
    };
    const satAnchor: Record<string, { x: number; y: number }> = {};
    const satPerHub: Record<string, number> = {};
    let rrCounter = 0;
    sidNodes
        .filter((n) => !slotHubIdSet.has(n.id))
        .sort((a, b) => a.id.localeCompare(b.id))
        .forEach((sat) => {
            const hub = satHubFor(sat.id, rrCounter);
            rrCounter += 1;
            if (hub === undefined || clusterCenterX[hub] === undefined) return;
            const k = satPerHub[hub] ?? 0;
            satPerHub[hub] = k + 1;
            /* Distance: hub ring + the satellite's own (tiny) leaf ring +
             * gap — the satellite SYSTEM clears the hub's territory. */
            const satRing = ringRadius(degOf(sat.id)) * knobs.tinyRingFactor;
            const dist = ringRadius(degOf(hub)) + satRing + knobs.satelliteGap;
            const a = satAngle(slotIndexOf[hub], k);
            satAnchor[sat.id] = {
                x: clusterCenterX[hub] + dist * Math.cos(a),
                y: height / 2 + dist * Math.sin(a),
            };
        });

    /* P3 — angular seeding. Star center per leaf: dominant slot hub, else
     * its strongest secondary-SID neighbor (satellite systems seed their own
     * planets), else none (canvas-center ring fallback). */
    const starOf = (leafId: string): string | undefined => {
        const hub = nodeToHub[leafId];
        if (hub) return hub;
        let best: string | undefined;
        let bestW = 0;
        edges.forEach((e) => {
            const other = e.source === leafId ? e.target : e.target === leafId ? e.source : undefined;
            if (!other) return;
            if (kindOf[other] !== 'sid_secondary') return;
            const w = e.callCount > 0 ? e.callCount : 1;
            if (w > bestW) { bestW = w; best = other; }
        });
        return best;
    };
    /* Direction per (leaf, star): net arrow direction — into the star (leaf
     * is source) seeds the LEFT arc, out of the star seeds the RIGHT arc. */
    const starLeaves: Record<string, Array<{ id: string; inbound: boolean }>> = {};
    simNodes
        .filter((n) => !isSid(n))
        .sort((a, b) => a.id.localeCompare(b.id))
        .forEach((leaf) => {
            const star = starOf(leaf.id);
            if (!star) return;
            let inW = 0;
            let outW = 0;
            edges.forEach((e) => {
                const w = e.callCount > 0 ? e.callCount : 1;
                if (e.source === leaf.id && e.target === star) inW += w;
                if (e.source === star && e.target === leaf.id) outW += w;
            });
            (starLeaves[star] ??= []).push({ id: leaf.id, inbound: inW >= outW });
        });
    const seeded: Record<string, { x: number; y: number }> = {};
    simNodes.forEach((n) => {
        if (slotHubIdSet.has(n.id)) {
            seeded[n.id] = { x: clusterCenterX[n.id] ?? width / 2, y: height / 2 };
        } else if (satAnchor[n.id]) {
            seeded[n.id] = satAnchor[n.id];
        }
    });
    Object.entries(starLeaves).forEach(([star, leaves]) => {
        const c = seeded[star] ?? { x: width / 2, y: height / 2 };
        const starDeg = degOf(star);
        const r = starDeg <= 2 ? ringRadius(starDeg) * knobs.tinyRingFactor : ringRadius(starDeg);
        const ins = leaves.filter((l) => l.inbound);
        const outs = leaves.filter((l) => !l.inbound);
        /* Left arc for inbound (100 deg..260 deg), right arc for outbound
         * (-80 deg..80 deg) — margins keep the top/bottom poles clear so the
         * two groups stay visually distinct. Even spacing within each arc. */
        const place = (arr: Array<{ id: string }>, a0: number, a1: number): void => {
            arr.forEach((l, i) => {
                const t = arr.length === 1 ? 0.5 : i / (arr.length - 1);
                const a = a0 + (a1 - a0) * t;
                const rr = r * (1 + 0.06 * hash01(l.id));
                seeded[l.id] = { x: c.x + rr * Math.cos(a), y: c.y + rr * Math.sin(a) };
            });
        };
        place(ins, (100 * Math.PI) / 180, (260 * Math.PI) / 180);
        place(outs, (-80 * Math.PI) / 180, (80 * Math.PI) / 180);
    });
    /* Anything still unseeded (isolated partners) rings the canvas center —
     * y-radius follows the world aspect so the ring fills the canvas shape. */
    let orphanIdx = 0;
    const orphanRx = knobs.minRingRadius * 1.5;
    const orphanRy = orphanRx * Math.min(1, height / Math.max(1, width));
    simNodes.forEach((n) => {
        if (seeded[n.id]) return;
        const a = orphanIdx * 2.399963; /* golden angle */
        orphanIdx += 1;
        seeded[n.id] = {
            x: width / 2 + orphanRx * Math.cos(a),
            y: height / 2 + orphanRy * Math.sin(a),
        };
    });
    simNodes.forEach((n) => {
        n.x = seeded[n.id].x;
        n.y = seeded[n.id].y;
    });

    /* Build 261 — seat-holding targets. The build-234 pull toward the hub's
     * center X (+ canvas-center Y) COLLAPSES the seeded rings — every leaf
     * targets its OWN seeded ring seat (the angular-maintenance force from
     * plan D4a), slot hubs target their slot, satellites their satellite
     * anchor, and shared leaves fall back to the edge-weighted hub midpoint. */
    const targetX = (n: SimNode): number => {
        if (slotHubIdSet.has(n.id)) return clusterCenterX[n.id] ?? width / 2;
        if (satAnchor[n.id]) return satAnchor[n.id].x;
        if (!isSid(n) && seeded[n.id]) return seeded[n.id].x;
        const w = hubWeights[n.id];
        if (w) {
            let sw = 0;
            let sx = 0;
            for (const [hub, wt] of Object.entries(w)) {
                const hx = clusterCenterX[hub];
                if (hx !== undefined) { sw += wt; sx += wt * hx; }
            }
            if (sw > 0) return sx / sw;
        }
        const hub = nodeToHub[n.id];
        if (hub && clusterCenterX[hub] !== undefined) return clusterCenterX[hub];
        return width / 2;
    };
    const targetY = (n: SimNode): number => {
        if (slotHubIdSet.has(n.id)) return height / 2;
        if (satAnchor[n.id]) return satAnchor[n.id].y;
        if (!isSid(n) && seeded[n.id]) return seeded[n.id].y;
        return height / 2;
    };

    /* Build 262 — per-node anchor strength: slot hubs + satellites are the
     * SKELETON of the layout — pin them firmly so springs/charge relax the
     * leaves around a stable geometry instead of dragging systems off
     * their territory. Leaves keep the soft build-261 seat-holding.
     * forceCenter removed: every node has an explicit target now; the
     * rigid mean-recentering only fought the anchors (fitView centers the
     * render regardless of where the world's mean sits). */
    const anchorStrengthX = (n: SimNode): number => {
        if (slotHubIdSet.has(n.id)) return knobs.hubPinStrength;
        if (satAnchor[n.id]) return knobs.satPinStrength;
        return knobs.forceXStrength;
    };
    const anchorStrengthY = (n: SimNode): number => {
        if (slotHubIdSet.has(n.id)) return knobs.hubPinStrength;
        if (satAnchor[n.id]) return knobs.satPinStrength;
        return knobs.forceYStrength;
    };

    const sim = forceSimulation<SimNode>(simNodes)
        .force(
            'link',
            forceLink<SimNode, SimLink>(simLinks)
                .id((d) => d.id)
                .distance((_l, i) => linkDistArr[i])
                .strength((_l, i) => linkStrArr[i]),
        )
        .force(
            'charge',
            forceManyBody<SimNode>().strength(
                (d) => chargeFor(d, knobs) * (1 + knobs.chargeDegreeFactor * Math.sqrt(degOf(d.id))),
            ),
        )
        .force('collide', forceCollide<SimNode>().radius((d) => collideFor(d, knobs)))
        .force('x', forceX<SimNode>(targetX).strength(anchorStrengthX))
        .force('y', forceY<SimNode>(targetY).strength(anchorStrengthY))
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
