/**
 * diagPlatform — the Tier B platform snapshot's READ side (build 315,
 * design SS16 + SS16.8a).
 *
 * The hourly `logserv_diag_platform_aggregate` saved search copies scheduler
 * outcomes, skips, concurrency warnings, per-index throughput, queue depths
 * and PCRE events from `index=_internal` into the world-readable
 * `logserv_diag_platform_snapshot` collection. This module turns those rows
 * back into classified, renderable facts.
 *
 * DOCTRINE (SS16.8a-1, the review's convergent blocker): the collection is
 * `write : [ * ]`, so a well-formed row can be forged by any authenticated
 * user. Snapshot-derived facts may therefore only ever ADD provenance-badged
 * evidence lines — they must NEVER raise a verdict's confidence grade. The
 * `confirmed` grade stays reserved for first-hand observations.
 *
 * SANITIZE-ON-READ (SS16.4/SS16.8a-15): every row passes a shape gate — the
 * metric enum, finite non-negative numbers, capped strings — and rows whose
 * `bucket_ts` is in the future (beyond the same guard the cascade uses for
 * event timestamps) are DROPPED AND COUNTED before liveness is classified,
 * because a single forged/skewed future bucket would otherwise pin the
 * snapshot "live" forever.
 *
 * GATE-SAFE: no `@splunk` imports, no module-level window/document — this is
 * exercised by `bin/check-diagnostics.js` under node.
 */

// ---------------------------------------------------------------------------
// Constants (exported + literal-pinned + boundary-tested — the STALE_LAG
// convention)
// ---------------------------------------------------------------------------

export const SNAPSHOT_COLLECTION = 'logserv_diag_platform_snapshot';
export const SNAPSHOT_AGGREGATE = 'logserv_diag_platform_aggregate';
export const SNAPSHOT_RETENTION = 'logserv_diag_platform_retention';

/** Row cap the nightly retention enforces (`| sort N - bucket_ts`). */
export const SNAPSHOT_MAX_ROWS = 120000;

/** The bounded windowed read (SS16.8a-16): limit + query window. A read that
 *  returns exactly the limit is TRUNCATED and must say so — a silently
 *  truncated snapshot read is fabricated absence (SS12.3). */
export const SNAPSHOT_READ_LIMIT = 3000;
export const SNAPSHOT_WINDOW_SECONDS = 24 * 3600;

/** Three hours — the same derivation as diagCascade.STALE_LAG_SECONDS (the
 *  aggregate runs at :02 over -1h@h..@h, so healthy steady-state lag is
 *  1h02..2h02). Defined locally to avoid a diagCascade <-> diagPlatform import
 *  cycle; the build gate asserts the two constants are EQUAL. */
export const SNAPSHOT_STALE_SECONDS = 3 * 3600;

/** Fifty hours — mirror of diagCascade.STALE_LAG_DAILY_SECONDS (same
 *  cycle-avoidance; the gate asserts equality). Used only as the TRIGGER
 *  threshold for the panel-scope snapshot probe on daily-grain collections. */
export const SNAPSHOT_STALE_DAILY_SECONDS = 50 * 3600;

/** Mirror of diagCascade.FUTURE_TS_GUARD_SECONDS (same cycle-avoidance +
 *  gate-asserted equality). `nowSec` is the BROWSER clock — wording hedges. */
export const SNAPSHOT_FUTURE_GUARD_SECONDS = 900;

export const SNAPSHOT_METRICS = [
    'sched',
    'sched_top',
    'sched_skip',
    'quota',
    'thruput',
    'queues',
    'pcre',
] as const;
export type SnapshotMetric = (typeof SNAPSHOT_METRICS)[number];

/** The sentinel scope every arm emits (empty-safe): pre-cap rows in `n`,
 *  post-cap rows in `ev`. Sentinel presence = the arm COMPLETED for that
 *  bucket; absence = the arm was not collected (never "0"). */
export const SENTINEL_SCOPE = '(all)';

/** The provenance badge every snapshot-derived line carries (SS16.8a-1/2). */
export const SNAPSHOT_PROVENANCE =
    'recorded by the hourly platform snapshot, a collection any authenticated Splunk user can write';

const MAX_SCOPE_CHARS = 256;
const MAX_DETAIL_CHARS = 300;

// ---------------------------------------------------------------------------
// Row shape
// ---------------------------------------------------------------------------

export interface SnapshotRow {
    bucketTs: number;
    metric: SnapshotMetric;
    scope: string;
    scope2: string;
    n: number | null;
    sumRt: number | null;
    maxRt: number | null;
    kb: number | null;
    ev: number | null;
    detail: string;
}

const numOrNull = (v: unknown): number | null => {
    const x = typeof v === 'number' ? v : typeof v === 'string' && v !== '' ? Number(v) : NaN;
    if (!Number.isFinite(x) || x < 0) return null;
    return x;
};

const str = (v: unknown, cap: number): string =>
    typeof v === 'string' ? v.slice(0, cap) : '';

/** Shape-gate one raw KV row. Returns null for junk (unknown metric,
 *  unusable bucket_ts). Future-dated rows are handled by the CALLER (they
 *  must be counted, not silently vanished). */
export const sanitizeSnapshotRow = (raw: unknown): SnapshotRow | null => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const r = raw as Record<string, unknown>;
    const metric = typeof r.metric === 'string' ? r.metric : '';
    if ((SNAPSHOT_METRICS as readonly string[]).indexOf(metric) === -1) return null;
    const bt = numOrNull(r.bucket_ts);
    if (bt === null || bt === 0) return null;
    return {
        bucketTs: Math.floor(bt),
        metric: metric as SnapshotMetric,
        scope: str(r.scope, MAX_SCOPE_CHARS),
        scope2: str(r.scope2, MAX_SCOPE_CHARS),
        n: numOrNull(r.n),
        sumRt: numOrNull(r.sum_rt),
        maxRt: numOrNull(r.max_rt),
        kb: numOrNull(r.kb),
        ev: numOrNull(r.ev),
        detail: str(r.detail, MAX_DETAIL_CHARS),
    };
};

export interface ParsedSnapshotRows {
    rows: SnapshotRow[];
    /** Rows dropped by the future clamp — reported, never silent. */
    futureDropped: number;
    /** Rows dropped by the shape gate. */
    junkDropped: number;
}

export const parseSnapshotRows = (raw: unknown[], nowSec: number): ParsedSnapshotRows => {
    const out: SnapshotRow[] = [];
    let futureDropped = 0;
    let junkDropped = 0;
    raw.forEach((r) => {
        const row = sanitizeSnapshotRow(r);
        if (!row) {
            junkDropped += 1;
            return;
        }
        if (row.bucketTs > nowSec + SNAPSHOT_FUTURE_GUARD_SECONDS) {
            futureDropped += 1;
            return;
        }
        out.push(row);
    });
    return { rows: out, futureDropped, junkDropped };
};

// ---------------------------------------------------------------------------
// Liveness (check 8) — classified from the UNWINDOWED extent read
// ---------------------------------------------------------------------------

export type SnapshotStatus = 'live' | 'stale' | 'empty' | 'not-checked';

/**
 * SS16.8a-14: a 24h-windowed read cannot see a newest bucket older than 24h,
 * so liveness classifies from the UNWINDOWED `kvExtent` newest — `empty`
 * means genuinely empty, `stale` reports the REAL age. The extent newest must
 * itself survive the future clamp (SS16.8a-15) — the caller passes the newest
 * NON-FUTURE bucket.
 */
export const classifySnapshotLiveness = (
    extentProbed: boolean,
    newestNonFuture: number | null,
    nowSec: number,
): { status: SnapshotStatus; ageSeconds: number | null } => {
    if (!extentProbed) return { status: 'not-checked', ageSeconds: null };
    if (newestNonFuture === null) return { status: 'empty', ageSeconds: null };
    const age = nowSec - newestNonFuture;
    return { status: age > SNAPSHOT_STALE_SECONDS ? 'stale' : 'live', ageSeconds: age };
};

// ---------------------------------------------------------------------------
// The parsed snapshot handed to renderers
// ---------------------------------------------------------------------------

export interface SkipRow {
    search: string;
    /** 'skipped' | 'deferred' — parsed from the scope2 "status|reason" form.
     *  Only 'skipped' may participate in the rollup-stale evidence line. */
    status: string;
    reason: string;
    app: string;
    n: number;
    bucketTs: number;
}

export interface PlatformSnapshot {
    probed: boolean;
    status: SnapshotStatus;
    /** Real age of the newest non-future bucket (unwindowed read). */
    ageSeconds: number | null;
    newestBucket: number | null;
    /** The windowed read hit SNAPSHOT_READ_LIMIT — partial window. */
    truncated: boolean;
    futureDropped: number;
    junkDropped: number;
    /** Distinct buckets present in the 24h window vs the expected 24 — a
     *  holed snapshot is itself scheduler evidence (SS16.8a-17). */
    bucketsPresent: number;
    bucketsExpected: number;
    /** Which metrics have a completion sentinel in the newest windowed
     *  bucket. A metric absent here renders "not collected", never "0". */
    metricsCollected: string[];
    rows: SnapshotRow[];
    skips: SkipRow[];
}

export const NOT_CHECKED_SNAPSHOT: PlatformSnapshot = {
    probed: false,
    status: 'not-checked',
    ageSeconds: null,
    newestBucket: null,
    truncated: false,
    futureDropped: 0,
    junkDropped: 0,
    bucketsPresent: 0,
    bucketsExpected: 24,
    metricsCollected: [],
    rows: [],
    skips: [],
};

/** Split the sched_skip scope2 "status|reason" form. */
export const splitSkipScope2 = (scope2: string): { status: string; reason: string } => {
    const i = scope2.indexOf('|');
    if (i === -1) return { status: '', reason: scope2 };
    return { status: scope2.slice(0, i), reason: scope2.slice(i + 1) };
};

export const buildPlatformSnapshot = (
    extentProbed: boolean,
    extentNewest: number | null,
    windowedRaw: unknown[],
    windowedTruncated: boolean,
    nowSec: number,
): PlatformSnapshot => {
    const parsed = parseSnapshotRows(windowedRaw, nowSec);
    // The extent newest also faces the future clamp: a forged future bucket
    // must not classify the snapshot live (SS16.8a-15). When the extent value
    // is future-dated, fall back to the newest non-future WINDOWED bucket —
    // honest degradation, and the drop is visible via futureDropped.
    let newest = extentNewest;
    if (newest !== null && newest > nowSec + SNAPSHOT_FUTURE_GUARD_SECONDS) {
        newest = parsed.rows.reduce<number | null>(
            (a, r) => (a === null || r.bucketTs > a ? r.bucketTs : a),
            null,
        );
    }
    const live = classifySnapshotLiveness(extentProbed, newest, nowSec);
    const buckets = new Set<number>();
    parsed.rows.forEach((r) => buckets.add(r.bucketTs));
    let newestWindowed: number | null = null;
    buckets.forEach((b) => {
        if (newestWindowed === null || b > newestWindowed) newestWindowed = b;
    });
    const metricsCollected: string[] = [];
    parsed.rows.forEach((r) => {
        if (
            r.bucketTs === newestWindowed &&
            r.scope === SENTINEL_SCOPE &&
            metricsCollected.indexOf(r.metric) === -1
        ) {
            metricsCollected.push(r.metric);
        }
    });
    const skips: SkipRow[] = [];
    parsed.rows.forEach((r) => {
        if (r.metric !== 'sched_skip' || r.scope === SENTINEL_SCOPE) return;
        const s = splitSkipScope2(r.scope2);
        skips.push({
            search: r.scope,
            status: s.status,
            reason: s.reason,
            app: r.detail,
            n: r.n === null ? 0 : r.n,
            bucketTs: r.bucketTs,
        });
    });
    return {
        probed: extentProbed,
        status: live.status,
        ageSeconds: live.ageSeconds,
        newestBucket: newest,
        truncated: windowedTruncated,
        futureDropped: parsed.futureDropped,
        junkDropped: parsed.junkDropped,
        bucketsPresent: buckets.size,
        bucketsExpected: 24,
        metricsCollected,
        rows: parsed.rows,
        skips,
    };
};

// ---------------------------------------------------------------------------
// The rollup-stale evidence line (SS16.8a-1/2/3) — an ADDITION, never a raise
// ---------------------------------------------------------------------------

export interface ProducerSkipEvidence {
    search: string;
    n: number;
    reason: string;
    buckets: number;
}

/**
 * Match the panel's traced producer names against the snapshot's skip rows.
 * Attaches ONLY when every condition holds (SS16.8a-2):
 *  - exact `savedsearch_name` equality against the producerNames ARRAY;
 *  - status === 'skipped' (deferrals are load context, SS16.8a-3);
 *  - the skip bucket is AFTER the collection's newest bucket (inside the
 *    staleness gap — an old skip cannot explain a fresh stall);
 *  - the snapshot classifies LIVE (the caller checks; enforced here too).
 * Absence of a match is NEVER negative evidence — the caller simply adds no
 * line. The returned reason is untrusted display text (already capped).
 */
export const matchProducerSkips = (
    snapshot: PlatformSnapshot,
    producerNames: readonly string[] | null,
    collectionNewest: number | null,
): ProducerSkipEvidence[] => {
    if (snapshot.status !== 'live') return [];
    if (!producerNames || producerNames.length === 0) return [];
    const out: Record<string, ProducerSkipEvidence & { seen: Set<number> }> = {};
    snapshot.skips.forEach((s) => {
        if (s.status !== 'skipped') return;
        if (producerNames.indexOf(s.search) === -1) return;
        if (collectionNewest !== null && s.bucketTs <= collectionNewest) return;
        if (!out[s.search]) {
            out[s.search] = { search: s.search, n: 0, reason: s.reason, buckets: 0, seen: new Set() };
        }
        out[s.search].n += s.n;
        if (!out[s.search].seen.has(s.bucketTs)) {
            out[s.search].seen.add(s.bucketTs);
            out[s.search].buckets += 1;
        }
        if (s.reason && !out[s.search].reason) out[s.search].reason = s.reason;
    });
    return Object.keys(out).map((k) => ({
        search: out[k].search,
        n: out[k].n,
        reason: out[k].reason,
        buckets: out[k].buckets,
    }));
};

// ---------------------------------------------------------------------------
// SS7.6 — the ASCII daily bar chart (cp1252-safe by construction)
// ---------------------------------------------------------------------------

export const DAILY_SERIES_MAX_ROWS = 60;
const BAR_MAX_MARKS = 45;

const pad2 = (x: number): string => (x < 10 ? '0' + x : String(x));

export const utcDayLabel = (epoch: number): string => {
    const d = new Date(epoch * 1000);
    return (
        d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate())
    );
};

const groupThousands = (x: number): string =>
    String(Math.round(x)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/**
 * `YYYY-MM-DD |########## 3,214,567` — '#' scaled to the window max, pure
 * ASCII, at most DAILY_SERIES_MAX_ROWS lines (the series is capped at the
 * SOURCE via `| tail 60`, SS16.8a-21 — this re-caps defensively).
 */
export const buildAsciiBarChart = (
    daily: Array<{ day: number; count: number }>,
): string => {
    const rows = daily.slice(-DAILY_SERIES_MAX_ROWS);
    if (rows.length === 0) return '(no events in the window)';
    let max = 0;
    rows.forEach((r) => {
        if (r.count > max) max = r.count;
    });
    return rows
        .map((r) => {
            const marks =
                max > 0 ? Math.max(r.count > 0 ? 1 : 0, Math.round((r.count / max) * BAR_MAX_MARKS)) : 0;
            let bar = '';
            for (let i = 0; i < marks; i += 1) bar += '#';
            return utcDayLabel(r.day) + ' |' + bar + ' ' + groupThousands(r.count);
        })
        .join('\n');
};
