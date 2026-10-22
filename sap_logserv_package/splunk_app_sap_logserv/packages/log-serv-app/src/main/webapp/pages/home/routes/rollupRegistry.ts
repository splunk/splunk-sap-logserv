/**
 * rollupRegistry — the canonical list of dashboard rollups (session 095).
 *
 * Extracted from `RollupBackfillPanel.tsx`, which owned it, because a SECOND
 * consumer now needs it: the Missing-Data Diagnostic traces a cached panel's
 * collection back to the aggregate saved search that populates it, so it can
 * ask whether the SOURCE events exist rather than shrugging at a rollup read
 * that names no sourcetype.
 *
 * Kept as a plain `.ts` module for two reasons: `bin/check-diagnostics.js`
 * resolves relative imports as `.ts` only, so anything a consistency test can
 * reach must not sit in a `.tsx`; and a registry has no business importing
 * React.
 *
 * DO NOT re-list these anywhere else. Session 062 shipped a duplicated rollup
 * list that went stale by two entries (stmap and hostrole) and had to be
 * reconciled by hand.
 */

/** A logical rollup. One entry may span multiple KV collections / aggregate
 *  searches / backfill stanzas (the Environment Topology graph = 3 each, the
 *  beaconing-detection pair = 2 each); single-dashboard rollups are 1 each.
 *  Reconciled exhaustively against default/{savedsearches,collections}.conf in
 *  session 063 — every *_aggregate / *_backfill / logserv_*_rollup collection
 *  appears exactly once below. */
export interface RollupDef {
    /** unique id used to key per-row state. */
    key: string;
    /** human label (the dashboard this rollup powers). */
    label: string;
    /** every KV collection this rollup writes (Clear fans out over all). */
    collections: string[];
    /** subset of `collections` whose oldest bucket gates completeness — excludes
     *  flat (non-time-bucketed) collections like the topology inventory. */
    completenessCollections: string[];
    /** the *_aggregate saved search(es) the master/row enable toggle acts on. */
    aggregateSearches: string[];
    /** the *_backfill saved search stanza name(s) — full name, fetched + split
     *  into top-level arms. */
    backfillStanzas: string[];
    /** the *_retention saved search(es) — informational. */
    retentionSearches: string[];
    /** the time-bucket field the completeness collections use. */
    bucketField: 'bucket_ts' | 'day_ts';
}

/** Build a standard single-collection rollup entry (1 collection / 1 of each
 *  search). `coll` defaults to `logserv_<key>_rollup` (the hana row overrides it
 *  because its collection is logserv_hana_category_rollup, key 'hana'). */
export const single = (
    key: string,
    label: string,
    coll?: string,
    bucketField: 'bucket_ts' | 'day_ts' = 'bucket_ts',
): RollupDef => {
    const collection = coll ?? `logserv_${key}_rollup`;
    return {
        key,
        label,
        collections: [collection],
        completenessCollections: [collection],
        aggregateSearches: [`logserv_${key}_aggregate`],
        backfillStanzas: [`logserv_${key}_backfill`],
        retentionSearches: [`logserv_${key}_retention`],
        bucketField,
    };
};

/**
 * Backfill stanzas that must NOT be chunked, and are run over a fixed recent
 * window instead of the operator's chosen one.
 *
 * Both write FLAT collections — no time dimension in the `_key` — so chunks
 * would OVERWRITE each other rather than accumulate, and with three arms in
 * flight not even "last chunk wins" is deterministic:
 *
 *   logserv_topology_backfill_inventory   _key = canonical_value. Worse than the
 *     overwrite: the SID it writes is a WHOLE-WINDOW choice (build 379: the SIDs
 *     whose newest event falls in the endpoint's most recent hour, then the one
 *     with the most events in the window; an exact tie writes nothing). Per
 *     chunk, each month would choose on its own counts, and an older chunk
 *     finishing last would put back a SID the endpoint has since left.
 *   logserv_topology_enrichment_backfill  _key = ip:evidence_source, aggregating
 *     count / values(enr_user) / min(_time) across the window — chunking would
 *     undercount events, drop users seen in earlier chunks and corrupt first_seen.
 *
 * Pinning them to 30 days is not a compromise: both describe CURRENT state, not
 * history. Session 131. (Its second reason - over a year more IPs got reassigned
 * and failed the one-SID test `mvcount(sids)=1`, so a longer window resolved
 * FEWER partner nodes to SIDs - ended with build 379's most-recent-SID choice.)
 *
 * The same whole-window choice also spans the inventory's ARMS (its tail adds
 * the arms' event counts per SID before it chooses), and so does the nodes
 * tail's `sum(event_count)`: since build 378 the panel stages those two
 * stanzas' arms and combines them in one search per part
 * (utils/backfillPlan.ts), so the inventory is one part over these 30 days.
 */
export const FIXED30_BACKFILL_STANZAS: ReadonlySet<string> = new Set([
    'logserv_topology_backfill_inventory',
    'logserv_topology_enrichment_backfill',
]);

export const ROLLUPS: RollupDef[] = [
    single('wp_perf', 'Work Process Performance / ABAP Operations'),
    single('severity', 'Environment Health'),
    single('hana', 'HANA Audit', 'logserv_hana_category_rollup'),
    single('compliance', 'Change & Configuration Activity'),
    single('saprouter', 'SAP Router'),
    single('abapnet', 'ABAP Network & Security'),
    single('xstack_auth', 'Cross-Stack Authentication'),
    single('perimeter', 'Network Perimeter'),
    single('linux', 'Linux System & Security / Network Perimeter'),
    single('web_timing', 'Web & API Performance / Web Dispatcher'),
    single('hana_trace', 'HANA Trace'),
    single('windows', 'Windows'),
    single('sapservices', 'SAP Services'),
    single('mc', 'Multi-Cloud Overview'),
    single('cloudconn', 'Cloud Connector'),
    single('proxy', 'Proxy Analytics'),
    single('dns', 'DNS Analytics'),
    single('pipeline', 'Data Pipeline Overview'),
    single('hostdetails', 'Host Details'),
    single('webdisp_slowtrace', 'Web Dispatcher Slowest Traces'),
    single('topology_detail', 'Environment Topology (detail tabs)'),
    single('stmap', 'Sourcetype Mapping (Host Details / Data Pipeline)'),
    single('hostrole', 'Host Role Activity (Host Details)'),
    // Beaconing detection — two day-bucketed rollups (the count rollup +
    // the build-237 per-(query,src) gap-stats detail rollup) folded into one row.
    {
        key: 'beaconing',
        label: 'Beaconing detection (Environment Health / DNS / Network Perimeter)',
        collections: ['logserv_beaconing_rollup', 'logserv_beaconing_detail_rollup'],
        completenessCollections: ['logserv_beaconing_rollup', 'logserv_beaconing_detail_rollup'],
        aggregateSearches: ['logserv_beaconing_aggregate', 'logserv_beaconing_detail_aggregate'],
        backfillStanzas: ['logserv_beaconing_backfill', 'logserv_beaconing_detail_backfill'],
        retentionSearches: ['logserv_beaconing_retention', 'logserv_beaconing_detail_retention'],
        bucketField: 'day_ts',
    },
    // Environment Topology graph — nodes/edges (bucketed) + inventory (flat)
    // + IP enrichment (flat; session 112 / build 329 — hostname + user names
    // for the IP partner squares). Completeness checks the two bucketed
    // collections; the flat collections are backfilled + cleared but not
    // history-gated. Backfill now uses the per-arm top-level dispatch (was the
    // old Topology tab's truncation-prone single-union saved-search dispatch);
    // the enrichment backfill is single-pipeline → parseUnion yields one arm.
    {
        key: 'topology_graph',
        label: 'Environment Topology (graph)',
        collections: [
            'logserv_topology_nodes',
            'logserv_topology_edges',
            'logserv_topology_inventory',
            'logserv_topology_ip_enrichment',
        ],
        completenessCollections: ['logserv_topology_nodes', 'logserv_topology_edges'],
        aggregateSearches: [
            'logserv_topology_aggregate_nodes',
            'logserv_topology_aggregate_edges',
            'logserv_topology_aggregate_inventory',
            'logserv_topology_enrichment_aggregate',
        ],
        backfillStanzas: [
            'logserv_topology_backfill_nodes',
            'logserv_topology_backfill_edges',
            'logserv_topology_backfill_inventory',
            'logserv_topology_enrichment_backfill',
        ],
        retentionSearches: [
            'logserv_topology_retention',
            'logserv_topology_edges_retention',
            'logserv_topology_enrichment_retention',
        ],
        bucketField: 'bucket_ts',
    },
];

/**
 * The Dashboard Data panel's upgrade note for the HANA host, HANA trace and RFC
 * edge changes (build 378; design_impact.md section 4 and findings F3, F4, F8),
 * by rollup key so the labels it shows are the table's own.
 *
 * CLEAR THEN BACKFILL: rows that store a value the upgrade changes in their
 * _key (the HANA audit `host`, the HANA trace severity / component / file
 * fields, the RFC edge orientation, and the topology rows hashed from them).
 * A Backfill without the Clear writes the new keys beside the old ones and the
 * dashboards sum both - Environment Health included (F3: Total Errors sums
 * `toterr` across hosts) - and the four all-sourcetype rollups keep rows for
 * client host names that never sent data. The Environment Topology (graph) row
 * also repairs any node counts or inventory mappings an earlier per-arm Backfill
 * of that row wrote short (F1).
 *
 * ABAP Network & Security (item icm): the ICM error count keeps its key but
 * now counts dev_icm ERROR lines (until build 378: sessions in SAP client
 * 400-599, read as HTTP 4xx/5xx), so a Backfill alone leaves the old count
 * in every hour with no ERROR line; the Clear also removes the icmstat rows
 * nothing reads any more. Where metric="icmerr" holds no row the old
 * count was never written, and a Backfill alone is exact (release notes).
 *
 * BACKFILL ONLY: HANA audit records with an empty client field now parse
 * (h1 decision 3), which adds rows and raises counts under keys that do not
 * change - no double count, so no Clear.
 */
export const UPGRADE_NOTE_CLEAR_THEN_BACKFILL: readonly string[] = [
    'hana',
    'hana_trace',
    'severity',
    'abapnet',
    'hostrole',
    'topology_graph',
    'topology_detail',
    'mc',
    'pipeline',
    'hostdetails',
    'stmap',
];
export const UPGRADE_NOTE_BACKFILL_ONLY: readonly string[] = ['compliance', 'xstack_auth'];
/**
 * Build 381: the work process trace-component names (wp_category_name) are
 * now SAP's own, and the Work Process Performance rollup keys its metric "wp"
 * on that name - one Clear then Backfill (or the narrower repair of the
 * release notes, which deletes metric "wp" only).
 */
export const UPGRADE_NOTE_TRACE_NAMES: readonly string[] = ['wp_perf'];

/** Flattened views of the static registry (concat — Array.flat/flatMap need an
 *  ES2019 lib; this tsconfig targets earlier). */
export const ALL_AGG_SEARCHES: string[] = ([] as string[]).concat(
    ...ROLLUPS.map((d) => d.aggregateSearches),
);
export const ALL_COLLECTIONS: string[] = ([] as string[]).concat(...ROLLUPS.map((d) => d.collections));
/** The per-rollup table is rendered alphabetically by dashboard label (ascending)
 *  so admins can scan it by name; the registry array stays in its logical
 *  definition order (which everything else iterates — order-independent). */
export const ROLLUPS_SORTED: RollupDef[] = [...ROLLUPS].sort((a, b) => a.label.localeCompare(b.label));
