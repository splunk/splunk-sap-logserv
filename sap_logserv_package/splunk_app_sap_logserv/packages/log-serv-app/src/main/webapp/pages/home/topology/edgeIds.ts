/* ============================================================================
 * topology/edgeIds.ts — the edge identity contract (build 321, session 107)
 * ============================================================================
 *
 * Two DIFFERENT edge identifiers exist in this view, and conflating them is
 * what broke the Edge Details tabs from build 240 to build 320:
 *
 *   1. The DISPLAY id — `edgeDisplayId(source, target, type)` — is the key of
 *      a *rendered* edge. Inventory retargeting (useTopologyData) can collapse
 *      several stored edges onto one rendered edge, so this id is a composite
 *      of the RETARGETED endpoints. It is the ReactFlow edge key, the
 *      selection key and the persisted `selectedEdgeId`. It is NOT a storage
 *      key and must never reach SPL.
 *
 *   2. The STORAGE ids — `TopologyEdge.bucketIds` — are the
 *      `logserv_topology_edges.id` values (also `logserv_topology_detail_rollup.scope`)
 *      whose hourly buckets compose that rendered edge. Both are
 *      `substr(sha1(source_id . ":" . target_id . ":" . type), 1, 16)` in
 *      savedsearches.conf, i.e. lowercase hex of a fixed length. A rendered
 *      edge maps to a SET of them, not to one.
 *
 * The build gate (bin/check-diagnostics.js section 3m) derives EDGE_ID_HEX_LEN
 * from the shipped conf and asserts that `sanitizeEdgeIds` accepts exactly
 * that shape, and that a value produced by `edgeDisplayId` is rejected — so
 * the two forms cannot silently drift back together.
 *
 * This module has ZERO imports on purpose: the gate loads it directly.
 * ============================================================================ */

/** Separator between the composite display id's parts. Kept here (not inline
 *  at the call site) so the gate can derive a rejection fixture from the real
 *  producer instead of restating the literal. */
export const EDGE_DISPLAY_ID_SEP = '::';

/**
 * The key of a RENDERED edge: retargeted source, retargeted target and the
 * canonical SPL edge type. Stable across renders for the same logical edge
 * regardless of which hourly buckets are in scope — which is why it is the
 * ReactFlow key and the persisted selection — and deliberately NOT a valid
 * storage key (see the sanitizer below).
 */
export const edgeDisplayId = (
    source: string,
    target: string,
    type: string,
): string => `${source}${EDGE_DISPLAY_ID_SEP}${target}${EDGE_DISPLAY_ID_SEP}${type}`;

/** Length of the stored edge id: `substr(sha1(...), 1, 16)` in
 *  [logserv_topology_aggregate_edges] and the detail aggregate's edge arms.
 *  Gate section 3m parses that literal out of the shipped conf and fails the
 *  build if it stops matching this constant. */
export const EDGE_ID_HEX_LEN = 16;

/** The stored-id whitelist, derived from EDGE_ID_HEX_LEN so the gate has a
 *  single number to check. Lowercase hex only — sha1 output is lowercase. */
export const EDGE_ID_RE = new RegExp(`^[0-9a-f]{${EDGE_ID_HEX_LEN}}$`);

/** Upper bound on how many stored ids get spliced into one read. Reached only
 *  if inventory retargeting collapses this many distinct stored edges onto one
 *  rendered edge; when it IS reached the caller is told (`truncated`) and the
 *  UI says so, because a silently-capped total under a full-window headline is
 *  a wrong number presented as fact. */
export const MAX_EDGE_IDS = 500;

export interface EdgeIdSelection {
    /** Sanitized, de-duplicated, sorted. At most MAX_EDGE_IDS entries. */
    ids: string[];
    /** True when `requested` exceeded MAX_EDGE_IDS and `ids` is a prefix. */
    truncated: boolean;
    /** How many distinct stored ids the rendered edge actually spans. */
    requested: number;
}

/**
 * Minimal shape of a `logserv_topology_edges` bucket row for id collection.
 * Deliberately structural so the gate can exercise this without importing the
 * hook's private interface.
 */
export interface EdgeIdBearingRow {
    id?: string;
}

/**
 * Collect the distinct stored ids composing a rendered edge.
 *
 * Reads `row.id` — NOT `row._key`, which is `id . ":" . bucket_ts` and would
 * be rejected by the sanitizer, silently emptying all three tabs (that is
 * precisely the build-240 failure, so the gate mutation-tests this line).
 * Sorted because the derived SPL string is what `useSearch` keys its dispatch
 * on: the KV fetch issues no `sort` parameter, so row order is unspecified and
 * an unsorted array would churn re-dispatches across renders.
 */
export const collectBucketIds = (rows: readonly EdgeIdBearingRow[]): string[] => {
    const seen = new Set<string>();
    rows.forEach((r) => {
        if (r && typeof r.id === 'string' && r.id) seen.add(r.id);
    });
    return Array.from(seen).sort();
};

/**
 * Validate the stored ids before they are spliced into an `inputlookup ...
 * where` clause.
 *
 * FAIL CLOSED: if ANY element fails the whitelist the whole selection is
 * rejected (null). The only realistic cause of an invalid id is that the wrong
 * field was carried onto the edge — the bug this module exists to prevent —
 * and a partial total is worse than an honest "nothing was queried", because a
 * partial total is indistinguishable from a real one.
 */
export const sanitizeEdgeIds = (
    ids: readonly string[] | null | undefined,
): EdgeIdSelection | null => {
    if (!Array.isArray(ids) || ids.length === 0) return null;
    const seen = new Set<string>();
    for (let i = 0; i < ids.length; i += 1) {
        const id = ids[i];
        if (typeof id !== 'string' || !EDGE_ID_RE.test(id)) return null;
        seen.add(id);
    }
    const all = Array.from(seen).sort();
    return {
        ids: all.slice(0, MAX_EDGE_IDS),
        truncated: all.length > MAX_EDGE_IDS,
        requested: all.length,
    };
};

/**
 * Render a sanitized selection as an SPL disjunction over `field`.
 *
 * Equality-only OR rather than `IN (...)`: every other rollup read in
 * topology/searches.ts uses equality, the `inputlookup ... where` filter
 * language is restricted, and the failure mode of an unsupported operator on
 * some customer build is zero rows — indistinguishable from the bug being
 * fixed. Both forms were verified to agree on splunk-sh-idxr; this one has no
 * version dependency.
 */
export const edgeIdClause = (field: string, ids: readonly string[]): string =>
    `(${ids.map((id) => `${field}="${id}"`).join(' OR ')})`;
