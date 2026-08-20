/**
 * diagEvidence — the dispatched checks (session 094, Phase 2).
 *
 * Phase 1 answers "what can I say for free". This module answers the questions
 * that need Splunk: does the index hold anything at all for this window, does
 * this panel's sourcetype exist, has the rollup this panel reads ever been
 * built, and is the search head keeping up.
 *
 * EVERY PROBE IS PIPE-LEADING (`| tstats`, `| inputlookup`, `| makeresults`,
 * `| rest`) — no raw event scan anywhere. All timings below were measured on
 * `splunk-sh-idxr` against 106 M events and a 782 K-row collection.
 *
 * ORDER IS A COST DECISION, NOT A STYLE ONE
 * -----------------------------------------
 * `gatherPanelEvidence` short-circuits. If the index has no events in the
 * window at all, the sourcetype and rollup probes are pointless — the answer is
 * already "there is no data here" — so they are skipped and reported as
 * `not evaluated — superseded`. The all-time "when did we last see this
 * sourcetype" probe is the most expensive at ~2.9 s and only runs when the
 * in-window count is zero, which is exactly when "no data since <date>" is the
 * thing worth saying.
 *
 * WHAT THIS MODULE MUST NEVER DO
 * ------------------------------
 * Interpret. It returns facts and the reason any fact is missing. The verdicts
 * live in the cascade, so the evidence stays reviewable on its own and a
 * skipped probe can never be silently read as a passing one.
 *
 * TRI-STATE IS LOAD-BEARING. Every field is `null` when the probe did not run
 * or failed, and a number/record only when it did. A consumer must treat `null`
 * as *not evaluated* and never as a zero — "the budget ran out" and "there are
 * genuinely none" are opposite conclusions. Note also that `| tstats … BY
 * sourcetype` emits NO ROW for a sourcetype with no events (not a row with
 * count 0), so an empty `sourcetypeCounts` record means "none present" while
 * `sourcetypeCounts === null` means "we did not find out".
 *
 * THE PANEL'S OWN NARROWING PREDICATES ARE NOT REPRODUCED HERE, ON PURPOSE.
 * A panel typically filters far more tightly than its sourcetype — by host, by
 * status, by action. This module answers only "does the sourcetype exist in
 * this window", so a consumer must never phrase a verdict as though the
 * panel's full predicate had been tested. The host filter in particular is NOT
 * spliced into any probe: `splProbe` recovers host values from SPL that
 * HostDetails built out of `?host=` / `?hosts=` URL parameters and
 * localStorage, so those strings have an untrusted origin. Keeping them out of
 * probe SPL entirely is simpler and safer than escaping them, and costs only
 * precision the verdict wording accounts for.
 */

import {
    ProbeRunner,
    ProbeResult,
    kvExtent,
    firstNumber,
    safeIdentifiers,
    isSafeIdentifier,
    fetchSavedSearchSpl,
    fetchMacroIndexes,
} from './diagProbe';
import { ROLLUPS } from '../routes/rollupRegistry';
import {
    IngestFacts,
    DIAG_INGEST_FACTS_COLLECTION,
    INGEST_FACTS_KEY,
    sanitizeFetchedFactsRow,
    ingestFactsSummary,
    scrubPaste,
} from './diagIngestFacts';
import { redactFreeTextPii } from './piiRedaction';
import { SplProbe } from './splProbe';
import {
    SNAPSHOT_COLLECTION,
    SNAPSHOT_READ_LIMIT,
    SNAPSHOT_WINDOW_SECONDS,
    SNAPSHOT_STALE_SECONDS,
    SNAPSHOT_STALE_DAILY_SECONDS,
    DAILY_SERIES_MAX_ROWS,
    buildPlatformSnapshot,
    matchProducerSkips,
    ProducerSkipEvidence,
} from './diagPlatform';

const INDEX_MACRO = '`sap_logserv_idx_macro`';

/** Why a fact is absent. Rendered verbatim in the evidence table. */
export interface ProbeNote {
    check: string;
    status: 'ok' | 'error' | 'skipped' | 'superseded';
    detail: string;
    durationMs?: number;
}

export interface PanelEvidence {
    /** Events in the window across whatever the index macro resolves to. */
    indexRowsInWindow: number | null;
    /** Indexes the windowed tstats actually MATCHED. Empty exactly when the
     *  window has zero events, so it cannot answer the visibility question —
     *  that is what `macroIndexes` is for (session 095, finding 1). */
    resolvedIndexes: string[] | null;
    /** The index name(s) the macro DEFINITION names — window-independent.
     *  Read from `configs/conf-macros` only when the windowed count is zero,
     *  which is the only time the visibility question matters. Catches a
     *  customer's `local/macros.conf` override. */
    macroIndexes: string[] | null;
    /** Indexes this ROLE can see. An index missing here that the macro names is
     *  the "zero rows, no error" authorization case. */
    visibleIndexes: string[] | null;
    /** In-window count per sourcetype the panel constrains on. */
    sourcetypeCounts: Record<string, number> | null;
    /** All-time last-seen epoch per sourcetype. Only probed when the in-window
     *  count is zero. Absent key = never seen at all. */
    sourcetypeLastSeen: Record<string, number> | null;
    /** §19.1 — all-time INDEX-TIME last-write epoch per sourcetype
     *  (`| metadata` recentTime; same dispatch, same filtering as
     *  `sourcetypeLastSeen`). Empirically verified per-sourcetype (session
     *  105: a backdated arrival moves it while lastTime stays; a sibling
     *  sourcetype's write does not move it). Feeds check 29's index-time
     *  contradiction comparator — the replay/backdate evasion L1-10
     *  recorded. Undefined-safe at every consumer. */
    sourcetypeRecentSeen: Record<string, number> | null;
    /** §19.8a-2 — the MINIMUM `firstTime` (event time) across the INDEX-WIDE
     *  metadata rows, BEFORE the panel's sourcetype filter: "does anything
     *  older than the cutoff exist in this index at all?" for check 28's
     *  evidence lines. Tri-state, null-preserving — never `?? 0`. */
    preCutoffOldest: number | null;
    /** §14.2 — the routing question, answered by ONE unfiltered
     *  `| tstats count … BY sourcetype` over the window: how many events carry
     *  the unparsed FALLBACK sourcetype (`sap_logserv_logs`, the input-stage
     *  name index-time routing rewrites), and the sum of every OTHER — i.e.
     *  routed — sourcetype. Probed only when the panel's required sourcetypes
     *  counted zero in a NON-EMPTY window (the moment the question matters).
     *  Tri-state together: both null when the probe did not run or failed.
     *  Any routed event in-window DISPROVES "routing is not applied"
     *  (transforms route every kind on the same tier), which is why both
     *  numbers come from the same dispatch. */
    fallbackRowsInWindow: number | null;
    routedRowsInWindow: number | null;
    /** The sourcetypes / tags the AGGREGATE that populates this panel's
     *  collection actually reads — traced back from the collection, so a cached
     *  panel can be asked the same question as a raw one. Null when the trace
     *  did not run or found nothing usable. */
    sourceScope: { sourcetypes: string[]; tags: string[]; via: string } | null;
    /** §14.5 — aggregate saved searches the trace found DISABLED, plus how
     *  many it traced in total. `producerDisabled === null` = the trace did
     *  not run or failed; `[]` = it ran and none were KNOWN-disabled. An
     *  UNKNOWN disabled flag never lands in the list, so "every traced
     *  aggregate is disabled" (the only state that may CONFIRM) is reachable
     *  on known facts alone. */
    producerDisabled: string[] | null;
    producerTracedCount: number | null;
    /** SS16.8a-2 — the traced aggregate NAMES as an ARRAY (`sourceScope.via`
     *  is a comma-joined display string and must never be re-split). Null when
     *  the trace did not run or found nothing. */
    producerNames: string[] | null;
    /** SS16 check 7 (panel scope) — platform-snapshot skip rows matched
     *  against `producerNames`, probed ONLY when the collection already looks
     *  stale. null = not probed; [] = probed, none matched — which is NEVER
     *  negative evidence. Matches may only ever ADD a provenance-badged
     *  evidence line to `rollup-stale`; they can never raise its confidence
     *  (SS16.8a-1: the snapshot collection is world-writable). */
    platformSkips: ProducerSkipEvidence[] | null;
    /** §20.2 — the FULL SPL of the saved searches that populate this panel's
     *  rollup collection(s), for DISPLAY (drawer + panel report). Deep-gated
     *  (drawer-only, like the §17 probes) so sweep evidence never carries SPL
     *  text into `json.sweep` (§20.8a-5); the panel report builder STRIPS it
     *  from its json copy. null = not collected (non-rollup panel, deep not
     *  set, budget gone, or nothing fetched). Consumers guard with
     *  `Array.isArray` — older fixtures/build states leave it undefined. */
    producerSpl: ProducerSplEntry[] | null;
    /** Rollup rows for this panel's collection+metric inside the window. */
    collectionRowsInWindow: number | null;
    /** Rollup rows for the collection WITHOUT the metric clause — probed only
     *  when the panel reads a metric arm and its scoped count is zero. >0 means
     *  the aggregate DID run for this window and only this metric's arm wrote
     *  nothing, which is ambiguous between "no qualifying events" and "the arm
     *  is broken" (session-093's D3/D4 were the latter) — the cascade must
     *  hedge, not confirm (session 095, finding 4c). */
    collectionRowsAllMetrics: number | null;
    /** True only when the extent probe SUCCEEDED. Distinguishes "collection is
     *  genuinely empty" (oldest/newest null, probed=true) from "the probe
     *  failed" (null, probed=false) — reading the latter as the former turned a
     *  KV hiccup into a confirmed "never built" (session 095, finding 2). */
    collectionExtentProbed: boolean;
    collectionOldest: number | null;
    collectionNewest: number | null;
    /** §14.4 — `apps/local` names visible to THIS role. Probed only when the
     *  panel's (own or traced) sourcetypes are Windows-family. ACL-scoped: an
     *  app the role cannot see reads as absent, which the verdict wording
     *  hedges. */
    installedApps: string[] | null;
    /** §14.5 — `server/info` kvStoreStatus. Probed only when a collection
     *  probe failed or the extent read came back EMPTY: the mongod-warm-up
     *  states where "empty" and "not ready yet" are otherwise
     *  indistinguishable (session-087 sticky). */
    kvStoreStatus: string | null;
    /** Operator-supplied ingest-filter configuration (design SS15, checks
     *  27-29). null = not supplied / unreadable / junk row. The scrubbedRaw
     *  inside is ALREADY excerpt-truncated (SS15.8a-23) so threading this into
     *  reports can never blow the model-size cap. Undefined-safe consumers
     *  only (older fixtures carry undefined). */
    ingestFacts: IngestFacts | null;
    /** `| makeresults count=1` round-trip, measured BEFORE any other probe is
     *  queued.
     *
     *  This is CONTEXT, never a cause. A saturated search head makes searches
     *  slow, queued or errored — it does not make one return successfully with
     *  zero rows, which is the state being diagnosed. And the number partly
     *  measures the diagnostic's own load plus whatever the dashboard's ~50
     *  panels are still doing, so a gate that concluded "overloaded" from it
     *  would accuse a healthy instance. Report it; do not rank on it. */
    canaryMs: number | null;
    /** §17.2 check 21 — the raw-equivalent (twin) query's OUTPUT-row count over
     *  the SETTLED window (clamped to `collectionNewest + grain`). Tri-state:
     *  a number ONLY when the probe ran clean; null on skip/error/not-run, with
     *  the reason in `rawArmError`. A `cache-contradicted`/`cached-raw-agree-empty`
     *  verdict is unreachable unless `rawArmRan && rawArmError === '' && ...`
     *  (§17.8a-4). */
    rawArmRan: boolean;
    rawArmRows: number | null;
    rawArmError: string;
    /** §17.3 check 22 — per-field presence/membership from ONE `| head 2000`
     *  sample of the panel's sourcetype(s). null = not probed. `sampled` is the
     *  sample size (2000 ⇒ capped, wording is per-sample). `matches` is null for
     *  neq/range/wildcard filters (existence-only). */
    fieldProbe: {
        sampled: number;
        filters: Array<{
            field: string;
            op: string;
            values: string[];
            present: number;
            distinct: number;
            matches: number | null;
        }>;
    } | null;
    /** §17.4 check 24 — non-rollup lookups the SPL references that are not
     *  registered / not visible. null = not probed; [] = all present. */
    lookupsMissing: string[] | null;
    /** §17.7 check 17b — whether the panel's cloud provider has any rows in the
     *  metric+window. null = not probed (no cloud filter, or metric count 0). */
    providerRowsPresent: boolean | null;
    /** §17.5 check 25 — the predicate bisect. null = not probed. `controlRows`
     *  is the base scope with NO clause removed (the §17.8a-7 control): >0 means
     *  the emptiness is AFTER the base search and the bisect concludes nothing.
     *  Each clause carries the row count when JUST that clause is removed
     *  (`removedRows`); null = that probe errored/truncated (§17.8a-6, no
     *  lower-bound claim). */
    bisect: {
        controlRows: number | null;
        clauses: Array<{ field: string; fragment: string; removedRows: number | null }>;
    } | null;
    /** §18.8a-27 — the partial-mode column tier, tri-state. null = the tier did
     *  not run (empty mode, no coverage supplied). `populated`/`derivedOrComputed`
     *  columns are dispositioned locally; `blanks` carry the corroboration
     *  sample result per column (`present` null = the probe did not complete);
     *  `dropped` columns could not be examined at all — the honest floor is
     *  UNREACHABLE while any exist (§18.8a-17). */
    columnProbe: {
        totalRows: number;
        capped: boolean;
        populated: string[];
        derivedOrComputed: Array<{ column: string; why: string }>;
        dropped: Array<{ column: string; reason: string }>;
        blanks: Array<{
            column: string;
            probeName: string;
            blankKind: string;
            present: number | null;
            /** Cached panels only: whether the traced aggregate's stored field
             *  list carries this column. Undefined when unknown. */
            storedByAggregate?: boolean;
        }>;
        sampled: number | null;
    } | null;
    /** §18.8a-10 — the scalar-twin VALUE probe for a zeroValued request.
     *  Evidence-first: a discrepancy can never confirm. null = not probed. */
    scalarTwin: { field: string; value: number } | null;
    notes: ProbeNote[];
    budgetExhausted: boolean;
}

const emptyEvidence = (): PanelEvidence => ({
    indexRowsInWindow: null,
    resolvedIndexes: null,
    macroIndexes: null,
    visibleIndexes: null,
    sourcetypeCounts: null,
    sourcetypeLastSeen: null,
    sourcetypeRecentSeen: null,
    preCutoffOldest: null,
    fallbackRowsInWindow: null,
    routedRowsInWindow: null,
    sourceScope: null,
    producerDisabled: null,
    producerTracedCount: null,
    producerNames: null,
    platformSkips: null,
    producerSpl: null,
    collectionRowsInWindow: null,
    collectionRowsAllMetrics: null,
    collectionExtentProbed: false,
    collectionOldest: null,
    collectionNewest: null,
    installedApps: null,
    kvStoreStatus: null,
    ingestFacts: null,
    canaryMs: null,
    rawArmRan: false,
    rawArmRows: null,
    rawArmError: '',
    fieldProbe: null,
    lookupsMissing: null,
    providerRowsPresent: null,
    bisect: null,
    columnProbe: null,
    scalarTwin: null,
    notes: [],
    budgetExhausted: false,
});

const note = (
    ev: PanelEvidence,
    check: string,
    r: ProbeResult,
    okDetail: string,
): boolean => {
    if (r.skipped) {
        ev.notes.push({ check, status: 'skipped', detail: 'Time budget exhausted or cancelled.' });
        ev.budgetExhausted = true;
        return false;
    }
    if (r.error) {
        ev.notes.push({ check, status: 'error', detail: r.error, durationMs: r.durationMs });
        return false;
    }
    ev.notes.push({ check, status: 'ok', detail: okDetail, durationMs: r.durationMs });
    return true;
};

const supersede = (ev: PanelEvidence, check: string, why: string): void => {
    ev.notes.push({ check, status: 'superseded', detail: why });
};

/** `(sourcetype="a" OR sourcetype="b")`, or '' when there is nothing safe. */
const sourcetypeClause = (sts: readonly string[]): string => {
    const safe = safeIdentifiers(sts);
    if (safe.length === 0) return '';
    return `(${safe.map((s) => `sourcetype="${s}"`).join(' OR ')})`;
};

// ---------------------------------------------------------------------------
// Individual probes
// ---------------------------------------------------------------------------

/** ~1.2 s. Presence AND macro resolution in one dispatch — `BY index` names the
 *  index the macro expanded to, which is the only way to see a customer's
 *  `local/macros.conf` override from the browser without an admin capability. */
export const probeIndexPresence = async (
    runner: ProbeRunner,
    earliest: string,
    latest: string,
): Promise<ProbeResult> =>
    runner.search(`| tstats count WHERE ${INDEX_MACRO} BY index`, earliest, latest);

/** ~0.1 s. Indexes this role can search. */
export const probeVisibleIndexes = async (runner: ProbeRunner): Promise<ProbeResult> =>
    runner.search('| eventcount summarize=false index=* | fields index', '-1m', 'now');

/** ~0.6 s. */
export const probeSourcetypeCounts = async (
    runner: ProbeRunner,
    sts: readonly string[],
    earliest: string,
    latest: string,
): Promise<ProbeResult> =>
    runner.search(
        `| tstats count WHERE ${INDEX_MACRO} ${sourcetypeClause(sts)} BY sourcetype`,
        earliest,
        latest,
    );

/**
 * All-time presence and last-seen, per sourcetype — **124 ms**.
 *
 * The obvious form, `| tstats max(_time) … BY sourcetype` with `earliest=0`,
 * measured **7.4 s** on this 106 M-event test box because it opens every tsidx
 * in the index across every peer; at the customer scale this product targets
 * (10.7 M events/day against a 365-day window) that is billions of events, per
 * drawer-open. `| metadata` reads the per-bucket summaries instead and answers
 * the same two questions 60x faster.
 *
 * TRAP: `index=` needs the RESOLVED index name — the macro expands to
 * `index="sap_logserv_logs"`, so `index=\`sap_logserv_idx_macro\`` becomes
 * `index=index="…"` and silently matches NOTHING (verified: 0 rows, no error).
 * That is why this takes the name discovered by `probeIndexPresence` rather
 * than using the macro like every other probe here.
 *
 * CAVEAT, deliberately unused: `totalCount` from a WINDOWED metadata dispatch
 * counts whole buckets that merely overlap the window, so it over-reports. Only
 * the all-time call is made, and only `lastTime` / presence are read from it —
 * exact in-window counts come from the tstats probe above.
 */
export const probeSourcetypeMetadata = async (
    runner: ProbeRunner,
    resolvedIndex: string,
): Promise<ProbeResult> => {
    if (!isSafeIdentifier(resolvedIndex)) {
        return { rows: [], error: `Unexpected index name: ${resolvedIndex}`, durationMs: 0, skipped: false };
    }
    /* §19.8a-2 (H5) — `firstTime` (event-time oldest, feeds preCutoffOldest)
     * and `recentTime` (INDEX-time last write, feeds the check-29 index-time
     * comparator) ride the SAME dispatch at zero extra cost. Both consumers
     * of this probe (the panel path here and diagEnvironment's) read fields
     * BY NAME, so the wider projection is shape-safe — gate-pinned. */
    return runner.search(
        `| metadata type=sourcetypes index=${resolvedIndex} | fields sourcetype firstTime lastTime recentTime totalCount`,
        '0',
        'now',
    );
};

/** ~0.5 s. Mirrors the panel's own read shape so the answer is comparable. */
export const probeCollectionWindow = async (
    runner: ProbeRunner,
    collection: string,
    metric: string | undefined,
    bucketField: string,
    earliest: string,
    latest: string,
): Promise<ProbeResult> => {
    const metricClause = metric && isSafeIdentifier(metric) ? `| search metric="${metric}" ` : '';
    return runner.search(
        `| inputlookup ${collection} ${metricClause}| addinfo ` +
            `| where ${bucketField}>=info_min_time AND ${bucketField}<info_max_time | stats count`,
        earliest,
        latest,
    );
};

/** ~0.2 s. A trivial search that takes seconds is waiting for a slot. */
export const probeCanary = async (runner: ProbeRunner): Promise<ProbeResult> =>
    runner.search('| makeresults count=1', '-1m', 'now');

/** The input-stage sourcetype that index-time routing rewrites. Events still
 *  carrying it were NOT parsed — by design for the documented Secondary log
 *  types and unrecognised kinds, and wholesale when the Data TA's transforms
 *  are not applied on the indexing path (design §14.2). */
export const FALLBACK_SOURCETYPE = 'sap_logserv_logs';

/** Un-namespaced splunkd proxy base for the panel path's REST probes.
 *  Deliberately defined HERE and imported by diagEnvironment, never the other
 *  way around — diagEnvironment already imports this module (and diagCascade,
 *  which imports this module), so an import in the other direction closes a
 *  module cycle the .ts-only gate resolver cannot load (§14.8a). */
export const RAW_SERVICES = '/en-US/splunkd/__raw/services';

/** ~0.6 s. ONE unfiltered per-sourcetype count answering BOTH §14.2 questions
 *  at once: how many in-window events carry the unparsed fallback sourcetype,
 *  and whether ANY routed sourcetype has in-window events — the decisive
 *  discriminator, since transforms route every kind on the same tier. */
export const probeUnroutedEvents = async (
    runner: ProbeRunner,
    earliest: string,
    latest: string,
): Promise<ProbeResult> =>
    runner.search(`| tstats count WHERE ${INDEX_MACRO} BY sourcetype`, earliest, latest);

/** The ProbeNote check name for the operator-supplied ingest-facts read —
 *  exported (§19.5) so the drawer's pointer can distinguish "nothing
 *  supplied" (no error/skip note) from "the read failed" without restating
 *  the string. */
export const INGEST_FACTS_CHECK_NAME = 'Ingest-tier filter config (operator-supplied)';

/** ~50 ms. The operator-supplied ingest-facts row (design SS15). Read via
 *  the runner so a dashboard sweep dedupes it across panels. */
export const probeIngestFacts = async (runner: ProbeRunner): Promise<ProbeResult> =>
    runner.kv(DIAG_INGEST_FACTS_COLLECTION, {
        query: JSON.stringify({ _key: INGEST_FACTS_KEY }),
        limit: '1',
    });

/** ~50 ms. App names visible to this role (ACL-scoped — see installedApps). */
export const probeInstalledApps = async (runner: ProbeRunner): Promise<ProbeResult> =>
    runner.rest(`${RAW_SERVICES}/apps/local?output_mode=json&count=0`);

/** SS16.8a-16 — the BOUNDED windowed snapshot read: query window + hard limit
 *  + explicit fields + newest-first sort. A read returning exactly the limit
 *  is TRUNCATED and the caller must say so (a silently truncated read is
 *  fabricated absence — SS12.3). */
export const probeSnapshotWindow = async (
    runner: ProbeRunner,
    nowSec: number,
): Promise<ProbeResult> =>
    runner.kv(SNAPSHOT_COLLECTION, {
        query: JSON.stringify({ bucket_ts: { $gte: nowSec - SNAPSHOT_WINDOW_SECONDS } }),
        limit: String(SNAPSHOT_READ_LIMIT),
        fields: 'bucket_ts,metric,scope,scope2,n,sum_rt,max_rt,kb,ev,detail',
        sort: 'bucket_ts:-1',
    });

/** SS16 check 6 — the caller's own search-job census, FIELD-FILTERED and
 *  capped (the unfiltered listing measured 4.7 MB on the test box). Admin
 *  roles see all users' jobs, others their own — the wording labels it, and
 *  SS12.6 applies: context, never a cause, never ranked. */
export const OWN_JOBS_COUNT_CAP = 200;
export const probeOwnJobs = async (runner: ProbeRunner): Promise<ProbeResult> =>
    runner.rest(
        `${RAW_SERVICES}/search/jobs?output_mode=json&count=${OWN_JOBS_COUNT_CAP}&f=dispatchState`,
    );

/** SS16.5 — the three data-coverage probes (environment scope). All tstats
 *  over the macro; the daily series is capped at the SOURCE (SS16.8a-21). */
export const probeDailyCounts = async (
    runner: ProbeRunner,
    earliest: string,
    latest: string,
): Promise<ProbeResult> =>
    runner.search(
        `| tstats count WHERE ${INDEX_MACRO} BY _time span=1d | tail ${DAILY_SERIES_MAX_ROWS}`,
        earliest,
        latest,
    );

/** clz_dir/clz_subdir are INDEXED (fields.conf, build 198). `BY` drops rows
 *  lacking the field, so the caller MUST print the covered-vs-total
 *  denominator (SS16.8a-22) — on the demo box the HEC-loaded events carry no
 *  clz fields at all and a zero-row result against millions of events is a
 *  REAL state, not a probe failure. */
export const probeClzCounts = async (
    runner: ProbeRunner,
    earliest: string,
    latest: string,
): Promise<ProbeResult> =>
    runner.search(
        `| tstats count WHERE ${INDEX_MACRO} BY clz_dir, clz_subdir | sort 30 - count`,
        earliest,
        latest,
    );

export const probeHostCounts = async (
    runner: ProbeRunner,
    earliest: string,
    latest: string,
): Promise<ProbeResult> =>
    runner.search(`| tstats count WHERE ${INDEX_MACRO} BY host | sort 15 - count`, earliest, latest);

export const probeHostDc = async (
    runner: ProbeRunner,
    earliest: string,
    latest: string,
): Promise<ProbeResult> =>
    runner.search(`| tstats dc(host) as hosts WHERE ${INDEX_MACRO}`, earliest, latest);

/* ------------------------------------------------------------------------- */
/* SS16.6 — the opt-in raw sample collection (SS7.10 / check 26).            */
/* ------------------------------------------------------------------------- */

/** Declared HERE (not in diagReport, which imports this module) so the drawer,
 *  the report builder and the build gate all reach it without a cycle. */
export interface RawSampleSet {
    events: Array<{ time: string; sourcetype: string; host: string; raw: string }>;
    fromWindow: boolean;
    excludedFilters: string[];
    error: string;
}

export const RAW_SAMPLE_MAX = 5;
/** §20.4/§20.8a-3 — a SAFETY CEILING, not a truncation policy (was a 500-char
 *  cap through build 319). 2× Splunk's 10,000-byte TRUNCATE default and below
 *  the PDF renderer's MONO_BLOCK_MAX_CHARS (gate-asserted), so the collector's
 *  disclosed marker is always the one the reader sees. HEC ingest bypasses
 *  TRUNCATE, so the ceiling is reachable in principle — never silently. */
export const RAW_SAMPLE_EVENT_MAX_CHARS = 20_000;
/** Deterministic thousands formatting (toLocaleString is locale-dependent). */
export const formatCount = (n: number): string =>
    String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/**
 * ONE `| head`-bounded event dispatch — window first, all-time fallback when
 * the window is empty (a reverse-time listing short-circuits at `head N`).
 * Redaction runs HERE, before the text can reach any model: each event is
 * clipped to RAW_SAMPLE_EVENT_MAX_CHARS FIRST (§20.8a-3 — the redactors must
 * never see an unbounded blob; a clip cannot expose a secret, because a
 * remnant either still matches the scrub patterns or carries no value), then
 * the SS15 credential scrubber, then the free-text PII redactor (emails +
 * user= shapes). Events at or under the ceiling are included IN FULL; an
 * over-ceiling event carries an explicit truncation marker derived from the
 * ORIGINAL length. Host and grain filter values are deliberately NOT spliced
 * (SS12.10) — the section wording carries `excludedFilters` so the reader
 * sees what was not applied. A failed/skipped probe returns an ERROR-carrying
 * set, never nothing (SS16.8a-27: the section must render the reason).
 */
export const collectRawSamples = async (
    runner: ProbeRunner,
    sts: readonly string[],
    excludedFilters: string[],
    earliest: string,
    latest: string,
): Promise<RawSampleSet> => {
    const clause = sourcetypeClause(sts);
    const spl =
        `search ${INDEX_MACRO} ${clause ? `${clause} ` : ''}| head ${RAW_SAMPLE_MAX} ` +
        `| fields _time, sourcetype, host, _raw`;
    const out: RawSampleSet = { events: [], fromWindow: true, excludedFilters, error: '' };
    let r = await runner.search(spl, earliest, latest);
    if (!r.skipped && !r.error && r.rows.length === 0) {
        out.fromWindow = false;
        r = await runner.search(spl, '0', 'now');
    }
    if (r.skipped) {
        out.error = 'the time budget was exhausted or the collection was cancelled.';
        return out;
    }
    if (r.error) {
        out.error = r.error;
        return out;
    }
    out.events = (r.rows as Array<Record<string, unknown>>)
        .slice(0, RAW_SAMPLE_MAX)
        .map((row) => {
            const rawFull = String(row._raw ?? '');
            const overCeiling = rawFull.length > RAW_SAMPLE_EVENT_MAX_CHARS;
            // §20.8a-3 — clip BEFORE redaction (order is load-bearing: the
            // mutation kill-test plants an email straddling the ceiling).
            const clipped = overCeiling ? rawFull.slice(0, RAW_SAMPLE_EVENT_MAX_CHARS) : rawFull;
            const redacted = redactFreeTextPii(scrubPaste(clipped));
            return {
                time: typeof row._time === 'string' ? row._time : String(row._time ?? ''),
                sourcetype: typeof row.sourcetype === 'string' ? row.sourcetype : '',
                host: typeof row.host === 'string' ? row.host : '',
                raw: overCeiling
                    ? `${redacted}\n… [truncated: event exceeds ${formatCount(RAW_SAMPLE_EVENT_MAX_CHARS)} characters]`
                    : redacted,
            };
        });
    if (out.events.length === 0) {
        out.error = 'no events of this panel’s sourcetype(s) exist on record.';
    }
    return out;
};

/** ~50 ms. kvStoreStatus from server/info ('ready' | 'starting' | …). */
export const probeKvStoreStatus = async (runner: ProbeRunner): Promise<ProbeResult> =>
    runner.rest(`${RAW_SERVICES}/server/info?output_mode=json`);

/**
 * Every sourcetype / tag named ANYWHERE in an aggregate saved search.
 *
 * Deliberately different from `splProbe.sourcetypes`, and the difference is the
 * whole point. `splProbe` reads only the BASE clause, because for a PANEL query
 * a `sourcetype=` after a pipe is a filter on already-summarised rows and must
 * not be mistaken for the query's scope. An AGGREGATE is the opposite case: it
 * is typically `| union [search sourcetype=a …] [search sourcetype=b …]`, and
 * what we want is the UNION of everything it consumes. Scanning the whole
 * string is correct here and wrong there.
 *
 * Over-collecting is the safe direction: a sourcetype named in the aggregate
 * but not actually feeding this panel's metric only makes the presence probe
 * broader, which can turn a "source data is missing" verdict into a
 * "source data is present" one — i.e. it errs toward blaming the rollup rather
 * than the data, and the rollup is ours.
 */
export const extractAggregateScope = (
    spl: string,
): { sourcetypes: string[]; tags: string[] } => {
    const sourcetypes: string[] = [];
    const tags: string[] = [];
    const push = (arr: string[], v: string): void => {
        if (isSafeIdentifier(v) && arr.indexOf(v) === -1) arr.push(v);
    };
    // sourcetype="x" / sourcetype=x
    const eq = /sourcetype\s*=\s*"([^"]+)"|sourcetype\s*=\s*([A-Za-z0-9:._-]+)/g;
    let m = eq.exec(spl);
    while (m !== null) {
        push(sourcetypes, (m[1] || m[2] || '').trim());
        m = eq.exec(spl);
    }
    // sourcetype IN ("a","b")
    const inList = /sourcetype\s+IN\s*\(([^)]*)\)/gi;
    m = inList.exec(spl);
    while (m !== null) {
        const inner = /"([^"]+)"/g;
        let q = inner.exec(m[1]);
        while (q !== null) {
            push(sourcetypes, q[1]);
            q = inner.exec(m[1]);
        }
        m = inList.exec(spl);
    }
    // tag=dns — DnsAnalytics' aggregate scopes this way and names no sourcetype
    const tg = /\btag\s*=\s*"?([A-Za-z0-9:._-]+)"?/g;
    m = tg.exec(spl);
    while (m !== null) {
        push(tags, m[1]);
        m = tg.exec(spl);
    }
    return { sourcetypes, tags };
};

/** The aggregate saved search(es) that populate a collection, from the shared
 *  registry — never a second hand-written list (session-062 precedent). */
export const aggregatesForCollection = (collection: string): string[] => {
    const hit = ROLLUPS.filter((r) => r.collections.indexOf(collection) !== -1);
    return ([] as string[]).concat(...hit.map((r) => r.aggregateSearches));
};

/* ------------------------------------------------------------------------- */
/* §20 — the rollup-populating SPL surfacing (display-only; never a check).   */
/* ------------------------------------------------------------------------- */

/** One populating saved search, fully fetched for DISPLAY (drawer technical
 *  detail, Copy technical summary, panel/dashboard PDFs). Tri-state honesty
 *  (§20.8a-8): a rendered entry can never show `spl: null` with an empty
 *  reason — the collector synthesizes one for every failure shape. */
export interface ProducerSplEntry {
    name: string;
    /** The `| outputlookup` target PARSED from the fetched SPL (§20.8a-1 —
     *  never the registry bundle, which is an entry-level union and false for
     *  the 1:many rollups). null = unparseable → the fallback wording. */
    collection: string | null;
    /** The registry entry's collections — the honest fallback wording when
     *  the outputlookup target could not be parsed. */
    rollupCollections: string[];
    spl: string | null;
    error: string;
    skipped: boolean;
    /** The entry's cron, verbatim (§20.8a-6 — cadence is never hardcoded). */
    cron: string | null;
    /** The entry's `updated` timestamp — "definition last modified". */
    updated: string | null;
    /** The sibling backfill stanza (name transform, registry-validated) for
     *  the §20.8a-2 as-shipped identity hedge. null = no registered sibling. */
    backfill: string | null;
}

/** §20.8a-2/12 — the sibling backfill name, by NAME transform (never index
 *  alignment between the two hand-written registry arrays). Handles the
 *  topology infix form (`logserv_topology_aggregate_nodes`). */
export const backfillNameFor = (aggregate: string): string =>
    aggregate.indexOf('_aggregate_') !== -1
        ? aggregate.replace('_aggregate_', '_backfill_')
        : aggregate.replace(/_aggregate$/, '_backfill');

/** §20.8a-1 — the LAST `| outputlookup <collection>` target in an aggregate's
 *  SPL (every shipped aggregate ends in exactly one). Options are skipped;
 *  null when nothing parseable is found (the caller words the fallback). */
export const parseOutputlookupTarget = (spl: string): string | null => {
    const re =
        /\|\s*outputlookup\s+((?:[a-z_]+\s*=\s*\S+\s+)*)([A-Za-z_][A-Za-z0-9_.-]*)/gi;
    let target: string | null = null;
    let m = re.exec(spl);
    while (m !== null) {
        target = m[2];
        m = re.exec(spl);
    }
    return target;
};

/** Panel path ≤ a handful; the dashboard union tops out well under this with
 *  the current registry. Candidates beyond the cap render as skipped entries
 *  (never silently dropped — §20.8a-8). */
export const PRODUCER_SPL_FETCH_MAX = 8;

/**
 * Fetch the full SPL of every saved search registered as populating any of
 * `collections`, for display (§20.2/§20.3). DISPLAY-ONLY: no ledger note, no
 * verdict input, independent of the trace (which keeps its own fetches; the
 * duplicate GETs are ~10 ms each and dedupe under a memoizing runner).
 *
 * Filter semantics (§20.8a-1): an aggregate whose PARSED outputlookup target
 * is not one of the requested collections is DROPPED (it does not populate
 * what this surface reads — the 1:many beaconing/topology case); an
 * unparseable target is KEPT with `collection: null` (fallback wording).
 * Returns null when there is nothing to say (no rollup collections, nothing
 * fetched, or the runner is already cancelled/out of budget — §20.8a-8).
 */
export const collectProducerSpl = async (
    runner: ProbeRunner,
    collections: readonly string[],
): Promise<ProducerSplEntry[] | null> => {
    const wanted = collections.filter((c, i) => collections.indexOf(c) === i);
    if (wanted.length === 0) return null;
    if (runner.isCancelled() || runner.remainingMs() <= 0) return null;

    interface Cand {
        name: string;
        rollupCollections: string[];
        backfill: string | null;
    }
    const cands: Cand[] = [];
    ROLLUPS.forEach((def) => {
        if (!def.collections.some((c) => wanted.indexOf(c) !== -1)) return;
        def.aggregateSearches.forEach((name) => {
            if (cands.some((x) => x.name === name)) return;
            const bf = backfillNameFor(name);
            cands.push({
                name,
                rollupCollections: def.collections.slice(),
                backfill: def.backfillStanzas.indexOf(bf) !== -1 ? bf : null,
            });
        });
    });
    if (cands.length === 0) return null;

    const out: ProducerSplEntry[] = [];
    const mkEntry = (c: Cand, over: Partial<ProducerSplEntry>): ProducerSplEntry => ({
        name: c.name,
        collection: null,
        rollupCollections: c.rollupCollections,
        spl: null,
        error: '',
        skipped: false,
        cron: null,
        updated: null,
        backfill: c.backfill,
        ...over,
    });
    for (let i = 0; i < cands.length; i += 1) {
        const cand = cands[i];
        if (i >= PRODUCER_SPL_FETCH_MAX) {
            out.push(
                mkEntry(cand, {
                    error: `the ${PRODUCER_SPL_FETCH_MAX}-search fetch cap was reached.`,
                    skipped: true,
                }),
            );
            continue;
        }
        if (runner.isCancelled() || runner.remainingMs() <= 0) {
            out.push(
                mkEntry(cand, {
                    error: 'Time budget exhausted or cancelled.',
                    skipped: true,
                }),
            );
            continue;
        }
        // eslint-disable-next-line no-await-in-loop
        const got = await fetchSavedSearchSpl(runner, cand.name);
        if (got.skipped) {
            out.push(
                mkEntry(cand, {
                    error: 'Time budget exhausted or cancelled.',
                    skipped: true,
                }),
            );
            continue;
        }
        if (got.error || !got.spl) {
            out.push(
                mkEntry(cand, {
                    error: got.error || 'the saved search returned no search string.',
                }),
            );
            continue;
        }
        const target = parseOutputlookupTarget(got.spl);
        if (target !== null && wanted.indexOf(target) === -1) continue; // §20.8a-1 drop
        out.push(
            mkEntry(cand, {
                collection: target,
                spl: got.spl,
                cron: got.cronSchedule,
                updated: got.updated,
            }),
        );
    }
    return out.length > 0 ? out : null;
};

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

const toRecordNumber = (rows: Record<string, unknown>[], key: string, valueField: string): Record<string, number> => {
    const out: Record<string, number> = {};
    rows.forEach((r) => {
        const k = r[key];
        const v = r[valueField];
        const n = typeof v === 'number' ? v : Number(v);
        if (typeof k === 'string' && Number.isFinite(n)) out[k] = n;
    });
    return out;
};

// ---------------------------------------------------------------------------
// Phase 5 deep-evidence probes (checks 17b / 22 / 24 / 21) — §17 / §17.8a
// ---------------------------------------------------------------------------

/** Local copy of the cascade's window→epoch approximation, for check 21's
 *  settled-window clamp (§17.8a-2). Pure; `nowSec` is the browser clock. */
const approxEpochLocal = (s: string, nowSec: number): number | null => {
    if (!s) return null;
    const t = s.trim();
    if (t === 'now' || t === 'rt') return nowSec;
    if (/^\d{9,}(\.\d+)?$/.test(t)) {
        const n = Number(t);
        return Number.isFinite(n) ? Math.floor(n) : null;
    }
    if (/^\d{4}-\d{2}-\d{2}/.test(t)) {
        const p = Date.parse(t);
        return Number.isFinite(p) ? Math.floor(p / 1000) : null;
    }
    const stripped = t.replace(/^rt/, '').replace(/@.*$/, '');
    if (stripped === '0') return 0;
    const m = stripped.match(/^([+-]?)(\d+)(mon|[smhdwy])$/);
    if (!m) return null;
    const sign = m[1] === '-' ? -1 : 1;
    const n = parseInt(m[2], 10);
    const mult: Record<string, number> = {
        s: 1, m: 60, h: 3600, d: 86400, w: 7 * 86400, mon: 30 * 86400, y: 365 * 86400,
    };
    return nowSec + sign * n * (mult[m[3]] ?? 0);
};

/** §17.8a-11 — a filter value safe to splice into probe SPL: no quotes,
 *  backslashes or SPL metacharacters. Anything else is DROPPED (never escaped). */
const isSafeFilterValue = (v: string): boolean => /^[A-Za-z0-9:._/@-]{1,64}$/.test(v);

/** Check 21 (§17.2): dispatch the raw twin as `… | stats count as n` over the
 *  SETTLED window and read the single count. Grouped-arm / scalar-arm decision
 *  and all cascade consumption live in diagCascade; this only gathers. */
const probeRawArm = async (
    runner: ProbeRunner,
    rawArm: string,
    earliest: string,
    latestClamped: string,
): Promise<ProbeResult> =>
    // 20 s ceiling (§17.8a-5): a raw scan must never eat the whole drawer budget.
    runner.search(`${rawArm} | stats count as n`, earliest, latestClamped, 20);

/** Check 22 (§17.3): ONE `| head 2000 | stats` membership sample. Returns the
 *  raw ProbeResult; the caller assembles `fieldProbe`. `stClause` already
 *  encodes the sourcetype (or tag) scope. */
const probeFieldMembership = async (
    runner: ProbeRunner,
    stClause: string,
    aggs: string,
    earliest: string,
    latest: string,
): Promise<ProbeResult> =>
    runner.search(
        `search ${INDEX_MACRO} ${stClause} | head 2000 | stats count as sampled${aggs}`,
        earliest,
        latest,
        20,
    );

/**
 * Collect everything the cascade needs for ONE panel.
 *
 * `probe` is the panel's classified SPL; `earliest`/`latest` are the window the
 * panel ACTUALLY ran over — not the picker's current value, because a few
 * panels override it (the topology right pane pins `-24h`).
 */
export interface GatherPanelOptions {
    /** §17.1 — the byte-equal raw twin for check 21, resolved at drawer-request
     *  build time (never via the collector registry). */
    rawAlternate?: string | null;
    /** §17.8a-16 — deep probes (21 raw scan + 25 bisect) run ONLY in the panel
     *  drawer. DEFAULT FALSE so a dashboard sweep can never fire N raw scans at
     *  once (the §3.5 prohibition). Only DiagnosticDrawerProvider passes true. */
    deep?: boolean;
    /** The row count the GATES should reason from. For a §18.4 effective-empty
     *  (zeroValued) request the drawer passes 0 here while `facts.rowCount`
     *  keeps the TRUE count — the report must state the real number
     *  (§18.8a-8). */
    rowCount?: number | null;
    /** §18.8a-23 — the gather mode. 'partial' runs ONLY: canary, ingest facts,
     *  the companion-apps read, (cached) the aggregate trace, and the single
     *  column-corroboration dispatch; every emptiness probe is SKIPPED with an
     *  explicit note. Default 'empty' (all existing callers unchanged). */
    mode?: 'empty' | 'partial';
    /** §18.8a-1/2 — the renderer-published, values-free column-coverage
     *  summary (resolved from the columnCoverage side channel at request-build
     *  time). Only consumed in partial mode. */
    columnCoverage?: import('./columnCoverage').ColumnCoverageSummary | null;
    /** §18.8a-10 — a KPI-entry zeroValued request: enables the scalar-twin
     *  VALUE probe alongside the effective-empty battery. */
    zeroValued?: boolean;
    /** §18.8a-12 — blank-column origin resolutions, computed at REQUEST-BUILD
     *  time from the panel's own SPL (`resolveColumnOrigins`) — the gather
     *  never sees the raw spl string. */
    columnOrigins?: Record<string, import('./splProbe').ColumnOrigin> | null;
    /** §18.8a-10 — the shared terminal field name of BOTH scalar arms
     *  (`scalarTwinFieldFor(facts.spl, rawAlternate)`); null disables the
     *  value probe (multi-field rows, mismatched arms). */
    scalarTwinField?: string | null;
}

export const gatherPanelEvidence = async (
    runner: ProbeRunner,
    probe: SplProbe,
    earliest: string,
    latest: string,
    /** Called after every probe so the UI can show live progress. This takes
     *  seconds against a large index, and a drawer that sits blank for ten of
     *  them is indistinguishable from one that hung. */
    onProgress?: (notes: ProbeNote[]) => void,
    opts?: GatherPanelOptions,
): Promise<PanelEvidence> => {
    const ev = emptyEvidence();
    const deep = opts?.deep === true;
    const rawAlternate = opts?.rawAlternate ?? null;
    const panelRowCount = opts?.rowCount ?? null;
    const mode = opts?.mode === 'partial' ? 'partial' : 'empty';
    const columnCoverage = opts?.columnCoverage ?? null;
    const columnOrigins = opts?.columnOrigins ?? null;
    const zeroValued = opts?.zeroValued === true;
    const scalarTwinField = opts?.scalarTwinField ?? null;
    const tick = (): void => {
        if (onProgress) onProgress(ev.notes.slice());
    };

    // 1. Canary first, and cheap. If the SH is saturated, everything after this
    //    is slow for a reason we want to be able to name.
    const canary = await probeCanary(runner);
    if (note(ev, 'Search-head canary', canary, `${canary.durationMs} ms round-trip`)) {
        ev.canaryMs = canary.durationMs;
    }
    tick();

    // 1.5 Operator-supplied ingest facts (design SS15, checks 27-29). One
    //     cheap KV read, deduped across a dashboard sweep by the memoizing
    //     runner. Per SS15.2 a panel gather is NOISELESS when nothing was
    //     supplied: it notes the check only when facts exist, the fetch
    //     errored, or the budget skipped it (SS15.8a-29).
    {
        const fx = await probeIngestFacts(runner);
        if (fx.skipped) {
            ev.notes.push({
                check: INGEST_FACTS_CHECK_NAME,
                status: 'skipped',
                detail: 'Time budget exhausted or cancelled.',
            });
            ev.budgetExhausted = true;
        } else if (fx.error) {
            ev.notes.push({
                check: INGEST_FACTS_CHECK_NAME,
                status: 'error',
                detail: fx.error,
                durationMs: fx.durationMs,
            });
        } else {
            const rows = fx.rows as unknown[];
            const facts = rows.length > 0
                ? sanitizeFetchedFactsRow(rows[0], Math.floor(Date.now() / 1000))
                : null;
            ev.ingestFacts = facts;
            if (facts) {
                ev.notes.push({
                    check: INGEST_FACTS_CHECK_NAME,
                    status: 'ok',
                    detail: `Recorded as supplied by ${facts.suppliedBy || 'an unknown user'}: ${ingestFactsSummary(facts)}`,
                    durationMs: fx.durationMs,
                });
            }
        }
    }
    tick();

    /* ---- shared probe closures (both modes) -------------------------------
     * The cached-source trace and the companion-apps read are needed by BOTH
     * the empty cascade and the §18.8a-23 partial gather, so they live in
     * closures the two paths share. `aggStoredFields` is the union of the
     * traced aggregates' terminal `| fields` keep-lists (single-pipeline
     * aggregates only — a `| union` aggregate's per-arm lists are not parsed,
     * leaving the stored-check honestly UNKNOWN); it feeds the §18.8a-13
     * `column-not-stored` branch. */
    const aggStored: { set: Set<string> | null } = { set: null };

    const parseTerminalFields = (aggSpl: string): string[] | null => {
        if (/^\s*\|\s*union\b/i.test(aggSpl)) return null;
        const re = /\|\s*fields\s+(?!\s*-)([^|]+)/gi;
        let last: string | null = null;
        let m = re.exec(aggSpl);
        while (m) {
            last = m[1];
            m = re.exec(aggSpl);
        }
        if (!last) return null;
        const names = last
            .split(/[,\s]+/)
            .map((s) => s.trim().replace(/^"|"$/g, ''))
            .filter((s) => s.length > 0);
        return names.length > 0 ? names : null;
    };

    const traceCachedSourceScope = async (): Promise<string[]> => {
        if (probe.tier !== 'cached' || !probe.collection) return [];
        const aggs = aggregatesForCollection(probe.collection);
        if (aggs.length === 0) {
            supersede(
                ev,
                'Source of the summarised data',
                `No aggregate is registered for ${probe.collection}.`,
            );
            return [];
        }
        /* Union ALL the collection's aggregates, not aggs[0] — the
         * multi-aggregate rollups have PER-ARM scopes (session 095, finding 9).
         * Over-collection is the declared safe direction. */
        const scopeSts: string[] = [];
        const scopeTags: string[] = [];
        const vias: string[] = [];
        const disabledNames: string[] = [];
        let firstError = '';
        let wasSkipped = false;
        for (const aggName of aggs.slice(0, 4)) {
            const got = await fetchSavedSearchSpl(runner, aggName);
            if (got.skipped) {
                wasSkipped = true;
                break;
            }
            if (got.error || !got.spl) {
                if (!firstError) firstError = got.error || `Could not read ${aggName}.`;
                continue;
            }
            const scope = extractAggregateScope(got.spl);
            scope.sourcetypes.forEach((s) => {
                if (scopeSts.indexOf(s) === -1) scopeSts.push(s);
            });
            scope.tags.forEach((t) => {
                if (scopeTags.indexOf(t) === -1) scopeTags.push(t);
            });
            vias.push(aggName);
            const stored = parseTerminalFields(got.spl);
            if (stored) {
                if (!aggStored.set) aggStored.set = new Set<string>();
                stored.forEach((s) => (aggStored.set as Set<string>).add(s));
            }
            // §14.5 — the disabled flag rides the entry the trace already
            // fetched. Only a KNOWN true lands in the list.
            if (got.disabled === true) disabledNames.push(aggName);
        }
        if (wasSkipped) {
            ev.notes.push({
                check: 'Source of the summarised data',
                status: 'skipped',
                detail: 'Time budget exhausted or cancelled.',
            });
            ev.budgetExhausted = true;
            return [];
        }
        if (vias.length === 0) {
            ev.notes.push({
                check: 'Source of the summarised data',
                status: 'error',
                detail: firstError || `Could not read ${aggs[0]}.`,
            });
            return [];
        }
        const via = vias.join(', ');
        ev.sourceScope = { sourcetypes: scopeSts, tags: scopeTags, via };
        ev.producerDisabled = disabledNames;
        ev.producerTracedCount = vias.length;
        ev.producerNames = vias.slice();
        ev.notes.push({
            check: 'Source of the summarised data',
            status: 'ok',
            detail:
                scopeSts.length > 0
                    ? `${via} reads ${scopeSts.join(', ')}`
                    : scopeTags.length > 0
                      ? `${via} is scoped by ${scopeTags.map((t) => `tag=${t}`).join(', ')}`
                      : `${via} names no sourcetype`,
        });
        return safeIdentifiers(scopeSts);
    };

    const WIN_FAMILY_RE = /^(Xml)?WinEventLog/i;
    const probeAppsInto = async (stList: string[]): Promise<void> => {
        const familySts = stList.filter((s) => WIN_FAMILY_RE.test(s));
        if (familySts.length === 0) return;
        const apps = await probeInstalledApps(runner);
        if (apps.skipped) {
            ev.notes.push({
                check: 'Installed apps (search tier)',
                status: 'skipped',
                detail: 'Time budget exhausted or cancelled.',
            });
            ev.budgetExhausted = true;
        } else if (apps.error) {
            ev.notes.push({
                check: 'Installed apps (search tier)',
                status: 'error',
                detail: apps.error,
                durationMs: apps.durationMs,
            });
        } else {
            const names = (apps.rows as Record<string, unknown>[])
                .map((r) => (typeof r.name === 'string' ? r.name : ''))
                .filter((s) => s.length > 0);
            ev.installedApps = names;
            ev.notes.push({
                check: 'Installed apps (search tier)',
                status: 'ok',
                detail: `${names.length} app(s) visible to this role`,
                durationMs: apps.durationMs,
            });
        }
    };

    /* §20.2/§20.8a-9 — the display-only producer-SPL capture: deep-gated
     * (drawer-only, so sweep evidence never carries SPL text — §20.8a-5) and
     * invoked from BOTH mode paths right after their trace/apps step, BEFORE
     * the partial-mode return and far from the §17 deep block so a spent
     * budget cannot silently starve it. Never a ledger note, never a verdict
     * input (§20.6). */
    const captureProducerSpl = async (): Promise<void> => {
        if (!deep || ev.producerSpl !== null) return;
        ev.producerSpl = await collectProducerSpl(runner, probe.collections);
    };

    /* §18.8a-23 — THE PARTIAL-MODE GATHER. A populated panel's rows are living
     * proof the index/sourcetype/rollup read path works, so the emptiness
     * battery is SKIPPED (with explicit notes — never silently omitted) and
     * only the column tier's needs run: the trace (cached), the companion-apps
     * read, and ONE corroboration dispatch for the blank probeable columns. */
    if (mode === 'partial') {
        let scopeSts = safeIdentifiers(probe.sourcetypes);
        let scopeTags = safeIdentifiers(probe.tags);
        if (scopeSts.length === 0 && probe.tier === 'cached' && probe.collection) {
            scopeSts = await traceCachedSourceScope();
            if (ev.sourceScope) scopeTags = safeIdentifiers(ev.sourceScope.tags);
        }
        tick();
        await probeAppsInto(scopeSts);
        await captureProducerSpl();
        tick();

        if (!columnCoverage) {
            ev.notes.push({
                check: 'Column coverage (local)',
                status: 'skipped',
                detail:
                    'No column-coverage summary was published for this panel (charts and hand-rolled visuals carry none) — the column tier cannot run.',
            });
        } else {
            const cp: NonNullable<PanelEvidence['columnProbe']> = {
                totalRows: columnCoverage.total,
                capped: columnCoverage.capped,
                populated: [],
                derivedOrComputed: [],
                dropped: [],
                blanks: [],
                sampled: null,
            };
            const partials: string[] = [];
            for (const col of columnCoverage.columns) {
                if (col.populated >= columnCoverage.total && columnCoverage.total > 0) {
                    cp.populated.push(col.key);
                    continue;
                }
                if (col.populated > 0) {
                    // §18.3(3) — partially-populated is routinely legitimate
                    // (optional fields): evidence only, and it counts as
                    // accounted-for toward the floor.
                    cp.populated.push(col.key);
                    partials.push(`${col.key} (${col.populated} of ${columnCoverage.total})`);
                    continue;
                }
                // Fully blank.
                if (col.hasRender) {
                    cp.derivedOrComputed.push({
                        column: col.key,
                        why: 'rendered by a custom cell renderer, which may compose content from other fields',
                    });
                    continue;
                }
                const origin = columnOrigins ? columnOrigins[col.key] : undefined;
                if (origin && origin.kind === 'computed') {
                    cp.derivedOrComputed.push({
                        column: col.key,
                        why: 'computed inside the query — not expected on raw events',
                    });
                    continue;
                }
                const probeName = origin && origin.probeName ? origin.probeName : col.key;
                if (!isSafeIdentifier(probeName) || probeName.length > 64) {
                    cp.dropped.push({
                        column: col.key,
                        reason: 'its source field could not be identified as a probeable name',
                    });
                    continue;
                }
                if (scopeSts.length === 0 && scopeTags.length === 0) {
                    cp.dropped.push({
                        column: col.key,
                        reason:
                            probe.tier === 'cached'
                                ? `the source of ${probe.collection ?? 'this summary'} could not be traced`
                                : 'this panel names no sourcetype or tag to sample',
                    });
                    continue;
                }
                if (cp.blanks.length >= 6) {
                    cp.dropped.push({ column: col.key, reason: 'more than 6 blank columns (probe cap)' });
                    continue;
                }
                const blank: NonNullable<PanelEvidence['columnProbe']>['blanks'][number] = {
                    column: col.key,
                    probeName,
                    blankKind: col.blankKind ?? 'absent',
                    present: null,
                };
                // TS cannot track the closure assignment into `aggStoredFields`
                // across the await boundary — snapshot it through a typed local.
                const storedSet: Set<string> | null = aggStored.set;
                if (storedSet) {
                    blank.storedByAggregate = storedSet.has(probeName) || storedSet.has(col.key);
                }
                cp.blanks.push(blank);
            }
            ev.notes.push({
                check: 'Column coverage (local)',
                status: 'ok',
                detail:
                    `${columnCoverage.columns.length} displayed column(s) over the first ${cp.totalRows} returned row(s)` +
                    `${cp.capped ? ' (capped)' : ''}: ${cp.populated.length} populated, ${cp.blanks.length + cp.derivedOrComputed.length + cp.dropped.length} blank` +
                    (partials.length > 0 ? `; partially populated: ${partials.join(', ')}` : ''),
            });

            // ONE corroboration dispatch for all probeable blanks (§18.8a-16).
            const toProbe = cp.blanks;
            if (toProbe.length > 0) {
                const stScope =
                    scopeSts.length > 0
                        ? sourcetypeClause(scopeSts)
                        : scopeTags.map((t) => `tag="${t}"`).join(' ');
                const aggParts = toProbe.map((b, i) => `count(${b.probeName}) as present_${i}`);
                const fp = await probeFieldMembership(
                    runner,
                    stScope,
                    `, ${aggParts.join(', ')}`,
                    earliest,
                    latest,
                );
                if (note(ev, 'Column corroboration probe (sampled)', fp, `${firstNumber(fp, 'sampled') ?? 0} sampled`)) {
                    const row = (fp.rows as Array<Record<string, unknown>>)[0] ?? {};
                    const num = (k: string): number => {
                        const v = row[k];
                        const n = typeof v === 'number' ? v : Number(v);
                        return Number.isFinite(n) ? n : 0;
                    };
                    cp.sampled = num('sampled');
                    toProbe.forEach((b, i) => {
                        b.present = num(`present_${i}`);
                    });
                }
            }
            ev.columnProbe = cp;
        }
        tick();

        // The emptiness battery is not applicable — say so, never silently omit.
        [
            'Index presence in window',
            'Index visibility for this role',
            'Sourcetype coverage',
            'Sourcetype last seen (all time)',
            'Summarised-data health',
        ].forEach((c) => supersede(ev, c, 'Not applicable — this panel returned data.'));
        if (runner.remainingMs() <= 0) ev.budgetExhausted = true;
        tick();
        return ev;
    }

    // 2. Is there anything in the index at all for this window, and what did the
    //    macro resolve to?
    const idx = await probeIndexPresence(runner, earliest, latest);
    if (note(ev, 'Index presence in window', idx, `${idx.rows.length} index(es) matched`)) {
        const rows = idx.rows as Record<string, unknown>[];
        const counts = toRecordNumber(rows, 'index', 'count');
        ev.resolvedIndexes = Object.keys(counts);
        ev.indexRowsInWindow = Object.keys(counts).reduce((a, k) => a + counts[k], 0);
    }
    tick();

    // 3. Only ask "can this role see the index" when the index looks empty —
    //    an authorization failure and a genuinely empty window are
    //    indistinguishable from the count alone (both are zero, no error).
    //    The macro DEFINITION is read alongside, because the windowed tstats
    //    resolves to an empty index list in exactly this state — without the
    //    definition the visibility comparison has nothing to compare against
    //    (session 095, finding 1).
    if (ev.indexRowsInWindow === 0 || ev.indexRowsInWindow === null) {
        const vis = await probeVisibleIndexes(runner);
        if (note(ev, 'Index visibility for this role', vis, `${vis.rows.length} index(es) visible`)) {
            ev.visibleIndexes = (vis.rows as Record<string, unknown>[])
                .map((r) => (typeof r.index === 'string' ? r.index : ''))
                .filter((s) => s.length > 0);
        }
        const mi = await fetchMacroIndexes(runner);
        if (mi.skipped) {
            ev.notes.push({
                check: 'Index named by the app macro',
                status: 'skipped',
                detail: 'Time budget exhausted or cancelled.',
            });
            ev.budgetExhausted = true;
        } else if (mi.error || mi.indexes === null) {
            ev.notes.push({
                check: 'Index named by the app macro',
                status: 'error',
                detail: mi.error || 'Macro definition could not be read.',
            });
        } else {
            ev.macroIndexes = mi.indexes;
            ev.notes.push({
                check: 'Index named by the app macro',
                status: 'ok',
                detail: mi.indexes.join(', ') || '(none found in the definition)',
            });
        }
    } else {
        supersede(ev, 'Index visibility for this role', 'The index returned events, so the role can see it.');
    }
    tick();

    // 4. Sourcetype coverage — only meaningful for a tier whose SPL names one.
    //    A cached rollup read carries no sourcetype at all (that is the whole
    //    point of a rollup), so this is skipped and the rollup probes below
    //    carry the weight instead.
    let sts = safeIdentifiers(probe.sourcetypes);

    /* TRACE A CACHED PANEL BACK TO ITS SOURCE (the shared closure above —
     * §18.8a-23 reuses it for the partial gather). If the summary is empty
     * for this window and the SOURCE events are absent too, nothing is
     * wrong; if the source events are right there, the rollup is the fault.
     * Opposite verdicts, and the difference is what a customer needs. */
    if (sts.length === 0 && probe.tier === 'cached' && probe.collection) {
        const traced = await traceCachedSourceScope();
        if (traced.length > 0) sts = traced;
    }
    await captureProducerSpl(); // §20.8a-9 — the empty-mode invocation

    /* One index name for the `| metadata` probe, with the macro-definition
     * fallback (§14.8a): on a ZERO-event window `resolvedIndexes` is [] — the
     * exact state where the fresh-install questions live — but
     * `fetchMacroIndexes` ran in precisely that state, so its single name is
     * available where the windowed tstats has nothing. */
    const singleIndexName = (): string =>
        ev.resolvedIndexes && ev.resolvedIndexes.length === 1
            ? ev.resolvedIndexes[0]
            : ev.macroIndexes && ev.macroIndexes.length === 1
              ? ev.macroIndexes[0]
              : '';

    const probeLastSeenInto = async (idxName: string): Promise<void> => {
        const ls = await probeSourcetypeMetadata(runner, idxName);
        if (note(ev, 'Sourcetype last seen (all time)', ls, `${ls.rows.length} sourcetype(s) known`)) {
            const rows = ls.rows as Record<string, unknown>[];
            const all = toRecordNumber(rows, 'sourcetype', 'lastTime');
            // Keep only the sourcetypes this panel asked about; the
            // index-wide list is not this panel's business.
            const kept: Record<string, number> = {};
            sts.forEach((s) => {
                if (Object.prototype.hasOwnProperty.call(all, s)) kept[s] = all[s];
            });
            ev.sourcetypeLastSeen = kept;
            // §19.1 — the index-time twin, from the SAME rows, filtered the
            // same way.
            const recent = toRecordNumber(rows, 'sourcetype', 'recentTime');
            const keptRecent: Record<string, number> = {};
            sts.forEach((s) => {
                if (Object.prototype.hasOwnProperty.call(recent, s)) keptRecent[s] = recent[s];
            });
            ev.sourcetypeRecentSeen = keptRecent;
            /* §19.8a-2 — the INDEX-WIDE oldest event time, null-preserving:
             * only rows with a finite positive firstTime participate, and
             * with none the field STAYS null (a failed parse must never read
             * as epoch 0 = "nothing older exists"). */
            let oldest: number | null = null;
            rows.forEach((r) => {
                const v = r.firstTime;
                const n = typeof v === 'number' ? v : Number(v);
                if (Number.isFinite(n) && n > 0 && (oldest === null || n < oldest)) oldest = n;
            });
            ev.preCutoffOldest = oldest;
        }
    };

    if (sts.length === 0) {
        supersede(
            ev,
            'Sourcetype coverage',
            probe.tier === 'cached'
                ? 'The aggregate behind this summary does not name a sourcetype (it is tag-scoped, or could not be read).'
                : 'This panel does not constrain a sourcetype.',
        );
    } else if (ev.indexRowsInWindow === 0) {
        supersede(ev, 'Sourcetype coverage', 'The index has no events in this window at all.');
        /* §14.1 (binding correction — all three review lenses independently):
         * without this, the pure fresh-install state (empty index) leaves
         * `sourcetypeLastSeen` null and the feed-never-arrived verdict is
         * STRUCTURALLY UNREACHABLE exactly where it was designed to fire —
         * the drawer would keep prescribing a backfill that cannot help. The
         * `| metadata` probe is all-time and window-independent (~124 ms), so
         * an empty window is no reason to skip it for a cached panel whose
         * source scope was traced. */
        if (probe.tier === 'cached' && ev.sourceScope !== null) {
            const idxName = singleIndexName();
            if (!idxName) {
                supersede(
                    ev,
                    'Sourcetype last seen (all time)',
                    'Needs a single index name, which neither the window probe nor the macro definition provided.',
                );
            } else {
                await probeLastSeenInto(idxName);
            }
        }
    } else {
        const stc = await probeSourcetypeCounts(runner, sts, earliest, latest);
        if (note(ev, 'Sourcetype coverage', stc, `${stc.rows.length} of ${sts.length} present`)) {
            ev.sourcetypeCounts = toRecordNumber(stc.rows as Record<string, unknown>[], 'sourcetype', 'count');
        }
        const total = ev.sourcetypeCounts
            ? Object.keys(ev.sourcetypeCounts).reduce((a, k) => a + (ev.sourcetypeCounts as Record<string, number>)[k], 0)
            : null;
        if (total === null) {
            // The count probe failed or was skipped — nothing may claim the
            // sourcetype IS present (session 095, finding 8a). The count
            // probe's own note already says what went wrong.
            supersede(
                ev,
                'Sourcetype last seen (all time)',
                'The in-window count could not be established, so last-seen was not checked.',
            );
        } else if (total === 0 || (ev.sourcetypeCounts && Object.keys(ev.sourcetypeCounts).length === 0)) {
            // Nothing in the window — so "was it ever here?" is now the question.
            const idxName = singleIndexName();
            if (!idxName) {
                supersede(
                    ev,
                    'Sourcetype last seen (all time)',
                    'Needs a single resolved index name, which the index probe did not return.',
                );
            } else {
                await probeLastSeenInto(idxName);
            }
            /* §14.2 — the routing question, asked ONLY at its moment: the
             * panel's log types have nothing in a window that is NOT empty.
             * One unfiltered per-sourcetype count answers both halves (the
             * fallback population and whether ANY routed kind has events);
             * skipped when the panel reads the fallback sourcetype itself. */
            if (sts.indexOf(FALLBACK_SOURCETYPE) === -1) {
                const ur = await probeUnroutedEvents(runner, earliest, latest);
                let urDetail = '';
                let fb = 0;
                let routed = 0;
                if (!ur.skipped && !ur.error) {
                    const counts = toRecordNumber(
                        ur.rows as Record<string, unknown>[],
                        'sourcetype',
                        'count',
                    );
                    fb = counts[FALLBACK_SOURCETYPE] ?? 0;
                    routed = Object.keys(counts)
                        .filter((k) => k !== FALLBACK_SOURCETYPE)
                        .reduce((a, k) => a + counts[k], 0);
                    urDetail = `${fb.toLocaleString()} unrouted (${FALLBACK_SOURCETYPE}), ${routed.toLocaleString()} routed`;
                }
                if (note(ev, 'Unrouted events in window', ur, urDetail)) {
                    ev.fallbackRowsInWindow = fb;
                    ev.routedRowsInWindow = routed;
                }
            } else {
                supersede(
                    ev,
                    'Unrouted events in window',
                    'This panel reads the fallback sourcetype itself.',
                );
            }
        } else {
            supersede(ev, 'Sourcetype last seen (all time)', 'The sourcetype has events in this window.');
        }
    }
    tick();

    /* §14.4 — the Windows-extraction question. The LogServ App ships NO
     * XmlWinEventLog search-time extraction of its own (severity/EventCode
     * come from Splunk_TA_windows on the SEARCH tier — session 069), so when
     * a panel's own or traced sourcetypes are Windows-family, one cheap
     * ACL-scoped listing answers whether that add-on is even installed.
     * (The shared closure — the §18.8a-23 partial gather runs it too.) */
    await probeAppsInto(sts);
    tick();

    // 5. Rollup health — only for a cached read, and only for a collection name
    //    we recognise as safe to splice.
    const collection = probe.collection;
    if (probe.tier !== 'cached' || !collection || !isSafeIdentifier(collection)) {
        supersede(ev, 'Summarised-data health', 'This panel does not read summarised data.');
    } else {
        const bucketField = probe.grain === 'daily' ? 'day_ts' : 'bucket_ts';
        const inWin = await probeCollectionWindow(
            runner,
            collection,
            probe.metric,
            bucketField,
            earliest,
            latest,
        );
        if (note(ev, 'Summarised rows in window', inWin, `${firstNumber(inWin, 'count') ?? 0} row(s)`)) {
            ev.collectionRowsInWindow = firstNumber(inWin, 'count') ?? 0;
        }
        /* When a metric arm read zero, ask the collection WITHOUT the metric
         * clause. Sibling-metric rows prove the aggregate ran for this window,
         * which changes the verdict from a confirmed gap to a hedged one
         * (session 095, finding 4c). Skipped entirely for metric-less reads. */
        if (probe.metric && ev.collectionRowsInWindow === 0) {
            const inWinAll = await probeCollectionWindow(
                runner,
                collection,
                undefined,
                bucketField,
                earliest,
                latest,
            );
            if (
                note(
                    ev,
                    'Summarised rows in window (all measures)',
                    inWinAll,
                    `${firstNumber(inWinAll, 'count') ?? 0} row(s)`,
                )
            ) {
                ev.collectionRowsAllMetrics = firstNumber(inWinAll, 'count') ?? 0;
            }
        } else if (probe.metric) {
            supersede(
                ev,
                'Summarised rows in window (all measures)',
                'This panel’s own measure has rows, so the whole-collection count adds nothing.',
            );
        }
        // Oldest/newest via the KV REST API, NOT `| inputlookup | stats min/max`
        // — 12–565 ms instead of ~5 s on a large collection.
        const extent = await kvExtent(runner, collection, bucketField);
        if (extent.skipped) {
            ev.notes.push({ check: 'Summarised data extent', status: 'skipped', detail: 'Time budget exhausted or cancelled.' });
            ev.budgetExhausted = true;
        } else if (extent.error) {
            ev.notes.push({ check: 'Summarised data extent', status: 'error', detail: extent.error });
        } else {
            // Only a SUCCESSFUL read may set this: null oldest/newest with the
            // flag true means "genuinely empty"; with it false, "unknown"
            // (session 095, finding 2).
            ev.collectionExtentProbed = true;
            ev.collectionOldest = extent.oldest;
            ev.collectionNewest = extent.newest;
            ev.notes.push({
                check: 'Summarised data extent',
                status: 'ok',
                detail:
                    extent.oldest === null || extent.newest === null
                        ? 'Collection is empty.'
                        : `${new Date(extent.oldest * 1000).toISOString().slice(0, 16).replace('T', ' ')} -> ` +
                          `${new Date(extent.newest * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC`,
            });
        }

        /* §14.5 — when a summarised-data read FAILED, or the extent read
         * succeeded but came back EMPTY, ask whether the KV Store itself is
         * up before anyone concludes anything. During mongod warm-up after a
         * restart, KV reads fail OR silently return empty (session-087
         * sticky) — states otherwise indistinguishable from "never built". */
        const extentEmpty =
            ev.collectionExtentProbed &&
            ev.collectionOldest === null &&
            ev.collectionNewest === null;
        if (ev.collectionRowsInWindow === null || !ev.collectionExtentProbed || extentEmpty) {
            const si = await probeKvStoreStatus(runner);
            if (si.skipped) {
                ev.notes.push({
                    check: 'KV Store status',
                    status: 'skipped',
                    detail: 'Time budget exhausted or cancelled.',
                });
                ev.budgetExhausted = true;
            } else if (si.error) {
                ev.notes.push({
                    check: 'KV Store status',
                    status: 'error',
                    detail: si.error,
                    durationMs: si.durationMs,
                });
            } else {
                const entry = (si.rows as Array<{ content?: { kvStoreStatus?: unknown } }>)[0];
                const status =
                    entry && entry.content && typeof entry.content.kvStoreStatus === 'string'
                        ? entry.content.kvStoreStatus
                        : null;
                ev.kvStoreStatus = status;
                ev.notes.push({
                    check: 'KV Store status',
                    status: 'ok',
                    detail: status ?? '(not reported)',
                    durationMs: si.durationMs,
                });
            }
        }

        /* SS16 check 7 (panel scope) — the platform-snapshot skip probe, run
         * ONLY when the collection already looks stale for its grain (the
         * moment the question matters) AND the trace produced producer names
         * to match on. Deduped by the memoizing runner across a sweep. The
         * result may only ever ADD a provenance-badged evidence line to
         * `rollup-stale` — never raise its confidence (SS16.8a-1: the
         * snapshot collection is world-writable). Silent when not triggered,
         * like the KV-status probe above. */
        if (
            ev.collectionExtentProbed &&
            ev.collectionNewest !== null &&
            ev.producerNames !== null &&
            ev.producerNames.length > 0
        ) {
            const nowSec = Math.floor(Date.now() / 1000);
            const lag = nowSec - ev.collectionNewest;
            const trigger =
                probe.grain === 'daily' ? SNAPSHOT_STALE_DAILY_SECONDS : SNAPSHOT_STALE_SECONDS;
            if (lag > trigger) {
                const snapExtent = await kvExtent(runner, SNAPSHOT_COLLECTION, 'bucket_ts');
                const snapWin = await probeSnapshotWindow(runner, nowSec);
                if (snapExtent.skipped || snapWin.skipped) {
                    ev.notes.push({
                        check: 'Platform snapshot (producer skips)',
                        status: 'skipped',
                        detail: 'Time budget exhausted or cancelled.',
                    });
                    ev.budgetExhausted = true;
                } else if (snapExtent.error || snapWin.error) {
                    ev.notes.push({
                        check: 'Platform snapshot (producer skips)',
                        status: 'error',
                        detail: snapExtent.error || snapWin.error,
                    });
                } else {
                    const snap = buildPlatformSnapshot(
                        true,
                        snapExtent.newest,
                        snapWin.rows as unknown[],
                        snapWin.rows.length >= SNAPSHOT_READ_LIMIT,
                        nowSec,
                    );
                    ev.platformSkips = matchProducerSkips(snap, ev.producerNames, ev.collectionNewest);
                    ev.notes.push({
                        check: 'Platform snapshot (producer skips)',
                        status: 'ok',
                        detail:
                            snap.status === 'live'
                                ? `${ev.platformSkips.length} matching skip record(s) since the summary's newest bucket`
                                : `snapshot ${snap.status} — skip records not usable`,
                    });
                }
            }
        }
    }

    // ------------------------------------------------------------------
    // Phase 5 deep evidence (§17). 17b is cheap and unconditional; 22/24/21
    // run ONLY in the drawer (`deep`) so a dashboard sweep never fires N raw
    // scans (§17.8a-16). All respect the runner's budget/concurrency and note
    // themselves honestly.
    // ------------------------------------------------------------------

    // 17b — provider-scoped coverage (§17.7). Evidence line only.
    if (
        probe.tier === 'cached' &&
        collection &&
        isSafeIdentifier(collection) &&
        probe.cloudFilter &&
        isSafeIdentifier(probe.cloudFilter.provider) &&
        ev.collectionRowsInWindow !== null &&
        ev.collectionRowsInWindow > 0
    ) {
        const bf = probe.grain === 'daily' ? 'day_ts' : 'bucket_ts';
        const metricClause =
            probe.metric && isSafeIdentifier(probe.metric) ? `metric="${probe.metric}" ` : '';
        const provRead = await runner.search(
            `| inputlookup ${collection} | addinfo | where ${bf}>=info_min_time AND ${bf}<info_max_time ` +
                `| search ${metricClause}cloud_provider="${probe.cloudFilter.provider}" | head 1 | stats count`,
            earliest,
            latest,
        );
        if (note(ev, 'Provider rows in window', provRead, 'checked')) {
            ev.providerRowsPresent = (firstNumber(provRead, 'count') ?? 0) > 0;
        }
        tick();
    }

    // 22 — field existence / value probe (§17.3). Drawer-only.
    if (
        deep &&
        probe.tier === 'raw' &&
        panelRowCount === 0 &&
        probe.fieldFilters.length > 0 &&
        (probe.sourcetypes.length > 0 || probe.tags.length > 0) &&
        ev.sourcetypeCounts !== null &&
        Object.values(ev.sourcetypeCounts).some((n) => n > 0)
    ) {
        // Scope clause: prefer sourcetypes (safe-listed already); fall back to tags.
        const stScope =
            probe.sourcetypes.length > 0
                ? sourcetypeClause(probe.sourcetypes)
                : safeIdentifiers(probe.tags)
                      .map((t) => `tag="${t}"`)
                      .join(' ');
        // Build one present/distinct (+ optional match) triple per usable filter.
        const usable = probe.fieldFilters.filter(
            (f) => isSafeIdentifier(f.field) && f.field.length <= 64,
        );
        const aggParts: string[] = [];
        const meta: Array<{ field: string; op: string; values: string[]; hasMatch: boolean }> = [];
        usable.forEach((f, i) => {
            aggParts.push(`count(${f.field}) as present_${i}`);
            aggParts.push(`dc(${f.field}) as distinct_${i}`);
            const safeVals = (f.op === 'eq' || f.op === 'in') && !f.wildcard
                ? f.values.filter(isSafeFilterValue)
                : [];
            const hasMatch = safeVals.length > 0 && safeVals.length === f.values.length;
            if (hasMatch) {
                // §17.8a-9: base/search origin = case-insensitive; where = literal.
                const lhs = f.origin === 'where' ? f.field : `lower(${f.field})`;
                const rhs = safeVals
                    .map((v) => `"${f.origin === 'where' ? v : v.toLowerCase()}"`)
                    .join(', ');
                aggParts.push(`sum(eval(if(${lhs} IN (${rhs}), 1, 0))) as match_${i}`);
            }
            meta.push({ field: f.field, op: f.op, values: f.values, hasMatch });
        });
        if (stScope && aggParts.length > 0) {
            const fp = await probeFieldMembership(
                runner,
                stScope,
                `, ${aggParts.join(', ')}`,
                earliest,
                latest,
            );
            if (note(ev, 'Field presence probe (sampled)', fp, `${firstNumber(fp, 'sampled') ?? 0} sampled`)) {
                const row = (fp.rows as Array<Record<string, unknown>>)[0] ?? {};
                const num = (k: string): number => {
                    const v = row[k];
                    const n = typeof v === 'number' ? v : Number(v);
                    return Number.isFinite(n) ? n : 0;
                };
                ev.fieldProbe = {
                    sampled: num('sampled'),
                    filters: meta.map((m, i) => ({
                        field: m.field,
                        op: m.op,
                        values: m.values,
                        present: num(`present_${i}`),
                        distinct: num(`distinct_${i}`),
                        matches: m.hasMatch ? num(`match_${i}`) : null,
                    })),
                };
            }
            tick();
        }
    }

    // 25 — predicate relaxation bisect (§17.5). Drawer-only, raw tier, base is
    // NOT a disjunction. First probe is the CONTROL (base with no clause
    // removed): if it returns > 0 the emptiness is downstream of the base
    // search and the bisect concludes nothing (§17.8a-7). k+1 probes, each hard
    // per-probe capped; a truncated/errored removal is unevaluated, never a
    // lower bound (§17.8a-6).
    if (
        deep &&
        probe.tier === 'raw' &&
        panelRowCount === 0 &&
        !probe.baseDisjunction &&
        probe.fieldFilters.length > 0 &&
        probe.fieldFilters.length <= 5 &&
        (probe.sourcetypes.length > 0 || probe.tags.length > 0)
    ) {
        const relaxable = probe.fieldFilters.filter((f) => isSafeIdentifier(f.field));
        const k = relaxable.length;
        // Base scope = the macro + the sourcetype/tag constraint + all conjuncts.
        const baseScope =
            probe.sourcetypes.length > 0
                ? sourcetypeClause(probe.sourcetypes)
                : safeIdentifiers(probe.tags).map((t) => `tag="${t}"`).join(' ');
        const conjuncts = relaxable.map((f) => f.fragment).join(' ');
        const HARD = 15000; // §17.8a-5 per-probe ceiling for the bisect
        if (k > 0 && baseScope && runner.remainingMs() >= (k + 1) * HARD + 5000) {
            const perProbeSec = Math.max(
                5,
                Math.min(15, Math.floor(runner.remainingMs() / (k + 1) / 1000)),
            );
            const fullBase = `search ${INDEX_MACRO} ${baseScope} ${conjuncts}`.trim();
            const control = await runner.search(`${fullBase} | stats count as n`, earliest, latest, perProbeSec);
            const controlRows = control.skipped || control.error ? null : firstNumber(control, 'n') ?? 0;
            if (controlRows !== null && controlRows > 0) {
                // Emptiness is AFTER the base search — the bisect cannot speak.
                ev.bisect = { controlRows, clauses: [] };
                ev.notes.push({
                    check: 'Clause relaxation',
                    status: 'ok',
                    detail: 'The panel’s filtering happens after the base search, which this check does not test.',
                });
            } else if (controlRows === 0) {
                const clauses: Array<{ field: string; fragment: string; removedRows: number | null }> = [];
                for (const f of relaxable) {
                    // Remove exactly this conjunct's fragment from the base.
                    const relaxed = `search ${INDEX_MACRO} ${baseScope} ${relaxable
                        .filter((g) => g !== f)
                        .map((g) => g.fragment)
                        .join(' ')}`.trim();
                    const rr = await runner.search(`${relaxed} | stats count as n`, earliest, latest, perProbeSec);
                    clauses.push({
                        field: f.field,
                        fragment: f.fragment,
                        removedRows: rr.skipped || rr.error ? null : firstNumber(rr, 'n') ?? 0,
                    });
                }
                ev.bisect = { controlRows: 0, clauses };
                const killers = clauses.filter((c) => (c.removedRows ?? 0) > 0);
                ev.notes.push({
                    check: 'Clause relaxation',
                    status: 'ok',
                    detail:
                        killers.length > 0
                            ? `${killers.length} clause(s) each remove all matches`
                            : 'no single clause explains the emptiness',
                });
            } else {
                ev.notes.push({
                    check: 'Clause relaxation',
                    status: control.skipped ? 'skipped' : 'error',
                    detail: control.error || 'the control search did not complete.',
                });
                if (control.skipped) ev.budgetExhausted = ev.budgetExhausted || runner.remainingMs() <= 0;
            }
            tick();
        }
    }

    // 24 — lookup registration (§17.4). Drawer-only; dormant for the current
    // panel set (no shipped panel references a non-rollup lookup).
    if (deep && panelRowCount === 0 && probe.lookups.length > 0) {
        const missing: string[] = [];
        let probed = false;
        for (const name of probe.lookups.slice(0, 3)) {
            if (!isSafeIdentifier(name.replace(/\.csv$/i, ''))) continue;
            const isCsv = /\.csv$/i.test(name);
            const url = isCsv
                ? `${RAW_SERVICES}/data/lookup-table-files/${encodeURIComponent(name)}?output_mode=json`
                : `${RAW_SERVICES}/data/transforms/lookups/${encodeURIComponent(name)}?output_mode=json`;
            const r = await runner.rest(url);
            if (r.skipped) {
                ev.budgetExhausted = true;
                continue;
            }
            probed = true;
            // A 404 (also what an ACL-hidden object returns) → missing.
            if (r.error && /HTTP 404/.test(r.error)) missing.push(name);
        }
        if (probed) {
            ev.lookupsMissing = missing;
            ev.notes.push({
                check: 'Lookup registration',
                status: 'ok',
                detail: missing.length > 0 ? `not registered: ${missing.join(', ')}` : 'all present',
            });
            tick();
        }
    }

    // 21 — cached-vs-raw arm reconciliation (§17.2). Drawer-only, the one probe
    // that can be a raw scan. Grouped-arm decision + all verdict consumption
    // live in diagCascade; here we dispatch the twin over the SETTLED window.
    if (
        deep &&
        probe.tier === 'cached' &&
        panelRowCount === 0 &&
        rawAlternate &&
        ev.collectionExtentProbed &&
        runner.remainingMs() >= 20000
    ) {
        const nowSec = Math.floor(Date.now() / 1000);
        const grainSec = probe.grain === 'daily' ? 86400 : 3600;
        const winEnd = approxEpochLocal(latest, nowSec);
        const winStart = approxEpochLocal(earliest, nowSec);
        // §17.8a-1: check 21 only has a row-count signal for a GROUPED raw arm.
        // A scalar (no-BY stats) twin returns exactly one row whether or not any
        // event matched, so `… | stats count` would be a constant 1 — the F1
        // false-`cache-contradicted` generator. Skip those with an honest note.
        const grouped = /\b(timechart|chart|top|rare)\b|\bstats\b[^|]*\bby\b/i.test(rawAlternate);
        if (!grouped) {
            ev.rawArmRan = false;
            ev.rawArmError = 'scalar raw arm';
            ev.notes.push({
                check: 'Raw-equivalent query',
                status: 'skipped',
                detail: 'This panel’s raw equivalent is a scalar query and carries no row-count signal.',
            });
            tick();
        } else if (ev.collectionNewest !== null) {
            const settledEnd = ev.collectionNewest + grainSec;
            const clampEnd = winEnd !== null ? Math.min(winEnd, settledEnd) : settledEnd;
            if (winStart !== null && clampEnd <= winStart) {
                ev.rawArmRan = false;
                ev.rawArmError = 'no settled window';
                ev.notes.push({
                    check: 'Raw-equivalent query',
                    status: 'skipped',
                    detail: 'The summarised data does not yet cover this range (nothing settled to compare).',
                });
            } else {
                const r = await probeRawArm(runner, rawAlternate, earliest, String(clampEnd));
                if (r.skipped) {
                    ev.rawArmError = 'skipped';
                    ev.budgetExhausted = ev.budgetExhausted || runner.remainingMs() <= 0;
                    ev.notes.push({ check: 'Raw-equivalent query', status: 'skipped', detail: 'Time budget exhausted or cancelled.' });
                } else if (r.error) {
                    ev.rawArmError = r.error;
                    ev.notes.push({ check: 'Raw-equivalent query', status: 'error', detail: r.error, durationMs: r.durationMs });
                } else {
                    ev.rawArmRan = true;
                    ev.rawArmRows = firstNumber(r, 'n') ?? 0;
                    ev.notes.push({
                        check: 'Raw-equivalent query',
                        status: 'ok',
                        detail: `${ev.rawArmRows} row(s) over the settled window`,
                        durationMs: r.durationMs,
                    });
                }
            }
            tick();
        }
    }

    /* §18.8a-10 — the scalar-twin VALUE probe. A zeroValued KPI's raw twin is
     * exactly the scalar arm check 21 skips — but its VALUE is the
     * reconciliation signal for a zero. Runs only when the drawer resolved a
     * SHARED terminal singleton field for both arms; the result is evidence-
     * first (a discrepancy can never confirm — the arms are hand-maintained
     * twins documented to disagree at float boundaries, and the twin itself
     * has had live defects). */
    if (deep && zeroValued && rawAlternate && scalarTwinField && runner.remainingMs() >= 20000) {
        const nowSec2 = Math.floor(Date.now() / 1000);
        const winEnd2 = approxEpochLocal(latest, nowSec2);
        let latestForTwin = latest;
        if (probe.tier === 'cached' && ev.collectionNewest !== null) {
            const grainSec2 = probe.grain === 'daily' ? 86400 : 3600;
            const settledEnd2 = ev.collectionNewest + grainSec2;
            latestForTwin = String(winEnd2 !== null ? Math.min(winEnd2, settledEnd2) : settledEnd2);
        }
        const tw = await runner.search(rawAlternate, earliest, latestForTwin, 20);
        if (tw.skipped) {
            ev.notes.push({
                check: 'Scalar-twin value probe',
                status: 'skipped',
                detail: 'Time budget exhausted or cancelled.',
            });
            ev.budgetExhausted = ev.budgetExhausted || runner.remainingMs() <= 0;
        } else if (tw.error) {
            ev.notes.push({
                check: 'Scalar-twin value probe',
                status: 'error',
                detail: tw.error,
                durationMs: tw.durationMs,
            });
        } else {
            const row0 = (tw.rows as Array<Record<string, unknown>>)[0];
            const raw = row0 ? row0[scalarTwinField] : undefined;
            const n = typeof raw === 'number' ? raw : Number(raw);
            if (Number.isFinite(n)) {
                ev.scalarTwin = { field: scalarTwinField, value: n };
                ev.notes.push({
                    check: 'Scalar-twin value probe',
                    status: 'ok',
                    detail: `raw equivalent computes ${scalarTwinField} = ${n}`,
                    durationMs: tw.durationMs,
                });
            } else {
                // §18.8a — a non-numeric read is NOT CHECKED, never a value.
                ev.notes.push({
                    check: 'Scalar-twin value probe',
                    status: 'error',
                    detail: `the raw equivalent returned a non-numeric ${scalarTwinField}`,
                    durationMs: tw.durationMs,
                });
            }
        }
        tick();
    }

    if (runner.remainingMs() <= 0) ev.budgetExhausted = true;
    tick();
    return ev;
};
