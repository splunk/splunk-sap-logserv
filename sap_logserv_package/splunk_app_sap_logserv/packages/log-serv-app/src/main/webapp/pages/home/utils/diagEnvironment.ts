/**
 * diagEnvironment — the GLOBAL-scope evidence for the Data Doctor report
 * (session 095, design §7 sections 3/6/7/8 at environment grain).
 *
 * No panel scope at all: does the index hold events for the selected window,
 * which sourcetypes exist and when were they last seen, and is every rollup
 * collection current — the questions that decide whether ANY dashboard can
 * have data before a single panel is looked at. This is the foundation the
 * future `#/diagnostics` page's pre-scan builds on (design §6.1); the
 * per-panel app-wide sweep with its selection tree is deliberately NOT here
 * (decision 6 — never sweep ~330 panels blind).
 *
 * Every probe goes through the caller's budgeted runner, so the whole gather
 * obeys one wall-clock budget and a Cancel. Tri-state discipline is the same
 * as `diagEvidence`: a field is null when its probe did not run or failed,
 * and the notes say why — a skipped rollup row renders NOT CHECKED, never OK.
 */

import {
    ProbeRunner,
    kvExtent,
    fetchMacroIndexes,
    fetchSavedSearchSpl,
    isSafeIdentifier,
} from './diagProbe';
import {
    probeCanary,
    probeIndexPresence,
    probeVisibleIndexes,
    probeSourcetypeCounts,
    probeSourcetypeMetadata,
    probeInstalledApps,
    probeSnapshotWindow,
    probeOwnJobs,
    probeDailyCounts,
    probeClzCounts,
    probeHostCounts,
    probeHostDc,
    OWN_JOBS_COUNT_CAP,
    ProbeNote,
} from './diagEvidence';
import {
    SNAPSHOT_COLLECTION,
    SNAPSHOT_AGGREGATE,
    SNAPSHOT_READ_LIMIT,
    PlatformSnapshot,
    buildPlatformSnapshot,
    NOT_CHECKED_SNAPSHOT,
} from './diagPlatform';
import { STALE_LAG_SECONDS, STALE_LAG_DAILY_SECONDS } from './diagCascade';
import { ROLLUPS } from '../routes/rollupRegistry';
import {
    IngestFacts,
    sanitizeFetchedFactsRow,
    ingestFactsSummary,
} from './diagIngestFacts';
import { probeIngestFacts } from './diagEvidence';

const RAW_BASE = '/en-US/splunkd/__raw/services';

/** The companion apps the fingerprint reports on (design §7.3; §14.3b).
 *
 *  Entries carry an optional NOTE rendered inline wherever the presence row
 *  appears (the Diagnostics page AND the environment report) — added for the
 *  Data TA, whose "absent" is EXPECTED on every distributed search head and
 *  would otherwise invite the wrong action ("install it on the SH"). The note
 *  is deliberately unconditional: topology cannot be sensed from a browser
 *  session. */
export const COMPANION_APPS: Array<{ id: string; note?: string }> = [
    { id: 'Splunk_SA_CIM' },
    { id: 'Splunk_TA_windows' },
    { id: 'Splunk_TA_nix' },
    { id: 'Splunk_MCP_Server' },
    {
        id: 'splunk_ta_sap_logserv',
        note: 'absence is expected on a dedicated search head — the Data TA runs on the forwarder/indexer tier',
    },
];

export interface RollupHealthRow {
    key: string;
    label: string;
    collection: string;
    grain: 'hourly' | 'daily';
    probed: boolean;
    oldest: number | null;
    newest: number | null;
    lagSeconds: number | null;
    status: 'ok' | 'stale' | 'empty' | 'not-checked';
    /** §17.6 check 18 — distinct buckets present in the last 72h (hourly) / 3d
     *  (daily) vs expected. CONTEXT only — a missing bucket is indistinguishable
     *  from a quiet hour at this tier. null unless the report path requested it. */
    bucketContinuity: { present: number; expected: number } | null;
}

export interface EnvironmentEvidence {
    canaryMs: number | null;
    serverVersion: string | null;
    serverName: string | null;
    serverTimeLabel: string | null;
    appsPresent: Record<string, boolean> | null;
    macroIndexes: string[] | null;
    visibleIndexCount: number | null;
    /** Windowed event count per index the macro matched. */
    indexCounts: Record<string, number> | null;
    /** Windowed count per sourcetype (all sourcetypes in the index). */
    sourcetypeWindowCounts: Record<string, number> | null;
    /** All-time last-seen per sourcetype (metadata). */
    sourcetypeLastSeen: Record<string, number> | null;
    rollups: RollupHealthRow[];
    /** Operator-supplied ingest-filter configuration (design SS15). null =
     *  not supplied / unreadable. Excerpt-truncated on read (SS15.8a-23). */
    ingestFacts: IngestFacts | null;
    /** SS16 checks 7/8 — the Tier B platform snapshot, parsed + classified.
     *  NOT_CHECKED_SNAPSHOT when the reads did not run. Stale/empty/unchecked
     *  snapshots render as NOT AVAILABLE — never as healthy numbers. */
    platform: PlatformSnapshot;
    /** SS16.8a-17 — the snapshot AGGREGATE's own state, read live so the
     *  empty-collection wording is verified, not guessed. Tri-state. */
    platformProducerDisabled: boolean | null;
    platformProducerHasRun: boolean | null;
    /** SS16 check 6 — the caller's own search-job census. Context, never a
     *  cause (SS12.6); admin roles see all users' jobs (the label says so). */
    ownJobs: { returned: number; queued: number; running: number; capped: boolean } | null;
    /** SS16.5 — data coverage (environment scope). All tri-state. */
    dailyCounts: Array<{ day: number; count: number }> | null;
    clzCounts: Array<{ dir: string; sub: string; count: number }> | null;
    hostCounts: Record<string, number> | null;
    hostTotal: number | null;
    notes: ProbeNote[];
    budgetExhausted: boolean;
}

/** Pure classification, exported for the build gate. `probed=false` must
 *  never classify as anything but not-checked (the finding-2 rule, applied
 *  here from day one). */
export const classifyRollupExtent = (
    probed: boolean,
    oldest: number | null,
    newest: number | null,
    grain: 'hourly' | 'daily',
    nowSec: number,
): { status: RollupHealthRow['status']; lagSeconds: number | null } => {
    if (!probed) return { status: 'not-checked', lagSeconds: null };
    if (oldest === null && newest === null) return { status: 'empty', lagSeconds: null };
    if (newest === null) return { status: 'not-checked', lagSeconds: null };
    const lag = nowSec - newest;
    const threshold = grain === 'daily' ? STALE_LAG_DAILY_SECONDS : STALE_LAG_SECONDS;
    return { status: lag > threshold ? 'stale' : 'ok', lagSeconds: lag };
};

/**
 * History depth — the Settings -> Dashboard Data completeness convention.
 * A rollup is "complete" when its stored history reaches back ~30 days
 * (oldest bucket ≤ now − 29 d). Single-sourced HERE so the Settings panel
 * (`RollupBackfillPanel`) and the `#/diagnostics` page share the PREDICATE —
 * note this makes the predicate structural, not the outcome: the two surfaces
 * probe via different transports (SPL oneshot vs KV REST) and may legitimately
 * disagree when exactly one transport is degraded (both degrade to 'unknown').
 */
export const COMPLETE_SECONDS = 29 * 86400;

export type RollupHistoryStatus = 'complete' | 'incomplete' | 'empty' | 'unknown';

/**
 * Per-collection history verdict from a kvExtent observation (design §13.8a
 * correction 4). Guards, in order:
 *  - `!probed` -> unknown (a failed probe must never classify — the finding-2
 *    rule);
 *  - both extents null -> empty (0 rows; on a successful probe this is the
 *    panel's `n === 0` case);
 *  - EXACTLY ONE extent null -> unknown (probe-degenerate: a missing-field row
 *    sorts first ascending, or a mid-write race with the nightly retention
 *    overwrite — asserting either way would be a guess);
 *  - `oldest > 0` mirrors the Settings panel's `m > 0` guard so a junk row
 *    with `bucket_ts = 0` cannot read as "ancient history = complete";
 *  - equivalence with the panel's oneshot predicate holds on well-formed rows
 *    only — the consistency test pins the malformed shapes.
 */
export const classifyRollupHistory = (
    probed: boolean,
    oldest: number | null,
    newest: number | null,
    nowSec: number,
): RollupHistoryStatus => {
    if (!probed) return 'unknown';
    if (oldest === null && newest === null) return 'empty';
    if (oldest === null || newest === null) return 'unknown';
    if (oldest > 0 && oldest <= nowSec - COMPLETE_SECONDS) return 'complete';
    return 'incomplete';
};

/**
 * Per-rollup verdict = weakest link across its completeness collections, with
 * `unknown` DOMINATING (any unchecked collection makes the rollup unknown —
 * matching the Settings panel, where any probe-null short-circuits to
 * 'unknown' before completeness is evaluated). Never certify `complete` from
 * a set containing an unchecked collection.
 */
export const combineRollupHistory = (statuses: RollupHistoryStatus[]): RollupHistoryStatus => {
    if (statuses.length === 0) return 'unknown';
    if (statuses.indexOf('unknown') !== -1) return 'unknown';
    if (statuses.indexOf('empty') !== -1 || statuses.indexOf('incomplete') !== -1) {
        return 'incomplete';
    }
    return 'complete';
};

const toRecordNumber = (
    rows: Array<Record<string, unknown>>,
    key: string,
    valueField: string,
): Record<string, number> => {
    const out: Record<string, number> = {};
    rows.forEach((r) => {
        const k = r[key];
        const v = r[valueField];
        const n = typeof v === 'number' ? v : Number(v);
        if (typeof k === 'string' && Number.isFinite(n)) out[k] = n;
    });
    return out;
};

export interface GatherEnvironmentOptions {
    /** §17.8a-18 — only the environment REPORT path requests bucket-continuity;
     *  the live Diagnostics page leaves it off (it re-gathers on every picker
     *  change, and continuity is report context, not a live signal). */
    bucketContinuity?: boolean;
}

export const gatherEnvironmentEvidence = async (
    runner: ProbeRunner,
    earliest: string,
    latest: string,
    onProgress?: (label: string) => void,
    opts?: GatherEnvironmentOptions,
): Promise<EnvironmentEvidence> => {
    const ev: EnvironmentEvidence = {
        canaryMs: null,
        serverVersion: null,
        serverName: null,
        serverTimeLabel: null,
        appsPresent: null,
        macroIndexes: null,
        visibleIndexCount: null,
        indexCounts: null,
        sourcetypeWindowCounts: null,
        sourcetypeLastSeen: null,
        rollups: [],
        ingestFacts: null,
        platform: NOT_CHECKED_SNAPSHOT,
        platformProducerDisabled: null,
        platformProducerHasRun: null,
        ownJobs: null,
        dailyCounts: null,
        clzCounts: null,
        hostCounts: null,
        hostTotal: null,
        notes: [],
        budgetExhausted: false,
    };
    const note = (check: string, status: ProbeNote['status'], detail: string): void => {
        ev.notes.push({ check, status, detail });
        if (status === 'skipped') ev.budgetExhausted = true;
    };
    const tick = (label: string): void => {
        if (onProgress) onProgress(label);
    };

    // 1. Canary — first and cheap, same reasoning as the panel path.
    tick('Checking the search head…');
    const canary = await probeCanary(runner);
    if (canary.skipped) note('Search-head canary', 'skipped', 'Budget exhausted or cancelled.');
    else if (canary.error) note('Search-head canary', 'error', canary.error);
    else {
        ev.canaryMs = canary.durationMs;
        note('Search-head canary', 'ok', `${canary.durationMs} ms round-trip`);
    }

    // 1.5 Operator-supplied ingest facts (design SS15, checks 27-29). The
    //     environment path ALWAYS notes the check — including the "not
    //     supplied" state, which the page turns into the ask (SS15.2).
    {
        const fx = await probeIngestFacts(runner);
        if (fx.skipped) {
            note('Ingest-tier filter config (operator-supplied)', 'skipped', 'Budget exhausted or cancelled.');
        } else if (fx.error) {
            note('Ingest-tier filter config (operator-supplied)', 'error', fx.error);
        } else {
            const rows = fx.rows as unknown[];
            const facts =
                rows.length > 0
                    ? sanitizeFetchedFactsRow(rows[0], Math.floor(Date.now() / 1000))
                    : null;
            ev.ingestFacts = facts;
            note(
                'Ingest-tier filter config (operator-supplied)',
                'ok',
                facts
                    ? `Recorded as supplied by ${facts.suppliedBy || 'an unknown user'}: ${ingestFactsSummary(facts)}`
                    : 'Not supplied — the Diagnostics page explains how to provide it.',
            );
        }
    }

    // 2. Server info + server clock (version, host, timezone).
    const info = await runner.rest<{ content?: { version?: string; serverName?: string } }>(
        `${RAW_BASE}/server/info?output_mode=json`,
    );
    if (info.skipped) note('Splunk server info', 'skipped', 'Budget exhausted or cancelled.');
    else if (info.error) note('Splunk server info', 'error', info.error);
    else {
        const entry = info.rows.length > 0 ? info.rows[0] : undefined;
        ev.serverVersion = (entry && entry.content && entry.content.version) || null;
        ev.serverName = (entry && entry.content && entry.content.serverName) || null;
        note('Splunk server info', 'ok', `${ev.serverVersion || '?'} on ${ev.serverName || '?'}`);
    }
    const clock = await runner.search<{ server_time?: string }>(
        '| makeresults | eval server_time=strftime(now(), "%Y-%m-%d %H:%M:%S %Z")',
        '-1m',
        'now',
    );
    if (!clock.skipped && !clock.error && clock.rows.length > 0) {
        const v = (clock.rows[0] as Record<string, unknown>).server_time;
        if (typeof v === 'string') {
            ev.serverTimeLabel = v;
            note('Search-head clock', 'ok', v);
        }
    } else if (clock.error) {
        note('Search-head clock', 'error', clock.error);
    }

    // 2.5 SS16 check 6 — the caller's own job census. Field-filtered + capped
    //     (the unfiltered listing measured 4.7 MB). SS12.6 discipline: context,
    //     never a cause — it includes this diagnostic's own probes and the
    //     panels of whatever page the caller came from.
    {
        const jobs = await probeOwnJobs(runner);
        if (jobs.skipped) note('Search jobs visible to you', 'skipped', 'Budget exhausted or cancelled.');
        else if (jobs.error) note('Search jobs visible to you', 'error', jobs.error);
        else {
            let queued = 0;
            let running = 0;
            (jobs.rows as Array<{ content?: { dispatchState?: unknown } }>).forEach((r) => {
                const s =
                    r && r.content && typeof r.content.dispatchState === 'string'
                        ? r.content.dispatchState.toUpperCase()
                        : '';
                if (s === 'QUEUED') queued += 1;
                else if (s === 'RUNNING' || s === 'PARSING' || s === 'FINALIZING') running += 1;
            });
            ev.ownJobs = {
                returned: jobs.rows.length,
                queued,
                running,
                capped: jobs.rows.length >= OWN_JOBS_COUNT_CAP,
            };
            note(
                'Search jobs visible to you',
                'ok',
                `${jobs.rows.length} artifact(s)${ev.ownJobs.capped ? ' (capped)' : ''}, ${queued} queued, ${running} running - includes this diagnostic's own probes; context, not a cause`,
            );
        }
    }

    // 3. Companion apps (design §7.3) — one listing, checked client-side.
    //    The probe itself lives in diagEvidence (§14.8a): the panel path also
    //    needs it, and importing FROM this module there would close a cycle.
    tick('Checking companion apps…');
    const apps = await probeInstalledApps(runner);
    if (apps.skipped) note('Companion apps', 'skipped', 'Budget exhausted or cancelled.');
    else if (apps.error) note('Companion apps', 'error', apps.error);
    else {
        const names = apps.rows
            .map((r) => (typeof (r as Record<string, unknown>).name === 'string' ? String((r as Record<string, unknown>).name) : ''))
            .filter((s) => s.length > 0);
        const present: Record<string, boolean> = {};
        COMPANION_APPS.forEach((a) => {
            present[a.id] = names.indexOf(a.id) !== -1;
        });
        ev.appsPresent = present;
        note(
            'Companion apps',
            'ok',
            COMPANION_APPS.map((a) => `${a.id}=${present[a.id] ? 'yes' : 'no'}`).join(' '),
        );
    }

    // 4. The index: macro definition, windowed presence, visibility.
    tick('Checking the index…');
    const mi = await fetchMacroIndexes(runner);
    if (mi.skipped) note('Index named by the app macro', 'skipped', 'Budget exhausted or cancelled.');
    else if (mi.error || mi.indexes === null) {
        note('Index named by the app macro', 'error', mi.error || 'Macro definition unreadable.');
    } else {
        ev.macroIndexes = mi.indexes;
        note('Index named by the app macro', 'ok', mi.indexes.join(', ') || '(none)');
    }
    const idx = await probeIndexPresence(runner, earliest, latest);
    if (idx.skipped) note('Events in window', 'skipped', 'Budget exhausted or cancelled.');
    else if (idx.error) note('Events in window', 'error', idx.error);
    else {
        ev.indexCounts = toRecordNumber(idx.rows as Array<Record<string, unknown>>, 'index', 'count');
        const total = Object.keys(ev.indexCounts).reduce(
            (a, k) => a + (ev.indexCounts as Record<string, number>)[k],
            0,
        );
        note('Events in window', 'ok', `${total.toLocaleString()} across ${Object.keys(ev.indexCounts).length} index(es)`);
    }
    const vis = await probeVisibleIndexes(runner);
    if (!vis.skipped && !vis.error) {
        ev.visibleIndexCount = vis.rows.length;
        note('Indexes visible to this role', 'ok', String(vis.rows.length));
    } else if (vis.error) {
        note('Indexes visible to this role', 'error', vis.error);
    }

    // 5. Sourcetypes: windowed counts (one tstats, unfiltered) + all-time
    //    last-seen (metadata — needs the resolved literal index name).
    tick('Checking sourcetypes…');
    const stc = await probeSourcetypeCounts(runner, [], earliest, latest);
    if (stc.skipped) note('Sourcetype counts in window', 'skipped', 'Budget exhausted or cancelled.');
    else if (stc.error) note('Sourcetype counts in window', 'error', stc.error);
    else {
        ev.sourcetypeWindowCounts = toRecordNumber(
            stc.rows as Array<Record<string, unknown>>,
            'sourcetype',
            'count',
        );
        note('Sourcetype counts in window', 'ok', `${Object.keys(ev.sourcetypeWindowCounts).length} present`);
    }
    const idxNames = ev.indexCounts ? Object.keys(ev.indexCounts) : [];
    const singleIdx =
        idxNames.length === 1
            ? idxNames[0]
            : ev.macroIndexes && ev.macroIndexes.length === 1
              ? ev.macroIndexes[0]
              : '';
    if (!singleIdx) {
        note(
            'Sourcetype last seen (all time)',
            'superseded',
            'Needs a single resolved index name, which neither the window count nor the macro produced.',
        );
    } else {
        const meta = await probeSourcetypeMetadata(runner, singleIdx);
        if (meta.skipped) note('Sourcetype last seen (all time)', 'skipped', 'Budget exhausted or cancelled.');
        else if (meta.error) note('Sourcetype last seen (all time)', 'error', meta.error);
        else {
            ev.sourcetypeLastSeen = toRecordNumber(
                meta.rows as Array<Record<string, unknown>>,
                'sourcetype',
                'lastTime',
            );
            note('Sourcetype last seen (all time)', 'ok', `${Object.keys(ev.sourcetypeLastSeen).length} known`);
        }
    }

    // 5.5 SS16.5 — data coverage: daily series (source-capped, SS16.8a-21),
    //     clz distribution (the DENOMINATOR is the index total — a zero-row
    //     BY-clz result against a populated index is a REAL state, SS16.8a-22)
    //     and host counts. All tstats-cheap; all tri-state.
    tick('Checking data coverage…');
    {
        const daily = await probeDailyCounts(runner, earliest, latest);
        if (daily.skipped) note('Daily event series', 'skipped', 'Budget exhausted or cancelled.');
        else if (daily.error) note('Daily event series', 'error', daily.error);
        else {
            const rows: Array<{ day: number; count: number }> = [];
            (daily.rows as Array<Record<string, unknown>>).forEach((r) => {
                /* The oneshot JSON renders `_time` as an ISO STRING
                 * ("2026-08-09T00:00:00.000-05:00"), not an epoch — caught in
                 * the build-315 rendered pass (0 days from a populated index).
                 * Accept both forms; drop what parses as neither. */
                const rawT = r._time;
                const asNum = typeof rawT === 'number' ? rawT : Number(rawT);
                const d = Number.isFinite(asNum)
                    ? asNum
                    : Math.floor(Date.parse(String(rawT)) / 1000);
                const c = Number(r.count);
                if (Number.isFinite(d) && Number.isFinite(c)) rows.push({ day: d, count: c });
            });
            rows.sort((a, b) => a.day - b.day);
            ev.dailyCounts = rows;
            note('Daily event series', 'ok', `${rows.length} day(s)`);
        }
        const clz = await probeClzCounts(runner, earliest, latest);
        if (clz.skipped) note('clz_dir/clz_subdir distribution', 'skipped', 'Budget exhausted or cancelled.');
        else if (clz.error) note('clz_dir/clz_subdir distribution', 'error', clz.error);
        else {
            const rows: Array<{ dir: string; sub: string; count: number }> = [];
            (clz.rows as Array<Record<string, unknown>>).forEach((r) => {
                const c = Number(r.count);
                if (typeof r.clz_dir === 'string' && Number.isFinite(c)) {
                    rows.push({
                        dir: r.clz_dir,
                        sub: typeof r.clz_subdir === 'string' ? r.clz_subdir : '',
                        count: c,
                    });
                }
            });
            ev.clzCounts = rows;
            note('clz_dir/clz_subdir distribution', 'ok', `${rows.length} pair(s) (events without the fields are not in this table)`);
        }
        const hc = await probeHostCounts(runner, earliest, latest);
        if (hc.skipped) note('Host counts', 'skipped', 'Budget exhausted or cancelled.');
        else if (hc.error) note('Host counts', 'error', hc.error);
        else {
            ev.hostCounts = toRecordNumber(hc.rows as Array<Record<string, unknown>>, 'host', 'count');
            note('Host counts', 'ok', `top ${Object.keys(ev.hostCounts).length} host(s)`);
        }
        const hd = await probeHostDc(runner, earliest, latest);
        if (!hd.skipped && !hd.error && hd.rows.length > 0) {
            const v = Number((hd.rows[0] as Record<string, unknown>).hosts);
            if (Number.isFinite(v)) {
                ev.hostTotal = v;
                note('Distinct hosts', 'ok', String(v));
            }
        } else if (hd.error) {
            note('Distinct hosts', 'error', hd.error);
        }
    }

    // 6. Every rollup collection's extent, classified per grain. The KV REST
    //    read is 12–565 ms per collection; ~28 collections is a few seconds.
    const nowSec = Math.floor(Date.now() / 1000);
    for (let i = 0; i < ROLLUPS.length; i += 1) {
        const def = ROLLUPS[i];
        tick(`Checking summarised data ${i + 1}/${ROLLUPS.length}…`);
        for (let c = 0; c < def.completenessCollections.length; c += 1) {
            const collection = def.completenessCollections[c];
            if (runner.isCancelled() || runner.remainingMs() <= 0) {
                ev.budgetExhausted = true;
                ev.rollups.push({
                    key: def.key,
                    label: def.label,
                    collection,
                    grain: def.bucketField === 'day_ts' ? 'daily' : 'hourly',
                    probed: false,
                    oldest: null,
                    newest: null,
                    lagSeconds: null,
                    status: 'not-checked',
                    bucketContinuity: null,
                });
                continue;
            }
            // eslint-disable-next-line no-await-in-loop
            const extent = await kvExtent(runner, collection, def.bucketField);
            const probed = !extent.skipped && !extent.error;
            const grain: 'hourly' | 'daily' = def.bucketField === 'day_ts' ? 'daily' : 'hourly';
            const cls = classifyRollupExtent(probed, extent.oldest, extent.newest, grain, nowSec);
            // §17.8a-18 — check 18: an EXACT distinct-bucket count over a recent
            // window via `stats dc(<bf>)` (no row cap, no truncation). Report
            // path only; skipped if the extent read failed.
            let bucketContinuity: { present: number; expected: number } | null = null;
            if (opts?.bucketContinuity && probed && isSafeIdentifier(collection)) {
                const bf = def.bucketField;
                const winE = grain === 'daily' ? '-3d@d' : '-72h@h';
                const expected = grain === 'daily' ? 3 : 71;
                // eslint-disable-next-line no-await-in-loop
                const bc = await runner.search(
                    `| inputlookup ${collection} | addinfo | where ${bf}>=info_min_time AND ${bf}<info_max_time | stats dc(${bf}) as buckets`,
                    winE,
                    '@h',
                );
                if (!bc.skipped && !bc.error) {
                    const rows = bc.rows as Array<Record<string, unknown>>;
                    const v = rows[0]?.buckets;
                    const present = typeof v === 'number' ? v : Number(v);
                    if (Number.isFinite(present)) bucketContinuity = { present, expected };
                }
                if (bc.skipped) ev.budgetExhausted = true;
            }
            ev.rollups.push({
                key: def.key,
                label: def.label,
                collection,
                grain,
                probed,
                oldest: extent.oldest,
                newest: extent.newest,
                lagSeconds: cls.lagSeconds,
                status: cls.status,
                bucketContinuity,
            });
            if (extent.skipped) ev.budgetExhausted = true;
        }
    }
    note(
        'Summarised-data extents',
        'ok',
        `${ev.rollups.length} collection(s) checked (${ev.rollups.filter((r) => !r.probed).length} unreadable)`,
    );

    // 7. SS16 checks 7/8 — the Tier B platform snapshot. Liveness classifies
    //    from the UNWINDOWED extent (SS16.8a-14: a 24h-windowed read cannot
    //    see a long-dead aggregate); the windowed bounded read supplies the
    //    rendered detail; the producer's own state is read live so the
    //    empty-collection wording is verified, never guessed (SS16.8a-17).
    tick('Checking the platform snapshot…');
    {
        const nowSec = Math.floor(Date.now() / 1000);
        const snapExtent = await kvExtent(runner, SNAPSHOT_COLLECTION, 'bucket_ts');
        const snapWin = await probeSnapshotWindow(runner, nowSec);
        if (snapExtent.skipped || snapWin.skipped) {
            note('Platform snapshot', 'skipped', 'Budget exhausted or cancelled.');
        } else if (snapExtent.error && snapWin.error) {
            note('Platform snapshot', 'error', snapExtent.error || snapWin.error);
        } else {
            ev.platform = buildPlatformSnapshot(
                !snapExtent.error,
                snapExtent.newest,
                (snapWin.error ? [] : snapWin.rows) as unknown[],
                !snapWin.error && snapWin.rows.length >= SNAPSHOT_READ_LIMIT,
                nowSec,
            );
            const p = ev.platform;
            note(
                'Platform snapshot',
                'ok',
                `status ${p.status}` +
                    (p.ageSeconds !== null ? `, newest bucket ${Math.round(p.ageSeconds / 60)} min old` : '') +
                    `, ${p.bucketsPresent}/${p.bucketsExpected} recent buckets` +
                    (p.truncated ? ', windowed read TRUNCATED' : '') +
                    (p.futureDropped > 0 ? `, ${p.futureDropped} future-dated row(s) ignored` : ''),
            );
        }
        if (ev.platform.status === 'empty' || ev.platform.status === 'not-checked') {
            const prod = await fetchSavedSearchSpl(runner, SNAPSHOT_AGGREGATE);
            if (!prod.skipped && !prod.error) {
                ev.platformProducerDisabled = prod.disabled;
                const hist = await runner.rest(
                    `/en-US/splunkd/__raw/servicesNS/nobody/splunk_app_sap_logserv/saved/searches/${SNAPSHOT_AGGREGATE}/history?output_mode=json&count=1`,
                );
                if (!hist.skipped && !hist.error) ev.platformProducerHasRun = hist.rows.length > 0;
                note(
                    'Platform snapshot producer',
                    'ok',
                    `${SNAPSHOT_AGGREGATE}: ` +
                        (prod.disabled === true
                            ? 'DISABLED'
                            : ev.platformProducerHasRun === false
                              ? 'never dispatched yet'
                              : ev.platformProducerHasRun === true
                                ? 'has dispatched, but the collection is empty'
                                : 'state unknown'),
                );
            } else if (prod.error) {
                note('Platform snapshot producer', 'error', prod.error);
            }
        }
    }

    if (runner.remainingMs() <= 0) ev.budgetExhausted = true;
    return ev;
};
