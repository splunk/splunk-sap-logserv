/**
 * Build-time consistency test for the Dashboard Data history check (session 144,
 * build 370). Async - exports `run(): Promise<number>` and is awaited by
 * bin/check-diagnostics.js (the diagIngestFacts shape).
 *
 * What it pins, and why each one is here rather than left to review:
 *
 *  - The classifier against the three responses captured LIVE from sh-idxr's
 *    oneshot endpoint in session 144: a real rollup; a missing lookup definition
 *    (HTTP 200 with ERROR messages and a zero row - the shape the panel used to
 *    show as "empty"); an unknown command (HTTP 400, FATAL). Then the busy
 *    family: HTTP 429 and 5xx, Splunk's "not executed / maximum number of
 *    concurrent" wording under any status, and no response at all.
 *  - The retry policy: a busy check is retried after 2, 4 and 8 s and then
 *    reported busy; a failed check is never retried; once a batch is saturated
 *    every later check gets one attempt; a stopped batch makes no attempt.
 *  - The limiter: never more than its limit in flight, FIFO starts, and a task
 *    that throws or rejects still frees its slot.
 *  - End to end against a fake search head: through the limiter, 27 checks
 *    never meet a refusal on a head with 3 free slots (all at once, the old way,
 *    22 of 27 are refused on a head with 5); on a head with none, they finish in
 *    at most 36 attempts and at most 14 s of backoff per check.
 *
 * Run standalone with: `yarn check:diagnostics`
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-var-requires */

declare const require: (id: string) => any;
declare const process: { stderr: { write(s: string): void } };

const hcProc = process;
const hc = require('./historyCheck') as any;

/* Captured live: POST servicesNS/nobody/splunk_app_sap_logserv/search/jobs/oneshot
 * on sh-idxr (Splunk 9.4.3), session 144, jan_magnetic/tools/s144_oneshot.py. */
const LIVE_OK = { status: 200, body: { messages: [], results: [{ n: '35984', m: '1781049600' }] } };
const LIVE_MISSING = {
    status: 200,
    body: {
        messages: [
            {
                type: 'ERROR',
                text: "The lookup table 'logserv_no_such_collection_s144' requires a .csv or KV store lookup definition.",
            },
            { type: 'ERROR', text: "The lookup table 'logserv_no_such_collection_s144' is invalid." },
        ],
        results: [{ n: '0', m: '0' }],
    },
};
const LIVE_BADCMD = {
    status: 400,
    body: { messages: [{ type: 'FATAL', text: "Unknown search command 'nosuchcommands144'." }] },
};
/* Splunk's refusal wording. The sentence after "Search not executed:" is the one
 * sh-idxr's own _internal logged on 2026-09-21 (there 9.4.3 QUEUED the jobs). */
const CONC =
    'Search not executed: The maximum number of concurrent historical searches on this instance has been reached.';
const ROLE =
    'The maximum number of concurrent historical searches for this user based on their role quota has been reached.';

const tick = (): Promise<void> => Promise.resolve();

export const run = async (): Promise<number> => {
    let failures = 0;
    let checks = 0;
    const check = (label: string, okC: boolean, detail?: string): void => {
        checks += 1;
        if (!okC) {
            failures += 1;
            hcProc.stderr.write(`FAIL: historyCheck ${label}: ${detail || ''}\n`);
        }
    };
    const eq = (label: string, actual: unknown, expected: unknown): void =>
        check(label, JSON.stringify(actual) === JSON.stringify(expected),
            `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);

    /* =========================================================================
     * A. Constants, literal-pinned
     * ====================================================================== */
    eq('A1 concurrency', hc.CHECK_CONCURRENCY, 3);
    eq('A2 retry delays', hc.CHECK_RETRY_DELAYS_MS, [2000, 4000, 8000]);

    /* =========================================================================
     * B. The classifier
     * ====================================================================== */
    const cls = hc.classifyCheckResponse;
    eq('B1 live: a real rollup', cls(LIVE_OK.status, LIVE_OK.body), { kind: 'ok', n: 35984, m: 1781049600 });
    eq('B2 live: a missing lookup is FAILED, not empty', cls(LIVE_MISSING.status, LIVE_MISSING.body),
        { kind: 'failed', reason: LIVE_MISSING.body.messages[0].text });
    eq('B3 live: an unknown command', cls(LIVE_BADCMD.status, LIVE_BADCMD.body),
        { kind: 'failed', reason: "Unknown search command 'nosuchcommands144'." });
    eq('B4 HTTP 503 with the refusal wording', cls(503, { messages: [{ type: 'FATAL', text: CONC }] }),
        { kind: 'busy', reason: CONC });
    eq('B5 the refusal wording is busy under a 4xx', cls(400, { messages: [{ type: 'ERROR', text: CONC }] }),
        { kind: 'busy', reason: CONC });
    eq('B6 ...and inside an HTTP 200', cls(200, { messages: [{ type: 'FATAL', text: CONC }], results: [] }),
        { kind: 'busy', reason: CONC });
    eq('B7 the role-quota wording', cls(503, { messages: [{ type: 'ERROR', text: ROLE }] }),
        { kind: 'busy', reason: ROLE });
    eq('B7 ...is busy by its words alone, under a 4xx', cls(400, { messages: [{ type: 'ERROR', text: ROLE }] }),
        { kind: 'busy', reason: ROLE });
    eq('B7 ...and so is a bare "Search not executed"',
        cls(400, { messages: [{ type: 'FATAL', text: 'Search not executed: quota' }] }),
        { kind: 'busy', reason: 'Search not executed: quota' });
    [429, 500, 502, 503, 504].forEach((s) =>
        eq(`B8 HTTP ${s} with no body is busy`, cls(s, null), { kind: 'busy', reason: `HTTP ${s}` }));
    [301, 400, 401, 403, 404, 409].forEach((s) =>
        eq(`B9 HTTP ${s} with no body is failed`, cls(s, null), { kind: 'failed', reason: `HTTP ${s}` }));
    eq('B10 a 5xx keeps Splunk\'s own words', cls(500, { messages: [{ type: 'ERROR', text: 'KV Store error' }] }),
        { kind: 'busy', reason: 'KV Store error' });
    eq('B11 a 401 whose only message is a WARN reports the status',
        cls(401, { messages: [{ type: 'WARN', text: 'call not properly authenticated' }] }),
        { kind: 'failed', reason: 'HTTP 401' });
    eq('B12 an empty collection (no row) is ok 0/0', cls(200, { messages: [], results: [] }), { kind: 'ok', n: 0, m: 0 });
    eq('B13 a 200 with no results array is failed', cls(200, { messages: [] }),
        { kind: 'failed', reason: 'the response carried no results' });
    eq('B14 an unreadable 200 body is failed', cls(200, null),
        { kind: 'failed', reason: 'the response carried no results' });
    eq('B15 INFO and WARN messages do not fail a check',
        cls(200, { messages: [{ type: 'WARN', text: 'w' }, { type: 'INFO', text: 'i' }], results: [{ n: 4, m: 7 }] }),
        { kind: 'ok', n: 4, m: 7 });
    eq('B16 the message type is case-insensitive',
        cls(200, { messages: [{ type: 'error', text: 'bad' }], results: [{ n: 1, m: 1 }] }),
        { kind: 'failed', reason: 'bad' });
    eq('B17 the FIRST error message is the reason',
        cls(200, { messages: [{ type: 'INFO', text: 'i' }, { type: 'ERROR', text: 'one' }, { type: 'FATAL', text: 'two' }] }),
        { kind: 'failed', reason: 'one' });
    eq('B18 a blank error text is ignored',
        cls(200, { messages: [{ type: 'ERROR', text: '   ' }], results: [{ n: 1, m: 2 }] }),
        { kind: 'ok', n: 1, m: 2 });
    eq('B19 a missing m reads 0', cls(200, { results: [{ n: '5' }] }), { kind: 'ok', n: 5, m: 0 });
    eq('B20 a non-numeric n reads 0', cls(200, { results: [{ n: 'x', m: '9' }] }), { kind: 'ok', n: 0, m: 9 });
    eq('B21 messages that are not a list are ignored', cls(200, { messages: 'oops', results: [{ n: 2, m: 3 }] }),
        { kind: 'ok', n: 2, m: 3 });
    eq('B22 firstErrorText with no messages', hc.firstErrorText({}), null);
    eq('B23 firstErrorText trims', hc.firstErrorText({ messages: [{ type: 'FATAL', text: '  x  ' }] }), 'x');

    /* =========================================================================
     * C. The retry policy
     * ====================================================================== */
    const OK = { kind: 'ok', n: 3, m: 9 };
    const BUSY = { kind: 'busy', reason: 'HTTP 503' };
    const FAIL = { kind: 'failed', reason: 'bad' };
    const newBatch = (): any => ({ saturated: false, stopped: () => false });
    /* A scripted attempt: returns (or throws) the steps in order, then repeats the
     * last one; counts its calls. */
    const scripted = (steps: any[]): { fn: () => Promise<any>; calls: () => number } => {
        let i = 0;
        return {
            fn: async (): Promise<any> => {
                const s = steps[Math.min(i, steps.length - 1)];
                i += 1;
                if (s instanceof Error) throw s;
                return s;
            },
            calls: () => i,
        };
    };
    const recorder = (): { sleep: (ms: number) => Promise<void>; slept: number[] } => {
        const slept: number[] = [];
        return {
            sleep: async (ms: number): Promise<void> => {
                slept.push(ms);
            },
            slept,
        };
    };

    {
        const s = scripted([OK]);
        const r = recorder();
        eq('C1 ok at once', await hc.runCheck(s.fn, r.sleep, newBatch()), { ok: true, n: 3, m: 9, attempts: 1 });
        eq('C1 ...without a wait', r.slept, []);
    }
    {
        const s = scripted([BUSY, BUSY, OK]);
        const r = recorder();
        eq('C2 busy, busy, ok', await hc.runCheck(s.fn, r.sleep, newBatch()), { ok: true, n: 3, m: 9, attempts: 3 });
        eq('C2 ...after 2 s and 4 s', r.slept, [2000, 4000]);
    }
    {
        const s = scripted([BUSY]);
        const r = recorder();
        const b = newBatch();
        eq('C3 busy four times gives up busy', await hc.runCheck(s.fn, r.sleep, b),
            { ok: false, busy: true, reason: 'HTTP 503', attempts: 4 });
        eq('C3 ...after 2, 4 and 8 s', r.slept, [2000, 4000, 8000]);
        eq('C3 ...and saturates the batch', b.saturated, true);
        eq('C3 ...with exactly 4 calls', s.calls(), 4);
    }
    {
        const s = scripted([FAIL]);
        const r = recorder();
        const b = newBatch();
        eq('C4 a failed check is not retried', await hc.runCheck(s.fn, r.sleep, b),
            { ok: false, busy: false, reason: 'bad', attempts: 1 });
        eq('C4 ...no wait', r.slept, []);
        eq('C4 ...and does not saturate the batch', b.saturated, false);
    }
    {
        const s = scripted([BUSY, FAIL]);
        const r = recorder();
        eq('C5 busy then failed', await hc.runCheck(s.fn, r.sleep, newBatch()),
            { ok: false, busy: false, reason: 'bad', attempts: 2 });
        eq('C5 ...one wait', r.slept, [2000]);
    }
    {
        const s = scripted([BUSY, OK]);
        const r = recorder();
        const b = newBatch();
        b.saturated = true;
        eq('C6 a saturated batch gives a busy check one attempt', await hc.runCheck(s.fn, r.sleep, b),
            { ok: false, busy: true, reason: 'HTTP 503', attempts: 1 });
        eq('C6 ...no wait', r.slept, []);
    }
    {
        const s = scripted([OK]);
        const b = newBatch();
        b.saturated = true;
        eq('C7 a saturated batch still measures a check that runs',
            await hc.runCheck(s.fn, recorder().sleep, b), { ok: true, n: 3, m: 9, attempts: 1 });
    }
    {
        const s = scripted([OK]);
        const r = recorder();
        const b = { saturated: false, stopped: () => true };
        eq('C8 a stopped batch makes no attempt', await hc.runCheck(s.fn, r.sleep, b),
            { ok: false, busy: false, reason: hc.STOPPED_REASON, attempts: 0 });
        eq('C8 ...no call', s.calls(), 0);
    }
    {
        const s = scripted([BUSY, OK]);
        let stop = false;
        const b = { saturated: false, stopped: () => stop };
        const sleep = async (): Promise<void> => {
            stop = true;
        };
        eq('C9 stopped during a wait: no further attempt', await hc.runCheck(s.fn, sleep, b),
            { ok: false, busy: false, reason: hc.STOPPED_REASON, attempts: 1 });
        eq('C9 ...one call', s.calls(), 1);
    }
    {
        const s = scripted([new Error('net down'), OK]);
        const r = recorder();
        eq('C10 a throw counts as busy and is retried', await hc.runCheck(s.fn, r.sleep, newBatch()),
            { ok: true, n: 3, m: 9, attempts: 2 });
        eq('C10 ...after 2 s', r.slept, [2000]);
    }
    {
        const s = scripted([new Error('net down')]);
        eq('C11 a throw names itself', await hc.runCheck(s.fn, recorder().sleep, newBatch()),
            { ok: false, busy: true, reason: 'no response from Splunk (net down)', attempts: 4 });
        const s2 = scripted([new Error('')]);
        eq('C11 ...or says no response', await hc.runCheck(s2.fn, recorder().sleep, newBatch()),
            { ok: false, busy: true, reason: 'no response from Splunk', attempts: 4 });
    }
    {
        const s = scripted([BUSY]);
        const r = recorder();
        eq('C12 the retry count follows the delays given', await hc.runCheck(s.fn, r.sleep, newBatch(), [500]),
            { ok: false, busy: true, reason: 'HTTP 503', attempts: 2 });
        eq('C12 ...one wait of 500', r.slept, [500]);
    }

    /* =========================================================================
     * D. The limiter
     * ====================================================================== */
    {
        const lim = hc.createLimiter(3);
        let inflight = 0;
        let maxIn = 0;
        const started: number[] = [];
        const task = (i: number) => async (): Promise<number> => {
            started.push(i);
            inflight += 1;
            maxIn = Math.max(maxIn, inflight);
            for (let k = 0; k < (i % 4) + 1; k += 1) await tick();
            inflight -= 1;
            return i * 10;
        };
        const idx = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
        const res = await Promise.all(idx.map((i) => lim(task(i))));
        eq('D1 every task resolves with its own value', res, idx.map((i) => i * 10));
        eq('D2 never more than 3 in flight', maxIn, 3);
        eq('D3 tasks start in the order given', started, idx);
    }
    {
        const lim = hc.createLimiter(1);
        const settle = (p: Promise<any>): Promise<string> =>
            p.then((v) => `ok:${v}`, (e) => `err:${e && e.message}`);
        const r1 = settle(lim(async () => {
            throw new Error('boom');
        }));
        const r2 = settle(lim(() => {
            throw new Error('sync');
        }));
        const r3 = settle(lim(async () => 'after'));
        eq('D4 a rejecting task rejects', await r1, 'err:boom');
        eq('D5 a task that throws at once rejects', await r2, 'err:sync');
        eq('D6 ...and neither kept its slot', await r3, 'ok:after');
    }
    {
        const lim = hc.createLimiter(1);
        let inflight = 0;
        let maxIn = 0;
        const t = async (): Promise<void> => {
            inflight += 1;
            maxIn = Math.max(maxIn, inflight);
            await tick();
            await tick();
            inflight -= 1;
        };
        await Promise.all([lim(t), lim(t), lim(t), lim(t)]);
        eq('D7 a limit of 1 serializes', maxIn, 1);
    }

    /* =========================================================================
     * E. End to end against a fake search head with `capacity` free slots
     * ====================================================================== */
    const fakeHead = (capacity: number): { attempt: () => Promise<any>; stats: () => any } => {
        let inflight = 0;
        let maxSeen = 0;
        let calls = 0;
        let refusals = 0;
        return {
            attempt: async (): Promise<any> => {
                calls += 1;
                inflight += 1;
                maxSeen = Math.max(maxSeen, inflight);
                if (inflight > capacity) {
                    inflight -= 1;
                    refusals += 1;
                    await tick();
                    return { kind: 'busy', reason: 'HTTP 503' };
                }
                await tick();
                await tick();
                await tick();
                inflight -= 1;
                return { kind: 'ok', n: 1, m: 1 };
            },
            stats: () => ({ maxSeen, calls, refusals }),
        };
    };
    const TWENTY_SEVEN = Array.from({ length: 27 }, (_v, i) => i);
    {
        const head = fakeHead(3);
        const lim = hc.createLimiter(hc.CHECK_CONCURRENCY);
        const b = newBatch();
        const r = recorder();
        const rs = await Promise.all(TWENTY_SEVEN.map(() => lim(() => hc.runCheck(head.attempt, r.sleep, b))));
        eq('E1 27 checks through the limiter on a head with 3 free slots',
            { ok: rs.filter((x: any) => x.ok).length, waits: r.slept.length, ...head.stats() },
            { ok: 27, waits: 0, maxSeen: 3, calls: 27, refusals: 0 });
    }
    {
        const head = fakeHead(5);
        const firstTry = await Promise.all(TWENTY_SEVEN.map(() => head.attempt()));
        eq('E2 the old way, all 27 at once on a head with 5 free slots: 22 refused',
            firstTry.filter((a: any) => a.kind === 'busy').length, 22);
    }
    {
        const head = fakeHead(0);
        const lim = hc.createLimiter(hc.CHECK_CONCURRENCY);
        const b = newBatch();
        const perCheck: number[][] = TWENTY_SEVEN.map(() => []);
        const rs = await Promise.all(TWENTY_SEVEN.map((i) => lim(() => hc.runCheck(head.attempt, async (ms: number) => {
            perCheck[i].push(ms);
        }, b))));
        const sums = perCheck.map((w) => w.reduce((a, x) => a + x, 0));
        eq('E3 a saturated head: every check reports busy', rs.every((x: any) => !x.ok && x.busy), true);
        check('E4 ...in at most 36 attempts', head.stats().calls <= 36, `calls ${head.stats().calls}`);
        eq('E5 ...one check used all four attempts', rs.some((x: any) => x.attempts === 4), true);
        eq('E6 ...every check after the first three made one attempt',
            rs.slice(3).every((x: any) => x.attempts === 1), true);
        eq('E7 ...and no check waited more than 14 s', Math.max(...sums), 14000);
        eq('E8 ...the batch is marked saturated', b.saturated, true);
    }
    {
        /* A mixed batch: one collection fails for good, the rest run. */
        const lim = hc.createLimiter(hc.CHECK_CONCURRENCY);
        const b = newBatch();
        const r = recorder();
        const rs = await Promise.all(TWENTY_SEVEN.map((i) => lim(() => hc.runCheck(
            async () => (i === 4
                ? cls(LIVE_MISSING.status, LIVE_MISSING.body)
                : cls(LIVE_OK.status, LIVE_OK.body)),
            r.sleep,
            b,
        ))));
        eq('E9 one missing lookup fails alone, at once',
            rs.map((x: any, i: number) => (x.ok ? 'ok' : `${i}:${x.busy ? 'busy' : 'failed'}:${x.attempts}`))
                .filter((s: string) => s !== 'ok'),
            ['4:failed:1']);
        eq('E9 ...no waits, batch not saturated', { waits: r.slept.length, saturated: b.saturated },
            { waits: 0, saturated: false });
    }

    /* =========================================================================
     * F. The hover text
     * ====================================================================== */
    eq('F1 busy after retries', hc.describeCheckFailure('logserv_perimeter_rollup',
        { busy: true, reason: 'HTTP 503', attempts: 4 }),
        'logserv_perimeter_rollup: Splunk did not run the check (HTTP 503) — tried 4 times');
    eq('F2 busy on one attempt (a saturated batch)', hc.describeCheckFailure('logserv_dns_rollup',
        { busy: true, reason: 'HTTP 503', attempts: 1 }),
        'logserv_dns_rollup: Splunk did not run the check (HTTP 503)');
    eq('F3 failed', hc.describeCheckFailure('logserv_x_rollup', { busy: false, reason: 'bad', attempts: 1 }),
        'logserv_x_rollup: the check failed (bad)');

    if (failures === 0) {
        // eslint-disable-next-line no-console
        console.log(`historyCheck consistency test: ${checks} checks OK`);
    } else {
        hcProc.stderr.write(`historyCheck consistency test: ${failures} failure(s) of ${checks}\n`);
    }
    return failures;
};

export {};
