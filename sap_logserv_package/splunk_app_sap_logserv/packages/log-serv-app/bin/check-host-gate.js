#!/usr/bin/env node
/**
 * Build gate: the real SID and Host filter provider, useSearch and useHybridSearch against a
 * stand-in KV Store and search job (build 397).
 *
 * utils/hostGrain.consistency-test.ts holds the conf and the pure functions. This holds what
 * the page does with them, under jsdom: nothing runs with no filter on; a filter never meets
 * a row with no host; the check's answer is only used for a range it covers; a browser clock
 * days fast moves nothing; the page waits rather than paints, and never hangs. Run by
 * bin/check-diagnostics.js in its own process, because it installs DOM globals and a clock.
 *
 * It runs itself three times, with the browser's clock fast, slow and right, and three more with
 * a browser clock days fast and no server clock to read (an error, no network, a read that never
 * answers): serverClock.ts holds its answer for the life of the page, so a process has only one.
 */

/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const Module = require('module');
const { spawnSync } = require('child_process');

const SKEW_ARG = process.argv.indexOf('--skew-days');
if (SKEW_ARG === -1) {
    let bad = false;
    [['0'], ['10'], ['-3'], ['10', '--clock-fails', 'http'], ['10', '--clock-fails', 'network'], ['10', '--clock-fails', 'stall']].forEach(([d, ...more]) => {
        const r = spawnSync(process.execPath, [__filename, '--skew-days', d, ...more], { stdio: 'inherit' });
        if (r.status !== 0) {
            console.error(`check-host-gate: failed with the browser clock ${d} days off ${more.join(' ')}: status ${r.status}, signal ${r.signal}${r.error ? `, ${r.error.message}` : ''}`);
            bad = true;
        }
    });
    process.exit(bad ? 1 : 0);
}
const SKEW_DAYS = Number(process.argv[SKEW_ARG + 1]);
const FAILS_ARG = process.argv.indexOf('--clock-fails');
const CLOCK_FAILS = FAILS_ARG === -1 ? null : process.argv[FAILS_ARG + 1];

const HOME = path.resolve(__dirname, '../src/main/webapp/pages/home');
const NM = path.resolve(__dirname, '../../../node_modules');
const req = (id) => require(path.join(NM, id));

let ts;
let JSDOM;
try {
    ts = req('typescript');
    ({ JSDOM } = req('jsdom'));
} catch (e) {
    console.error(`check-host-gate: cannot load typescript and jsdom from ${NM}: ${e.message}`);
    process.exit(1);
}

const compile = (mod, filename) => {
    const out = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019, jsx: ts.JsxEmit.React, esModuleInterop: true },
        fileName: filename,
    }).outputText;
    mod._compile(out, filename);
};
require.extensions['.ts'] = compile;
require.extensions['.tsx'] = compile;

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost/en-US/app/splunk_app_sap_logserv/home',
    pretendToBeVisual: true,
});
global.window = dom.window;
global.document = dom.window.document;
Object.defineProperty(global, 'navigator', { value: dom.window.navigator, configurable: true });
global.HTMLElement = dom.window.HTMLElement;
global.Element = dom.window.Element;
global.Node = dom.window.Node;
global.IS_REACT_ACT_ENVIRONMENT = true;
global.localStorage = dom.window.localStorage;

// The search job stand-in.
const jobs = [];
class FakeJob {
    constructor(opts) {
        this.opts = opts;
        this.cancelled = false;
        this.sub = null;
        jobs.push(this);
    }

    getSid() {
        return { subscribe: ({ next }) => { next(`sid${jobs.length}`); return { unsubscribe() {} }; } };
    }

    getResults() {
        return { subscribe: (o) => { this.sub = o; return { unsubscribe: () => { this.sub = null; } }; } };
    }

    cancel() {
        this.cancelled = true;
    }
}
const origLoad = Module._load;
Module._load = function load(request, parent, isMain) {
    if (request === '@splunk/search-job') return { __esModule: true, default: { create: (o) => new FakeJob(o) } };
    if (request === '@splunk/splunk-utils/config') return { __esModule: true, username: 'tester' };
    return origLoad.call(this, request, parent, isMain);
};

const React = req('react');
const { createRoot } = req('react-dom/client');
const { act } = React;
const { TimeRangeProvider, useTimeRange } = require(path.join(HOME, 'state/TimeRangeProvider.tsx'));
const { SidHostFilterProvider, useQueryFilters, withQueryFilters, useSidHostFilter } = require(path.join(HOME, 'state/SidHostFilterProvider.tsx'));
const { useHybridSearch } = require(path.join(HOME, 'hooks/useHybridSearch.ts'));
const { useSearch } = require(path.join(HOME, 'hooks/useSearch.ts'));
const { isFilterPending } = require(path.join(HOME, 'utils/queryFilters.ts'));
const { HOST_GATE_METRICS, HOST_GATE_TIMEOUT_MS, HOST_GATE_TTL_MS } = require(path.join(HOME, 'utils/hostGate.ts'));
const { KV_WINDOW_MARGIN_SEC } = require(path.join(HOME, 'utils/kvWindow.ts'));
const { SERVER_CLOCK_TIMEOUT_MS } = require(path.join(HOME, 'utils/serverClock.ts'));

const METRICS = HOST_GATE_METRICS.length;
let serverMs = Date.UTC(2026, 10, 3, 15, 20, 0);
Date.now = () => serverMs + SKEW_DAYS * 86400000;
// What Splunk resolves a range against: the earlier clock is what the page may use.
const pageNowSec = () => Math.min(serverMs, serverMs + SKEW_DAYS * 86400000) / 1000;

let failures = 0;
let checks = 0;
const check = (name, ok, detail = '') => {
    checks += 1;
    if (!ok) {
        failures += 1;
        console.error(`FAIL [browser ${SKEW_DAYS} days off] ${name}${detail ? `: ${detail}` : ''}`);
    }
};

// The KV Store stand-in. `hold` keeps a read open until released or aborted.
const abortError = () => { const e = new Error('aborted'); e.name = 'AbortError'; return e; };
const kv = { log: [], rows: null, hold: null };
const clock = { held: null, reads: 0, fail: CLOCK_FAILS, signal: null };
global.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.indexOf('/services/server/info') !== -1) {
        clock.reads += 1;
        clock.signal = init.signal;
        // Ignores its signal on purpose: nothing but the time limit can end this wait.
        if (clock.fail === 'stall') await new Promise(() => {});
        if (clock.held) await clock.held;
        if (clock.fail === 'network') throw new Error('network');
        return { ok: !clock.fail, headers: { get: (h) => (h === 'Date' ? new Date(serverMs).toUTCString() : null) }, json: async () => ({}) };
    }
    if (u.indexOf('/storage/collections/data/') === -1) return { ok: true, json: async () => [] };
    const q = new URLSearchParams(u.split('?')[1]);
    const query = JSON.parse(q.get('query') || '{}');
    const info = { collection: u.split('?')[0].split('/').pop(), query, noHost: Object.prototype.hasOwnProperty.call(query, 'host'), signal: init.signal };
    kv.log.push(info);
    if (init.signal && init.signal.aborted) throw abortError();
    if (kv.hold) {
        const p = kv.hold(info);
        if (p) {
            await new Promise((resolve, reject) => {
                p.then(resolve, reject);
                if (init.signal) init.signal.addEventListener('abort', () => reject(abortError()));
            });
        }
    }
    if (init.signal && init.signal.aborted) throw abortError();
    return { ok: true, json: async () => kv.rows(info) };
};
// A healthy, rebuilt collection: no row without a host, and rows in the range.
const REBUILT = (i) => (i.noHost ? [] : [{ _key: 'k' }]);
const OLD_ROWS = (metric) => (i) => {
    if (i.query.metric === metric && i.noHost) return [{ _key: 'old' }];
    return i.noHost ? [] : [{ _key: 'k' }];
};

const RANGE = '| addinfo | where bucket_ts>=info_min_time AND bucket_ts<info_max_time';
const TREND = `| inputlookup logserv_severity_rollup where metric="trend" ${RANGE} | stats sum(count) as count`;
const TREND_RAW = '`sap_logserv_idx_macro` sourcetype="x" | stats count as count';
const TOTERR = `| inputlookup logserv_severity_rollup where metric="toterr" ${RANGE} | stats sum(count) as count`;
const TOTERR_RAW = '`sap_logserv_idx_macro` sourcetype="y" | stats count as count';

const seen = {};
let setRange = null;
let sidHost = null;
const Panel = ({ name, cached, raw }) => {
    const filters = useQueryFilters();
    const s = useHybridSearch({ cached: withQueryFilters(cached, filters), raw: withQueryFilters(raw, filters) });
    (seen[name] = seen[name] || []).push({ spl: s.spl, results: s.results, loading: s.loading, dispatched: s.dispatched });
    return null;
};
const Spark = ({ name, cached }) => {
    const filters = useQueryFilters();
    const s = useSearch({ query: withQueryFilters(cached, filters) });
    (seen[name] = seen[name] || []).push({ spl: s.spl, results: s.results, loading: s.loading, dispatched: s.dispatched });
    return null;
};
// Build 398: a query with an explicit range.
const Fixed = ({ name, query, earliest }) => {
    const s = useSearch({ query, earliest, latest: 'now' });
    (seen[name] = seen[name] || []).push({ spl: s.spl, results: s.results, loading: s.loading, dispatched: s.dispatched });
    return null;
};
const RAW_ONLY = '`sap_logserv_idx_macro` sourcetype="z0" | stats count as count';
const Ctl = () => {
    const { setTimeRange } = useTimeRange();
    setRange = setTimeRange;
    sidHost = useSidHostFilter();
    return null;
};

const flush = async (n = 8) => {
    for (let i = 0; i < n; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await act(async () => { await Promise.resolve(); await new Promise((r) => setImmediate(r)); });
    }
};
const select = (hosts) => localStorage.setItem('logserv.sidHostFilter.tester', JSON.stringify({ sid: null, hosts, scopeHosts: [], scopeSids: [] }));
const last = (n) => seen[n][seen[n].length - 1];
const reset = () => {
    serverMs += 6 * 60 * 1000; // past the answers' lifetime
    jobs.length = 0;
    kv.log.length = 0;
    kv.rows = REBUILT;
    kv.hold = null;
    Object.keys(seen).forEach((k) => delete seen[k]);
    localStorage.clear();
};
const panelJobs = () => jobs.filter((j) => j.opts.search.indexOf('logserv_sid_hosts') === -1);
const rollupJobs = () => panelJobs().filter((j) => j.opts.search.indexOf('inputlookup logserv_') !== -1);
const bound30 = () => Math.floor((pageNowSec() - 30 * 86400 - 86400 - KV_WINDOW_MARGIN_SEC) / 86400) * 86400;

const mount = async (children, initial) => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
        root.render(React.createElement(TimeRangeProvider, { initial },
            React.createElement(SidHostFilterProvider, null, React.createElement(Ctl), children)));
    });
    return root;
};

const reactErrors = [];
const realError = console.error;
console.error = (...a) => {
    const text = a.join(' ');
    if (text.indexOf('FAIL ') === 0 || text.indexOf('check-host-gate') === 0) realError(...a);
    else reactErrors.push(text.slice(0, 200));
};

(async () => {
    if (CLOCK_FAILS) {
        // ---- C: no server clock, ever, and a browser clock days fast: every reader goes without its bound
        reset();
        let r0;
        if (CLOCK_FAILS === 'stall') {
            // A read that never answers holds a filtered panel only until the time limit.
            const stallTimers = [];
            const realStall = dom.window.setTimeout;
            dom.window.setTimeout = (fn, ms) => { stallTimers.push({ fn, ms }); return stallTimers.length; };
            select(['h1']);
            r0 = await mount(React.createElement(Panel, { name: 't', cached: TREND, raw: TREND_RAW }));
            await flush();
            check('C0a the read has a time limit', stallTimers.some((t) => t.ms === SERVER_CLOCK_TIMEOUT_MS), JSON.stringify(stallTimers.map((t) => t.ms)));
            check('C0e a short one: panels wait on it', SERVER_CLOCK_TIMEOUT_MS <= 10000, String(SERVER_CLOCK_TIMEOUT_MS));
            check('C0b before it: the panel waits, and no KV read', isFilterPending(last('t').spl) && last('t').loading === true && kv.log.length === 0);
            await act(async () => { stallTimers.filter((t) => t.ms === SERVER_CLOCK_TIMEOUT_MS).forEach((t) => t.fn()); });
            dom.window.setTimeout = realStall;
            await flush();
            check('C0c after it: the check runs and the panel goes on', kv.log.length === METRICS * 2 && rollupJobs().length === 1, `${kv.log.length} ${rollupJobs().length}`);
            check('C0d the read is aborted', !!clock.signal && clock.signal.aborted === true);
            await act(async () => r0.unmount());
            reset();
        }
        r0 = await mount(React.createElement(Panel, { name: 't', cached: TREND, raw: TREND_RAW }));
        await flush();
        check('C1 no filter: the job runs, with no bound', panelJobs().length === 1 && panelJobs()[0].opts.search.indexOf('AND bucket_ts>=') === -1,
            panelJobs()[0] && panelJobs()[0].opts.search.slice(0, 120));
        await act(async () => r0.unmount());
        reset();
        select(['h1']);
        r0 = await mount(React.createElement(Panel, { name: 't', cached: TREND, raw: TREND_RAW }));
        await flush();
        check('C2 a filter on: the check runs, over the whole metric', kv.log.length === METRICS * 2 && kv.log.every((i) => !i.query.bucket_ts), String(kv.log.length));
        check('C3 a filter on: the job has the host term and no bound', rollupJobs().length === 1 && rollupJobs()[0].opts.search.indexOf('search host="h1"') !== -1 && rollupJobs()[0].opts.search.indexOf('AND bucket_ts>=') === -1,
            rollupJobs()[0] && rollupJobs()[0].opts.search.slice(0, 160));
        check('C4 the clock was read once', clock.reads === 1, String(clock.reads));
        await act(async () => r0.unmount());
        const noisyC = reactErrors.filter((e) => !/ReactDOM.render|deprecated/.test(e));
        check('C5 no React errors or warnings', noisyC.length === 0, noisyC.slice(0, 3).join(' || '));
        console.error = realError;
        if (failures > 0) {
            console.error(`check-host-gate: ${failures} of ${checks} failed, clock read failing by ${CLOCK_FAILS}`);
            process.exit(1);
        }
        console.log(`check-host-gate: OK (${checks} checks, clock read failing by ${CLOCK_FAILS}, browser clock ${SKEW_DAYS} days off: no bound anywhere)`);
        process.exit(0);
    }

    // ---- H0: no filter, before the server's clock has answered (build 398, the 397 audit's M5): a
    // read that takes the bound waits for it; anything else runs at once and is not run again.
    // Its page stays open through H1, which answers the clock.
    reset();
    let releaseClock = null;
    clock.held = new Promise((r) => { releaseClock = r; });
    const FIXED_START = Math.floor(pageNowSec()) - 7 * 86400;
    const FIXED_BOUND = Math.floor((FIXED_START - KV_WINDOW_MARGIN_SEC) / 86400) * 86400;
    const root0 = await mount(React.createElement(React.Fragment, null,
        React.createElement(Spark, { name: 't0', cached: TREND }),
        React.createElement(Spark, { name: 'r0', cached: RAW_ONLY }),
        React.createElement(Fixed, { name: 'f0', query: TREND, earliest: String(FIXED_START) })));
    await flush();
    const relJobs = () => jobs.filter((j) => j.opts.earliest_time === '-30d@d' && j.opts.search.indexOf('metric="trend"') !== -1 && j.opts.search.indexOf('search host') === -1);
    const ranBefore = () => jobs.filter((j) => j.opts.search.indexOf('sourcetype="z0"') !== -1 || j.opts.earliest_time === String(FIXED_START));
    check('H0a no clock yet: a read that takes the bound waits, loading, no rows', relJobs().length === 0 && last('t0').loading === true && last('t0').results === null,
        relJobs().map((j) => j.opts.search.slice(0, 80)).join(' ; '));
    check('H0b no clock yet: a raw search runs at once', jobs.filter((j) => j.opts.search.indexOf('sourcetype="z0"') !== -1).length === 1,
        jobs.map((j) => j.opts.search.slice(0, 60)).join(' ; '));
    check('H0c no clock yet: an absolute range runs at once, with its bound',
        jobs.filter((j) => j.opts.earliest_time === String(FIXED_START) && j.opts.search.indexOf(`AND bucket_ts>=${FIXED_BOUND} | addinfo`) !== -1).length === 1,
        jobs.map((j) => `${j.opts.earliest_time}: ${j.opts.search.slice(0, 90)}`).join(' ; '));

    // ---- H1: before the server's clock has answered
    reset();
    select(['h1']);
    let root = await mount(React.createElement(Panel, { name: 't', cached: TREND, raw: TREND_RAW }));
    await flush();
    check('H1a the clock is read once', clock.reads === 1, String(clock.reads));
    check('H1b filter on, no clock yet: no KV read', kv.log.length === 0, String(kv.log.length));
    check('H1c filter on, no clock yet: the panel waits', isFilterPending(last('t').spl) && last('t').loading === true);
    check('H1d filter on, no clock yet: no job', rollupJobs().length === 0);
    await act(async () => { clock.held = null; releaseClock(); });
    await flush();
    check('H1e once it answers: the check runs', kv.log.length === METRICS * 2, String(kv.log.length));
    check('H1f on the server\'s clock, whatever the browser says', kv.log[0] && kv.log[0].query.bucket_ts && kv.log[0].query.bucket_ts.$gte === bound30(),
        `${kv.log[0] && JSON.stringify(kv.log[0].query)} vs ${bound30()}`);
    check('H0d once it answers: the read that waited runs once, with the bound',
        relJobs().length === 1 && relJobs()[0].opts.search.indexOf(`AND bucket_ts>=${bound30()} | addinfo`) !== -1,
        relJobs().map((j) => j.opts.search.slice(0, 120)).join(' ; '));
    check('H0e once it answers: what ran before is not run again', ranBefore().length === 0,
        ranBefore().map((j) => j.opts.search.slice(0, 80)).join(' ; '));
    await act(async () => root.unmount());
    await act(async () => root0.unmount());

    // ---- H2: no filter
    reset();
    root = await mount(React.createElement(Panel, { name: 't', cached: TREND, raw: TREND_RAW }));
    await flush();
    check('H2a no filter: no KV read', kv.log.length === 0, String(kv.log.length));
    check('H2b no filter: the job carries the bound', panelJobs().length === 1 && panelJobs()[0].opts.search.indexOf(`AND bucket_ts>=${bound30()} | addinfo`) !== -1,
        panelJobs()[0] && panelJobs()[0].opts.search.slice(0, 120));
    check('H2c no filter: the panel keeps the query as written', last('t').spl === TREND);
    await act(async () => root.unmount());

    // ---- H3: a filter on, the check held open
    reset();
    select(['h1', 'h2']);
    const waiters = [];
    kv.hold = () => new Promise((r) => { waiters.push(r); });
    root = await mount(React.createElement(React.Fragment, null,
        React.createElement(Panel, { name: 't', cached: TREND, raw: TREND_RAW }),
        React.createElement(Panel, { name: 'e', cached: TOTERR, raw: TOTERR_RAW }),
        React.createElement(Spark, { name: 's', cached: TREND })));
    await flush();
    check('H3a one read per metric first', kv.log.length === METRICS && kv.log.every((i) => i.noHost), String(kv.log.length));
    check('H3b waiting: the marker, loading, no rows', isFilterPending(last('t').spl) && last('t').loading === true && last('t').results === null);
    check('H3c waiting: only the panel with no check dispatched', rollupJobs().length === 1 && rollupJobs()[0].opts.search.indexOf('metric="toterr"') !== -1,
        rollupJobs().map((j) => j.opts.search.slice(0, 60)).join(' ; '));
    kv.hold = null;
    await act(async () => { waiters.splice(0).forEach((r) => r()); });
    await flush();
    const trendJobs = rollupJobs().filter((j) => j.opts.search.indexOf('metric="trend"') !== -1);
    check('H3d ready: the panel and the sparkline each dispatch once', trendJobs.length === 2, String(trendJobs.length));
    check('H3e ready: the bound and the host term',
        !!trendJobs[0] && trendJobs[0].opts.search.indexOf(`AND bucket_ts>=${bound30()} ${RANGE} | search (host="h1" OR host="h2")`) !== -1, trendJobs[0] && trendJobs[0].opts.search.slice(0, 180));
    check('H3f ready: the panel with no check did not run again', rollupJobs().filter((j) => j.opts.search.indexOf('metric="toterr"') !== -1).length === 1);
    await act(async () => root.unmount());

    // ---- H4: a row with no host in the range
    reset();
    select(['h1']);
    kv.rows = OLD_ROWS('trend');
    root = await mount(React.createElement(React.Fragment, null,
        React.createElement(Panel, { name: 't', cached: TREND, raw: TREND_RAW }),
        React.createElement(Spark, { name: 's', cached: TREND })));
    await flush();
    check('H4a old: the raw arm, filtered', panelJobs().length === 1 && panelJobs()[0].opts.search.indexOf('sourcetype="x"') !== -1 && panelJobs()[0].opts.search.indexOf('host="h1"') !== -1,
        panelJobs().map((j) => j.opts.search.slice(0, 70)).join(' ; '));
    check('H4b old: no rollup read', rollupJobs().length === 0);
    check('H4c old: the sparkline runs nothing', !!last('s').results && last('s').results.length === 0 && last('s').dispatched === false);
    await act(async () => root.unmount());

    // ---- H5: KV Store warming up: empty answers to both reads
    reset();
    select(['h1']);
    kv.rows = () => [];
    root = await mount(React.createElement(Panel, { name: 't', cached: TREND, raw: TREND_RAW }));
    await flush();
    check('H5a an empty answer is not ready: the raw arm', panelJobs().length === 1 && panelJobs()[0].opts.search.indexOf('sourcetype="x"') !== -1,
        panelJobs().map((j) => j.opts.search.slice(0, 70)).join(' ; '));
    await act(async () => root.unmount());

    // ---- H7: it is read again, so neither a warm-up's answer nor a rebuild's stands forever
    reset();
    select(['h1']);
    kv.rows = OLD_ROWS('trend');
    const intervals = [];
    const cleared = [];
    const realSetInterval = dom.window.setInterval;
    const realClearInterval = dom.window.clearInterval;
    dom.window.setInterval = (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; };
    dom.window.clearInterval = (id) => { cleared.push(id); };
    root = await mount(React.createElement(Panel, { name: 't', cached: TREND, raw: TREND_RAW }));
    await flush();
    check('H7a old at first: the raw arm', panelJobs().length === 1 && panelJobs()[0].opts.search.indexOf('sourcetype="x"') !== -1);
    const tick = intervals.find((t) => t.ms === HOST_GATE_TTL_MS);
    check('H7b a re-read is scheduled', !!tick, JSON.stringify(intervals.map((t) => t.ms)));
    const n7 = kv.log.length;
    kv.rows = REBUILT; // a Clear then Backfill ran in another tab
    // The tick alone reads again: the first answer is younger than its lifetime here.
    if (tick) await act(async () => { tick.fn(); });
    await flush();
    check('H7c it reads again', kv.log.length > n7, String(kv.log.length - n7));
    check('H7d no panel went back to waiting', !seen.t.slice(-4).some((f) => isFilterPending(f.spl)));
    check('H7e the panel moves to the rollup', rollupJobs().length === 1 && rollupJobs()[0].opts.search.indexOf('search host="h1"') !== -1,
        rollupJobs().map((j) => j.opts.search.slice(0, 80)).join(' ; '));
    await act(async () => root.unmount());
    check('H7f the timer stops with the page', cleared.indexOf(intervals.indexOf(tick) + 1) !== -1, JSON.stringify(cleared));
    dom.window.setInterval = realSetInterval;
    dom.window.clearInterval = realClearInterval;

    // ---- H8: a check that never answers
    reset();
    select(['h1']);
    const timers = [];
    const realST = dom.window.setTimeout;
    dom.window.setTimeout = (fn, ms) => { timers.push({ fn, ms }); return timers.length; };
    kv.hold = () => new Promise(() => {});
    root = await mount(React.createElement(Panel, { name: 't', cached: TREND, raw: TREND_RAW }));
    await flush();
    check('H8a a time limit is set', timers.some((t) => t.ms === HOST_GATE_TIMEOUT_MS));
    check('H8b still waiting before it', isFilterPending(last('t').spl) && last('t').loading === true);
    await act(async () => { timers.filter((t) => t.ms === HOST_GATE_TIMEOUT_MS).forEach((t) => t.fn()); });
    await flush();
    check('H8c after it: the raw arm, not a hang', panelJobs().length === 1 && panelJobs()[0].opts.search.indexOf('sourcetype="x"') !== -1,
        panelJobs().map((j) => j.opts.search.slice(0, 60)).join(' ; '));
    dom.window.setTimeout = realST;
    await act(async () => root.unmount());

    // ---- H9: a wider range while the check runs
    reset();
    select(['h1']);
    const w9 = [];
    kv.hold = () => new Promise((r) => { w9.push(r); });
    root = await mount(React.createElement(Panel, { name: 't', cached: TREND, raw: TREND_RAW }));
    await flush();
    const first = kv.log.slice();
    await act(async () => { setRange({ earliest: '-90d@d', latest: 'now' }); });
    await flush();
    check('H9a the running reads are aborted', first.length > 0 && first.every((i) => i.signal.aborted));
    check('H9b new reads, with the new bound', kv.log.length === 2 * METRICS && kv.log[METRICS].query.bucket_ts.$gte < first[0].query.bucket_ts.$gte, String(kv.log.length));
    check('H9c still waiting', isFilterPending(last('t').spl));
    kv.hold = null;
    await act(async () => { w9.splice(0).forEach((r) => r()); });
    await flush();
    check('H9d one job, over the new range', rollupJobs().length === 1 && rollupJobs()[0].opts.earliest_time === '-90d@d', rollupJobs().map((j) => j.opts.earliest_time).join(','));
    // A shorter range: the answer covers it, so no panel clears and waits.
    Object.keys(seen).forEach((k) => delete seen[k]);
    await act(async () => { setRange({ earliest: '-7d@h', latest: 'now' }); });
    await flush();
    check('H9e a shorter range does not wait', !seen.t.some((f) => isFilterPending(f.spl)));
    // A wider one again than ever read: it does.
    Object.keys(seen).forEach((k) => delete seen[k]);
    kv.hold = () => new Promise(() => {});
    await act(async () => { setRange({ earliest: '-180d@d', latest: 'now' }); });
    await flush();
    check('H9f a range wider than the answer waits', seen.t.some((f) => isFilterPending(f.spl)));
    check('H9g waiting never shows old rows as settled', !seen.t.some((f) => isFilterPending(f.spl) && f.results && f.results.length > 0 && !f.loading));
    kv.hold = null;
    await act(async () => root.unmount());

    // ---- H15: reads cut short by a move to a shorter range say nothing, though their bound covers it
    reset();
    select(['h1']);
    kv.hold = () => new Promise(() => {});
    root = await mount(React.createElement(Panel, { name: 't', cached: TREND, raw: TREND_RAW }), { earliest: '-90d@d', latest: 'now' });
    await flush();
    await act(async () => { setRange({ earliest: '-7d@h', latest: 'now' }); });
    await flush();
    check('H15a still waiting, on the new reads', isFilterPending(last('t').spl) && kv.log.length === 2 * METRICS, String(kv.log.length));
    check('H15b no job from an answer nobody gave', panelJobs().length === 0, panelJobs().map((j) => j.opts.search.slice(0, 60)).join(' ; '));
    kv.hold = null;
    await act(async () => root.unmount());

    // ---- H10: UTC midnight: the bound moves on, and nothing clears
    reset();
    select(['h1']);
    root = await mount(React.createElement(Panel, { name: 't', cached: TREND, raw: TREND_RAW }));
    await flush();
    const n10 = rollupJobs().length;
    await act(async () => { rollupJobs()[0].sub.next({ results: [{ count: '5' }] }); });
    Object.keys(seen).forEach((k) => delete seen[k]);
    serverMs += 24 * 3600 * 1000;
    await act(async () => { sidHost.setHosts(['h1']); });
    await flush();
    check('H10a a later bound does not go back to waiting', !seen.t.some((f) => isFilterPending(f.spl)));
    check('H10b the job is not run again', rollupJobs().length === n10, String(rollupJobs().length - n10));
    check('H10c the rows stay', !!last('t').results && last('t').results.length === 1);
    await act(async () => root.unmount());

    // ---- H11: leaving the page
    reset();
    select(['h1']);
    kv.hold = () => new Promise(() => {});
    root = await mount(React.createElement(Panel, { name: 't', cached: TREND, raw: TREND_RAW }));
    await flush();
    await act(async () => root.unmount());
    check('H11a the reads are aborted', kv.log.length > 0 && kv.log.every((i) => i.signal.aborted));

    // ---- H12: a short range does not wait for the check
    reset();
    select(['h1']);
    kv.hold = () => new Promise(() => {});
    root = await mount(React.createElement(Panel, { name: 't', cached: TREND, raw: TREND_RAW }), { earliest: '-15m', latest: 'now' });
    await flush();
    check('H12a the raw arm at once', panelJobs().length === 1 && panelJobs()[0].opts.search.indexOf('sourcetype="x"') !== -1, panelJobs().map((j) => j.opts.search.slice(0, 60)).join(' ; '));
    await act(async () => root.unmount());

    // ---- H13: all time: no bound, the check covers the whole metric
    reset();
    select(['h1']);
    root = await mount(React.createElement(Panel, { name: 't', cached: TREND, raw: TREND_RAW }), { earliest: '0', latest: 'now' });
    await flush();
    check('H13a no bound on the check', kv.log.length > 0 && kv.log.every((i) => !i.query.bucket_ts), kv.log[0] && JSON.stringify(kv.log[0].query));
    check('H13b no bound on the job', rollupJobs().length === 1 && rollupJobs()[0].opts.search.indexOf('AND bucket_ts>=') === -1);
    await act(async () => root.unmount());

    const noisy = reactErrors.filter((e) => !/ReactDOM.render|deprecated/.test(e));
    check('H14 no React errors or warnings', noisy.length === 0, noisy.slice(0, 3).join(' || '));

    console.error = realError;
    if (failures > 0) {
        console.error(`check-host-gate: ${failures} of ${checks} failed, browser clock ${SKEW_DAYS} days off`);
        process.exit(1);
    }
    console.log(`check-host-gate: OK (${checks} checks, browser clock ${SKEW_DAYS} days off: the real provider and hooks; no read with no filter, no filter on a row with no host, no hang)`);
    process.exit(0);
})().catch((e) => {
    console.error = realError;
    console.error(e);
    process.exit(1);
});
