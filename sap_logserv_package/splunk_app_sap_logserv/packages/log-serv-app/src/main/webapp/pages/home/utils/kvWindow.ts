/**
 * Reading only the rollup rows near a panel's time range (build 397).
 *
 * A rollup read is `| inputlookup <coll> where metric="m" | addinfo | where bucket_ts
 * in the range`: KV Store hands over every row of the metric, a year's worth, and SPL
 * throws away the ones outside the range. So a read costs the same at any range
 * (about 7 microseconds a row on the reference system), and a metric that gains a
 * `host` grain slows every panel reading it, filter or no filter.
 *
 * `where` on an `inputlookup` of a KV Store collection is answered by the KV Store,
 * through the (metric, bucket_ts) index every rollup has. Giving it a lower bound took
 * the largest metric from 6.4 s to 0.1 s at Last 7 days with the same rows. The bound
 * has to be a number in the SPL (the `where` takes no subsearch or function), so it is
 * worked out here, against the server's clock (utils/serverClock.ts): a browser clock
 * days fast would otherwise start the read late and lose rows. The `addinfo` range stays
 * as the exact filter: this only ever removes rows the range would remove anyway, provided
 * the bound is early enough, which is what KV_WINDOW_MARGIN_SEC and the snap handling are
 * for.
 *
 * Applied where the job is dispatched, nowhere else: a panel's `spl`, Open in Search,
 * Data Doctor and the raw-twin map keep the query as written.
 *
 * Build 398: ten more of the rollups the dashboards read in this shape take the bound too (not
 * Host Details', Multi-Cloud Overview's or Data Pipeline Overview's, nor the beaconing and
 * slow-trace rollups), and a job that would take one waits for the server's clock instead of
 * running without it (kvWindowNeedsClock, hooks/useSearch.ts).
 */

/** The collections whose reads take the bound: the six of build 397 and, from build 398, ten
 *  more that the dashboards read. Each has the (metric, bucket_ts) index
 *  (collections.conf `accelerated_fields.by_metric_bucket`), which is what makes the bound fast;
 *  without it the bound would still be right, only slower. */
export const KV_WINDOW_COLLECTIONS: readonly string[] = [
    'logserv_abapnet_rollup',
    'logserv_cloudconn_rollup',
    'logserv_compliance_rollup',
    'logserv_dns_rollup',
    'logserv_hana_category_rollup',
    'logserv_hana_trace_rollup',
    'logserv_linux_rollup',
    'logserv_perimeter_rollup',
    'logserv_proxy_rollup',
    'logserv_saprouter_rollup',
    'logserv_sapservices_rollup',
    'logserv_severity_rollup',
    'logserv_web_timing_rollup',
    'logserv_windows_rollup',
    'logserv_wp_perf_rollup',
    'logserv_xstack_auth_rollup',
];

/** How far before the range the bound sits, on top of the snap: a custom time with no
 *  zone is read in the browser's, and Splunk reads it in the user's, up to 26 hours apart. */
export const KV_WINDOW_MARGIN_SEC = 2 * 86400;

const UNIT_SEC: Readonly<Record<string, number>> = {
    s: 1,
    m: 60,
    h: 3600,
    d: 86400,
    w: 7 * 86400,
    // The longest a calendar unit can be: a bound may only err early.
    mon: 31 * 86400,
    q: 92 * 86400,
    y: 366 * 86400,
};

/**
 * A number of seconds since the epoch at or before the start of a Splunk `earliest`,
 * floored to a UTC day so the query is the same string all day. Null when it cannot be
 * sure: all time, a real-time window, a chained modifier, anything it does not parse, or
 * a relative time while `nowSec` is null (the server's clock is not known yet). A read
 * with no bound is slower, never wrong.
 */
export const kvWindowLowerBound = (earliest: string | null | undefined, nowSec: number | null): number | null => {
    if (!earliest) return null;
    let start: number | null = null;
    if (/^\d+(\.\d+)?$/.test(earliest)) {
        start = Number(earliest);
    } else if (/^\d{4}-\d{2}-\d{2}/.test(earliest)) {
        const t = Date.parse(earliest);
        if (Number.isFinite(t)) start = t / 1000;
    } else {
        // -7d, -24h@h, -1mon@mon, @d, @w0. The snap can move the start back by up to one
        // of its units (w0, w1, ... are weeks); the literal numbers in front of a snap unit
        // are not allowed by Splunk, so a plain table covers them.
        const m = /^(?:-(\d+)(s|m|h|d|w|mon|q|y))?(?:@(s|m|h|d|w[0-7]?|mon|q|y))?$/.exec(earliest);
        if (m && nowSec !== null) {
            const back = m[1] ? Number(m[1]) * UNIT_SEC[m[2]] : 0;
            const snap = m[3] ? UNIT_SEC[m[3].charAt(0) === 'w' ? 'w' : m[3]] : 0;
            start = nowSec - back - snap;
        }
    }
    if (start === null || !Number.isFinite(start)) return null;
    const bound = Math.floor((start - KV_WINDOW_MARGIN_SEC) / 86400) * 86400;
    return bound > 0 ? bound : null;
};

/** One rollup read in the exact shape the dashboards write. Any other shape is left as
 *  it is, and reads as it always has. */
const WINDOWED_READ =
    /(\|\s*inputlookup\s+([^\s|]+)\s+where\s+metric="[^"]*")(\s*\|\s*addinfo\s*\|\s*where\s+bucket_ts>=info_min_time AND bucket_ts<info_max_time)/g;

/** The query a job should run for this range. Unchanged when nothing in it qualifies. */
export const withKvWindow = (query: string, earliest: string | null | undefined, nowSec: number | null): string => {
    if (query.indexOf('inputlookup') === -1) return query;
    const bound = kvWindowLowerBound(earliest, nowSec);
    if (bound === null) return query;
    return query.replace(WINDOWED_READ, (match: string, read: string, collection: string, range: string) =>
        (KV_WINDOW_COLLECTIONS.indexOf(collection) === -1 ? match : `${read} AND bucket_ts>=${bound}${range}`));
};

/** A time far ahead, only to ask whether `earliest` is a form a clock would give a bound. */
const ANY_NOW_SEC = 4102444800; // 2100-01-01 UTC

/**
 * True when the query would take a bound once the server's clock is known, and has none
 * without it (build 398; the 397 audit's M5): a read on the list, in the shape above, over a
 * relative range. A job dispatched before the clock answers reads every stored row of its
 * metric, so `useSearch` holds such a query until the clock has answered or failed (at most
 * SERVER_CLOCK_TIMEOUT_MS). False for an absolute range (it needs no clock), for one that never
 * takes a bound (all time, real-time), and for every other query.
 */
export const kvWindowNeedsClock = (query: string, earliest: string | null | undefined): boolean => {
    if (query.indexOf('inputlookup') === -1) return false;
    if (kvWindowLowerBound(earliest, null) !== null) return false;
    if (kvWindowLowerBound(earliest, ANY_NOW_SEC) === null) return false;
    let found = false;
    query.replace(WINDOWED_READ, (match: string, read: string, collection: string) => {
        if (KV_WINDOW_COLLECTIONS.indexOf(collection) !== -1) found = true;
        return match;
    });
    return found;
};
