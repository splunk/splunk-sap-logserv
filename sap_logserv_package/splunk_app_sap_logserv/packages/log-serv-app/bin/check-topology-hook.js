#!/usr/bin/env node
/**
 * Build gate: the real Environment Topology hook against a stand-in KV Store (build 396).
 *
 * utils/kvPagedRead.consistency-test.ts holds the read. This holds what the hook does with
 * it, by running hooks/useTopologyData.ts under jsdom: every row past the 50,000-row cap,
 * the row sequence its first-row consumers depend on, the inventory, the cut at the read
 * limit across both collections, the staleness rule, loading and errors through a
 * Refresh, a time-range change, an abort and a failed page, and that the aggregation does
 * not run again when only the loading state flips. Run by bin/check-diagnostics.js in its
 * own process, because it installs DOM globals and a clock the other suites should not see.
 *
 * The stand-in behaves as the live KV Store was measured to (2026-11-03): index order
 * (bucket_ts ascending, then insertion) with no sort, its exact reverse with
 * sort=bucket_ts:-1, a silent row cap, [] past the end.
 */

/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');

const HOME = path.resolve(__dirname, '../src/main/webapp/pages/home');
const NM = path.resolve(__dirname, '../../../node_modules');
const req = (id) => require(path.join(NM, id));

let ts;
let JSDOM;
try {
    ts = req('typescript');
    ({ JSDOM } = req('jsdom'));
} catch (e) {
    console.error(`check-topology-hook: cannot load typescript and jsdom from ${NM}: ${e.message}`);
    console.error('  (expected the workspace-root node_modules - run `yarn install --frozen-lockfile --ignore-engines`)');
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

const React = req('react');
const { createRoot } = req('react-dom/client');
const { act } = React;
const { TimeRangeProvider } = require(path.join(HOME, 'state/TimeRangeProvider.tsx'));
const { TOPOLOGY_READ_MAX_ROWS, useTopologyData } = require(path.join(HOME, 'hooks/useTopologyData.ts'));
const { edgeActivitySeries } = require(path.join(HOME, 'topology/types.ts'));

const NOW = 1790000000 - (1790000000 % 3600) + 1234; // 20m34s past an hour
const END = NOW - (NOW % 3600); // the newest whole hour
const HOUR = 3600;
Date.now = () => NOW * 1000;

let failures = 0;
let checks = 0;
const check = (name, ok, detail = '') => {
    checks += 1;
    if (!ok) {
        failures += 1;
        console.error(`check-topology-hook FAIL ${name}${detail ? `: ${detail}` : ''}`);
    }
};

const abortError = () => {
    const e = new Error('The operation was aborted');
    e.name = 'AbortError';
    return e;
};

/** The KV Store: `collections` rows in insertion order. */
const makeKv = (collections, cap = 50000) => {
    const state = { log: [], hold: null, failOn: null };
    state.fetch = async (url, init = {}) => {
        const [base, q] = url.split('?');
        const name = base.split('/').pop();
        const qs = new URLSearchParams(q);
        const info = { name, limit: Number(qs.get('limit')), skip: Number(qs.get('skip') || 0), sort: qs.get('sort') };
        state.log.push(info);
        if (init.signal && init.signal.aborted) throw abortError();
        if (state.hold) {
            const p = state.hold(info);
            if (p) {
                await new Promise((resolve, reject) => {
                    p.then(resolve, reject);
                    if (init.signal) init.signal.addEventListener('abort', () => reject(abortError()));
                });
            }
        }
        if (init.signal && init.signal.aborted) throw abortError();
        if (state.failOn && state.failOn(info)) {
            return { ok: false, status: 503, statusText: 'Service Unavailable', json: async () => ({}) };
        }
        let rows = collections[name] || [];
        const query = qs.get('query');
        if (query) {
            const { $gte, $lte } = JSON.parse(query).bucket_ts;
            rows = rows.map((r, i) => ({ r, i }))
                .sort((a, b) => (a.r.bucket_ts - b.r.bucket_ts) || (a.i - b.i))
                .map((x) => x.r)
                .filter((r) => r.bucket_ts >= $gte && r.bucket_ts <= $lte);
            if (info.sort === 'bucket_ts:-1') rows = rows.slice().reverse();
        }
        const size = info.limit === 0 ? cap : Math.min(info.limit, cap);
        const page = rows.slice(info.skip, info.skip + size);
        return { ok: true, status: 200, statusText: 'OK', json: async () => page };
    };
    global.fetch = state.fetch;
    return state;
};

const clause = (field, value) => ({ field, value });
const nodeRow = (key, id, value, ts, extra = {}) => ({
    _key: key,
    id,
    canonical_kind: 'sid',
    canonical_value: value,
    bucket_ts: ts,
    kind: 'sid_secondary',
    tag: 'ABAP',
    label: value,
    event_count: 10,
    last_seen: ts + 60,
    ...extra,
});
const edgeRow = (key, id, src, dst, ts, calls, extra = {}) => ({
    _key: key,
    id,
    source_id: src,
    target_id: dst,
    type: 'rfc',
    direction: 'client',
    bucket_ts: ts,
    call_count: calls,
    error_count: 1,
    spl_sourcetype: 'sap:abap:gateway',
    spl_filter_clauses: JSON.stringify([clause('sap_sid', src.toUpperCase()), clause('sap_sid', dst.toUpperCase())]),
    ...extra,
});

/** `hours` buckets ending at `end`, `perHour` edge rows each, between systems a..., plus their node rows. */
const world = ({ hours, perHour, end = END }) => {
    const nodes = [];
    const edges = [];
    for (let h = 0; h < hours; h += 1) {
        const ts = end - h * HOUR;
        for (let i = 0; i < perHour; i += 1) {
            const src = `aaa${i % 7}`;
            const dst = `bbb${i}`;
            edges.push(edgeRow(`e${h}:${i}`, `id${i}`, src, dst, ts, 2));
            nodes.push(nodeRow(`n${h}:${i}`, src, src.toUpperCase(), ts));
        }
    }
    return { nodes, edges };
};

const kvOf = (w, extra = {}, cap) => makeKv({
    logserv_topology_nodes: w.nodes,
    logserv_topology_edges: w.edges,
    logserv_topology_inventory: extra.inventory || [],
}, cap);

/** Mount the hook. `result.current` is its latest return; `seen` holds each distinct return. */
const mount = (range, nonce = 0, maxRows) => {
    const holder = { current: null, renders: [] };
    const props = { nonce, maxRows };
    let setProps;
    const Probe = () => {
        const [p, set] = React.useState(props);
        setProps = set;
        const r = useTopologyData(p.nonce, p.maxRows);
        holder.current = r;
        holder.renders.push(r);
        return null;
    };
    const el = document.createElement('div');
    const root = createRoot(el);
    const render = (r) => React.createElement(TimeRangeProvider, { initial: r }, React.createElement(Probe));
    act(() => { root.render(render(range)); });
    holder.setNonce = (n) => act(() => { setProps((p) => ({ ...p, nonce: n })); });
    holder.unmount = () => act(() => { root.unmount(); });
    return holder;
};

const settle = async (holder, want = () => true) => {
    for (let i = 0; i < 4000; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await act(async () => { await new Promise((r) => setImmediate(r)); });
        if (!holder.current.loading && want(holder.current)) return holder.current;
    }
    throw new Error('the hook never finished loading');
};

const range = (earliest, latest = 'now') => ({ earliest: String(earliest), latest: String(latest) });
const callsOf = (r) => r.edges.reduce((s, e) => s + e.callCount, 0);
const eventsOf = (r) => r.nodes.reduce((s, n) => s + n.eventCount, 0);

const main = async () => {
    check('H0 the limit is the documented one', TOPOLOGY_READ_MAX_ROWS === 500000, String(TOPOLOGY_READ_MAX_ROWS));

    // --- H1: every row past the 50,000-row cap ---
    {
        const w = world({ hours: 120, perHour: 500 }); // 60,000 of each
        const kv = kvOf(w);
        const h = mount(range(END - 200 * HOUR));
        const r = await settle(h);
        check('H1a every edge row past the cap', callsOf(r) === 60000 * 2, String(callsOf(r)));
        check('H1b every node row of a referenced node', eventsOf(r) === 60000 * 10, String(eventsOf(r)));
        check('H1c complete: no start named, no error, not loading', r.completeFromTs === null && r.errors.length === 0 && r.loading === false);
        check('H1d no limit=0 sent', kv.log.every((c) => c.limit > 0));
        check('H1e newest first', kv.log.filter((c) => c.name !== 'logserv_topology_inventory').every((c) => c.sort === 'bucket_ts:-1'));
        check('H1f fresh data is not stale', r.staleness && r.staleness.isStale === false, JSON.stringify(r.staleness));
        h.unmount();
    }

    // --- H2: the row sequence first-row consumers depend on ---
    {
        const oldest = END - 3 * HOUR;
        const w = {
            nodes: [
                nodeRow('n3', 'aaa', 'AAA', END, { label: 'newest-label' }),
                nodeRow('n1', 'aaa', 'AAA', oldest, { label: 'oldest-label' }),
                nodeRow('n2', 'aaa', 'AAA', END - HOUR, { label: 'middle-label' }),
                nodeRow('m1', 'bbb', 'BBB', END),
            ],
            edges: [
                edgeRow('e3', 'id1', 'aaa', 'bbb', END, 5, { direction: 'server' }),
                edgeRow('e1', 'id1', 'aaa', 'bbb', oldest, 3, { direction: 'client' }),
                edgeRow('e2', 'id1', 'aaa', 'bbb', END - HOUR, 4, { direction: 'bidi' }),
            ],
        };
        kvOf(w);
        const h = mount(range(END - 10 * HOUR));
        const r = await settle(h);
        const node = r.nodes.find((n) => n.id === 'aaa');
        check('H2a a node takes its label from the oldest bucket, as with no sort', node && node.label === 'oldest-label', node && node.label);
        check('H2b an edge takes its direction from the oldest bucket, as with no sort', r.edges[0].direction === 'client', r.edges[0].direction);
        check('H2c sums cross buckets', r.edges[0].callCount === 12 && node.eventCount === 30, `${r.edges[0].callCount} ${node.eventCount}`);
        // The activity series: sparse on the edge, zero-filled on demand, summing to callCount.
        const buckets = r.edges[0].activity.buckets;
        const series = edgeActivitySeries(r.edges[0].activity);
        check('H2d the series spans every bucket any edge spans, oldest first', buckets.length === 3 && buckets[0] === oldest && series[2].time === END);
        check('H2e the series sums to the headline', series.reduce((s, p) => s + p.count, 0) === r.edges[0].callCount);
        h.unmount();
    }
    {
        // Two edges in different hours: each series is zero-filled over both, and each edge holds only its own hour.
        const w = {
            nodes: [],
            edges: [edgeRow('a', 'id1', 'aaa', 'bbb', END, 7), edgeRow('b', 'id2', 'ccc', 'ddd', END - 2 * HOUR, 9)],
        };
        kvOf(w);
        const h = mount(range(END - 10 * HOUR));
        const r = await settle(h);
        const a = r.edges.find((e) => e.callCount === 7);
        const s = edgeActivitySeries(a.activity);
        check('H2f an edge stores only the hours it has rows in', a.activity.byBucket.size === 1, String(a.activity.byBucket.size));
        check('H2g the buckets array is one array, shared by every edge', r.edges[0].activity.buckets === r.edges[1].activity.buckets);
        check('H2h its series is zero-filled over every edge\'s buckets',
            s.length === 2 && s[0].time === END - 2 * HOUR && s[0].count === 0 && s[0].errorCount === 0 && s[1].count === 7 && s[1].errorCount === 1, JSON.stringify(s));
        h.unmount();
    }

    {
        // Two rows of one edge in one hour add up, for the headline and the series alike.
        kvOf({
            nodes: [],
            edges: [edgeRow('a', 'id1', 'aaa', 'bbb', END, 7), edgeRow('b', 'id1', 'aaa', 'bbb', END, 5, { error_count: 3 })],
        });
        const h = mount(range(END - 10 * HOUR));
        const r = await settle(h);
        const s = edgeActivitySeries(r.edges[0].activity);
        check('H2i two rows of one edge in one hour add up', r.edges[0].callCount === 12 && s.length === 1 && s[0].count === 12 && s[0].errorCount === 4, JSON.stringify(s));
        h.unmount();
    }

    // --- H3: the inventory reaches the aggregation ---
    {
        const w = {
            nodes: [nodeRow('n1', 'sidx', 'XCP', END), nodeRow('n2', 'ipx', '10.0.0.1', END, { canonical_kind: 'ip', kind: 'partner', tag: 'EXT' })],
            edges: [edgeRow('e1', 'id1', 'ipx', 'zzz', END, 3, { spl_filter_clauses: JSON.stringify([clause('peer_ip', '10.0.0.1'), clause('peer_ip', '10.0.0.9')]) })],
        };
        kvOf(w, { inventory: [{ _key: 'i1', canonical_value: '10.0.0.1', canonical_kind: 'ip', resolved_sid: 'XCP', updated_at: END }] });
        const h = mount(range(END - 10 * HOUR));
        const r = await settle(h);
        check('H3a an inventory row retargets an endpoint to its system', r.edges[0].source === 'sidx', r.edges[0].source);
        check('H3b and names its owner', r.inventoryOwnerByValue['10.0.0.1'] === 'XCP');
        h.unmount();
    }

    // --- H4: the cut at the read limit ---
    {
        // Edges stopped, nodes complete: 50 node rows, 5 a bucket, reaching 10 buckets back.
        const w = world({ hours: 20, perHour: 10 }); // 200 of each; newest bucket END
        const edgesOnly = { nodes: w.nodes.filter((_, i) => i % 2 === 0).slice(0, 50), edges: w.edges };
        kvOf(edgesOnly);
        const h = mount(range(END - 40 * HOUR), 0, 55);
        const r = await settle(h);
        // 55 newest rows: 5 whole buckets and part of a sixth, which is dropped.
        const start = END - 4 * HOUR;
        check('H4a the start is the oldest whole bucket read', r.completeFromTs === start, String(r.completeFromTs));
        check('H4b calls are exact from that start', callsOf(r) === 5 * 10 * 2, String(callsOf(r)));
        check('H4c node rows before the start are cut too (their own read was complete)',
            eventsOf(r) === 5 * 5 * 10, String(eventsOf(r)));
        check('H4d the read keeps the newest rows, so freshness is right', r.staleness.lastBucketTs === END && r.staleness.isStale === false, JSON.stringify(r.staleness));
        h.unmount();
    }
    {
        // Both stopped at different starts: from the later one on, both are complete.
        const w = world({ hours: 20, perHour: 10 });
        const fewerNodes = { nodes: w.nodes.filter((_, i) => i % 2 === 0), edges: w.edges }; // nodes 5 a bucket, edges 10
        kvOf(fewerNodes);
        const h = mount(range(END - 40 * HOUR), 0, 60);
        const r = await settle(h);
        // Edges: 60 rows is exactly 6 buckets, and the sixth is dropped because the read cannot tell it is whole.
        check('H4e both collections are cut at the later start', r.completeFromTs === END - 4 * HOUR, String(r.completeFromTs));
        check('H4f edge sum from the start', callsOf(r) === 5 * 10 * 2, String(callsOf(r)));
        check('H4g node sum from the start', eventsOf(r) === 5 * 5 * 10, String(eventsOf(r)));
        h.unmount();
    }

    {
        // Nodes stopped later than edges: the edges are cut at the nodes' start too.
        const w = world({ hours: 20, perHour: 10 });
        const fewerEdges = { nodes: w.nodes, edges: w.edges.filter((_, i) => i % 2 === 0) }; // edges 5 a bucket, nodes 10
        kvOf(fewerEdges);
        const h = mount(range(END - 40 * HOUR), 0, 55);
        const r = await settle(h);
        const start = END - 4 * HOUR; // nodes: 5 whole buckets and part of a sixth; edges reach 11 buckets back
        const kept = fewerEdges.edges.filter((e) => e.bucket_ts >= start);
        const ids = new Set(kept.map((e) => e.source_id));
        const nodeEvents = w.nodes.filter((n) => n.bucket_ts >= start && ids.has(n.id)).length * 10;
        check('H4h the start is the nodes\' when theirs is the later', r.completeFromTs === start, String(r.completeFromTs));
        check('H4i edge rows before it are cut', callsOf(r) === kept.length * 2, `${callsOf(r)} vs ${kept.length * 2}`);
        check('H4j node sum from the start', eventsOf(r) === nodeEvents, `${eventsOf(r)} vs ${nodeEvents}`);
        h.unmount();
    }

    {
        // Nodes stopped, edges complete, the likeliest case in the field: nodes hold more rows than edges.
        const w = world({ hours: 20, perHour: 10 });
        kvOf({ nodes: w.nodes, edges: w.edges.filter((_, i) => i % 2 === 0).slice(0, 50) });
        const h = mount(range(END - 40 * HOUR), 0, 55);
        const r = await settle(h);
        check('H4k nodes stopped, edges complete: the start is the nodes\'', r.completeFromTs === END - 4 * HOUR, String(r.completeFromTs));
        check('H4l edge rows before it are cut, though their own read was complete', callsOf(r) === 5 * 5 * 2, String(callsOf(r)));
        h.unmount();
    }

    // --- H5: staleness ---
    const staleOf = async (newestAgeHours, latest) => {
        const newest = END - newestAgeHours * HOUR;
        kvOf({ nodes: [], edges: [edgeRow('e', 'id', 'aaa', 'bbb', newest, 1)] });
        const h = mount(range(newest - 5 * HOUR, latest));
        const r = await settle(h);
        h.unmount();
        return r.staleness.isStale;
    };
    check('H5a newest row 5 h old at now: not stale', (await staleOf(5, 'now')) === false);
    check('H5b newest row 7 h old at now: stale', (await staleOf(7, 'now')) === true);
    check('H5c a window that ended 3 days ago: not stale', (await staleOf(72, String(END - 72 * HOUR))) === false);
    check('H5d a window that ended 7 h ago, rows to its end: not stale', (await staleOf(7, String(END - 7 * HOUR))) === false);
    check('H5e a window that ended under 6 h ago, rows to its end: not stale',
        (await staleOf(6, String(NOW - 5 * HOUR - 45 * 60))) === false);
    check('H5f the same window, rows stopping 7 h before its end: stale',
        (await staleOf(13, String(NOW - 5 * HOUR - 45 * 60))) === true);
    check('H5g a window that ended 3 days ago, rows stopping 10 h before its end: not stale, it says nothing about today',
        (await staleOf(82, String(END - 72 * HOUR))) === false);
    check('H5h a window ending in the future is measured from now: newest row 5 h old, not stale',
        (await staleOf(5, String(NOW + 3 * HOUR))) === false);

    // --- H6: loading, Refresh, and what re-runs the aggregation ---
    {
        const w = world({ hours: 3, perHour: 4 });
        const kv = kvOf(w);
        const h = mount(range(END - 10 * HOUR));
        check('H6a loading while the first read runs', h.current.loading === true);
        const first = await settle(h);
        check('H6b loading ends', first.loading === false);
        const releases = [];
        kv.hold = () => new Promise((r) => { releases.push(r); });
        h.setNonce(1);
        await act(async () => { await new Promise((r) => setImmediate(r)); });
        check('H6c a Refresh shows loading', h.current.loading === true);
        check('H6d the flip keeps the node and edge arrays: no re-layout, no second aggregation',
            h.current.nodes === first.nodes && h.current.edges === first.edges);
        kv.hold = null;
        releases.forEach((r) => r());
        const second = await settle(h);
        check('H6e the Refresh lands', second.loading === false && second.nodes !== first.nodes);
        h.unmount();
    }

    // --- H7: a superseded read, and an unmount ---
    {
        const w = world({ hours: 3, perHour: 4 });
        const kv = kvOf(w);
        const h = mount(range(END - 10 * HOUR));
        await settle(h);
        kv.log.length = 0;
        let release;
        kv.hold = (info) => (info.name === 'logserv_topology_edges' ? new Promise((r) => { release = r; }) : null);
        h.setNonce(1);
        await act(async () => { await new Promise((r) => setImmediate(r)); });
        kv.hold = null;
        h.setNonce(2);
        const r = await settle(h, (x) => x.loading === false);
        if (release) release();
        await act(async () => { await new Promise((res) => setImmediate(res)); });
        check('H7a a superseded read shows no error', h.current.errors.length === 0, JSON.stringify(h.current.errors));
        check('H7b the latest read lands', r.loading === false && callsOf(h.current) === 12 * 2, String(callsOf(h.current)));
        h.unmount();
    }
    {
        // Held on a later page, released after the unmount: an aborted read asks for nothing more.
        const w = world({ hours: 30, perHour: 1000 });
        const kv = kvOf(w);
        const releases = [];
        kv.hold = (info) => (info.skip > 0 ? new Promise((r) => { releases.push(r); }) : null);
        const h = mount(range(END - 40 * HOUR));
        await act(async () => { await new Promise((r) => setImmediate(r)); });
        const held = releases.length;
        h.unmount();
        const n = kv.log.length;
        kv.hold = null;
        releases.forEach((r) => r());
        await new Promise((r) => setTimeout(r, 30));
        check('H7c an unmount stops the read: nothing more is asked for', held > 0 && kv.log.length === n, `${held} held, ${n} then ${kv.log.length} requests`);
    }

    {
        // A newer read held while the one it replaced is aborted: the aborted one changes nothing.
        const w = world({ hours: 3, perHour: 4 });
        const kv = kvOf(w);
        const h = mount(range(END - 10 * HOUR));
        const first = await settle(h);
        const releases = [];
        kv.hold = () => new Promise((r) => { releases.push(r); });
        h.setNonce(1);
        await act(async () => { await new Promise((r) => setImmediate(r)); });
        h.setNonce(2);
        for (let i = 0; i < 5; i += 1) {
            // eslint-disable-next-line no-await-in-loop
            await act(async () => { await new Promise((r) => setImmediate(r)); });
        }
        check('H7d while the newer read runs, the aborted one changes nothing',
            h.current.loading === true && h.current.nodes === first.nodes && h.current.errors.length === 0,
            `loading ${h.current.loading}, same nodes ${h.current.nodes === first.nodes}, ${JSON.stringify(h.current.errors)}`);
        kv.hold = null;
        releases.forEach((r) => r());
        await settle(h);
        check('H7e and the newer read lands', callsOf(h.current) === 12 * 2, String(callsOf(h.current)));
        h.unmount();
    }

    // --- H8: a failed page ---
    {
        const w = world({ hours: 3, perHour: 4 });
        const kv = kvOf(w);
        kv.failOn = (info) => info.name === 'logserv_topology_edges' && info.skip > 0;
        const h = mount(range(END - 10 * HOUR));
        const r = await settle(h);
        check('H8a a failed later page reports the read that failed', r.errors.length === 1 && r.errors[0].search === 'topology_edges' && /503/.test(r.errors[0].message), JSON.stringify(r.errors));
        check('H8b and shows none of its rows as if complete', r.edges.length === 0 && r.loading === false);
        kv.failOn = null;
        h.setNonce(1);
        const again = await settle(h, (x) => x.edges.length > 0);
        check('H8c the next read clears the error', again.errors.length === 0 && callsOf(again) === 12 * 2, JSON.stringify(again.errors));
        h.unmount();
    }

    if (failures > 0) {
        console.error(`check-topology-hook: ${failures} failure(s) of ${checks}`);
        process.exit(1);
    }
    console.log(`check-topology-hook: OK (${checks} checks, the real hook: every row past the cap, first-row order, the cut, staleness, loading, abort)`);
    process.exit(0);
};

main().catch((e) => {
    console.error('check-topology-hook: threw');
    console.error(e && e.stack ? e.stack : e);
    process.exit(1);
});
