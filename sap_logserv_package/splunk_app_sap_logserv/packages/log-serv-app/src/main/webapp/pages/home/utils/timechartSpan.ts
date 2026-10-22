/**
 * Choose a sensible `timechart span=...` value based on the current
 * time range. Returns a Splunk-formatted span string ('1m', '15m',
 * '1h', '6h', '1d') tuned to keep timechart output around 30–200
 * data points across a wide variety of windows.
 *
 * Why dynamic spans matter: a hard-coded `span=1h` produces ~720
 * data points for a 30-day window, which collapses into visual noise
 * on any chart narrower than ~1500 px. Recomputing per time range
 * keeps the same chart readable across "Last 1 hour" and "Last 90 days".
 *
 * Usage in a dashboard:
 *
 *   const { timeRange } = useTimeRange();
 *   const span = chooseTimechartSpan(timeRange.earliest, timeRange.latest);
 *   const query = `... | timechart span=${span} count`;
 */
/**
 * Placeholder written into the module-level query strings of every dashboard,
 * substituted at the same `useMemo` boundary that already applies
 * `mapCloudProviderQueries`. Build 345.
 *
 * WHY A TOKEN. The query objects are module-level constants, so `span` — which
 * depends on the live time range — cannot be interpolated where they are
 * written. Substituting where the cloud-provider splice already happens keeps
 * it to one insertion point per dashboard.
 *
 * WHY BOTH ARMS. `utils/rawTwin.ts` keys its map on the EXACT dispatched SPL
 * string, and its contract is that every transform is applied to the cached
 * AND raw arms BEFORE `useRoutedQuery` picks between them. A span substitution
 * applied to only one arm would silently break twin resolution.
 */
export const SPAN_TOKEN = '__LSV_SPAN__';

/** Seconds per span string this module can emit — used only to decide whether
 *  a span is finer than the rollup's bucket size. */
const SPAN_SECONDS: Readonly<Record<string, number>> = {
    '1m': 60,
    '15m': 900,
    '1h': 3600,
    '6h': 21600,
    '1d': 86400,
};

/** The KV rollups are bucketed HOURLY (`bucket_ts`), so no query reading them
 *  can resolve finer than this however narrow the window is. */
const ROLLUP_MIN_SPAN = '1h';

/**
 * Substitute `SPAN_TOKEN` in one SPL string, clamping to the rollup's floor
 * when the query reads rollup rows.
 *
 * The clamp keys on `bucket_ts` — the marker of a KV-rollup read — and
 * deliberately NOT on `tstats`: a `tstats ... BY _time span=...` runs over the
 * index via `sap_logserv_idx_macro`, not over the rollup, so it can bucket as
 * finely as the window deserves.
 *
 * In practice the clamp is belt-and-braces: `shouldUseRawSource` already routes
 * any window under 90 minutes to the raw arm, so a rollup query is not
 * dispatched at a width where sub-hour spans would arise. It stays because that
 * threshold is a tuning knob (`HYBRID_RAW_MAX_SPAN_SEC`) and lowering it should
 * not silently produce empty rollup charts.
 */
export const applySpanToken = (spl: string, span: string): string => {
    if (!spl.includes(SPAN_TOKEN)) return spl;
    const readsRollup = spl.includes('bucket_ts');
    const effective =
        readsRollup && (SPAN_SECONDS[span] ?? 0) < SPAN_SECONDS[ROLLUP_MIN_SPAN]
            ? ROLLUP_MIN_SPAN
            : span;
    return spl.split(SPAN_TOKEN).join(effective);
};

/** Map `applySpanToken` over a dashboard's query object. Returns the SAME
 *  object when nothing carries the token, so a dashboard that opted out costs
 *  no extra renders. */
export const applySpanTokens = <T extends Record<string, string>>(
    queries: T,
    span: string,
): T => {
    let changed = false;
    const out = {} as Record<string, string>;
    (Object.keys(queries) as Array<keyof T & string>).forEach((k) => {
        const next = applySpanToken(queries[k], span);
        if (next !== queries[k]) changed = true;
        out[k] = next;
    });
    return changed ? (out as T) : queries;
};

export const chooseTimechartSpan = (earliest: string, latest: string): string => {
    const sec = estimateWindowSeconds(earliest, latest);
    if (sec <= 6 * 3600) return '1m';            // ≤6h → ~360 pts
    if (sec <= 24 * 3600) return '15m';          // ≤24h → ~96 pts
    if (sec <= 7 * 86400) return '1h';           // ≤7d → ~168 pts
    if (sec <= 30 * 86400) return '6h';          // ≤30d → ~120 pts
    if (sec <= 90 * 86400) return '1d';          // ≤90d → ~90 pts
    return '1d';                                 // longer — daily, capped
};

/**
 * Best-effort estimate of a Splunk time range in seconds.
 *
 * Recognized inputs:
 *   - "now", "rt"                                 → 0 (relative to itself)
 *   - "0"                                          → -∞ (full retention / all time)
 *   - ISO-ish dates "2026-03-01T00:00:00.000Z"     → parsed via Date.parse
 *   - Splunk relative "[+-]N{unit}[@unit2]"        → unit math, snap-suffix ignored
 *     (units: s, m, h, d, w, mon, y)
 *   - Real-time prefix "rt..." stripped first      → "rt-7h" treated as "-7h"
 *
 * Returns absolute seconds between earliest and latest. Falls back to
 * 30 days for unparseable inputs so the caller still gets a sensible
 * default span.
 */
export const estimateWindowSeconds = (earliest: string, latest: string): number => {
    if (!earliest || earliest === '0') return 365 * 86400; // "all time" — assume long
    const e = parseRelativeOffsetSeconds(earliest);
    const l = parseRelativeOffsetSeconds(latest);
    if (e === null || l === null) return 30 * 86400;
    return Math.abs(l - e);
};

const parseRelativeOffsetSeconds = (s: string): number | null => {
    if (!s) return null;
    if (s === 'now' || s === 'rt') return 0;

    // ISO-ish date
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
        const t = Date.parse(s);
        if (Number.isFinite(t)) return Math.floor((t - Date.now()) / 1000);
        return null;
    }

    // Strip leading "rt" (real-time prefix). Strip "@unit" snap suffix —
    // it doesn't change the window length.
    const stripped = s.replace(/^rt/, '').replace(/@.*$/, '');

    if (stripped === '0') return -Number.MAX_SAFE_INTEGER;

    // Splunk relative: [+-]N{unit}  (unit is mon|s|m|h|d|w|y, mon must
    // be matched first to avoid greedy 'm' eating it).
    const m = stripped.match(/^([+-]?)(\d+)(mon|[smhdwy])$/);
    if (!m) return null;

    const sign = m[1] === '-' ? -1 : 1;
    const n = parseInt(m[2], 10);
    const unit = m[3];
    const mult: Record<string, number> = {
        s: 1,
        m: 60,
        h: 3600,
        d: 86400,
        w: 7 * 86400,
        mon: 30 * 86400,
        y: 365 * 86400,
    };
    return sign * n * (mult[unit] ?? 0);
};

/* ---------------------------------------------------------------------------
 * Span labels (build 377).
 *
 * The CLAUDE.md "Dynamic timechart span" rule says every range-following chart
 * shows its span in the subtitle. The span a chart DRAWS is not always the one
 * chooseTimechartSpan picked: applySpanToken clamps rollup reads (`bucket_ts`)
 * to 1h, and the hybrid routing sends windows under 90 minutes to the raw arm.
 * So the label is read from the SPL that is actually dispatched, never from
 * the picked span.
 * ------------------------------------------------------------------------- */

/** The bin width a dispatched query draws at: the span of its LAST `timechart`
 *  (a `tstats ... BY _time span=` pre-bin comes first), or null when it has
 *  none or the token is still unsubstituted. */
export const timechartSpanOf = (spl: string): string | null => {
    let last: string | null = null;
    const re = /\btimechart\b[^|]*?\bspan\s*=\s*([0-9]+(?:mon|[smhdwy]))\b/g;
    for (let m = re.exec(spl); m; m = re.exec(spl)) last = m[1];
    return last;
};

/** A range-following chart's subtitle: "<lead> — span <X>[ — <tail>]". The
 *  span part is left out when the query has no readable timechart span. */
export const spanSubtitle = (lead: string, spl: string, tail?: string): string => {
    const s = timechartSpanOf(spl);
    return [lead, s ? `span ${s}` : null, tail || null].filter(Boolean).join(' — ');
};

/* ---------------------------------------------------------------------------
 * Sparkline tooltip times (build 377).
 *
 * A KPI sparkline's buckets are days in the dispatching Splunk user's time
 * zone (`span=1d` bins at that user's local midnight), and Splunk renders each
 * result's `_time` as ISO-8601 carrying that zone's offset, e.g.
 * "2026-10-07T00:00:00.000-05:00". Formatting it through `new Date(...)` and
 * toLocaleString printed the BROWSER's zone instead ("Oct 6, 7:00 PM" for a
 * Central-time Splunk user on a UTC browser). formatBucketTime prints the wall
 * clock written in the string, which is the Splunk user's zone.
 *
 * The beaconing rollups are stored by UTC day (`day_ts` = 00:00 UTC). Binned
 * into the user's local days, each UTC day lands under the previous local date
 * west of UTC. utcDayLabel prints the UTC date each point carries, labelled as
 * a UTC day. Both are pure functions of their arguments - no Date locale
 * formatting, no browser time zone; utcDayLabel's clock is a parameter that
 * defaults to now - so the build-time suite can pin them exactly.
 * ------------------------------------------------------------------------- */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAY_SECONDS = 86400;

/** "Oct 7, 2026" from the UTC calendar fields of `d`. */
const dateText = (d: Date): string => `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;

/** "12:00 AM" from the UTC clock fields of `d`. */
const clockText = (d: Date): string => {
    const h = d.getUTCHours();
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return `${h12}:${String(d.getUTCMinutes()).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
};

/** ISO-8601 as Splunk renders `_time`: date, time, optional seconds and
 *  fraction, optional offset (Z, +hh:mm, +hhmm or +hh). */
const ISO_TIME_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}(?::?\d{2})?)?$/;

/** The wall clock written in an ISO string (as a Date whose UTC fields ARE
 *  that wall clock) and its offset in seconds east of UTC (null when the
 *  string carries none). Null for anything that is not a valid ISO time. */
const parseIsoWallClock = (s: string): { wall: Date; offsetSec: number | null } | null => {
    const m = ISO_TIME_RE.exec(s.trim());
    if (!m) return null;
    const y = parseInt(m[1], 10);
    const mo = parseInt(m[2], 10);
    const d = parseInt(m[3], 10);
    const h = parseInt(m[4], 10);
    const mi = parseInt(m[5], 10);
    const se = m[6] ? parseInt(m[6], 10) : 0;
    if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || se > 59) return null;
    const wall = new Date(Date.UTC(y, mo - 1, d, h, mi, se));
    if (wall.getUTCFullYear() !== y || wall.getUTCMonth() !== mo - 1 || wall.getUTCDate() !== d) return null;
    let offsetSec: number | null = null;
    if (m[7] === 'Z') offsetSec = 0;
    else if (m[7]) {
        const om = /^([+-])(\d{2}):?(\d{2})?$/.exec(m[7]);
        if (!om) return null;
        const oh = parseInt(om[2], 10);
        const omi = om[3] ? parseInt(om[3], 10) : 0;
        if (oh > 23 || omi > 59) return null;
        offsetSec = (om[1] === '-' ? -1 : 1) * (oh * 3600 + omi * 60);
    }
    return { wall, offsetSec };
};

/** A sparkline bucket's time for its tooltip, in the Splunk user's zone:
 *  "Oct 7, 2026, 12:00 AM" read from the wall clock of Splunk's ISO `_time`.
 *  A bare number (epoch seconds) carries no zone, so it is printed in UTC and
 *  says so; a string that is not an ISO time is shown as it came. */
export const formatBucketTime = (raw: unknown): string | null => {
    if (raw === null || typeof raw === 'undefined' || raw === '') return null;
    if (typeof raw === 'number') {
        if (!Number.isFinite(raw)) return null;
        const d = new Date(raw * 1000);
        return `${dateText(d)}, ${clockText(d)} UTC`;
    }
    const s = String(raw);
    const p = parseIsoWallClock(s);
    return p ? `${dateText(p.wall)}, ${clockText(p.wall)}` : s;
};

/** Seconds since the epoch for a number, a numeric string, or an ISO time
 *  that carries its offset; null otherwise. */
const epochSecondsOf = (raw: unknown): number | null => {
    if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
    if (typeof raw !== 'string') return null;
    if (/^\s*-?\d+(?:\.\d+)?\s*$/.test(raw)) return parseFloat(raw);
    const p = parseIsoWallClock(raw);
    return p && p.offsetSec !== null ? p.wall.getTime() / 1000 - p.offsetSec : null;
};

/** The label of a UTC day. */
export const UTC_DAY_SUFFIX = ' (UTC day)';

/** The label of a UTC day that has not ended yet, so no rollup row can hold
 *  it: the beaconing aggregates write complete UTC days only. */
export const UTC_DAY_PENDING_SUFFIX = ' (UTC day, not yet computed)';

/** A beaconing sparkline point's tooltip date: the UTC day the point carries
 *  (`dayTs`, epoch seconds of its 00:00 UTC, as the rollup stores `day_ts`),
 *  labelled as a UTC day - "Oct 7, 2026 (UTC day)". A point that carries none
 *  (a day the timechart filled with 0) takes the first UTC midnight at or
 *  after its bin's start: a local-day bin holds exactly that one UTC day
 *  start in every fixed-offset zone. When that UTC day has not ended at
 *  `nowSec` (the in-progress day, and west of UTC the trailing bin's next
 *  day), its 0 is not a measurement and the label says so: "Oct 10, 2026
 *  (UTC day, not yet computed)". A carried day is a row the rollup holds and
 *  is never labelled pending. Null when neither can be read. */
export const utcDayLabel = (dayTs: unknown, binStart?: unknown, nowSec: number = Date.now() / 1000): string | null => {
    const carried = epochSecondsOf(dayTs);
    if (carried !== null && carried > 0) return `${dateText(new Date(carried * 1000))}${UTC_DAY_SUFFIX}`;
    const b = epochSecondsOf(binStart);
    if (b === null) return null;
    const t = Math.ceil(b / DAY_SECONDS) * DAY_SECONDS;
    const suffix = t + DAY_SECONDS > nowSec ? UTC_DAY_PENDING_SUFFIX : UTC_DAY_SUFFIX;
    return `${dateText(new Date(t * 1000))}${suffix}`;
};
