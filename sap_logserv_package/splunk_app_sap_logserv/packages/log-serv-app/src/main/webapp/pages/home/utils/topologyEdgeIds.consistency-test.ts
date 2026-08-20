/**
 * Build-time consistency test for the topology EDGE IDENTITY contract
 * (build 321, session 107).
 *
 * The bug this pins: from build 240 to build 320 the Edge Details tabs
 * dispatched nothing, because `useEdgeData` passed the composite DISPLAY id
 * ("<src>::<tgt>::<type>") to SPL builders whose sanitizer only accepts the
 * STORED id (sha1[:16] hex). Every read returned null, `useSearch` was
 * disabled, and the pane asserted "no events for this edge".
 *
 * Two halves have to stay in agreement forever:
 *   - what `useTopologyData` CARRIES onto an edge (`collectBucketIds`, from
 *     the KV row's `id`), and
 *   - what the SPL builders ACCEPT (`sanitizeEdgeIds`).
 * The behavioural half lives here; the conf-derived half (the stored id's real
 * shape and length, parsed out of savedsearches.conf) is section 3m of
 * bin/check-diagnostics.js, so neither can drift alone.
 *
 * Run standalone with: `yarn check:diagnostics`
 */

/* eslint-disable no-console */

// Standalone script, not a module — see session-085 sticky #4.
export {};

const tProc = process as unknown as {
    stderr: { write(s: string): void };
    exit(code: number): never;
};

/* eslint-disable @typescript-eslint/no-explicit-any */
const idMod = require('../topology/edgeIds') as any;
const searchMod = require('../topology/searches') as any;
/* eslint-enable @typescript-eslint/no-explicit-any */

const collectBucketIds = idMod.collectBucketIds as (rows: { id?: string }[]) => string[];
const sanitizeEdgeIds = idMod.sanitizeEdgeIds as (
    ids: readonly string[] | null | undefined,
) => { ids: string[]; truncated: boolean; requested: number } | null;
const edgeDisplayId = idMod.edgeDisplayId as (s: string, t: string, ty: string) => string;
const edgeIdClause = idMod.edgeIdClause as (f: string, ids: readonly string[]) => string;
const MAX_EDGE_IDS = idMod.MAX_EDGE_IDS as number;
const EDGE_ID_HEX_LEN = idMod.EDGE_ID_HEX_LEN as number;

type Builder = (splType: string, ids: readonly string[] | null | undefined) => string | null;
const BUILDERS: { name: string; fn: Builder }[] = [
    { name: 'SEARCH_EDGE_OPERATIONS', fn: searchMod.SEARCH_EDGE_OPERATIONS },
    { name: 'SEARCH_EDGE_PERFORMANCE', fn: searchMod.SEARCH_EDGE_PERFORMANCE },
    { name: 'SEARCH_EDGE_ERRORS', fn: searchMod.SEARCH_EDGE_ERRORS },
];
const SPL_TYPES = ['http', 'rfc', 'hana_audit', 'hana_tenant'];

let tFailures = 0;
let tChecks = 0;
const tCheck = (label: string, ok: boolean, detail: string): void => {
    tChecks += 1;
    if (!ok) {
        tFailures += 1;
        tProc.stderr.write(`FAIL: ${label}: ${detail}\n`);
    }
};

/** A valid stored id of exactly the shipped length. */
const hex = (seed: string): string =>
    (seed.repeat(EDGE_ID_HEX_LEN)).slice(0, EDGE_ID_HEX_LEN);
const ID_A = hex('a1b2c3d4e5f60789');
const ID_B = hex('0f1e2d3c4b5a6978');

// =============================================================================
// G1 — collectBucketIds reads `id`, NOT `_key`.
// `_key` is `id . ":" . bucket_ts`; carrying it reproduces the build-240 bug
// exactly (the sanitizer rejects the colon and all three tabs go silent).
// =============================================================================
{
    const rows = [{ _key: `${ID_A}:1699999200`, id: ID_A } as { _key: string; id: string }];
    const got = collectBucketIds(rows);
    tCheck('G1 collectBucketIds returns row.id', got.length === 1 && got[0] === ID_A, JSON.stringify(got));
    tCheck('G1 the value it returns is accepted by the sanitizer',
        sanitizeEdgeIds(got) !== null, 'sanitizer rejected what the collector produced');
    // The mutation this kills: `.map(r => r._key)`.
    tCheck('G1 a _key-shaped value would be REJECTED (so the mutation cannot pass)',
        sanitizeEdgeIds([`${ID_A}:1699999200`]) === null, 'the _key form was accepted');
}

// =============================================================================
// G2 — order independence: the derived SPL is byte-identical whichever order
// the KV fetch happened to return the rows in. `useSearch` keys its dispatch
// effect on the query STRING, so an unsorted array churns re-dispatches.
// =============================================================================
{
    const fwd = collectBucketIds([{ id: ID_A }, { id: ID_B }]);
    const rev = collectBucketIds([{ id: ID_B }, { id: ID_A }]);
    tCheck('G2 collectBucketIds is order-independent', JSON.stringify(fwd) === JSON.stringify(rev),
        `${JSON.stringify(fwd)} vs ${JSON.stringify(rev)}`);
    BUILDERS.forEach((b) => {
        const a = b.fn('http', fwd);
        const c = b.fn('http', rev);
        tCheck(`G2 ${b.name} emits the same SPL for either order`, a === c && a !== null, 'differs or null');
    });
    const selFwd = sanitizeEdgeIds([ID_B, ID_A]);
    tCheck('G2 sanitizeEdgeIds also sorts',
        !!selFwd && JSON.stringify(selFwd.ids) === JSON.stringify(fwd), JSON.stringify(selFwd));
}

// =============================================================================
// G3 — dedupe: one edge has many hourly buckets, all carrying the same id.
// =============================================================================
{
    const got = collectBucketIds([{ id: ID_A }, { id: ID_A }, { id: ID_A }]);
    tCheck('G3 repeated bucket rows collapse to one id', got.length === 1, JSON.stringify(got));
    const sel = sanitizeEdgeIds([ID_A, ID_A]);
    tCheck('G3 sanitizeEdgeIds dedupes too', !!sel && sel.ids.length === 1 && sel.requested === 1,
        JSON.stringify(sel));
}

// =============================================================================
// G4 — the cap is enforced AND reported. A silently-capped tab total sitting
// under a full-window headline is a wrong number presented as fact.
// =============================================================================
{
    const many: string[] = [];
    for (let i = 0; i < MAX_EDGE_IDS + 1; i += 1) {
        many.push(i.toString(16).padStart(EDGE_ID_HEX_LEN, '0'));
    }
    const sel = sanitizeEdgeIds(many);
    tCheck('G4 cap applied', !!sel && sel.ids.length === MAX_EDGE_IDS, `${sel && sel.ids.length}`);
    tCheck('G4 truncation REPORTED', !!sel && sel.truncated === true, `${sel && sel.truncated}`);
    tCheck('G4 requested carries the true total', !!sel && sel.requested === MAX_EDGE_IDS + 1,
        `${sel && sel.requested}`);
    const under = sanitizeEdgeIds(many.slice(0, MAX_EDGE_IDS));
    tCheck('G4 exactly at the cap is NOT flagged truncated',
        !!under && under.truncated === false && under.ids.length === MAX_EDGE_IDS, JSON.stringify(under && under.truncated));
}

// =============================================================================
// G5 — FAIL CLOSED. One bad element rejects the whole selection: a partial
// total is indistinguishable from a real one, and the only realistic cause of
// an invalid id is that the wrong field was carried (the bug itself).
// =============================================================================
{
    tCheck('G5 mixed valid+invalid is rejected outright', sanitizeEdgeIds([ID_A, 'nope']) === null, 'accepted');
    BUILDERS.forEach((b) => {
        tCheck(`G5 ${b.name} returns null on a mixed set`, b.fn('http', [ID_A, 'nope']) === null, 'built a query');
    });
    tCheck('G5 uppercase hex is rejected (sha1 output is lowercase)',
        sanitizeEdgeIds([ID_A.toUpperCase()]) === null, 'accepted uppercase');
    tCheck('G5 short id rejected', sanitizeEdgeIds([ID_A.slice(0, EDGE_ID_HEX_LEN - 1)]) === null, 'accepted short');
    tCheck('G5 long id rejected', sanitizeEdgeIds([`${ID_A}0`]) === null, 'accepted long');
}

// =============================================================================
// G6 — the DISPLAY id is rejected, DERIVED from its real producer rather than
// restated as a literal. Changing the separator without updating edgeDisplayId
// must not quietly make the composite acceptable.
// =============================================================================
{
    const display = edgeDisplayId(ID_A, ID_B, 'http');
    tCheck('G6 the display id is not a stored id', sanitizeEdgeIds([display]) === null, display);
    BUILDERS.forEach((b) => {
        tCheck(`G6 ${b.name} refuses the display id`, b.fn('http', [display]) === null, 'built a query');
    });
    // The real-world shape: retargeted endpoints are themselves sha1[:16].
    tCheck('G6 display id embeds both endpoints and the type',
        display.indexOf(ID_A) === 0 && display.indexOf('http') > 0, display);
}

// =============================================================================
// G7 — empty / absent input dispatches nothing.
// =============================================================================
{
    tCheck('G7 empty array -> null', sanitizeEdgeIds([]) === null, 'accepted');
    tCheck('G7 undefined -> null', sanitizeEdgeIds(undefined) === null, 'accepted');
    tCheck('G7 null -> null', sanitizeEdgeIds(null) === null, 'accepted');
    BUILDERS.forEach((b) => {
        tCheck(`G7 ${b.name} null on empty`, b.fn('http', []) === null, 'built a query');
        tCheck(`G7 ${b.name} null on undefined`, b.fn('http', undefined) === null, 'built a query');
    });
}

// =============================================================================
// G8 — every builder x every splType splices EVERY id, as an equality
// disjunction (not `IN`), and hana_tenant takes the Avg+Max branch.
// =============================================================================
{
    SPL_TYPES.forEach((ty) => {
        BUILDERS.forEach((b) => {
            const spl = b.fn(ty, [ID_A, ID_B]);
            tCheck(`G8 ${b.name}/${ty} builds`, typeof spl === 'string' && spl.length > 0, `${spl}`);
            if (typeof spl !== 'string') return;
            tCheck(`G8 ${b.name}/${ty} contains id A`, spl.indexOf(`"${ID_A}"`) > 0, 'missing');
            tCheck(`G8 ${b.name}/${ty} contains id B`, spl.indexOf(`"${ID_B}"`) > 0, 'missing');
            tCheck(`G8 ${b.name}/${ty} uses the OR form`, spl.indexOf(' OR ') > 0, 'no disjunction');
            tCheck(`G8 ${b.name}/${ty} avoids IN(`, spl.indexOf(' IN (') === -1, 'used IN');
            tCheck(`G8 ${b.name}/${ty} scopes the bucket range`, spl.indexOf('bucket_ts') > 0, 'no range filter');
        });
    });
    const tenant = searchMod.SEARCH_EDGE_PERFORMANCE('hana_tenant', [ID_A]) as string;
    const http = searchMod.SEARCH_EDGE_PERFORMANCE('http', [ID_A]) as string;
    tCheck('G8 hana_tenant Performance reads the duration branch',
        tenant.indexOf('sum_dur') > 0 && tenant.indexOf('max_dur') > 0, 'wrong branch');
    tCheck('G8 non-tenant Performance reads the histogram branch',
        http.indexOf('bucket_label') > 0 && http.indexOf('sum_dur') === -1, 'wrong branch');
    tCheck('G8 edgeIdClause parenthesises the disjunction',
        edgeIdClause('scope', [ID_A, ID_B]) === `(scope="${ID_A}" OR scope="${ID_B}")`,
        edgeIdClause('scope', [ID_A, ID_B]));
    tCheck('G8 a single id needs no OR',
        edgeIdClause('id', [ID_A]) === `(id="${ID_A}")`, edgeIdClause('id', [ID_A]));
}

/* G13/G14 (the source pins for the two call sites that carry the id, and the
 * node-label / edge-object asymmetry) live in bin/check-diagnostics.js section
 * 3m: this file is typechecked by the webapp tsconfig, which has no Node
 * types, and every other source pin in this project already lives in the JS
 * gate. */

if (tFailures > 0) {
    tProc.stderr.write(`topologyEdgeIds consistency test: ${tFailures} FAILURE(S) in ${tChecks} checks\n`);
    tProc.exit(1);
}
console.log(`topologyEdgeIds consistency test: ${tChecks} checks OK`);
