/* ============================================================================
 * topology/panelFacts.ts — the node right-panel's derived facts (build 322)
 * ============================================================================
 *
 * Everything the Details panel ASSERTS about a node is derived here, as pure
 * functions, so the gate can exercise it (utils/panelFacts.consistency-test.ts)
 * and the sidebar can stay presentational. Three customer-reported ambiguities
 * drive it — see testing/panel_clarity_design_s107.md and its binding §8a:
 *
 *   1. "Which IPs are instances of this SID?"  -> ownership classification
 *   2. "Is Top Partners IN or OUT?"            -> the graph-role partner split
 *   3. "What are the Hosts-tab hosts to me?"   -> per-host traffic + ownership
 *
 * Two rules this module exists to enforce:
 *
 *   - An ownership verdict is NEVER derived from a rendered label. It comes
 *     from the hook's canonical record, keyed by node id; a node with no
 *     canonical entry gets NO badge rather than a fabricated "unattributed"
 *     (§8a-7 — the sixth id-vs-label bug this view would otherwise have had).
 *   - The traffic rows account for 100% of a node's calls. Every incident edge
 *     lands in exactly one row, so the column sums to the panel's own
 *     `Total calls` and is self-checking (§8a-1).
 *
 * Runtime imports are limited to utils/colorMath (zero-import, gate-safe);
 * the palette arrives as a plain string[] so magneticTokens — which imports
 * @splunk/splunk-utils/config and is NOT gate-loadable — never enters the
 * graph. No user-visible prose is exported from here: the panel owns its
 * wording, which also keeps this file out of the cp1252 report-module list.
 * ============================================================================ */

import { darken, lighten } from '../utils/colorMath';

/* ---------------------------------------------------------------------------
 * Ownership
 * ------------------------------------------------------------------------ */

/**
 * What the hook knows about one edge endpoint, keyed by NODE ID.
 *
 * `owner` is the SID `logserv_topology_inventory` attributes the endpoint to,
 * or null when the inventory has no entry for it. That absence has at least
 * four causes (never emitted a system identifier; failed the per-hour
 * `mvcount(sids)=1` unambiguity test; two arms disagreed; not observed since
 * the collection was populated), which is why the verdict below says
 * "unestablished" and never "shared".
 */
export interface EndpointAttribution {
    /** Canonical kind: 'sid' | 'ip' | 'host' | 'tenant_db'. */
    kind: string;
    /** Canonical value — the IP, hostname or SID name. */
    value: string;
    /** Inventory-resolved owning SID, or null when not established. */
    owner: string | null;
    /** True iff the inventory had an entry (i.e. `owner` is non-null). */
    resolved: boolean;
}

export type Ownership =
    /** Nothing measurable: no canonical entry, or a kind that cannot be owned. */
    | { state: 'none' }
    /** The inventory attributes this endpoint to `sid`. */
    | { state: 'owner'; sid: string }
    /** An IP/host the inventory has no entry for. */
    | { state: 'unestablished' };

/** The canonical kinds an inventory owner can exist for. A `sid` owns itself
 *  and a `tenant_db` is a logical database, so neither carries a badge. */
export const OWNABLE_KINDS: readonly string[] = ['ip', 'host'];

const NONE: Ownership = { state: 'none' };

/**
 * Classify an endpoint from the hook's record. A missing record yields
 * `none` — the panel then renders no badge at all, because "we could not
 * resolve this id" is not the same statement as "no system claims it".
 */
export const classifyEndpointOwnership = (
    att: EndpointAttribution | null | undefined,
): Ownership => {
    if (!att || typeof att.kind !== 'string') return NONE;
    if (OWNABLE_KINDS.indexOf(att.kind) === -1) return NONE;
    if (att.owner) return { state: 'owner', sid: att.owner };
    return { state: 'unestablished' };
};

/**
 * Classify a Hosts-tab row. Unlike the donut legend this lookup is BY VALUE,
 * which is sound and is the one place it is: the `node_host` metric's `host`
 * grain and `logserv_topology_inventory`'s `_key` are both the raw
 * canonical_value, so no id translation is involved. The entity is a hostname
 * by construction, so `unestablished` here is measured, not fabricated.
 */
export const classifyHostOwnership = (
    host: string,
    ownerByValue: Readonly<Record<string, string>>,
): Ownership => {
    if (!host) return NONE;
    const owner = ownerByValue ? ownerByValue[host] : undefined;
    if (owner) return { state: 'owner', sid: owner };
    return { state: 'unestablished' };
};

/* ---------------------------------------------------------------------------
 * Per-node traffic rows
 * ------------------------------------------------------------------------ */

/**
 * Which way the calls flow, FROM THE SELECTED NODE'S POINT OF VIEW.
 *
 * Deliberately not called `direction`: `TopologyEdge.direction`
 * (`client | server | bidi`) is ranked from the SOURCE node's perspective and
 * is a different axis. Two axes sharing one name in this module is how the
 * previous id/label confusions started (§8a-16).
 */
export type TrafficFlow = 'inbound' | 'outbound' | 'bidirectional';

/** The stored fields a member row must expose for accumulation. Structural on
 *  purpose so the gate can drive this without the hook's private interfaces. */
export interface TrafficMemberRow {
    source_id: string;
    target_id: string;
    call_count: number;
    error_count?: number;
}

/**
 * One surviving edge group — i.e. one RENDERED edge plus the stored rows that
 * compose it. Note `rows` carries the PRE-retarget endpoint ids: inventory
 * retargeting folds a resolved host endpoint into its SID's node before
 * grouping, so the rendered edge's node-side endpoint is the SID and the host
 * name survives only here (§8a-2). This is also what gives the table per-host
 * granularity when several hosts fold onto one SID.
 */
export interface TrafficEdgeGroup {
    retargetedSource: string;
    retargetedTarget: string;
    /** The canonical SPL edge type: http | rfc | hana_audit | hana_tenant. */
    splType: string;
    /** The stored `direction` field; 'bidi' suppresses the flow claim. */
    direction: string;
    rows: readonly TrafficMemberRow[];
}

export interface TrafficRow {
    /** 'host' names a receiving host; 'type' names an edge type whose calls
     *  cannot be attributed to a host at all. */
    scope: 'host' | 'type';
    /** The host's canonical value, or the SPL edge type. */
    key: string;
    flow: TrafficFlow;
    calls: number;
    errors: number;
}

/** Minimal canonical lookup: node id -> canonical (kind, value), or null. */
export type CanonicalLookup = (nodeId: string) => { kind: string; value: string } | null | undefined;

const rowKey = (scope: string, key: string, flow: string): string => `${scope}\u0000${key}\u0000${flow}`;

/**
 * Build every node's traffic rows from the SURVIVING edge groups.
 *
 * The caller must pass groups AFTER the self-loop filter; a self-loop
 * contributes to no rendered edge and to no headline total, so counting one
 * would make this table out-sum `Total calls` one scroll above it (§8a-3).
 * The guard below is defence in depth, and the gate mutation-tests it.
 *
 * Classification is per EDGE INSTANCE, never per type: an edge whose node-side
 * stored endpoint is canonical kind `host` produces a host row; everything
 * else produces a system-level row keyed by the edge type — which is where
 * outbound traffic becomes visible, including outbound HTTP when the selected
 * node is the client-side IP (§8a-1).
 *
 * Rows are READ from; nothing here mutates a member row. `rows` holds
 * references shared with `collectBucketIds` and the build-321 activity
 * accumulator, and annotating one would corrupt both.
 */
export const buildNodeTraffic = (
    groups: readonly TrafficEdgeGroup[],
    canonicalOf: CanonicalLookup,
): Record<string, TrafficRow[]> => {
    const acc = new Map<string, Map<string, TrafficRow>>();

    const add = (
        nodeId: string,
        scope: 'host' | 'type',
        key: string,
        flow: TrafficFlow,
        calls: number,
        errors: number,
    ): void => {
        let perNode = acc.get(nodeId);
        if (!perNode) {
            perNode = new Map<string, TrafficRow>();
            acc.set(nodeId, perNode);
        }
        const k = rowKey(scope, key, flow);
        const existing = perNode.get(k);
        if (existing) {
            existing.calls += calls;
            existing.errors += errors;
        } else {
            perNode.set(k, { scope, key, flow, calls, errors });
        }
    };

    groups.forEach((g) => {
        if (!g || !Array.isArray(g.rows)) return;
        // Self-loops never render, so they must never accumulate.
        if (g.retargetedSource === g.retargetedTarget) return;
        const bidi = g.direction === 'bidi';
        const sides: { nodeId: string; flow: TrafficFlow; pick: (r: TrafficMemberRow) => string }[] = [
            {
                nodeId: g.retargetedTarget,
                flow: bidi ? 'bidirectional' : 'inbound',
                pick: (r) => r.target_id,
            },
            {
                nodeId: g.retargetedSource,
                flow: bidi ? 'bidirectional' : 'outbound',
                pick: (r) => r.source_id,
            },
        ];
        sides.forEach((side) => {
            if (!side.nodeId) return;
            g.rows.forEach((r) => {
                if (!r) return;
                const calls = typeof r.call_count === 'number' ? r.call_count : 0;
                const errors = typeof r.error_count === 'number' ? r.error_count : 0;
                const canonical = canonicalOf(side.pick(r));
                if (canonical && canonical.kind === 'host' && canonical.value) {
                    add(side.nodeId, 'host', canonical.value, side.flow, calls, errors);
                } else {
                    add(side.nodeId, 'type', g.splType, side.flow, calls, errors);
                }
            });
        });
    });

    const out: Record<string, TrafficRow[]> = {};
    acc.forEach((perNode, nodeId) => {
        out[nodeId] = Array.from(perNode.values()).sort((a, b) => {
            if (a.scope !== b.scope) return a.scope === 'host' ? -1 : 1;
            if (b.calls !== a.calls) return b.calls - a.calls;
            if (a.key !== b.key) return a.key < b.key ? -1 : 1;
            return a.flow < b.flow ? -1 : 1;
        });
    });
    return out;
};

/** Sum a node's traffic rows — the value that must equal `Total calls`. */
export const trafficTotal = (rows: readonly TrafficRow[]): number =>
    rows.reduce((s, r) => s + r.calls, 0);

/* ---------------------------------------------------------------------------
 * Per-edge app-server rows (build 325 / session 110, plan item E3)
 * ------------------------------------------------------------------------ */

/** The stored fields an RFC member row must expose for the app-server split.
 *  Structural, like TrafficMemberRow, so the gate can drive this without the
 *  hook's private interfaces. `local_ip` is the SID-side gateway listening
 *  address the build-325 key change projects onto RFC rows; rows stored
 *  before that change simply lack it. */
export interface AppServerMemberRow {
    local_ip?: string;
    call_count: number;
    error_count?: number;
}

/** One "By app server" row of the edge Overview tab. `localIp === null`
 *  collects the pre-build-325 rows (no stored address) — the panel names
 *  them "(not recorded)" and points at Clear + Backfill. */
export interface EdgeAppServerRow {
    localIp: string | null;
    calls: number;
    errors: number;
}

/**
 * Group an RFC edge's member rows by `local_ip`. The member rows PARTITION
 * the rendered edge's buckets, so `calls` sums to the edge's `callCount` by
 * construction — the same self-checking property as buildNodeTraffic (§8a-1).
 *
 * What the rows are — and are not: the gateway log records the LISTENING
 * ADDRESS a call was handled on, so these are the SID-side app servers as the
 * data names them, not a full instance inventory. The panel's caption says so.
 *
 * Sorted by calls desc; ties break by localIp asc with the null
 * (pre-upgrade) row last — deterministic across re-renders (the session-108
 * tie-break lesson: a fixture already in sorted order proves nothing, and an
 * unstable order repaints rows under the user's cursor).
 */
export const buildEdgeAppServers = (
    rows: readonly AppServerMemberRow[],
): EdgeAppServerRow[] => {
    const acc = new Map<string | null, EdgeAppServerRow>();
    rows.forEach((r) => {
        if (!r) return;
        const key = typeof r.local_ip === 'string' && r.local_ip.length > 0
            ? r.local_ip
            : null;
        const calls = typeof r.call_count === 'number' && Number.isFinite(r.call_count)
            ? r.call_count
            : 0;
        const errors = typeof r.error_count === 'number' && Number.isFinite(r.error_count)
            ? r.error_count
            : 0;
        const existing = acc.get(key);
        if (existing) {
            existing.calls += calls;
            existing.errors += errors;
        } else {
            acc.set(key, { localIp: key, calls, errors });
        }
    });
    return Array.from(acc.values()).sort((a, b) => {
        if (b.calls !== a.calls) return b.calls - a.calls;
        if (a.localIp === null) return 1;
        if (b.localIp === null) return -1;
        if (a.localIp !== b.localIp) return a.localIp < b.localIp ? -1 : 1;
        return 0;
    });
};

/* ---------------------------------------------------------------------------
 * The partner split
 * ------------------------------------------------------------------------ */

/** The rendered-edge fields the split needs. */
export interface PartnerEdgeLike {
    source: string;
    target: string;
    callCount: number;
    direction: string;
    /** Optional; only used to name the bidirectional types in the panel note. */
    splType?: string;
}

export interface PartnerEntry {
    /** The partner's NODE ID — the React key and the attribution lookup key.
     *  The label is display text only (§8a-11). */
    id: string;
    calls: number;
}

export interface PartnerSplit {
    /** Partners that call this node, grouped by edge source. */
    inbound: PartnerEntry[];
    /** Partners this node calls, grouped by edge target. */
    outbound: PartnerEntry[];
    inboundCalls: number;
    outboundCalls: number;
    /** Calls on edges stored as `direction="bidi"`, excluded from both groups
     *  because their source/target ordering is an artefact of how the SPL arm
     *  assembles the pair — filing them under IN or OUT would assert a
     *  direction the row itself denies (§8a-8). */
    bidiCalls: number;
    bidiEdges: number;
    /** Distinct SPL types carrying those bidirectional edges, so the panel can
     *  name them instead of asserting a generic claim. Sorted, de-duplicated. */
    bidiTypes: string[];
    /** inboundCalls + outboundCalls + bidiCalls. Equals the panel's
     *  `Total calls` because incoming and outgoing partition the node's
     *  incident edges (self-loops are already filtered upstream). */
    totalCalls: number;
}

const collectPartners = (
    edges: readonly PartnerEdgeLike[],
    endpointOf: (e: PartnerEdgeLike) => string,
): { list: PartnerEntry[]; calls: number } => {
    const counts = new Map<string, number>();
    let calls = 0;
    edges.forEach((e) => {
        if (!e || e.direction === 'bidi') return;
        const id = endpointOf(e);
        if (!id) return;
        const c = typeof e.callCount === 'number' ? e.callCount : 0;
        counts.set(id, (counts.get(id) ?? 0) + c);
        calls += c;
    });
    const list = Array.from(counts.entries())
        .map(([id, c]) => ({ id, calls: c }))
        .sort((a, b) => (b.calls !== a.calls ? b.calls - a.calls : (a.id < b.id ? -1 : 1)));
    return { list, calls };
};

/**
 * Split a node's partners by GRAPH ROLE. Every partner is listed — no top-N
 * slice and no OTHER bucket; bounding happens in the legend (planLegend), so
 * the chart and its totals stay exhaustive.
 */
export const splitPartners = (
    incoming: readonly PartnerEdgeLike[],
    outgoing: readonly PartnerEdgeLike[],
): PartnerSplit => {
    const inb = collectPartners(incoming, (e) => e.source);
    const outb = collectPartners(outgoing, (e) => e.target);
    let bidiCalls = 0;
    let bidiEdges = 0;
    const bidiTypeSet = new Set<string>();
    const countBidi = (edges: readonly PartnerEdgeLike[]): void => {
        edges.forEach((e) => {
            if (!e || e.direction !== 'bidi') return;
            bidiEdges += 1;
            bidiCalls += typeof e.callCount === 'number' ? e.callCount : 0;
            if (e.splType) bidiTypeSet.add(e.splType);
        });
    };
    countBidi(incoming);
    countBidi(outgoing);
    return {
        inbound: inb.list,
        outbound: outb.list,
        inboundCalls: inb.calls,
        outboundCalls: outb.calls,
        bidiCalls,
        bidiEdges,
        bidiTypes: Array.from(bidiTypeSet).sort(),
        totalCalls: inb.calls + outb.calls + bidiCalls,
    };
};

/* ---------------------------------------------------------------------------
 * Legend
 * ------------------------------------------------------------------------ */

/**
 * How many legend entries the PALETTE guarantees are fully pairwise separable.
 *
 * The legend itself is NOT capped — it lists every partner. This constant is
 * the colour design's promise and the gate's window: within the first N
 * entries any two colours are at least as separable as the base palette's own
 * tightest pair; beyond N the guarantee weakens to "adjacent entries are
 * separable and no colour ever repeats", which is what a reader scanning a
 * long list actually relies on.
 */
export const PALETTE_FULL_SEPARATION_ROWS = 8;

/* ---------------------------------------------------------------------------
 * Donut geometry
 * ------------------------------------------------------------------------ */

export interface DonutSegment {
    /** Start fraction of the circle, 0..1. */
    t0: number;
    /** End fraction. Equal to t0 for a non-positive value (nothing drawn). */
    t1: number;
}

/** Minimum visible arc per wedge. Each wedge is stroked 1 px against a ~314 px
 *  circumference, so anything under roughly 0.6% is consumed by its own stroke
 *  and renders as background while its legend row claims a colour (§8a-9). */
export const DONUT_MIN_SLIVER = 0.015;
/** Gap between wedges, so the min sliver is not eaten by the neighbours. */
export const DONUT_GAP = 0.006;

/**
 * Proportional + minimum-sliver + gap layout for an N-wedge donut. Generalises
 * `computeBucketSegments` (SidNode.tsx), which does the same for exactly three.
 *
 * The reserved minimum and the gaps shrink as the wedge count grows so they can
 * never exceed the circle. Angles therefore encode proportion APPROXIMATELY —
 * the accepted trade this codebase already makes on the node health ring; the
 * legend carries the exact counts.
 *
 * Returns one segment per input value, in input order, so callers can zip with
 * their labels and colours. Non-positive values yield a zero-length segment.
 */
export const donutSegments = (
    values: readonly number[],
    minSliver: number = DONUT_MIN_SLIVER,
    gap: number = DONUT_GAP,
): DonutSegment[] => {
    const positives = values.filter((v) => typeof v === 'number' && v > 0);
    const n = positives.length;
    if (n === 0) return values.map(() => ({ t0: 0, t1: 0 }));
    /* Reserved minima never take more than 80% of the circle, and the gaps
     * never more than 15% — so `remaining` stays non-negative for any N and
     * the proportional term never inverts. */
    const minEach = Math.min(minSliver, 0.8 / n);
    const gapEach = n > 1 ? Math.min(gap, 0.15 / n) : 0;
    const remaining = Math.max(0, 1 - n * minEach - n * gapEach);
    const sum = positives.reduce((s, v) => s + v, 0);
    let cursor = 0;
    return values.map((v) => {
        if (!(typeof v === 'number') || v <= 0) return { t0: cursor, t1: cursor };
        const len = minEach + (v / sum) * remaining;
        const seg = { t0: cursor, t1: cursor + len };
        cursor += len + gapEach;
        return seg;
    });
};

/** How many wedges a value list will actually draw. <= 1 means the segmented
 *  path degenerates to an arc-to-itself and the caller must draw a full circle
 *  instead — the build-227/228 fix, never carried into DonutChart. */
export const visibleWedgeCount = (values: readonly number[]): number =>
    values.filter((v) => typeof v === 'number' && v > 0).length;

/**
 * True when at least one wedge is drawn WIDER than its true share, because it
 * would otherwise be too small to survive its own stroke.
 *
 * This is the honest trigger for the panel's "the angles are approximate"
 * disclosure: it fires exactly when the geometry stops encoding proportion,
 * rather than at some proxy like a partner count. Note that a couple of even
 * wedges are drawn slightly NARROWER than their share (the inter-wedge gaps
 * come out of the same budget) — that is not a misrepresentation of one slice
 * relative to another, so it does not count here.
 */
export const hasInflatedWedges = (
    values: readonly number[],
    minSliver: number = DONUT_MIN_SLIVER,
    gap: number = DONUT_GAP,
): boolean => {
    const positives = values.filter((v) => typeof v === 'number' && v > 0);
    const n = positives.length;
    if (n === 0) return false;
    const minEach = Math.min(minSliver, 0.8 / n);
    const gapEach = n > 1 ? Math.min(gap, 0.15 / n) : 0;
    const remaining = Math.max(0, 1 - n * minEach - n * gapEach);
    const sum = positives.reduce((s, v) => s + v, 0);
    return positives.some((v) => {
        const share = v / sum;
        return minEach + share * remaining > share + 1e-12;
    });
};

/* ---------------------------------------------------------------------------
 * Palette cycling
 * ------------------------------------------------------------------------ */

/**
 * Colour for wedge `i`, cycling the palette and stepping the shade once per
 * completed cycle. The step direction follows the resolved theme so a shade
 * never buries itself in the panel background: lighten on dark, darken on
 * light (§8a-12).
 */
export const partnerColorAt = (
    palette: readonly string[],
    i: number,
    mode: 'light' | 'dark',
): string => {
    if (!palette || palette.length === 0) return '#888888';
    const idx = ((i % palette.length) + palette.length) % palette.length;
    const base = palette[idx];
    const cycle = Math.floor(Math.max(0, i) / palette.length);
    if (cycle === 0) return base;
    /* Strictly increasing and never clamped: a `Math.min(cap, k * cycle)` form
     * collapses once it reaches the cap, so every cycle beyond that resolves to
     * the SAME shade and the palette emits exact duplicate colours. The
     * asymptote below approaches 0.62 without ever reaching it, so no two
     * cycles can produce the same amount. */
    const amount = 0.62 * (1 - Math.pow(0.55, cycle));
    return mode === 'dark' ? lighten(base, amount) : darken(base, amount);
};

const hexToRgb = (hex: string): [number, number, number] | null => {
    if (typeof hex !== 'string') return null;
    const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
    if (!m) return null;
    const n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

/**
 * Perceptual distance between two colours ("redmean" weighted RGB, ~0..765).
 * Used by the gate to assert that cycling does not make the palette LESS
 * discriminable than the base set the app already ships — a derived threshold
 * rather than an arbitrary one, and strictly stronger than string inequality,
 * which would pass while the legend fails its only purpose.
 */
export const colorDistance = (a: string, b: string): number => {
    const ca = hexToRgb(a);
    const cb = hexToRgb(b);
    if (!ca || !cb) return 0;
    const rmean = (ca[0] + cb[0]) / 2;
    const dr = ca[0] - cb[0];
    const dg = ca[1] - cb[1];
    const db = ca[2] - cb[2];
    return Math.sqrt(
        (2 + rmean / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rmean) / 256) * db * db,
    );
};

/** Smallest pairwise distance in a colour list. */
export const minPairwiseDistance = (colors: readonly string[]): number => {
    let min = Infinity;
    for (let i = 0; i < colors.length; i += 1) {
        for (let j = i + 1; j < colors.length; j += 1) {
            const d = colorDistance(colors[i], colors[j]);
            if (d < min) min = d;
        }
    }
    return Number.isFinite(min) ? min : 0;
};
