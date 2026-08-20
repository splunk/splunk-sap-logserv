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

export const ROLLUPS: RollupDef[] = [
    single('wp_perf', 'Work Process Performance'),
    single('severity', 'Environment Health'),
    single('hana', 'HANA Audit', 'logserv_hana_category_rollup'),
    single('compliance', 'Change & Configuration Activity'),
    single('saprouter', 'SAP Router'),
    single('abapnet', 'ABAP Network & Security'),
    single('xstack_auth', 'Cross-Stack Authentication'),
    single('perimeter', 'Network Perimeter'),
    single('linux', 'Linux System & Security'),
    single('web_timing', 'Web & API Performance'),
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
            'logserv_topology_enrichment_retention',
        ],
        bucketField: 'bucket_ts',
    },
];

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
