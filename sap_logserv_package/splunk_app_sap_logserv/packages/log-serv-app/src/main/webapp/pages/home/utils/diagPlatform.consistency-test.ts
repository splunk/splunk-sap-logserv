/**
 * diagPlatform.consistency-test — the SS16 build gate for the Tier B platform
 * snapshot's READ side (build 315).
 *
 * Pins the review's blockers where they live:
 *  - sanitize-on-read (world-writable collection): junk metric dropped,
 *    oversize strings capped, negative/NaN numbers dropped;
 *  - the FUTURE clamp runs BEFORE liveness (a forged future bucket must not
 *    pin the snapshot live — SS16.8a-15), boundary-tested both directions;
 *  - liveness classifies from the UNWINDOWED newest (SS16.8a-14), 3h
 *    boundary-tested both directions;
 *  - matchProducerSkips: skipped-only, exact-name equality, bucket AFTER the
 *    collection's newest, LIVE-only — and an empty result is just empty
 *    (never negative evidence);
 *  - the ASCII bar chart is cp1252-pure and row-capped;
 *  - the state-aware banner: both forms differ exactly on the samples
 *    sentence; the samples-free form IS the DATA_BANNER constant.
 *
 * Async house rules: exports `run(): Promise<number>`, never exits, the
 * summary block is the LAST statement (session-099 sticky 7).
 */

/* eslint-disable @typescript-eslint/no-var-requires */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const require: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const process: any;
const proc = require('process') as { stderr: { write: (s: string) => void } };

const plat = require('./diagPlatform') as any; // eslint-disable-line @typescript-eslint/no-explicit-any
const cascade = require('./diagCascade') as any; // eslint-disable-line @typescript-eslint/no-explicit-any
const report = require('./diagReport') as any; // eslint-disable-line @typescript-eslint/no-explicit-any

export const run = async (): Promise<number> => {
    let checks = 0;
    let failures = 0;
    const check = (name: string, ok: boolean, why: string): void => {
        checks += 1;
        if (!ok) {
            failures += 1;
            proc.stderr.write(`FAIL: ${name}: ${why}\n`);
        }
    };

    const NOW = 1786320000;
    const HOUR = 3600;

    // ---------------------------------------------------------------- constants
    check(
        'const.staleEqualsCascade',
        plat.SNAPSHOT_STALE_SECONDS === cascade.STALE_LAG_SECONDS,
        'SNAPSHOT_STALE_SECONDS drifted from STALE_LAG_SECONDS (cycle-avoidance duplicate)',
    );
    check(
        'const.staleDailyEqualsCascade',
        plat.SNAPSHOT_STALE_DAILY_SECONDS === cascade.STALE_LAG_DAILY_SECONDS,
        'daily duplicate drifted',
    );
    check(
        'const.futureGuardEqualsCascade',
        plat.SNAPSHOT_FUTURE_GUARD_SECONDS === cascade.FUTURE_TS_GUARD_SECONDS,
        'future-guard duplicate drifted',
    );
    check('const.staleLiteral', plat.SNAPSHOT_STALE_SECONDS === 3 * 3600, 'stale not 3h');
    check('const.maxRowsLiteral', plat.SNAPSHOT_MAX_ROWS === 120000, 'retention cap moved');
    check('const.readLimitLiteral', plat.SNAPSHOT_READ_LIMIT === 3000, 'read limit moved');

    // ---------------------------------------------------------------- sanitize
    const goodRow = {
        bucket_ts: NOW - HOUR,
        metric: 'sched',
        scope: 'splunk_app_sap_logserv',
        scope2: 'success',
        n: 25,
        sum_rt: 84.1,
    };
    check(
        'sanitize.acceptsGood',
        plat.sanitizeSnapshotRow(goodRow) !== null,
        'a well-formed row was dropped',
    );
    check(
        'sanitize.dropsUnknownMetric',
        plat.sanitizeSnapshotRow({ ...goodRow, metric: 'forged_metric' }) === null,
        'an unknown metric survived the shape gate',
    );
    check(
        'sanitize.dropsZeroBucket',
        plat.sanitizeSnapshotRow({ ...goodRow, bucket_ts: 0 }) === null,
        'a bucket_ts=0 junk row survived',
    );
    check(
        'sanitize.dropsNegativeNumbers',
        (plat.sanitizeSnapshotRow({ ...goodRow, n: -5 }) as { n: number | null }).n === null,
        'a negative count survived as a number',
    );
    const longDetail = new Array(1000).join('x');
    check(
        'sanitize.capsDetail',
        (
            plat.sanitizeSnapshotRow({
                ...goodRow,
                metric: 'quota',
                detail: longDetail,
            }) as { detail: string }
        ).detail.length <= 300,
        'oversize detail not capped',
    );

    // ---------------------------------------------------------------- future clamp
    const future = { ...goodRow, bucket_ts: NOW + plat.SNAPSHOT_FUTURE_GUARD_SECONDS + 1 };
    const atGuard = { ...goodRow, bucket_ts: NOW + plat.SNAPSHOT_FUTURE_GUARD_SECONDS - 1 };
    const parsed = plat.parseSnapshotRows([goodRow, future, atGuard], NOW);
    check('future.drops', parsed.futureDropped === 1, 'the future row was not dropped');
    check('future.keepsWithinGuard', parsed.rows.length === 2, 'a within-guard row was dropped');

    // ---------------------------------------------------------------- liveness
    check(
        'live.notProbed',
        plat.classifySnapshotLiveness(false, null, NOW).status === 'not-checked',
        'an unprobed extent classified',
    );
    check(
        'live.empty',
        plat.classifySnapshotLiveness(true, null, NOW).status === 'empty',
        'a null newest did not classify empty',
    );
    check(
        'live.freshIsLive',
        plat.classifySnapshotLiveness(true, NOW - (plat.SNAPSHOT_STALE_SECONDS - 60), NOW).status ===
            'live',
        'a fresh bucket classified stale (boundary)',
    );
    check(
        'live.oldIsStale',
        plat.classifySnapshotLiveness(true, NOW - (plat.SNAPSHOT_STALE_SECONDS + 60), NOW).status ===
            'stale',
        'an old bucket classified live (boundary)',
    );
    // SS16.8a-14: a bucket older than the whole windowed read still classifies
    // (the windowed read alone could never see it).
    check(
        'live.veryOldStillStale',
        plat.classifySnapshotLiveness(true, NOW - 30 * 24 * HOUR, NOW).status === 'stale',
        'a 30-day-old newest did not classify stale',
    );
    // SS16.8a-15: a FUTURE extent newest must not classify live off the forged
    // value — buildPlatformSnapshot falls back to the windowed non-future max.
    const snapForged = plat.buildPlatformSnapshot(
        true,
        NOW + 10 * 365 * 24 * HOUR,
        [{ ...goodRow, bucket_ts: NOW - 5 * HOUR }],
        false,
        NOW,
    );
    check(
        'future.extentForgeryIgnored',
        snapForged.status === 'stale' && snapForged.newestBucket === NOW - 5 * HOUR,
        `a future-dated extent pinned the snapshot ${snapForged.status}`,
    );

    // ---------------------------------------------------------------- sentinels
    const mkRows = (bt: number) => [
        { bucket_ts: bt, metric: 'sched', scope: '(all)', scope2: '(all)', n: 29, ev: 3 },
        { bucket_ts: bt, metric: 'sched_skip', scope: '(all)', scope2: '(all)', n: 0, ev: 0 },
        {
            bucket_ts: bt,
            metric: 'sched_skip',
            scope: 'logserv_linux_aggregate',
            scope2: 'skipped|The maximum number of concurrent historical searches has been reached.',
            n: 2,
            detail: 'splunk_app_sap_logserv',
        },
        {
            bucket_ts: bt,
            metric: 'sched_skip',
            scope: 'logserv_linux_aggregate',
            scope2: 'deferred|deferred by scheduler load',
            n: 1,
            detail: 'splunk_app_sap_logserv',
        },
    ];
    const bt = NOW - HOUR;
    const snap = plat.buildPlatformSnapshot(true, bt, mkRows(bt), false, NOW);
    check('snap.live', snap.status === 'live', 'fresh snapshot not live');
    check(
        'snap.metricsCollected',
        snap.metricsCollected.indexOf('sched') !== -1 &&
            snap.metricsCollected.indexOf('sched_skip') !== -1 &&
            snap.metricsCollected.indexOf('pcre') === -1,
        'sentinel-based metric collection wrong',
    );
    check(
        'snap.skipParse',
        snap.skips.length === 2 &&
            snap.skips[0].status === 'skipped' &&
            snap.skips[0].reason.indexOf('maximum number') !== -1 &&
            snap.skips[1].status === 'deferred',
        'skip scope2 status|reason split failed',
    );

    // ---------------------------------------------------------------- skip matching
    const producers = ['logserv_linux_aggregate'];
    const collNewest = bt - 2 * HOUR; // staleness gap contains the skip bucket
    const matched = plat.matchProducerSkips(snap, producers, collNewest);
    check('match.fires', matched.length === 1, 'a matching in-gap skipped row did not match');
    check(
        'match.skippedOnly',
        matched.length === 1 && matched[0].n === 2,
        'a DEFERRED row participated in the match (SS16.8a-3)',
    );
    check(
        'match.exactNameOnly',
        plat.matchProducerSkips(snap, ['logserv_linux'], collNewest).length === 0,
        'a substring producer name matched',
    );
    check(
        'match.outsideGapIgnored',
        plat.matchProducerSkips(snap, producers, bt + 1).length === 0,
        'a skip OLDER than the collection newest matched (no temporal link)',
    );
    /* The stale-case fixture must be blocked ONLY by the liveness guard —
     * its skip buckets sit INSIDE the staleness gap (bucketTs > collNewest),
     * so the temporal guard passes and removing the live-only guard is
     * observable (the first fixture was double-blocked and let that mutation
     * survive — the equivalent-mutant trap, session-093 sticky 5). */
    const staleSnap = plat.buildPlatformSnapshot(
        true,
        NOW - 10 * HOUR,
        mkRows(NOW - 10 * HOUR),
        false,
        NOW,
    );
    check(
        'match.staleSnapshotNeverMatches',
        plat.matchProducerSkips(staleSnap, producers, NOW - 20 * HOUR).length === 0,
        'a STALE snapshot produced skip evidence (SS16.8a-2)',
    );
    check(
        'match.noProducersNoMatch',
        plat.matchProducerSkips(snap, null, collNewest).length === 0,
        'null producerNames matched',
    );

    // ---------------------------------------------------------------- ASCII chart
    const chart = plat.buildAsciiBarChart([
        { day: 1786060800, count: 100 },
        { day: 1786147200, count: 0 },
        { day: 1786233600, count: 3214567 },
    ]);
    check(
        'ascii.cp1252Pure',
        // eslint-disable-next-line no-control-regex
        !/[^\n\u0020-\u00ff]/.test(chart) && chart.indexOf('#') !== -1,
        'the chart contains non-cp1252 glyphs or no marks',
    );
    check(
        'ascii.zeroDayZeroMarks',
        chart.split('\n')[1].indexOf('#') === -1,
        'a zero day drew marks',
    );
    const manyDays: Array<{ day: number; count: number }> = [];
    for (let i = 0; i < 200; i += 1) manyDays.push({ day: 1786060800 + i * 86400, count: i });
    check(
        'ascii.rowCap',
        plat.buildAsciiBarChart(manyDays).split('\n').length <= plat.DAILY_SERIES_MAX_ROWS,
        'the chart exceeded the row cap',
    );

    // ---------------------------------------------------------------- banner forms
    check(
        'banner.constIsDerivedFalse',
        report.DATA_BANNER === report.dataBanner(false),
        'DATA_BANNER is not dataBanner(false)',
    );
    check(
        'banner.formsDiffer',
        report.dataBanner(true) !== report.dataBanner(false) &&
            report.dataBanner(false).indexOf('It contains no raw log events.') !== -1 &&
            report.dataBanner(true).indexOf('It contains no raw log events.') === -1 &&
            report.dataBanner(true).indexOf('INCLUDES up to 5') !== -1,
        'the two banner forms do not differ exactly on the samples sentence',
    );
    check(
        'banner.cp1252',
        // eslint-disable-next-line no-control-regex
        !/[^\u0020-\u00ff]/.test(report.dataBanner(true) + report.dataBanner(false)),
        'a banner form carries a non-cp1252 glyph',
    );

    // ---------------------------------------------------------------- provenance
    check(
        'provenance.namesWritability',
        typeof plat.SNAPSHOT_PROVENANCE === 'string' &&
            plat.SNAPSHOT_PROVENANCE.indexOf('any authenticated Splunk user can write') !== -1,
        'the provenance badge does not state the write surface',
    );

    if (failures > 0) {
        proc.stderr.write(
            `\ndiagPlatform consistency test: ${failures} failure(s) of ${checks} checks\n`,
        );
    } else {
        // eslint-disable-next-line no-console
        console.log(`diagPlatform consistency test: ${checks} checks OK`);
    }
    return failures;
};
