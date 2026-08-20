/**
 * Build-time consistency test for `diagEvidence.ts` orchestration + the
 * transport's response interpretation (session 095 fix pass).
 *
 * `gatherPanelEvidence` is async and fetch-driven, so unlike its siblings this
 * test drives it through a FAKE ProbeRunner — canned results per probe shape —
 * which is exactly what lets it pin the evidence-integrity fixes:
 *
 *   - an errored/skipped count probe must not fabricate the note
 *     "The sourcetype has events in this window." (finding 8a)
 *   - a failed KV extent read must leave `collectionExtentProbed=false`,
 *     distinct from a successful read of an empty collection (finding 2)
 *   - the rollup-source trace must UNION every aggregate of a multi-aggregate
 *     rollup, not read aggs[0] only (finding 9)
 *   - the macro-definition probe must populate `macroIndexes` when the window
 *     count is zero (finding 1's evidence side)
 *   - a metric-scoped zero must trigger the all-measures count (finding 4c's
 *     evidence side)
 *   - `oneshotFailureMessage` must catch ERROR/finalization messages and pass
 *     benign chatter through (finding 7)
 *
 * Loaded by `bin/check-diagnostics.js`, which AWAITS the exported `run()` —
 * this file must not call process.exit itself.
 */

/* eslint-disable no-console, @typescript-eslint/no-explicit-any */

// The webapp tsconfig types `process` narrowly (DefinePlugin ambient), so the
// stderr writes go through the same cast the sibling tests use.
const proc = process as unknown as { stderr: { write(s: string): void } };

const evMod = require('./diagEvidence') as any;
const probeMod = require('./splProbe') as any;
const transportMod = require('./diagProbe') as any;

const gather = evMod.gatherPanelEvidence as (
    runner: any,
    probe: any,
    earliest: string,
    latest: string,
    onProgress?: (notes: unknown[]) => void,
    opts?: any,
) => Promise<any>;
const aggregatesForCollection = evMod.aggregatesForCollection as (c: string) => string[];
const probeSpl = probeMod.probeSpl as (spl: string) => any;
const oneshotFailureMessage = transportMod.oneshotFailureMessage as (d: unknown) => string | null;
const fetchMacroIndexes = transportMod.fetchMacroIndexes as (
    runner: any,
) => Promise<{ indexes: string[] | null; error: string; skipped: boolean }>;

interface FakeResult {
    rows: unknown[];
    error: string;
    durationMs: number;
    skipped: boolean;
}
const ok = (rows: unknown[]): FakeResult => ({ rows, error: '', durationMs: 1, skipped: false });
const err = (e: string): FakeResult => ({ rows: [], error: e, durationMs: 1, skipped: false });

interface RunnerCfg {
    search?: (spl: string) => FakeResult;
    kv?: (collection: string, params: Record<string, string>) => FakeResult;
    rest?: (url: string) => FakeResult;
}
const makeRunner = (cfg: RunnerCfg): any => ({
    search: (spl: string): Promise<FakeResult> =>
        Promise.resolve(cfg.search ? cfg.search(spl) : ok([])),
    kv: (c: string, p: Record<string, string>): Promise<FakeResult> =>
        Promise.resolve(cfg.kv ? cfg.kv(c, p) : ok([])),
    rest: (u: string): Promise<FakeResult> => Promise.resolve(cfg.rest ? cfg.rest(u) : ok([])),
    cancel: (): void => undefined,
    isCancelled: (): boolean => false,
    elapsedMs: (): number => 0,
    remainingMs: (): number => 60_000,
    dispatched: (): number => 0,
});

const RAW = '`sap_logserv_idx_macro` sourcetype="sap:hana:audit" | stats count';
const BEACON_READ =
    '| inputlookup logserv_beaconing_detail_rollup where metric="denied" | addinfo | where day_ts>=relative_time(info_min_time,"@d") AND day_ts<info_max_time | stats sum(count) as c';
const HOURLY_READ =
    '| inputlookup logserv_linux_rollup where metric="total" | addinfo | where bucket_ts>=info_min_time AND bucket_ts<info_max_time | stats sum(count) as count';

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

    // --- oneshotFailureMessage (pure) ------------------------------------
    check(
        'msg.error',
        oneshotFailureMessage({ messages: [{ type: 'ERROR', text: 'boom' }] }) === 'boom',
        'an ERROR message must surface as the failure',
    );
    check(
        'msg.finalized',
        /auto-finalized/.test(
            oneshotFailureMessage({
                messages: [{ type: 'INFO', text: 'The search was auto-finalized after time limit.' }],
            }) || '',
        ),
        'a finalization message must surface as a failure',
    );
    check(
        'msg.benign',
        oneshotFailureMessage({
            messages: [{ type: 'INFO', text: 'Your timerange was substituted based on your search string' }],
        }) === null,
        'benign INFO chatter must pass through',
    );
    check('msg.bareArray', oneshotFailureMessage([{ x: 1 }]) === null, 'a KV bare array has no messages');
    check('msg.none', oneshotFailureMessage({ results: [] }) === null, 'no messages key means no failure');

    // --- finding 8a: errored count probe must not fabricate presence -----
    {
        const runner = makeRunner({
            search: (spl) => {
                if (spl.indexOf('makeresults') !== -1) return ok([{}]);
                if (spl.indexOf('BY index') !== -1)
                    return ok([{ index: 'sap_logserv_logs', count: '500' }]);
                if (spl.indexOf('BY sourcetype') !== -1) return err('HTTP 503 Service Unavailable');
                return ok([]);
            },
        });
        const ev = await gather(runner, probeSpl(RAW), '-24h', 'now');
        check('8a.countsNull', ev.sourcetypeCounts === null, 'an errored probe must leave null');
        const fabricated = (ev.notes as Array<{ detail: string }>).some((n) =>
            /The sourcetype has events in this window/.test(n.detail),
        );
        check('8a.noFabricatedNote', !fabricated, 'the evidence trail claimed presence no probe established');
        const honest = (ev.notes as Array<{ check: string; status: string; detail: string }>).some(
            (n) => n.check === 'Sourcetype last seen (all time)' && /could not be established/.test(n.detail),
        );
        check('8a.honestSupersede', honest, 'last-seen must be superseded with the real reason');
    }

    // --- finding 9: multi-aggregate trace union --------------------------
    {
        const aggs = aggregatesForCollection('logserv_beaconing_detail_rollup');
        check(
            '9.registryHasBoth',
            aggs.length >= 2,
            `the beaconing rollup must register both aggregates, got ${JSON.stringify(aggs)}`,
        );
        const runner = makeRunner({
            search: (spl) => {
                if (spl.indexOf('makeresults') !== -1) return ok([{}]);
                if (spl.indexOf('BY index') !== -1)
                    return ok([{ index: 'sap_logserv_logs', count: '500' }]);
                if (spl.indexOf('BY sourcetype') !== -1)
                    return ok([{ sourcetype: 'squid:access', count: '10' }]);
                if (spl.indexOf('inputlookup') !== -1 && spl.indexOf('metric=') !== -1)
                    return ok([{ count: '0' }]);
                if (spl.indexOf('inputlookup') !== -1) return ok([{ count: '7' }]);
                return ok([]);
            },
            kv: (_c, p) =>
                p.sort && p.sort.indexOf(':-1') !== -1
                    ? ok([{ day_ts: 5678 }])
                    : ok([{ day_ts: 1234 }]),
            rest: (url) => {
                if (url.indexOf('logserv_beaconing_detail_aggregate') !== -1) {
                    return ok([
                        { content: { search: 'search `sap_logserv_idx_macro` sourcetype="squid:access" status=403 | bin _time' } },
                    ]);
                }
                if (url.indexOf('logserv_beaconing_aggregate') !== -1) {
                    return ok([
                        { content: { search: 'search `sap_logserv_idx_macro` tag=dns message_type="Query" | bin _time' } },
                    ]);
                }
                return err('unexpected rest url');
            },
        });
        const ev = await gather(runner, probeSpl(BEACON_READ), '-7d', 'now');
        check(
            '9.unionSourcetypes',
            !!ev.sourceScope && ev.sourceScope.sourcetypes.indexOf('squid:access') !== -1,
            `the squid arm's scope must survive the union, got ${JSON.stringify(ev.sourceScope)}`,
        );
        check(
            '9.unionTags',
            !!ev.sourceScope && ev.sourceScope.tags.indexOf('dns') !== -1,
            `the tag-scoped arm must survive the union, got ${JSON.stringify(ev.sourceScope)}`,
        );
        check(
            '9.viaNamesBoth',
            !!ev.sourceScope &&
                /logserv_beaconing_aggregate/.test(ev.sourceScope.via) &&
                /logserv_beaconing_detail_aggregate/.test(ev.sourceScope.via),
            `via must name every traced aggregate, got "${ev.sourceScope && ev.sourceScope.via}"`,
        );
        // finding 4c's evidence side: metric-scoped zero triggers the
        // all-measures count.
        check(
            '4c.allMetricsProbed',
            ev.collectionRowsAllMetrics === 7,
            `expected the all-measures count 7, got ${ev.collectionRowsAllMetrics}`,
        );
        // extent success on a daily collection.
        check(
            '2.extentProbedTrue',
            ev.collectionExtentProbed === true &&
                ev.collectionOldest === 1234 &&
                ev.collectionNewest === 5678,
            `expected a successful extent read, got probed=${ev.collectionExtentProbed} ${ev.collectionOldest}..${ev.collectionNewest}`,
        );
    }

    // --- finding 1: the macro-definition probe ---------------------------
    {
        const runner = makeRunner({
            search: (spl) => {
                if (spl.indexOf('makeresults') !== -1) return ok([{}]);
                if (spl.indexOf('BY index') !== -1) return ok([]); // empty window
                if (spl.indexOf('eventcount') !== -1) return ok([{ index: 'main' }]);
                return ok([]);
            },
            rest: (url) =>
                url.indexOf('conf-macros/sap_logserv_idx_macro') !== -1
                    ? ok([{ content: { definition: 'index="sap_logserv_logs_con01"' } }])
                    : err('unexpected rest url'),
        });
        const ev = await gather(runner, probeSpl(RAW), '-24h', 'now');
        check(
            '1.macroIndexes',
            !!ev.macroIndexes && ev.macroIndexes.length === 1 && ev.macroIndexes[0] === 'sap_logserv_logs_con01',
            `the macro definition must resolve the index, got ${JSON.stringify(ev.macroIndexes)}`,
        );
        check(
            '1.resolvedEmpty',
            Array.isArray(ev.resolvedIndexes) && ev.resolvedIndexes.length === 0,
            'the windowed tstats resolves to nothing on an empty window — that is the point',
        );
        // Direct parse check, incl. the multi-index OR form.
        const multi = await fetchMacroIndexes(
            makeRunner({
                rest: () => ok([{ content: { definition: '(index="a_one" OR index=b_two)' } }]),
            }),
        );
        check(
            '1.macroMultiIndex',
            !!multi.indexes && multi.indexes.join(',') === 'a_one,b_two',
            `both named indexes must parse, got ${JSON.stringify(multi.indexes)}`,
        );
    }

    // --- finding 2: extent probe FAILURE stays distinguishable ----------
    {
        const runner = makeRunner({
            search: (spl) => {
                if (spl.indexOf('makeresults') !== -1) return ok([{}]);
                if (spl.indexOf('BY index') !== -1)
                    return ok([{ index: 'sap_logserv_logs', count: '500' }]);
                if (spl.indexOf('inputlookup') !== -1) return ok([{ count: '0' }]);
                return ok([]);
            },
            kv: () => err('HTTP 503 Service Unavailable'),
            rest: (url) =>
                url.indexOf('saved/searches') !== -1
                    ? ok([{ content: { search: 'search sourcetype="linux_secure" | bin _time' } }])
                    : ok([]),
        });
        const ev = await gather(runner, probeSpl(HOURLY_READ), '-24h', 'now');
        check(
            '2.extentProbedFalse',
            ev.collectionExtentProbed === false &&
                ev.collectionOldest === null &&
                ev.collectionNewest === null,
            `a failed extent read must not look like an empty collection, got probed=${ev.collectionExtentProbed}`,
        );
    }

    // =====================================================================
    // §14 (build 313) — the new probes' gathering + tri-state (design §14.8a).
    // =====================================================================

    // --- §14.1: the PURE fresh-install state must still gather last-seen —
    // indexRows === 0 previously superseded the whole sourcetype block, which
    // made the feed-never-arrived verdict structurally unreachable exactly
    // where it matters. For a cached panel with a traced scope, the all-time
    // `| metadata` probe must dispatch, resolving the index via the MACRO
    // definition (the windowed tstats has nothing in this state).
    {
        const dispatchedSpl: string[] = [];
        const runner = makeRunner({
            search: (spl) => {
                dispatchedSpl.push(spl);
                if (spl.indexOf('makeresults') !== -1) return ok([{}]);
                if (spl.indexOf('BY index') !== -1) return ok([]); // empty index
                if (spl.indexOf('eventcount') !== -1)
                    return ok([{ index: 'sap_logserv_logs' }]);
                if (spl.indexOf('| metadata') !== -1)
                    return ok([{ sourcetype: 'other_type', lastTime: '1700000000' }]);
                return ok([]);
            },
            rest: (u) => {
                if (u.indexOf('conf-macros') !== -1)
                    return ok([{ content: { definition: 'index="sap_logserv_logs"' } }]);
                if (u.indexOf('saved/searches') !== -1)
                    return ok([
                        { content: { search: 'sourcetype="linux_secure" | stats count', disabled: false } },
                    ]);
                return ok([]);
            },
            kv: () => ok([]),
        });
        const ev = await gather(runner, probeSpl(HOURLY_READ), '-30d@d', 'now');
        const metaSpl = dispatchedSpl.filter((s) => s.indexOf('| metadata') !== -1);
        check(
            's14.1.metadataDispatchedOnEmptyIndex',
            metaSpl.length === 1,
            `expected 1 metadata dispatch, got ${metaSpl.length}`,
        );
        check(
            's14.1.macroFallbackIndexName',
            metaSpl.length === 1 && metaSpl[0].indexOf('index=sap_logserv_logs') !== -1,
            metaSpl.join(' | '),
        );
        check(
            's14.1.lastSeenKnownEmpty',
            ev.sourcetypeLastSeen !== null && Object.keys(ev.sourcetypeLastSeen).length === 0,
            `got ${JSON.stringify(ev.sourcetypeLastSeen)}`,
        );
        check(
            's14.5.producerTriState',
            Array.isArray(ev.producerDisabled) &&
                ev.producerDisabled.length === 0 &&
                ev.producerTracedCount === 1,
            `got ${JSON.stringify(ev.producerDisabled)}/${ev.producerTracedCount}`,
        );
    }

    // --- §14.2: the unrouted probe fires at its moment, splits fallback vs
    // routed from one dispatch, and its skipped form leaves both fields null.
    {
        const runner = makeRunner({
            search: (spl) => {
                if (spl.indexOf('makeresults') !== -1) return ok([{}]);
                if (spl.indexOf('BY index') !== -1)
                    return ok([{ index: 'sap_logserv_logs', count: '1000' }]);
                if (spl.indexOf('BY sourcetype') !== -1 && spl.indexOf('sourcetype="') !== -1)
                    return ok([]); // the panel's own sourcetypes: absent
                if (spl.indexOf('BY sourcetype') !== -1)
                    return ok([
                        { sourcetype: 'sap_logserv_logs', count: '800' },
                        { sourcetype: 'linux_secure', count: '25' },
                    ]); // the unfiltered §14.2 probe
                if (spl.indexOf('| metadata') !== -1) return ok([]);
                return ok([]);
            },
        });
        const ev = await gather(runner, probeSpl(RAW), '-24h', 'now');
        check(
            's14.2.fallbackSplit',
            ev.fallbackRowsInWindow === 800 && ev.routedRowsInWindow === 25,
            `got fb=${ev.fallbackRowsInWindow} routed=${ev.routedRowsInWindow}`,
        );
        const noteRow = (ev.notes as Array<{ check: string; status: string }>).filter(
            (n) => n.check === 'Unrouted events in window',
        );
        check('s14.2.noteTracked', noteRow.length === 1 && noteRow[0].status === 'ok', JSON.stringify(noteRow));
    }
    {
        const runner = makeRunner({
            search: (spl) => {
                if (spl.indexOf('makeresults') !== -1) return ok([{}]);
                if (spl.indexOf('BY index') !== -1)
                    return ok([{ index: 'sap_logserv_logs', count: '1000' }]);
                if (spl.indexOf('BY sourcetype') !== -1 && spl.indexOf('sourcetype="') !== -1)
                    return ok([]);
                if (spl.indexOf('BY sourcetype') !== -1)
                    return { rows: [], error: '', durationMs: 0, skipped: true };
                if (spl.indexOf('| metadata') !== -1) return ok([]);
                return ok([]);
            },
        });
        const ev = await gather(runner, probeSpl(RAW), '-24h', 'now');
        check(
            's14.2.skippedLeavesNull',
            ev.fallbackRowsInWindow === null && ev.routedRowsInWindow === null,
            `got fb=${ev.fallbackRowsInWindow} routed=${ev.routedRowsInWindow}`,
        );
    }

    // --- §19.1/§19.8a-2: recentTime + firstTime ride the SAME metadata
    // dispatch — recentSeen filtered like lastSeen; preCutoffOldest is the
    // INDEX-WIDE min firstTime; both null-preserving.
    {
        const dispatchedSpl: string[] = [];
        const NOWs = Math.floor(Date.now() / 1000);
        const runner = makeRunner({
            search: (spl) => {
                dispatchedSpl.push(spl);
                if (spl.indexOf('makeresults') !== -1) return ok([{}]);
                if (spl.indexOf('BY index') !== -1)
                    return ok([{ index: 'sap_logserv_logs', count: '1000' }]);
                if (spl.indexOf('BY sourcetype') !== -1 && spl.indexOf('sourcetype="') !== -1)
                    return ok([]); // the panel's sourcetype: absent in window
                if (spl.indexOf('| metadata') !== -1)
                    return ok([
                        {
                            sourcetype: 'sap:hana:audit',
                            firstTime: String(NOWs - 40 * 86400),
                            lastTime: String(NOWs - 30 * 86400),
                            recentTime: String(NOWs - 60),
                        },
                        {
                            // an OTHER sourcetype with the OLDEST firstTime —
                            // preCutoffOldest is index-wide, before the filter
                            sourcetype: 'linux_secure',
                            firstTime: String(NOWs - 90 * 86400),
                            lastTime: String(NOWs - 10),
                            recentTime: String(NOWs - 10),
                        },
                        {
                            // a garbage row: unparsable firstTime is SKIPPED,
                            // never read as 0 (the null-preserving pin, M11)
                            sourcetype: 'junk_type',
                            firstTime: 'not-a-number',
                            lastTime: 'also-junk',
                            recentTime: '',
                        },
                    ]);
                return ok([]);
            },
        });
        const ev = await gather(runner, probeSpl(RAW), '-24h', 'now');
        const metaSpl = dispatchedSpl.filter((s) => s.indexOf('| metadata') !== -1);
        check(
            's19.metaFields',
            metaSpl.length === 1 &&
                metaSpl[0].indexOf('firstTime') !== -1 &&
                metaSpl[0].indexOf('recentTime') !== -1 &&
                metaSpl[0].indexOf('lastTime') !== -1,
            metaSpl.join(' | '),
        );
        check(
            's19.recentSeenFiltered',
            ev.sourcetypeRecentSeen !== null &&
                ev.sourcetypeRecentSeen['sap:hana:audit'] === NOWs - 60 &&
                !('linux_secure' in ev.sourcetypeRecentSeen),
            `got ${JSON.stringify(ev.sourcetypeRecentSeen)}`,
        );
        check(
            's19.lastSeenUnchangedShape',
            ev.sourcetypeLastSeen !== null && ev.sourcetypeLastSeen['sap:hana:audit'] === NOWs - 30 * 86400,
            `got ${JSON.stringify(ev.sourcetypeLastSeen)}`,
        );
        check(
            's19.preCutoffOldestIndexWide',
            ev.preCutoffOldest === NOWs - 90 * 86400,
            `got ${String(ev.preCutoffOldest)}`,
        );
    }
    // All-garbage metadata rows: preCutoffOldest STAYS null (never 0).
    {
        const runner = makeRunner({
            search: (spl) => {
                if (spl.indexOf('makeresults') !== -1) return ok([{}]);
                if (spl.indexOf('BY index') !== -1)
                    return ok([{ index: 'sap_logserv_logs', count: '1000' }]);
                if (spl.indexOf('BY sourcetype') !== -1 && spl.indexOf('sourcetype="') !== -1)
                    return ok([]);
                if (spl.indexOf('| metadata') !== -1)
                    return ok([{ sourcetype: 'x', firstTime: 'garbage', lastTime: 'garbage' }]);
                return ok([]);
            },
        });
        const ev = await gather(runner, probeSpl(RAW), '-24h', 'now');
        check('s19.allGarbageOldestNull', ev.preCutoffOldest === null, String(ev.preCutoffOldest));
        check(
            's19.recentSeenEmptyNotNull',
            ev.sourcetypeRecentSeen !== null && Object.keys(ev.sourcetypeRecentSeen).length === 0,
            JSON.stringify(ev.sourcetypeRecentSeen),
        );
    }
    // Probe failure: BOTH new fields stay null (tri-state).
    {
        const runner = makeRunner({
            search: (spl) => {
                if (spl.indexOf('makeresults') !== -1) return ok([{}]);
                if (spl.indexOf('BY index') !== -1)
                    return ok([{ index: 'sap_logserv_logs', count: '1000' }]);
                if (spl.indexOf('BY sourcetype') !== -1 && spl.indexOf('sourcetype="') !== -1)
                    return ok([]);
                if (spl.indexOf('| metadata') !== -1) return err('HTTP 503');
                return ok([]);
            },
        });
        const ev = await gather(runner, probeSpl(RAW), '-24h', 'now');
        check(
            's19.failedProbeNulls',
            ev.sourcetypeRecentSeen === null && ev.preCutoffOldest === null,
            `${JSON.stringify(ev.sourcetypeRecentSeen)}/${String(ev.preCutoffOldest)}`,
        );
    }

    // --- §14.4: the apps listing is probed for Windows-family panels and NOT
    // for others (one cheap call, only at its moment).
    {
        const WINRAW = '`sap_logserv_idx_macro` sourcetype="XmlWinEventLog" | stats count';
        const restUrls: string[] = [];
        const runner = makeRunner({
            search: (spl) => {
                if (spl.indexOf('makeresults') !== -1) return ok([{}]);
                if (spl.indexOf('BY index') !== -1)
                    return ok([{ index: 'sap_logserv_logs', count: '1000' }]);
                if (spl.indexOf('sourcetype="') !== -1 && spl.indexOf('BY sourcetype') !== -1)
                    return ok([{ sourcetype: 'XmlWinEventLog', count: '500' }]);
                return ok([]);
            },
            rest: (u) => {
                restUrls.push(u);
                if (u.indexOf('apps/local') !== -1)
                    return ok([{ name: 'search' }, { name: 'Splunk_SA_CIM' }]);
                return ok([]);
            },
        });
        const ev = await gather(runner, probeSpl(WINRAW), '-24h', 'now');
        check(
            's14.4.appsProbedForWindows',
            Array.isArray(ev.installedApps) && ev.installedApps.indexOf('Splunk_SA_CIM') !== -1,
            `got ${JSON.stringify(ev.installedApps)}`,
        );
    }
    {
        const restUrls: string[] = [];
        const runner = makeRunner({
            search: (spl) => {
                if (spl.indexOf('makeresults') !== -1) return ok([{}]);
                if (spl.indexOf('BY index') !== -1)
                    return ok([{ index: 'sap_logserv_logs', count: '1000' }]);
                if (spl.indexOf('sourcetype="') !== -1 && spl.indexOf('BY sourcetype') !== -1)
                    return ok([{ sourcetype: 'sap:hana:audit', count: '500' }]);
                return ok([]);
            },
            rest: (u) => {
                restUrls.push(u);
                return ok([]);
            },
        });
        const ev = await gather(runner, probeSpl(RAW), '-24h', 'now');
        check(
            's14.4.appsNotProbedOtherwise',
            ev.installedApps === null && restUrls.every((u) => u.indexOf('apps/local') === -1),
            `installedApps=${JSON.stringify(ev.installedApps)} urls=${restUrls.join(',')}`,
        );
    }

    // --- §14.5: kvStoreStatus is fetched when the collection reads fail, and
    // the producer-disabled flags ride the trace.
    {
        const runner = makeRunner({
            search: (spl) => {
                if (spl.indexOf('makeresults') !== -1) return ok([{}]);
                if (spl.indexOf('BY index') !== -1)
                    return ok([{ index: 'sap_logserv_logs', count: '1000' }]);
                if (spl.indexOf('inputlookup') !== -1) return err('KV Store initializing');
                return ok([]);
            },
            rest: (u) => {
                if (u.indexOf('conf-macros') !== -1)
                    return ok([{ content: { definition: 'index="sap_logserv_logs"' } }]);
                if (u.indexOf('saved/searches') !== -1)
                    return ok([
                        { content: { search: 'sourcetype="linux_secure" | stats count', disabled: true } },
                    ]);
                if (u.indexOf('server/info') !== -1)
                    return ok([{ content: { kvStoreStatus: 'starting' } }]);
                return ok([]);
            },
            kv: () => err('KV Store initializing'),
        });
        const ev = await gather(runner, probeSpl(HOURLY_READ), '-30d@d', 'now');
        check('s14.5.kvStatusFetched', ev.kvStoreStatus === 'starting', `got ${ev.kvStoreStatus}`);
        check(
            's14.5.producerDisabledCollected',
            Array.isArray(ev.producerDisabled) &&
                ev.producerDisabled.length === 1 &&
                ev.producerTracedCount === 1,
            `got ${JSON.stringify(ev.producerDisabled)}/${ev.producerTracedCount}`,
        );
    }

    // =====================================================================
    // §18.8a-27 residual (session 104) — the PARTIAL gather + scalar twin.
    // =====================================================================

    // --- §18.8a-23: partial mode SKIPS the emptiness battery (with explicit
    // notes, never silently) and dispatches nothing it does not need.
    {
        const dispatched: string[] = [];
        const runner = makeRunner({
            search: (spl) => {
                dispatched.push(spl);
                if (spl.indexOf('makeresults') !== -1) return ok([{}]);
                return ok([]);
            },
        });
        const ev = await gather(runner, probeSpl(RAW), '-24h', 'now', undefined, {
            mode: 'partial',
        } as any);
        const emptinessDispatches = dispatched.filter(
            (s) =>
                s.indexOf('BY index') !== -1 ||
                s.indexOf('BY sourcetype') !== -1 ||
                s.indexOf('| metadata') !== -1 ||
                s.indexOf('inputlookup') !== -1 ||
                s.indexOf('eventcount') !== -1,
        );
        check(
            's18.partial.noEmptinessDispatches',
            emptinessDispatches.length === 0,
            `emptiness probes dispatched in partial mode: ${emptinessDispatches.join(' | ')}`,
        );
        check('s18.partial.indexRowsNull', ev.indexRowsInWindow === null, String(ev.indexRowsInWindow));
        const superseded = (ev.notes as Array<{ check: string; status: string; detail: string }>).filter(
            (n) => /Not applicable — this panel returned data\./.test(n.detail),
        );
        check(
            's18.partial.batterySuperseded',
            superseded.length === 5,
            `expected the 5 emptiness checks superseded, got ${superseded.length}: ${JSON.stringify(superseded.map((n) => n.check))}`,
        );
        // No coverage summary passed → the column tier says so, honestly.
        const covNote = (ev.notes as Array<{ check: string; status: string; detail: string }>).filter(
            (n) => n.check === 'Column coverage (local)',
        );
        check(
            's18.partial.noCoverageSkipped',
            covNote.length === 1 && covNote[0].status === 'skipped' && /cannot run/.test(covNote[0].detail),
            JSON.stringify(covNote),
        );
        check('s18.partial.columnProbeNull', ev.columnProbe === null, JSON.stringify(ev.columnProbe));
    }

    // --- §18.8a-16: ONE corroboration dispatch for ALL probeable blanks, and
    // the §18.8a-12 blank dispositions (hasRender / computed / unsafe / renamed).
    {
        const dispatched: string[] = [];
        const runner = makeRunner({
            search: (spl) => {
                dispatched.push(spl);
                if (spl.indexOf('makeresults') !== -1) return ok([{}]);
                if (spl.indexOf('stats count as sampled') !== -1)
                    return ok([{ sampled: '850', present_0: '0', present_1: '312' }]);
                return ok([]);
            },
        });
        const coverage = {
            columns: [
                { key: 'status', populated: 20, hasRender: false },
                { key: 'method', populated: 7, hasRender: false },
                { key: 'chart', populated: 0, hasRender: true },
                { key: 'rate', populated: 0, blankKind: 'absent', hasRender: false },
                { key: 'Bad Name', populated: 0, blankKind: 'absent', hasRender: false },
                { key: 'Request URI', populated: 0, blankKind: 'absent', hasRender: false },
                { key: 'peer', populated: 0, blankKind: 'empty-string', hasRender: false },
            ],
            total: 20,
            capped: false,
        };
        const origins = {
            status: { kind: 'passthrough', probeName: 'status' },
            method: { kind: 'passthrough', probeName: 'method' },
            rate: { kind: 'computed' },
            'Bad Name': { kind: 'passthrough', probeName: 'Bad Name' },
            'Request URI': { kind: 'renamed', probeName: 'uri' },
            peer: { kind: 'passthrough', probeName: 'peer' },
        };
        const ev = await gather(runner, probeSpl(RAW), '-24h', 'now', undefined, {
            mode: 'partial',
            columnCoverage: coverage,
            columnOrigins: origins,
        } as any);
        const corr = dispatched.filter((s) => s.indexOf('stats count as sampled') !== -1);
        check('s18.corr.oneDispatch', corr.length === 1, `${corr.length} corroboration dispatches`);
        check(
            's18.corr.probesRenameSource',
            corr.length === 1 && corr[0].indexOf('count(uri) as present_0') !== -1 && corr[0].indexOf('count(peer) as present_1') !== -1,
            corr.join(' | '),
        );
        check(
            's18.corr.headCapPresent',
            corr.length === 1 && corr[0].indexOf('head 2000') !== -1,
            corr.join(' | '),
        );
        const cp = ev.columnProbe;
        check('s18.corr.probeAssembled', cp !== null, 'columnProbe null');
        if (cp) {
            check(
                's18.corr.populatedIncludesPartial',
                cp.populated.indexOf('status') !== -1 && cp.populated.indexOf('method') !== -1,
                JSON.stringify(cp.populated),
            );
            check(
                's18.corr.hasRenderDerived',
                cp.derivedOrComputed.some((d: { column: string }) => d.column === 'chart'),
                JSON.stringify(cp.derivedOrComputed),
            );
            check(
                's18.corr.computedDerived',
                cp.derivedOrComputed.some((d: { column: string }) => d.column === 'rate'),
                JSON.stringify(cp.derivedOrComputed),
            );
            check(
                's18.corr.unsafeDropped',
                cp.dropped.some((d: { column: string; reason: string }) => d.column === 'Bad Name' && /could not be identified/.test(d.reason)),
                JSON.stringify(cp.dropped),
            );
            const uri = cp.blanks.find((b: { column: string }) => b.column === 'Request URI');
            const peer = cp.blanks.find((b: { column: string }) => b.column === 'peer');
            check(
                's18.corr.blankValuesLanded',
                !!uri && uri.probeName === 'uri' && uri.present === 0 && !!peer && peer.present === 312,
                JSON.stringify(cp.blanks),
            );
            check('s18.corr.sampledLanded', cp.sampled === 850, String(cp.sampled));
        }
    }

    // --- §18.8a-13: the cached trace feeds `storedByAggregate` from the
    // aggregate's terminal `| fields` keep-list (single-pipeline only).
    {
        const runner = makeRunner({
            search: (spl) => {
                if (spl.indexOf('makeresults') !== -1) return ok([{}]);
                if (spl.indexOf('stats count as sampled') !== -1)
                    return ok([{ sampled: '400', present_0: '400', present_1: '0' }]);
                return ok([]);
            },
            rest: (u) =>
                u.indexOf('saved/searches') !== -1
                    ? ok([
                          {
                              content: {
                                  search:
                                      'search `sap_logserv_idx_macro` sourcetype="linux_secure" | bin _time span=1h | stats count by host | eval metric="total" | fields metric, host, count, bucket_ts',
                                  disabled: false,
                              },
                          },
                      ])
                    : ok([]),
        });
        const coverage = {
            columns: [
                { key: 'host', populated: 0, blankKind: 'absent', hasRender: false },
                { key: 'oom_proc', populated: 0, blankKind: 'absent', hasRender: false },
            ],
            total: 10,
            capped: false,
        };
        const origins = {
            host: { kind: 'passthrough', probeName: 'host' },
            oom_proc: { kind: 'passthrough', probeName: 'oom_proc' },
        };
        const ev = await gather(runner, probeSpl(HOURLY_READ), '-24h', 'now', undefined, {
            mode: 'partial',
            columnCoverage: coverage,
            columnOrigins: origins,
        } as any);
        const cp = ev.columnProbe;
        check('s18.stored.assembled', cp !== null, 'columnProbe null');
        if (cp) {
            const host = cp.blanks.find((b: { column: string }) => b.column === 'host');
            const oom = cp.blanks.find((b: { column: string }) => b.column === 'oom_proc');
            check(
                's18.stored.inKeepListTrue',
                !!host && host.storedByAggregate === true,
                JSON.stringify(host),
            );
            check(
                's18.stored.notInKeepListFalse',
                !!oom && oom.storedByAggregate === false,
                JSON.stringify(oom),
            );
        }
        // The trace itself ran (partial mode, cached panel with no SPL sourcetypes).
        check(
            's18.stored.traceRan',
            !!ev.sourceScope && ev.sourceScope.sourcetypes.indexOf('linux_secure') !== -1,
            JSON.stringify(ev.sourceScope),
        );
    }

    // --- §18.8a-10: the scalar-twin VALUE probe (deep + zeroValued + shared
    // terminal field). ok / non-numeric / error — and the twin dispatch is the
    // BARE raw arm, never suffixed with `| stats count as n`.
    {
        const RAWALT =
            '`sap_logserv_idx_macro` sourcetype="linux_secure" | stats count as n, count as count | fillnull value=0 count | fields count';
        const mkTwinRunner = (twinResult: FakeResult, dispatched: string[]): any =>
            makeRunner({
                search: (spl) => {
                    dispatched.push(spl);
                    if (spl === RAWALT) return twinResult;
                    if (spl.indexOf('makeresults') !== -1) return ok([{}]);
                    if (spl.indexOf('BY index') !== -1)
                        return ok([{ index: 'sap_logserv_logs', count: '1000' }]);
                    if (spl.indexOf('BY sourcetype') !== -1)
                        return ok([{ sourcetype: 'linux_secure', count: '50' }]);
                    if (spl.indexOf('inputlookup') !== -1 && spl.indexOf('metric=') !== -1)
                        return ok([{ count: '0' }]);
                    if (spl.indexOf('inputlookup') !== -1) return ok([{ count: '200' }]);
                    return ok([]);
                },
                kv: (_c, p) =>
                    p.sort && p.sort.indexOf(':-1') !== -1
                        ? ok([{ bucket_ts: Math.floor(Date.now() / 1000) - 7200 }])
                        : ok([{ bucket_ts: 1780000000 }]),
                rest: (u) =>
                    u.indexOf('saved/searches') !== -1
                        ? ok([
                              {
                                  content: {
                                      search: 'search sourcetype="linux_secure" | bin _time',
                                      disabled: false,
                                  },
                              },
                          ])
                        : ok([]),
            });
        const twinOpts = {
            deep: true,
            zeroValued: true,
            rawAlternate: RAWALT,
            scalarTwinField: 'count',
            rowCount: 0,
        } as any;

        // (a) ok — the numeric value lands as evidence.
        {
            const dispatched: string[] = [];
            const ev = await gather(
                mkTwinRunner(ok([{ count: '812' }]), dispatched),
                probeSpl(HOURLY_READ),
                '-24h',
                'now',
                undefined,
                twinOpts,
            );
            check(
                's18.twin.value',
                !!ev.scalarTwin && ev.scalarTwin.field === 'count' && ev.scalarTwin.value === 812,
                JSON.stringify(ev.scalarTwin),
            );
            const twinNote = (ev.notes as Array<{ check: string; status: string; detail: string }>).filter(
                (n) => n.check === 'Scalar-twin value probe',
            );
            check(
                's18.twin.noteOk',
                twinNote.length === 1 && twinNote[0].status === 'ok' && /count = 812/.test(twinNote[0].detail),
                JSON.stringify(twinNote),
            );
            // The check-21 arm must have been SKIPPED as scalar (never dispatched
            // with the `| stats count as n` suffix) — §17.8a-1's F1 guard.
            check(
                's18.twin.armSkippedScalar',
                ev.rawArmRan === false && ev.rawArmError === 'scalar raw arm',
                `ran=${ev.rawArmRan} err=${ev.rawArmError}`,
            );
            const suffixed = dispatched.filter((s) => s.indexOf(`${RAWALT} | stats count as n`) !== -1);
            check('s18.twin.bareDispatch', suffixed.length === 0, suffixed.join(' | '));
        }

        // (b) non-numeric — NOT CHECKED, never a value.
        {
            const ev = await gather(
                mkTwinRunner(ok([{ count: 'abc' }]), []),
                probeSpl(HOURLY_READ),
                '-24h',
                'now',
                undefined,
                twinOpts,
            );
            check('s18.twin.nonNumericNull', ev.scalarTwin === null, JSON.stringify(ev.scalarTwin));
            const twinNote = (ev.notes as Array<{ check: string; status: string; detail: string }>).filter(
                (n) => n.check === 'Scalar-twin value probe',
            );
            check(
                's18.twin.nonNumericNote',
                twinNote.length === 1 && twinNote[0].status === 'error' && /non-numeric/.test(twinNote[0].detail),
                JSON.stringify(twinNote),
            );
        }

        // (c) error — the failure surfaces, no value is fabricated.
        {
            const ev = await gather(
                mkTwinRunner(err('HTTP 400 Bad Request'), []),
                probeSpl(HOURLY_READ),
                '-24h',
                'now',
                undefined,
                twinOpts,
            );
            check('s18.twin.errorNull', ev.scalarTwin === null, JSON.stringify(ev.scalarTwin));
            const twinNote = (ev.notes as Array<{ check: string; status: string; detail: string }>).filter(
                (n) => n.check === 'Scalar-twin value probe',
            );
            check(
                's18.twin.errorNote',
                twinNote.length === 1 && twinNote[0].status === 'error' && /HTTP 400/.test(twinNote[0].detail),
                JSON.stringify(twinNote),
            );
        }
    }

    // =====================================================================
    // §20 — producer-SPL capture + full-length raw samples
    // =====================================================================
    {
        const collectProducerSpl = evMod.collectProducerSpl as (
            runner: any,
            collections: readonly string[],
        ) => Promise<any[] | null>;
        const parseOutputlookupTarget = evMod.parseOutputlookupTarget as (s: string) => string | null;
        const backfillNameFor = evMod.backfillNameFor as (s: string) => string;
        const collectRawSamples = evMod.collectRawSamples as (
            runner: any,
            sts: readonly string[],
            excluded: string[],
            e: string,
            l: string,
        ) => Promise<any>;
        const CAP = evMod.RAW_SAMPLE_EVENT_MAX_CHARS as number;

        // --- pure helpers ------------------------------------------------
        check(
            's20.outputlookup.plain',
            parseOutputlookupTarget('search x | outputlookup logserv_linux_rollup') ===
                'logserv_linux_rollup',
            'plain target',
        );
        check(
            's20.outputlookup.options',
            parseOutputlookupTarget(
                'search x | outputlookup append=true key_field=_key logserv_beaconing_detail_rollup',
            ) === 'logserv_beaconing_detail_rollup',
            'options are skipped',
        );
        check('s20.outputlookup.none', parseOutputlookupTarget('search x | stats count') === null, 'no target');
        check(
            's20.backfill.suffix',
            backfillNameFor('logserv_linux_aggregate') === 'logserv_linux_backfill',
            'suffix transform',
        );
        check(
            's20.backfill.infix',
            backfillNameFor('logserv_topology_aggregate_nodes') === 'logserv_topology_backfill_nodes',
            'topology infix transform',
        );

        // --- the 1:many attribution fixture (§20.8a-1; kills mutation e) --
        // A panel reading ONLY logserv_beaconing_rollup: the registry entry
        // bundles BOTH beaconing aggregates, but the detail aggregate's
        // outputlookup targets the OTHER collection and must be DROPPED.
        const beaconRest = (url: string): FakeResult => {
            if (url.indexOf('logserv_beaconing_detail_aggregate') !== -1) {
                return ok([
                    {
                        updated: '2026-08-01T00:00:00+00:00',
                        content: {
                            search: 'search x | outputlookup append=true logserv_beaconing_detail_rollup',
                            cron_schedule: '32 0 * * *',
                        },
                    },
                ]);
            }
            if (url.indexOf('logserv_beaconing_aggregate') !== -1) {
                return ok([
                    {
                        updated: '2026-08-02T00:00:00+00:00',
                        content: {
                            search: 'search y | outputlookup append=true logserv_beaconing_rollup',
                            cron_schedule: '30 0 * * *',
                        },
                    },
                ]);
            }
            return ok([]);
        };
        {
            const entries = await collectProducerSpl(makeRunner({ rest: beaconRest }), [
                'logserv_beaconing_rollup',
            ]);
            check(
                's20.attr.onlyOwnAggregate',
                Array.isArray(entries) &&
                    entries.length === 1 &&
                    entries[0].name === 'logserv_beaconing_aggregate',
                `the detail aggregate must be dropped, got ${JSON.stringify(entries && entries.map((e: any) => e.name))}`,
            );
            check(
                's20.attr.parsedCollection',
                !!entries && entries[0].collection === 'logserv_beaconing_rollup',
                'the collection is the PARSED outputlookup target',
            );
            check(
                's20.attr.cronVerbatim',
                !!entries && entries[0].cron === '30 0 * * *',
                'cron rides verbatim',
            );
            check(
                's20.attr.updated',
                !!entries && entries[0].updated === '2026-08-02T00:00:00+00:00',
                'updated rides',
            );
            check(
                's20.attr.backfillSibling',
                !!entries && entries[0].backfill === 'logserv_beaconing_backfill',
                'the sibling backfill by name transform',
            );
            check(
                's20.attr.splVerbatim',
                !!entries &&
                    entries[0].spl === 'search y | outputlookup append=true logserv_beaconing_rollup',
                'the SPL is byte-equal',
            );
        }
        // Both collections requested -> both aggregates kept.
        {
            const entries = await collectProducerSpl(makeRunner({ rest: beaconRest }), [
                'logserv_beaconing_rollup',
                'logserv_beaconing_detail_rollup',
            ]);
            check(
                's20.attr.bothWhenBothRead',
                Array.isArray(entries) && entries.length === 2,
                `got ${entries ? entries.length : 'null'}`,
            );
        }
        // --- tri-state honesty (§20.8a-8) ---------------------------------
        {
            // A skipped fetch must carry a NON-EMPTY synthesized reason (the
            // skip sentinel's error is '' — the review's silent-blank state).
            const skippedRunner = {
                ...makeRunner({}),
                rest: (): Promise<FakeResult> =>
                    Promise.resolve({ rows: [], error: '', durationMs: 0, skipped: true }),
            };
            const entries = await collectProducerSpl(skippedRunner, ['logserv_linux_rollup']);
            check(
                's20.tristate.skippedReason',
                Array.isArray(entries) &&
                    entries.length === 1 &&
                    entries[0].skipped === true &&
                    entries[0].spl === null &&
                    entries[0].error.length > 0,
                `skipped must synthesize a reason, got ${JSON.stringify(entries)}`,
            );
        }
        {
            // An entry with no search string: non-empty reason, not skipped.
            const entries = await collectProducerSpl(
                makeRunner({ rest: () => ok([{ content: {} }]) }),
                ['logserv_linux_rollup'],
            );
            check(
                's20.tristate.noSearchString',
                Array.isArray(entries) &&
                    entries[0].spl === null &&
                    entries[0].skipped === false &&
                    /no search string/.test(entries[0].error),
                JSON.stringify(entries),
            );
        }
        {
            // Already cancelled at entry -> null (section absent, §20.8a-8).
            const dead = { ...makeRunner({}), isCancelled: (): boolean => true };
            check(
                's20.tristate.cancelledNull',
                (await collectProducerSpl(dead, ['logserv_linux_rollup'])) === null,
                'a dead runner collects nothing',
            );
        }
        check(
            's20.emptyCollections',
            (await collectProducerSpl(makeRunner({}), [])) === null,
            'no collections, nothing to say',
        );

        // --- gather integration: deep-gated, both modes (§20.8a-9) --------
        const gatherRest = (url: string): FakeResult => {
            if (url.indexOf('saved/searches') !== -1 && url.indexOf('logserv_linux_aggregate') !== -1) {
                return ok([
                    {
                        content: {
                            search: 'search st | outputlookup append=true logserv_linux_rollup',
                            cron_schedule: '11 * * * *',
                        },
                    },
                ]);
            }
            return ok([]);
        };
        const gatherSearch = (spl: string): FakeResult => {
            if (spl.indexOf('makeresults') !== -1) return ok([{}]);
            if (spl.indexOf('BY index') !== -1) return ok([{ index: 'sap_logserv_logs', count: '500' }]);
            if (spl.indexOf('BY sourcetype') !== -1) return ok([{ sourcetype: 'linux_secure', count: '5' }]);
            if (spl.indexOf('inputlookup') !== -1) return ok([{ count: '3' }]);
            return ok([]);
        };
        {
            const ev = await gather(
                makeRunner({ search: gatherSearch, rest: gatherRest }),
                probeSpl(HOURLY_READ),
                '-24h',
                'now',
                undefined,
                { deep: true },
            );
            check(
                's20.gather.deepCaptures',
                Array.isArray(ev.producerSpl) && ev.producerSpl.length === 1,
                `deep:true on a cached panel must capture, got ${JSON.stringify(ev.producerSpl)}`,
            );
        }
        {
            const ev = await gather(
                makeRunner({ search: gatherSearch, rest: gatherRest }),
                probeSpl(HOURLY_READ),
                '-24h',
                'now',
            );
            check(
                's20.gather.sweepClean',
                ev.producerSpl === null,
                'no deep (the sweep shape) must NOT capture — §20.8a-5 json.sweep stays clean',
            );
        }
        {
            // §20.8a-9 — PARTIAL mode captures too (the early-return trap).
            const ev = await gather(
                makeRunner({ search: gatherSearch, rest: gatherRest }),
                probeSpl(HOURLY_READ),
                '-24h',
                'now',
                undefined,
                {
                    deep: true,
                    mode: 'partial',
                    rowCount: 40,
                    columnCoverage: {
                        total: 40,
                        capped: false,
                        columns: [{ key: 'count', populated: 40, hasRender: false }],
                    },
                },
            );
            check(
                's20.gather.partialCaptures',
                Array.isArray(ev.producerSpl) && ev.producerSpl.length === 1,
                `partial+deep must capture, got ${JSON.stringify(ev.producerSpl)}`,
            );
        }

        // --- full-length raw samples (§20.4/§20.8a-3) ---------------------
        const sampleRunner = (raw: string): any =>
            makeRunner({
                search: (spl) =>
                    spl.indexOf('| head 5') !== -1
                        ? ok([{ _time: '2026-08-11T00:00:00', sourcetype: 'x', host: 'h', _raw: raw }])
                        : ok([]),
            });
        {
            // A 2,000-char event survives byte-equal (kills mutation b: the
            // old 500 cap would have cut it).
            const long = 'Z'.repeat(2_000);
            const set = await collectRawSamples(sampleRunner(long), ['x'], [], '-24h', 'now');
            check(
                's20.samples.fullLength',
                set.events.length === 1 && set.events[0].raw === long,
                `a ${long.length}-char event must survive byte-equal, got ${set.events[0] ? set.events[0].raw.length : 'none'}`,
            );
        }
        {
            // Over-ceiling: clipped to CAP + the disclosed marker.
            const over = 'Y'.repeat(CAP + 500);
            const set = await collectRawSamples(sampleRunner(over), ['x'], [], '-24h', 'now');
            const raw = set.events[0].raw as string;
            check(
                's20.samples.ceilingMarker',
                raw.indexOf('[truncated: event exceeds') !== -1 && raw.length < over.length,
                'an over-ceiling event carries the disclosed marker',
            );
        }
        {
            // §20.8a-3 ORDER (kills mutation a): an email straddling the
            // ceiling. Slice-BEFORE-redaction leaves an inert partial address;
            // slice-after would have redacted it first and shifted the tail.
            const pad = 'A'.repeat(CAP - 10);
            const raw = `${pad}bob@example.com${'X'.repeat(50)}`;
            const set = await collectRawSamples(sampleRunner(raw), ['x'], [], '-24h', 'now');
            const got = set.events[0].raw as string;
            const expectHead = `${pad}bob@examp`; // the clip lands mid-address
            check(
                's20.samples.sliceBeforeRedaction',
                got.indexOf(expectHead) === 0 && got.indexOf('<redacted-') === -1,
                'the clip must run BEFORE redaction (a partial address is inert)',
            );
        }
        {
            // Redaction still applies to full-length events.
            const raw = `user=root did a thing; contact admin@example.com ${'B'.repeat(1_000)}`;
            const set = await collectRawSamples(sampleRunner(raw), ['x'], [], '-24h', 'now');
            const got = set.events[0].raw as string;
            check(
                's20.samples.redactionHolds',
                got.indexOf('admin@example.com') === -1 && got.indexOf('<redacted-') !== -1,
                'full-length ≠ unredacted',
            );
        }
        check(
            's20.samples.capRelation',
            CAP <= 60_000,
            'RAW_SAMPLE_EVENT_MAX_CHARS must not exceed the PDF mono cap (§20.8a-13)',
        );
    }

    if (failures > 0) {
        proc.stderr.write(
            `\ndiagEvidence consistency test: ${failures} failure(s) of ${checks} checks\n`,
        );
    } else {
        console.log(`diagEvidence consistency test: ${checks} checks OK`);
    }
    return failures;
};
