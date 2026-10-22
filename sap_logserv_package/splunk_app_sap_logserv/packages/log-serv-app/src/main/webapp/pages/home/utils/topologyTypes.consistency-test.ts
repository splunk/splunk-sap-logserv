/**
 * Build-time consistency test for the Environment Topology's edge TYPES and
 * endpoint KINDS (build 378, session 156: the SAP Router edges, item e; the
 * RFC connection captions, item f).
 *
 * What it pins, and why each one is here rather than left to review:
 *
 *  - T1-T3  The type model. `saprouter` is the 9th IntegrationType (U32 / U1):
 *    it has a legend label and a colour of its own, the stored type maps onto
 *    it, and the right pane's type badge reads the SAME colour token as the
 *    graph — two copies of a colour drift, so there is one name
 *    (SAPROUTER_EDGE_TOKEN) and this suite holds both readers to it.
 *  - T4     The colour is legible: in BOTH modes (the real MODE_TOKENS, not a
 *    regex over the source) it is perceptually far from every other legend
 *    colour, from the health ring's red and green, from the selected-edge
 *    stroke and from the unknown-type grey, and adding it does not make the
 *    legend less discriminable. The light-mode trfc / btp_iflow collision
 *    (orangeLight == yellow) predates build 378; it is reported, and any
 *    OTHER collision fails.
 *  - T5     The saved-layout union rule: a layout saved before a type existed
 *    loads with that type ENABLED; a type the layout knew and had unchecked
 *    stays off. Without it every pre-378 saved layout would hide the SAP
 *    Router edges (the filter list is restored verbatim).
 *  - T6-T8  The router endpoint (U29 / S2): kind `saprouter` is never folded
 *    into a SID — even when the inventory maps the same host name to one —
 *    its clause fields are classified, and it carries the ROUTER tag.
 *  - T9-T11 The Edge Details text per stored type: RFC counts connections, SAP
 *    Router routed connections, and the four older types keep their exact
 *    pre-378 strings; the Operations donut's centre word is the unit's noun
 *    (never "calls" for RFC / SAP Router); the failure rate stays in [0, 1].
 *  - T12    The shipped conf against the UI: every edge type, endpoint kind,
 *    clause field and node tag the topology saved searches emit as a literal
 *    is one the UI knows (a conf arm adding a type the UI cannot draw fails
 *    here, not on a customer's canvas).
 *
 * Run standalone with: `yarn check:diagnostics`
 */

/* eslint-disable no-console */
/* eslint-disable @typescript-eslint/no-var-requires */

// Standalone script, not a module — see session-085 sticky #4.
export {};

declare const __dirname: string;

const ttProc = process as unknown as {
    stderr: { write(s: string): void };
    exit(code: number): never;
};

/* eslint-disable @typescript-eslint/no-explicit-any */
const fs = require('fs') as any;
const path = require('path') as any;
const es = require('../topology/edgeStyle') as any;
const ty = require('../topology/types') as any;
const ps = require('../topology/persistence') as any;
const pf = require('../topology/panelFacts') as any;
const mt = require('../styles/magneticTokens') as any;
/* eslint-enable @typescript-eslint/no-explicit-any */

let ttFailures = 0;
let ttChecks = 0;
const check = (label: string, ok: boolean, detail: string): void => {
    ttChecks += 1;
    if (!ok) {
        ttFailures += 1;
        ttProc.stderr.write(`FAIL: ${label}: ${detail}\n`);
    }
};
const eq = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

const HOME = path.resolve(__dirname, '..');
const read = (rel: string): string => fs.readFileSync(path.join(HOME, rel), 'utf8').replace(/\r\n/g, '\n');

/** Members of a string-literal union `export type <name> = | 'a' | 'b' ...;`,
 *  read from the SOURCE so the runtime lists below cannot drift from the
 *  compile-time unions (tsc only checks that a list's members are valid,
 *  never that the list is complete). */
const unionMembers = (src: string, name: string): string[] => {
    const m = new RegExp(`export type ${name} =([\\s\\S]*?);`).exec(src);
    if (!m) return [];
    const body = m[1].replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    const out: string[] = [];
    const re = /'([A-Za-z0-9_]+)'/g;
    let x: RegExpExecArray | null;
    while ((x = re.exec(body)) !== null) out.push(x[1]);
    return out;
};

const TYPES_SRC = read('topology/types.ts');
const INTEGRATION_TYPES: string[] = unionMembers(TYPES_SRC, 'IntegrationType');
const SPL_TYPES: string[] = unionMembers(TYPES_SRC, 'EdgeSplType');
const CANON_KINDS: string[] = unionMembers(TYPES_SRC, 'CanonicalKind');
const SYSTEM_TAGS: string[] = unionMembers(TYPES_SRC, 'SystemTag');
const ALL: string[] = es.ALL_INTEGRATION_TYPES;
const LEGACY: string[] = ps.LEGACY_INTEGRATION_TYPES_V5;
const LEGACY_EXPECTED = ['rfc', 'idoc', 'qrfc', 'trfc', 'bgrfc', 'web_service', 'odata', 'btp_iflow'];

// =============================================================================
// T1 — the IntegrationType list
// =============================================================================
check('T1 the unions could be read from topology/types.ts',
    INTEGRATION_TYPES.length >= 9 && SPL_TYPES.length >= 5 && CANON_KINDS.length >= 5 && SYSTEM_TAGS.length >= 10,
    `IntegrationType ${INTEGRATION_TYPES.length}, EdgeSplType ${SPL_TYPES.length}, CanonicalKind ${CANON_KINDS.length}, SystemTag ${SYSTEM_TAGS.length}`);
check('T1 ALL_INTEGRATION_TYPES lists every IntegrationType exactly once',
    eq([...ALL].sort(), [...INTEGRATION_TYPES].sort()) && new Set(ALL).size === ALL.length,
    `ALL ${JSON.stringify(ALL)} vs union ${JSON.stringify(INTEGRATION_TYPES)}`);
check('T1 saprouter is an integration type', ALL.indexOf('saprouter') !== -1, JSON.stringify(ALL));
check('T1 LEGACY_INTEGRATION_TYPES_V5 is the frozen eight, in order',
    eq(LEGACY, LEGACY_EXPECTED) && Object.isFrozen(LEGACY),
    `${JSON.stringify(LEGACY)} frozen=${Object.isFrozen(LEGACY)} — appending to it would hide the new type on old layouts`);
check('T1 the legacy eight keep their display order at the head of the list',
    eq(ALL.slice(0, LEGACY_EXPECTED.length), LEGACY_EXPECTED),
    `ALL starts ${JSON.stringify(ALL.slice(0, 8))}`);
{
    const labels = ALL.map((t) => es.integrationTypeLabel(t));
    check('T1 every type has its own legend label',
        ALL.every((t, i) => typeof labels[i] === 'string' && labels[i] !== String(t) && labels[i].length > 0)
        && new Set(labels).size === labels.length,
        JSON.stringify(labels));
    check('T1 the SAP Router legend label', es.integrationTypeLabel('saprouter') === 'SAP Router',
        es.integrationTypeLabel('saprouter'));
}

// =============================================================================
// T2 — stored type -> IntegrationType
// =============================================================================
{
    const want: Record<string, string> = {
        http: 'web_service',
        rfc: 'rfc',
        hana_audit: 'web_service',
        hana_tenant: 'rfc',
        saprouter: 'saprouter',
    };
    check('T2 the stored types are exactly the five the map knows',
        eq([...SPL_TYPES].sort(), Object.keys(want).sort()), JSON.stringify(SPL_TYPES));
    SPL_TYPES.forEach((t) => {
        const got = es.splTypeToIntegrationType(t);
        check(`T2 stored type ${t} maps onto ${want[t]}`, got === want[t], `got ${got}`);
        check(`T2 stored type ${t} maps onto a listed IntegrationType`, ALL.indexOf(got) !== -1, got);
    });
}

// =============================================================================
// T3 — the right pane's type name and colour token
// =============================================================================
{
    const pre378Tokens: Record<string, string> = {
        http: 'cyanAccent', rfc: 'teal', hana_audit: 'orange', hana_tenant: 'purple',
    };
    Object.keys(pre378Tokens).forEach((t) => {
        check(`T3 the pane keeps its ${t} badge colour`, es.splTypeColorToken(t) === pre378Tokens[t],
            es.splTypeColorToken(t));
    });
    check('T3 unknown types fall back to textMuted', es.splTypeColorToken('nope') === 'textMuted'
        && es.splTypeColorToken(undefined) === 'textMuted', String(es.splTypeColorToken('nope')));
    const pre378Labels: Record<string, string> = {
        http: 'HTTP', rfc: 'RFC', hana_audit: 'HANA Audit', hana_tenant: 'HANA Tenant',
    };
    Object.keys(pre378Labels).forEach((t) => {
        check(`T3 the pane keeps its ${t} name`, es.splTypeLabel(t) === pre378Labels[t], es.splTypeLabel(t));
    });
    check('T3 SAP Router: the pane and the legend use one name',
        es.splTypeLabel('saprouter') === 'SAP Router'
        && es.splTypeLabel('saprouter') === es.integrationTypeLabel(es.splTypeToIntegrationType('saprouter')),
        es.splTypeLabel('saprouter'));
    check('T3 SAP Router: the pane badge reads SAPROUTER_EDGE_TOKEN',
        es.splTypeColorToken('saprouter') === es.SAPROUTER_EDGE_TOKEN,
        `${es.splTypeColorToken('saprouter')} vs ${es.SAPROUTER_EDGE_TOKEN}`);
    (['light', 'dark'] as const).forEach((mode) => {
        const tok = mt.MODE_TOKENS[mode];
        check(`T3 SAP Router (${mode}): the canvas edge and the pane badge are one colour`,
            es.edgeColor('saprouter', tok) === tok[es.splTypeColorToken('saprouter')]
            && typeof tok[es.SAPROUTER_EDGE_TOKEN] === 'string',
            `${es.edgeColor('saprouter', tok)} vs ${tok[es.splTypeColorToken('saprouter')]}`);
        check(`T3 (${mode}) no listed type falls back to the unknown-type grey`,
            ALL.every((t) => es.edgeColor(t, tok) !== tok.textMuted),
            ALL.filter((t) => es.edgeColor(t, tok) === tok.textMuted).join(', '));
        check(`T3 (${mode}) every stored type has a badge colour other than grey`,
            SPL_TYPES.every((t) => tok[es.splTypeColorToken(t)] !== tok.textMuted),
            SPL_TYPES.filter((t) => tok[es.splTypeColorToken(t)] === tok.textMuted).join(', '));
    });
    check('T3 a SAP Router traffic row on the Hosts tab is named SAP Router',
        (() => {
            const rows = pf.buildNodeTraffic(
                [{
                    retargetedSource: 'R', retargetedTarget: 'X', splType: 'saprouter', direction: 'client',
                    rows: [{ source_id: 'r1', target_id: 't1', call_count: 3, error_count: 1 }],
                }],
                (id: string) => (id === 'r1' ? { kind: 'saprouter', value: 'hec53v013858' }
                    : { kind: 'ip', value: '10.186.75.230' }),
            );
            const r = rows.R && rows.R[0];
            return !!r && r.scope === 'type' && r.key === 'saprouter' && es.splTypeLabel(r.key) === 'SAP Router';
        })(),
        'a router node must yield an edge-type row, never a host row');
}

// =============================================================================
// T4 — the SAP Router colour is legible, in both modes
// =============================================================================
{
    /* The absolute floor of gate 3o's palette check (session 129): below the
     * Harbor palette's own base separation, so it still catches a colour that
     * genuinely collides. */
    const FLOOR = 40;
    const KNOWN_COLLISIONS = [['trfc', 'btp_iflow']]; // light-mode orangeLight == yellow (pre-378)
    const isKnown = (a: string, b: string): boolean => KNOWN_COLLISIONS
        .some(([x, y]) => (a === x && b === y) || (a === y && b === x));
    (['light', 'dark'] as const).forEach((mode) => {
        const tok = mt.MODE_TOKENS[mode];
        const sap = es.edgeColor('saprouter', tok);
        const others = ALL.filter((t) => t !== 'saprouter');
        const nearest = others
            .map((t) => ({ t, d: pf.colorDistance(sap, es.edgeColor(t, tok)) }))
            .sort((a, b) => a.d - b.d)[0];
        const otherColors = others.map((t) => es.edgeColor(t, tok));
        const baseMin = pf.minPairwiseDistance(otherColors);
        check(`T4 (${mode}) SAP Router is far from every other legend colour`,
            nearest.d >= Math.max(FLOOR, baseMin) - 1e-6,
            `nearest ${nearest.t} at ${nearest.d.toFixed(1)} (floor ${FLOOR}, legend's own min ${baseMin.toFixed(1)})`);
        check(`T4 (${mode}) adding SAP Router does not make the legend less discriminable`,
            pf.minPairwiseDistance(otherColors.concat([sap])) >= baseMin - 1e-6,
            `${pf.minPairwiseDistance(otherColors.concat([sap])).toFixed(1)} < ${baseMin.toFixed(1)}`);
        const meaning: Record<string, string> = {
            red: 'the health ring\'s error segment',
            green: 'the health ring\'s normal segment',
            orange: 'the health ring\'s warning segment / the HANA Audit badge',
            cyanLight: 'the selected-edge stroke',
            textMuted: 'the unknown-type grey',
            cyanAccent: 'the HTTP badge',
            teal: 'the RFC badge',
            purple: 'the HANA Tenant badge',
        };
        Object.keys(meaning).forEach((k) => {
            const d = pf.colorDistance(sap, tok[k]);
            check(`T4 (${mode}) SAP Router is not confusable with ${meaning[k]}`, d >= FLOOR,
                `${k} at ${d.toFixed(1)}`);
        });
        ['pageBackground', 'panelBackground'].forEach((bg) => {
            const d = pf.colorDistance(sap, tok[bg]);
            check(`T4 (${mode}) SAP Router edges stand out from the ${bg}`, d >= 3 * FLOOR, `${d.toFixed(1)}`);
        });
        // Every pair of legend colours other than the known collision stays separable.
        const bad: string[] = [];
        ALL.forEach((a, i) => ALL.slice(i + 1).forEach((b) => {
            const d = pf.colorDistance(es.edgeColor(a, tok), es.edgeColor(b, tok));
            if (d < FLOOR && !isKnown(a, b)) bad.push(`${a}/${b} ${d.toFixed(1)}`);
        }));
        check(`T4 (${mode}) no legend collision beyond the known trfc / btp_iflow pair`, bad.length === 0,
            bad.join(', '));
    });
    const lightKnown = pf.colorDistance(es.edgeColor('trfc', mt.MODE_TOKENS.light),
        es.edgeColor('btp_iflow', mt.MODE_TOKENS.light));
    console.log(`topologyTypes.consistency-test: note - the pre-378 light-mode legend collision trfc / btp_iflow is at ${
        lightKnown.toFixed(1)} (neither type is produced by any rollup arm)`);
}

// =============================================================================
// T5 — the saved-layout union rule (restoreEnabledTypes)
// =============================================================================
{
    const R = ps.restoreEnabledTypes;
    check('T5a a pre-378 layout keeps the new type enabled',
        eq(R(['rfc', 'web_service'], undefined, ALL), ['rfc', 'web_service', 'saprouter']),
        JSON.stringify(R(['rfc', 'web_service'], undefined, ALL)));
    check('T5b a pre-378 layout with all eight on gets all nine',
        eq(R(LEGACY_EXPECTED, undefined, ALL), ALL), JSON.stringify(R(LEGACY_EXPECTED, undefined, ALL)));
    check('T5c a layout that knew saprouter and switched it off keeps it off',
        eq(R(['rfc'], ALL, ALL), ['rfc']), JSON.stringify(R(['rfc'], ALL, ALL)));
    check('T5d a layout that knew saprouter and kept it on keeps it on',
        eq(R(['saprouter', 'rfc'], ALL, ALL), ['rfc', 'saprouter']), JSON.stringify(R(['saprouter', 'rfc'], ALL, ALL)));
    check('T5e no recorded filter leaves the live one (null)',
        R(undefined, undefined, ALL) === null && R(null, ALL, ALL) === null && R([], ALL, ALL) === null,
        'an absent or empty saved list must not clear the filter (pre-378 behaviour)');
    check('T5f a retired name is dropped, the new type still added',
        eq(R(['rfc', 'retired_type'], undefined, ALL), ['rfc', 'saprouter']),
        JSON.stringify(R(['rfc', 'retired_type'], undefined, ALL)));
    check('T5g the result follows the display order, not the saved order',
        eq(R(['web_service', 'rfc'], undefined, ALL), ['rfc', 'web_service', 'saprouter']),
        JSON.stringify(R(['web_service', 'rfc'], undefined, ALL)));
    check('T5h an empty knownTypes is read as the frozen eight',
        eq(R(['rfc'], [], ALL), ['rfc', 'saprouter']), JSON.stringify(R(['rfc'], [], ALL)));
    const FUTURE = ALL.concat(['x_future']);
    check('T5i a later type is enabled on a 378 layout and on a pre-378 one',
        eq(R(['rfc'], ALL, FUTURE), ['rfc', 'x_future'])
        && eq(R(['rfc'], undefined, FUTURE), ['rfc', 'saprouter', 'x_future']),
        `${JSON.stringify(R(['rfc'], ALL, FUTURE))} / ${JSON.stringify(R(['rfc'], undefined, FUTURE))}`);
    check('T5j a pre-378 layout with every box unchecked except an unknown name enables only new types',
        eq(R(['retired_type'], undefined, ALL), ['saprouter']), JSON.stringify(R(['retired_type'], undefined, ALL)));
    check('T5k the rule does not mutate its inputs',
        (() => {
            const saved = ['web_service', 'rfc'];
            const known = ALL.slice();
            R(saved, known, ALL);
            return eq(saved, ['web_service', 'rfc']) && eq(known, ALL);
        })(), 'saved or known list mutated');
}

// =============================================================================
// T6 — retargetEndpoint: the router is never folded into a SID
// =============================================================================
{
    const owner = new Map<string, string>([
        ['hec53v013858', 'XCS'],      // the router host is ALSO an XCS app server (Demo Gen)
        ['10.186.75.230', 'XCI'],     // the sapmsXCI target, attributed by the inventory
        ['10.9.9.9', 'XZZ'],          // owned by a SID that has no node
    ]);
    const sidNode = new Map<string, string>([['XCS', 'n_xcs'], ['XCI', 'n_xci']]);
    const RT = (id: string, c: { kind: string; value: string } | undefined): string =>
        ty.retargetEndpoint(id, c, (v: string) => owner.get(v), (s: string) => sidNode.get(s));
    check('T6a a saprouter endpoint stays itself even when the inventory owns its host name',
        RT('r', { kind: 'saprouter', value: 'hec53v013858' }) === 'r', RT('r', { kind: 'saprouter', value: 'hec53v013858' }));
    check('T6b the same name as kind host IS folded (the rule S2 sidesteps)',
        RT('h', { kind: 'host', value: 'hec53v013858' }) === 'n_xcs', RT('h', { kind: 'host', value: 'hec53v013858' }));
    check('T6c a router target address folds into its SID (T1 + inventory)',
        RT('t', { kind: 'ip', value: '10.186.75.230' }) === 'n_xci', RT('t', { kind: 'ip', value: '10.186.75.230' }));
    check('T6d an unattributed target stays a raw address',
        RT('t2', { kind: 'ip', value: '10.186.74.36' }) === 't2', RT('t2', { kind: 'ip', value: '10.186.74.36' }));
    check('T6e an owner without a node does not retarget',
        RT('t3', { kind: 'ip', value: '10.9.9.9' }) === 't3', RT('t3', { kind: 'ip', value: '10.9.9.9' }));
    check('T6f a sid goes to its node, or stays itself',
        RT('s', { kind: 'sid', value: 'XCI' }) === 'n_xci' && RT('s2', { kind: 'sid', value: 'QQQ' }) === 's2', 'sid');
    check('T6g tenant_db, an unknown kind and no canonical entry stay themselves',
        RT('d', { kind: 'tenant_db', value: 'XCI' }) === 'd'
        && RT('u', { kind: 'mystery', value: '10.186.75.230' }) === 'u'
        && RT('n', undefined) === 'n', 'non-retargetable kinds moved');
}

// =============================================================================
// T7 — clause fields -> canonical kinds
// =============================================================================
{
    const want: [string, string | null][] = [
        ['sap_sid', 'sid'], ['hana_tenant_sid', 'tenant_db'], ['saprouter_host', 'saprouter'],
        ['saprouter_target_ip', 'ip'], ['gw_client_ip', 'ip'], ['peer_ip', 'ip'], ['local_ip', 'ip'],
        ['client_ip', 'ip'], ['clientip', 'ip'], ['host', 'host'], ['hana_host', 'host'],
        ['saprouter_target_sid', null], ['saprouter_fail_target_ip', null], ['', null], ['SAP_SID', null],
    ];
    want.forEach(([f, k]) => {
        check(`T7 clause field "${f}" -> ${String(k)}`, ty.clauseFieldToKind(f) === k, String(ty.clauseFieldToKind(f)));
    });
    check('T7 every kind clauseFieldToKind returns is a CanonicalKind',
        want.every(([f]) => ty.clauseFieldToKind(f) === null || CANON_KINDS.indexOf(ty.clauseFieldToKind(f)) !== -1),
        JSON.stringify(CANON_KINDS));
}

// =============================================================================
// T8 — tags
// =============================================================================
check('T8 saprouter carries the ROUTER tag, tenant_db TENANT, others none',
    ty.fixedTagForKind('saprouter') === 'ROUTER' && ty.fixedTagForKind('tenant_db') === 'TENANT'
    && ['sid', 'ip', 'host', undefined, null, ''].every((k) => ty.fixedTagForKind(k) === null),
    `${ty.fixedTagForKind('saprouter')} / ${ty.fixedTagForKind('tenant_db')}`);
check('T8 ROUTER renders as SAP ROUTER (chip and full form)',
    ty.displayTag('ROUTER') === 'SAP ROUTER' && ty.displayTag('ROUTER', { short: true }) === 'SAP ROUTER',
    ty.displayTag('ROUTER'));
check('T8 refineTag leaves the fixed tags alone, and only those',
    ty.isFixedTag('ROUTER') && ty.isFixedTag('TENANT') && !ty.isFixedTag('EXT') && !ty.isFixedTag('HANA'),
    'isFixedTag');
check('T8 ROUTER is a SystemTag and not a database tag',
    SYSTEM_TAGS.indexOf('ROUTER') !== -1 && ty.isDatabaseTag('ROUTER') === false, JSON.stringify(SYSTEM_TAGS));
check('T8 the earlier tags still render as before',
    ty.displayTag('HANA') === 'HANA SYSTEM' && ty.displayTag('TENANT', { short: true }) === 'HANA TENANT'
    && ty.displayTag('EXT') === 'EXT', 'displayTag drifted');

// =============================================================================
// T9 — Edge Details nouns per stored type
// =============================================================================
{
    const pre = {
        unit: 'calls', countRow: 'Calls in window', errorRow: 'Errors in window',
        perHourCaption: 'Calls + errors per hour', okLegend: 'Successful calls', errLegend: 'Errors',
    };
    check('T9 HTTP keeps its pre-378 text', eq(es.edgeMeasureLabels('http'), pre), JSON.stringify(es.edgeMeasureLabels('http')));
    check('T9 HANA Tenant keeps its pre-378 text', eq(es.edgeMeasureLabels('hana_tenant'), pre),
        JSON.stringify(es.edgeMeasureLabels('hana_tenant')));
    check('T9 an unknown type reads as calls', eq(es.edgeMeasureLabels(undefined), pre), JSON.stringify(es.edgeMeasureLabels(undefined)));
    check('T9 HANA Audit keeps "Auth failures (CONNECT)"',
        eq(es.edgeMeasureLabels('hana_audit'), Object.assign({}, pre, { errorRow: 'Auth failures (CONNECT)' })),
        JSON.stringify(es.edgeMeasureLabels('hana_audit')));
    const rfc = es.edgeMeasureLabels('rfc');
    check('T9 an RFC edge counts connections (the gateway trace records no calls)',
        rfc.unit === 'connections' && /connection/i.test(rfc.countRow) && /broken/i.test(rfc.errorRow)
        && !/\bcalls?\b/i.test(JSON.stringify(rfc)), JSON.stringify(rfc));
    const sr = es.edgeMeasureLabels('saprouter');
    check('T9 a SAP Router edge counts routed and failed connections',
        sr.unit === 'routed connections' && sr.errorRow === 'Failed connections'
        && /routed/i.test(sr.countRow) && !/\bcalls?\b/i.test(JSON.stringify(sr)), JSON.stringify(sr));
    // The Edge Details Operations donut (TopologyRightSidebar) prints the edge's
    // unit in its wedge hover text and the unit's last word under its centre
    // total - the 64 px hole fits one short word at 9 px. Gate 3tu pins the
    // call site; these pin the word.
    const centreCases: [string, string][] = [
        ['calls', 'calls'], ['connections', 'connections'], ['routed connections', 'connections'],
        ['  routed   connections ', 'connections'], ['', 'calls'], ['   ', 'calls'],
    ];
    check('T9 donutCentreUnit keeps the unit\'s last word',
        centreCases.every(([u, w]) => es.donutCentreUnit(u) === w),
        centreCases.map(([u]) => `${JSON.stringify(u)} -> ${JSON.stringify(es.donutCentreUnit(u))}`).join(', '));
    const centres = SPL_TYPES.concat([undefined as unknown as string])
        .map((t) => es.donutCentreUnit(es.edgeMeasureLabels(t).unit) as string);
    check('T9 every edge type\'s donut centre word is one short word',
        centres.every((c) => /^[a-z]{1,11}$/.test(c)), centres.join(', '));
    check('T9 an RFC or SAP Router Operations donut centre never reads "calls"',
        es.donutCentreUnit(rfc.unit) === 'connections' && es.donutCentreUnit(sr.unit) === 'connections'
        && es.donutCentreUnit(es.edgeMeasureLabels('http').unit) === 'calls',
        `rfc ${es.donutCentreUnit(rfc.unit)}, saprouter ${es.donutCentreUnit(sr.unit)}`);
    // Build 380: the node pane's partner donuts add up all of one direction's
    // edges, so their unit comes from all of its types (combinedMeasureUnit).
    // Gate 3tu (h) pins the call sites; these pin the words.
    const mixCases: [(string | undefined)[], string, string][] = [
        [[], 'calls', 'calls'], [[''], 'calls', 'calls'], [[undefined], 'calls', 'calls'],
        [['http'], 'calls', 'calls'], [['hana_audit', 'http', 'hana_tenant'], 'calls', 'calls'],
        [['rfc'], 'connections', 'connections'], [['saprouter'], 'routed connections', 'connections'],
        [['rfc', 'saprouter'], 'connections', 'connections'],
        [['http', 'rfc'], 'calls + connections', 'total'], [['', 'saprouter'], 'calls + connections', 'total'],
    ];
    check('T9 combinedMeasureUnit names what a node pane donut counts',
        mixCases.every(([ts, u, c]) => {
            const m = es.combinedMeasureUnit(ts);
            return m.unit === u && m.centre === c;
        }),
        mixCases.map(([ts]) => `${JSON.stringify(ts)} -> ${JSON.stringify(es.combinedMeasureUnit(ts))}`).join(', '));
    const pairCentres: string[] = [];
    SPL_TYPES.forEach((a: string) => SPL_TYPES.forEach((b: string) => {
        pairCentres.push(es.combinedMeasureUnit([a, b]).centre);
    }));
    check('T9 every pair of edge types still gives one short centre word',
        pairCentres.every((c) => /^[a-z]{1,11}$/.test(c)), Array.from(new Set(pairCentres)).join(', '));
}

// =============================================================================
// T10 — Operations / Performance captions
// =============================================================================
{
    check('T10 Operations captions: the older types unchanged',
        es.edgeOperationsNoun('http') === 'URIs' && es.edgeOperationsNoun('hana_audit') === 'action types'
        && es.edgeOperationsNoun('hana_tenant') === 'trace components' && es.edgeOperationsNoun('x') === 'entities',
        'drifted');
    check('T10 Operations: RFC names remote services / client programs, SAP Router target services',
        es.edgeOperationsNoun('rfc') === 'remote services / client programs'
        && es.edgeOperationsNoun('saprouter') === 'target services',
        `${es.edgeOperationsNoun('rfc')} / ${es.edgeOperationsNoun('saprouter')}`);
    check('T10 Performance captions: the older types unchanged',
        es.edgePerformanceCaption('http') === 'Status class distribution'
        && es.edgePerformanceCaption('hana_audit') === 'Action status mix'
        && es.edgePerformanceCaption('hana_tenant') === 'hdbcons command duration (avg + max)'
        && es.edgePerformanceCaption('x') === 'Distribution', 'drifted');
    check('T10 Performance: RFC connection record mix, SAP Router target role mix',
        es.edgePerformanceCaption('rfc') === 'Connection record mix'
        && es.edgePerformanceCaption('saprouter') === 'Target role mix',
        `${es.edgePerformanceCaption('rfc')} / ${es.edgePerformanceCaption('saprouter')}`);
    const rfcText = `${es.edgeOperationsNoun('rfc')} ${es.edgePerformanceCaption('rfc')}`;
    check('T10 the RFC captions no longer name icm_tasks or ABAP programs (the build-240 leftovers)',
        !/icm_tasks|icm_program|ABAP programs/i.test(rfcText), rfcText);
    const all = SPL_TYPES.concat([undefined as unknown as string]).map((t) => JSON.stringify([
        es.edgeMeasureLabels(t), es.edgeOperationsNoun(t), es.edgePerformanceCaption(t), es.splTypeLabel(t),
    ])).join(' ') + ALL.map((t) => es.integrationTypeLabel(t)).join(' ');
    check('T10 no app version in any of these user-visible strings',
        !/\bv?\d+\.\d+\.\d+|\bbuild\s*\d+/i.test(all), 'a version or build number reached the UI text');
}

// =============================================================================
// T11 — failureRate
// =============================================================================
{
    const cases: [number, number, number][] = [
        [10, 5, 0.5], [10, 20, 1], [0, 3, 1], [0, 0, 0], [5, 0, 0], [5, -1, 0], [4, 4, 1],
    ];
    cases.forEach(([t, e, w]) => {
        const got = es.failureRate(t, e);
        check(`T11 failureRate(${t}, ${e}) = ${w}`, Number.isFinite(got) && Math.abs(got - w) < 1e-12, String(got));
    });
}

// =============================================================================
// T12 — the shipped topology conf only emits what the UI knows
// =============================================================================
{
    const confPath = path.resolve(HOME, '../../../resources/splunk/default/savedsearches.conf');
    const conf = fs.readFileSync(confPath, 'utf8').replace(/\r\n/g, '\n');
    const stanzas: Record<string, string> = {};
    let current: string | null = null;
    conf.split('\n').forEach((line: string) => {
        const m = /^\[(.+)\]\s*$/.exec(line.trim());
        if (m) {
            current = m[1];
            stanzas[current] = '';
            return;
        }
        if (current && !line.trim().startsWith('#')) stanzas[current] += `${line}\n`;
    });
    const EDGES = ['logserv_topology_aggregate_edges', 'logserv_topology_backfill_edges'];
    const NODES = ['logserv_topology_aggregate_nodes', 'logserv_topology_backfill_nodes'];
    const INV = ['logserv_topology_aggregate_inventory', 'logserv_topology_backfill_inventory'];
    const missing = EDGES.concat(NODES, INV).filter((n) => stanzas[n] === undefined);
    check('T12 the topology stanzas exist', missing.length === 0, missing.join(', '));
    const collect = (names: string[], re: RegExp): Set<string> => {
        const out = new Set<string>();
        names.forEach((n) => {
            const body = stanzas[n] || '';
            const r = new RegExp(re.source, 'g');
            let m: RegExpExecArray | null;
            while ((m = r.exec(body)) !== null) out.add(m[1]);
        });
        return out;
    };
    const types = collect(EDGES, /\btype\s*=\s*"([a-z_]+)"/);
    const kinds = collect(EDGES, /\b(?:source|target)_kind\s*=\s*"([a-z_]+)"/);
    const fields = collect(EDGES, /\\"field\\":\\"([A-Za-z0-9_]+)\\"/);
    const nodeKinds = collect(NODES.concat(INV), /\bcanonical_kind\s*=\s*"([a-z_]+)"/);
    const tagCase = collect(NODES, /\beval tag\s*=\s*case\(([^|]*)/);
    const tags = new Set<string>();
    tagCase.forEach((c) => {
        const r = /"([A-Z][A-Z0-9_]*)"/g;
        let m: RegExpExecArray | null;
        while ((m = r.exec(c)) !== null) tags.add(m[1]);
    });
    check('T12 the edge stanzas emit literal types', types.size >= 4, Array.from(types).join(', '));
    const unknownTypes = Array.from(types).filter((t) => SPL_TYPES.indexOf(t) === -1);
    check('T12 every stored edge type is one the UI maps', unknownTypes.length === 0,
        `${unknownTypes.join(', ')} — the canvas would draw it as RFC and the pane would name it raw`);
    const unknownKinds = Array.from(kinds).concat(Array.from(nodeKinds)).filter((k) => CANON_KINDS.indexOf(k) === -1);
    check('T12 every stored endpoint / node kind is a CanonicalKind', unknownKinds.length === 0, unknownKinds.join(', '));
    const unknownFields = Array.from(fields).filter((f) => ty.clauseFieldToKind(f) === null);
    check('T12 every literal clause field is classified by clauseFieldToKind', unknownFields.length === 0,
        `${unknownFields.join(', ')} — an endpoint without a node row would lose its kind`);
    const unknownTags = Array.from(tags).filter((t) => SYSTEM_TAGS.indexOf(t) === -1);
    check('T12 every node tag the nodes arms store is a SystemTag', tags.size > 0 && unknownTags.length === 0,
        `${unknownTags.join(', ')} (read ${Array.from(tags).join(', ')})`);
    if (types.has('saprouter')) {
        check('T12 the saprouter arm stores a saprouter source and an ip target',
            kinds.has('saprouter') && kinds.has('ip') && fields.has('saprouter_host') && fields.has('saprouter_target_ip'),
            `kinds ${Array.from(kinds).join(', ')}; fields ${Array.from(fields).join(', ')}`);
    }
    if (nodeKinds.has('saprouter')) {
        check('T12 a saprouter node row carries the ROUTER tag', tags.has('ROUTER'), Array.from(tags).join(', '));
    }
    console.log(`topologyTypes.consistency-test: conf emits types [${Array.from(types).sort().join(', ')}], kinds [${
        Array.from(new Set(Array.from(kinds).concat(Array.from(nodeKinds)))).sort().join(', ')}], tags [${
        Array.from(tags).sort().join(', ')}]`);
}

/* ===================================================================== */

if (ttFailures > 0) {
    ttProc.stderr.write(`\ntopologyTypes.consistency-test: ${ttFailures} failure(s) of ${ttChecks}\n`);
    ttProc.exit(1);
}
console.log(`topologyTypes.consistency-test: OK (${ttChecks} checks)`);
