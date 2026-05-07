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
const estimateWindowSeconds = (earliest: string, latest: string): number => {
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
