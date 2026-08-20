/**
 * Build-time consistency test for `columnCoverage.ts` + the §18 partial-mode
 * invariants that flow from it (design §18 / §18.8a).
 *
 * Pins, and their review provenance:
 *  - the four blank kinds (absent / empty-string / '(none)' sentinel /
 *    empty-multivalue) all COUNT as blank (H-F17, W-11);
 *  - a key absent from EVERY row is classified BLANK, never skipped (H-F3 —
 *    Splunk's JSON omits valueless fields, the exact reported-symptom shape);
 *  - numeric zero is POPULATED (a 0 is a value, not a gap);
 *  - the 500-row reduction cap + the `capped` flag (W-10);
 *  - `hasRender` rides through (render columns are never probed — P-2);
 *  - the publish map: round-trip, bounded, evict-oldest;
 *  - the §18.8a-20 verdict-id classification: every id the cascade can emit is
 *    classified partial-allowed or partial-forbidden (drift check lives in
 *    bin/check-diagnostics.js; here we pin the sets are disjoint + non-empty);
 *  - the §18.8a-1 report-safety invariant: PanelFacts carries NO rows field —
 *    the coverage summary is the ONLY channel, and it holds counts, not values.
 *
 * Run standalone with: `yarn check:diagnostics`
 */

/* eslint-disable no-console */

export {};

const proc = process as unknown as {
    stderr: { write(s: string): void };
    stdout: { write(s: string): void };
    exit(code: number): never;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const cov = require('./columnCoverage') as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const cascade = require('./diagCascade') as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const pd = require('./panelDiagnosis') as any;

const computeColumnCoverage = cov.computeColumnCoverage as (
    rows: unknown[],
    columns: Array<{ key: string; hasRender: boolean }>,
) => {
    columns: Array<{ key: string; populated: number; blankKind?: string; hasRender: boolean }>;
    total: number;
    capped: boolean;
};

let failures = 0;
let checks = 0;
const check = (label: string, ok: boolean, detail: string): void => {
    checks += 1;
    if (!ok) {
        failures += 1;
        proc.stderr.write(`FAIL: ${label}: ${detail}\n`);
    }
};

// ---------------------------------------------------------------------------
// 1. The reducer: blank kinds.
// ---------------------------------------------------------------------------
{
    const rows = [
        { a: 'x', b: '', c: '(none)', d: [], e: 0 },
        { a: 'y', b: '', c: '(none)', d: [], e: 5 },
    ];
    const s = computeColumnCoverage(rows, [
        { key: 'a', hasRender: false },
        { key: 'b', hasRender: false },
        { key: 'c', hasRender: false },
        { key: 'd', hasRender: false },
        { key: 'e', hasRender: false },
        { key: 'missing', hasRender: false },
    ]);
    const by = (k: string) => s.columns.find((c) => c.key === k)!;
    check('populated string column', by('a').populated === 2, JSON.stringify(by('a')));
    check('empty-string is blank', by('b').populated === 0 && by('b').blankKind === 'empty-string', JSON.stringify(by('b')));
    check('sentinel is blank', by('c').populated === 0 && by('c').blankKind === 'sentinel', JSON.stringify(by('c')));
    check('empty multivalue is blank', by('d').populated === 0 && by('d').blankKind === 'empty-multivalue', JSON.stringify(by('d')));
    check('numeric zero is POPULATED', by('e').populated === 2, JSON.stringify(by('e')));
    // H-F3 — the absent-key column is BLANK, not skipped.
    check('absent key is blank (never skipped)', by('missing').populated === 0 && by('missing').blankKind === 'absent', JSON.stringify(by('missing')));
    check('total rows', s.total === 2 && s.capped === false, JSON.stringify({ t: s.total, c: s.capped }));
}

// 2. Mixed blank kinds pick the dominant kind; partial columns keep counts.
{
    const rows = [{ a: '' }, { a: '' }, { a: '(none)' }, { a: 'v' }];
    const s = computeColumnCoverage(rows, [{ key: 'a', hasRender: false }]);
    check('partial column counts', s.columns[0].populated === 1, JSON.stringify(s.columns[0]));
    check('dominant blank kind', s.columns[0].blankKind === 'empty-string', JSON.stringify(s.columns[0]));
}

// 3. The 500-row cap.
{
    const rows: unknown[] = [];
    for (let i = 0; i < 600; i += 1) rows.push({ a: i < 550 ? 'v' : '' });
    const s = computeColumnCoverage(rows, [{ key: 'a', hasRender: false }]);
    check('cap applies', s.total === cov.COVERAGE_ROW_CAP && s.capped === true, JSON.stringify({ t: s.total, c: s.capped }));
    check('cap is 500', cov.COVERAGE_ROW_CAP === 500, String(cov.COVERAGE_ROW_CAP));
}

// 4. hasRender rides through.
{
    const s = computeColumnCoverage([{}], [{ key: 'x', hasRender: true }]);
    check('hasRender preserved', s.columns[0].hasRender === true, JSON.stringify(s.columns[0]));
}

// 5. The publish map: round-trip + bounded evict-oldest.
{
    cov.clearColumnCoverage();
    const one = computeColumnCoverage([{ a: 1 }], [{ key: 'a', hasRender: false }]);
    cov.recordColumnCoverage('SPL_A', one);
    check('map round-trip', cov.coverageFor('SPL_A') !== null, 'miss');
    check('map miss → null', cov.coverageFor('SPL_NOPE') === null, 'hit');
    for (let i = 0; i < 450; i += 1) cov.recordColumnCoverage(`SPL_${i}`, one);
    check('map bounded', cov.coverageCount() <= 400, String(cov.coverageCount()));
    check('oldest evicted', cov.coverageFor('SPL_A') === null, 'survived');
    check('newest survives', cov.coverageFor('SPL_449') !== null, 'evicted');
    cov.clearColumnCoverage();
}

// ---------------------------------------------------------------------------
// 6. §18.8a-20 — the verdict-id classification sets exist, are non-empty and
//    DISJOINT. (The completeness drift check — every id literal in the source
//    classified — lives in bin/check-diagnostics.js where the source text is
//    available.)
// ---------------------------------------------------------------------------
{
    const emp = cascade.EMPTINESS_VERDICT_IDS as string[];
    const part = cascade.PARTIAL_ALLOWED_VERDICT_IDS as string[];
    check('EMPTINESS set non-empty', Array.isArray(emp) && emp.length > 10, String(emp && emp.length));
    check('PARTIAL set non-empty', Array.isArray(part) && part.length > 5, String(part && part.length));
    const overlap = emp.filter((id) => part.indexOf(id) !== -1);
    check('sets disjoint', overlap.length === 0, overlap.join(','));
    check('index-not-visible forbidden in partial', emp.indexOf('index-not-visible') !== -1, 'missing (H-F9)');
    check('extraction-app-missing allowed in partial', part.indexOf('extraction-app-missing') !== -1, 'missing (§18.8a-21)');
}

// ---------------------------------------------------------------------------
// 7. §18.8a-18/1 — the partial-mode SWEEP: a populated panel may never receive
//    an emptiness verdict, whatever evidence is thrown at it.
// ---------------------------------------------------------------------------
{
    const emp = cascade.EMPTINESS_VERDICT_IDS as string[];
    const partialFacts = {
        spl: '| inputlookup logserv_linux_rollup where metric="oom" | addinfo | where bucket_ts>=info_min_time AND bucket_ts<info_max_time | stats sum(count) as Kills by host',
        earliest: '-24h',
        latest: 'now',
        dispatched: true,
        loading: false,
        errorMessage: null,
        rowCount: 12,
        cloudProvider: 'all',
    };
    // Throw a maximally-empty-looking evidence object at it: every emptiness
    // signal firing at once. None may surface.
    const nastyEvidence = {
        indexRowsInWindow: 0,
        resolvedIndexes: [],
        macroIndexes: ['sap_logserv_logs'],
        visibleIndexes: ['main'],
        sourcetypeCounts: { linux_secure: 0 },
        sourcetypeLastSeen: {},
        fallbackRowsInWindow: 100,
        routedRowsInWindow: 0,
        sourceScope: { sourcetypes: ['linux_secure'], tags: [], via: 'logserv_linux_aggregate' },
        producerDisabled: ['logserv_linux_aggregate'],
        producerTracedCount: 1,
        producerNames: ['logserv_linux_aggregate'],
        platformSkips: null,
        collectionRowsInWindow: 0,
        collectionRowsAllMetrics: 0,
        collectionExtentProbed: true,
        collectionOldest: null,
        collectionNewest: null,
        installedApps: [],
        kvStoreStatus: 'ready',
        ingestFacts: null,
        canaryMs: 100,
        rawArmRan: true,
        rawArmRows: 500,
        rawArmError: '',
        fieldProbe: { sampled: 100, filters: [{ field: 'x', op: 'eq', values: ['y'], present: 0, distinct: 0, matches: 0 }] },
        lookupsMissing: ['bogus'],
        providerRowsPresent: false,
        bisect: { controlRows: 0, clauses: [{ field: 'x', fragment: 'x=y', removedRows: 9 }] },
        columnProbe: null,
        scalarTwin: null,
        notes: [],
        budgetExhausted: false,
    };
    const diag = cascade.diagnosePanel(partialFacts, nastyEvidence);
    const ids = (diag.all as Array<{ id: string }>).map((v) => v.id);
    const leaked = ids.filter((id) => emp.indexOf(id) !== -1);
    check('partial sweep: no emptiness verdicts leak', leaked.length === 0, leaked.join(','));
    check('partial fallback reachable', diag.top.id === 'partial-undetermined' || ids.indexOf('partial-undetermined') !== -1 || diag.top.confidence !== 'not-evaluated', JSON.stringify(diag.top.id));
    const anyEmptyWording = (diag.all as Array<{ headline: string }>).some((v) => /why this view is empty/i.test(v.headline));
    check('partial: no "why this view is empty" wording', !anyEmptyWording, 'FALLBACK leaked');
}

// 8. §18.8a-5 — unknown mode refuses (null rowCount never diagnosed as empty).
{
    const facts = {
        spl: '`sap_logserv_idx_macro` sourcetype="sap:saprouter" | stats count by host',
        earliest: '-24h',
        latest: 'now',
        dispatched: true,
        loading: false,
        errorMessage: null,
        rowCount: null,
        cloudProvider: 'all',
    };
    check('mode: unknown for null rowCount', pd.diagnosisMode(facts) === 'unknown', pd.diagnosisMode(facts));
    const emptyEv = { ...{}, notes: [], budgetExhausted: false } as Record<string, unknown>;
    const diag = cascade.diagnosePanel(facts, emptyEv);
    check('unknown: not-evaluated top', diag.top.confidence === 'not-evaluated', diag.top.id);
    const ids = (diag.all as Array<{ id: string }>).map((v) => v.id);
    check('unknown: mode-unknown present', ids.indexOf('mode-unknown') !== -1, ids.join(','));
}

// 9. §18.8a-7 — zeroValued routes to empty; emptySafeKpi alone NEVER does.
{
    const zv = { spl: '| inputlookup logserv_abapnet_rollup where metric="icmerr" | addinfo | where bucket_ts>=info_min_time AND bucket_ts<info_max_time | stats count as n, sum(count) as count | fillnull value=0 count | fields count', earliest: '-24h', latest: 'now', dispatched: true, loading: false, errorMessage: null, rowCount: 1, cloudProvider: 'all', zeroValued: true };
    check('zeroValued → empty', pd.diagnosisMode(zv) === 'empty', pd.diagnosisMode(zv));
    const populatedSameSpl = { ...zv, zeroValued: undefined, rowCount: 1 };
    check('emptySafeKpi alone → partial (never empty)', pd.diagnosisMode(populatedSameSpl) === 'partial', pd.diagnosisMode(populatedSameSpl));
}

// 10. §18.8a-9 — a legitimately-zero cached KPI concludes expected-class, and
//     never a backfill prescription: metric rows > 0 → panel-zero-confirmed.
{
    const zv = { spl: '| inputlookup logserv_abapnet_rollup where metric="icmerr" | addinfo | where bucket_ts>=info_min_time AND bucket_ts<info_max_time | stats count as n, sum(count) as count | fillnull value=0 count | fields count', earliest: '-24h', latest: 'now', dispatched: true, loading: false, errorMessage: null, rowCount: 1, cloudProvider: 'all', zeroValued: true };
    const ev = {
        indexRowsInWindow: 1000, resolvedIndexes: ['sap_logserv_logs'], macroIndexes: null, visibleIndexes: null,
        sourcetypeCounts: null, sourcetypeLastSeen: null, fallbackRowsInWindow: null, routedRowsInWindow: null,
        sourceScope: null, producerDisabled: null, producerTracedCount: null, producerNames: null, platformSkips: null,
        collectionRowsInWindow: 40, collectionRowsAllMetrics: null, collectionExtentProbed: true,
        collectionOldest: 1780000000, collectionNewest: Math.floor(Date.now() / 1000) - 3600,
        installedApps: null, kvStoreStatus: null, ingestFacts: null, canaryMs: 50,
        rawArmRan: false, rawArmRows: null, rawArmError: '', fieldProbe: null, lookupsMissing: null,
        providerRowsPresent: null, bisect: null, columnProbe: null, scalarTwin: null, notes: [], budgetExhausted: false,
    };
    const diag = cascade.diagnosePanel(zv, ev);
    check('zero + metric rows → panel-zero-confirmed', diag.top.id === 'panel-zero-confirmed', diag.top.id);
    check('zero-confirmed is expected-class', diag.top.confidence === 'expected', diag.top.confidence);
    // With metric rows 0 and an agreeing scalar twin → the same conclusion.
    const ev2 = { ...ev, collectionRowsInWindow: 0, collectionRowsAllMetrics: 200, scalarTwin: { field: 'count', value: 0 } };
    const diag2 = cascade.diagnosePanel(zv, ev2);
    check('zero + twin agreement → panel-zero-confirmed', diag2.top.id === 'panel-zero-confirmed', diag2.top.id);
    // A disagreeing twin is at most possible — NEVER confirmed (§18.8a-10).
    const ev3 = { ...ev, collectionRowsInWindow: 0, collectionRowsAllMetrics: 200, scalarTwin: { field: 'count', value: 812 } };
    const diag3 = cascade.diagnosePanel(zv, ev3);
    check('zero + twin disagreement → zero-value-mismatch', diag3.top.id === 'zero-value-mismatch', diag3.top.id);
    check('twin disagreement capped at possible', diag3.top.confidence === 'possible', diag3.top.confidence);
}

// 11. §18.8a-17 — the honest floor: unreachable while any column is unaccounted.
{
    const partialFacts = {
        spl: '| inputlookup logserv_webdisp_slowtrace_rollup | addinfo | where bucket_ts>=info_min_time AND bucket_ts<info_max_time | sort 20 - total_us | table _time, uri, status',
        earliest: '-24h', latest: 'now', dispatched: true, loading: false, errorMessage: null, rowCount: 20, cloudProvider: 'all',
    };
    const base = {
        indexRowsInWindow: null, resolvedIndexes: null, macroIndexes: null, visibleIndexes: null,
        sourcetypeCounts: null, sourcetypeLastSeen: null, fallbackRowsInWindow: null, routedRowsInWindow: null,
        sourceScope: { sourcetypes: ['sap:webdispatcher:access'], tags: [], via: 'logserv_webdisp_slowtrace_aggregate' },
        producerDisabled: null, producerTracedCount: null, producerNames: null, platformSkips: null,
        collectionRowsInWindow: null, collectionRowsAllMetrics: null, collectionExtentProbed: false,
        collectionOldest: null, collectionNewest: null, installedApps: null, kvStoreStatus: null,
        ingestFacts: null, canaryMs: 40, rawArmRan: false, rawArmRows: null, rawArmError: '',
        fieldProbe: null, lookupsMissing: null, providerRowsPresent: null, bisect: null, scalarTwin: null,
        notes: [], budgetExhausted: false,
    };
    // (a) a DROPPED column blocks the floor.
    const evDropped = { ...base, columnProbe: { totalRows: 20, capped: false, populated: ['_time', 'status'], derivedOrComputed: [], dropped: [{ column: 'uri', reason: 'unprobeable' }], blanks: [], sampled: null } };
    const d1 = cascade.diagnosePanel(partialFacts, evDropped);
    check('dropped column blocks the floor', d1.top.id !== 'panel-data-present', d1.top.id);
    check('dropped column names itself', (d1.all as Array<{ id: string }>).some((v) => v.id === 'column-tier-incomplete'), JSON.stringify((d1.all as Array<{ id: string }>).map((v) => v.id)));
    // (b) a fully-accounted panel reaches the floor.
    const evClean = { ...base, columnProbe: { totalRows: 20, capped: false, populated: ['_time', 'uri', 'status'], derivedOrComputed: [], dropped: [], blanks: [], sampled: null } };
    const d2 = cascade.diagnosePanel(partialFacts, evClean);
    check('clean coverage reaches the floor', d2.top.id === 'panel-data-present', d2.top.id);
    // (c) a blank column with a completed 0-present probe → the extraction verdict.
    const evBlank = { ...base, columnProbe: { totalRows: 20, capped: false, populated: ['_time', 'status'], derivedOrComputed: [], dropped: [], blanks: [{ column: 'uri', probeName: 'uri', blankKind: 'absent', present: 0, storedByAggregate: true }], sampled: 800 } };
    const d3 = cascade.diagnosePanel(partialFacts, evBlank);
    check('blank + probe 0 → column-never-populated', d3.top.id === 'column-never-populated', d3.top.id);
    check('uncapped sample → likely', d3.top.confidence === 'likely', d3.top.confidence);
    // (d) blank but source carries it (cached) → column-not-summarised, possible.
    const evLost = { ...base, columnProbe: { ...evBlank.columnProbe, blanks: [{ column: 'uri', probeName: 'uri', blankKind: 'absent', present: 512, storedByAggregate: true }] } };
    const d4 = cascade.diagnosePanel(partialFacts, evLost);
    check('blank + source present (cached) → column-not-summarised', d4.top.id === 'column-not-summarised', d4.top.id);
    check('column-not-summarised capped at possible', d4.top.confidence === 'possible', d4.top.confidence);
    // (e) the aggregate provably does not store it → column-not-stored, no backfill wording.
    const evNotStored = { ...base, columnProbe: { ...evBlank.columnProbe, blanks: [{ column: 'uri', probeName: 'uri', blankKind: 'absent', present: 512, storedByAggregate: false }] } };
    const d5 = cascade.diagnosePanel(partialFacts, evNotStored);
    check('aggregate-not-stored beats not-summarised', d5.top.id === 'column-not-stored', d5.top.id);
    check('not-stored says backfill cannot help', /backfill cannot add it/i.test(d5.top.headline), d5.top.headline);
}

proc.stdout.write(`columnCoverage consistency test: ${checks} checks ${failures === 0 ? 'OK' : `- ${failures} FAILURES`}\n`);
if (failures > 0) proc.exit(1);
