/**
 * Late-arriving data in Settings -> Dashboard Data (session 147, build 372).
 *
 * WHY THIS EXISTS. Each hourly *_aggregate reads its hour once, a few minutes
 * after the hour ends, and an event Splunk indexes after that run is never
 * counted - no rollup read ever sees it, because every panel wider than 90
 * minutes reads the rollup (utils/hybridRouting.ts). SAP LogServ data comes
 * from S3 / Azure Blob / GCS queues and does arrive late. Measured on the
 * reference box over 30 days (session 147): about 1.4% of real Azure events
 * arrived 1-5 minutes after their hour ended (missed by the aggregates that run
 * at :03-:08); the weekly linux_secure delivery (Sunday 00:00-03:00 UTC, up to
 * ~160 hours late) and a queue backlog drained after an outage (up to the
 * queue's 7-day message lifetime) arrived days late. The Multi-Cloud Overview
 * rollup lacked 0.33% of the month's Azure events and the Linux firewall metric
 * 18% of its events since 09-20 - every one of them an event that arrived after
 * the last backfill.
 *
 * WHAT CHANGED. The bucket-local hourly aggregates now re-scan the last TWO
 * complete hours (-2h@h..@h), which catches the minute-scale delays and repairs
 * a skipped run at the next hour. Re-scanning days on a schedule is not safe:
 * every rollup is a `| union` whose non-first arms are subsearches that Splunk
 * auto-finalizes at about 30 seconds (an 8-day re-scan of the topology detail
 * rollup hit it on the reference box), and a truncated arm would overwrite good
 * rows with lower counts. The App has no Python to dispatch arms one by one on
 * a schedule. So multi-day stragglers are FOUND here and REBUILT by the panel's
 * existing per-arm backfill, which has no such limit.
 *
 * HOW IT IS FOUND. One oneshot (the saved search LATE_CHECK_STANZA) compares
 * `| tstats count` of the indexed events with the Multi-Cloud Overview rollup
 * (joined through `inputlookup append=true`, never a subsearch - a subsearch's
 * row and time limits would truncate the reference and invent late days)
 * (logserv_mc_rollup, metric "count": one row per cloud provider, sourcetype
 * and hour, counting every event) per hour and sourcetype. Where the index
 * holds more than the rollup, the difference is events the rollups never saw:
 * late arrivals, an hour whose aggregate was skipped, a stretch with
 * aggregation switched off. The window starts at the later of LATE_CHECK_DAYS
 * ago and the rollup's oldest bucket (older hours were never aggregated at all)
 * and ends LATE_CHECK_SETTLE_HOURS before the current hour (younger hours can
 * still be rewritten by the schedule). Fewer events in the index than in the
 * rollup (deleted or frozen data) is never reported.
 *
 * Pure: no fetch, no timers, no clock. lateArrivals.consistency-test.ts pins it.
 */
import { resolveWindow, toUtcDateString } from './backfillWindow';
import type { ResolvedWindow } from './backfillWindow';

/** The saved search holding the check's SPL (default/savedsearches.conf). The
 *  panel reads its `search` and dispatches it with an epoch window, as it does
 *  the *_backfill stanzas. It also runs daily at 05:40 (search-head time) and
 *  records a triggered alert when it finds a day (build 373). */
export const LATE_CHECK_STANZA = 'logserv_late_arrival_check';

/** The rollup the check compares against (rollupRegistry key). */
export const LATE_CHECK_ROLLUP_KEY = 'mc';

/** How far back the check looks - the dashboards' default history. */
export const LATE_CHECK_DAYS = 30;

/** Hours before the current one that are not final yet. Bucket H is written
 *  last by the run at H+2h (minute :22 for the Multi-Cloud rollup; every
 *  aggregate fires by :28), so a bucket is final three hours after it starts
 *  plus at most 28 minutes - the start of the hour three hours back is the
 *  first instant every older bucket is settled. */
export const LATE_CHECK_SETTLE_HOURS = 3;

/** Days listed in the panel before "and N more days". */
export const LATE_LIST_MAX = 7;

const HOUR = 3600;
const DAY = 86400;

/** One UTC day with events the rollups do not hold. */
export interface LateDay {
    /** UTC midnight, epoch seconds. */
    dayTs: number;
    /** Events in the index beyond what the rollup holds, summed over the day. */
    missing: number;
    /** Hour-buckets of the day that are short. */
    hours: number;
    /** Sourcetypes that are short, sorted. */
    sourcetypes: string[];
}

/**
 * The check's window, [earliest, latest) in epoch seconds, or null when there
 * is nothing it can judge: an empty rollup (oldestBucketMs 0) or a rollup whose
 * history starts after the settle edge.
 */
export const lateCheckWindow = (
    nowMs: number,
    oldestBucketMs: number,
): { earliest: number; latest: number } | null => {
    if (!(oldestBucketMs > 0)) return null;
    const nowSec = Math.floor(nowMs / 1000);
    const latest = Math.floor(nowSec / HOUR) * HOUR - LATE_CHECK_SETTLE_HOURS * HOUR;
    const floor = Math.floor(nowSec / DAY) * DAY - LATE_CHECK_DAYS * DAY;
    const oldest = Math.ceil(oldestBucketMs / 1000 / HOUR) * HOUR;
    const earliest = Math.max(floor, oldest);
    return latest > earliest ? { earliest, latest } : null;
};

const toNum = (v: unknown): number => {
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) ? n : NaN;
};

/** Read the oneshot's result rows. A row that is not a whole UTC day with a
 *  positive count is dropped rather than guessed at; days come back sorted,
 *  each once. */
export const parseLateRows = (results: unknown): LateDay[] => {
    if (!Array.isArray(results)) return [];
    const byDay = new Map<number, LateDay>();
    for (const r of results) {
        const row = (r ?? {}) as Record<string, unknown>;
        const dayTs = toNum(row.day_ts);
        const missing = toNum(row.missing);
        const hours = toNum(row.hours);
        if (!Number.isInteger(dayTs) || dayTs % DAY !== 0 || !(missing > 0)) continue;
        const raw = row.sourcetypes;
        const sts = (Array.isArray(raw) ? raw : raw == null ? [] : [raw])
            .map((s) => String(s))
            .filter((s) => s.length > 0);
        const prev = byDay.get(dayTs);
        if (prev) {
            prev.missing += missing;
            prev.hours += hours > 0 ? hours : 0;
            prev.sourcetypes = Array.from(new Set(prev.sourcetypes.concat(sts))).sort();
        } else {
            byDay.set(dayTs, {
                dayTs,
                missing,
                hours: hours > 0 ? hours : 0,
                sourcetypes: Array.from(new Set(sts)).sort(),
            });
        }
    }
    return Array.from(byDay.values()).sort((a, b) => a.dayTs - b.dayTs);
};

/** Merge days into runs of consecutive UTC days, as inclusive 'YYYY-MM-DD'
 *  ranges in ascending order. Duplicates are ignored. */
export const dayRanges = (dayTs: number[]): Array<{ from: string; to: string }> => {
    const days = Array.from(new Set(dayTs)).sort((a, b) => a - b);
    const out: Array<{ from: string; to: string }> = [];
    let start = -1;
    let prev = -1;
    days.forEach((d) => {
        if (start < 0) {
            start = d;
        } else if (d !== prev + DAY) {
            out.push({ from: toUtcDateString(start * 1000), to: toUtcDateString(prev * 1000) });
            start = d;
        }
        prev = d;
    });
    if (start >= 0) out.push({ from: toUtcDateString(start * 1000), to: toUtcDateString(prev * 1000) });
    return out;
};

/**
 * The backfill windows that rebuild exactly the listed days: one custom window
 * per run of consecutive days, resolved by backfillWindow.resolveWindow (UTC
 * whole days, the end capped at the current hour, the 365-day floor enforced).
 * Any range it rejects fails the whole set - a partial rebuild must not report
 * success.
 */
export const lateBackfillWindows = (
    days: LateDay[],
    nowMs: number,
): { ok: true; windows: ResolvedWindow[] } | { ok: false; error: string } => {
    const ranges = dayRanges(days.map((d) => d.dayTs));
    if (ranges.length === 0) return { ok: false, error: 'No days to rebuild.' };
    const windows: ResolvedWindow[] = [];
    for (const r of ranges) {
        const res = resolveWindow({ kind: 'custom', from: r.from, to: r.to }, nowMs);
        if (!res.ok) return { ok: false, error: `${r.from} to ${r.to}: ${res.error}` };
        windows.push(res.window);
    }
    return { ok: true, windows };
};

/** Thousands separators without locale surprises. */
export const fmtCount = (n: number): string =>
    String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/** One panel line per day: "2026-09-26: 28,193 events in 42 hours (linux_secure, sap_logserv_logs)". */
export const describeLateDay = (d: LateDay): string =>
    `${toUtcDateString(d.dayTs * 1000)}: ${fmtCount(d.missing)} event${d.missing === 1 ? '' : 's'} in `
    + `${d.hours} hour${d.hours === 1 ? '' : 's'}`
    + (d.sourcetypes.length ? ` (${d.sourcetypes.join(', ')})` : '');

/** The panel's summary sentence for a non-empty result. */
export const summarizeLate = (days: LateDay[]): string => {
    const total = days.reduce((s, d) => s + d.missing, 0);
    const n = days.length;
    return `${fmtCount(total)} event${total === 1 ? '' : 's'} on ${n} day${n === 1 ? '' : 's'} `
        + `${total === 1 ? 'is' : 'are'} in the index but not in the rollups.`;
};
