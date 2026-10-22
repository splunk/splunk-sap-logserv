/**
 * How Settings -> Dashboard Data measures each rollup's History cell.
 *
 * WHY THIS IS ITS OWN MODULE (session 144, build 370). Every row's history is a
 * oneshot search - `| inputlookup <collection> | stats count, min(<bucket>)` -
 * and the panel used to fire all of them at once: 27 searches (23 single rows,
 * Beaconing 2, Environment Topology graph 2). Any response that was not HTTP OK
 * became the muted dash the History column also uses for "not measured", so it
 * read like missing data. In the field, right after a successful 30-day
 * backfill, 17 of 25 rows showed the dash: the checks that found the search
 * head's slots taken (the backfill's last searches, the hourly aggregates) came
 * back as errors. A check that RAN and failed was worse: a missing lookup
 * definition answers HTTP 200 with ERROR messages and a zero row, which read
 * "empty".
 *
 * THE POLICY:
 *   - at most CHECK_CONCURRENCY checks in flight per panel (createLimiter);
 *   - a check Splunk did not run now - HTTP 429 or 5xx, no response, or a
 *     message saying the search was not executed or hit a concurrency limit -
 *     is BUSY and is retried after CHECK_RETRY_DELAYS_MS, keeping its slot so
 *     the panel backs off as a whole;
 *   - a check that ran and failed, or was refused for good (any other 4xx, a
 *     FATAL or ERROR message, a body with no results), is FAILED at once -
 *     retrying cannot help;
 *   - once one check of a batch (one refresh) has used all its retries, every
 *     later check of that batch gets a single attempt, so a saturated search
 *     head costs about 14 seconds, not minutes;
 *   - the panel shows a check that produced no measurement as "check failed",
 *     with the reason on hover - never the dash and never "empty".
 *
 * Pure apart from the promises it is handed: no fetch, no timers, no clock.
 * historyCheck.consistency-test.ts pins every branch.
 */

/** One attempt at a history check, reduced to what the policy needs. */
export type CheckAttempt =
    | { kind: 'ok'; n: number; m: number }
    /** Splunk did not run the search now - worth another try. */
    | { kind: 'busy'; reason: string }
    /** The search ran and failed, or was refused for good - another try cannot help. */
    | { kind: 'failed'; reason: string };

/** What one check came to after its retries. */
export type CheckResult =
    | { ok: true; n: number; m: number; attempts: number }
    | { ok: false; busy: boolean; reason: string; attempts: number };

/** State shared by the checks of one refresh. */
export interface CheckBatch {
    /** Set once a check has used all its retries: later checks get one attempt. */
    saturated: boolean;
    /** True once nobody is waiting for the answer (the panel unmounted). */
    stopped: () => boolean;
}

/** Checks in flight at once, per panel. The backfill runs 3 searches of its own
 *  (the panel's CONCURRENCY); 3 more keep the two together inside Splunk's
 *  default limit even on a 1-CPU search head (6 + 1 per CPU). */
export const CHECK_CONCURRENCY = 3;

/** Waits before the 2nd, 3rd and 4th attempt of a busy check (ms). */
export const CHECK_RETRY_DELAYS_MS: readonly number[] = [2000, 4000, 8000];

/** The reason a check gives when it stopped because nobody is waiting. */
export const STOPPED_REASON = 'stopped: the panel closed';

/** Splunk's words for "not run now": the concurrency limit (system-wide or the
 *  role's quota - "The maximum number of concurrent historical searches ...")
 *  and the "Search not executed" family. */
const BUSY_TEXT = /maximum number of concurrent|search not executed/i;

/** The first FATAL or ERROR message Splunk put in the response, if any. */
export const firstErrorText = (body: unknown): string | null => {
    const msgs = (body as { messages?: unknown } | null | undefined)?.messages;
    if (!Array.isArray(msgs)) return null;
    for (const m of msgs) {
        const type = String((m as { type?: unknown } | null)?.type ?? '').toUpperCase();
        const text = (m as { text?: unknown } | null)?.text;
        if ((type === 'FATAL' || type === 'ERROR') && typeof text === 'string' && text.trim()) {
            return text.trim();
        }
    }
    return null;
};

/** Classify one oneshot response (HTTP status + parsed JSON body, or null). */
export const classifyCheckResponse = (status: number, body: unknown): CheckAttempt => {
    const err = firstErrorText(body);
    if (err !== null && BUSY_TEXT.test(err)) return { kind: 'busy', reason: err };
    if (status === 429 || status >= 500) return { kind: 'busy', reason: err ?? `HTTP ${status}` };
    if (status < 200 || status >= 300) return { kind: 'failed', reason: err ?? `HTTP ${status}` };
    if (err !== null) return { kind: 'failed', reason: err };
    const results = (body as { results?: unknown } | null | undefined)?.results;
    if (!Array.isArray(results)) return { kind: 'failed', reason: 'the response carried no results' };
    const row = results[0] as { n?: unknown; m?: unknown } | undefined;
    if (!row) return { kind: 'ok', n: 0, m: 0 };
    return { kind: 'ok', n: Number(row.n) || 0, m: Number(row.m) || 0 };
};

/** Run one check with the retry policy. `attemptOnce` does the HTTP call and
 *  classifies it; a throw counts as busy (no response). `sleep` is the wait
 *  between attempts. */
export const runCheck = async (
    attemptOnce: () => Promise<CheckAttempt>,
    sleep: (ms: number) => Promise<void>,
    batch: CheckBatch,
    delays: readonly number[] = CHECK_RETRY_DELAYS_MS,
): Promise<CheckResult> => {
    let attempts = 0;
    for (;;) {
        if (batch.stopped()) return { ok: false, busy: false, reason: STOPPED_REASON, attempts };
        let a: CheckAttempt;
        try {
            a = await attemptOnce();
        } catch (e) {
            const msg = e instanceof Error && e.message ? e.message : '';
            a = { kind: 'busy', reason: msg ? `no response from Splunk (${msg})` : 'no response from Splunk' };
        }
        attempts += 1;
        if (a.kind === 'ok') return { ok: true, n: a.n, m: a.m, attempts };
        if (a.kind === 'failed') return { ok: false, busy: false, reason: a.reason, attempts };
        const retriesUsed = attempts - 1;
        if (batch.saturated || retriesUsed >= delays.length) {
            batch.saturated = true;
            return { ok: false, busy: true, reason: a.reason, attempts };
        }
        await sleep(delays[retriesUsed]);
    }
};

/** A FIFO limiter: at most `max` tasks run at once; the rest wait their turn.
 *  A task that throws or rejects still frees its slot. */
export const createLimiter = (max: number): (<T>(task: () => Promise<T>) => Promise<T>) => {
    let active = 0;
    const waiting: Array<() => void> = [];
    const pump = (): void => {
        while (active < max && waiting.length > 0) {
            active += 1;
            const start = waiting.shift() as () => void;
            start();
        }
    };
    return <T>(task: () => Promise<T>): Promise<T> =>
        new Promise<T>((resolve, reject) => {
            waiting.push(() => {
                let p: Promise<T>;
                try {
                    p = task();
                } catch (e) {
                    p = Promise.reject(e);
                }
                p.then(
                    (v) => {
                        active -= 1;
                        pump();
                        resolve(v);
                    },
                    (e) => {
                        active -= 1;
                        pump();
                        reject(e);
                    },
                );
            });
            pump();
        });
};

/** The History cell's hover text for a check that produced no measurement. */
export const describeCheckFailure = (
    collection: string,
    r: { busy: boolean; reason: string; attempts: number },
): string =>
    r.busy
        ? `${collection}: Splunk did not run the check (${r.reason})`
          + (r.attempts > 1 ? ` — tried ${r.attempts} times` : '')
        : `${collection}: the check failed (${r.reason})`;
