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
