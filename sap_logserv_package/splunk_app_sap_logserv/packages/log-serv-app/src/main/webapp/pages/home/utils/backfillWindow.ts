/**
 * Backfill window resolution + monthly chunking for Settings -> Dashboard Data.
 *
 * WHY THIS IS ITS OWN MODULE. The arithmetic is the part that can be wrong in a
 * way nothing visibly complains about — an off-by-one at a month boundary
 * silently leaves an hour of rollup unbuilt, and a timezone slip moves a whole
 * window. Keeping it out of the panel lets backfillWindow.consistency-test.ts
 * exercise it against a frozen clock instead of whatever date the suite happens
 * to run on (session-128 sticky 12).
 *
 * DESIGN NOTE — everything here is UTC, deliberately. Splunk's search head
 * resolves an absolute time STRING in its own timezone, which is not
 * necessarily the box's (session-116: SH-rendered timestamps are SH-local even
 * on a UTC box). So the panel sends epoch integers, and the only place a
 * calendar exists is here.
 *
 * Design: rollup_backfill_window_design_v0.1_20260923.md. Session 131.
 */

/** Rollup retention is -365d in all 29 *_retention searches. A backfill earlier
 *  than this rebuilds rows the nightly retention run then deletes. */
export const RETENTION_DAYS = 365;

/** Preset offering. 30 stays first because it is the post-install default and
 *  the overwhelmingly common case. */
export const PRESET_DAYS: readonly number[] = [30, 60, 90, 180, 365];

/** The preset the panel starts on — identical to the pre-session-131 hardcoded
 *  window, so an operator who never touches the picker gets exactly the old
 *  behaviour. */
export const DEFAULT_PRESET_DAYS = 30;

export type WindowChoice =
    | { kind: 'preset'; days: number }
    | { kind: 'custom'; from: string; to: string }; // both 'YYYY-MM-DD', UTC

export interface ResolvedWindow {
    /** Inclusive start, epoch SECONDS (what Splunk's earliest_time takes). */
    earliest: number;
    /** Exclusive end, epoch SECONDS. */
    latest: number;
    /** Human label for the run summary, e.g. "last 90 days" / "2025-06-01 to 2025-06-30". */
    label: string;
    /** Days the window covers AS AN OPERATOR COUNTS THEM, for the summary line
     *  and the cost warning: a preset's own N (it reaches N whole UTC days back,
     *  plus today so far), a custom range's INCLUSIVE count of the dates it
     *  names, its end capped at today. (The count follows the NAMED dates, not
     *  the window's last complete hour: in the 00:xx hour a range ending today
     *  has no complete hour of today in it, and counting from the window's end
     *  read one day short - session 132, found on the deployed build 354.)
     *  Deliberately independent of the hour of day. Build 353 used
     *  Math.round((latest - earliest) / day), and because a preset starts at a
     *  UTC midnight but ends at the current HOUR, "last 30 days" read
     *  "31 day(s)" after 12:00 UTC and the > 90-day warning appeared on the
     *  90-day preset in the afternoon only (session 132). */
    days: number;
}

/** The cost-warning threshold, in `days`. Strictly greater: the 90-day preset
 *  does not warn, 180 and 365 always do. */
export const COST_WARNING_DAYS = 90;

export const isCostlyWindow = (w: ResolvedWindow): boolean => w.days > COST_WARNING_DAYS;

const MS_DAY = 86400000;
const MS_HOUR = 3600000;

const startOfUtcDay = (ms: number): number => {
    const d = new Date(ms);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
};

const startOfUtcHour = (ms: number): number => Math.floor(ms / MS_HOUR) * MS_HOUR;

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Parse 'YYYY-MM-DD' as UTC midnight. Returns null for a malformed string OR a
 *  date the calendar does not have — `Date.UTC(2025, 1, 30)` silently rolls
 *  into March, so the round-trip check is what rejects 2025-02-30. */
export const parseUtcDate = (s: string): number | null => {
    const m = DATE_RE.exec((s || '').trim());
    if (!m) return null;
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    if (mo < 1 || mo > 12 || d < 1 || d > 31 || y < 1970 || y > 9999) return null;
    const ms = Date.UTC(y, mo - 1, d);
    const back = new Date(ms);
    if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) {
        return null;
    }
    return ms;
};

/** 'YYYY-MM-DD' for a UTC instant — for prefilling the custom inputs. */
export const toUtcDateString = (ms: number): string => {
    const d = new Date(ms);
    const p = (n: number): string => (n < 10 ? '0' + n : String(n));
    return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate());
};

/**
 * Resolve a choice against a clock. Returns a string on rejection rather than
 * throwing, because every rejection here is an operator-facing message.
 *
 * The two ends do different jobs, which is why they snap differently:
 *   earliest — snapped DOWN to a UTC day, matching how S3 partitions its
 *              prefixes (YYYY/MM/DD) and how the old `-30d@d` behaved.
 *   latest   — snapped DOWN to the hour. NEVER to the day: a `@d` end would
 *              discard every rollup bucket built so far today (standing project
 *              sticky, learned the hard way on clear+re-backfill windows).
 */
export const resolveWindow = (
    choice: WindowChoice,
    nowMs: number,
): { ok: true; window: ResolvedWindow } | { ok: false; error: string } => {
    const nowHour = startOfUtcHour(nowMs);
    const floor = startOfUtcDay(nowMs - RETENTION_DAYS * MS_DAY);

    let earliestMs: number;
    let latestMs: number;
    let label: string;
    /* Custom only: the last date the operator NAMED, for the day count. */
    let lastDayMs = 0;

    if (choice.kind === 'preset') {
        if (!(choice.days > 0)) return { ok: false, error: 'Pick a window length.' };
        earliestMs = startOfUtcDay(nowMs - choice.days * MS_DAY);
        latestMs = nowHour;
        label = 'last ' + choice.days + ' days';
    } else {
        const from = parseUtcDate(choice.from);
        const to = parseUtcDate(choice.to);
        if (from === null || to === null) {
            return { ok: false, error: 'Enter both dates as YYYY-MM-DD (UTC).' };
        }
        earliestMs = from;
        lastDayMs = to;
        /* End-exclusive at the START of the day after `to`, so picking
         * 2025-06-30 includes all of 30 June. That instant is midnight, which
         * is already hour-aligned, so the @h rule is satisfied by construction. */
        const toDate = new Date(to);
        latestMs = Date.UTC(toDate.getUTCFullYear(), toDate.getUTCMonth(), toDate.getUTCDate() + 1);
        if (latestMs > nowHour) latestMs = nowHour; // never ask for the future
        label = toUtcDateString(earliestMs) + ' to ' + choice.to;
    }

    if (latestMs <= earliestMs) {
        return { ok: false, error: 'The start of the window must be before its end.' };
    }
    if (earliestMs < floor) {
        return {
            ok: false,
            error:
                'That start date is older than the ' + RETENTION_DAYS + '-day rollup retention '
                + 'window, so the nightly retention run would delete the rebuilt rows. Earliest '
                + 'usable date is ' + toUtcDateString(floor) + '.',
        };
    }

    return {
        ok: true,
        window: {
            earliest: Math.floor(earliestMs / 1000),
            latest: Math.floor(latestMs / 1000),
            label,
            days: choice.kind === 'preset'
                ? choice.days
                /* inclusive count of the NAMED dates, the end capped at today
                 * (a future `to` is clamped to now for the window, so it must
                 * not inflate the count either). */
                : Math.floor((Math.min(lastDayMs, startOfUtcDay(nowMs)) - earliestMs) / MS_DAY) + 1,
        },
    };
};

export interface Chunk {
    /** epoch SECONDS, inclusive start */
    earliest: number;
    /** epoch SECONDS, exclusive end */
    latest: number;
    /** "Jun 2025" — shown in the progress line so a failure names its month. */
    label: string;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Split a window at UTC CALENDAR-MONTH boundaries.
 *
 * Calendar months rather than fixed 30-day slices for two reasons: a month
 * boundary is also a DAY boundary, which is what makes the day-scoped rollups
 * (beaconing / beaconing_detail, and every hourly one) safe to chunk — no day
 * or hour is ever split across two chunks; and a failure names a month an
 * operator can re-run, rather than an anonymous slice. The 28-vs-31 day cost
 * variance is immaterial next to the per-arm ceiling this exists to stay under.
 *
 * Guarantees, asserted in the consistency test: chunks are contiguous, ordered,
 * non-overlapping, and cover [earliest, latest) exactly.
 */
/** The longest window dispatched WHOLE, in days. One calendar month is already
 *  the size of a chunk, so splitting a window this short at a month boundary
 *  only multiplies the dispatches: build 353 ran the 30-day default -- which
 *  crosses a month boundary on almost every day of the year -- as TWO chunks,
 *  where it had always run as one. 31 = the longest calendar month, which also
 *  covers the 30-day preset at any hour (30 days + at most 23 hours). */
export const MAX_UNCHUNKED_DAYS = 31;

/**
 * What the panel dispatches: the window whole when it is no longer than
 * MAX_UNCHUNKED_DAYS, otherwise monthChunks unchanged. A whole window comes back
 * as ONE unlabelled chunk covering [earliest, latest) exactly, so the caller
 * handles both cases with the same loop.
 */
export const planChunks = (earliest: number, latest: number): Chunk[] => {
    if (!(latest > earliest)) return [];
    if (latest - earliest <= MAX_UNCHUNKED_DAYS * 86400) {
        return [{ earliest, latest, label: '' }];
    }
    return monthChunks(earliest, latest);
};

export const monthChunks = (earliest: number, latest: number): Chunk[] => {
    const out: Chunk[] = [];
    if (!(latest > earliest)) return out;
    let cur = earliest * 1000;
    const endMs = latest * 1000;
    /* Bounded: each pass advances `cur` to the next month start, so the loop
     * runs once per calendar month in the window. The cap is a backstop against
     * a future caller handing us a nonsense range, not an expected path. */
    for (let guard = 0; guard < 1000 && cur < endMs; guard += 1) {
        const d = new Date(cur);
        const nextMonth = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
        const stop = nextMonth < endMs ? nextMonth : endMs;
        out.push({
            earliest: Math.floor(cur / 1000),
            latest: Math.floor(stop / 1000),
            label: MONTHS[d.getUTCMonth()] + ' ' + d.getUTCFullYear(),
        });
        cur = stop;
    }
    return out;
};
