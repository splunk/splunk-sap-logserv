/**
 * Build-time consistency test for the Data Doctor REPORT layer (session 095):
 * `diagSweep` (classification + the memoizing runner), `diagEnvironment`
 * (rollup-extent classification + the environment gather), and `diagReport`
 * (the three report models).
 *
 * What it pins, and why:
 *   - the memoizing runner really dedupes — the sweep's cost model depends on
 *     identical probes dispatching once across 20 panels;
 *   - only EMPTY panels are deep-diagnosed — an errored panel's verdict is its
 *     own message, an OK panel needs none;
 *   - a rollup extent that was NOT probed classifies as not-checked, never as
 *     empty/ok (the finding-2 rule applied to the environment report);
 *   - per-grain staleness in the environment table (finding-3's rule);
 *   - every report model carries the data-exposure banner, the verbatim
 *     dispatched SPL, the schema-tagged JSON appendix, and a skipped check's
 *     REASON in the evidence table (design §7.5).
 *
 * Async (fake-runner-driven) — exports `run()`, awaited by
 * `bin/check-diagnostics.js`; never calls process.exit.
 */

/* eslint-disable no-console, @typescript-eslint/no-explicit-any */

const proc = process as unknown as { stderr: { write(s: string): void } };

const sweepMod = require('./diagSweep') as any;
const envMod = require('./diagEnvironment') as any;
const reportMod = require('./diagReport') as any;
const probeMod = require('./splProbe') as any;

const {
    classifyRegistration,
    createMemoizingRunner,
    sweepDashboard,
    describeSearch,
} = sweepMod;
const { classifyRollupExtent, gatherEnvironmentEvidence } = envMod;
const {
    buildPanelReportModel,
    buildDashboardReportModel,
    buildEnvironmentReportModel,
    DATA_BANNER,
    REPORT_SCHEMA,
} = reportMod;
const probeSpl = probeMod.probeSpl as (spl: string) => any;

interface FakeResult {
    rows: unknown[];
    error: string;
    durationMs: number;
    skipped: boolean;
}
const ok = (rows: unknown[]): FakeResult => ({ rows, error: '', durationMs: 1, skipped: false });
const err = (e: string): FakeResult => ({ rows: [], error: e, durationMs: 1, skipped: false });

const makeRunner = (cfg: {
    search?: (spl: string, e: string, l: string) => FakeResult;
    kv?: (collection: string, params: Record<string, string>) => FakeResult;
    rest?: (url: string) => FakeResult;
}): any => ({
    search: (spl: string, e: string, l: string): Promise<FakeResult> =>
        Promise.resolve(cfg.search ? cfg.search(spl, e, l) : ok([])),
    kv: (c: string, p: Record<string, string>): Promise<FakeResult> =>
        Promise.resolve(cfg.kv ? cfg.kv(c, p) : ok([])),
    rest: (u: string): Promise<FakeResult> => Promise.resolve(cfg.rest ? cfg.rest(u) : ok([])),
    cancel: (): void => undefined,
    isCancelled: (): boolean => false,
    elapsedMs: (): number => 0,
    remainingMs: (): number => 60_000,
    dispatched: (): number => 0,
});

const NOW = Math.floor(Date.now() / 1000);
const CACHED =
    '| inputlookup logserv_linux_rollup where metric="total" | addinfo | where bucket_ts>=info_min_time AND bucket_ts<info_max_time | stats sum(count) as count';
const RAW = '`sap_logserv_idx_macro` sourcetype="sap:hana:audit" | stats count';

const reg = (over: Record<string, unknown>): any => ({
    id: 's1',
    spl: RAW,
    earliest: '-7d@d',
    latest: 'now',
    dispatched: true,
    loading: false,
    errorMessage: null,
    rowCount: 5,
    ...over,
});

const META = {
    appVersion: '0.1.1',
    appBuild: '310',
    appBuildDate: '2026-08-08',
    templatesOnly: false,
    username: 'tester',
};

export const run = async (): Promise<number> => {
    let failures = 0;
    let checks = 0;
    const check = (label: string, okC: boolean, detail: string): void => {
        checks += 1;
        if (!okC) {
            failures += 1;
            proc.stderr.write(`FAIL: ${label}: ${detail}\n`);
        }
    };

    // --- classification --------------------------------------------------
    check('classify.ok', classifyRegistration(reg({})) === 'ok', 'rows>0 is ok');
    check('classify.empty', classifyRegistration(reg({ rowCount: 0 })) === 'empty', 'rows=0 is empty');
    check(
        'classify.error',
        classifyRegistration(reg({ errorMessage: 'boom' })) === 'error',
        'an error outranks emptiness',
    );
    check(
        'classify.loading',
        classifyRegistration(reg({ loading: true })) === 'loading',
        'still loading',
    );
    check(
        'classify.notDispatched',
        classifyRegistration(reg({ dispatched: false })) === 'not-dispatched',
        'enabled:false',
    );
    check('classify.noQuery', classifyRegistration(reg({ spl: '' })) === 'no-query', 'empty query');

    // --- descriptors -----------------------------------------------------
    check(
        'describe.cached',
        /logserv_linux_rollup \(total\)/.test(describeSearch(probeSpl(CACHED), CACHED)),
        `got "${describeSearch(probeSpl(CACHED), CACHED)}"`,
    );
    check(
        'describe.raw',
        /sap:hana:audit/.test(describeSearch(probeSpl(RAW), RAW)),
        `got "${describeSearch(probeSpl(RAW), RAW)}"`,
    );

    // --- the memoizing runner --------------------------------------------
    {
        let searches = 0;
        let kvs = 0;
        let rests = 0;
        const inner = makeRunner({
            search: () => {
                searches += 1;
                return ok([{ count: '1' }]);
            },
            kv: () => {
                kvs += 1;
                return ok([{ bucket_ts: 1 }]);
            },
            rest: () => {
                rests += 1;
                return ok([{}]);
            },
        });
        const memo = createMemoizingRunner(inner);
        await Promise.all([
            memo.search('| makeresults', '-1m', 'now'),
            memo.search('| makeresults', '-1m', 'now'), // concurrent duplicate
        ]);
        await memo.search('| makeresults', '-1m', 'now'); // sequential duplicate
        await memo.search('| makeresults', '-2m', 'now'); // different window
        check('memo.search', searches === 2, `identical searches must dispatch once, got ${searches}`);
        await memo.kv('c1', { sort: 'a:1', limit: '1' });
        await memo.kv('c1', { limit: '1', sort: 'a:1' }); // same params, other order
        await memo.kv('c1', { limit: '1', sort: 'a:-1' });
        check('memo.kv', kvs === 2, `order-insensitive kv dedupe, got ${kvs}`);
        await memo.rest('/x');
        await memo.rest('/x');
        check('memo.rest', rests === 1, `identical rest urls must fetch once, got ${rests}`);
    }

    // --- the sweep -------------------------------------------------------
    {
        const runner = makeRunner({
            search: (spl) => {
                if (spl.indexOf('makeresults') !== -1) return ok([{}]);
                if (spl.indexOf('BY index') !== -1)
                    return ok([{ index: 'sap_logserv_logs', count: '500' }]);
                if (spl.indexOf('inputlookup') !== -1) return ok([{ count: '3' }]);
                return ok([]);
            },
            kv: () => ok([{ bucket_ts: NOW - 3600 }]),
            rest: (url) =>
                url.indexOf('saved/searches') !== -1
                    ? ok([{ content: { search: 'search sourcetype="linux_secure" | bin _time' } }])
                    : ok([]),
        });
        let progressCalls = 0;
        const result = await sweepDashboard(
            runner,
            [
                reg({ id: 'a' }), // ok
                reg({ id: 'b', spl: CACHED, rowCount: 0 }), // empty -> deep dive
                reg({ id: 'c', errorMessage: 'Error in search.' }), // error
                reg({ id: 'd', dispatched: false }), // not run
            ],
            'all',
            () => {
                progressCalls += 1;
            },
        );
        check('sweep.entries', result.entries.length === 4, `got ${result.entries.length}`);
        check(
            'sweep.onlyEmptyDiagnosed',
            result.diagnosedCount === 1 &&
                !!result.entries[1].diag &&
                !result.entries[0].diag &&
                !result.entries[2].diag,
            'exactly the empty panel gets the dispatched cascade',
        );
        check(
            'sweep.errorFreeVerdict',
            !!result.entries[2].freeVerdict && result.entries[2].freeVerdict.id === 'search-error',
            `an errored panel carries its own error verdict, got ${JSON.stringify(result.entries[2].freeVerdict && result.entries[2].freeVerdict.id)}`,
        );
        check('sweep.progress', progressCalls >= 1, 'progress callback must fire');
        check(
            'sweep.descriptors',
            result.entries.every((e: any) => typeof e.descriptor === 'string' && e.descriptor.length > 0),
            'every entry needs a descriptor',
        );

        // --- dashboard report model over this sweep -----------------------
        const model = buildDashboardReportModel({
            dashboardLabel: 'Linux System & Security',
            sweep: result,
            meta: META,
        });
        check('dashModel.banner', model.banner === DATA_BANNER, 'the data-exposure banner is mandatory');
        check('dashModel.schema', (model.json as any).schema === REPORT_SCHEMA, 'schema tag');
        check('dashModel.kind', (model.json as any).kind === 'dashboard', 'kind tag');
        const monoBlocks: string[] = [];
        model.sections.forEach((s: any) =>
            s.blocks.forEach((b: any) => {
                if (b.kind === 'mono') monoBlocks.push(b.text);
            }),
        );
        check(
            'dashModel.splVerbatim',
            monoBlocks.some((m) => m === CACHED),
            'the diagnosed panel’s dispatched SPL must appear verbatim',
        );
        const summaryTable = model.sections[0].blocks.filter((b: any) => b.kind === 'table')[0];
        check(
            'dashModel.summaryRows',
            !!summaryTable && summaryTable.table.rows.length === 4,
            'one summary row per registered search',
        );
        check(
            'dashModel.filename',
            /^logserv-diagnostic-linux-system-security-\d{4}-/.test(model.filenameBase),
            `got ${model.filenameBase}`,
        );
    }

    // --- rollup extent classification (environment) ----------------------
    check(
        'rollup.notProbed',
        classifyRollupExtent(false, null, null, 'hourly', NOW).status === 'not-checked',
        'a failed probe must never classify as empty or ok',
    );
    check(
        'rollup.empty',
        classifyRollupExtent(true, null, null, 'hourly', NOW).status === 'empty',
        'a probed empty collection is empty',
    );
    check(
        'rollup.hourlyOk',
        classifyRollupExtent(true, NOW - 100000, NOW - 2 * 3600, 'hourly', NOW).status === 'ok',
        '2h lag is healthy hourly',
    );
    check(
        'rollup.hourlyStale',
        classifyRollupExtent(true, NOW - 100000, NOW - 4 * 3600, 'hourly', NOW).status === 'stale',
        '4h lag is stale hourly',
    );
    check(
        'rollup.dailyOk',
        classifyRollupExtent(true, NOW - 100000, NOW - 40 * 3600, 'daily', NOW).status === 'ok',
        '40h lag is healthy daily (finding 3)',
    );
    check(
        'rollup.dailyStale',
        classifyRollupExtent(true, NOW - 100000, NOW - 60 * 3600, 'daily', NOW).status === 'stale',
        '60h lag is stale daily',
    );

    // --- the environment gather ------------------------------------------
    {
        const runner = makeRunner({
            search: (spl) => {
                if (spl.indexOf('strftime') !== -1)
                    return ok([{ server_time: '2026-08-08 12:00:00 UTC' }]);
                if (spl.indexOf('makeresults') !== -1) return ok([{}]);
                if (spl.indexOf('BY index') !== -1)
                    return ok([{ index: 'sap_logserv_logs', count: '1000' }]);
                if (spl.indexOf('BY sourcetype') !== -1)
                    return ok([
                        { sourcetype: 'sap:hana:audit', count: '10' },
                        { sourcetype: 'linux_secure', count: '20' },
                    ]);
                if (spl.indexOf('metadata') !== -1)
                    /* §19.8a-13 (L9) — the widened `| fields` projection now
                     * carries firstTime + recentTime; the ENVIRONMENT path
                     * reads lastTime BY NAME and must be unmoved by the new
                     * fields (the second consumer, easy to forget). */
                    return ok([
                        {
                            sourcetype: 'sap:hana:audit',
                            firstTime: String(NOW - 90 * 86400),
                            lastTime: String(NOW - 60),
                            recentTime: String(NOW - 5),
                        },
                    ]);
                if (spl.indexOf('eventcount') !== -1) return ok([{ index: 'sap_logserv_logs' }]);
                return ok([]);
            },
            kv: (collection, p) => {
                if (collection === 'logserv_saprouter_rollup') return err('HTTP 503');
                if (collection === 'logserv_beaconing_rollup')
                    return ok([{ day_ts: p.sort && p.sort.indexOf(':-1') !== -1 ? NOW - 40 * 3600 : NOW - 30 * 86400 }]);
                return ok([
                    { bucket_ts: p.sort && p.sort.indexOf(':-1') !== -1 ? NOW - 3600 : NOW - 30 * 86400 },
                ]);
            },
            rest: (url) => {
                if (url.indexOf('server/info') !== -1)
                    return ok([{ content: { version: '9.4.3', serverName: 'sh-idxr' } }]);
                if (url.indexOf('conf-macros') !== -1)
                    return ok([{ content: { definition: 'index="sap_logserv_logs"' } }]);
                if (url.indexOf('apps/local') !== -1)
                    return ok([{ name: 'Splunk_SA_CIM' }, { name: 'search' }]);
                return ok([]);
            },
        });
        const env = await gatherEnvironmentEvidence(runner, '-24h', 'now');
        check('env.canary', env.canaryMs !== null, 'canary must record');
        check('env.server', env.serverVersion === '9.4.3', `got ${env.serverVersion}`);
        check(
            'env.apps',
            !!env.appsPresent &&
                env.appsPresent.Splunk_SA_CIM === true &&
                env.appsPresent.Splunk_TA_windows === false,
            `got ${JSON.stringify(env.appsPresent)}`,
        );
        check(
            'env.macro',
            !!env.macroIndexes && env.macroIndexes[0] === 'sap_logserv_logs',
            `got ${JSON.stringify(env.macroIndexes)}`,
        );
        check(
            'env.sourcetypes',
            !!env.sourcetypeWindowCounts &&
                Object.keys(env.sourcetypeWindowCounts).length === 2,
            'windowed sourcetype counts',
        );
        check(
            's19.env.lastSeenUnmovedByNewFields',
            !!env.sourcetypeLastSeen && env.sourcetypeLastSeen['sap:hana:audit'] === NOW - 60,
            `got ${JSON.stringify(env.sourcetypeLastSeen)}`,
        );
        const rows: any[] = env.rollups;
        check('env.rollupRowCount', rows.length >= 25, `expected every registry collection, got ${rows.length}`);
        const bad = rows.filter((r) => r.collection === 'logserv_saprouter_rollup')[0];
        check(
            'env.errorIsNotChecked',
            !!bad && bad.status === 'not-checked' && bad.probed === false,
            `a KV error must classify not-checked, got ${bad && bad.status}`,
        );
        const daily = rows.filter((r) => r.collection === 'logserv_beaconing_rollup')[0];
        check(
            'env.dailyGrainOk',
            !!daily && daily.grain === 'daily' && daily.status === 'ok',
            `40h daily lag must be ok, got ${daily && daily.status}`,
        );
        const hourly = rows.filter((r) => r.collection === 'logserv_linux_rollup')[0];
        check(
            'env.hourlyOk',
            !!hourly && hourly.status === 'ok',
            `1h hourly lag must be ok, got ${hourly && hourly.status}`,
        );

        const model = buildEnvironmentReportModel({
            env,
            windowLabel: '-24h → now',
            meta: META,
        });
        check('envModel.kind', (model.json as any).kind === 'environment', 'kind tag');
        check('envModel.banner', model.banner === DATA_BANNER, 'banner mandatory');
        const tables: any[] = [];
        model.sections.forEach((s: any) =>
            s.blocks.forEach((b: any) => {
                if (b.kind === 'table') tables.push(b.table);
            }),
        );
        check(
            'envModel.rollupTable',
            tables.some((t) => t.rows.some((r: string[]) => r.indexOf('NOT CHECKED') !== -1 || /NOT CHECKED/.test(r.join(' ')))),
            'an unreadable collection must render NOT CHECKED, never OK',
        );
    }

    // --- the panel report model -------------------------------------------
    {
        const facts = {
            spl: RAW,
            earliest: '-7d@d',
            latest: 'now',
            dispatched: true,
            loading: false,
            errorMessage: null,
            rowCount: 0,
            cloudProvider: 'all',
        };
        const verdict = {
            id: 'source-absent',
            short: 'No such data',
            headline: 'There are genuinely no events — nothing is broken.',
            confidence: 'expected',
            owner: 'nobody',
            evidence: ['ev1'],
        };
        const evidence = {
            indexRowsInWindow: 100,
            resolvedIndexes: ['sap_logserv_logs'],
            macroIndexes: null,
            visibleIndexes: null,
            sourcetypeCounts: {},
            sourcetypeLastSeen: null,
            sourceScope: null,
            collectionRowsInWindow: null,
            collectionRowsAllMetrics: null,
            collectionExtentProbed: false,
            collectionOldest: null,
            collectionNewest: null,
            canaryMs: 210,
            notes: [
                { check: 'Index presence in window', status: 'ok', detail: '1 index(es) matched', durationMs: 900 },
                { check: 'Sourcetype coverage', status: 'skipped', detail: 'Time budget exhausted or cancelled.' },
            ],
            budgetExhausted: true,
        };
        const model = buildPanelReportModel({
            panelTitle: 'Failed Logins',
            dashboardLabel: 'HANA Audit',
            facts,
            probe: probeSpl(RAW),
            diag: { top: verdict, all: [verdict], incomplete: true },
            evidence,
            meta: META,
        });
        check('panelModel.banner', model.banner === DATA_BANNER, 'banner mandatory');
        check('panelModel.schema', (model.json as any).schema === REPORT_SCHEMA, 'schema tag');
        const monos: string[] = [];
        const tableRows: string[] = [];
        model.sections.forEach((s: any) =>
            s.blocks.forEach((b: any) => {
                if (b.kind === 'mono') monos.push(b.text);
                if (b.kind === 'table') b.table.rows.forEach((r: string[]) => tableRows.push(r.join(' | ')));
            }),
        );
        check('panelModel.splVerbatim', monos.some((m) => m === RAW), 'dispatched SPL verbatim');
        check(
            'panelModel.skippedSaysWhy',
            tableRows.some((r) => /SKIPPED/.test(r) && /Time budget exhausted/.test(r)),
            'a skipped check must carry its reason into the evidence table (design §7.5)',
        );
        check(
            'panelModel.canary',
            model.sections.some((s: any) =>
                s.blocks.some(
                    (b: any) =>
                        b.kind === 'keyValues' &&
                        b.items.some((i: any) => /canary/i.test(i.label) && /210 ms/.test(i.value)),
                ),
            ),
            'the canary belongs in the fingerprint',
        );
        check(
            'panelModel.filename',
            /^logserv-diagnostic-panel-hana-audit-\d{4}-/.test(model.filenameBase),
            `got ${model.filenameBase}`,
        );
    }

    // --- §15 (build 314) — the operator-supplied ingest-facts section ------
    // Pins (§15.8a-30): section rendered iff facts present; positioned
    // immediately BEFORE "What cannot be checked from here" with the appendix
    // still LAST; excerpt cap applied; boundary line swapped vs static (and
    // KEPT for the shipped-defaults shape); `json.ingestFacts` on all three
    // kinds; the persistence strip/restore leaves the new section intact.
    {
        const ingestMod = require('./diagIngestFacts') as any;
        const NOWSEC = 1786310000;
        const fxFull = {
            suppliedAt: NOWSEC - 100,
            suppliedBy: 'opsuser',
            sourceHost: 'ds01',
            inputShape: 'rest-json',
            parseStatus: 'parsed',
            parseNote: '',
            filterEnabled: true,
            daysInPast: 30,
            cutoffEpoch: 1785628800,
            includeFilters: ['linux/*'],
            excludeFilters: ['proxy/squid'],
            filtersApproximate: false,
            scrubbedRaw: '',
        };
        const facts15 = {
            spl: RAW,
            earliest: '-24h',
            latest: 'now',
            dispatched: true,
            loading: false,
            errorMessage: null,
            rowCount: 0,
        };
        const verdict15 = {
            id: 'ingest-type-excluded',
            short: 'Excluded at ingest',
            headline: 'x',
            confidence: 'confirmed',
            owner: 'splunk-admin',
            evidence: ['e'],
        };
        const mkEvidence = (fx: unknown): Record<string, unknown> => ({
            indexRowsInWindow: 100,
            resolvedIndexes: ['sap_logserv_logs'],
            macroIndexes: null,
            visibleIndexes: null,
            sourcetypeCounts: {},
            sourcetypeLastSeen: null,
            sourceScope: null,
            collectionRowsInWindow: null,
            collectionRowsAllMetrics: null,
            collectionExtentProbed: false,
            collectionOldest: null,
            collectionNewest: null,
            ingestFacts: fx,
            canaryMs: 210,
            notes: [],
            budgetExhausted: false,
        });
        const mWith = buildPanelReportModel({
            panelTitle: 'P',
            dashboardLabel: 'D',
            facts: facts15,
            probe: probeSpl(RAW),
            diag: { top: verdict15, all: [verdict15], incomplete: false },
            evidence: mkEvidence(fxFull),
            meta: META,
        });
        const headings = mWith.sections.map((s: any) => s.heading);
        const iFacts = headings.indexOf('Ingest-tier filters (supplied by operator)');
        const iCannot = headings.indexOf('What cannot be checked from here');
        check('s15.section.present', iFacts !== -1, headings.join(' | '));
        check('s15.section.beforeCannotCheck', iFacts !== -1 && iCannot === iFacts + 1, `${iFacts} vs ${iCannot}`);
        check(
            's15.section.appendixLast',
            /Machine-readable appendix/.test(headings[headings.length - 1]),
            headings[headings.length - 1],
        );
        check('s15.json.panel', (mWith.json as any).ingestFacts && (mWith.json as any).ingestFacts.recordedAsSuppliedBy === 'opsuser', '');
        // boundary line SWAPPED for a clean non-defaults paste
        const cannotBlock = (mWith.sections[iCannot].blocks[0] as any).text as string[];
        check('s15.boundary.swapped', cannotBlock[0].indexOf('were supplied by opsuser') !== -1, cannotBlock[0]);
        check('s15.boundary.staticTailKept', cannotBlock.length === reportMod.CANNOT_CHECK_LINES.length, String(cannotBlock.length));

        // absent facts -> no section, static lines
        const mWithout = buildPanelReportModel({
            panelTitle: 'P',
            dashboardLabel: 'D',
            facts: facts15,
            probe: probeSpl(RAW),
            diag: { top: verdict15, all: [verdict15], incomplete: false },
            evidence: mkEvidence(null),
            meta: META,
        });
        const h2 = mWithout.sections.map((s: any) => s.heading);
        check('s15.section.absentWithoutFacts', h2.indexOf('Ingest-tier filters (supplied by operator)') === -1, '');
        const cannot2 = (mWithout.sections[h2.indexOf('What cannot be checked from here')].blocks[0] as any).text as string[];
        check('s15.boundary.staticWithoutFacts', cannot2[0] === reportMod.CANNOT_CHECK_LINES[0], '');
        check('s15.json.nullWithoutFacts', (mWithout.json as any).ingestFacts === null, '');

        // shipped-defaults shape: the ask is KEPT + the hedged summary added
        const fxDefaults = Object.assign({}, fxFull, {
            filterEnabled: false,
            daysInPast: 7,
            includeFilters: ['*/*'],
            excludeFilters: [],
            cutoffEpoch: null,
        });
        const mDef = buildPanelReportModel({
            panelTitle: 'P',
            dashboardLabel: 'D',
            facts: facts15,
            probe: probeSpl(RAW),
            diag: { top: verdict15, all: [verdict15], incomplete: false },
            evidence: mkEvidence(fxDefaults),
            meta: META,
        });
        const h3 = mDef.sections.map((s: any) => s.heading);
        const cannot3 = (mDef.sections[h3.indexOf('What cannot be checked from here')].blocks[0] as any).text as string[];
        check('s15.boundary.defaultsKeepsAsk', cannot3[0] === reportMod.CANNOT_CHECK_LINES[0], cannot3[0]);
        check('s15.boundary.defaultsAddsHedge', cannot3[1].indexOf('heavy forwarder') !== -1, cannot3[1]);

        // §19.8a-18 (M7) — a parse that could not determine whether filtering
        // is enabled does NOT answer the boundary question: the ask is KEPT
        // (the shared factsUsableForBoundary predicate drives this and the
        // drawer pointer together).
        const fxNoEnabled = Object.assign({}, fxFull, { parseStatus: 'partial', filterEnabled: null });
        const cannotNE = reportMod.cannotCheckLines(fxNoEnabled);
        check('s19.boundary.enabledUnknownKeepsAsk', cannotNE[0] === reportMod.CANNOT_CHECK_LINES[0], cannotNE[0]);
        check('s19.boundary.enabledUnknownAddsSummary', /could not be determined/.test(cannotNE[1]), cannotNE[1]);
        // ...while usable partial facts still swap line [0] (unchanged).
        const fxPartialUsable = Object.assign({}, fxFull, { parseStatus: 'partial' });
        const cannotPU = reportMod.cannotCheckLines(fxPartialUsable);
        check('s19.boundary.partialUsableSwaps', cannotPU[0].indexOf('were supplied by opsuser') !== -1, cannotPU[0]);

        // §19.4 — the stamp row + json key, only when known.
        const fxStamp = Object.assign({}, fxFull, { cloudProviderStamp: 'azure' });
        const secStamp = reportMod.ingestFactsSection(fxStamp, NOWSEC);
        const tblStamp = secStamp.blocks.filter((b: any) => b.kind === 'table')[0];
        check(
            's19.section.stampRow',
            !!tblStamp && (tblStamp.table.rows as string[][]).some((r) => r[0] === 'Cloud-provider stamp' && r[1] === 'azure'),
            JSON.stringify(tblStamp && tblStamp.table.rows),
        );
        const secNoStamp = reportMod.ingestFactsSection(fxFull, NOWSEC);
        const tblNoStamp = secNoStamp.blocks.filter((b: any) => b.kind === 'table')[0];
        check(
            's19.section.noStampRowWhenUnknown',
            !!tblNoStamp && !(tblNoStamp.table.rows as string[][]).some((r) => r[0] === 'Cloud-provider stamp'),
            '',
        );
        check('s19.json.stamp', reportMod.ingestFactsJson(fxStamp).cloudProviderStamp === 'azure', '');
        check('s19.json.stampNull', reportMod.ingestFactsJson(fxFull).cloudProviderStamp === null, '');
        check(
            's19.summary.stampInBoundary',
            reportMod.cannotCheckLines(fxStamp)[0].indexOf('Cloud-provider stamp: azure') !== -1,
            reportMod.cannotCheckLines(fxStamp)[0],
        );

        // excerpt cap applied through the section builder
        const fxRaw = Object.assign({}, fxFull, {
            parseStatus: 'partial',
            scrubbedRaw: 'z'.repeat(9000),
        });
        const sec = reportMod.ingestFactsSection(fxRaw, NOWSEC);
        const mono = sec.blocks.filter((b: any) => b.kind === 'mono')[0];
        check(
            's15.section.excerptCapped',
            mono && mono.text.length <= ingestMod.INGEST_RAW_EXCERPT_CHARS + 120,
            mono ? String(mono.text.length) : 'no mono block',
        );

        // dashboard + environment kinds carry json.ingestFacts
        const mDash = buildDashboardReportModel({
            dashboardLabel: 'D',
            sweep: { entries: [], diagnosedCount: 0, budgetExhausted: false },
            meta: META,
            ingestFacts: fxFull,
        });
        check('s15.json.dashboard', (mDash.json as any).ingestFacts && (mDash.json as any).ingestFacts.cutoffEpoch === 1785628800, '');
        const hDash = mDash.sections.map((s: any) => s.heading);
        check('s15.section.dashboard', hDash.indexOf('Ingest-tier filters (supplied by operator)') !== -1, hDash.join('|'));

        const envEv = Object.assign(
            {},
            {
                canaryMs: 100,
                serverVersion: '9.4.3',
                serverName: 'x',
                serverTimeLabel: 'x',
                appsPresent: null,
                macroIndexes: null,
                visibleIndexCount: null,
                indexCounts: null,
                sourcetypeWindowCounts: null,
                sourcetypeLastSeen: null,
                rollups: [],
                ingestFacts: fxFull,
                notes: [],
                budgetExhausted: false,
            },
        );
        const mEnv = buildEnvironmentReportModel({ env: envEv, windowLabel: 'w', meta: META });
        check('s15.json.environment', (mEnv.json as any).ingestFacts && (mEnv.json as any).ingestFacts.recordedAsSuppliedBy === 'opsuser', '');
        const hEnv = mEnv.sections.map((s: any) => s.heading);
        check('s15.section.environment', hEnv.indexOf('Ingest-tier filters (supplied by operator)') !== -1, hEnv.join('|'));

        // persistence strip/restore keeps the new section (strip is BY the
        // appendix heading, so anything else survives byte-identically)
        const persistMod15 = require('./diagPersistence') as any;
        const stripped = persistMod15.stripAppendixForStorage(mWith);
        check(
            's15.persist.sectionSurvivesStrip',
            stripped.sections.some((s: any) => s.heading === 'Ingest-tier filters (supplied by operator)'),
            '',
        );
        check(
            's15.persist.appendixStripped',
            !stripped.sections.some((s: any) => /Machine-readable appendix/.test(s.heading)),
            '',
        );
    }

    // =====================================================================
    // §20 — the rollup-populating-SPL section + full-length samples
    // =====================================================================
    {
        const {
            rollupSearchesSection,
            PRODUCER_SPL_INTRO,
            ROLLUP_SEARCHES_HEADING,
            jsonAppendixSection,
            dataBanner,
            LEGACY_DATA_BANNERS,
            producerSplForOpenInSearch,
        } = reportMod;
        const AGG_SPL =
            'search `sap_logserv_idx_macro` sourcetype="linux_secure" | bin _time span=1h ' +
            '| stats count by host, _time "with quotes" | outputlookup append=true logserv_linux_rollup';
        const entry = {
            name: 'logserv_linux_aggregate',
            collection: 'logserv_linux_rollup',
            rollupCollections: ['logserv_linux_rollup'],
            spl: AGG_SPL,
            error: '',
            skipped: false,
            cron: '11 * * * *',
            updated: '2026-08-01T00:00:00+00:00',
            backfill: 'logserv_linux_backfill',
        };
        const dailyEntry = {
            ...entry,
            name: 'logserv_beaconing_aggregate',
            collection: 'logserv_beaconing_rollup',
            rollupCollections: ['logserv_beaconing_rollup', 'logserv_beaconing_detail_rollup'],
            // Distinct SPL — the stored-twice pins count the OTHER entry's
            // needle and must not pick up a second copy from this one.
            spl: 'search `sap_logserv_idx_macro` tag=dns | outputlookup append=true logserv_beaconing_rollup',
            cron: '30 0 * * *',
            backfill: 'logserv_beaconing_backfill',
        };
        const skippedEntry = {
            ...entry,
            name: 'logserv_severity_aggregate',
            collection: null,
            spl: null,
            error: 'Time budget exhausted or cancelled.',
            skipped: true,
            cron: null,
            updated: null,
            backfill: null,
        };

        // --- the section builder ------------------------------------------
        const sec = rollupSearchesSection([entry, dailyEntry, skippedEntry]);
        check(
            's20.section.heading',
            sec.heading === ROLLUP_SEARCHES_HEADING &&
                sec.heading !== jsonAppendixSection({}).heading,
            'the heading must differ from the appendix heading (persistence-strip safety)',
        );
        const secText = JSON.stringify(sec);
        check(
            's20.section.intro',
            sec.blocks[0].kind === 'paragraphs' && sec.blocks[0].text[0] === PRODUCER_SPL_INTRO,
            'the §20.8a-7 not-executed intro leads the section',
        );
        check(
            's20.section.notRunClaim',
            /NOT run by this diagnosis/.test(PRODUCER_SPL_INTRO),
            'the intro must state the SPL did not run',
        );
        check(
            's20.section.splByteEqual',
            sec.blocks.some((b: any) => b.kind === 'mono' && b.text === AGG_SPL),
            'the SPL renders byte-equal — no truncation on this path (kills mutation c)',
        );
        check(
            's20.section.cronVerbatimNoAdjective',
            secText.indexOf('30 0 * * *') !== -1 && !/hourly aggregate/i.test(secText),
            'cadence renders as the verbatim cron, never a hardcoded adjective (§20.8a-6)',
        );
        check(
            's20.section.backfillHedge',
            sec.blocks.some(
                (b: any) =>
                    b.kind === 'paragraphs' &&
                    b.text.some(
                        (t: string) =>
                            /As shipped, the backfill stanza logserv_linux_backfill/.test(t) &&
                            /did not read it/.test(t),
                    ),
            ),
            'the as-shipped hedge names only the entry’s own sibling (§20.8a-2)',
        );
        check(
            's20.section.completeness',
            sec.blocks[0].text.some((t: string) =>
                /1 of 3 populating searches could not be read/.test(t),
            ),
            'a skipped entry raises the explicit completeness line (§20.8a-8)',
        );
        check(
            's20.section.skippedReason',
            sec.blocks.some(
                (b: any) =>
                    b.kind === 'paragraphs' &&
                    b.text.some((t: string) => /Could not be read — Time budget exhausted/.test(t)),
            ),
            'a skipped entry renders its reason, never a blank',
        );

        // --- the Open-in-Search strip (session 113) -----------------------
        // The drawer's per-entry "Open in Search" action must never hand out
        // a search that still carries the `| outputlookup` write (running it
        // over a partial window would upsert partial bucket rows over correct
        // summary rows — the no-destructive-controls rule). The build gate
        // additionally proves the strip against every registry aggregate's
        // SHIPPED search=; these checks pin the pure function's contract.
        check(
            's113.open.exported',
            typeof producerSplForOpenInSearch === 'function',
            'diagReport must export producerSplForOpenInSearch',
        );
        check(
            's113.open.stripsTerminalWrite',
            producerSplForOpenInSearch(AGG_SPL) ===
                'search `sap_logserv_idx_macro` sourcetype="linux_secure" | bin _time span=1h ' +
                    '| stats count by host, _time "with quotes"',
            'the terminal | outputlookup write is removed, everything before it byte-equal',
        );
        check(
            's113.open.caseInsensitive',
            producerSplForOpenInSearch('| makeresults | OUTPUTLOOKUP logserv_x_rollup append=true') ===
                '| makeresults',
            'OUTPUTLOOKUP in any case is stripped',
        );
        check(
            's113.open.nonTerminalFailsClosed',
            producerSplForOpenInSearch('| inputlookup a | outputlookup b append=true | stats count') ===
                null,
            'a NON-terminal outputlookup cannot be removed with certainty -> null (fail closed)',
        );
        check(
            's113.open.subsearchFailsClosed',
            producerSplForOpenInSearch('| makeresults | appendpipe [| outputlookup b]') === null,
            'a subsearch-closing outputlookup must not be bracket-broken -> null (fail closed)',
        );
        check(
            's113.open.writeOnlyFailsClosed',
            producerSplForOpenInSearch('| outputlookup logserv_x_rollup append=true') === null,
            'a definition that is ONLY the write strips to nothing -> null',
        );
        check(
            's113.open.noWritePassesThrough',
            producerSplForOpenInSearch('  | inputlookup logserv_linux_rollup where metric="fw"  ') ===
                '| inputlookup logserv_linux_rollup where metric="fw"',
            'a definition with no write opens as-is (trimmed)',
        );
        check(
            's113.open.emptyNull',
            producerSplForOpenInSearch('') === null && producerSplForOpenInSearch('   ') === null,
            'empty / whitespace-only -> null',
        );

        // --- the panel model ----------------------------------------------
        const facts20 = {
            spl: CACHED,
            earliest: '-7d@d',
            latest: 'now',
            dispatched: true,
            loading: false,
            errorMessage: null,
            rowCount: 0,
            cloudProvider: 'all',
        };
        const verdict20 = {
            id: 'rollup-never-built',
            short: 'Never built',
            headline: 'x',
            confidence: 'confirmed',
            owner: 'splunk-admin',
            evidence: ['e'],
        };
        const ev20 = {
            indexRowsInWindow: 100,
            resolvedIndexes: ['sap_logserv_logs'],
            macroIndexes: null,
            visibleIndexes: null,
            sourcetypeCounts: {},
            sourcetypeLastSeen: null,
            sourceScope: null,
            collectionRowsInWindow: 0,
            collectionRowsAllMetrics: null,
            collectionExtentProbed: true,
            collectionOldest: null,
            collectionNewest: null,
            canaryMs: 100,
            producerSpl: [entry],
            notes: [],
            budgetExhausted: false,
        };
        const pm = buildPanelReportModel({
            panelTitle: 'Volume by Type',
            dashboardLabel: 'Linux',
            facts: facts20,
            probe: probeSpl(CACHED),
            diag: { top: verdict20, all: [verdict20], incomplete: false },
            evidence: ev20,
            meta: META,
        });
        check(
            's20.panel.section',
            pm.sections.some((s: any) => s.heading === ROLLUP_SEARCHES_HEADING),
            'a producer-carrying panel model renders the section',
        );
        check(
            's20.panel.jsonKey',
            Array.isArray((pm.json as any).rollupSearches) &&
                (pm.json as any).rollupSearches[0].spl === AGG_SPL,
            'json.rollupSearches carries the entries',
        );
        check(
            's20.panel.evidenceStripped',
            (pm.json as any).evidence.producerSpl === undefined,
            'json.evidence must NOT carry producerSpl (§20.8a-5)',
        );
        // The §20.8a-5 exact-count pin: the SPL appears exactly TWICE in the
        // STORED model (section mono + json.rollupSearches) — compare on the
        // JSON-escaped needle so both copies count.
        {
            const persistMod20 = require('./diagPersistence') as any;
            const stored = persistMod20.stripAppendixForStorage(pm);
            const needle = JSON.stringify(AGG_SPL).slice(1, -1);
            const count = JSON.stringify(stored).split(needle).length - 1;
            check('s20.panel.storedTwice', count === 2, `SPL appears ${count}× in the stored model, want 2`);
        }
        // Absent case: the pre-§20 fixtures above already build evidence
        // without the field — but pin it explicitly too.
        const pmAbsent = buildPanelReportModel({
            panelTitle: 'Volume by Type',
            dashboardLabel: 'Linux',
            facts: facts20,
            probe: probeSpl(CACHED),
            diag: { top: verdict20, all: [verdict20], incomplete: false },
            evidence: { ...ev20, producerSpl: undefined },
            meta: META,
        });
        check(
            's20.panel.absentNoSection',
            !pmAbsent.sections.some((s: any) => s.heading === ROLLUP_SEARCHES_HEADING) &&
                (pmAbsent.json as any).rollupSearches === null,
            'no capture -> no section, json null, no throw',
        );

        // --- the dashboard model ------------------------------------------
        const dm = buildDashboardReportModel({
            dashboardLabel: 'Linux',
            sweep: { entries: [], diagnosedCount: 0, budgetExhausted: false },
            meta: META,
            rollupSearches: [entry, dailyEntry],
        });
        check(
            's20.dash.section',
            dm.sections.some((s: any) => s.heading === ROLLUP_SEARCHES_HEADING),
            'the dashboard section renders from the explicit input (healthy dashboards included — kills mutation d’s cousin)',
        );
        check(
            's20.dash.jsonKey',
            Array.isArray((dm.json as any).rollupSearches) && (dm.json as any).rollupSearches.length === 2,
            'json.rollupSearches deduped list',
        );
        check(
            's20.dash.sweepClean',
            JSON.stringify((dm.json as any).sweep).indexOf('rollupSearches') === -1,
            'json.sweep must not carry the SPL (§20.8a-5)',
        );
        {
            const persistMod20 = require('./diagPersistence') as any;
            const stored = persistMod20.stripAppendixForStorage(dm);
            const needle = JSON.stringify(AGG_SPL).slice(1, -1);
            const count = JSON.stringify(stored).split(needle).length - 1;
            check('s20.dash.storedTwice', count === 2, `SPL appears ${count}× in the stored dashboard model, want 2`);
        }
        // The existing dashboard fixture above passes NO rollupSearches and
        // did not throw — the absent case is exercised; pin the no-section
        // outcome here.
        const dmAbsent = buildDashboardReportModel({
            dashboardLabel: 'Linux',
            sweep: { entries: [], diagnosedCount: 0, budgetExhausted: false },
            meta: META,
        });
        check(
            's20.dash.absentNoSection',
            !dmAbsent.sections.some((s: any) => s.heading === ROLLUP_SEARCHES_HEADING),
            'no input -> no section, no throw',
        );

        // --- full-length samples wording (from the BUILT model, §20.8a-16) --
        const longRaw = 'Q'.repeat(2_000);
        const pmSamples = buildPanelReportModel({
            panelTitle: 'Audit Log',
            dashboardLabel: 'Cloud Connector',
            facts: facts20,
            probe: probeSpl(CACHED),
            diag: { top: verdict20, all: [verdict20], incomplete: false },
            evidence: { ...ev20, producerSpl: undefined },
            meta: META,
            rawSamples: {
                events: [{ time: 't', sourcetype: 'x', host: 'h', raw: longRaw }],
                fromWindow: true,
                excludedFilters: [],
                error: '',
            },
        });
        const samplesSec = pmSamples.sections.find((s: any) => /Raw event samples/.test(s.heading));
        const samplesText = samplesSec ? JSON.stringify(samplesSec) : '';
        check('s20.samples.sectionPresent', !!samplesSec, 'samples section renders');
        check(
            's20.samples.noStale500',
            samplesText.indexOf('truncated to 500') === -1,
            'the stale 500-char claim must be gone from the built model (§20.8a-16)',
        );
        check(
            's20.samples.ceilingWording',
            /included in full, up to a 20,000-character safety ceiling/.test(samplesText),
            'the paragraph derives the ceiling from the constant',
        );
        check(
            's20.samples.latin1Clause',
            /Latin-1 font/.test(samplesText) && /.json file carries the exact text/.test(samplesText),
            'the §20.8a-14 PDF-fidelity clause',
        );
        check(
            's20.samples.fullEventInModel',
            samplesSec.blocks.some((b: any) => b.kind === 'mono' && b.text.indexOf(longRaw) !== -1),
            'the full event body lands in the model',
        );
        check(
            's20.samples.bannerFullLength',
            pmSamples.banner.indexOf('full-length raw log events') !== -1 &&
                pmSamples.banner.indexOf('Latin-1 font') !== -1,
            'the includes-branch banner names full-length + the fidelity clause',
        );

        // --- the banner inventory + the legacy list (§20.8a-4) ------------
        check(
            's20.banner.namesSplClass',
            dataBanner(false).indexOf('full text of the saved searches') !== -1,
            'the banner inventory names the new content class',
        );
        check(
            's20.banner.legacyListNonEmpty',
            Array.isArray(LEGACY_DATA_BANNERS) &&
                LEGACY_DATA_BANNERS.length >= 1 &&
                LEGACY_DATA_BANNERS[0].indexOf('full text of the saved searches') === -1,
            'the legacy list carries the exact pre-§20 form',
        );
    }

    if (failures > 0) {
        proc.stderr.write(`\ndiagReport consistency test: ${failures} failure(s) of ${checks} checks\n`);
    } else {
        console.log(`diagReport consistency test: ${checks} checks OK`);
    }

    return failures;
};
