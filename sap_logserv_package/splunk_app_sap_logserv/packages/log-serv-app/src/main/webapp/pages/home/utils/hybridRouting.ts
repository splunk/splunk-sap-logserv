import { estimateWindowSeconds } from './timechartSpan';

/**
 * Hybrid read-source routing (session 085) — pure, React-free so it stays
 * unit-testable (see hybridRouting.consistency-test.ts).
 *
 * WHY THIS EXISTS
 * ---------------
 * The dashboard-perf refactor (sessions 048-062) moved almost every panel off
 * a live raw index scan onto an **hourly KV-Store rollup** (`bin _time span=1h`,
 * warmed by an hourly scheduled aggregate). That's ideal for the 7d/30d/90d
 * trend ranges these dashboards target, but the hourly grain cannot answer a
 * **sub-hour window**: the rollup's `bucket_ts` values are hour-aligned, so
 *   - a 15-min window *within* an hour matches NO bucket  → the panel reads empty
 *   - a 15-min window *crossing* an hour boundary matches the whole hour → ~4x
 *     overcount
 * (demonstrated live in the session-054 scale report §8: 15,619 raw vs
 * empty / 62,030 cached for a "Last 15 min" window). Meanwhile the raw/tstats
 * panels on the same dashboard stay correct — a confusing mixed view. Splunk's
 * standard time picker offers "Last 15 minutes" / "Last 60 minutes" / custom
 * real-time windows one click away, so the gap is easily reached.
 *
 * THE FIX
 * -------
 * `useHybridSearch({ cached, raw })` routes short windows to the pre-refactor
 * RAW query (which honors any window exactly) and wide windows to the fast
 * rollup CACHE. This module holds the pure routing decision.
 *
 * ROUTING RULE — span-only, deliberately
 * --------------------------------------
 * Route to RAW iff the window span is below `HYBRID_RAW_MAX_SPAN_SEC`.
 *
 * The sub-hour empty/4x-overcount error is *purely* a sub-hour phenomenon (any
 * window >= 1h always contains >= 1 full hour-aligned bucket, so it is never
 * empty/4x-wrong — only the accepted graceful hourly coarseness at the edges,
 * which shrinks as the window widens and is negligible at >= 1 day). So a small
 * span threshold fixes the actual correctness bug while keeping the raw fallback
 * scan tiny (<= ~90 min of data — a sub-second scan even at customer scale),
 * honoring the whole point of the cache (never reintroduce the wide-window scans
 * the refactor removed).
 *
 * We deliberately do NOT also route "latest within the last hour" wide windows
 * to raw (the session-054 §8 note's second clause). A `-30d..now` window HAS its
 * latest edge at `now`, so that clause would send every ...->now trend window to
 * a full raw scan — defeating the cache entirely. The current incomplete hour is
 * never warmed, so a wide window ending at `now` is missing at most its last <1h;
 * that leading-edge freshness lag is invisible on a 7d/30d/90d chart and is the
 * same documented hourly-freshness trade-off the dashboards already accept. It is
 * NOT worth a full raw scan to close.
 *
 * TUNING
 * ------
 * `HYBRID_RAW_MAX_SPAN_SEC` is the single tuning knob. Raising it (e.g. to 6h)
 * would also serve the moderately-short 2-6h "recent" ranges accurately from
 * raw, at the cost of a larger (but still bounded) raw scan on those views.
 * 90 min is the conservative default: it covers every genuinely-broken sub-hour
 * case plus the immediately-adjacent "Last 60 min" preset, with a minimal scan.
 */
export const HYBRID_RAW_MAX_SPAN_SEC = 90 * 60; // 90 minutes

/**
 * Decide whether a panel should read the RAW query (true) or the CACHED rollup
 * query (false) for the given Splunk time range.
 *
 * `earliest` / `latest` are Splunk time modifiers exactly as the picker emits
 * them (`-30d@d`, `-15m`, `now`, `rt-1h`, ISO/absolute for custom ranges). We
 * reuse `estimateWindowSeconds` (the same parser `chooseTimechartSpan` uses), so
 * every form the picker can produce is handled, and any unparseable / all-time
 * input estimates LONG -> stays CACHED (no regression from today's behavior).
 */
export const shouldUseRawSource = (earliest: string, latest: string): boolean =>
    estimateWindowSeconds(earliest, latest) < HYBRID_RAW_MAX_SPAN_SEC;
