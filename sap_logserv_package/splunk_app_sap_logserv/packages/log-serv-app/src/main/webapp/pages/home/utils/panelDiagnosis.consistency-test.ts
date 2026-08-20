/**
 * Build-time consistency test for `panelDiagnosis.ts` (session 093).
 *
 * The free checks auto-run on every empty panel, so the thing that matters
 * most is not that they fire — it is that they STAY SILENT unless they have
 * something honest to say, and that they never accuse the platform of a fault
 * on evidence they do not have (design doc §10 guard, Risk 8).
 *
 * The invariant test at the bottom enforces that mechanically: across a corpus
 * of real dispatched SPL, every verdict a free check can produce must be
 * Expected-class — with exactly two allowed exceptions, both of which carry
 * complete local evidence (a quoted Splunk error, and a static clause that
 * provably cannot match).
 *
 * Run with: `npx ts-node --transpile-only panelDiagnosis.consistency-test.ts`
 * Exits 1 on failure.
 */

/* eslint-disable no-console */

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
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mod = require('./panelDiagnosis') as any;
const explain = mod.explainEmptyPanel as (f: FactsShape) => VerdictShape | null;
const allFree = mod.allFreeVerdicts as (f: FactsShape) => VerdictShape[];
const gate0 = mod.evaluateGate0 as (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    probe: any,
    a?: boolean,
    b?: boolean,
) => VerdictShape;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const probeSpl = (require('./splProbe') as any).probeSpl as (s: string) => any;

let failures = 0;
let checks = 0;
const fail = (m: string): void => {
    failures += 1;
    proc.stderr.write(`FAIL: ${m}\n`);
};

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

const expectId = (label: string, f: FactsShape, id: string | null): void => {
    checks += 1;
    const v = explain(f);
    const got = v ? v.id : null;
    if (got !== id) fail(`${label}: verdict id = ${String(got)}, want ${String(id)}`);
};

// --- real dispatched SPL, from the session-093 census ----------------------

const ROLLUP_HOURLY =
    '| inputlookup logserv_linux_rollup where metric="total" | addinfo | where bucket_ts>=info_min_time AND bucket_ts<info_max_time | stats count as n, sum(count) as count | fillnull value=0 count | fields count';
const ROLLUP_DAILY =
    '| inputlookup logserv_beaconing_rollup | addinfo | where day_ts>=info_min_time AND day_ts<info_max_time | stats count as n, sum(count) as count | fillnull value=0 count | fields count';
const RAW =
    '`sap_logserv_idx_macro` sourcetype="sap:hana:audit" | stats count by action_type';
const TSTATS =
    '| tstats count WHERE `sap_logserv_idx_macro` sourcetype="squid:access" BY _time span=1d | timechart span=1d sum(count) AS count';

// --- 1. Silence is the default -------------------------------------------
// A wide window, no filters, a perfectly ordinary rollup read that came back
// empty: there is nothing honest to say without dispatching something, so the
// panel must keep the message it already had.
expectId('silence.rollupWideNoFilters', facts({ spl: ROLLUP_HOURLY }), null);
expectId('silence.rawWideNoFilters', facts({ spl: RAW }), null);
expectId('silence.tstats', facts({ spl: TSTATS }), null);
// Still loading — never speak before the answer is in.
expectId('silence.loading', facts({ spl: ROLLUP_HOURLY, loading: true }), null);

// --- 2. Time-grain (check 20) --------------------------------------------
// Hourly rollup + sub-hour window: structurally cannot answer.
expectId(
    'grain.hourlySubHour',
    facts({ spl: ROLLUP_HOURLY, earliest: '-15m', latest: 'now' }),
    'time-grain-hourly',
);
// At/above an hour it is fine — the hourly coarseness at the edges is accepted.
expectId('grain.hourlyAtHour', facts({ spl: ROLLUP_HOURLY, earliest: '-1h', latest: 'now' }), null);
expectId('grain.hourlyWide', facts({ spl: ROLLUP_HOURLY, earliest: '-24h', latest: 'now' }), null);
// Daily rollup + sub-day window.
expectId(
    'grain.dailySubDay',
    facts({ spl: ROLLUP_DAILY, earliest: '-4h', latest: 'now' }),
    'time-grain-daily',
);
expectId('grain.dailyWide', facts({ spl: ROLLUP_DAILY, earliest: '-7d', latest: 'now' }), null);
// A RAW arm answers any window exactly — the rule must never fire on it. This
// is what `useHybridSearch` routes sub-hour windows to, so a false positive
// here would contradict the app's own correct behaviour.
expectId('grain.rawSubHourIsFine', facts({ spl: RAW, earliest: '-15m', latest: 'now' }), null);
expectId('grain.tstatsSubHourIsFine', facts({ spl: TSTATS, earliest: '-15m', latest: 'now' }), null);

// --- 3. Active global filters --------------------------------------------
// The cloud filter is sticky per user across every dashboard, so a selection
// made weeks ago silently narrows everything. Highest-value free statement.
{
    const spl =
        '| inputlookup logserv_linux_rollup where metric="total" | addinfo | where bucket_ts>=info_min_time AND bucket_ts<info_max_time | search cloud_provider="gcp" | stats sum(count) as count';
    expectId('filters.cloudSpliced', facts({ spl, cloudProvider: 'gcp' }), 'active-filters');
    checks += 1;
    const v = explain(facts({ spl, cloudProvider: 'gcp' }));
    if (!v || v.headline.indexOf('GCP') === -1) {
        fail(`filters.cloudSpliced: headline should name the provider, got "${v && v.headline}"`);
    }
}
{
    // Raw-form splice, and the headline should name the sourcetype it wanted.
    const spl =
        '`sap_logserv_idx_macro` cloud_provider="azure" sourcetype="sap:hana:audit" | stats count';
    checks += 1;
    const v = explain(facts({ spl, cloudProvider: 'azure' }));
    if (!v || v.id !== 'active-filters' || v.headline.indexOf('sap:hana:audit') === -1) {
        fail(`filters.rawSplice: expected a sourcetype-naming active-filters verdict, got ${JSON.stringify(v)}`);
    }
}
{
    // Host filter alone.
    const spl = '`sap_logserv_idx_macro` host="hec53v013858" sourcetype="sap:saprouter" | stats count';
    expectId('filters.host', facts({ spl }), 'active-filters');
}
/* --- REGRESSION, session 094 -------------------------------------------
 * A provider in the SPL with the picker on "All" is INTRINSIC to the panel,
 * not a filter the user set. Multi-Cloud Overview's per-provider KPIs are
 * exactly this shape: the dashboard is deliberately exempt from the global
 * filter, yet build 306 told the user "the Cloud filter is set to AZURE"
 * when it was on All — advising them to change a setting they never made.
 * Observed live on splunk-sh-idxr, both the Azure and GCP cards. */
{
    const spl =
        '| tstats count WHERE `sap_logserv_idx_macro` cloud_provider="azure" | stats sum(count) as count';
    expectId('filters.intrinsicProvider', facts({ spl, cloudProvider: 'all' }), 'intrinsic-provider');
    checks += 1;
    const v = explain(facts({ spl, cloudProvider: 'all' }));
    if (!v || /Cloud filter is set/i.test(v.headline)) {
        fail(
            `filters.intrinsicProvider: must NOT blame the global picker when it is "all", got "${
                v && v.headline
            }"`,
        );
    }
    checks += 1;
    if (!v || v.headline.indexOf('AZURE') === -1) {
        fail(`filters.intrinsicProvider: headline should still name the provider, got "${v && v.headline}"`);
    }
    // ...and with the picker actually set TO THE SAME PROVIDER, attribution
    // returns to the filter — agreement is what proves withCloudProvider spliced it.
    checks += 1;
    const g = explain(facts({ spl, cloudProvider: 'azure' }));
    if (!g || g.id !== 'active-filters' || !/Cloud filter is set to AZURE/.test(g.headline)) {
        fail(`filters.intrinsicProvider: picker set to azure must attribute to the filter, got ${JSON.stringify(g)}`);
    }
    /* The picker is sticky APP-WIDE, so it can hold a provider while the panel's
     * own query pins a different one. Crediting the picker there is the same
     * defect in a subtler form. */
    checks += 1;
    const m = explain(facts({ spl, cloudProvider: 'gcp' }));
    if (!m || m.id !== 'intrinsic-provider' || /Cloud filter/i.test(m.headline)) {
        fail(`filters.mismatchedPicker: picker=gcp vs query=azure must stay intrinsic, got ${JSON.stringify(m)}`);
    }
}
/* A panel with NO provider term in its query cannot have been narrowed by the
 * picker, however the picker is set — Multi-Cloud Overview, Environment
 * Topology and Settings are all exempt from the global filter. Blaming it there
 * sends the user to change a control that does not apply to what they are
 * looking at. */
{
    const spl = '| tstats count WHERE `sap_logserv_idx_macro` | stats sum(count) as count';
    expectId('filters.exemptDashboard', facts({ spl, cloudProvider: 'azure' }), null);
}
{
    // Both at once — one sentence, both named.
    const spl =
        '`sap_logserv_idx_macro` (cloud_provider="aws" OR NOT cloud_provider=*) host IN ("a","b") sourcetype="squid:access" | stats count';
    checks += 1;
    const v = explain(facts({ spl, cloudProvider: 'aws' }));
    if (!v || v.headline.indexOf('AWS') === -1 || v.headline.indexOf('2 hosts') === -1) {
        fail(`filters.both: expected both filters named, got "${v && v.headline}"`);
    }
}

// --- 4. Error and never-dispatched ---------------------------------------
expectId(
    'error.quoted',
    facts({ spl: ROLLUP_HOURLY, errorMessage: 'Unknown search command "inputlookup".' }),
    'search-error',
);
{
    checks += 1;
    const v = explain(facts({ spl: ROLLUP_HOURLY, errorMessage: 'Boom' }));
    if (!v || v.detail !== 'Boom') fail('error.quoted: must quote Splunk verbatim in detail');
}
expectId('notDispatched', facts({ spl: RAW, dispatched: false, rowCount: null }), 'not-dispatched');

// --- 5. Precedence — the cascade order, not a score ----------------------
expectId(
    'precedence.errorBeatsGrain',
    facts({
        spl: ROLLUP_HOURLY,
        earliest: '-15m',
        latest: 'now',
        errorMessage: 'search failed',
    }),
    'search-error',
);
// A structural time-grain mismatch AND an active filter can both be true. The
// grain wins: it is the thing that makes the panel unable to answer AT ALL,
// whereas the filter merely narrows. Told to change one thing, the user should
// change the range first.
{
    const spl =
        '| inputlookup logserv_linux_rollup where metric="total" | addinfo | where bucket_ts>=info_min_time AND bucket_ts<info_max_time | search cloud_provider="gcp" | stats sum(count) as count';
    expectId(
        'precedence.grainBeatsFilters',
        facts({ spl, earliest: '-15m', latest: 'now', cloudProvider: 'gcp' }),
        'time-grain-hourly',
    );
    // …and with a wide window the same panel reports the filter instead.
    expectId(
        'precedence.filtersWhenRangeIsFine',
        facts({ spl, earliest: '-30d@d', latest: 'now', cloudProvider: 'gcp' }),
        'active-filters',
    );
}

// --- 6. Lint reaches the panel -------------------------------------------
// The live defect at EnvironmentHealth.tsx:230 — a clause that can never match.
expectId(
    'lint.surfacedToPanel',
    facts({ spl: '`sap_logserv_idx_macro` (sourcetype="sap:abap:icm" icm_is_error=1) | stats count' }),
    'lint-numeric-vs-string-boolean',
);

// --- 7. Gate 0 ------------------------------------------------------------
{
    const p = probeSpl(RAW);
    checks += 1;
    if (gate0(p).confidence !== 'not-evaluated') {
        fail('gate0: with no dispatched evidence the gate must report not-evaluated, never healthy');
    }
    checks += 1;
    const settled = gate0(p, true, false);
    if (settled.confidence !== 'expected' || settled.owner !== 'nobody') {
        fail(`gate0: index-has-events + sourcetype-absent must be Expected/nobody, got ${settled.confidence}/${settled.owner}`);
    }
    checks += 1;
    if (settled.headline.indexOf('nothing is broken') === -1) {
        fail('gate0: the "nothing is wrong" verdict must say so in plain language');
    }
}

// --- 8. THE INVARIANT -----------------------------------------------------
// No free check may assert a system fault. Only two exceptions are allowed,
// and both carry complete local evidence: a verbatim Splunk error, and a
// static clause that provably cannot match. Anything else claiming
// confirmed/likely/possible would be the diagnostic accusing the platform on
// evidence it does not have.
{
    const CORPUS: FactsShape[] = [];
    const spls = [ROLLUP_HOURLY, ROLLUP_DAILY, RAW, TSTATS,
        '| inputlookup logserv_topology_inventory | stats count',
        '`sap_logserv_idx_macro` host="h1" cloud_provider="gcp" sourcetype="sap:abap:icm" | stats count',
        '| makeresults count=1',
        ''];
    const windows: Array<[string, string]> = [
        ['-15m', 'now'], ['-4h', 'now'], ['-24h', 'now'], ['-30d@d', 'now'], ['0', 'now'],
    ];
    for (const spl of spls) {
        for (const w of windows) {
            for (const provider of ['all', 'gcp']) {
                for (const dispatched of [true, false]) {
                    CORPUS.push(facts({ spl, earliest: w[0], latest: w[1], cloudProvider: provider, dispatched }));
                }
            }
        }
    }
    const ALLOWED_NON_EXPECTED: Record<string, boolean> = {
        'search-error': true,
        'lint-match-in-base': true,
        'lint-bare-boolean-in-where': true,
        'lint-numeric-vs-string-boolean': true,
    };
    let violations = 0;
    for (const f of CORPUS) {
        for (const v of allFree(f)) {
            checks += 1;
            if (v.confidence !== 'expected' && !ALLOWED_NON_EXPECTED[v.id]) {
                violations += 1;
                fail(
                    `INVARIANT: free check "${v.id}" produced confidence "${v.confidence}" ` +
                        `— only Expected-class verdicts are permitted without dispatched evidence.`,
                );
            }
            if (v.evidence.length === 0) {
                violations += 1;
                fail(`INVARIANT: verdict "${v.id}" carries no evidence.`);
            }
            // Every verdict must also carry a compact form — a KPI card renders
            // `short` and would show an empty line without it. Cap the length so
            // it cannot wrap and lift a height-equalised KPI row.
            if (!v.short || v.short.length === 0) {
                violations += 1;
                fail(`INVARIANT: verdict "${v.id}" has no short form (KPI cards render it).`);
            } else if (v.short.length > 34) {
                violations += 1;
                fail(`INVARIANT: verdict "${v.id}" short form is ${v.short.length} chars ("${v.short}") — too long for a KPI card.`);
            }
        }
    }
    if (violations === 0) {
        console.log(`  invariant: ${CORPUS.length} fact combinations, 0 unevidenced fault claims`);
    }
}

// --- no-range-filter, pinned BY ID (session-097 coverage-review rider) ----
// The plan skips this verdict as unreachable in the shipped product (every
// rollup read is range-filtered), and the review found no id-targeted
// assertion existed anywhere — only incidental sweep exposure. This is it.
{
    const unfiltered = allFree({
        spl: '| inputlookup logserv_linux_rollup where metric="total" | stats sum(count) as count',
        earliest: '-24h',
        latest: 'now',
        dispatched: true,
        loading: false,
        errorMessage: null,
        rowCount: 0,
        cloudProvider: 'all',
    });
    const hit = unfiltered.filter((v) => v.id === 'no-range-filter');
    checks += 1;
    if (!(hit.length === 1 && hit[0].confidence === 'expected')) {
        fail(
            `noRangeFilter.byId: expected exactly one expected-class no-range-filter, got ${JSON.stringify(unfiltered.map((v) => v.id))}`,
        );
    }
}

// --- §18.8a-27 residual — the PARTIAL-mode free checks (session 104) --------
// Partial mode keeps searchError / lint / noRangeFilter / a re-phrased
// timeGrain, DEMOTES active-filters to context lines (§18.8a-19), and
// not-dispatched fires ONLY on an explicit false (§18.8a-4).
{
    const explainMode = mod.explainEmptyPanel as (f: FactsShape, mode: string) => VerdictShape | null;
    const allFreeMode = mod.allFreeVerdicts as (f: FactsShape, mode: string) => VerdictShape[];
    const filterLines = mod.activeFilterContextLines as (f: FactsShape) => string[];

    const FILTERED_SPL =
        '| inputlookup logserv_linux_rollup where metric="total" | addinfo | where bucket_ts>=info_min_time AND bucket_ts<info_max_time | search cloud_provider="gcp" | stats sum(count) as count';
    const filteredFacts = facts({ spl: FILTERED_SPL, cloudProvider: 'gcp', rowCount: 12 });

    // (a) active-filters is demoted in partial mode — the emptiness sentence
    // ("There are no … events once …") would be false over a populated panel.
    checks += 1;
    if (explainMode(filteredFacts, 'partial') !== null) {
        fail(
            `partial.filtersDemoted: expected null, got ${JSON.stringify(explainMode(filteredFacts, 'partial'))}`,
        );
    }
    checks += 1;
    const partialAll = allFreeMode(filteredFacts, 'partial').map((v) => v.id);
    if (partialAll.indexOf('active-filters') !== -1) {
        fail(`partial.filtersNotInAll: active-filters leaked into partial mode: ${partialAll.join(',')}`);
    }
    // …and the SAME facts still carry the filter as context lines for the
    // floor/fallback evidence.
    checks += 1;
    const lines = filterLines(filteredFacts);
    if (!(lines.length > 0 && lines.some((l) => /gcp/i.test(l)))) {
        fail(`partial.contextLines: expected provider-naming context lines, got ${JSON.stringify(lines)}`);
    }
    // Empty mode on the same SPL still yields the full verdict (regression pin).
    expectId('partial.emptyModeUnchanged', facts({ spl: FILTERED_SPL, cloudProvider: 'gcp' }), 'active-filters');

    // (b) time-grain survives partial mode with the overcount phrasing — a
    // POPULATED sub-hour panel is the documented ~4x boundary overcount.
    {
        const f = facts({ spl: ROLLUP_HOURLY, earliest: '-15m', latest: 'now', rowCount: 3 });
        const v = explainMode(f, 'partial');
        checks += 1;
        if (!v || v.id !== 'time-grain-hourly') {
            fail(`partial.grainSurvives: got ${JSON.stringify(v && v.id)}`);
        }
        checks += 1;
        if (!v || !/whole hour rather than exactly your range/.test(v.headline)) {
            fail(`partial.grainPhrasing: headline must carry the numbers-may-be-wrong phrasing, got "${v && v.headline}"`);
        }
        checks += 1;
        if (!v || !/overcount/i.test(v.detail || '')) {
            fail(`partial.grainDetail: detail must explain the boundary overcount, got "${v && v.detail}"`);
        }
        // The empty-mode phrasing must NOT carry the partial wording.
        const e = explainMode(facts({ spl: ROLLUP_HOURLY, earliest: '-15m', latest: 'now' }), 'empty');
        checks += 1;
        if (!e || /rather than exactly your range/.test(e.headline)) {
            fail(`partial.grainEmptyPhrasing: empty mode must keep the emptiness phrasing, got "${e && e.headline}"`);
        }
    }

    // (c) searchError / lint / noRangeFilter all still fire in partial mode.
    {
        const v = explainMode(facts({ spl: ROLLUP_HOURLY, rowCount: 5, errorMessage: 'Boom' }), 'partial');
        checks += 1;
        if (!v || v.id !== 'search-error') fail(`partial.errorFires: got ${JSON.stringify(v && v.id)}`);
    }
    {
        const v = explainMode(
            facts({ spl: '`sap_logserv_idx_macro` (sourcetype="sap:abap:icm" icm_is_error=1) | stats count', rowCount: 5 }),
            'partial',
        );
        checks += 1;
        if (!v || v.id !== 'lint-numeric-vs-string-boolean') fail(`partial.lintFires: got ${JSON.stringify(v && v.id)}`);
    }
    {
        const v = explainMode(
            facts({ spl: '| inputlookup logserv_linux_rollup where metric="total" | stats sum(count) as count', rowCount: 5 }),
            'partial',
        );
        checks += 1;
        if (!v || v.id !== 'no-range-filter') fail(`partial.noRangeFires: got ${JSON.stringify(v && v.id)}`);
    }

    // (d) §18.8a-4 — not-dispatched fires ONLY on an explicit false. An entry
    // point that could not establish the flag passes undefined, and headlining
    // "did not run a search" on a panel that visibly rendered data was the
    // review's blocker H-F1(a).
    {
        const undef = facts({ spl: RAW, rowCount: 5 });
        (undef as unknown as Record<string, unknown>).dispatched = undefined;
        const ids = allFreeMode(undef, 'partial').map((v) => v.id);
        checks += 1;
        if (ids.indexOf('not-dispatched') !== -1) {
            fail(`partial.undefinedDispatchSilent: not-dispatched fired on undefined: ${ids.join(',')}`);
        }
        const explicit = allFreeMode(facts({ spl: RAW, dispatched: false, rowCount: null }), 'partial').map((v) => v.id);
        checks += 1;
        if (explicit.indexOf('not-dispatched') === -1) {
            fail(`partial.explicitFalseFires: expected not-dispatched, got ${explicit.join(',')}`);
        }
    }
}

if (failures > 0) {
    proc.stderr.write(`\npanelDiagnosis consistency test: ${failures} failure(s) of ${checks} checks\n`);
    proc.exit(1);
}
console.log(`panelDiagnosis consistency test: ${checks} checks OK`);

export {};
