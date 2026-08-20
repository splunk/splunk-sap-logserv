/**
 * Build-time consistency test for the topology node panel's derived facts
 * (build 322, session 108).
 *
 * What it pins, and why each one is here rather than left to review:
 *
 *  - OWNERSHIP is a claim about a customer's estate. A missing canonical entry
 *    must produce NO badge, never "unattributed" — that would be a fabricated
 *    fact about an endpoint whose name we merely failed to resolve, which is
 *    the shape of the five prior id-vs-label bugs in this view.
 *  - The TRAFFIC rows must account for 100% of a node's calls, so the table
 *    reconciles against the `Total calls` row one tab away. Self-loop groups
 *    are dropped from the rendered graph and must therefore not accumulate,
 *    or the table out-sums the headline.
 *  - The PARTNER split must not file a bidirectional edge under a direction
 *    the stored row explicitly denies, and the three totals must still sum.
 *  - The DONUT must draw every wedge it has data for: a sub-1% wedge that
 *    renders as background, or a single wedge drawn as a degenerate
 *    arc-to-itself, leaves a legend row claiming a colour that is not there.
 *
 * The halves that can only be checked against the shipped conf and the real
 * theme tokens — that canonical kind `host` is never an edge SOURCE, and that
 * palette cycling stays discriminable — are section 3o of
 * bin/check-diagnostics.js, so neither can drift alone.
 *
 * Run standalone with: `yarn check:diagnostics`
 */

/* eslint-disable no-console */

// Standalone script, not a module — see session-085 sticky #4.
export {};

const pfProc = process as unknown as {
    stderr: { write(s: string): void };
    exit(code: number): never;
};

/* eslint-disable @typescript-eslint/no-explicit-any */
const pf = require('../topology/panelFacts') as any;
/* eslint-enable @typescript-eslint/no-explicit-any */

const {
    classifyEndpointOwnership,
    classifyHostOwnership,
    buildNodeTraffic,
    buildEdgeAppServers,
    trafficTotal,
    splitPartners,
    hasInflatedWedges,
    donutSegments,
    visibleWedgeCount,
    partnerColorAt,
    colorDistance,
    minPairwiseDistance,
    DONUT_MIN_SLIVER,
} = pf;

/** Segment length, needed by the D block before the E block declares its own. */
const segLenOf = (s: { t0: number; t1: number }): number => s.t1 - s.t0;

let pfFailures = 0;
let pfChecks = 0;
const check = (label: string, ok: boolean, detail: string): void => {
    pfChecks += 1;
    if (!ok) {
        pfFailures += 1;
        pfProc.stderr.write(`FAIL: ${label}: ${detail}\n`);
    }
};
const eq = (label: string, actual: unknown, expected: unknown): void =>
    check(label, JSON.stringify(actual) === JSON.stringify(expected),
        `got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);

/* =============================================================================
 * A. Ownership — the claim that reaches the customer as a badge
 * ========================================================================== */

const att = (kind: string, value: string, owner: string | null) => ({
    kind, value, owner, resolved: owner !== null,
});

eq('A1 no canonical entry renders no badge',
    classifyEndpointOwnership(undefined), { state: 'none' });
eq('A2 null canonical entry renders no badge',
    classifyEndpointOwnership(null), { state: 'none' });
eq('A3 a SID owns itself, so no badge',
    classifyEndpointOwnership(att('sid', 'XCP', null)), { state: 'none' });
eq('A4 a tenant database carries no ownership badge',
    classifyEndpointOwnership(att('tenant_db', 'XCQ', null)), { state: 'none' });
eq('A5 an inventoried IP names its owner',
    classifyEndpointOwnership(att('ip', '10.1.2.3', 'XCP')), { state: 'owner', sid: 'XCP' });
eq('A6 an un-inventoried IP is unestablished, not unattributed',
    classifyEndpointOwnership(att('ip', '10.1.2.3', null)), { state: 'unestablished' });
eq('A7 an inventoried host names its owner',
    classifyEndpointOwnership(att('host', 'hec53v1', 'XCQ')), { state: 'owner', sid: 'XCQ' });
eq('A8 an un-inventoried host is unestablished',
    classifyEndpointOwnership(att('host', 'hec53v1', null)), { state: 'unestablished' });
// The mutation this kills: treating "no canonical entry" the same as "no owner".
check('A9 a missing entry is NOT reported as unestablished',
    classifyEndpointOwnership(undefined).state !== 'unestablished',
    'an unresolvable id would be asserted as having no owner');
eq('A10 an unknown kind carries no badge',
    classifyEndpointOwnership(att('service', 'x', null)), { state: 'none' });

eq('A11 hosts-tab lookup by value, present',
    classifyHostOwnership('hec53v1', { hec53v1: 'XCP' }), { state: 'owner', sid: 'XCP' });
eq('A12 hosts-tab lookup by value, absent',
    classifyHostOwnership('hec53v9', { hec53v1: 'XCP' }), { state: 'unestablished' });
eq('A13 an empty host name claims nothing',
    classifyHostOwnership('', { hec53v1: 'XCP' }), { state: 'none' });

/* =============================================================================
 * B. Traffic rows — 100% of a node's calls, and nothing that does not render
 * ========================================================================== */

const SID_A = 'sidA';
const SID_B = 'sidB';
const HOST_1 = 'host1id';
const HOST_2 = 'host2id';
const IP_1 = 'ip1id';
const TENANT = 'tenantid';

const CANON: Record<string, { kind: string; value: string }> = {
    [SID_A]: { kind: 'sid', value: 'XCP' },
    [SID_B]: { kind: 'sid', value: 'XCQ' },
    [HOST_1]: { kind: 'host', value: 'hec53v014018' },
    [HOST_2]: { kind: 'host', value: 'hec53v014019' },
    [IP_1]: { kind: 'ip', value: '10.186.72.127' },
    [TENANT]: { kind: 'tenant_db', value: 'XCQ' },
};
const canonicalOf = (id: string) => CANON[id] ?? null;

const row = (s: string, t: string, calls: number, errs = 0) => ({
    source_id: s, target_id: t, call_count: calls, error_count: errs,
});

/* http: an IP calls two hosts, BOTH of which the inventory folds onto SID_A.
 * The rendered edge's node-side endpoint is therefore SID_A (kind 'sid') —
 * the host names survive only on these member rows, which is exactly why the
 * accumulator reads them (§8a-2). */
const HTTP_GROUP = {
    retargetedSource: IP_1,
    retargetedTarget: SID_A,
    splType: 'http',
    direction: 'client',
    rows: [row(IP_1, HOST_1, 100, 7), row(IP_1, HOST_2, 40, 1), row(IP_1, HOST_1, 10, 0)],
};
/* rfc: SID_A calls a peer IP. Node-side endpoint is a SID, so this is an
 * edge-type row and it is where outbound traffic becomes visible. */
const RFC_GROUP = {
    retargetedSource: SID_A,
    retargetedTarget: IP_1,
    splType: 'rfc',
    direction: 'client',
    rows: [row(SID_A, IP_1, 25, 3)],
};
/* hana_tenant: stored bidirectional; neither side may be called in or out. */
const TENANT_GROUP = {
    retargetedSource: SID_A,
    retargetedTarget: TENANT,
    splType: 'hana_tenant',
    direction: 'bidi',
    rows: [row(SID_A, TENANT, 9, 0)],
};
/* A self-loop: dropped from the rendered graph, so it must not accumulate. */
const SELF_LOOP_GROUP = {
    retargetedSource: SID_A,
    retargetedTarget: SID_A,
    splType: 'rfc',
    direction: 'client',
    rows: [row(SID_A, HOST_1, 5000, 500)],
};

const ALL_GROUPS = [HTTP_GROUP, RFC_GROUP, TENANT_GROUP, SELF_LOOP_GROUP];
const before = JSON.stringify(ALL_GROUPS);
const traffic = buildNodeTraffic(ALL_GROUPS, canonicalOf);
check('B0 the accumulator does not mutate the member rows it reads',
    JSON.stringify(ALL_GROUPS) === before,
    'agg.rows is shared with collectBucketIds and the activity accumulator');

const rowsA = traffic[SID_A] ?? [];
interface RowLike { scope: string; key: string; flow: string; calls: number; errors: number }
const findRow = (rows: RowLike[], scope: string, key: string): RowLike | undefined =>
    rows.filter((r) => r.scope === scope && r.key === key)[0];

const h1 = findRow(rowsA, 'host', 'hec53v014018');
const h2 = findRow(rowsA, 'host', 'hec53v014019');
check('B1 several hosts folding onto one SID stay separate rows',
    !!h1 && !!h2, `got ${JSON.stringify(rowsA.map((r: { key: string }) => r.key))}`);
eq('B2 host row sums its member rows', h1 && [h1.calls, h1.errors], [110, 7]);
eq('B3 host rows are inbound — a host endpoint is only ever a target',
    h1 && h1.flow, 'inbound');
const rfcRow = findRow(rowsA, 'type', 'rfc');
eq('B4 outbound traffic appears as an edge-type row', rfcRow && [rfcRow.flow, rfcRow.calls, rfcRow.errors],
    ['outbound', 25, 3]);
const tenantRow = findRow(rowsA, 'type', 'hana_tenant');
eq('B5 a bidirectional edge claims no direction', tenantRow && tenantRow.flow, 'bidirectional');

// The reconciliation property the whole table rests on.
const renderedCallsForA = HTTP_GROUP.rows.concat(RFC_GROUP.rows).concat(TENANT_GROUP.rows)
    .reduce((s, r) => s + r.call_count, 0);
eq('B6 the rows account for 100% of the node\'s rendered calls',
    trafficTotal(rowsA), renderedCallsForA);
check('B7 the self-loop\'s 5000 calls are excluded',
    trafficTotal(rowsA) === 184 && rowsA.every((r: { calls: number }) => r.calls !== 5000),
    `total ${trafficTotal(rowsA)} — a self-loop contributes to no rendered edge`);

// The other endpoints see the mirror image.
const rowsIp = traffic[IP_1] ?? [];
eq('B8 the partner sees the same edges from its own side',
    rowsIp.map((r: { scope: string; key: string; flow: string; calls: number }) =>
        [r.scope, r.key, r.flow, r.calls]),
    [['type', 'http', 'outbound', 150], ['type', 'rfc', 'inbound', 25]]);
check('B9 an IP-kind node produces no host rows — those hosts are the far end',
    rowsIp.every((r: { scope: string }) => r.scope === 'type'),
    'badging them would invert the ownership claim');

// An endpoint with no canonical entry must not be rendered as a hash.
const UNKNOWN_GROUP = {
    retargetedSource: 'unknownid',
    retargetedTarget: SID_B,
    splType: 'http',
    direction: 'client',
    rows: [row('unknownid', 'unknownid2', 12, 0)],
};
const unknownTraffic = buildNodeTraffic([UNKNOWN_GROUP], canonicalOf);
eq('B10 an unresolvable endpoint falls to the edge-type row, never a hash-named host row',
    (unknownTraffic[SID_B] ?? []).map((r: { scope: string; key: string }) => [r.scope, r.key]),
    [['type', 'http']]);

// Ordering: hosts first (they are the answer to the question asked), then by volume.
const ordered = rowsA.map((r: { scope: string; key: string }) => `${r.scope}:${r.key}`);
check('B11 host rows sort before edge-type rows, then by call volume',
    ordered[0] === 'host:hec53v014018' && ordered[1] === 'host:hec53v014019'
    && ordered.indexOf('type:rfc') > 1,
    JSON.stringify(ordered));

// Defence in depth: a self-loop passed alone still contributes nothing.
eq('B12 a lone self-loop group produces no rows at all',
    Object.keys(buildNodeTraffic([SELF_LOOP_GROUP], canonicalOf)).length, 0);
eq('B13 a missing error_count counts as zero, not NaN',
    (buildNodeTraffic([{
        ...RFC_GROUP,
        rows: [{ source_id: SID_A, target_id: IP_1, call_count: 4 }],
    }], canonicalOf)[SID_A] ?? [])[0]?.errors, 0);

/* =============================================================================
 * C. The partner split
 * ========================================================================== */

const edge = (source: string, target: string, callCount: number, direction = 'client', splType = 'http') =>
    ({ source, target, callCount, direction, splType });

/* p3 is fed BEFORE p2 deliberately. Array.prototype.sort is stable and the
 * Map preserves insertion order, so a fixture in already-correct order would
 * satisfy C8 with no tie-break at all. Group order derives from the KV fetch,
 * which issues no sort — and the wedge colour is assigned by index, so two
 * equal-count partners swapping re-colours the donut between refreshes. */
const INCOMING = [edge('p1', SID_A, 100), edge('p3', SID_A, 50), edge('p2', SID_A, 50),
    edge(TENANT, SID_A, 9, 'bidi', 'hana_tenant')];
const OUTGOING = [edge(SID_A, 'p4', 25), edge(SID_A, 'p1', 5),
    edge(SID_A, TENANT, 11, 'bidi', 'hana_tenant')];
const split = splitPartners(INCOMING, OUTGOING);

eq('C1 every inbound partner is listed — no top-N slice, no OTHER',
    split.inbound.map((p: PartnerLike) => [p.id, p.calls]),
    [['p1', 100], ['p2', 50], ['p3', 50]]);
eq('C2 every outbound partner is listed',
    split.outbound.map((p: PartnerLike) => [p.id, p.calls]), [['p4', 25], ['p1', 5]]);
eq('C3 bidirectional edges are counted separately', [split.bidiEdges, split.bidiCalls], [2, 20]);
eq('C4 and their types are named so the panel need not guess', split.bidiTypes, ['hana_tenant']);
check('C5 no bidirectional edge appears in either directional group',
    split.inbound.concat(split.outbound).every((p: PartnerLike) => p.id !== TENANT),
    'a bidi edge would be asserted as having a direction its own row denies');
eq('C6 in + out + bidi equals the node total',
    split.inboundCalls + split.outboundCalls + split.bidiCalls, split.totalCalls);
eq('C7 which is also the sum of every incident edge',
    split.totalCalls,
    INCOMING.concat(OUTGOING).reduce((s, e) => s + e.callCount, 0));
check('C8 ties break deterministically so the legend does not churn',
    split.inbound[1].id === 'p2' && split.inbound[2].id === 'p3',
    'equal-count partners must keep a stable order across renders');
eq('C9 a partner on both sides is counted once per direction',
    [split.inbound.filter((p: PartnerLike) => p.id === 'p1')[0].calls,
        split.outbound.filter((p: PartnerLike) => p.id === 'p1')[0].calls], [100, 5]);
const emptySplit = splitPartners([], []);
eq('C10 an isolated node splits to zeros, not NaN',
    [emptySplit.inbound.length, emptySplit.outbound.length, emptySplit.totalCalls], [0, 0, 0]);
interface PartnerLike { id: string; calls: number }

/* =============================================================================
 * D. The approximate-angle disclosure trigger
 *
 * The legend is NOT capped — every partner is listed. What IS approximate is
 * the GEOMETRY: a slice too small to survive its own stroke is widened to stay
 * visible. `hasInflatedWedges` is what the panel gates its disclosure on, so it
 * has to fire exactly when that happens and not merely when a chart is busy.
 * ========================================================================== */

eq('D1 nothing to draw claims nothing', hasInflatedWedges([]), false);
eq('D2 a single wedge fills the ring at its true share', hasInflatedWedges([42]), false);
eq('D3 two even wedges are not inflated (the gaps make them slightly narrower)',
    hasInflatedWedges([50, 50]), false);
eq('D4 a long tail IS inflated — the 0.03% slices are drawn at the floor',
    hasInflatedWedges([10000, 3, 2, 1]), true);
eq('D5 the smallest slice is what triggers it',
    [hasInflatedWedges([100, 100, 100]), hasInflatedWedges([100, 100, 1])], [false, true]);
check('D6 the trigger agrees with the geometry it describes',
    (() => {
        const vals = [10000, 3, 2, 1];
        const segs = donutSegments(vals);
        const sum = vals.reduce((s, v) => s + v, 0);
        const inflated = vals.some((v, i) => segLenOf(segs[i]) > v / sum + 1e-12);
        return inflated === hasInflatedWedges(vals);
    })(),
    'the disclosure would fire when no wedge is actually widened, or stay silent when one is');

/* =============================================================================
 * E. Donut geometry
 * ========================================================================== */

const segLen = (s: { t0: number; t1: number }) => s.t1 - s.t0;
const monotonic = (segs: { t0: number; t1: number }[]): boolean => {
    for (let i = 1; i < segs.length; i += 1) {
        if (segs[i].t0 + 1e-9 < segs[i - 1].t1) return false;
    }
    return true;
};

eq('E1 nothing to draw yields no arcs', donutSegments([]).length, 0);
eq('E2 all-zero values yield only zero-length segments',
    donutSegments([0, 0]).every((s: { t0: number; t1: number }) => segLen(s) === 0), true);
eq('E3 visibleWedgeCount counts only positive values',
    [visibleWedgeCount([]), visibleWedgeCount([0, 5]), visibleWedgeCount([1, 2, 3])], [0, 1, 3]);

/* The floor is a LITERAL derived from the geometry, not the constant under
 * test: DonutChart strokes each wedge 1 px against a ~314 px circumference
 * (r=50), so a wedge below ~0.6% of the ring is consumed by its own stroke and
 * renders as background. Asserting against DONUT_MIN_SLIVER instead would make
 * this check degenerate to `>= -1e-9` the moment someone zeroed the constant. */
const STROKE_FLOOR = 0.006;
check('E4a the minimum sliver clears the 1px stroke it exists to survive',
    DONUT_MIN_SLIVER >= STROKE_FLOOR,
    `DONUT_MIN_SLIVER is ${DONUT_MIN_SLIVER}, below the ~${STROKE_FLOOR} a 1px stroke consumes`);

const LONG_TAIL = [10000, 3, 2, 1];
const tailSegs = donutSegments(LONG_TAIL);
check('E4 a sub-1% wedge is still drawn wide enough to see',
    tailSegs.slice(1).every((s: { t0: number; t1: number }) => segLen(s) >= STROKE_FLOOR),
    `got ${JSON.stringify(tailSegs.map(segLen))} — a wedge under ~0.6% is eaten by its own stroke`);
check('E5 segments are ordered and do not overlap', monotonic(tailSegs), JSON.stringify(tailSegs));
check('E6 the arcs stay inside the circle',
    tailSegs[tailSegs.length - 1].t1 <= 1 + 1e-9, `ends at ${tailSegs[tailSegs.length - 1].t1}`);
check('E7 the dominant value still gets the dominant arc',
    segLen(tailSegs[0]) > 0.5, `got ${segLen(tailSegs[0])}`);

const zeroMixed = donutSegments([5, 0, 5]);
eq('E8 a zero value takes no arc and consumes no circle',
    segLen(zeroMixed[1]) === 0 && zeroMixed[2].t0 === zeroMixed[1].t0, true);
eq('E9 the two positive values still split the circle evenly',
    Math.abs(segLen(zeroMixed[0]) - segLen(zeroMixed[2])) < 1e-9, true);

const many = donutSegments(Array.from({ length: 120 }, () => 1));
check('E10 120 equal wedges still fit inside the circle',
    many[many.length - 1].t1 <= 1 + 1e-9 && many.every((s: { t0: number; t1: number }) => segLen(s) > 0),
    `ends at ${many[many.length - 1].t1}`);
check('E11 and the reserved minimum shrinks rather than overflowing',
    monotonic(many), 'segments overlap at high wedge counts');

const single = donutSegments([42]);
check('E12 a single wedge is a full ring — the caller must draw a circle, not an arc',
    segLen(single[0]) > 0.99 && visibleWedgeCount([42]) === 1,
    'a 0..360 arc path renders as nothing (build 227/228)');

/* =============================================================================
 * F. Palette cycling (behaviour; the real-token check is gate section 3o)
 * ========================================================================== */

const FAKE = ['#4ad9d9', '#f0b02f', '#9b5ff5'];
eq('F1 the first cycle is the palette itself',
    [0, 1, 2].map((i) => partnerColorAt(FAKE, i, 'dark')), FAKE);
const lum = (hex: string): number => {
    const n = parseInt(hex.slice(1), 16);
    return ((n >> 16) & 255) + ((n >> 8) & 255) + (n & 255);
};
check('F2 dark mode lightens, so a shade never buries itself in the panel',
    lum(partnerColorAt(FAKE, 3, 'dark')) > lum(FAKE[0]),
    'shading down on a dark panel makes the wedge invisible');
check('F3 light mode darkens, for the same reason inverted',
    lum(partnerColorAt(FAKE, 3, 'light')) < lum(FAKE[0]), 'shading up on white washes out');
const cycled = Array.from({ length: FAKE.length * 3 }, (_, i) => partnerColorAt(FAKE, i, 'dark'));
eq('F4 three cycles produce no duplicate colours', new Set(cycled).size, cycled.length);
check('F5 an empty palette degrades to a colour rather than undefined',
    /^#[0-9a-f]{6}$/.test(partnerColorAt([], 0, 'dark')), 'fill={undefined} renders nothing');
check('F6 a negative index cannot escape the palette',
    FAKE.indexOf(partnerColorAt(FAKE, -1, 'dark')) >= 0, 'modulo must be normalised');
check('F7 colorDistance separates two obviously different colours',
    colorDistance('#000000', '#ffffff') > 400 && colorDistance('#4ad9d9', '#4ad9d9') === 0,
    'the perceptual metric must be usable as a gate threshold');
check('F8 minPairwiseDistance finds the tightest pair',
    Math.abs(minPairwiseDistance(['#000000', '#ffffff', '#fefefe'])
        - colorDistance('#ffffff', '#fefefe')) < 1e-9,
    'the gate compares this against the base palette');

/* =============================================================================
 * G. Per-edge app-server rows (build 325 / session 110, plan item E3)
 *
 * The By-app-server table's one load-bearing property is the same one
 * buildNodeTraffic has: the rows PARTITION the member rows, so Calls sums to
 * the edge's `Calls in window` fact two lines above it. The null bucket is a
 * claim too — "(not recorded)" must collect exactly the rows that carry no
 * address (pre-build-325 storage), never rows whose address merely repeats.
 * ========================================================================== */

const asRows = buildEdgeAppServers([
    { local_ip: '10.0.0.2', call_count: 5, error_count: 1 },
    { local_ip: '10.0.0.1', call_count: 20, error_count: 0 },
    { local_ip: '10.0.0.2', call_count: 7, error_count: 2 },
    { call_count: 3, error_count: 1 },              // pre-325 row: no address
    { local_ip: '10.0.0.1', call_count: 20, error_count: 4 },
]);
eq('G1 rows group by local_ip and sum calls + errors',
    asRows.map((r: { localIp: string | null; calls: number; errors: number }) => [r.localIp, r.calls, r.errors]),
    [['10.0.0.1', 40, 4], ['10.0.0.2', 12, 3], [null, 3, 1]]);
eq('G2 the rows partition the member rows — calls sum to the edge total',
    asRows.reduce((s: number, r: { calls: number }) => s + r.calls, 0),
    5 + 20 + 7 + 3 + 20);
check('G3 the null bucket collects ONLY address-less rows',
    asRows.filter((r: { localIp: string | null }) => r.localIp === null).length === 1
    && asRows.find((r: { localIp: string | null; calls: number }) => r.localIp === null)!.calls === 3,
    'pre-325 rows must group under "(not recorded)", never under a real address');
/* The fixture is fed UNSORTED and with the tie pair out of order — a sorted
 * fixture proves nothing about the sort (session-108 tie-break lesson). */
const gTies = buildEdgeAppServers([
    { local_ip: '10.9.9.2', call_count: 10 },
    { call_count: 10 },
    { local_ip: '10.9.9.1', call_count: 10 },
]);
eq('G4 ties break by address asc with the null row last — deterministic',
    gTies.map((r: { localIp: string | null }) => r.localIp),
    ['10.9.9.1', '10.9.9.2', null]);
eq('G5 empty input yields an empty table, not a null-row artifact',
    buildEdgeAppServers([]), []);
check('G6 a null member row is skipped, and the empty-string address is not a real address',
    (() => {
        const out = buildEdgeAppServers([
            null as never,
            { local_ip: '', call_count: 4 },
            { local_ip: '10.1.1.1', call_count: 1 },
        ]);
        return out.length === 2
            && out.some((r: { localIp: string | null; calls: number }) => r.localIp === null && r.calls === 4)
            && out.some((r: { localIp: string | null; calls: number }) => r.localIp === '10.1.1.1' && r.calls === 1);
    })(),
    'an empty-string local_ip would render a blank primary cell claiming a real address');
check('G7 non-numeric counts degrade to 0 instead of NaN-poisoning the sums',
    (() => {
        const out = buildEdgeAppServers([
            { local_ip: '10.2.2.2', call_count: 'x' as never, error_count: undefined },
            { local_ip: '10.2.2.2', call_count: 6 },
        ]);
        return out.length === 1 && out[0].calls === 6 && out[0].errors === 0;
    })(),
    'a NaN in one KV row would blank the whole table');

/* ===================================================================== */

if (pfFailures > 0) {
    pfProc.stderr.write(`\npanelFacts.consistency-test: ${pfFailures} failure(s) of ${pfChecks}\n`);
    pfProc.exit(1);
}
console.log(`panelFacts.consistency-test: OK (${pfChecks} checks)`);
