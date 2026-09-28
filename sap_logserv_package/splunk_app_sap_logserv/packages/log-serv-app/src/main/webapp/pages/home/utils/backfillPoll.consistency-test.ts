/**
 * Build-time consistency test for the backfill wait policy (session 134).
 *
 * What it pins, and why each one is here rather than left to review:
 *
 *  - NO POLL-COUNT CEILING. Build 353 reported a search FAILED after 2,000
 *    polls (~90 minutes) while the search kept running and writing on the
 *    server. A running job must now be waited on for as long as Splunk reports
 *    it alive - asserted past the old ceiling and through a simulated
 *    near-24-hour wait with the real poll schedule.
 *  - Only SPLUNK decides failure: FAILED / isFailed, a zombie process, or a job
 *    that 404s on consecutive polls. Poll errors (network, an ended session, a
 *    5xx) are NOT failures - before build 357, 60 seconds of them were.
 *  - When the panel stops waiting for any other reason the arm is DETACHED
 *    ("still running on the server"), at exactly the documented thresholds.
 *  - A row's outcome keeps its worst verdict and the IDs of detached jobs, and a
 *    clean 'done' never erases an earlier problem.
 *
 * Run standalone with: `yarn check:diagnostics`
 */

/* eslint-disable no-console */

// Standalone script, not a module - see session-085 sticky #4.
export {};

const bpProc = process as unknown as {
    stderr: { write(s: string): void };
    exit(code: number): never;
};

/* eslint-disable @typescript-eslint/no-explicit-any */
const bp = require('./backfillPoll') as any;
/* eslint-enable @typescript-eslint/no-explicit-any */

const {
    observeJob,
    decidePoll,
    pollDelayMs,
    mergeRowOutcome,
    INITIAL_TRACKER,
    MAX_WAIT_MS,
    LOST_CONTACT_MS,
    GONE_STREAK_FAIL,
    FAST_POLL_MS,
    SLOW_POLL_MS,
    FAST_POLL_WINDOW_MS,
} = bp;

let bpFailures = 0;
let bpChecks = 0;
const check = (label: string, ok: boolean, detail: string): void => {
    bpChecks += 1;
    if (!ok) {
        bpFailures += 1;
        bpProc.stderr.write(`FAIL: ${label}: ${detail}\n`);
    }
};
const eq = (label: string, actual: unknown, expected: unknown): void =>
    check(label, JSON.stringify(actual) === JSON.stringify(expected),
        `got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);

const job = (content: Record<string, unknown>): unknown => ({ entry: [{ content }] });
const RUNNING = { kind: 'state', isDone: false, failed: false, zombie: false, truncated: false };
const T0 = Date.UTC(2026, 8, 24, 16, 0, 0);
const MIN = 60 * 1000;

/* =============================================================================
 * A. observeJob - reading one GET search/jobs/<sid> response
 * ========================================================================== */

eq('A1 HTTP 404 is gone', observeJob(404, null), { kind: 'gone' });
for (const s of [0, 302, 401, 403, 500, 503]) {
    eq(`A2 HTTP ${s} is a poll error, not a verdict`, observeJob(s, job({ isDone: true })), { kind: 'error' });
}
eq('A3 200 with no body is an error', observeJob(200, null), { kind: 'error' });
eq('A4 200 without an entry is an error', observeJob(200, { entry: [] }), { kind: 'error' });
eq('A5 200 with non-object content is an error', observeJob(200, { entry: [{ content: 'x' }] }), { kind: 'error' });
eq('A6 a running job', observeJob(200, job({ dispatchState: 'RUNNING', isDone: false })), RUNNING);
for (const v of [true, 1, '1', 'true']) {
    eq(`A7 isDone=${JSON.stringify(v)} reads as done`,
        observeJob(200, job({ dispatchState: 'DONE', isDone: v })).isDone, true);
}
for (const v of [false, 0, '0', 'false', null, undefined]) {
    eq(`A8 isDone=${JSON.stringify(v)} reads as not done`,
        observeJob(200, job({ dispatchState: 'RUNNING', isDone: v })).isDone, false);
}
eq('A9 dispatchState FAILED is failed', observeJob(200, job({ dispatchState: 'FAILED', isDone: true })).failed, true);
eq('A10 isFailed is failed even when the state reads DONE',
    observeJob(200, job({ dispatchState: 'DONE', isDone: true, isFailed: true })).failed, true);
eq('A11 isZombie is read', observeJob(200, job({ dispatchState: 'RUNNING', isZombie: true })).zombie, true);
eq('A12 a healthy job is neither failed nor a zombie',
    observeJob(200, job({ dispatchState: 'DONE', isDone: true, isFailed: false, isZombie: false })),
    { kind: 'state', isDone: true, failed: false, zombie: false, truncated: false });
for (const text of [
    'The search reached its time limit',
    'The search auto-finalized',
    'Search results might be incomplete: the search process reached maxout',
    'Results were truncated',
    'Some results may be incomplete',
]) {
    eq(`A13 truncation message is flagged: "${text.slice(0, 32)}..."`,
        observeJob(200, job({ dispatchState: 'DONE', isDone: true, messages: [{ type: 'WARN', text }] })).truncated, true);
}
eq('A14 an unrelated message is not truncation',
    observeJob(200, job({ dispatchState: 'DONE', isDone: true, messages: [{ type: 'INFO', text: 'Your timerange was substituted' }] })).truncated,
    false);
eq('A15 malformed messages do not throw and do not flag',
    observeJob(200, job({ dispatchState: 'DONE', isDone: true, messages: [null, { text: null }, 7] })).truncated,
    false);
eq('A16 messages that are not an array are ignored',
    observeJob(200, job({ dispatchState: 'DONE', isDone: true, messages: 'truncated' })).truncated, false);

/* =============================================================================
 * B. Splunk's own verdicts
 * ========================================================================== */

const st = (o: Record<string, boolean>): unknown => ({ ...RUNNING, ...o });
eq('B1 done', decidePoll(st({ isDone: true }), INITIAL_TRACKER, T0 + MIN, T0), { verdict: 'done', reason: 'done' });
eq('B2 done but truncated', decidePoll(st({ isDone: true, truncated: true }), INITIAL_TRACKER, T0 + MIN, T0),
    { verdict: 'truncated', reason: 'truncated' });
eq('B3 failed', decidePoll(st({ failed: true, isDone: true }), INITIAL_TRACKER, T0 + MIN, T0),
    { verdict: 'failed', reason: 'failed_state' });
eq('B4 a zombie process is a failure', decidePoll(st({ zombie: true }), INITIAL_TRACKER, T0 + MIN, T0),
    { verdict: 'failed', reason: 'zombie' });
eq('B5 zombie outranks a done flag (the process died - re-run, never trust the rows)',
    decidePoll(st({ zombie: true, isDone: true }), INITIAL_TRACKER, T0 + MIN, T0),
    { verdict: 'failed', reason: 'zombie' });
eq('B6 a job that finishes at the backstop instant is DONE, not detached',
    decidePoll(st({ isDone: true }), INITIAL_TRACKER, T0 + MAX_WAIT_MS, T0), { verdict: 'done', reason: 'done' });
eq('B7 a failure at the backstop instant is still a failure',
    decidePoll(st({ failed: true }), INITIAL_TRACKER, T0 + MAX_WAIT_MS + MIN, T0),
    { verdict: 'failed', reason: 'failed_state' });

/* =============================================================================
 * C. No poll-count ceiling - the reason this module exists
 * ========================================================================== */

/** Drive the policy with the panel's own schedule; returns where it stopped. */
const simulate = (
    obsAt: (elapsedMs: number, poll: number) => unknown,
    capPolls: number,
): { decision: any; polls: number; elapsedMs: number } => {
    let tracker = INITIAL_TRACKER;
    let now = T0;
    for (let poll = 1; poll <= capPolls; poll += 1) {
        now += pollDelayMs(now - T0);
        const d = decidePoll(obsAt(now - T0, poll), tracker, now, T0);
        if (d.verdict !== 'continue') return { decision: d, polls: poll, elapsedMs: now - T0 };
        tracker = d.tracker;
    }
    return { decision: { verdict: 'continue' }, polls: capPolls, elapsedMs: now - T0 };
};

{
    // The build-353 ceiling was 2,000 polls. Poll 2,001 at the OLD 2.5 s rate is
    // well past it; a running job must still be waited on.
    let tracker = INITIAL_TRACKER;
    let lastVerdict = 'continue';
    for (let poll = 1; poll <= 2001; poll += 1) {
        const d = decidePoll(RUNNING, tracker, T0 + poll * 2500, T0);
        lastVerdict = d.verdict;
        if (d.verdict !== 'continue') break;
        tracker = d.tracker;
    }
    eq('C1 a running job is still waited on after 2,001 polls (the old ceiling)', lastVerdict, 'continue');
}
{
    const r = simulate(() => RUNNING, 100000);
    eq('C2 a job that never finishes is DETACHED at the backstop, not failed',
        r.decision, { verdict: 'detached', reason: 'backstop' });
    check('C3 ...and not before the backstop', r.elapsedMs >= MAX_WAIT_MS,
        `stopped at ${r.elapsedMs} ms < ${MAX_WAIT_MS}`);
    check('C4 ...within one slow poll after it', r.elapsedMs < MAX_WAIT_MS + SLOW_POLL_MS,
        `stopped ${r.elapsedMs - MAX_WAIT_MS} ms late`);
    check('C5 a 24-hour wait costs under 10,000 status requests (the 2.5 s rate would be ~34,560)',
        r.polls < 10000, `${r.polls} polls`);
}
{
    // The slowest search measured on the reference box: 2,524 s.
    const r = simulate((ms) => (ms >= 2524 * 1000 ? st({ isDone: true }) : RUNNING), 100000);
    eq('C6 the measured 42-minute search completes as DONE', r.decision, { verdict: 'done', reason: 'done' });
    check('C7 ...and is noticed within one slow poll of finishing',
        r.elapsedMs >= 2524 * 1000 && r.elapsedMs < 2524 * 1000 + SLOW_POLL_MS, `noticed at ${r.elapsedMs} ms`);
}
{
    // Four times the reference box: a monthly chunk of ~2.8 hours.
    const r = simulate((ms) => (ms >= 10096 * 1000 ? st({ isDone: true }) : RUNNING), 100000);
    eq('C8 a 2.8-hour search (4x the reference box) completes as DONE', r.decision, { verdict: 'done', reason: 'done' });
}
eq('C9 one millisecond before the backstop: keep waiting',
    decidePoll(RUNNING, INITIAL_TRACKER, T0 + MAX_WAIT_MS - 1, T0).verdict, 'continue');
eq('C10 at the backstop: detached', decidePoll(RUNNING, INITIAL_TRACKER, T0 + MAX_WAIT_MS, T0),
    { verdict: 'detached', reason: 'backstop' });

/* =============================================================================
 * D. A job that no longer exists
 * ========================================================================== */

{
    const GONE = { kind: 'gone' };
    let t = INITIAL_TRACKER;
    const seq: string[] = [];
    for (let i = 1; i <= GONE_STREAK_FAIL; i += 1) {
        const d = decidePoll(GONE, t, T0 + i * 2500, T0);
        seq.push(d.verdict === 'continue' ? 'continue' : `${d.verdict}:${d.reason}`);
        if (d.verdict === 'continue') t = d.tracker;
    }
    eq('D1 404s are tolerated until the streak, then the job is gone',
        seq, [...Array(GONE_STREAK_FAIL - 1).fill('continue'), 'failed:vanished']);
    eq('D2 the streak is at least 2 (one stray 404 is not a verdict)', GONE_STREAK_FAIL >= 2, true);
}
{
    const GONE = { kind: 'gone' };
    let t = INITIAL_TRACKER;
    const walk = [GONE, GONE, RUNNING, GONE, GONE];
    let last = 'continue';
    walk.forEach((o, i) => {
        const d = decidePoll(o, t, T0 + (i + 1) * 2500, T0);
        last = d.verdict;
        if (d.verdict === 'continue') t = d.tracker;
    });
    eq('D3 a live observation resets the 404 streak', last, 'continue');
}
{
    const walk = [{ kind: 'gone' }, { kind: 'gone' }, { kind: 'error' }, { kind: 'gone' }, { kind: 'gone' }];
    let t = INITIAL_TRACKER;
    let last = 'continue';
    walk.forEach((o, i) => {
        const d = decidePoll(o, t, T0 + (i + 1) * 2500, T0);
        last = d.verdict;
        if (d.verdict === 'continue') t = d.tracker;
    });
    eq('D4 a poll error also breaks a 404 streak (only CONSECUTIVE 404s count)', last, 'continue');
}

/* =============================================================================
 * E. Lost contact - poll errors are not failures
 * ========================================================================== */

{
    // Build 353: 24 consecutive null polls (~60 s) returned 'failed'.
    let t = INITIAL_TRACKER;
    let last = 'continue';
    for (let i = 1; i <= 24; i += 1) {
        const d = decidePoll({ kind: 'error' }, t, T0 + i * 2500, T0);
        last = d.verdict;
        if (d.verdict === 'continue') t = d.tracker;
    }
    eq('E1 a minute of poll errors is not a failure', last, 'continue');
}
{
    const r = simulate(() => ({ kind: 'error' }), 100000);
    eq('E2 sustained poll errors DETACH the arm (still running on the server), never fail it',
        r.decision, { verdict: 'detached', reason: 'lost_contact' });
    check('E3 ...after LOST_CONTACT_MS measured from the FIRST error',
        r.elapsedMs >= LOST_CONTACT_MS && r.elapsedMs < LOST_CONTACT_MS + SLOW_POLL_MS + FAST_POLL_MS,
        `detached at ${r.elapsedMs} ms`);
}
{
    const first = T0 + MIN;
    const a = decidePoll({ kind: 'error' }, INITIAL_TRACKER, first, T0);
    const b = a.verdict === 'continue' ? decidePoll({ kind: 'error' }, a.tracker, first + LOST_CONTACT_MS - 1, T0) : a;
    eq('E4 one millisecond short of LOST_CONTACT_MS keeps waiting', b.verdict, 'continue');
    const c = b.verdict === 'continue' ? decidePoll({ kind: 'error' }, b.tracker, first + LOST_CONTACT_MS, T0) : b;
    eq('E5 at LOST_CONTACT_MS: detached', c, { verdict: 'detached', reason: 'lost_contact' });
}
{
    // 14 minutes of errors, one good poll, 14 more minutes of errors: never detached.
    let t = INITIAL_TRACKER;
    let now = T0;
    let last = 'continue';
    const step = (o: unknown): void => {
        now += SLOW_POLL_MS;
        const d = decidePoll(o, t, now, T0);
        last = d.verdict;
        if (d.verdict === 'continue') t = d.tracker;
    };
    for (let i = 0; i < 84; i += 1) step({ kind: 'error' });
    step(RUNNING);
    for (let i = 0; i < 84; i += 1) step({ kind: 'error' });
    eq('E6 a live observation resets the lost-contact clock', last, 'continue');
}

/* =============================================================================
 * F. The poll schedule
 * ========================================================================== */

eq('F1 fast at dispatch', pollDelayMs(0), FAST_POLL_MS);
eq('F2 still fast just inside the window', pollDelayMs(FAST_POLL_WINDOW_MS - 1), FAST_POLL_MS);
eq('F3 slow from the window edge', pollDelayMs(FAST_POLL_WINDOW_MS), SLOW_POLL_MS);
eq('F4 slow a day in', pollDelayMs(MAX_WAIT_MS), SLOW_POLL_MS);
check('F5 the fast rate is the one build 353 used', FAST_POLL_MS === 2500, `${FAST_POLL_MS}`);
check('F6 slow polling still notices lost contact many times over',
    LOST_CONTACT_MS / SLOW_POLL_MS >= 30, `${LOST_CONTACT_MS / SLOW_POLL_MS} polls`);
// The documented contract (design note section 11, the panel's own copy, the
// docs): checks that read these constants move with them, so pin the values.
eq('F7 documented thresholds: backstop 24 h, lost contact 15 min, 3 x 404, slow 10 s after 5 min',
    [MAX_WAIT_MS, LOST_CONTACT_MS, GONE_STREAK_FAIL, SLOW_POLL_MS, FAST_POLL_WINDOW_MS],
    [86400000, 900000, 3, 10000, 300000]);

/* =============================================================================
 * G. Row outcomes survive the post-run refresh and keep the worst verdict
 * ========================================================================== */

eq('G1 a clean done leaves no outcome', mergeRowOutcome(undefined, 'done', 's1'), undefined);
eq('G2 a failure', mergeRowOutcome(undefined, 'failed', 's1'), { status: 'error', sids: [] });
eq('G3 a detached arm records its search ID', mergeRowOutcome(undefined, 'detached', 's1'),
    { status: 'detached', sids: ['s1'] });
eq('G4 a later failure outranks detached and keeps the ID',
    mergeRowOutcome({ status: 'detached', sids: ['s1'] }, 'failed', 's2'), { status: 'error', sids: ['s1'] });
eq('G5 detached never downgrades an error, but its ID is kept',
    mergeRowOutcome({ status: 'error', sids: [] }, 'detached', 's3'), { status: 'error', sids: ['s3'] });
eq('G6 truncated outranks detached',
    mergeRowOutcome({ status: 'detached', sids: ['s1'] }, 'truncated', 's2'), { status: 'truncated', sids: ['s1'] });
eq('G7 detached does not downgrade truncated',
    mergeRowOutcome({ status: 'truncated', sids: [] }, 'detached', 's4'), { status: 'truncated', sids: ['s4'] });
eq('G8 a clean done never erases an earlier problem',
    mergeRowOutcome({ status: 'error', sids: [] }, 'done', 's5'), { status: 'error', sids: [] });
eq('G9 a detached arm without a search ID adds none',
    mergeRowOutcome({ status: 'detached', sids: ['s1'] }, 'detached', null), { status: 'detached', sids: ['s1'] });
{
    // Unfrozen on purpose: a frozen object only THROWS on mutation in strict
    // mode, so comparing afterwards is the check that holds in any mode.
    const prior = { status: 'detached', sids: ['s1'] };
    mergeRowOutcome(prior, 'detached', 's2');
    mergeRowOutcome(prior, 'failed', 's3');
    eq('G10 merging never mutates the prior outcome', prior, { status: 'detached', sids: ['s1'] });
}

/* =============================================================================
 * H. Purity
 * ========================================================================== */

{
    // Unfrozen on purpose, compared afterwards (see G10).
    const tracker = { errorSinceMs: T0, goneStreak: 1 };
    decidePoll({ kind: 'error' }, tracker, T0 + MIN, T0);
    decidePoll({ kind: 'gone' }, tracker, T0 + MIN, T0);
    decidePoll(RUNNING, tracker, T0 + MIN, T0);
    eq('H1 decidePoll never mutates the tracker it is given', tracker, { errorSinceMs: T0, goneStreak: 1 });
    eq('H2 INITIAL_TRACKER is the empty state', INITIAL_TRACKER, { errorSinceMs: null, goneStreak: 0 });
    decidePoll({ kind: 'gone' }, INITIAL_TRACKER, T0 + MIN, T0);
    decidePoll({ kind: 'error' }, INITIAL_TRACKER, T0 + MIN, T0);
    eq('H3 ...including the shared INITIAL_TRACKER', INITIAL_TRACKER, { errorSinceMs: null, goneStreak: 0 });
}

/* ===================================================================== */

if (bpFailures > 0) {
    bpProc.stderr.write(`\nbackfillPoll.consistency-test: ${bpFailures} failure(s) of ${bpChecks}\n`);
    bpProc.exit(1);
}
console.log(`backfillPoll.consistency-test: OK (${bpChecks} checks)`);
