/**
 * Build-time consistency test for reading a whole KV Store query (build 396).
 *
 * The defect it holds shut: Environment Topology read with limit=0 and Splunk's
 * limits.conf [kvstore] max_rows_per_query silently cut the read at 50,000 rows, the
 * newest ones, so at Last 90 days on the reference system the page saw 36% of its node
 * events and 88% of its edge calls and called the data stale.
 *
 * What it pins, against a fake KV Store with the same caps:
 *  - R1: every row comes back past the row cap, at the default cap and at one lower than
 *    the page size, with no limit=0 ever sent;
 *  - R2: short pages (the size cap) never end a read, only an empty page does, and skip
 *    moves by what a page held;
 *  - R3: maxRows, exactly at it and one past it, is told apart;
 *  - R4: a row written during the read does not count a row twice;
 *  - R5: a failed page, a body that is not a list and a server that stops moving all
 *    reach the caller's error path, and an abort is passed on; one page of nothing new
 *    does not;
 *  - B1-B4: the window read: the query and sort it sends, the same row sequence a
 *    no-sort read returns, the newest rows kept and a part-read bucket dropped on a
 *    stopped read, and the common start of two stopped reads;
 *  - S1-S4: the wiring: no URL anywhere in the App reads with limit=0, the topology
 *    hook and the enrichment read go through this module, the limit the docs state,
 *    the shared activity series, and the page's notice.
 *
 * bin/check-topology-hook.js runs the real hook (state, flows, cut, staleness).
 *
 * Run standalone with: `yarn check:diagnostics`
 */

/* eslint-disable no-console */
/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-var-requires */

declare const require: (id: string) => any;
declare const __dirname: string;
declare const process: { stderr: { write(s: string): void } };

const fs = require('fs');
const path = require('path');
const mod = require('./kvPagedRead');

const { commonCompleteFromTs, KV_PAGE_ROWS, readAllKvRows, readKvBucketWindow } = mod;

const HOME = path.resolve(__dirname, '..');
const read = (rel: string): string => fs.readFileSync(path.join(HOME, rel), 'utf8').replace(/\r\n/g, '\n');
/** Source without comments, so a comment can neither satisfy a pin nor trip a ban. */
const code = (rel: string): string => read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
const listFiles = (dir: string): string[] => {
    const out: string[] = [];
    fs.readdirSync(dir, { withFileTypes: true }).forEach((e: any) => {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) out.push(...listFiles(p));
        else if (/\.tsx?$/.test(e.name) && !/consistency-test/.test(e.name)) out.push(p);
    });
    return out;
};

interface Call {
    limit: number;
    skip: number;
    sort: string | null;
    query: any;
    outputMode: string | null;
    init: any;
}

interface FakeOptions {
    rowCap?: number;
    /** Page sizes in turn, as a size cap would cut them. */
    pageSizes?: number[];
    failOnCall?: number;
    body?: unknown;
    ignoreSkip?: boolean;
    onCall?: (callNumber: number) => void;
}

/** A KV Store collection: `stored` in index order, ascending. */
const fakeKv = (stored: any[], opts: FakeOptions = {}): { calls: Call[]; fetchImpl: any } => {
    const calls: Call[] = [];
    const fetchImpl = (url: string, init: any): Promise<any> => {
        const qs = new URLSearchParams(url.split('?')[1]);
        const queryText = qs.get('query');
        const call: Call = {
            limit: Number(qs.get('limit')),
            skip: Number(qs.get('skip') || 0),
            sort: qs.get('sort'),
            query: queryText ? JSON.parse(queryText) : null,
            outputMode: qs.get('output_mode'),
            init,
        };
        calls.push(call);
        if (opts.onCall) opts.onCall(calls.length);
        if (opts.failOnCall === calls.length) {
            return Promise.resolve({ ok: false, status: 503, statusText: 'Service Unavailable', json: () => Promise.resolve({}) });
        }
        if (opts.body !== undefined) {
            return Promise.resolve({ ok: true, status: 200, statusText: 'OK', json: () => Promise.resolve(opts.body) });
        }
        let rows = stored;
        if (call.query) {
            const { $gte, $lte } = call.query.bucket_ts;
            rows = rows.filter((r) => r.bucket_ts >= $gte && r.bucket_ts <= $lte);
        }
        if (call.sort === 'bucket_ts:-1') rows = rows.slice().reverse();
        const cap = opts.rowCap === undefined ? 50000 : opts.rowCap;
        let size = call.limit === 0 ? cap : Math.min(call.limit, cap);
        if (opts.pageSizes) size = Math.min(size, opts.pageSizes[(calls.length - 1) % opts.pageSizes.length]);
        const from = opts.ignoreSkip ? 0 : call.skip;
        const page = rows.slice(from, from + size);
        return Promise.resolve({ ok: true, status: 200, statusText: 'OK', json: () => Promise.resolve(page) });
    };
    return { calls, fetchImpl };
};

const flatRows = (n: number): any[] => Array.from({ length: n }, (_, i) => ({ _key: `k${i}`, n: i }));

/** `perBucket` rows in each of `buckets` hours, ascending, as the by_bucket_ts index holds them. */
const bucketRows = (buckets: number, perBucket: number, firstTs = 3600000): any[] => {
    const rows: any[] = [];
    for (let b = 0; b < buckets; b += 1) {
        for (let i = 0; i < perBucket; i += 1) {
            rows.push({ _key: `b${b}:${i}`, bucket_ts: firstTs + b * 3600 });
        }
    }
    return rows;
};

const keysOf = (rows: any[]): string => rows.map((r) => r._key).join(',');

export const run = async (): Promise<number> => {
    let failures = 0;
    let checks = 0;
    const check = (name: string, ok: boolean, detail = ''): void => {
        checks += 1;
        if (!ok) {
            failures += 1;
            process.stderr.write(`kvPagedRead FAIL ${name}${detail ? `: ${detail}` : ''}\n`);
        }
    };
    const rejects = async (p: Promise<any>): Promise<string | null> => {
        try {
            await p;
            return null;
        } catch (e) {
            return e instanceof Error ? e.message : String(e);
        }
    };
    const URLBASE = '/kv/coll';

    // --- R1: past the row cap ---
    {
        const stored = flatRows(125000);
        const { calls, fetchImpl } = fakeKv(stored);
        const r = await readAllKvRows(URLBASE, { fetchImpl });
        check('R1a every row past the default cap', r.rows.length === 125000 && r.complete === true, `${r.rows.length} rows`);
        check('R1b each row once, in the server order', keysOf(r.rows) === keysOf(stored));
        check('R1c limit=0 is never sent', calls.every((c) => c.limit > 0));
        check('R1d asks json with the session cookie',
            calls.every((c) => c.outputMode === 'json' && c.init.credentials === 'same-origin'));
    }
    {
        const stored = flatRows(5000);
        const { calls, fetchImpl } = fakeKv(stored, { rowCap: 1000 });
        const r = await readAllKvRows(URLBASE, { fetchImpl });
        check('R1e a customer cap below the page size still reads every row',
            r.rows.length === 5000 && r.complete === true, `${r.rows.length} rows in ${calls.length} calls`);
        check('R1f an unset maxRows is complete', r.complete === true);
    }
    {
        const { calls, fetchImpl } = fakeKv([]);
        const r = await readAllKvRows(URLBASE, { fetchImpl });
        check('R1g an empty collection takes one request', r.rows.length === 0 && r.complete && calls.length === 1);
    }
    {
        const seen: string[] = [];
        const fetchImpl = (url: string): Promise<any> => {
            seen.push(url);
            return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
        };
        await readAllKvRows(URLBASE, { fetchImpl, params: { fields: 'a,b' } });
        check('R1h a caller parameter is sent', /[?&]fields=a%2Cb(&|$)/.test(seen[0]), seen[0]);
    }

    // --- R2: short pages and skip ---
    {
        const stored = flatRows(10000);
        const { calls, fetchImpl } = fakeKv(stored, { pageSizes: [700, 3, 2500] });
        const r = await readAllKvRows(URLBASE, { fetchImpl, pageRows: 5000 });
        check('R2a short pages never end a read', r.rows.length === 10000 && r.complete === true, `${r.rows.length} rows`);
        check('R2b only an empty page does', calls.length >= 2 && keysOf(r.rows) === keysOf(stored));
        check('R2c skip moves by what each page held',
            calls[0].skip === 0 && calls[1].skip === 700 && calls[2].skip === 703 && calls[3].skip === 3203,
            JSON.stringify(calls.slice(0, 4).map((c) => c.skip)));
    }
    {
        const { calls, fetchImpl } = fakeKv(flatRows(2 * KV_PAGE_ROWS));
        const r = await readAllKvRows(URLBASE, { fetchImpl });
        check('R2d an exact multiple of the page size ends on an empty page',
            r.rows.length === 2 * KV_PAGE_ROWS && r.complete && calls.length === 3, `${calls.length} calls`);
        check('R2e the page size is the limit asked for', calls[0].limit === KV_PAGE_ROWS);
    }
    check('R2f a page stays under the 50 MB result cap up to 5 KB a row', KV_PAGE_ROWS * 5000 < 50 * 1024 * 1024);

    // --- R3: maxRows ---
    {
        const { calls, fetchImpl } = fakeKv(flatRows(300));
        const r = await readAllKvRows(URLBASE, { fetchImpl, maxRows: 300, pageRows: 100 });
        check('R3a exactly at maxRows is complete', r.rows.length === 300 && r.complete === true);
        check('R3b the last request only asks whether a row exists', calls[calls.length - 1].limit === 1);
    }
    {
        const { fetchImpl } = fakeKv(flatRows(301));
        const r = await readAllKvRows(URLBASE, { fetchImpl, maxRows: 300, pageRows: 100 });
        check('R3c one row past maxRows is not complete, and is not kept', r.rows.length === 300 && r.complete === false);
    }
    {
        const { calls, fetchImpl } = fakeKv(flatRows(1000));
        const r = await readAllKvRows(URLBASE, { fetchImpl, maxRows: 150, pageRows: 100 });
        check('R3d the last page asks only for the room left',
            calls[0].limit === 100 && calls[1].limit === 50 && r.rows.length === 150 && r.complete === false);
    }

    // --- R4: a row written during the read ---
    {
        const stored = bucketRows(40, 10);
        const originals = keysOf(stored.slice().reverse());
        let added = 0;
        const { fetchImpl } = fakeKv(stored, {
            onCall: (n) => {
                if (n === 2 || n === 3) {
                    added += 1;
                    stored.push({ _key: `new${added}`, bucket_ts: 3600000 + 40 * 3600 });
                }
            },
        });
        const r = await readAllKvRows(URLBASE, { fetchImpl, pageRows: 50, params: { sort: 'bucket_ts:-1' } });
        const keys = r.rows.map((x: any) => x._key);
        check('R4a no row counts twice when a write shifts the pages', new Set(keys).size === keys.length,
            `${keys.length} rows, ${new Set(keys).size} distinct`);
        check('R4b no row present at the start is lost',
            originals.split(',').every((k) => keys.indexOf(k) !== -1));
    }
    {
        const rows = [{ n: 1 }, { n: 2 }];
        let served = false;
        const fetchImpl = (): Promise<any> => {
            const body = served ? [] : rows;
            served = true;
            return Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
        };
        const r = await readAllKvRows(URLBASE, { fetchImpl });
        check('R4c a row with no _key is kept', r.rows.length === 2);
    }

    // --- R5: failures ---
    {
        const { fetchImpl } = fakeKv(flatRows(50), { failOnCall: 2 });
        const msg = await rejects(readAllKvRows(URLBASE, { fetchImpl, pageRows: 10 }));
        check('R5a a failed later page rejects, naming the status', !!msg && /503/.test(msg), String(msg));
    }
    {
        const { fetchImpl } = fakeKv([], { body: { error: 'x' } });
        const msg = await rejects(readAllKvRows(URLBASE, { fetchImpl }));
        check('R5b a body that is not a list rejects', !!msg && /not a list/.test(msg), String(msg));
    }
    {
        const { calls, fetchImpl } = fakeKv(flatRows(50), { ignoreSkip: true });
        const msg = await rejects(readAllKvRows(URLBASE, { fetchImpl, pageRows: 10 }));
        check('R5c a server that stops moving rejects, and does not loop', !!msg && /no new rows/.test(msg) && calls.length === 4,
            `${msg}, ${calls.length} calls`);
    }
    {
        // Rows written ahead of a newest-first read, a page's worth between two requests.
        const stored = bucketRows(30, 10);
        const originals = stored.map((r) => r._key);
        let added = 0;
        const { fetchImpl } = fakeKv(stored, {
            onCall: (n) => {
                if (n === 2) {
                    for (let i = 0; i < 50; i += 1) {
                        added += 1;
                        stored.push({ _key: `new${added}`, bucket_ts: 3600000 + 30 * 3600 });
                    }
                }
            },
        });
        const r = await readAllKvRows(URLBASE, { fetchImpl, pageRows: 50, params: { sort: 'bucket_ts:-1' } });
        const keys = r.rows.map((x: any) => x._key);
        check('R5e one page of nothing new does not end a read', r.complete === true && originals.every((k) => keys.indexOf(k) !== -1),
            `${keys.length} rows`);
    }
    {
        // Two all-seen pages, then new rows: the count starts again.
        let n = 0;
        const fetchImpl = (): Promise<any> => {
            n += 1;
            const pages: { [k: number]: any[] } = {
                1: [{ _key: 'a' }], 2: [{ _key: 'a' }], 3: [{ _key: 'a' }], 4: [{ _key: 'b' }], 5: [{ _key: 'a' }], 6: [{ _key: 'a' }], 7: [],
            };
            return Promise.resolve({ ok: true, json: () => Promise.resolve(pages[n]) });
        };
        const r = await readAllKvRows(URLBASE, { fetchImpl });
        check('R5f new rows start the count of all-seen pages again', r.complete === true && r.rows.length === 2 && n === 7, `${r.rows.length} rows, ${n} calls`);
    }
    {
        const controller = new AbortController();
        const seen: any[] = [];
        const aborted = new Error('The operation was aborted');
        aborted.name = 'AbortError';
        const fetchImpl = (_u: string, init: any): Promise<any> => {
            seen.push(init.signal);
            return Promise.reject(aborted);
        };
        const msg = await rejects(readAllKvRows(URLBASE, { fetchImpl, signal: controller.signal }));
        check('R5d the signal reaches the fetch and an abort is passed on',
            seen[0] === controller.signal && msg === 'The operation was aborted', String(msg));
    }

    // --- B1-B2: the window read ---
    {
        const stored = bucketRows(30, 7);
        const earliest = 3600000 + 5 * 3600;
        const latest = 3600000 + 20 * 3600;
        const { calls, fetchImpl } = fakeKv(stored);
        const r = await readKvBucketWindow(URLBASE, earliest, latest, { fetchImpl, pageRows: 25 });
        check('B1a the query names the window', calls.every((c) => c.query.bucket_ts.$gte === earliest && c.query.bucket_ts.$lte === latest));
        check('B1b newest first', calls.every((c) => c.sort === 'bucket_ts:-1'));
        const noSort = await readAllKvRows(URLBASE, {
            fetchImpl: fakeKv(stored).fetchImpl,
            params: { query: JSON.stringify({ bucket_ts: { $gte: earliest, $lte: latest } }) },
        });
        check('B2a the rows come back in the sequence a no-sort read returns', keysOf(r.rows) === keysOf(noSort.rows));
        check('B2b a complete read names no start', r.complete === true && r.completeFromTs === null);
        check('B2c only the rows of the window', r.rows.length === 16 * 7, `${r.rows.length} rows`);
    }

    // --- B3: a stopped read ---
    {
        const stored = bucketRows(10, 100);
        const newest = 3600000 + 9 * 3600;
        const { fetchImpl } = fakeKv(stored);
        const r = await readKvBucketWindow(URLBASE, 0, newest, { fetchImpl, maxRows: 350, pageRows: 100 });
        check('B3a not complete', r.complete === false);
        check('B3b the newest rows are the ones kept', r.rows[r.rows.length - 1].bucket_ts === newest);
        const startTs = 3600000 + 7 * 3600;
        check('B3c the part-read bucket is dropped and the start is the oldest whole bucket',
            r.completeFromTs === startTs && r.rows.every((x: any) => x.bucket_ts >= startTs), String(r.completeFromTs));
        check('B3d every bucket from the start on is whole', r.rows.length === 300, `${r.rows.length} rows`);
        check('B3e oldest first', r.rows[0].bucket_ts === startTs);
    }
    {
        const stored = bucketRows(10, 100);
        const { fetchImpl } = fakeKv(stored);
        const r = await readKvBucketWindow(URLBASE, 0, 3600000 + 9 * 3600, { fetchImpl, maxRows: 300, pageRows: 100 });
        const startTs = 3600000 + 8 * 3600;
        check('B3f a stop on a bucket edge cannot tell, so that bucket goes too',
            r.completeFromTs === startTs && r.rows.length === 200, `${r.completeFromTs}, ${r.rows.length}`);
    }
    {
        const stored = bucketRows(3, 500);
        const { fetchImpl } = fakeKv(stored);
        const r = await readKvBucketWindow(URLBASE, 0, 3600000 + 2 * 3600, { fetchImpl, maxRows: 100, pageRows: 50 });
        const only = 3600000 + 2 * 3600;
        check('B3g one bucket bigger than the limit stays, named as the start',
            r.rows.length === 100 && r.completeFromTs === only && r.complete === false);
    }
    {
        const { fetchImpl } = fakeKv(bucketRows(3, 5));
        const r = await readKvBucketWindow(URLBASE, 1, 2, { fetchImpl });
        check('B3h an empty window', r.rows.length === 0 && r.complete === true && r.completeFromTs === null);
    }

    // --- B4: two stopped reads ---
    check('B4a no stopped read', commonCompleteFromTs([null, null]) === null);
    check('B4b one stopped read', commonCompleteFromTs([null, 7200]) === 7200 && commonCompleteFromTs([7200, null]) === 7200);
    check('B4c both: the later start, from where both are complete', commonCompleteFromTs([3600, 7200]) === 7200);

    // --- S1: nothing reads with limit=0 ---
    {
        const offenders = listFiles(HOME)
            .map((p: string) => path.relative(HOME, p).split(path.sep).join('/'))
            .filter((rel: string) => /[?&]limit=0\b|\blimit['"]?\s*[:,]\s*['"]0['"]/.test(code(rel)));
        check('S1a no URL in the App reads with limit=0', offenders.length === 0, offenders.join(', '));
    }

    // --- S2: the topology hook ---
    {
        const hook = code('hooks/useTopologyData.ts');
        check('S2a the node and edge collections go through the window read',
            /fetchBucketed<NodeBucketRow>\('logserv_topology_nodes'/.test(hook)
            && /fetchBucketed<EdgeBucketRow>\('logserv_topology_edges'/.test(hook)
            && /await readKvBucketWindow<T>\(/.test(hook));
        check('S2b the window read carries the limit and the abort signal',
            /readKvBucketWindow<T>\([^;]*maxRows,\s*signal: controller\.signal/.test(hook)
            && /maxRows = TOPOLOGY_READ_MAX_ROWS,/.test(hook));
        check('S2c the inventory reads every row, with no limit',
            /fetchFlat<InventoryRow>\('logserv_topology_inventory'/.test(hook)
            && /readAllKvRows<T>\(`\$\{KV_BASE\}\/\$\{collection\}`, \{ signal: controller\.signal \}\)/.test(hook));
        check('S2d the cleanup aborts the read', /cancelled = true;\s*controller\.abort\(\);/.test(hook));
        check('S2e both collections are cut at one start',
            /nodes\.rows\.filter\(\(r\) => r\.bucket_ts >= completeFromTs\)/.test(hook)
            && /edges\.rows\.filter\(\(r\) => r\.bucket_ts >= completeFromTs\)/.test(hook)
            && /commonCompleteFromTs\(\[nodes\.completeFromTs, edges\.completeFromTs\]\)/.test(hook));
        check('S2g the aggregation depends on the read alone', /\}, \[read\]\);/.test(hook)
            && /\{ \.\.\.data, loading, errors \}/.test(hook));
        check('S2h the fetches before this module are gone', !/fetchKvBucketRows|fetchKvAllRows/.test(hook));
        check('S2i the limit is the one the docs state', /export const TOPOLOGY_READ_MAX_ROWS = 500000;/.test(hook));
        const docsRoot = path.resolve(HOME, '../../../../../../../../../docs/content');
        ['logserv-app/dashboards/topology.md', 'overview/release-notes.md'].forEach((d) => {
            check(`S2j ${d} states that limit`, fs.readFileSync(path.join(docsRoot, d), 'utf8').indexOf('500,000 rows per collection') !== -1);
        });
        check('S2k no edge carries a zero-filled series: only the selected edge builds one',
            /activity: \{ buckets: allEdgeBuckets, byBucket: agg\.activityByBucket \}/.test(hook)
            && /edgeActivitySeries\(edge\.activity\)/.test(code('hooks/useEdgeData.ts')));
    }

    // --- S3: the enrichment read ---
    {
        const enrich = code('topology/enrichment.ts');
        check('S3a the enrichment read goes through this module',
            /await readAllKvRows<IpEnrichmentRow>\(KV_URL\)/.test(enrich) && !/limit=/.test(enrich));
    }

    // --- S4: the page says so ---
    {
        const page = code('dashboards/IntegrationTopology.tsx');
        check('S4a a notice when the numbers do not cover the range, shown as long as those rows are on screen',
            /\{topology\.completeFromTs !== null && \(\s*<StatusBanner \$kind="warning" role="status">/.test(page)
            && /cover only \{utcMinute\(topology\.completeFromTs\)\} onward/.test(page)
            && /What the side panel searches for itself \(Top Programs, Errors, the Hosts list and\s+host count, Operations, the Performance distribution\) reads the whole range/.test(page)
            && /what the side panel takes from them \(an edge's\s+Overview, Activity and Performance figures; a node's Overview totals and Calls by\s+host\)/.test(page));
        check('S4b the stats line says so too', /from \$\{utcMinute\(topology\.completeFromTs\)\} only/.test(page));
        check('S4c the notice names the limit', /\{TOPOLOGY_READ_MAX_ROWS\.toLocaleString\(\)\} rows per collection/.test(page));
    }

    if (failures === 0) {
        console.log(`kvPagedRead consistency test: ${checks} checks OK (every row past either KV Store read cap, each once;`
            + ' a read stopped by its limit keeps the newest whole buckets and the page says so)');
    } else {
        process.stderr.write(`kvPagedRead consistency test: ${failures} failure(s) of ${checks}\n`);
    }
    return failures;
};
