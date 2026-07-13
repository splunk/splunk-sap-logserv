/**
 * Raw fallback for the Sourcetype Mapping panels' sub-hour hybrid (session 087).
 *
 * The `logserv_stmap_rollup` KV-Store rollup — read by BOTH the Data Pipeline
 * Overview "Sourcetype Mapping" (Linked Graph) tab and the Host Details
 * "Sourcetype Mapping" tab — is hourly `bucket_ts`-keyed, so a sub-hour window
 * reads empty (within-hour → blank map) or over-inclusive (crossing an hour
 * boundary). This builds the always-correct raw arm those panels route to at
 * sub-hour ranges via `useHybridSearch`.
 *
 * The rollup stores a NORMALIZED `source` (UUID / date / long-digit-run stripped)
 * so the graph stays small. This raw arm applies the IDENTICAL three
 * `rex mode=sed` passes (in the same order: UUID → <id>, date → <date>,
 * long-digit → <n>) that [logserv_stmap_aggregate] uses, then dedups to
 * (sourcetype, source, host) tuples — byte-equal to the cached rollup read over
 * any hour-aligned window (de-risked 243/244 all-hosts + host-filtered tuples on
 * two dense settled days, session 087). It runs only at sub-hour ranges, so the
 * event scan is bounded to ≤90 min of data.
 *
 * `hostFragment` is the tstats-WHERE-dialect host clause (e.g.
 * `(host="a" OR host="b")`, or '' for all hosts) — the same
 * `combinedHostFilterTstats` OR-fragment the cached read appends via `| search`.
 * The macro is spliced first so `withCloudProvider` can inject the cloud term
 * right after it (matching the cached arm's `| search cloud_provider=…`).
 *
 * KEEP THE SED PASSES IN LOCKSTEP WITH [logserv_stmap_aggregate] in
 * default/savedsearches.conf — if the normalization there ever changes, this
 * raw arm must change identically or the hybrid stops being byte-equal.
 */
export const buildStmapRawQuery = (hostFragment: string): string => {
    const host = hostFragment ? ` ${hostFragment}` : '';
    return `\`sap_logserv_idx_macro\`${host} | eval source_n=source | rex mode=sed field=source_n "s/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/<id>/g" | rex mode=sed field=source_n "s/[0-9]{4}-[0-9]{2}-[0-9]{2}/<date>/g" | rex mode=sed field=source_n "s/[0-9]{4,}/<n>/g" | stats count by sourcetype, source_n, host | rename source_n as source | fields - count`;
};
