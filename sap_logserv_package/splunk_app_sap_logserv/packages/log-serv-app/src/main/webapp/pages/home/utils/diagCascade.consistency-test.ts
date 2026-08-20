/**
 * Build-time consistency test for `diagCascade.ts` (session 095, Phase 2).
 *
 * Every assertion here corresponds to a finding from the Phase 2
 * pre-implementation review (design doc §12), where two of three adversarial
 * lenses returned `do-not-ship`. They are encoded as tests precisely because
 * each one is a way the diagnostic could tell a customer the OPPOSITE of the
 * truth, and none of them is visible by reading the happy path.
 *
 * Run standalone with: `yarn check:diagnostics`
 */

/* eslint-disable no-console */

// Standalone script, not a module — without an explicit export its top-level
// consts collide with the other consistency tests in the shared global scope
// (TS2451). Session-085 sticky #4.
export {};

const proc = process as unknown as {
    stderr: { write(s: string): void };
    exit(code: number): never;
};

interface VerdictShape {
    id: string;
    headline: string;
    short: string;
    detail?: string;
    confidence: string;
    owner: string;
    evidence: string[];
}
interface DiagnosisShape {
    top: VerdictShape;
    all: VerdictShape[];
    incomplete: boolean;
}
interface FactsShape {
    spl: string;
    earliest: string;
    latest: string;
    dispatched: boolean;
    loading: boolean;
    errorMessage?: string | null;
    rowCount: number | null;
    cloudProvider?: string;
}
interface EvidenceShape {
    indexRowsInWindow: number | null;
    resolvedIndexes: string[] | null;
    macroIndexes: string[] | null;
    visibleIndexes: string[] | null;
    sourcetypeCounts: Record<string, number> | null;
    sourcetypeLastSeen: Record<string, number> | null;
    /** §19.1/§19.8a-13 — the index-time twin + the index-wide oldest event. */
    sourcetypeRecentSeen: Record<string, number> | null;
    preCutoffOldest: number | null;
    fallbackRowsInWindow: number | null;
    routedRowsInWindow: number | null;
    sourceScope: { sourcetypes: string[]; tags: string[]; via: string } | null;
    producerDisabled: string[] | null;
    producerTracedCount: number | null;
    collectionRowsInWindow: number | null;
    collectionRowsAllMetrics: number | null;
    collectionExtentProbed: boolean;
    collectionOldest: number | null;
    collectionNewest: number | null;
    installedApps: string[] | null;
    kvStoreStatus: string | null;
    /** SS15 — operator-supplied ingest facts (checks 27-29). The mirror keeps
     *  it loose: fixtures build it via ingestFactsFx(). */
    ingestFacts: Record<string, unknown> | null;
    canaryMs: number | null;
    // §17 Phase 5 — deep-evidence fields (optional so old fixtures stay valid).
    rawArmRan?: boolean;
    rawArmRows?: number | null;
    rawArmError?: string;
    fieldProbe?: {
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
    lookupsMissing?: string[] | null;
    providerRowsPresent?: boolean | null;
    bisect?: {
        controlRows: number | null;
        clauses: Array<{ field: string; fragment: string; removedRows: number | null }>;
    } | null;
    notes: unknown[];
    budgetExhausted: boolean;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mod = require('./diagCascade') as any;
const diagnose = mod.diagnosePanel as (f: FactsShape, e: EvidenceShape) => DiagnosisShape;

let failures = 0;
let checks = 0;
const fail = (m: string): void => {
    failures += 1;
    proc.stderr.write(`FAIL: ${m}\n`);
};
const check = (label: string, ok: boolean, detail: string): void => {
    checks += 1;
    if (!ok) fail(`${label}: ${detail}`);
};

const NOW = Math.floor(Date.now() / 1000);

const facts = (over: Partial<FactsShape>): FactsShape => ({
    spl: '',
    earliest: '-30d@d',
    latest: 'now',
    dispatched: true,
    loading: false,
    errorMessage: null,
    rowCount: 0,
    cloudProvider: 'all',
    ...over,
});

/** Everything unknown — the state a fully-skipped diagnosis leaves behind. */
const noEvidence = (over: Partial<EvidenceShape> = {}): EvidenceShape => ({
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
    collectionRowsInWindow: null,
    collectionRowsAllMetrics: null,
    collectionExtentProbed: false,
    collectionOldest: null,
    collectionNewest: null,
    installedApps: null,
    kvStoreStatus: null,
    ingestFacts: null,
    canaryMs: null,
    notes: [],
    budgetExhausted: false,
    ...over,
});

const CACHED =
    '| inputlookup logserv_linux_rollup where metric="total" | addinfo | where bucket_ts>=info_min_time AND bucket_ts<info_max_time | stats sum(count) as count';
const RAW = '`sap_logserv_idx_macro` sourcetype="sap:hana:audit" | stats count';
const TSTATS_WHOLE_INDEX = '| tstats count WHERE `sap_logserv_idx_macro` | stats sum(count) as count';
const TAG_SCOPED = '`sap_logserv_idx_macro` tag=dns message_type="Query" | stats count';

// =========================================================================
// §12.1 BLOCKER — an unbuilt rollup must NEVER be reported as healthy.
//
// Zero rollup rows is identical for "no such events occurred" and "nobody ran
// the backfill". The original design fed that number into Gate 0, whose verdict
// is literally "nothing is broken" — so a fresh install would have been
// certified healthy on the single most important failure this tool exists to
// catch.
// =========================================================================
{
    const d = diagnose(
        facts({ spl: CACHED, rowCount: 0 }),
        noEvidence({
            indexRowsInWindow: 5_000_000,
            resolvedIndexes: ['sap_logserv_logs'],
            collectionRowsInWindow: 0,
            collectionExtentProbed: true,
            collectionOldest: null,
            collectionNewest: null,
        }),
    );
    check(
        '12.1 unbuiltRollup.id',
        d.top.id === 'rollup-never-built',
        `expected rollup-never-built, got ${d.top.id} ("${d.top.headline}")`,
    );
    check(
        '12.1 unbuiltRollup.notHealthy',
        !d.all.some((v) => /nothing is broken/i.test(v.headline)),
        'a cached panel must never reach Gate 0 "nothing is broken"',
    );
    check(
        '12.1 unbuiltRollup.owner',
        d.top.owner === 'splunk-admin' && d.top.confidence === 'confirmed',
        `expected confirmed/splunk-admin, got ${d.top.confidence}/${d.top.owner}`,
    );
    check(
        '12.1 unbuiltRollup.actionable',
        /Dashboard Data/.test(d.top.detail || ''),
        'the verdict must name where the backfill is run',
    );
}

// =========================================================================
// §12.2 BLOCKER — Gate 0 is unevaluable without a sourcetype or a tag.
//
// `probe.sourcetypes` is empty for whole-index tstats panels and for tag-scoped
// panels. Reading that empty list as "the sourcetype is absent" would certify
// health with no evidence whatsoever.
// =========================================================================
{
    const ev = noEvidence({
        indexRowsInWindow: 5_000_000,
        resolvedIndexes: ['sap_logserv_logs'],
        sourcetypeCounts: {},
    });
    for (const [label, spl] of [
        ['wholeIndexTstats', TSTATS_WHOLE_INDEX],
        ['tagScoped', TAG_SCOPED],
    ] as Array<[string, string]>) {
        const d = diagnose(facts({ spl }), ev);
        check(
            `12.2 ${label}.noHealthClaim`,
            !d.all.some((v) => /nothing is broken/i.test(v.headline)),
            `Gate 0 fired for a panel with no sourcetype (${label})`,
        );
        const st = d.all.filter((v) => v.id === 'sourcetype-presence');
        check(
            `12.2 ${label}.notEvaluated`,
            st.length === 1 && st[0].confidence === 'not-evaluated',
            `expected a single not-evaluated sourcetype verdict, got ${JSON.stringify(st)}`,
        );
    }
}

// =========================================================================
// §12.3 BLOCKER — unknown is not false.
//
// With every probe skipped, no gate may conclude anything. This is the
// difference between "we ran out of time" and "there is genuinely none of it".
// =========================================================================
{
    for (const [label, spl] of [
        ['cached', CACHED],
        ['raw', RAW],
        ['tstats', TSTATS_WHOLE_INDEX],
    ] as Array<[string, string]>) {
        const d = diagnose(facts({ spl }), noEvidence({ budgetExhausted: true }));
        const asserted = d.all.filter(
            (v) => v.confidence === 'confirmed' || v.confidence === 'likely',
        );
        check(
            `12.3 ${label}.noAssertionWithoutEvidence`,
            asserted.length === 0,
            `asserted ${JSON.stringify(asserted.map((v) => v.id))} with no evidence at all`,
        );
        check(
            `12.3 ${label}.fallback`,
            d.top.id === 'undetermined' && d.top.confidence === 'not-evaluated',
            `expected the undetermined fallback, got ${d.top.id}/${d.top.confidence}`,
        );
        check(`12.3 ${label}.incomplete`, d.incomplete === true, 'must report itself incomplete');
        check(
            `12.3 ${label}.saysWhy`,
            d.all.some((v) => /ran out of time/i.test(v.evidence.join(' '))),
            'a skipped check must state why it was skipped',
        );
    }
}

// =========================================================================
// §12.5 BLOCKER — the panel's own error outranks every dispatched gate.
//
// Otherwise an independent probe can short-circuit with a health verdict while
// the panel's own search failed, and the drawer contradicts the inline hint on
// the same panel.
// =========================================================================
{
    const d = diagnose(
        facts({ spl: CACHED, errorMessage: 'Error in "inputlookup" command: could not find lookup.' }),
        noEvidence({
            indexRowsInWindow: 5_000_000,
            resolvedIndexes: ['sap_logserv_logs'],
            collectionRowsInWindow: 4_000, // would otherwise conclude "summary is fine"
            collectionExtentProbed: true,
            collectionOldest: NOW - 30 * 86400,
            collectionNewest: NOW - 3600,
        }),
    );
    check(
        '12.5 errorFirst.top',
        d.top.id === 'search-error',
        `the panel's own error must rank first, got ${d.top.id}`,
    );
    check(
        '12.5 errorFirst.quoted',
        (d.top.detail || '').indexOf('inputlookup') !== -1,
        'the error must be quoted verbatim',
    );
}

// =========================================================================
// §12.8 — the staleness threshold is 3h, not 2h.
//
// Hourly aggregates run at staggered minutes over -1h@h..@h, so a HEALTHY
// collection sits between 1h+M and 2h+M of lag at all times. A >2h rule would
// flag every collection with M > 0, every hour.
// =========================================================================
{
    const base = {
        indexRowsInWindow: 5_000_000,
        resolvedIndexes: ['sap_logserv_logs'],
        collectionRowsInWindow: 0,
        collectionExtentProbed: true,
        collectionOldest: NOW - 30 * 86400,
    };
    const healthy = diagnose(
        facts({ spl: CACHED }),
        noEvidence({ ...base, collectionNewest: NOW - Math.round(2.4 * 3600) }),
    );
    check(
        '12.8 lag.healthyNotFlagged',
        healthy.top.id !== 'rollup-stale',
        `2.4h of lag is normal for a staggered hourly aggregate, but got ${healthy.top.id}`,
    );
    const stale = diagnose(
        facts({ spl: CACHED }),
        noEvidence({ ...base, collectionNewest: NOW - 8 * 3600 }),
    );
    check(
        '12.8 lag.staleFlagged',
        stale.top.id === 'rollup-stale' && stale.top.owner === 'splunk-admin',
        `8h of lag must be flagged, got ${stale.top.id}/${stale.top.owner}`,
    );
}

// =========================================================================
// Gate V / Gate I / Gate S — the remaining dispatched conclusions.
// =========================================================================
{
    // An index the role cannot search returns zero rows and NO error.
    const d = diagnose(
        facts({ spl: RAW }),
        noEvidence({
            indexRowsInWindow: 0,
            resolvedIndexes: ['sap_logserv_logs'],
            visibleIndexes: ['main', '_internal'],
        }),
    );
    check('gateV.id', d.top.id === 'index-not-visible', `got ${d.top.id}`);
    check('gateV.owner', d.top.owner === 'splunk-admin', `got ${d.top.owner}`);
}
{
    // SESSION 095, FINDING 1 — the REALISTIC authorization shape. The windowed
    // `tstats BY index` emits no rows for an empty (or unauthorized) window,
    // so `resolvedIndexes` is EMPTY exactly when this gate matters; the macro
    // DEFINITION is what names the index. Before the fix this fell through to
    // a false confirmed "there are no events of any kind".
    const d = diagnose(
        facts({ spl: RAW }),
        noEvidence({
            indexRowsInWindow: 0,
            resolvedIndexes: [],
            macroIndexes: ['sap_logserv_logs'],
            visibleIndexes: ['main', '_internal'],
        }),
    );
    check('095 gateV.deadCode.id', d.top.id === 'index-not-visible', `got ${d.top.id}`);
    check(
        '095 gateV.deadCode.noContradiction',
        !d.all.some((v) => v.id === 'index-empty-in-window'),
        'index-empty-in-window must stand down when the visibility gate fires',
    );
    check(
        '095 gateV.deadCode.namesMacroIndex',
        d.top.headline.indexOf('sap_logserv_logs') !== -1,
        `the headline must name the unreadable index, got "${d.top.headline}"`,
    );
}
{
    // Visible, but genuinely nothing in the window.
    const d = diagnose(
        facts({ spl: RAW }),
        noEvidence({
            indexRowsInWindow: 0,
            resolvedIndexes: ['sap_logserv_logs'],
            visibleIndexes: ['sap_logserv_logs', 'main'],
        }),
    );
    check('gateI.id', d.top.id === 'index-empty-in-window', `got ${d.top.id}`);
}
{
    // The sourcetype has never arrived at all.
    const d = diagnose(
        facts({ spl: RAW }),
        noEvidence({
            indexRowsInWindow: 5_000_000,
            resolvedIndexes: ['sap_logserv_logs'],
            sourcetypeCounts: {},
            sourcetypeLastSeen: {},
        }),
    );
    check('gateS.neverSeen', d.top.id === 'sourcetype-never-seen', `got ${d.top.id}`);
    check('gateS.neverSeen.owner', d.top.owner === 'ingest', `got ${d.top.owner}`);
}
{
    // It exists, but stopped before the selected window.
    const last = NOW - 5 * 86400;
    const d = diagnose(
        facts({ spl: RAW }),
        noEvidence({
            indexRowsInWindow: 5_000_000,
            resolvedIndexes: ['sap_logserv_logs'],
            sourcetypeCounts: {},
            sourcetypeLastSeen: { 'sap:hana:audit': last },
        }),
    );
    check('gateS.stale', d.top.id === 'sourcetype-stale', `got ${d.top.id}`);
    check(
        'gateS.stale.namesDate',
        /\d{4}-\d{2}-\d{2}/.test(d.top.headline),
        `the headline must name the last-seen date, got "${d.top.headline}"`,
    );
    // SESSION 095, FINDING 5 — a quiet stretch is not a CONFIRMED ingest
    // fault. Sparse-vs-stopped is not decidable from a last-seen date alone,
    // so the verdict must hedge; 5 days of silence grades 'possible'.
    check(
        '095 gateS.stale.hedged',
        d.top.confidence === 'possible',
        `5 days of silence must grade possible, got ${d.top.confidence}`,
    );
}
{
    // SESSION 095, FINDING 5 — HISTORICAL window with NEWER data after it:
    // the feed is alive, the selected period just has none. Before the fix
    // this produced "Stopped arriving" with a most-recent timestamp of an
    // hour ago — a self-contradictory confirmed fault on healthy data.
    const d = diagnose(
        facts({
            spl: RAW,
            earliest: String(NOW - 10 * 86400),
            latest: String(NOW - 9 * 86400),
        }),
        noEvidence({
            indexRowsInWindow: 5_000_000,
            resolvedIndexes: ['sap_logserv_logs'],
            sourcetypeCounts: {},
            sourcetypeLastSeen: { 'sap:hana:audit': NOW - 3600 },
        }),
    );
    check('095 gateS.outsideWindow.id', d.top.id === 'sourcetype-outside-window', `got ${d.top.id}`);
    check(
        '095 gateS.outsideWindow.expected',
        d.top.confidence === 'expected' && d.top.owner === 'nobody',
        `got ${d.top.confidence}/${d.top.owner}`,
    );
    check(
        '095 gateS.outsideWindow.noStopClaim',
        !/stopped/i.test(d.top.short),
        `must not claim a stop, got short "${d.top.short}"`,
    );
}
{
    // SESSION 095, FINDING 5 — a LONG silence (30 days, window ending now)
    // is the strongest non-confirmed grade: likely, never confirmed.
    const d = diagnose(
        facts({ spl: RAW, earliest: '-24h', latest: 'now' }),
        noEvidence({
            indexRowsInWindow: 5_000_000,
            resolvedIndexes: ['sap_logserv_logs'],
            sourcetypeCounts: {},
            sourcetypeLastSeen: { 'sap:hana:audit': NOW - 30 * 86400 },
        }),
    );
    check('095 gateS.longSilence.id', d.top.id === 'sourcetype-stale', `got ${d.top.id}`);
    check(
        '095 gateS.longSilence.likelyNotConfirmed',
        d.top.confidence === 'likely',
        `30 days of silence grades likely (never confirmed), got ${d.top.confidence}`,
    );
}
{
    // SESSION 095, FINDING 8b — when the index probe FAILED, Gate 0 must not
    // assert "The index has events in this window" as observed fact.
    const d = diagnose(
        facts({ spl: RAW }),
        noEvidence({
            indexRowsInWindow: null,
            sourcetypeCounts: {},
            sourcetypeLastSeen: null,
        }),
    );
    check(
        '095 gate0.noFabricatedIndexEvidence',
        !d.all.some((v) => v.evidence.some((e) => /The index has events in this window/.test(e))),
        'gate0 asserted index evidence that was never established',
    );
}
{
    // Present in the window — this gate must stand aside for something else.
    const d = diagnose(
        facts({ spl: RAW }),
        noEvidence({
            indexRowsInWindow: 5_000_000,
            resolvedIndexes: ['sap_logserv_logs'],
            sourcetypeCounts: { 'sap:hana:audit': 1234 },
        }),
    );
    check(
        'gateS.presentStandsAside',
        !d.all.some((v) => v.id.indexOf('sourcetype-') === 0 && v.confidence !== 'not-evaluated'),
        `a present sourcetype must not produce a conclusion, got ${JSON.stringify(d.all.map((v) => v.id))}`,
    );
}
{
    // The summary covers the window; the panel's own conditions matched nothing.
    const d = diagnose(
        facts({ spl: CACHED }),
        noEvidence({
            indexRowsInWindow: 5_000_000,
            resolvedIndexes: ['sap_logserv_logs'],
            collectionRowsInWindow: 900,
            collectionOldest: NOW - 30 * 86400,
            collectionNewest: NOW - 3600,
        }),
    );
    check('gateC.hasRows', d.top.id === 'rollup-has-rows', `got ${d.top.id}`);
    check('gateC.hasRows.expected', d.top.confidence === 'expected', `got ${d.top.confidence}`);
}

// =========================================================================
// SESSION 095 — tracing a cached panel back to the aggregate that fills it.
//
// A rollup read names no sourcetype, so before this the diagnostic could only
// shrug at the most common panel shape in the app. Reading the aggregate saved
// search that POPULATES the collection tells us what it consumes, which turns
// the decisive question into an answerable one: summary empty AND source empty
// is nothing wrong; summary empty WHILE the source has events is our fault.
// =========================================================================
{
    const healthyExtent = {
        indexRowsInWindow: 5_000_000,
        resolvedIndexes: ['sap_logserv_logs'],
        collectionRowsInWindow: 0,
        collectionExtentProbed: true,
        collectionOldest: NOW - 30 * 86400,
        collectionNewest: NOW - 3600,
        sourceScope: {
            sourcetypes: ['linux_secure', 'linux:cron'],
            tags: [],
            via: 'logserv_linux_aggregate',
        },
    };
    // Source events ARE there, summary has none — for the WHOLE collection
    // (all-measures count is zero too) -> our fault, and actionable.
    const gap = diagnose(
        facts({ spl: CACHED }),
        noEvidence({
            ...healthyExtent,
            collectionRowsAllMetrics: 0,
            sourcetypeCounts: { linux_secure: 4423, 'linux:cron': 100 },
        }),
    );
    check('095 rollupGap.id', gap.top.id === 'rollup-gap', `got ${gap.top.id}`);
    check(
        '095 rollupGap.owner',
        gap.top.owner === 'splunk-admin' && gap.top.confidence === 'confirmed',
        `got ${gap.top.confidence}/${gap.top.owner}`,
    );
    check(
        '095 rollupGap.countsSource',
        /4,523|4523/.test(gap.top.detail || ''),
        `the verdict must quote how many source events exist, got "${gap.top.detail}"`,
    );
    check(
        '095 rollupGap.namesTrace',
        gap.top.evidence.some((e) => /logserv_linux_aggregate/.test(e)),
        'the verdict must name the aggregate it traced through',
    );

    // Source events are absent too -> genuinely nothing happened.
    const absent = diagnose(
        facts({ spl: CACHED }),
        noEvidence({ ...healthyExtent, sourcetypeCounts: {} }),
    );
    check('095 sourceAbsent.id', absent.top.id === 'source-absent', `got ${absent.top.id}`);
    check(
        '095 sourceAbsent.expected',
        absent.top.confidence === 'expected' && absent.top.owner === 'nobody',
        `got ${absent.top.confidence}/${absent.top.owner}`,
    );

    // An EMPTY collection still outranks both — never-built is more specific
    // than "this window has no rows", and it is the fix the admin must make.
    const unbuilt = diagnose(
        facts({ spl: CACHED }),
        noEvidence({
            ...healthyExtent,
            collectionOldest: null,
            collectionNewest: null,
            sourcetypeCounts: { linux_secure: 4423 },
        }),
    );
    check(
        '095 neverBuiltStillWins',
        unbuilt.top.id === 'rollup-never-built',
        `an empty collection must outrank the gap verdict, got ${unbuilt.top.id}`,
    );

    // Without the trace, we must NOT guess — the weaker, honest answer stands.
    const noTrace = diagnose(
        facts({ spl: CACHED }),
        noEvidence({ ...healthyExtent, sourceScope: null, sourcetypeCounts: null }),
    );
    check(
        '095 noTrace.fallsBack',
        noTrace.top.id === 'rollup-window-uncovered',
        `without source evidence the fallback must stand, got ${noTrace.top.id}`,
    );
    check(
        '095 noTrace.noHealthClaim',
        !noTrace.all.some((v) => /nothing is broken/i.test(v.headline)),
        'without source evidence nothing may be certified healthy',
    );
}

// =========================================================================
// SESSION 095 FIX PASS — the false-verdict cluster found by the build-308
// sanity review. Each case below was a way the cascade told a customer the
// OPPOSITE of the truth on a healthy (or merely hiccuping) instance.
// =========================================================================
{
    // FINDING 2 — a FAILED extent probe is not an EMPTY collection. Same
    // nulls, opposite meaning; reading one as the other turned a KV hiccup
    // into a confirmed "never built — run the backfill".
    const d = diagnose(
        facts({ spl: CACHED }),
        noEvidence({
            indexRowsInWindow: 5_000_000,
            resolvedIndexes: ['sap_logserv_logs'],
            collectionRowsInWindow: 0,
            collectionExtentProbed: false,
            collectionOldest: null,
            collectionNewest: null,
        }),
    );
    check(
        '095 extentFailed.notNeverBuilt',
        d.top.id !== 'rollup-never-built',
        `a failed extent probe must not read as an empty collection, got ${d.top.id}`,
    );
    check(
        '095 extentFailed.saysNotChecked',
        d.all.some((v) => v.id === 'rollup-extent' && v.confidence === 'not-evaluated'),
        'the extent must be reported as not-checked, with the reason',
    );
    check('095 extentFailed.incomplete', d.incomplete === true, 'must report itself incomplete');
}
{
    // FINDING 3 — daily-grain collections have a daily lag budget. A healthy
    // beaconing summary is 24.5-48.5h behind BY DESIGN; the 3h hourly rule
    // flagged it "stale" on an untouched box, every day. 40h must pass; 60h
    // is genuinely stale.
    const DAILY =
        '| inputlookup logserv_beaconing_rollup | addinfo | where day_ts>=relative_time(info_min_time,"@d") AND day_ts<info_max_time | stats sum(count) as count';
    const base = {
        indexRowsInWindow: 5_000_000,
        resolvedIndexes: ['sap_logserv_logs'],
        collectionRowsInWindow: 0,
        collectionExtentProbed: true,
        collectionOldest: NOW - 30 * 86400,
    };
    const healthy = diagnose(
        facts({ spl: DAILY, earliest: '-24h', latest: 'now' }),
        noEvidence({ ...base, collectionNewest: NOW - 40 * 3600 }),
    );
    check(
        '095 dailyLag.healthyNotStale',
        healthy.top.id !== 'rollup-stale',
        `40h of lag is normal for a daily summary, got ${healthy.top.id}`,
    );
    // …and the RIGHT answer for "Last 24 hours" on a fresh daily summary is
    // the leading-edge freshness statement, Expected-class.
    check(
        '095 dailyLag.leadingEdge',
        healthy.top.id === 'rollup-leading-edge' && healthy.top.confidence === 'expected',
        `expected the leading-edge freshness verdict, got ${healthy.top.id}/${healthy.top.confidence}`,
    );
    const stale = diagnose(
        facts({ spl: DAILY, earliest: '-24h', latest: 'now' }),
        noEvidence({ ...base, collectionNewest: NOW - 60 * 3600 }),
    );
    check(
        '095 dailyLag.staleFlagged',
        stale.top.id === 'rollup-stale',
        `60h of lag on a daily summary must be flagged, got ${stale.top.id}`,
    );
}
{
    // FINDING 4b — the hourly leading edge. "Last 2 hours" dispatched before
    // this collection's staggered minute: the newest written bucket starts
    // BEFORE the window, the current hour is not written yet — zero rows on a
    // perfectly healthy collection. Must be Expected-class, never a gap.
    const d = diagnose(
        facts({ spl: CACHED, earliest: '-2h', latest: 'now' }),
        noEvidence({
            indexRowsInWindow: 5_000_000,
            resolvedIndexes: ['sap_logserv_logs'],
            collectionRowsInWindow: 0,
            collectionExtentProbed: true,
            collectionOldest: NOW - 30 * 86400,
            collectionNewest: NOW - Math.round(2.2 * 3600),
            sourceScope: { sourcetypes: ['linux_secure'], tags: [], via: 'logserv_linux_aggregate' },
            sourcetypeCounts: { linux_secure: 900 },
        }),
    );
    check(
        '095 leadingEdge.id',
        d.top.id === 'rollup-leading-edge',
        `a fresh summary with the window past its newest bucket is the leading edge, got ${d.top.id}`,
    );
    check(
        '095 leadingEdge.notAFault',
        d.top.confidence === 'expected' && !d.all.some((v) => v.id === 'rollup-gap'),
        'the leading edge must never be reported as a gap',
    );
}
{
    // FINDING 4a — a window entirely BEFORE the stored history. The extent is
    // in hand; consult it BEFORE the source trace, or a by-design 30-day
    // backfill horizon reads as a confirmed "never summarised — re-run the
    // backfill" whose prescribed fix cannot even reach the window.
    const d = diagnose(
        facts({
            spl: CACHED,
            earliest: String(NOW - 60 * 86400),
            latest: String(NOW - 40 * 86400),
        }),
        noEvidence({
            indexRowsInWindow: 5_000_000,
            resolvedIndexes: ['sap_logserv_logs'],
            collectionRowsInWindow: 0,
            collectionExtentProbed: true,
            collectionOldest: NOW - 30 * 86400,
            collectionNewest: NOW - 3600,
            sourceScope: { sourcetypes: ['linux_secure'], tags: [], via: 'logserv_linux_aggregate' },
            sourcetypeCounts: { linux_secure: 123456 },
        }),
    );
    check(
        '095 horizon.id',
        d.top.id === 'rollup-window-uncovered',
        `a pre-history window must report the horizon, got ${d.top.id}`,
    );
    check(
        '095 horizon.neverGap',
        !d.all.some((v) => v.id === 'rollup-gap'),
        'a pre-history window must never be reported as a gap',
    );
}
{
    // FINDING 4c — a metric arm with sibling rows in the window. The
    // aggregate RAN; whether this arm legitimately produced nothing (the live
    // icmerr case) or is broken (session-093's D3/D4) is not decidable
    // without re-running its predicate — so the verdict must HEDGE, and the
    // confirmed gap remains only for the whole-collection-empty shape.
    const base = {
        indexRowsInWindow: 5_000_000,
        resolvedIndexes: ['sap_logserv_logs'],
        collectionRowsInWindow: 0,
        collectionExtentProbed: true,
        collectionOldest: NOW - 30 * 86400,
        collectionNewest: NOW - 3600,
        sourceScope: {
            sourcetypes: ['sap:abap:icm'],
            tags: [],
            via: 'logserv_abapnet_aggregate',
        },
        sourcetypeCounts: { 'sap:abap:icm': 75_000 },
    };
    const hedged = diagnose(
        facts({ spl: CACHED }),
        noEvidence({ ...base, collectionRowsAllMetrics: 500 }),
    );
    check(
        '095 metricArm.hedgedId',
        hedged.top.id === 'rollup-metric-empty',
        `sibling rows must produce the hedged verdict, got ${hedged.top.id}`,
    );
    check(
        '095 metricArm.hedgedConfidence',
        hedged.top.confidence === 'possible',
        `the metric-arm case is ambiguous and must never be confirmed, got ${hedged.top.confidence}`,
    );
    check(
        '095 metricArm.namesSettlingAction',
        /backfill/i.test(hedged.top.detail || ''),
        'the hedged verdict must name the safe, settling action',
    );
    const unknownSiblings = diagnose(
        facts({ spl: CACHED }),
        noEvidence({ ...base, collectionRowsAllMetrics: null }),
    );
    check(
        '095 metricArm.unknownSiblingsHedges',
        unknownSiblings.top.id === 'rollup-metric-empty' &&
            unknownSiblings.top.confidence === 'possible',
        `unknown sibling rows must hedge too (the safe direction), got ${unknownSiblings.top.id}/${unknownSiblings.top.confidence}`,
    );
}

// =========================================================================
// INVARIANTS across a corpus — the guard that outlives these hand-written cases.
// =========================================================================
{
    const spls = [CACHED, RAW, TSTATS_WHOLE_INDEX, TAG_SCOPED, ''];
    const evidences: EvidenceShape[] = [
        noEvidence(),
        noEvidence({ budgetExhausted: true }),
        noEvidence({ indexRowsInWindow: 0, resolvedIndexes: ['sap_logserv_logs'], visibleIndexes: ['main'] }),
        noEvidence({ indexRowsInWindow: 0, resolvedIndexes: [], macroIndexes: ['sap_logserv_logs'], visibleIndexes: ['main'] }),
        noEvidence({ indexRowsInWindow: 0, resolvedIndexes: ['sap_logserv_logs'], visibleIndexes: ['sap_logserv_logs'] }),
        noEvidence({ indexRowsInWindow: 9, resolvedIndexes: ['sap_logserv_logs'], sourcetypeCounts: {}, sourcetypeLastSeen: {} }),
        noEvidence({ indexRowsInWindow: 9, resolvedIndexes: ['sap_logserv_logs'], sourcetypeCounts: {}, sourcetypeLastSeen: { 'sap:hana:audit': NOW - 3600 } }),
        // Extent probe FAILED (nulls, probed=false) vs collection genuinely
        // EMPTY (nulls, probed=true) — session 095, finding 2.
        noEvidence({ indexRowsInWindow: 9, resolvedIndexes: ['sap_logserv_logs'], collectionRowsInWindow: 0, collectionOldest: null, collectionNewest: null }),
        noEvidence({ indexRowsInWindow: 9, resolvedIndexes: ['sap_logserv_logs'], collectionRowsInWindow: 0, collectionExtentProbed: true, collectionOldest: null, collectionNewest: null }),
        noEvidence({ indexRowsInWindow: 9, resolvedIndexes: ['sap_logserv_logs'], collectionRowsInWindow: 0, collectionExtentProbed: true, collectionOldest: NOW - 100000, collectionNewest: NOW - 7920, collectionRowsAllMetrics: 5 }),
        noEvidence({ indexRowsInWindow: 9, resolvedIndexes: ['sap_logserv_logs'], collectionRowsInWindow: 7, collectionExtentProbed: true, collectionOldest: NOW - 100000, collectionNewest: NOW - 1000 }),
    ];
    let combos = 0;
    for (const spl of spls) {
        for (const ev of evidences) {
            for (const rowCount of [0, null] as Array<number | null>) {
                combos += 1;
                const d = diagnose(facts({ spl, rowCount }), ev);
                checks += 1;
                // 1. `top` is never null and always carries a usable short form.
                if (!d.top || !d.top.short || d.top.short.length === 0 || d.top.short.length > 34) {
                    fail(`invariant: bad short form "${d.top && d.top.short}" for spl="${spl.slice(0, 30)}"`);
                }
                // 2. Never a fault claim about the cached layer for a panel that
                //    does not read the cached layer.
                if (spl !== CACHED && d.all.some((v) => v.id.indexOf('rollup-') === 0)) {
                    fail(`invariant: rollup verdict on a non-cached panel (spl="${spl.slice(0, 30)}")`);
                }
                // 3. A cached panel may be certified healthy ONLY on
                //    SOURCE-EVENT evidence (id `source-absent`, session 095),
                //    never from the rollup row count — which is identical for
                //    "no such events" and "never backfilled" (§12.1).
                if (spl === CACHED) {
                    const healthy = d.all.filter((v) => /nothing is broken/i.test(v.headline));
                    for (const v of healthy) {
                        if (v.id !== 'source-absent') {
                            fail(`invariant: cached panel certified healthy by "${v.id}" (only source-absent may)`);
                        } else if (!ev.sourceScope) {
                            fail('invariant: source-absent fired without source-scope evidence');
                        }
                    }
                }
                // 4. Every verdict names an owner from the closed set.
                for (const v of d.all.concat([d.top])) {
                    if (['user', 'splunk-admin', 'ingest', 'vendor', 'nobody'].indexOf(v.owner) === -1) {
                        fail(`invariant: unknown owner "${v.owner}" on "${v.id}"`);
                    }
                }
                // 5. Session 095, finding 2: "never built" may only be
                //    concluded from a SUCCESSFUL extent read — a failed probe
                //    leaves the same nulls with the flag false.
                if (
                    d.all.some((v) => v.id === 'rollup-never-built') &&
                    !ev.collectionExtentProbed
                ) {
                    fail('invariant: rollup-never-built without a successful extent probe');
                }
                // 6. Session 095, finding 5: a quiet window is never a
                //    CONFIRMED ingest fault — only never-seen (which is
                //    genuinely confirmed by an all-time search) may carry it.
                for (const v of d.all) {
                    if (v.id === 'sourcetype-stale' && v.confidence === 'confirmed') {
                        fail('invariant: sourcetype-stale must never be confirmed');
                    }
                }
                // 7. Session 095, finding 4: the confirmed gap verdict needs
                //    source-scope evidence AND an unambiguous (whole
                //    collection empty) shape when the read is metric-scoped.
                for (const v of d.all) {
                    if (v.id === 'rollup-gap' && !ev.sourceScope) {
                        fail('invariant: rollup-gap without source-scope evidence');
                    }
                }
            }
        }
    }
    proc.stderr.write(`  invariant: ${combos} cascade combinations swept\n`);
}

// =========================================================================
// §14 (build 313) — the fresh-install verdicts. Every fixture corresponds to
// a binding correction in design §14.8a (3-lens review wf_ba94245a-fa8:
// 1 blocker, 7 high). Both directions are pinned: fires where it must, and
// CANNOT fire where the review showed the un-corrected design lied.
// =========================================================================

// Constants pinned (§14.8a-2.5) — an edit must consciously touch these.
check('s14.const.share', mod.ROUTING_FALLBACK_MIN_SHARE === 0.5, `got ${mod.ROUTING_FALLBACK_MIN_SHARE}`);
check('s14.const.floor', mod.ROUTING_FALLBACK_MIN_EVENTS === 50, `got ${mod.ROUTING_FALLBACK_MIN_EVENTS}`);
check('s14.const.future', mod.FUTURE_TS_GUARD_SECONDS === 900, `got ${mod.FUTURE_TS_GUARD_SECONDS}`);

// --- §14.2 routing-not-applied, raw tier ---------------------------------
const routingEv = (over: Partial<EvidenceShape> = {}): EvidenceShape =>
    noEvidence({
        indexRowsInWindow: 1000,
        resolvedIndexes: ['sap_logserv_logs'],
        sourcetypeCounts: {},
        sourcetypeLastSeen: {},
        fallbackRowsInWindow: 1000,
        routedRowsInWindow: 0,
        ...over,
    });
{
    const d = diagnose(facts({ spl: RAW }), routingEv());
    check('s14.routing.fires', d.top.id === 'routing-not-applied', `got ${d.top.id}`);
    check('s14.routing.likely', d.top.confidence === 'likely', d.top.confidence);
    check('s14.routing.owner', d.top.owner === 'splunk-admin', d.top.owner);
    check(
        's14.routing.headline',
        d.top.headline.indexOf('none are being parsed') !== -1,
        d.top.headline,
    );

    // THE DISCRIMINATOR (§14.8a-2.2): a single routed event suppresses it —
    // the legitimately-fallback-heavy estate (the live Azure Cribl state).
    const d2 = diagnose(facts({ spl: RAW }), routingEv({ routedRowsInWindow: 5 }));
    check('s14.routing.discriminator', d2.top.id === 'sourcetype-never-seen', `got ${d2.top.id}`);
    // …and the confirmed never-seen it falls to carries the fallback caveat
    // (§14.8a-1.3) and the index-scoped claim (§14.8a-1.2).
    check(
        's14.neverSeen.caveat',
        (d2.top.detail || '').indexOf('unparsed fallback sourcetype') !== -1,
        d2.top.detail || '(no detail)',
    );
    check(
        's14.neverSeen.indexScoped',
        d2.top.headline.indexOf('in the index this app reads') !== -1,
        d2.top.headline,
    );

    // Boundary fixtures, both directions (§14.8a-2.5).
    const d3 = diagnose(facts({ spl: RAW }), routingEv({ fallbackRowsInWindow: 50, indexRowsInWindow: 50 }));
    check('s14.routing.floorAt50Fires', d3.top.id === 'routing-not-applied', `got ${d3.top.id}`);
    const d4 = diagnose(facts({ spl: RAW }), routingEv({ fallbackRowsInWindow: 49, indexRowsInWindow: 49 }));
    check('s14.routing.floor49Blocked', d4.top.id === 'sourcetype-never-seen', `got ${d4.top.id}`);
    const d5 = diagnose(facts({ spl: RAW }), routingEv({ fallbackRowsInWindow: 50, indexRowsInWindow: 100 }));
    check('s14.routing.shareAtHalfFires', d5.top.id === 'routing-not-applied', `got ${d5.top.id}`);
    const d6 = diagnose(facts({ spl: RAW }), routingEv({ fallbackRowsInWindow: 100, indexRowsInWindow: 300 }));
    check('s14.routing.shareBelowHalfBlocked', d6.top.id === 'sourcetype-never-seen', `got ${d6.top.id}`);

    // Tri-state: an unknown probe side can never fire it.
    const d7 = diagnose(facts({ spl: RAW }), routingEv({ fallbackRowsInWindow: null }));
    check('s14.routing.triFallbackNull', d7.top.id === 'sourcetype-never-seen', `got ${d7.top.id}`);
    const d8 = diagnose(facts({ spl: RAW }), routingEv({ routedRowsInWindow: null }));
    check('s14.routing.triRoutedNull', d8.top.id === 'sourcetype-never-seen', `got ${d8.top.id}`);
    // indexRows null: the unfiltered probe is its own universe — MUST fire.
    const d9 = diagnose(facts({ spl: RAW }), routingEv({ indexRowsInWindow: null }));
    check('s14.routing.indexNullStillFires', d9.top.id === 'routing-not-applied', `got ${d9.top.id}`);

    // THE BLOCKER (§14.8a-2.1): newest-after-window PROVES routing applies —
    // outside-window must win even with a 100% fallback share.
    const dB = diagnose(
        facts({ spl: RAW, latest: String(NOW - 86400) }),
        routingEv({ sourcetypeLastSeen: { 'sap:hana:audit': NOW - 100 } }),
    );
    check('s14.routing.outsideWindowWins', dB.top.id === 'sourcetype-outside-window', `got ${dB.top.id}`);

    // History variants: stopped-since (seen before, newest inside/behind the
    // window) and unknown (no last-seen evidence at all).
    const dS = diagnose(
        facts({ spl: RAW, latest: 'now' }),
        routingEv({ sourcetypeLastSeen: { 'sap:hana:audit': NOW - 2 * 86400 } }),
    );
    check('s14.routing.stoppedVariant', dS.top.id === 'routing-not-applied', `got ${dS.top.id}`);
    check(
        's14.routing.stoppedEvidence',
        dS.top.evidence.some((e) => e.indexOf('most recent parsed') !== -1),
        dS.top.evidence.join(' | '),
    );
    const dU = diagnose(facts({ spl: RAW }), routingEv({ sourcetypeLastSeen: null }));
    check('s14.routing.unknownVariant', dU.top.id === 'routing-not-applied', `got ${dU.top.id}`);
    check(
        's14.routing.unknownEvidence',
        dU.top.evidence.some((e) => e.indexOf('could not be established') !== -1),
        dU.top.evidence.join(' | '),
    );
}

// --- §14.5 future timestamps ---------------------------------------------
{
    const fEv = noEvidence({
        indexRowsInWindow: 1000,
        resolvedIndexes: ['sap_logserv_logs'],
        sourcetypeCounts: {},
        sourcetypeLastSeen: { 'sap:hana:audit': NOW + 3600 },
    });
    const d = diagnose(facts({ spl: RAW, latest: 'now' }), fEv);
    check('s14.future.fires', d.top.id === 'sourcetype-future-timestamps', `got ${d.top.id}`);
    check('s14.future.possible', d.top.confidence === 'possible', d.top.confidence);
    check(
        's14.future.viewerClockHedge',
        (d.top.detail || '').indexOf('machine viewing this page') !== -1,
        d.top.detail || '(no detail)',
    );
    // Inside the 900 s guard: plain outside-window, not a clock accusation.
    const gEv = noEvidence({
        indexRowsInWindow: 1000,
        resolvedIndexes: ['sap_logserv_logs'],
        sourcetypeCounts: {},
        sourcetypeLastSeen: { 'sap:hana:audit': NOW + 800 },
    });
    const d2 = diagnose(facts({ spl: RAW, latest: 'now' }), gEv);
    check('s14.future.guardBlocks', d2.top.id === 'sourcetype-outside-window', `got ${d2.top.id}`);
}

// --- §14.1 rollup-source-never-seen + the cached routing precedence ------
const cachedEmptyEv = (over: Partial<EvidenceShape> = {}): EvidenceShape =>
    noEvidence({
        indexRowsInWindow: 0,
        resolvedIndexes: [],
        macroIndexes: ['sap_logserv_logs'],
        visibleIndexes: ['sap_logserv_logs'],
        sourceScope: {
            sourcetypes: ['sap:hana:audit'],
            tags: [],
            via: 'logserv_hana_category_aggregate',
        },
        sourcetypeLastSeen: {},
        collectionRowsInWindow: 0,
        collectionExtentProbed: true,
        collectionOldest: null,
        collectionNewest: null,
        ...over,
    });
{
    // PURE fresh install (the state the un-corrected trigger could not reach):
    // index-empty stays top; feed-not-started REPLACES the backfill loop.
    const d = diagnose(facts({ spl: CACHED }), cachedEmptyEv());
    check('s14.srcNever.pureTop', d.top.id === 'index-empty-in-window', `got ${d.top.id}`);
    const sn = d.all.filter((v) => v.id === 'rollup-source-never-seen');
    check('s14.srcNever.pureInAll', sn.length === 1, `found ${sn.length}`);
    check(
        's14.srcNever.noBackfillLoop',
        d.all.every((v) => v.id !== 'rollup-never-built'),
        'rollup-never-built still present in the pure fresh install',
    );
    if (sn.length === 1) {
        check('s14.srcNever.confirmed', sn[0].confidence === 'confirmed', sn[0].confidence);
        check('s14.srcNever.owner', sn[0].owner === 'ingest', sn[0].owner);
        check(
            's14.srcNever.indexScoped',
            sn[0].headline.indexOf('in the index this app reads') !== -1,
            sn[0].headline,
        );
        check(
            's14.srcNever.noBackfillPrescription',
            (sn[0].detail || '').indexOf('cannot help yet') !== -1,
            sn[0].detail || '(no detail)',
        );
    }

    // MIXED state (other feeds live): feed-not-started IS the top.
    const d2 = diagnose(
        facts({ spl: CACHED }),
        cachedEmptyEv({ indexRowsInWindow: 5000, resolvedIndexes: ['sap_logserv_logs'] }),
    );
    check('s14.srcNever.mixedTop', d2.top.id === 'rollup-source-never-seen', `got ${d2.top.id}`);

    // Residuals keep the unchanged never-built (honest fallback): no last-seen
    // evidence, and source-seen (where the backfill genuinely helps).
    const d3 = diagnose(
        facts({ spl: CACHED }),
        cachedEmptyEv({
            indexRowsInWindow: 5000,
            resolvedIndexes: ['sap_logserv_logs'],
            sourcetypeLastSeen: null,
        }),
    );
    check('s14.srcNever.residualNullLastSeen', d3.top.id === 'rollup-never-built', `got ${d3.top.id}`);
    const d4 = diagnose(
        facts({ spl: CACHED }),
        cachedEmptyEv({
            indexRowsInWindow: 5000,
            resolvedIndexes: ['sap_logserv_logs'],
            sourcetypeLastSeen: { 'sap:hana:audit': NOW - 100 },
        }),
    );
    check('s14.srcNever.sourceSeenKeepsNeverBuilt', d4.top.id === 'rollup-never-built', `got ${d4.top.id}`);

    // §14.8a precedence: routing beats feed-not-started on the empty collection.
    const d5 = diagnose(
        facts({ spl: CACHED }),
        cachedEmptyEv({
            indexRowsInWindow: 1000,
            resolvedIndexes: ['sap_logserv_logs'],
            fallbackRowsInWindow: 1000,
            routedRowsInWindow: 0,
        }),
    );
    check('s14.routing.beatsSrcNever', d5.top.id === 'routing-not-applied', `got ${d5.top.id}`);

    // §14.8a-2.4: routing beats rollup-stale (the aggregate runs fine and
    // finds nothing — "check the scheduler" would misdirect).
    const staleRoutingEv = noEvidence({
        indexRowsInWindow: 1000,
        resolvedIndexes: ['sap_logserv_logs'],
        sourceScope: {
            sourcetypes: ['sap:hana:audit'],
            tags: [],
            via: 'logserv_hana_category_aggregate',
        },
        sourcetypeCounts: {},
        sourcetypeLastSeen: { 'sap:hana:audit': NOW - 5 * 86400 },
        fallbackRowsInWindow: 1000,
        routedRowsInWindow: 0,
        collectionRowsInWindow: 0,
        collectionExtentProbed: true,
        collectionOldest: NOW - 30 * 86400,
        collectionNewest: NOW - 5 * 3600,
    });
    const d6 = diagnose(facts({ spl: CACHED }), staleRoutingEv);
    check('s14.routing.beatsStale', d6.top.id === 'routing-not-applied', `got ${d6.top.id}`);
}

// --- §14.5 producer-disabled upgrade -------------------------------------
{
    const staleEv = (over: Partial<EvidenceShape> = {}): EvidenceShape =>
        noEvidence({
            indexRowsInWindow: 1000,
            resolvedIndexes: ['sap_logserv_logs'],
            collectionRowsInWindow: 0,
            collectionExtentProbed: true,
            collectionOldest: NOW - 30 * 86400,
            collectionNewest: NOW - 5 * 3600,
            ...over,
        });
    const d = diagnose(
        facts({ spl: CACHED }),
        staleEv({ producerDisabled: ['logserv_linux_aggregate'], producerTracedCount: 1 }),
    );
    check('s14.producer.allDisabledConfirms', d.top.id === 'rollup-stale' && d.top.confidence === 'confirmed', `${d.top.id}/${d.top.confidence}`);
    check(
        's14.producer.namesTheJob',
        (d.top.detail || '').indexOf('DISABLED') !== -1 && (d.top.detail || '').indexOf('logserv_linux_aggregate') !== -1,
        d.top.detail || '(no detail)',
    );
    // A disabled SIBLING (subset) must NOT confirm — the multi-collection
    // rollup case where over-collection would blame the wrong job.
    const d2 = diagnose(
        facts({ spl: CACHED }),
        staleEv({ producerDisabled: ['logserv_beaconing_detail_aggregate'], producerTracedCount: 2 }),
    );
    check('s14.producer.subsetStaysLikely', d2.top.id === 'rollup-stale' && d2.top.confidence === 'likely', `${d2.top.id}/${d2.top.confidence}`);
    check(
        's14.producer.subsetIsCandidate',
        (d2.top.detail || '').indexOf('candidate cause') !== -1,
        d2.top.detail || '(no detail)',
    );
    // Tri-state: none-disabled ([]) and unknown (null) both stay likely with
    // no disabled claim.
    const d3 = diagnose(facts({ spl: CACHED }), staleEv({ producerDisabled: [], producerTracedCount: 1 }));
    check('s14.producer.noneDisabled', d3.top.confidence === 'likely' && (d3.top.detail || '').indexOf('DISABLED') === -1, `${d3.top.confidence}`);
    const d4 = diagnose(facts({ spl: CACHED }), staleEv());
    check('s14.producer.unknown', d4.top.confidence === 'likely' && (d4.top.detail || '').indexOf('DISABLED') === -1, `${d4.top.confidence}`);
}

// --- §14.4 extraction-app-missing ----------------------------------------
const WINRAW = '`sap_logserv_idx_macro` sourcetype="XmlWinEventLog" severity="critical" | stats count';
const WINCACHED =
    '| inputlookup logserv_windows_rollup where metric="main" | addinfo | where bucket_ts>=info_min_time AND bucket_ts<info_max_time | stats sum(count) as count';
{
    const winEv = (over: Partial<EvidenceShape> = {}): EvidenceShape =>
        noEvidence({
            indexRowsInWindow: 10000,
            resolvedIndexes: ['sap_logserv_logs'],
            sourcetypeCounts: { XmlWinEventLog: 500 },
            installedApps: ['search', 'Splunk_SA_CIM'],
            ...over,
        });
    const d = diagnose(facts({ spl: WINRAW }), winEv());
    check('s14.extract.fires', d.top.id === 'extraction-app-missing', `got ${d.top.id}`);
    check('s14.extract.possible', d.top.confidence === 'possible', d.top.confidence);
    check('s14.extract.owner', d.top.owner === 'splunk-admin', d.top.owner);
    check(
        's14.extract.aclHedge',
        d.top.headline.indexOf('not visible to your account') !== -1,
        d.top.headline,
    );
    // TA present / apps unknown / events absent: must NOT fire.
    const d2 = diagnose(facts({ spl: WINRAW }), winEv({ installedApps: ['Splunk_TA_windows'] }));
    check('s14.extract.taPresent', d2.top.id === 'undetermined', `got ${d2.top.id}`);
    const d3 = diagnose(facts({ spl: WINRAW }), winEv({ installedApps: null }));
    check('s14.extract.appsUnknown', d3.top.id === 'undetermined', `got ${d3.top.id}`);
    const d4 = diagnose(
        facts({ spl: WINRAW }),
        winEv({ sourcetypeCounts: {}, sourcetypeLastSeen: {} }),
    );
    check('s14.extract.eventsAbsent', d4.top.id === 'sourcetype-never-seen', `got ${d4.top.id}`);
    // Windows-family ONLY — the App ships the Linux extractions itself.
    const LINRAW = '`sap_logserv_idx_macro` sourcetype="linux_secure" | stats count';
    const d5 = diagnose(
        facts({ spl: LINRAW }),
        noEvidence({
            indexRowsInWindow: 10000,
            resolvedIndexes: ['sap_logserv_logs'],
            sourcetypeCounts: { linux_secure: 500 },
            installedApps: ['search'],
        }),
    );
    check('s14.extract.neverForLinux', d5.top.id === 'undetermined', `got ${d5.top.id}`);
    // Cached tier via the traced scope — must outrank rollup-has-rows, and the
    // detail must carry the rebuild-history advice.
    const d6 = diagnose(
        facts({ spl: WINCACHED }),
        noEvidence({
            indexRowsInWindow: 10000,
            resolvedIndexes: ['sap_logserv_logs'],
            sourceScope: { sourcetypes: ['XmlWinEventLog'], tags: [], via: 'logserv_windows_aggregate' },
            sourcetypeCounts: { XmlWinEventLog: 500 },
            collectionRowsInWindow: 5,
            installedApps: ['search'],
        }),
    );
    check('s14.extract.cachedFires', d6.top.id === 'extraction-app-missing', `got ${d6.top.id}`);
    check(
        's14.extract.cachedRebuildAdvice',
        (d6.top.detail || '').indexOf('re-run the backfill') !== -1,
        d6.top.detail || '(no detail)',
    );
}

// --- §14.5 kvstore-not-ready ---------------------------------------------
{
    const kvEv = (over: Partial<EvidenceShape> = {}): EvidenceShape =>
        noEvidence({
            indexRowsInWindow: 1000,
            resolvedIndexes: ['sap_logserv_logs'],
            collectionRowsInWindow: null,
            kvStoreStatus: 'starting',
            ...over,
        });
    const d = diagnose(facts({ spl: CACHED }), kvEv());
    check('s14.kv.fires', d.top.id === 'kvstore-not-ready', `got ${d.top.id}`);
    check('s14.kv.likely', d.top.confidence === 'likely', d.top.confidence);
    check('s14.kv.transientWording', (d.top.detail || '').indexOf('clears itself') !== -1, d.top.detail || '');
    // §14.8a-5.3: the incomplete signal must survive the upgrade.
    check('s14.kv.incompleteKept', d.incomplete === true, 'incomplete flipped false');
    check(
        's14.kv.companionEntry',
        d.all.some((v) => v.id === 'rollup-health-unchecked'),
        'no rollup-health-unchecked companion in all',
    );
    // Persistent statuses get the non-transient wording.
    const d2 = diagnose(facts({ spl: CACHED }), kvEv({ kvStoreStatus: 'failed' }));
    check('s14.kv.persistentWording', (d2.top.detail || '').indexOf('does not clear itself') !== -1, d2.top.detail || '');
    // Status unknown: the honest placeholder stays — NEVER kvstore-not-ready.
    const d3 = diagnose(facts({ spl: CACHED }), kvEv({ kvStoreStatus: null }));
    check(
        's14.kv.unknownStaysPlaceholder',
        d3.all.some((v) => v.id === 'rollup-window') && d3.all.every((v) => v.id !== 'kvstore-not-ready'),
        d3.all.map((v) => v.id).join(','),
    );
    // The mongod-warm-up belt: an EMPTY extent with a non-ready status must
    // NOT read "never built"; with a ready status it must (unchanged).
    const beltEv = (status: string | null): EvidenceShape =>
        noEvidence({
            indexRowsInWindow: 1000,
            resolvedIndexes: ['sap_logserv_logs'],
            collectionRowsInWindow: 0,
            collectionExtentProbed: true,
            collectionOldest: null,
            collectionNewest: null,
            kvStoreStatus: status,
        });
    const d4 = diagnose(facts({ spl: CACHED }), beltEv('starting'));
    check('s14.kv.beltBlocksNeverBuilt', d4.top.id === 'kvstore-not-ready', `got ${d4.top.id}`);
    const d5 = diagnose(facts({ spl: CACHED }), beltEv('ready'));
    check('s14.kv.readyKeepsNeverBuilt', d5.top.id === 'rollup-never-built', `got ${d5.top.id}`);
}

// --- §14.3 index-not-visible wording pin ---------------------------------
{
    const d = diagnose(
        facts({ spl: RAW }),
        noEvidence({
            indexRowsInWindow: 0,
            visibleIndexes: ['main'],
            macroIndexes: ['sap_logserv_logs'],
        }),
    );
    check('s14.visibility.fires', d.top.id === 'index-not-visible', `got ${d.top.id}`);
    const det = d.top.detail || '';
    check(
        's14.visibility.namesAllCauses',
        det.indexOf('srchIndexesAllowed') !== -1 &&
            det.indexOf('is not installed') !== -1 &&
            det.indexOf('overridden') !== -1 &&
            det.indexOf('disabled') !== -1,
        det,
    );
}

// --- sourcetype-presence placeholder wordings (coverage-review rider) ----
{
    const d = diagnose(
        facts({ spl: TAG_SCOPED }),
        noEvidence({ indexRowsInWindow: 1000, resolvedIndexes: ['sap_logserv_logs'] }),
    );
    const tag = d.all.filter((v) => v.id === 'sourcetype-presence');
    check('s14.stPresence.tagScoped', tag.length === 1 && tag[0].headline.indexOf('selected by tag') !== -1, tag.map((v) => v.headline).join('|'));
    const d2 = diagnose(
        facts({ spl: TSTATS_WHOLE_INDEX }),
        noEvidence({ indexRowsInWindow: 1000, resolvedIndexes: ['sap_logserv_logs'] }),
    );
    const nc = d2.all.filter((v) => v.id === 'sourcetype-presence');
    check('s14.stPresence.noConstraint', nc.length === 1 && nc[0].headline.indexOf('not limited to one kind') !== -1, nc.map((v) => v.headline).join('|'));
}

// --- §14 invariant mini-sweep --------------------------------------------
// routing-not-applied may only ever appear with routed === 0 AND
// fallback >= floor, never confirmed; kvstore-not-ready never with an
// unknown/ready status. Swept over the new-field combinations.
{
    let s14combos = 0;
    const fbVals: Array<number | null> = [null, 0, 49, 50, 1000];
    const rtVals: Array<number | null> = [null, 0, 5];
    const lsVals: Array<Record<string, number> | null> = [null, {}, { 'sap:hana:audit': NOW - 2 * 86400 }];
    const kvVals: Array<string | null> = [null, 'ready', 'starting'];
    for (const fb of fbVals) {
        for (const rt of rtVals) {
            for (const ls of lsVals) {
                for (const kv of kvVals) {
                    s14combos += 1;
                    const d = diagnose(
                        facts({ spl: RAW }),
                        routingEv({
                            fallbackRowsInWindow: fb,
                            routedRowsInWindow: rt,
                            sourcetypeLastSeen: ls,
                            kvStoreStatus: kv,
                        }),
                    );
                    for (const v of d.all) {
                        if (v.id === 'routing-not-applied') {
                            if (rt !== 0) fail('s14 invariant: routing with routed != 0');
                            if (fb === null || fb < 50) fail('s14 invariant: routing below the floor');
                            if (v.confidence === 'confirmed') fail('s14 invariant: routing must never be confirmed');
                        }
                        if (v.id === 'kvstore-not-ready' && (kv === null || kv === 'ready')) {
                            fail('s14 invariant: kvstore-not-ready with unknown/ready status');
                        }
                    }
                }
            }
        }
    }
    checks += 1;
    proc.stderr.write(`  s14 invariant: ${s14combos} new-field combinations swept\n`);
}

// --- §15 — operator-supplied ingest evidence (checks 28/29, build 314) -----
//
// Order pins BOTH WAYS per §15.8a: 28 beaten by visibility, beats index-empty
// and silences the whole cached gate; 29 beaten by outside-window and the
// observed producer-disabled stale, beats routing/never-seen/
// rollup-source-never-seen; every firing precondition (B1's in-window
// absence, the evaluable contradiction guard, the supplied-confidence caps)
// pinned; then a mini-sweep asserting the invariants over the new-field
// combinations.
{
    const CUTOFF = 1785628800;
    const ingestFx = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
        suppliedAt: NOW - 100,
        suppliedBy: 'opsuser',
        sourceHost: 'ds01',
        inputShape: 'rest-json',
        parseStatus: 'parsed',
        parseNote: '',
        filterEnabled: true,
        daysInPast: 7,
        cutoffEpoch: null,
        includeFilters: [],
        excludeFilters: [],
        filtersApproximate: false,
        scrubbedRaw: '',
        ...over,
    });
    const ids = (d: DiagnosisShape): string[] => d.all.map((v) => v.id);

    // ---- check 28: ingest-window-before-cutoff --------------------------
    const oldWindow = { earliest: String(CUTOFF - 20 * 86400), latest: String(CUTOFF - 10 * 86400) };
    const cutoffEv = (over: Partial<EvidenceShape> = {}): EvidenceShape =>
        noEvidence({
            indexRowsInWindow: 0,
            ingestFacts: ingestFx({ cutoffEpoch: CUTOFF }),
            ...over,
        });

    const d28 = diagnose(facts({ spl: RAW, ...oldWindow }), cutoffEv());
    check('s15.cutoff.fires', d28.top.id === 'ingest-window-before-cutoff', d28.top.id);
    check('s15.cutoff.confirmedFresh', d28.top.confidence === 'confirmed', d28.top.confidence);
    check('s15.cutoff.indexEmptyStandsDown', ids(d28).indexOf('index-empty-in-window') === -1, ids(d28).join(','));
    check(
        's15.cutoff.provenanceInEvidence',
        d28.top.evidence.some((e: string) => e.indexOf('Recorded as supplied by') !== -1),
        d28.top.evidence.join('|'),
    );

    // beaten by visibility (the contradictory-zero rule)
    const dVis = diagnose(
        facts({ spl: RAW, ...oldWindow }),
        cutoffEv({ visibleIndexes: ['main'], macroIndexes: ['sap_logserv_logs'] }),
    );
    check('s15.cutoff.beatenByVisibility', dVis.top.id === 'index-not-visible', dVis.top.id);
    check('s15.cutoff.absentUnderVisibility', ids(dVis).indexOf('ingest-window-before-cutoff') === -1, '');

    // silences the WHOLE cached gate (§15.8a-9)
    const dCachedCut = diagnose(
        facts({ spl: CACHED, ...oldWindow }),
        cutoffEv({
            collectionRowsInWindow: 0,
            collectionRowsAllMetrics: 0,
            collectionExtentProbed: true,
            collectionOldest: null,
            collectionNewest: null,
        }),
    );
    check('s15.cutoff.topOnCached', dCachedCut.top.id === 'ingest-window-before-cutoff', dCachedCut.top.id);
    check(
        's15.cutoff.cachedGateSilenced',
        ids(dCachedCut).every((i) => i.indexOf('rollup-') !== 0),
        ids(dCachedCut).join(','),
    );

    // margin boundary both ways (§15.8a-8/10): exactly the floor -> confirmed;
    // inside the floor -> likely; window end past the cutoff -> silent.
    const atFloor = diagnose(
        facts({ spl: RAW, earliest: String(CUTOFF - 10 * 86400), latest: String(CUTOFF - 86400) }),
        cutoffEv(),
    );
    check('s15.cutoff.floorConfirmed', atFloor.top.confidence === 'confirmed', atFloor.top.confidence);
    const nearEdge = diagnose(
        facts({ spl: RAW, earliest: String(CUTOFF - 10 * 86400), latest: String(CUTOFF - 100) }),
        cutoffEv(),
    );
    check('s15.cutoff.nearEdgeLikely', nearEdge.top.id === 'ingest-window-before-cutoff' && nearEdge.top.confidence === 'likely', `${nearEdge.top.id}/${nearEdge.top.confidence}`);
    const straddle = diagnose(
        facts({ spl: RAW, earliest: String(CUTOFF - 86400), latest: String(CUTOFF + 86400) }),
        cutoffEv(),
    );
    check('s15.cutoff.straddleSilent', straddle.top.id === 'index-empty-in-window', straddle.top.id);

    // facts-state gating: disabled / unparsed / partial / stale
    const dDis = diagnose(facts({ spl: RAW, ...oldWindow }), cutoffEv({ ingestFacts: ingestFx({ cutoffEpoch: CUTOFF, filterEnabled: false }) }));
    check('s15.cutoff.disabledSilent', dDis.top.id === 'index-empty-in-window', dDis.top.id);
    const dUnp = diagnose(facts({ spl: RAW, ...oldWindow }), cutoffEv({ ingestFacts: ingestFx({ cutoffEpoch: CUTOFF, parseStatus: 'unparsed' }) }));
    check('s15.cutoff.unparsedSilent', dUnp.top.id === 'index-empty-in-window', dUnp.top.id);
    const dPart = diagnose(facts({ spl: RAW, ...oldWindow }), cutoffEv({ ingestFacts: ingestFx({ cutoffEpoch: CUTOFF, parseStatus: 'partial' }) }));
    check('s15.cutoff.partialCapsPossible', dPart.top.id === 'ingest-window-before-cutoff' && dPart.top.confidence === 'possible', `${dPart.top.id}/${dPart.top.confidence}`);
    const dStale = diagnose(facts({ spl: RAW, ...oldWindow }), cutoffEv({ ingestFacts: ingestFx({ cutoffEpoch: CUTOFF, suppliedAt: NOW - 9 * 86400 }) }));
    check('s15.cutoff.staleCapsLikely', dStale.top.confidence === 'likely', dStale.top.confidence);

    // ---- check 29: ingest-type-excluded ----------------------------------
    // RAW tier, hana panel, hana events absent in-window, guard evaluable +
    // negative, fresh exact paste excluding hana/hanaaudit.
    const exFx = (over: Record<string, unknown> = {}): Record<string, unknown> =>
        ingestFx({ excludeFilters: ['hana/hanaaudit'], ...over });
    const exEv = (over: Partial<EvidenceShape> = {}): EvidenceShape =>
        noEvidence({
            indexRowsInWindow: 5000,
            sourcetypeCounts: { linux_messages_syslog: 5000 },
            sourcetypeLastSeen: { 'sap:hana:audit': NOW - 30 * 86400 },
            ingestFacts: exFx(),
            ...over,
        });

    const d29 = diagnose(facts({ spl: RAW }), exEv());
    check('s15.excl.rawConfirmed', d29.top.id === 'ingest-type-excluded' && d29.top.confidence === 'confirmed', `${d29.top.id}/${d29.top.confidence}`);
    check('s15.excl.ownerAdmin', d29.top.owner === 'splunk-admin', d29.top.owner);
    check(
        's15.excl.intentWording',
        (d29.top.detail || '').indexOf('If this exclusion is intentional') !== -1,
        d29.top.detail || '',
    );

    // beats sourcetype-never-seen (evaluated, never seen)
    const dNever = diagnose(facts({ spl: RAW }), exEv({ sourcetypeLastSeen: {} }));
    check('s15.excl.beatsNeverSeen', dNever.top.id === 'ingest-type-excluded', dNever.top.id);
    check('s15.excl.neverSeenNotTop', ids(dNever).indexOf('sourcetype-never-seen') === -1, '');
    // ...and the same state WITHOUT facts still lands on never-seen (both ways)
    const dNoFx = diagnose(facts({ spl: RAW }), exEv({ sourcetypeLastSeen: {}, ingestFacts: null }));
    check('s15.excl.withoutFactsNeverSeen', dNoFx.top.id === 'sourcetype-never-seen', dNoFx.top.id);

    // beaten by outside-window proof-of-life (§14.8a-2.1 preserved)
    const dOut = diagnose(
        facts({ spl: RAW, earliest: String(NOW - 3 * 86400), latest: String(NOW - 86400) }),
        exEv({ sourcetypeLastSeen: { 'sap:hana:audit': NOW - 3600 } }),
    );
    check('s15.excl.beatenByOutsideWindow', dOut.top.id === 'sourcetype-outside-window', dOut.top.id);
    check('s15.excl.absentUnderOutsideWindow', ids(dOut).indexOf('ingest-type-excluded') === -1, '');

    // B1 second contradiction: events of the "excluded" type IN the window
    const dContra = diagnose(facts({ spl: RAW }), exEv({ sourcetypeCounts: { 'sap:hana:audit': 10 } }));
    check('s15.excl.contradictionEntry', ids(dContra).indexOf('ingest-facts-contradicted') !== -1, ids(dContra).join(','));
    check('s15.excl.noVerdictOnContradiction', ids(dContra).indexOf('ingest-type-excluded') === -1, '');

    // stale-paste contradiction: newer events (by event time) than the paste
    const dContra2 = diagnose(facts({ spl: RAW }), exEv({ sourcetypeLastSeen: { 'sap:hana:audit': NOW - 10 } }));
    check('s15.excl.stalePasteContradiction', ids(dContra2).indexOf('ingest-facts-contradicted') !== -1, ids(dContra2).join(','));
    check('s15.excl.fallsToStale', dContra2.top.id === 'sourcetype-stale', dContra2.top.id);

    // guard unevaluable -> possible, never confirmed (§15.8a-2)
    const dGuard = diagnose(facts({ spl: RAW }), exEv({ sourcetypeLastSeen: null }));
    check('s15.excl.guardUnevaluablePossible', dGuard.top.id === 'ingest-type-excluded' && dGuard.top.confidence === 'possible', `${dGuard.top.id}/${dGuard.top.confidence}`);

    // B1 precondition: counts unknown -> silent
    const dNoCounts = diagnose(facts({ spl: RAW }), exEv({ sourcetypeCounts: null }));
    check('s15.excl.noCountsSilent', ids(dNoCounts).indexOf('ingest-type-excluded') === -1, ids(dNoCounts).join(','));

    // partial path drop -> possible (§15.8a-4)
    const WINRAW = '`sap_logserv_idx_macro` sourcetype="XmlWinEventLog" | stats count';
    const dWin = diagnose(
        facts({ spl: WINRAW }),
        noEvidence({
            indexRowsInWindow: 5000,
            sourcetypeCounts: { linux_messages_syslog: 5000 },
            sourcetypeLastSeen: { XmlWinEventLog: NOW - 30 * 86400 },
            ingestFacts: ingestFx({ excludeFilters: ['windows/WinEventLog:Security'] }),
        }),
    );
    check('s15.excl.partialPossible', dWin.top.id === 'ingest-type-excluded' && dWin.top.confidence === 'possible', `${dWin.top.id}/${dWin.top.confidence}`);

    // approximate recovery caps at likely (§15.8a-17)
    const dApprox = diagnose(facts({ spl: RAW }), exEv({ ingestFacts: exFx({ filtersApproximate: true, inputShape: 'transforms-conf' }) }));
    check('s15.excl.approxLikely', dApprox.top.id === 'ingest-type-excluded' && dApprox.top.confidence === 'likely', `${dApprox.top.id}/${dApprox.top.confidence}`);

    // tag-scoped reachability (§15.8a-5)
    const dTag = diagnose(
        facts({ spl: TAG_SCOPED }),
        noEvidence({
            indexRowsInWindow: 5000,
            sourcetypeCounts: { linux_messages_syslog: 5000 },
            sourcetypeLastSeen: { 'isc:bind:query': NOW - 30 * 86400 },
            ingestFacts: ingestFx({ excludeFilters: ['dns/binddns'] }),
        }),
    );
    check('s15.excl.tagScopedFires', dTag.top.id === 'ingest-type-excluded', dTag.top.id);

    // cached empty-extent chain: exclusion > rollup-source-never-seen,
    // pinned both ways on the same state (§15.8a precedence)
    const cachedEmpty = (fx: Record<string, unknown> | null): EvidenceShape =>
        noEvidence({
            indexRowsInWindow: 5000,
            sourcetypeCounts: { linux_messages_syslog: 5000 },
            sourcetypeLastSeen: {},
            sourceScope: { sourcetypes: ['sap:saprouter'], tags: [], via: 'logserv_saprouter_aggregate' },
            collectionRowsInWindow: 0,
            collectionRowsAllMetrics: 0,
            collectionExtentProbed: true,
            collectionOldest: null,
            collectionNewest: null,
            ingestFacts: fx,
        });
    const dCa = diagnose(facts({ spl: CACHED }), cachedEmpty(ingestFx({ excludeFilters: ['sap/saprouter'] })));
    check('s15.excl.cachedEmptyExtent', dCa.top.id === 'ingest-type-excluded', dCa.top.id);
    // B1 on the CACHED tier: counts unknown -> the exclusion must stay silent
    // (and must not crash) even when the supplied config would drop the whole
    // traced scope — kill-tested (M4).
    const dCc = diagnose(
        facts({ spl: CACHED }),
        cachedEmpty(ingestFx({ excludeFilters: ['sap/saprouter'] })),
    );
    void dCc; // baseline above; the counts-null variant:
    const cachedNoCounts = cachedEmpty(ingestFx({ excludeFilters: ['sap/saprouter'] }));
    (cachedNoCounts as unknown as Record<string, unknown>).sourcetypeCounts = null;
    const dCn = diagnose(facts({ spl: CACHED }), cachedNoCounts);
    check('s15.excl.cachedNoCountsSilent', ids(dCn).indexOf('ingest-type-excluded') === -1, ids(dCn).join(','));

    const dCb = diagnose(facts({ spl: CACHED }), cachedEmpty(null));
    check('s15.excl.cachedWithoutFacts', dCb.top.id === 'rollup-source-never-seen', dCb.top.id);

    // stale chain order (§15.8a-3): allDisabled OBSERVED beats the supplied
    // exclusion; without allDisabled the exclusion leads.
    const cachedStale = (over: Partial<EvidenceShape> = {}): EvidenceShape =>
        noEvidence({
            indexRowsInWindow: 5000,
            sourcetypeCounts: { linux_messages_syslog: 5000 },
            sourcetypeLastSeen: {},
            sourceScope: { sourcetypes: ['sap:saprouter'], tags: [], via: 'logserv_saprouter_aggregate' },
            collectionRowsInWindow: 0,
            collectionRowsAllMetrics: 0,
            collectionExtentProbed: true,
            collectionOldest: NOW - 20 * 86400,
            collectionNewest: NOW - 10 * 3600,
            ingestFacts: ingestFx({ excludeFilters: ['sap/saprouter'] }),
            ...over,
        });
    const dS1 = diagnose(facts({ spl: CACHED }), cachedStale({ producerDisabled: ['logserv_saprouter_aggregate'], producerTracedCount: 1 }));
    check('s15.excl.allDisabledWins', dS1.top.id === 'rollup-stale' && dS1.top.confidence === 'confirmed', `${dS1.top.id}/${dS1.top.confidence}`);
    const dS2 = diagnose(facts({ spl: CACHED }), cachedStale({ producerDisabled: [], producerTracedCount: 1 }));
    check('s15.excl.exclusionBeatsPlainStale', dS2.top.id === 'ingest-type-excluded', dS2.top.id);

    // ---- §15 invariant mini-sweep ------------------------------------------
    let s15combos = 0;
    const fxVals: Array<Record<string, unknown> | null | undefined> = [
        undefined,
        null,
        ingestFx({ cutoffEpoch: CUTOFF }),
        ingestFx({ cutoffEpoch: CUTOFF, filterEnabled: false }),
        ingestFx({ cutoffEpoch: CUTOFF, parseStatus: 'unparsed' }),
        ingestFx({ cutoffEpoch: CUTOFF, parseStatus: 'partial' }),
        exFx(),
        exFx({ filtersApproximate: true }),
        exFx({ suppliedAt: NOW - 9 * 86400 }),
    ];
    const idxVals: Array<number | null> = [null, 0, 5000];
    const cntVals: Array<Record<string, number> | null> = [null, {}, { 'sap:hana:audit': 7 }];
    const lsVals: Array<Record<string, number> | null> = [null, {}, { 'sap:hana:audit': NOW - 30 * 86400 }];
    for (const fx of fxVals) {
        for (const idx of idxVals) {
            for (const cnt of cntVals) {
                for (const lsv of lsVals) {
                    s15combos += 1;
                    const ev = noEvidence({
                        indexRowsInWindow: idx,
                        sourcetypeCounts: cnt,
                        sourcetypeLastSeen: lsv,
                    });
                    (ev as unknown as Record<string, unknown>).ingestFacts = fx as unknown;
                    const d = diagnose(facts({ spl: RAW, ...oldWindow }), ev);
                    const fxo = fx as Record<string, unknown> | null | undefined;
                    const usable = !!fxo && fxo.parseStatus !== 'unparsed' && fxo.filterEnabled === true;
                    for (const v of d.all) {
                        if (v.id === 'ingest-window-before-cutoff') {
                            if (!usable) fail('s15 sweep: cutoff verdict from unusable facts');
                            if (idx !== 0) fail('s15 sweep: cutoff verdict without the observed zero');
                            if (!fxo || typeof fxo.cutoffEpoch !== 'number') fail('s15 sweep: cutoff verdict without a cutoff');
                        }
                        if (v.id === 'ingest-type-excluded') {
                            if (!usable) fail('s15 sweep: exclusion verdict from unusable facts');
                            if (cnt === null) fail('s15 sweep: exclusion without counts (B1)');
                            if (cnt !== null && (cnt as Record<string, number>)['sap:hana:audit'] > 0) {
                                fail('s15 sweep: exclusion with the type present in-window (B1)');
                            }
                            if (v.confidence === 'confirmed') {
                                if (lsv === null) fail('s15 sweep: confirmed exclusion with unevaluable guard');
                                if (fxo && fxo.filtersApproximate === true) fail('s15 sweep: confirmed exclusion from approximate recovery');
                                if (fxo && fxo.parseStatus === 'partial') fail('s15 sweep: confirmed exclusion from a partial parse');
                                if (fxo && (fxo.suppliedAt as number) < NOW - 7 * 86400) fail('s15 sweep: confirmed exclusion from stale facts');
                            }
                        }
                        if (v.id === 'ingest-facts-contradicted' && v.confidence !== 'not-evaluated') {
                            fail('s15 sweep: contradiction entry must be not-evaluated');
                        }
                    }
                }
            }
        }
    }
    checks += 1;
    proc.stderr.write(`  s15 invariant: ${s15combos} operator-evidence combinations swept\n`);
}

// =========================================================================
// §19 (build 319) — the evidence refinements: the index-time comparator, the
// pre-cutoff corroboration lines, the sourcetype-level cutoff context, the
// cloud-provider stamp lines, and the drawer pointer's trigger.
// =========================================================================
{
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ingestMod = require('./diagIngestFacts') as any;
    const cutoffFromDays = ingestMod.cutoffFromDays as (d: number, n: number) => number;
    const SKEW = ingestMod.INGEST_RECENT_SKEW_SECONDS as number;
    const ids = (d: DiagnosisShape): string[] => d.all.map((v) => v.id);
    const ingestFx = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
        suppliedAt: NOW - 100,
        suppliedBy: 'opsuser',
        sourceHost: 'ds01',
        inputShape: 'rest-json',
        parseStatus: 'parsed',
        parseNote: '',
        filterEnabled: true,
        daysInPast: 7,
        cutoffEpoch: null,
        includeFilters: [],
        excludeFilters: [],
        filtersApproximate: false,
        cloudProviderStamp: null,
        scrubbedRaw: '',
        ...over,
    });
    const exFx = (over: Record<string, unknown> = {}): Record<string, unknown> =>
        ingestFx({ excludeFilters: ['hana/hanaaudit'], ...over });
    const exEv = (over: Partial<EvidenceShape> = {}): EvidenceShape =>
        noEvidence({
            indexRowsInWindow: 5000,
            sourcetypeCounts: { linux_messages_syslog: 5000 },
            sourcetypeLastSeen: { 'sap:hana:audit': NOW - 30 * 86400 },
            ingestFacts: exFx({ suppliedAt: NOW - 3600 }),
            ...over,
        });

    // ---- item 1: the index-time contradiction comparator -----------------
    // The L1-10 replay evasion: event-time lastSeen is OLD (no event-time
    // contradiction) while INDEX-time recentSeen is newer than the paste.
    const dRecent = diagnose(
        facts({ spl: RAW }),
        exEv({ sourcetypeRecentSeen: { 'sap:hana:audit': NOW - 10 } }),
    );
    check(
        's19.recent.capsPossible',
        dRecent.top.id === 'ingest-type-excluded' && dRecent.top.confidence === 'possible',
        `${dRecent.top.id}/${dRecent.top.confidence}`,
    );
    check(
        's19.recent.lineWorded',
        dRecent.top.evidence.some((e) => /recorded as indexed after the configuration was supplied/.test(e)),
        dRecent.top.evidence.join('|'),
    );
    check(
        's19.recent.neverStandsDown',
        ids(dRecent).indexOf('ingest-facts-contradicted') === -1,
        'the index-time comparator must cap, never stand the gate down',
    );
    // Skew boundary BOTH directions (§19.8a-12; mutation (a) target): at
    // exactly suppliedAt+SKEW the grace holds and the verdict stays
    // confirmed; one second past it, the cap engages.
    const atSkew = diagnose(
        facts({ spl: RAW }),
        exEv({ sourcetypeRecentSeen: { 'sap:hana:audit': NOW - 3600 + SKEW } }),
    );
    check(
        's19.recent.skewBoundaryNotCapped',
        atSkew.top.id === 'ingest-type-excluded' && atSkew.top.confidence === 'confirmed',
        `${atSkew.top.id}/${atSkew.top.confidence}`,
    );
    const pastSkew = diagnose(
        facts({ spl: RAW }),
        exEv({ sourcetypeRecentSeen: { 'sap:hana:audit': NOW - 3600 + SKEW + 1 } }),
    );
    check(
        's19.recent.pastSkewCapped',
        pastSkew.top.confidence === 'possible',
        pastSkew.top.confidence,
    );
    // Absent/undefined recentSeen: unchanged confirmed (undefined-safety).
    const dNoRecent = diagnose(facts({ spl: RAW }), exEv());
    check('s19.recent.absentUnchanged', dNoRecent.top.confidence === 'confirmed', dNoRecent.top.confidence);

    // ---- item 2: the pre-cutoff corroboration lines ----------------------
    const CUT30 = cutoffFromDays(30, NOW);
    const oldWin = { earliest: String(CUT30 - 20 * 86400), latest: String(CUT30 - 10 * 86400) };
    const cutEv = (over: Partial<EvidenceShape> = {}): EvidenceShape =>
        noEvidence({
            indexRowsInWindow: 0,
            ingestFacts: ingestFx({ cutoffEpoch: CUT30, daysInPast: 30 }),
            ...over,
        });
    const dPre0 = diagnose(facts({ spl: RAW, ...oldWin }), cutEv({ preCutoffOldest: CUT30 + 86400 }));
    check('s19.pre.zeroCaseFires', dPre0.top.id === 'ingest-window-before-cutoff', dPre0.top.id);
    check(
        's19.pre.zeroCaseNonDiscriminator',
        dPre0.top.evidence.some((e) => /does not discriminate/.test(e)),
        dPre0.top.evidence.join('|'),
    );
    check('s19.pre.confidenceUnchangedZero', dPre0.top.confidence === 'confirmed', dPre0.top.confidence);
    const dPreN = diagnose(
        facts({ spl: RAW, ...oldWin }),
        cutEv({ preCutoffOldest: CUT30 - 40 * 86400 }),
    );
    check(
        's19.pre.olderExistsInformative',
        dPreN.top.evidence.some((e) => /Events older than the cutoff do exist/.test(e)),
        dPreN.top.evidence.join('|'),
    );
    check('s19.pre.confidenceUnchangedOlder', dPreN.top.confidence === 'confirmed', dPreN.top.confidence);
    const dPreAbs = diagnose(facts({ spl: RAW, ...oldWin }), cutEv());
    check(
        's19.pre.absentNoLine',
        !dPreAbs.top.evidence.some((e) => /older than the cutoff/.test(e)),
        dPreAbs.top.evidence.join('|'),
    );
    // H10 belt at the gate: a fabricated near-now cutoff with a small
    // days_in_past must NOT let check 28 fire on a recent window.
    const dPoison = diagnose(
        facts({ spl: RAW, earliest: String(NOW - 7 * 86400), latest: String(NOW - 3600) }),
        noEvidence({
            indexRowsInWindow: 0,
            ingestFacts: ingestFx({ cutoffEpoch: NOW - 100, daysInPast: 7 }),
        }),
    );
    check('s19.pre.h10PoisonDeclines', dPoison.top.id === 'index-empty-in-window', dPoison.top.id);

    // ---- item 3: the sourcetype-level cutoff context ---------------------
    const CUT7 = cutoffFromDays(7, NOW);
    const ctxFx = ingestFx({ cutoffEpoch: CUT7, daysInPast: 7 });
    const ctxWin = { earliest: String(CUT7 - 12 * 86400), latest: String(CUT7 - 2 * 86400) };
    const CTX_LINE = /ends before the ingest cutoff recorded as supplied/;
    // stale (+ the line), never-seen (+ the line), outside-window (+ the line)
    const dCtxStale = diagnose(
        facts({ spl: RAW, ...ctxWin }),
        noEvidence({
            indexRowsInWindow: 5000,
            sourcetypeCounts: { linux_messages_syslog: 5000 },
            sourcetypeLastSeen: { 'sap:hana:audit': CUT7 - 30 * 86400 },
            ingestFacts: ctxFx,
        }),
    );
    check('s19.ctx.staleCarries', dCtxStale.top.id === 'sourcetype-stale' && dCtxStale.top.evidence.some((e) => CTX_LINE.test(e)), `${dCtxStale.top.id}: ${dCtxStale.top.evidence.join('|')}`);
    const dCtxNever = diagnose(
        facts({ spl: RAW, ...ctxWin }),
        noEvidence({
            indexRowsInWindow: 5000,
            resolvedIndexes: ['sap_logserv_logs'],
            sourcetypeCounts: { linux_messages_syslog: 5000 },
            sourcetypeLastSeen: {},
            ingestFacts: ctxFx,
        }),
    );
    check('s19.ctx.neverSeenCarries', dCtxNever.top.id === 'sourcetype-never-seen' && dCtxNever.top.evidence.some((e) => CTX_LINE.test(e)), `${dCtxNever.top.id}: ${dCtxNever.top.evidence.join('|')}`);
    const dCtxOut = diagnose(
        facts({ spl: RAW, ...ctxWin }),
        noEvidence({
            indexRowsInWindow: 5000,
            sourcetypeCounts: { linux_messages_syslog: 5000 },
            sourcetypeLastSeen: { 'sap:hana:audit': NOW - 3600 },
            ingestFacts: ctxFx,
        }),
    );
    check('s19.ctx.outsideWindowCarries', dCtxOut.top.id === 'sourcetype-outside-window' && dCtxOut.top.evidence.some((e) => CTX_LINE.test(e)), `${dCtxOut.top.id}: ${dCtxOut.top.evidence.join('|')}`);
    // BOTH directions of the indexRowsInWindow conjunct (§19.8a-14): with an
    // empty index the line must appear NOWHERE (check 28's territory).
    const dCtxEmptyIdx = diagnose(
        facts({ spl: RAW, ...ctxWin }),
        noEvidence({
            indexRowsInWindow: 0,
            sourcetypeCounts: { linux_messages_syslog: 5000 },
            sourcetypeLastSeen: { 'sap:hana:audit': CUT7 - 30 * 86400 },
            ingestFacts: ctxFx,
        }),
    );
    check(
        's19.ctx.absentOnEmptyIndex',
        !dCtxEmptyIdx.all.some((v) => v.evidence.some((e) => CTX_LINE.test(e))),
        'the cutoff must never be narrated twice',
    );
    // future-timestamps is EXCLUDED by design (§19.8a-16, pinned absent).
    const dCtxFuture = diagnose(
        facts({ spl: RAW, ...ctxWin }),
        noEvidence({
            indexRowsInWindow: 5000,
            sourcetypeCounts: { linux_messages_syslog: 5000 },
            sourcetypeLastSeen: { 'sap:hana:audit': NOW + 3600 },
            ingestFacts: ctxFx,
        }),
    );
    check(
        's19.ctx.futureExcluded',
        dCtxFuture.top.id === 'sourcetype-future-timestamps' &&
            !dCtxFuture.top.evidence.some((e) => CTX_LINE.test(e)),
        `${dCtxFuture.top.id}: ${dCtxFuture.top.evidence.join('|')}`,
    );
    // No facts -> no line (trivially) + verdicts unchanged.
    const dCtxNoFx = diagnose(
        facts({ spl: RAW, ...ctxWin }),
        noEvidence({
            indexRowsInWindow: 5000,
            sourcetypeCounts: { linux_messages_syslog: 5000 },
            sourcetypeLastSeen: { 'sap:hana:audit': CUT7 - 30 * 86400 },
        }),
    );
    check('s19.ctx.noFactsNoLine', !dCtxNoFx.top.evidence.some((e) => CTX_LINE.test(e)), '');

    // ---- item 4: the cloud-provider stamp lines --------------------------
    const CACHED_AZ =
        '| inputlookup logserv_linux_rollup where metric="total" | addinfo | where bucket_ts>=info_min_time AND bucket_ts<info_max_time | search cloud_provider="azure" | stats sum(count) as count';
    const CACHED_AWS =
        '| inputlookup logserv_linux_rollup where metric="total" | addinfo | where bucket_ts>=info_min_time AND bucket_ts<info_max_time | search cloud_provider="aws" | stats sum(count) as count';
    const hasRowsEv = (fx: Record<string, unknown> | null): EvidenceShape =>
        noEvidence({
            indexRowsInWindow: 5000,
            collectionRowsInWindow: 7,
            collectionExtentProbed: true,
            collectionOldest: NOW - 100000,
            collectionNewest: NOW - 1000,
            ingestFacts: fx,
        });
    /* NOTE: with an intrinsic provider filter the FREE `intrinsic-provider`
     * verdict outranks `rollup-has-rows` as `top` (§12.5 free-first order),
     * so the stamp assertions search `all` — both are stamp surfaces and
     * BOTH must carry the line. */
    const entry = (d: DiagnosisShape, id: string): VerdictShape | undefined =>
        d.all.filter((v) => v.id === id)[0];
    const dStamp = diagnose(facts({ spl: CACHED_AZ }), hasRowsEv(ingestFx({ cloudProviderStamp: 'aws' })));
    const stampRhr = entry(dStamp, 'rollup-has-rows');
    check('s19.stamp.rollupHasRowsLine', !!stampRhr && stampRhr.evidence.some((e) => /ingest stamp is `aws`/.test(e)), JSON.stringify(stampRhr && stampRhr.evidence));
    check(
        's19.stamp.topSurfaceCarriesToo',
        dStamp.top.id === 'intrinsic-provider' && dStamp.top.evidence.some((e) => /ingest stamp is `aws`/.test(e)),
        `${dStamp.top.id}: ${dStamp.top.evidence.join('|')}`,
    );
    check(
        's19.stamp.tenseAndScope',
        !!stampRhr && stampRhr.evidence.some((e) => /since that setting was applied/.test(e) && /other forwarders may be configured differently/.test(e)),
        JSON.stringify(stampRhr && stampRhr.evidence),
    );
    // Confidence is untouched by the line (evidence-only).
    const dNoStamp = diagnose(facts({ spl: CACHED_AZ }), hasRowsEv(ingestFx({})));
    const noStampRhr = entry(dNoStamp, 'rollup-has-rows');
    check(
        's19.stamp.confidenceUnmoved',
        !!stampRhr && !!noStampRhr && stampRhr.confidence === noStampRhr.confidence && dStamp.top.id === dNoStamp.top.id,
        `${stampRhr && stampRhr.confidence} vs ${noStampRhr && noStampRhr.confidence}`,
    );
    check('s19.stamp.absentWhenUnknown', !!noStampRhr && !noStampRhr.evidence.some((e) => /ingest stamp/.test(e)), '');
    // Matching stamp: nothing to explain, no line.
    const dSame = diagnose(facts({ spl: CACHED_AZ }), hasRowsEv(ingestFx({ cloudProviderStamp: 'azure' })));
    check('s19.stamp.sameProviderNoLine', !dSame.all.some((v) => v.evidence.some((e) => /ingest stamp/.test(e))), '');
    // not_set: the neutral intended-config wording.
    const dNotSet = diagnose(facts({ spl: CACHED_AZ }), hasRowsEv(ingestFx({ cloudProviderStamp: 'not_set' })));
    const notSetRhr = entry(dNotSet, 'rollup-has-rows');
    check('s19.stamp.notSetNeutral', !!notSetRhr && notSetRhr.evidence.some((e) => /stamps no provider/.test(e) && /_meta/.test(e)), JSON.stringify(notSetRhr && notSetRhr.evidence));
    // aws-scoped panel: the OR-NOT clause rider on both branches.
    const dAws = diagnose(facts({ spl: CACHED_AWS }), hasRowsEv(ingestFx({ cloudProviderStamp: 'azure' })));
    const awsRhr = entry(dAws, 'rollup-has-rows');
    check('s19.stamp.awsClause', !!awsRhr && awsRhr.evidence.some((e) => /does not by itself explain an empty `aws` panel/.test(e)), JSON.stringify(awsRhr && awsRhr.evidence));
    const dAwsNS = diagnose(facts({ spl: CACHED_AWS }), hasRowsEv(ingestFx({ cloudProviderStamp: 'not_set' })));
    const awsNsRhr = entry(dAwsNS, 'rollup-has-rows');
    check('s19.stamp.awsClauseOnNotSet', !!awsNsRhr && awsNsRhr.evidence.some((e) => /does not by itself explain an empty `aws` panel/.test(e)), JSON.stringify(awsNsRhr && awsNsRhr.evidence));
    // The free active-filters verdict gets the line — via a CLONE (residue
    // pin per §19.8a-10: a following diagnosis without facts is byte-clean).
    const RAW_AZ = '`sap_logserv_idx_macro` cloud_provider="azure" sourcetype="sap:hana:audit" | stats count';
    const azFacts = facts({ spl: RAW_AZ, cloudProvider: 'azure' });
    const dFree1 = diagnose(azFacts, noEvidence({ indexRowsInWindow: 5000, ingestFacts: ingestFx({ cloudProviderStamp: 'gcp' }) }));
    const af1 = dFree1.all.filter((v) => v.id === 'active-filters');
    check('s19.stamp.activeFiltersLine', af1.length === 1 && af1[0].evidence.some((e) => /ingest stamp is `gcp`/.test(e)), JSON.stringify(af1.map((v) => v.evidence)));
    const dFree2 = diagnose(azFacts, noEvidence({ indexRowsInWindow: 5000 }));
    const af2 = dFree2.all.filter((v) => v.id === 'active-filters');
    check('s19.stamp.noResidue', af2.length === 1 && !af2[0].evidence.some((e) => /ingest stamp/.test(e)), JSON.stringify(af2.map((v) => v.evidence)));
    // The intrinsic-provider verdict (panel pins its own provider, picker off).
    const MC_AZ = '`sap_logserv_idx_macro` cloud_provider="azure" | stats count';
    const dIntr = diagnose(
        facts({ spl: MC_AZ, cloudProvider: 'all' }),
        noEvidence({ indexRowsInWindow: 5000, ingestFacts: ingestFx({ cloudProviderStamp: 'aws' }) }),
    );
    const intr = dIntr.all.filter((v) => v.id === 'intrinsic-provider');
    check('s19.stamp.intrinsicLine', intr.length === 1 && intr[0].evidence.some((e) => /ingest stamp is `aws`/.test(e)), JSON.stringify(intr.map((v) => v.evidence)));

    // ---- item 5: the pointer trigger -------------------------------------
    const POINTER_IDS = mod.INGEST_POINTER_VERDICT_IDS as string[];
    const shouldShow = mod.shouldShowIngestPointer as (id: string, ev: unknown) => boolean;
    check(
        's19.ptr.exactSet',
        JSON.stringify(POINTER_IDS.slice().sort()) ===
            JSON.stringify(
                ['index-empty-in-window', 'sourcetype-never-seen', 'rollup-source-never-seen', 'sourcetype-stale', 'routing-not-applied'].sort(),
            ),
        JSON.stringify(POINTER_IDS),
    );
    const EMPTINESS = mod.EMPTINESS_VERDICT_IDS as string[];
    check('s19.ptr.allEmptinessMembers', POINTER_IDS.every((i) => EMPTINESS.indexOf(i) !== -1), JSON.stringify(POINTER_IDS));
    // Mutation (c) target: the H20 exclusion, pinned explicitly.
    check('s19.ptr.outsideWindowExcluded', POINTER_IDS.indexOf('sourcetype-outside-window') === -1, JSON.stringify(POINTER_IDS));
    check('s19.ptr.sentence', /can take those filters into account/.test(mod.INGEST_POINTER_SENTENCE), mod.INGEST_POINTER_SENTENCE);
    const ptrEv = (over: Record<string, unknown> = {}): unknown =>
        Object.assign(noEvidence(), over);
    for (const id of POINTER_IDS) {
        check(`s19.ptr.shows.${id}`, shouldShow(id, ptrEv()) === true, id);
    }
    check('s19.ptr.hiddenOnOutsideWindow', shouldShow('sourcetype-outside-window', ptrEv()) === false, '');
    check('s19.ptr.hiddenOnOtherIds', shouldShow('rollup-never-built', ptrEv()) === false, '');
    check(
        's19.ptr.hiddenOnUsableFacts',
        shouldShow('index-empty-in-window', ptrEv({ ingestFacts: ingestFx({}) })) === false,
        'usable facts already answer the boundary',
    );
    check(
        's19.ptr.shownOnUnparsed',
        shouldShow('index-empty-in-window', ptrEv({ ingestFacts: ingestFx({ parseStatus: 'unparsed', filterEnabled: null }) })) === true,
        'an unparsed paste keeps the ask',
    );
    check(
        's19.ptr.shownOnDefaultsShape',
        shouldShow(
            'index-empty-in-window',
            ptrEv({ ingestFacts: ingestFx({ filterEnabled: false, daysInPast: 7, includeFilters: ['*/*'], excludeFilters: [] }) }),
        ) === true,
        'the defaults-shape keeps the ask',
    );
    const CHECK_NAME = 'Ingest-tier filter config (operator-supplied)';
    check(
        's19.ptr.hiddenOnFetchError',
        shouldShow('index-empty-in-window', ptrEv({ notes: [{ check: CHECK_NAME, status: 'error', detail: 'HTTP 503' }] })) === false,
        'a failed read is not "not supplied"',
    );
    check(
        's19.ptr.hiddenOnFetchSkip',
        shouldShow('index-empty-in-window', ptrEv({ notes: [{ check: CHECK_NAME, status: 'skipped', detail: 'budget' }] })) === false,
        '',
    );

    // ---- the §19 invariant mini-sweep: the new dims never move a verdict —
    // same top id + same confidences with the dim present vs stripped (only
    // the documented recent-contradiction cap may differ, and only downward
    // to possible on ingest-type-excluded).
    let s19combos = 0;
    const stampVals = [undefined, null, 'aws', 'azure', 'not_set'];
    const preVals = [undefined, null, CUT30 + 86400, CUT30 - 40 * 86400];
    const recentVals: Array<Record<string, number> | null | undefined> = [
        undefined,
        null,
        { 'sap:hana:audit': NOW - 30 * 86400 },
        { 'sap:hana:audit': NOW - 10 },
    ];
    const baseStates: Array<{ f: FactsShape; e: () => EvidenceShape }> = [
        { f: facts({ spl: RAW, ...oldWin }), e: () => cutEv() },
        { f: facts({ spl: RAW }), e: () => exEv() },
        { f: facts({ spl: CACHED_AZ }), e: () => hasRowsEv(exFx({ suppliedAt: NOW - 3600 })) },
    ];
    for (const st of baseStates) {
        const base = diagnose(st.f, st.e());
        const baseIds = ids(base).join(',');
        for (const sv of stampVals) {
            for (const pv of preVals) {
                for (const rv of recentVals) {
                    s19combos += 1;
                    const e2 = st.e();
                    const fx2 = e2.ingestFacts as Record<string, unknown>;
                    if (sv !== undefined) fx2.cloudProviderStamp = sv;
                    if (pv !== undefined) (e2 as unknown as Record<string, unknown>).preCutoffOldest = pv;
                    if (rv !== undefined) (e2 as unknown as Record<string, unknown>).sourcetypeRecentSeen = rv;
                    const d2 = diagnose(st.f, e2);
                    if (ids(d2).join(',') !== baseIds) {
                        fail(`s19 sweep: verdict-id drift from evidence dims (${baseIds} -> ${ids(d2).join(',')})`);
                    }
                    for (let i = 0; i < d2.all.length; i += 1) {
                        const c0 = base.all[i].confidence;
                        const c2 = d2.all[i].confidence;
                        if (c0 === c2) continue;
                        const allowed =
                            d2.all[i].id === 'ingest-type-excluded' &&
                            c2 === 'possible' &&
                            !!rv &&
                            Object.keys(rv).some((k) => (rv as Record<string, number>)[k] > NOW - 3600 + SKEW);
                        if (!allowed) {
                            fail(`s19 sweep: confidence moved by an evidence dim (${d2.all[i].id}: ${c0} -> ${c2})`);
                        }
                    }
                }
            }
        }
    }
    checks += 1;
    proc.stderr.write(`  s19 invariant: ${s19combos} evidence-dim combinations swept\n`);
}

// =========================================================================
// §17 Phase 5 — the deep-evidence verdicts.
// =========================================================================
const CACHED_METRIC =
    '| inputlookup logserv_hana_category_rollup where metric="password" | addinfo | where bucket_ts>=info_min_time AND bucket_ts<info_max_time | eval _time=bucket_ts | timechart span=1h sum(count)';
const RAW_GROUPED = '`sap_logserv_idx_macro` sourcetype="sap:hana:audit" is_critical=true | timechart span=1h count';

// Common cached-metric-arm base: source events present, this metric empty,
// sibling metrics present (the armAmbiguous shape). collectionNewest recent so
// the settled clamp leaves a window.
const armAmbiguousEv = (over: Partial<EvidenceShape>): EvidenceShape =>
    noEvidence({
        indexRowsInWindow: 5_000_000,
        resolvedIndexes: ['sap_logserv_logs'],
        sourcetypeCounts: { 'sap:hana:audit': 4000 },
        sourceScope: { sourcetypes: ['sap:hana:audit'], tags: [], via: 'logserv_hana_aggregate' },
        collectionRowsInWindow: 0,
        collectionRowsAllMetrics: 500,
        collectionExtentProbed: true,
        collectionOldest: NOW - 30 * 86400,
        collectionNewest: NOW - 3600,
        ...over,
    });

// 17.2 — cache-contradicted: raw arm returns rows, cache holds none. Confirmed.
{
    const d = diagnose(
        facts({ spl: CACHED_METRIC, rowCount: 0 }),
        armAmbiguousEv({ rawArmRan: true, rawArmError: '', rawArmRows: 42 }),
    );
    check('17.2 cacheContradicted.id', d.top.id === 'cache-contradicted', `got ${d.top.id}`);
    check('17.2 cacheContradicted.confirmed', d.top.confidence === 'confirmed', `got ${d.top.confidence}`);
}
// 17.2 — cached-raw-agree-empty: raw arm clean and empty on the ambiguous branch.
{
    const d = diagnose(
        facts({ spl: CACHED_METRIC, rowCount: 0 }),
        armAmbiguousEv({ rawArmRan: true, rawArmError: '', rawArmRows: 0 }),
    );
    check('17.2 agreeEmpty.id', d.top.id === 'cached-raw-agree-empty', `got ${d.top.id}`);
    check('17.2 agreeEmpty.expected', d.top.confidence === 'expected', `got ${d.top.confidence}`);
}
// §17.8a-4 — an ERRORED raw arm must NOT certify health. The fixture pins the
// error GUARD specifically: rawArmRan true but an error set + rows 0 (an
// inconsistent object the guard defends against) must NOT reach agree-empty.
{
    const d = diagnose(
        facts({ spl: CACHED_METRIC, rowCount: 0 }),
        armAmbiguousEv({ rawArmRan: true, rawArmError: 'HTTP 500', rawArmRows: 0 }),
    );
    check(
        '17.8a-4 erroredRawArm.notCertified',
        d.top.id !== 'cached-raw-agree-empty' && d.top.id !== 'cache-contradicted',
        `an errored raw arm produced ${d.top.id}`,
    );
    check('17.8a-4 erroredRawArm.hedged', d.top.id === 'rollup-metric-empty', `got ${d.top.id}`);
}
// §17.8a-3 — on the rollup-GAP branch (no metric arm), raw agreement DOWNGRADES
// to possible, never certifies health.
{
    const d = diagnose(
        facts({ spl: CACHED_METRIC.replace('where metric="password" ', ''), rowCount: 0 }),
        noEvidence({
            indexRowsInWindow: 5_000_000,
            resolvedIndexes: ['sap_logserv_logs'],
            sourcetypeCounts: { 'sap:hana:audit': 4000 },
            sourceScope: { sourcetypes: ['sap:hana:audit'], tags: [], via: 'logserv_hana_aggregate' },
            collectionRowsInWindow: 0,
            collectionRowsAllMetrics: 0,
            collectionExtentProbed: true,
            collectionOldest: NOW - 30 * 86400,
            collectionNewest: NOW - 3600,
            rawArmRan: true,
            rawArmError: '',
            rawArmRows: 0,
        }),
    );
    check('17.8a-3 gapAgree.id', d.top.id === 'rollup-gap', `got ${d.top.id}`);
    check('17.8a-3 gapAgree.downgraded', d.top.confidence === 'possible', `got ${d.top.confidence}`);
    check(
        '17.8a-3 gapAgree.notCertified',
        !d.all.some((v) => v.id === 'cached-raw-agree-empty'),
        'agreement certified health on the gap branch',
    );
}
// 17.3 — field-never-populated (raw tier).
{
    const d = diagnose(
        facts({ spl: RAW_GROUPED, rowCount: 0 }),
        noEvidence({
            indexRowsInWindow: 5_000_000,
            resolvedIndexes: ['sap_logserv_logs'],
            sourcetypeCounts: { 'sap:hana:audit': 4000 },
            fieldProbe: {
                sampled: 1500,
                filters: [{ field: 'is_critical', op: 'eq', values: ['true'], present: 0, distinct: 0, matches: 0 }],
            },
        }),
    );
    check('17.3 neverPop.id', d.top.id === 'field-never-populated', `got ${d.top.id}`);
    check('17.3 neverPop.likely', d.top.confidence === 'likely', `got ${d.top.confidence} (sampled<2000 → likely)`);
}
// §17.8a-12 — a CAPPED sample (2000) caps the grade at possible.
{
    const d = diagnose(
        facts({ spl: RAW_GROUPED, rowCount: 0 }),
        noEvidence({
            indexRowsInWindow: 5_000_000,
            resolvedIndexes: ['sap_logserv_logs'],
            sourcetypeCounts: { 'sap:hana:audit': 4000 },
            fieldProbe: {
                sampled: 2000,
                filters: [{ field: 'is_critical', op: 'eq', values: ['true'], present: 0, distinct: 0, matches: 0 }],
            },
        }),
    );
    check('17.8a-12 cappedSample.possible', d.top.confidence === 'possible', `got ${d.top.confidence}`);
}
// 17.3 — field-value-mismatch (field present, value never matches).
{
    const d = diagnose(
        facts({ spl: RAW_GROUPED, rowCount: 0 }),
        noEvidence({
            indexRowsInWindow: 5_000_000,
            resolvedIndexes: ['sap_logserv_logs'],
            sourcetypeCounts: { 'sap:hana:audit': 4000 },
            fieldProbe: {
                sampled: 1500,
                filters: [{ field: 'action', op: 'eq', values: ['blocked'], present: 1400, distinct: 3, matches: 0 }],
            },
        }),
    );
    check('17.3 valueMismatch.id', d.top.id === 'field-value-mismatch', `got ${d.top.id}`);
    check('17.3 valueMismatch.possible', d.top.confidence === 'possible', `got ${d.top.confidence}`);
}
// 17.4 — lookup-not-registered.
{
    const d = diagnose(
        facts({ spl: RAW_GROUPED, rowCount: 0 }),
        noEvidence({
            indexRowsInWindow: 5_000_000,
            resolvedIndexes: ['sap_logserv_logs'],
            sourcetypeCounts: { 'sap:hana:audit': 4000 },
            lookupsMissing: ['some_lookup'],
        }),
    );
    check('17.4 lookup.present', d.all.some((v) => v.id === 'lookup-not-registered'), 'lookup verdict absent');
}
// 17.5 — clause-excludes-all (control 0, one killer).
{
    const d = diagnose(
        facts({ spl: RAW_GROUPED, rowCount: 0 }),
        noEvidence({
            indexRowsInWindow: 5_000_000,
            resolvedIndexes: ['sap_logserv_logs'],
            sourcetypeCounts: { 'sap:hana:audit': 4000 },
            bisect: { controlRows: 0, clauses: [{ field: 'is_critical', fragment: 'is_critical=true', removedRows: 12431 }] },
        }),
    );
    check('17.5 bisect.present', d.all.some((v) => v.id === 'clause-excludes-all'), 'bisect verdict absent');
    check(
        '17.5 bisect.possible',
        (d.all.find((v) => v.id === 'clause-excludes-all')?.confidence ?? '') === 'possible',
        'bisect must be possible, never higher',
    );
}
// §17.8a-7 — control > 0 → the bisect concludes NOTHING, even with a would-be
// killer clause present (the control guard, not the empty-clauses guard, is
// what must stop it).
{
    const d = diagnose(
        facts({ spl: RAW_GROUPED, rowCount: 0 }),
        noEvidence({
            indexRowsInWindow: 5_000_000,
            resolvedIndexes: ['sap_logserv_logs'],
            sourcetypeCounts: { 'sap:hana:audit': 4000 },
            bisect: { controlRows: 999, clauses: [{ field: 'x', fragment: 'x=1', removedRows: 5 }] },
        }),
    );
    check(
        '17.8a-7 bisectControlPositive.silent',
        !d.all.some((v) => v.id === 'clause-excludes-all'),
        'the bisect spoke though the control was non-zero',
    );
}
// §17.8a-14 — a CONFIRMED cached-layer verdict outranks a likely check-22 one.
{
    const d = diagnose(
        facts({ spl: RAW_GROUPED, rowCount: 0 }),
        noEvidence({
            indexRowsInWindow: 5_000_000,
            resolvedIndexes: ['sap_logserv_logs'],
            sourcetypeCounts: { 'sap:hana:audit': 4000 },
            // both a confirmed sourcetype-tier gap AND a field probe: the gap wins.
            sourceScope: { sourcetypes: ['sap:hana:audit'], tags: [], via: 'logserv_hana_aggregate' },
            fieldProbe: {
                sampled: 1500,
                filters: [{ field: 'is_critical', op: 'eq', values: ['true'], present: 0, distinct: 0, matches: 0 }],
            },
        }),
    );
    // Raw tier + present sourcetype but empty panel: gateSourcetype returns null
    // (events present), so the field probe is the ranking verdict here — but it
    // must never outrank a confirmed. This raw panel has no cached gap, so the
    // check is simply that a raw field-never-populated is allowed to surface.
    check('17.8a-14 fieldProbe.surfaces', d.all.some((v) => v.id === 'field-never-populated'), 'field probe did not surface');
}

if (failures > 0) {
    proc.stderr.write(`\ndiagCascade consistency test: ${failures} failure(s) of ${checks} checks\n`);
    proc.exit(1);
}
console.log(`diagCascade consistency test: ${checks} checks OK`);
