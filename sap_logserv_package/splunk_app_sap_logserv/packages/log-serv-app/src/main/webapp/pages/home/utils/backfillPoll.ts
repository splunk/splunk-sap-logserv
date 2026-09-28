/**
 * How the Settings -> Dashboard Data backfill waits on one dispatched search.
 *
 * WHY THIS IS ITS OWN MODULE. Until build 357 the panel gave up on a search
 * after a fixed number of polls (MAX_POLLS = 2000 at 2.5 s, roughly 90 minutes
 * of wall time) and reported it FAILED - while the search itself kept running
 * on the server and kept writing rows. That is a false failure, and the natural
 * response to one (re-run) repeats hours of work. Measured on the reference box
 * (session 132, a 365-day chunked run): the slowest single search took 42.1
 * minutes and 929 polls - 46% of the ceiling - and all ten slowest were the
 * Environment Topology detail rollup's June/July chunks. A customer with about
 * twice that box's volume would have hit the ceiling on every heavy month.
 *
 * THE POLICY - "wait on the job, not a clock" (user decision, session 134):
 *   - keep polling while Splunk reports the job alive (QUEUED, PARSING,
 *     RUNNING, PAUSED, FINALIZING - however long that takes);
 *   - report FAILED only when Splunk says so: dispatchState FAILED or isFailed,
 *     a dead search process (isZombie), or a job that no longer exists (HTTP
 *     404 on GONE_STREAK_FAIL consecutive polls);
 *   - when the panel stops waiting for any other reason - the operator cancels,
 *     the MAX_WAIT_MS backstop, or LOST_CONTACT_MS without reaching Splunk - the
 *     search is DETACHED: "still running on the server", never "failed". The job
 *     keeps going (a REST-dispatched job has auto_cancel = 0) and writes its rows
 *     when it finishes;
 *   - polling slows from FAST_POLL_MS to SLOW_POLL_MS once a job has run for
 *     FAST_POLL_WINDOW_MS: a job that long gains nothing from 2.5 s polls, and a
 *     24-hour wait at 2.5 s would be ~34,000 status requests for one search.
 *
 * Pure: no fetch, no clock reads, no timers. The panel supplies the HTTP result
 * and the time; backfillPoll.consistency-test.ts pins every branch.
 *
 * Design: rollup_backfill_window_design (section 11, session 134).
 */

/** One poll of GET search/jobs/<sid>, reduced to what the policy needs. */
export type PollObservation =
    | { kind: 'state'; isDone: boolean; failed: boolean; zombie: boolean; truncated: boolean }
    /** HTTP 404: Splunk answered, and the job does not exist. */
    | { kind: 'gone' }
    /** Anything else: a network error, 401/403 (the session ended), a 5xx, an unreadable body. */
    | { kind: 'error' };

export interface PollTracker {
    /** When the current unbroken run of 'error' observations began (epoch ms);
     *  null when the last observation was not an error. */
    errorSinceMs: number | null;
    /** Consecutive 'gone' observations. */
    goneStreak: number;
}

export const INITIAL_TRACKER: Readonly<PollTracker> = { errorSinceMs: null, goneStreak: 0 };

/** What one arm-search came to, from the panel's point of view. */
export type ArmVerdict = 'done' | 'truncated' | 'failed' | 'detached';

export type WaitReason =
    | 'done'
    | 'truncated'
    | 'failed_state'
    | 'zombie'
    | 'vanished'
    | 'backstop'
    | 'lost_contact'
    | 'cancelled';

export type PollDecision =
    | { verdict: 'continue'; tracker: PollTracker }
    | { verdict: ArmVerdict; reason: WaitReason };

/** The backstop: the panel stops waiting after this long even if Splunk still
 *  reports the job alive, so the Run button always comes back. Reported as
 *  DETACHED, not failed. */
export const MAX_WAIT_MS = 24 * 60 * 60 * 1000;
/** Consecutive poll errors (not 404s) for this long -> stop waiting, DETACHED.
 *  Long enough to ride out a network blip or a Splunk Web restart; short enough
 *  that an ended session does not keep the panel busy for a day. */
export const LOST_CONTACT_MS = 15 * 60 * 1000;
/** Consecutive HTTP 404s before the job counts as gone (FAILED). A job cannot be
 *  reaped between polls - a finished ad-hoc job lives 10 minutes by default -
 *  so a repeated 404 means it was deleted or lost, and its rows may be partial. */
export const GONE_STREAK_FAIL = 3;
export const FAST_POLL_MS = 2500;
export const SLOW_POLL_MS = 10000;
export const FAST_POLL_WINDOW_MS = 5 * 60 * 1000;

/** Delay before the next poll, by how long the job has been running. */
export const pollDelayMs = (elapsedMs: number): number =>
    elapsedMs < FAST_POLL_WINDOW_MS ? FAST_POLL_MS : SLOW_POLL_MS;

/** Splunk's job flags arrive as JSON booleans, but older paths and proxies have
 *  been seen to stringify them. */
const truthy = (v: unknown): boolean => v === true || v === 1 || v === '1' || v === 'true';

/** Job messages that mean a search did not see all of its data. A top-level arm
 *  should never produce one; when one does, the rollup is flagged 'truncated'
 *  (re-run) rather than left silently short. Unchanged from build 353. */
export const TRUNCATION_RE = /time limit|auto.?finaliz|maxout|truncat|results may be incomplete/i;

/** Reduce one GET search/jobs/<sid> response to an observation. `body` is the
 *  parsed JSON, or null when there was none. */
export const observeJob = (httpStatus: number, body: unknown): PollObservation => {
    if (httpStatus === 404) return { kind: 'gone' };
    if (httpStatus < 200 || httpStatus >= 300) return { kind: 'error' };
    const entry = (body as { entry?: Array<{ content?: unknown }> } | null)?.entry?.[0];
    const c = entry?.content;
    if (!c || typeof c !== 'object') return { kind: 'error' };
    const content = c as Record<string, unknown>;
    const state = String(content.dispatchState ?? '');
    const messages = Array.isArray(content.messages) ? (content.messages as Array<{ text?: unknown }>) : [];
    return {
        kind: 'state',
        isDone: truthy(content.isDone),
        failed: state === 'FAILED' || truthy(content.isFailed),
        zombie: truthy(content.isZombie),
        truncated: messages.some((m) => TRUNCATION_RE.test(String((m && m.text) ?? ''))),
    };
};

/**
 * Decide what one observation means. `dispatchedAtMs` is when the job was
 * created, `nowMs` when the observation was taken - both wall-clock, so a
 * sleeping laptop or a throttled background tab cannot stretch the backstop.
 */
export const decidePoll = (
    obs: PollObservation,
    tracker: Readonly<PollTracker>,
    nowMs: number,
    dispatchedAtMs: number,
): PollDecision => {
    const overdue = nowMs - dispatchedAtMs >= MAX_WAIT_MS;
    if (obs.kind === 'state') {
        // Splunk's own verdicts first: a finished job is finished even at the backstop.
        if (obs.zombie) return { verdict: 'failed', reason: 'zombie' };
        if (obs.failed) return { verdict: 'failed', reason: 'failed_state' };
        if (obs.isDone) {
            return obs.truncated
                ? { verdict: 'truncated', reason: 'truncated' }
                : { verdict: 'done', reason: 'done' };
        }
        if (overdue) return { verdict: 'detached', reason: 'backstop' };
        return { verdict: 'continue', tracker: { errorSinceMs: null, goneStreak: 0 } };
    }
    if (obs.kind === 'gone') {
        const goneStreak = tracker.goneStreak + 1;
        if (goneStreak >= GONE_STREAK_FAIL) return { verdict: 'failed', reason: 'vanished' };
        if (overdue) return { verdict: 'detached', reason: 'backstop' };
        return { verdict: 'continue', tracker: { errorSinceMs: null, goneStreak } };
    }
    const errorSinceMs = tracker.errorSinceMs === null ? nowMs : tracker.errorSinceMs;
    if (nowMs - errorSinceMs >= LOST_CONTACT_MS) return { verdict: 'detached', reason: 'lost_contact' };
    if (overdue) return { verdict: 'detached', reason: 'backstop' };
    return { verdict: 'continue', tracker: { errorSinceMs, goneStreak: 0 } };
};

/** A rollup row's outcome from the last run, kept apart from the completeness
 *  state because the post-run refresh rebuilds that from scratch - before build
 *  357 it silently erased the "failed"/"truncated" marks the error banner told
 *  the operator to look for. */
export type RowOutcomeStatus = 'error' | 'truncated' | 'detached';
export interface RowOutcome {
    status: RowOutcomeStatus;
    /** Search IDs of the row's DETACHED arms, so the operator can find the jobs. */
    sids: string[];
}

const OUTCOME_RANK: Record<RowOutcomeStatus, number> = { detached: 1, truncated: 2, error: 3 };

/** Fold one arm's verdict into its row's outcome. The worst wins (error >
 *  truncated > detached); a clean 'done' never erases an earlier problem. */
export const mergeRowOutcome = (
    cur: RowOutcome | undefined,
    verdict: ArmVerdict,
    sid: string | null,
): RowOutcome | undefined => {
    const add: RowOutcomeStatus | null =
        verdict === 'failed' ? 'error' : verdict === 'truncated' ? 'truncated' : verdict === 'detached' ? 'detached' : null;
    if (add === null) return cur;
    const status = !cur || OUTCOME_RANK[add] > OUTCOME_RANK[cur.status] ? add : cur.status;
    const prior = cur ? cur.sids : [];
    const sids = verdict === 'detached' && sid ? prior.concat(sid) : prior;
    return { status, sids };
};
