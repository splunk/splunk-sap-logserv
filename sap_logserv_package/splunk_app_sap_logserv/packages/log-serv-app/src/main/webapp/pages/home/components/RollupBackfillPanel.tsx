import React, { useCallback, useEffect, useRef, useState } from 'react';
import styled from 'styled-components';
import { logservTheme } from '../styles/logservTheme';
import {
    RollupDef,
    ROLLUPS,
    ROLLUPS_SORTED,
    ALL_AGG_SEARCHES,
    ALL_COLLECTIONS,
    FIXED30_BACKFILL_STANZAS,
} from '../routes/rollupRegistry';
import { COMPLETE_SECONDS } from '../utils/diagEnvironment';
import {
    resolveWindow,
    planChunks,
    isCostlyWindow,
    toUtcDateString,
    PRESET_DAYS,
    DEFAULT_PRESET_DAYS,
    RETENTION_DAYS,
} from '../utils/backfillWindow';
import type { ResolvedWindow, WindowChoice } from '../utils/backfillWindow';
import {
    decidePoll,
    observeJob,
    pollDelayMs,
    mergeRowOutcome,
    INITIAL_TRACKER,
} from '../utils/backfillPoll';
import type { ArmVerdict, PollObservation, PollTracker, RowOutcome } from '../utils/backfillPoll';

/**
 * Dashboard Data — admin control for the entire KV-Store rollup data layer that
 * powers the dashboard suite AND the Environment Topology view. One uniform
 * panel managing aggregation, backfill, retention, and clear for every rollup.
 *
 * This panel was the merge target for the former "Topology" settings tab
 * (session 063 / build 245): the topology graph collections (nodes/edges/
 * inventory) are now just one more rollup row, so the master aggregation switch,
 * the per-rollup table, and the one-click backfill cover them uniformly. The
 * topology backfill switches from the old single-`| union` saved-search dispatch
 * (which truncated at scale) to the per-arm top-level dispatch below.
 *
 * WHY NOT JUST DISPATCH THE *_backfill SAVED SEARCHES:
 *   Each [logserv_<coll>_backfill] saved search is `| union [arm1]..[armN]`.
 *   Splunk runs a `| union`'s non-first arms as SUBSEARCHES with a ~30s
 *   wall-clock limit. At customer scale (~10M+ events/day) a 30-day arm blows
 *   that limit and SILENTLY TRUNCATES — the install rollup ends up 58-81%
 *   undercounted (session 054). The ongoing hourly `*_aggregate` is safe
 *   (1-hour scan); only the one-shot install backfill breaks.
 *
 *   THE FIX (proven byte-exact at 335M, session 054 fix_backfill.py): parse each
 *   union into its arms + post-union tail and dispatch each `<arm> <tail>` as a
 *   TOP-LEVEL ad-hoc search. A top-level search is the unlimited primary — it has
 *   NO subsearch wall-clock cap — so every arm completes and the rollup is
 *   byte-exact. `outputlookup append=true` upserts by `_key`, so re-running is
 *   idempotent + resumable. This panel ports that orchestration to the browser
 *   with limited concurrency + a progress bar.
 *
 * REST surface (all relative to the Splunk Web origin, `/en-US/splunkd/__raw/`):
 *   GET    saved/searches/<name>?output_mode=json              (info + SPL)
 *   POST   saved/searches/<name>/{enable,disable}?output_mode=json
 *   POST   search/jobs?output_mode=json                        (ad-hoc dispatch)
 *   GET    search/jobs/<sid>?output_mode=json                  (poll)
 *   POST   search/jobs/oneshot?output_mode=json                (completeness)
 *   DELETE storage/collections/data/<collection>?output_mode=json (clear)
 *
 * Session 063 / build 245 (merged Topology + Dashboard Data tabs).
 */

const APP = 'splunk_app_sap_logserv';
/* Splunk Web's REST proxy requires the `/en-US/splunkd/__raw/` prefix — direct
 * `/servicesNS/...` URLs hit Splunk Web's rewriter and 404. Same convention as
 * topology/persistence.ts. */
const NS_PREFIX = `/en-US/splunkd/__raw/servicesNS/nobody/${APP}`;

const BACKFILL_EARLIEST = '-30d@d';
const BACKFILL_LATEST = '@h';
/** Concurrent top-level arm-searches. Top-level searches just queue for slots
 *  (no subsearch wall-clock cap → no truncation), so mild concurrency is safe
 *  and faster than strict serial without overwhelming the search tier. */
const CONCURRENCY = 3;
/* How long to wait on each arm-search, and what counts as its failure, lives in
 * utils/backfillPoll.ts - wait on the JOB, not a clock (session 134, build 357).
 * Build 353 gave up after a fixed 2,000 polls (~90 min) and called the arm
 * FAILED while the search kept running and writing on the server: a false
 * failure at about twice the reference box's volume, and a re-run that repeated
 * the work. It also failed an arm after ~60 s of poll errors. Now the panel
 * waits as long as Splunk reports the job alive, fails it only on Splunk's own
 * verdict (FAILED, a zombie process, a vanished job), and reports anything else
 * that ends the wait - Cancel, the 24 h backstop, lost contact - as "still
 * running on the server". */
/* COMPLETE_SECONDS ("a rollup is complete when its oldest bucket reaches back
 * ~30 days") moved to utils/diagEnvironment.ts in session 096 so this panel and
 * the #/diagnostics page share the completeness PREDICATE structurally. NOTE:
 * it remains an oldest-bucket heuristic — it proves history reaches back, not
 * that every interior bucket is dense. A prior *truncated* union-backfill could
 * leave the right oldest bucket with gaps and read as complete; "Re-run
 * backfill (all)" recovers it (idempotent). A fresh install via this panel is
 * always dense. */
/** Uniform retention window across every rollup (set in the *_retention saved
 *  searches). Displayed read-only; change default/savedsearches.conf to alter. */
const RETENTION_DISPLAY = '365 days';

/* The rollup registry moved to routes/rollupRegistry.ts in session 095 — the
   Missing-Data Diagnostic needs it too, and a second copy would drift (it
   already did once, session 062). */

// ─── REST helpers (raw fetch — the repo's model for imperative dispatch/poll) ──
/** Read Splunk Web's CSRF token (`splunkweb_csrf_token_<port>` cookie). */
const getCsrfToken = (): string => {
    for (const c of document.cookie.split(';')) {
        const [k, v] = c.trim().split('=');
        if (k && k.startsWith('splunkweb_csrf_token_') && v) return decodeURIComponent(v);
    }
    return '';
};

const postHeaders = (): Record<string, string> => ({
    'X-Requested-With': 'XMLHttpRequest',
    'X-Splunk-Form-Key': getCsrfToken(),
    'Content-Type': 'application/x-www-form-urlencoded',
});
const getHeaders = (): Record<string, string> => ({ 'X-Requested-With': 'XMLHttpRequest' });

interface SavedSearchInfo {
    exists: boolean;
    disabled: boolean;
    cronSchedule: string;
    nextScheduled: string | null;
}

/** GET a saved search's enable/cron metadata (for the aggregation toggle +
 *  Schedule column). Lifted from the former TopologySettingsPanel. */
const fetchSavedSearchInfo = async (name: string): Promise<SavedSearchInfo> => {
    try {
        const res = await fetch(`${NS_PREFIX}/saved/searches/${name}?output_mode=json`, {
            credentials: 'same-origin',
            headers: getHeaders(),
        });
        if (!res.ok) return { exists: false, disabled: true, cronSchedule: '', nextScheduled: null };
        const json = await res.json();
        const entry = json?.entry?.[0];
        if (!entry) return { exists: false, disabled: true, cronSchedule: '', nextScheduled: null };
        const content = entry.content ?? {};
        return {
            exists: true,
            disabled: content.disabled === true || content.disabled === '1' || content.disabled === 1,
            cronSchedule: content.cron_schedule ?? '',
            nextScheduled: content.next_scheduled_time ?? null,
        };
    } catch {
        return { exists: false, disabled: true, cronSchedule: '', nextScheduled: null };
    }
};

/** POST enable/disable on a saved search. Lifted from TopologySettingsPanel. */
const setSavedSearchEnabled = async (name: string, enabled: boolean): Promise<boolean> => {
    const action = enabled ? 'enable' : 'disable';
    try {
        const res = await fetch(`${NS_PREFIX}/saved/searches/${name}/${action}?output_mode=json`, {
            method: 'POST',
            credentials: 'same-origin',
            headers: postHeaders(),
        });
        return res.ok;
    } catch {
        return false;
    }
};

/** DELETE every row in a KV collection. Lifted from TopologySettingsPanel. */
const clearCollection = async (collection: string): Promise<boolean> => {
    try {
        const res = await fetch(
            `${NS_PREFIX}/storage/collections/data/${collection}?output_mode=json`,
            { method: 'DELETE', credentials: 'same-origin', headers: postHeaders() },
        );
        return res.ok;
    } catch {
        return false;
    }
};

/** GET the backfill saved search's `search` SPL string. */
const fetchBackfillSpl = async (stanza: string): Promise<string | null> => {
    try {
        const res = await fetch(`${NS_PREFIX}/saved/searches/${stanza}?output_mode=json`, {
            credentials: 'same-origin',
            headers: getHeaders(),
        });
        if (!res.ok) return null;
        const json = await res.json();
        const spl = json?.entry?.[0]?.content?.search;
        return typeof spl === 'string' ? spl : null;
    } catch {
        return null;
    }
};

/** Dispatch an AD-HOC async search → returns the sid (or null). exec_mode=normal
 *  runs it server-side as an unlimited TOP-LEVEL search.
 *
 *  The raw REST `search/jobs` endpoint (unlike Splunk Web's search bar, and unlike
 *  `@splunk/search-job`) does NOT implicitly prepend `search` — an EVENT search
 *  must begin with the literal `search` token or a `|` generating command, else
 *  the job returns empty/errors (session-048 sticky #4). The union arms already
 *  start with `search \`macro\``; the single-pipeline backfills start with the
 *  bare macro, so we normalize a leading `search` here. */
const dispatchAdHoc = async (
    spl: string,
    earliest: number,
    latest: number,
): Promise<string | null> => {
    const norm = /^\s*(search\b|\|)/i.test(spl) ? spl : `search ${spl}`;
    const params = new URLSearchParams();
    params.set('search', norm);
    /* EPOCH, not a formatted time string. The search head resolves an absolute
     * time string in ITS OWN timezone, which is not necessarily the box's
     * (session-116: SH-rendered timestamps are SH-local even on a UTC box), so a
     * formatted window would silently shift by the SH offset. Epoch has no
     * timezone to get wrong. */
    params.set('earliest_time', String(earliest));
    params.set('latest_time', String(latest));
    params.set('exec_mode', 'normal');
    params.set('output_mode', 'json');
    try {
        const res = await fetch(`${NS_PREFIX}/search/jobs?output_mode=json`, {
            method: 'POST',
            credentials: 'same-origin',
            headers: postHeaders(),
            body: params.toString(),
        });
        if (!res.ok) return null;
        const json = await res.json();
        return json?.sid ?? json?.entry?.[0]?.content?.sid ?? null;
    } catch {
        return null;
    }
};

/** One status poll, reduced to an observation by the wait policy. A thrown
 *  fetch (network down) is a poll ERROR, never a verdict. */
const pollJobOnce = async (sid: string): Promise<PollObservation> => {
    try {
        const res = await fetch(`${NS_PREFIX}/search/jobs/${encodeURIComponent(sid)}?output_mode=json`, {
            credentials: 'same-origin',
            headers: getHeaders(),
        });
        const body = res.ok ? await res.json().catch(() => null) : null;
        return observeJob(res.status, body);
    } catch {
        return { kind: 'error' };
    }
};

interface ArmOutcome {
    verdict: ArmVerdict;
    /** null only when the dispatch itself failed. */
    sid: string | null;
}

/** Dispatch one arm and wait on the job (utils/backfillPoll.ts). Cancel stops
 *  the WAITING, not the job: an arm in flight at Cancel is reported DETACHED
 *  ("still running on the server"), because it is. */
const runArm = async (
    spl: string,
    earliest: number,
    latest: number,
    shouldCancel: () => boolean,
): Promise<ArmOutcome> => {
    const sid = await dispatchAdHoc(spl, earliest, latest);
    if (!sid) return { verdict: 'failed', sid: null };
    const dispatchedAt = Date.now();
    let tracker: Readonly<PollTracker> = INITIAL_TRACKER;
    for (;;) {
        if (shouldCancel()) return { verdict: 'detached', sid };
        await new Promise((r) => window.setTimeout(r, pollDelayMs(Date.now() - dispatchedAt)));
        if (shouldCancel()) return { verdict: 'detached', sid };
        const d = decidePoll(await pollJobOnce(sid), tracker, Date.now(), dispatchedAt);
        if (d.verdict !== 'continue') return { verdict: d.verdict, sid };
        tracker = d.tracker;
    }
};

/** Blocking oneshot returning {n, m} for the completeness detector. n=0 → empty
 *  collection; m = oldest bucket epoch (0 if empty / flat collection). */
const fetchOldestBucket = async (
    collection: string,
    bucketField: string,
): Promise<{ n: number; m: number } | null> => {
    const params = new URLSearchParams();
    params.set(
        'search',
        `| inputlookup ${collection} | stats count as n, min(${bucketField}) as m | fillnull value=0 m`,
    );
    params.set('output_mode', 'json');
    params.set('count', '1');
    try {
        const res = await fetch(`${NS_PREFIX}/search/jobs/oneshot?output_mode=json`, {
            method: 'POST',
            credentials: 'same-origin',
            headers: postHeaders(),
            body: params.toString(),
        });
        if (!res.ok) return null;
        const json = await res.json();
        const row = Array.isArray(json?.results) ? json.results[0] : undefined;
        if (!row) return { n: 0, m: 0 }; // empty collection → 0 rows from stats
        return { n: Number(row.n) || 0, m: Number(row.m) || 0 };
    } catch {
        return null;
    }
};

/** Quote-aware union splitter — port of fix_backfill.py parse_union. Tracks
 *  double-quote state (counting consecutive preceding backslashes so an escaped
 *  backslash `\\"` is NOT mistaken for an escaped quote `\"`) so `[`/`]` inside
 *  quoted rex regexes (e.g. linux's "kernel:.*?\]...") don't confuse arm
 *  boundaries. Returns arms=[] for a single-pipeline (no `| union`) search — the
 *  caller then dispatches the whole SPL as one top-level search. */
const parseUnion = (spl: string): { arms: string[]; tail: string } => {
    const trimmed = spl.trim();
    if (!/^\|\s*union\b/.test(trimmed)) return { arms: [], tail: '' };
    const s = trimmed.replace(/^\|\s*union\s+/, '');
    const arms: string[] = [];
    let depth = 0;
    let start = -1;
    let rest = 0;
    let inQ = false;
    for (let i = 0; i < s.length; i += 1) {
        const ch = s[i];
        if (ch === '"') {
            let bs = 0;
            let j = i - 1;
            while (j >= 0 && s[j] === '\\') {
                bs += 1;
                j -= 1;
            }
            if (bs % 2 === 0) inQ = !inQ;
        } else if (!inQ) {
            if (ch === '[') {
                if (depth === 0) start = i + 1;
                depth += 1;
            } else if (ch === ']') {
                depth -= 1;
                if (depth === 0) {
                    arms.push(s.slice(start, i).trim());
                    rest = i + 1;
                }
            }
        }
    }
    return { arms, tail: s.slice(rest).trim() };
};

/** Build the flat list of top-level work-items (one per arm, or one whole SPL
 *  for single-pipeline backfills) for the given rollups. A logical rollup may
 *  have multiple backfill stanzas (topology=3, beaconing=2); arms across all its
 *  stanzas are flattened under the same key. */
interface WorkItem {
    key: string;
    label: string;
    spl: string;
    armIndex: number;
    armCount: number;
    /** epoch seconds — this item's own window, which is NOT always the run's
     *  window (the FIXED30 stanzas get a pinned 30 days). */
    earliest: number;
    latest: number;
    /** "Jun 2025" when the arm was split into monthly chunks; '' when it runs
     *  whole. Shown in the progress line so a failure names a re-runnable month. */
    chunkLabel: string;
}

/**
 * Expand the selected rollups into dispatchable units.
 *
 * Two dimensions of expansion, in order:
 *   1. ARMS — each `*_backfill` stanza's `| union` is split so every arm is a
 *      TOP-LEVEL search. Pre-existing and load-bearing: the bundled saved
 *      searches truncate at customer scale because subsearches hit a wall-clock
 *      cap.
 *   2. CHUNKS — each arm is then split at UTC calendar-month boundaries, so no
 *      single dispatch has to cover a year. Month boundaries are also DAY
 *      boundaries, which is what keeps the day-scoped rollups correct. A window
 *      no longer than one calendar month runs WHOLE (planChunks) -- splitting it
 *      only doubled the default run's dispatches (session 132).
 *
 * The FIXED30 stanzas take neither the run's window nor any chunking — see the
 * block comment on FIXED30_BACKFILL_STANZAS for why forcing them would be
 * silently wrong rather than merely slow.
 */
const buildWorkItems = async (
    defs: RollupDef[],
    win: ResolvedWindow,
    fixed30: ResolvedWindow,
): Promise<WorkItem[]> => {
    const items: WorkItem[] = [];
    for (const def of defs) {
        const loaded = await Promise.all(
            def.backfillStanzas.map(async (stanza) => ({
                stanza,
                spl: await fetchBackfillSpl(stanza),
            })),
        );
        const arms: Array<{ spl: string; win: ResolvedWindow; chunk: boolean }> = [];
        loaded.forEach(({ stanza, spl }) => {
            if (!spl) return;
            const pinned = FIXED30_BACKFILL_STANZAS.has(stanza);
            const w = pinned ? fixed30 : win;
            const { arms: parsed, tail } = parseUnion(spl);
            if (parsed.length === 0) arms.push({ spl, win: w, chunk: !pinned });
            else parsed.forEach((a) => arms.push({ spl: `${a} ${tail}`, win: w, chunk: !pinned }));
        });
        if (arms.length === 0) {
            // every stanza was unreadable → one failed sentinel item
            items.push({
                key: def.key, label: def.label, spl: '', armIndex: 1, armCount: 1,
                earliest: win.earliest, latest: win.latest, chunkLabel: '',
            });
            continue;
        }
        arms.forEach((arm, i) => {
            const chunks = arm.chunk ? planChunks(arm.win.earliest, arm.win.latest) : [];
            const units = chunks.length > 1
                ? chunks
                : [{ earliest: arm.win.earliest, latest: arm.win.latest, label: '' }];
            units.forEach((u) => {
                items.push({
                    key: def.key,
                    label: def.label,
                    spl: arm.spl,
                    armIndex: i + 1,
                    armCount: arms.length,
                    earliest: u.earliest,
                    latest: u.latest,
                    chunkLabel: units.length > 1 ? u.label : '',
                });
            });
        });
    }
    return items;
};

// ─── styled (mirror TopologySettingsPanel / AIAssistantSettings conventions) ───
const SectionHeading = styled.h3`
    margin: ${logservTheme.spacing.lg} 0 0;
    padding: ${logservTheme.spacing.xs} 0 ${logservTheme.spacing.sm};
    border-bottom: 1px solid ${logservTheme.colors.cyanAccent};
    color: ${logservTheme.colors.cyanLight};
    text-transform: uppercase;
    letter-spacing: 1.2px;
    font-size: ${logservTheme.fontSize.body};
    font-weight: ${logservTheme.fontWeight.semibold};
    &:first-child {
        margin-top: 0;
    }
`;
const FieldRow = styled.div`
    display: grid;
    grid-template-columns: clamp(320px, 30%, 520px) 1fr auto;
    gap: ${logservTheme.spacing.md};
    align-items: center;
    padding: ${logservTheme.spacing.sm} 0;
    border-bottom: 1px solid ${logservTheme.colors.panelBorderWeak};
    &:last-child {
        border-bottom: 0;
    }
`;
const FieldLabel = styled.label`
    color: ${logservTheme.colors.textActive};
    font-size: ${logservTheme.fontSize.body};
    font-weight: ${logservTheme.fontWeight.semibold};
`;
const FieldHint = styled.div`
    color: ${logservTheme.colors.textMuted};
    font-size: ${logservTheme.fontSize.body};
    margin-top: 2px;
`;
const FieldStatus = styled.div<{ $tone: 'good' | 'absent' | 'error' | 'warn' }>`
    color: ${(p) =>
        p.$tone === 'good'
            ? logservTheme.colors.teal
            : p.$tone === 'error'
            ? logservTheme.colors.red
            : p.$tone === 'warn'
            ? logservTheme.colors.orange
            : logservTheme.colors.textMuted};
    font-size: ${logservTheme.fontSize.body};
    font-style: italic;
    margin-top: 2px;
`;
const Banner = styled.div<{ $tone: 'warn' | 'good' | 'error' }>`
    display: flex;
    align-items: center;
    gap: ${logservTheme.spacing.sm};
    padding: ${logservTheme.spacing.sm} ${logservTheme.spacing.md};
    margin-bottom: ${logservTheme.spacing.md};
    border-radius: ${logservTheme.radius.small};
    border: 1px solid
        ${(p) =>
            p.$tone === 'warn'
                ? logservTheme.colors.orange
                : p.$tone === 'error'
                ? logservTheme.colors.red
                : logservTheme.colors.teal};
    background: ${(p) =>
        p.$tone === 'warn'
            ? 'rgba(241,129,63,0.12)'
            : p.$tone === 'error'
            ? 'rgba(220,78,65,0.12)'
            : 'rgba(0,212,180,0.10)'};
    color: ${(p) =>
        p.$tone === 'warn'
            ? logservTheme.colors.orange
            : p.$tone === 'error'
            ? logservTheme.colors.red
            : logservTheme.colors.teal};
    font-size: ${logservTheme.fontSize.body};
`;
const Button = styled.button<{ $variant?: 'primary' | 'danger' }>`
    background: ${(p) =>
        p.$variant === 'primary'
            ? logservTheme.colors.cyanAccent
            : p.$variant === 'danger'
            ? logservTheme.colors.red
            : 'transparent'};
    color: ${(p) =>
        p.$variant === 'primary' || p.$variant === 'danger'
            ? logservTheme.colors.inverseText
            : logservTheme.colors.textActive};
    border: 1px solid
        ${(p) =>
            p.$variant === 'primary'
                ? logservTheme.colors.cyanAccent
                : p.$variant === 'danger'
                ? logservTheme.colors.red
                : logservTheme.colors.panelBorderWeak};
    border-radius: ${logservTheme.radius.small};
    padding: 6px 14px;
    cursor: pointer;
    font-family: inherit;
    font-size: ${logservTheme.fontSize.body};
    font-weight: ${logservTheme.fontWeight.semibold};
    &:hover:not(:disabled) {
        opacity: 0.85;
    }
    &:disabled {
        opacity: 0.5;
        cursor: not-allowed;
    }
`;
/** compact text-button for the per-row Backfill / Clear actions. */
const SmallButton = styled.button<{ $variant?: 'danger' }>`
    background: transparent;
    color: ${(p) => (p.$variant === 'danger' ? logservTheme.colors.red : logservTheme.colors.cyanLight)};
    border: 1px solid
        ${(p) => (p.$variant === 'danger' ? 'rgba(220,78,65,0.5)' : logservTheme.colors.panelBorderWeak)};
    border-radius: ${logservTheme.radius.small};
    padding: 2px 8px;
    cursor: pointer;
    font-family: inherit;
    font-size: ${logservTheme.fontSize.body};
    white-space: nowrap;
    &:hover:not(:disabled) {
        opacity: 0.8;
    }
    &:disabled {
        opacity: 0.4;
        cursor: not-allowed;
    }
`;
const ButtonRow = styled.div`
    display: flex;
    gap: ${logservTheme.spacing.sm};
    align-items: center;
`;
const ToggleLabel = styled.label`
    display: inline-flex;
    align-items: center;
    gap: ${logservTheme.spacing.sm};
    color: ${logservTheme.colors.textActive};
    font-size: ${logservTheme.fontSize.body};
    cursor: pointer;
`;
const ReadonlyValue = styled.code`
    background: ${logservTheme.colors.tableHeaderBackground};
    color: ${logservTheme.colors.cyanLight};
    border-radius: ${logservTheme.radius.small};
    padding: 2px 8px;
    font-family: monospace;
    font-size: ${logservTheme.fontSize.body};
`;
/* NO BACKTICKS IN THESE CSS COMMENTS — a backtick terminates the tagged
   template and the file stops compiling (sessions 017, 036, 130 x3). */
const PresetRow = styled.div`
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    align-items: center;
`;

const PresetButton = styled.button<{ $on: boolean }>`
    padding: 5px 12px;
    border-radius: 999px;
    cursor: pointer;
    font: inherit;
    font-size: 12.5px;
    border: 1px solid ${(p) => (p.$on
        ? logservTheme.colors.cyanAccent
        : logservTheme.colors.panelBorderWeak)};
    background: ${(p) => (p.$on
        ? logservTheme.colors.hoverBackground
        : 'transparent')};
    color: ${(p) => (p.$on
        ? logservTheme.colors.textActive
        : logservTheme.colors.textDefault)};

    &:disabled {
        opacity: 0.5;
        cursor: default;
    }
`;

const DateRow = styled.div`
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
    margin-top: 8px;
    font-size: 12.5px;
    color: ${logservTheme.colors.textMuted};
`;

const DateInput = styled.input`
    padding: 4px 8px;
    border-radius: ${logservTheme.radius.medium};
    border: 1px solid ${logservTheme.colors.panelBorderWeak};
    background: ${logservTheme.colors.panelBackground};
    color: ${logservTheme.colors.textActive};
    font: inherit;
    font-size: 12.5px;
`;

const WindowSummary = styled.div<{ $bad: boolean }>`
    margin-top: 8px;
    font-size: 12.5px;
    line-height: 1.5;
    color: ${(p) => (p.$bad
        ? logservTheme.colors.red
        : logservTheme.colors.textMuted)};
`;

const ProgressOuter = styled.div`
    width: 100%;
    height: 10px;
    background: ${logservTheme.colors.tableHeaderBackground};
    border-radius: ${logservTheme.radius.small};
    overflow: hidden;
    margin-top: ${logservTheme.spacing.sm};
`;
const ProgressInner = styled.div<{ $pct: number }>`
    width: ${(p) => p.$pct}%;
    height: 100%;
    background: ${logservTheme.colors.cyanAccent};
    transition: width 0.3s ease;
`;

// ─── per-rollup table ─────────────────────────────────────────────────────────
const ROW_COLS = 'minmax(190px, 1.7fr) minmax(96px, 0.8fr) 92px minmax(118px, 1fr) auto';
const TableHead = styled.div`
    display: grid;
    grid-template-columns: ${ROW_COLS};
    gap: ${logservTheme.spacing.md};
    align-items: center;
    padding: ${logservTheme.spacing.xs} 0;
    margin-top: ${logservTheme.spacing.sm};
    border-bottom: 1px solid ${logservTheme.colors.cyanAccent};
    color: ${logservTheme.colors.textMuted};
    text-transform: uppercase;
    letter-spacing: 0.6px;
    font-size: ${logservTheme.fontSize.body};
    font-weight: ${logservTheme.fontWeight.semibold};
`;
const TableRow = styled.div`
    display: grid;
    grid-template-columns: ${ROW_COLS};
    gap: ${logservTheme.spacing.md};
    align-items: center;
    padding: 5px 0;
    border-bottom: 1px solid ${logservTheme.colors.panelBorderWeak};
    font-size: ${logservTheme.fontSize.body};
    &:last-child {
        border-bottom: 0;
    }
`;
const CellName = styled.span`
    color: ${logservTheme.colors.textDefault};
`;
const CellMono = styled.code`
    color: ${logservTheme.colors.textMuted};
    font-family: monospace;
    font-size: ${logservTheme.fontSize.small};
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
`;
const RowToggle = styled.label`
    display: inline-flex;
    align-items: center;
    gap: 6px;
    cursor: pointer;
    color: ${logservTheme.colors.textDefault};
`;
const HistoryVal = styled.span<{ $tone: 'good' | 'absent' | 'error' | 'warn' | 'running' }>`
    color: ${(p) =>
        p.$tone === 'good'
            ? logservTheme.colors.teal
            : p.$tone === 'error'
            ? logservTheme.colors.red
            : p.$tone === 'warn'
            ? logservTheme.colors.orange
            : p.$tone === 'running'
            ? logservTheme.colors.cyanLight
            : logservTheme.colors.textMuted};
    font-variant-numeric: tabular-nums;
`;
const RowActions = styled.div`
    display: inline-flex;
    gap: 6px;
    justify-content: flex-end;
`;

type CollStatus = 'complete' | 'incomplete' | 'running' | 'done' | 'error' | 'truncated' | 'unknown';
interface CollState {
    status: CollStatus;
    oldestBucketMs: number; // 0 if empty
    armsDone: number;
    armsTotal: number;
}
interface AggState {
    /** existing aggregate searches that are enabled. */
    enabledCount: number;
    /** aggregate searches that exist. */
    existCount: number;
    /** total declared aggregate searches. */
    total: number;
    cron: string;
    next: string | null;
}
const seedColl = (prev: CollState | undefined, status: CollStatus): CollState => ({
    status,
    oldestBucketMs: prev?.oldestBucketMs ?? 0,
    armsDone: 0,
    armsTotal: 0,
});

/** oldestBucketMs sentinel while a just-finished row re-measures its depth
 *  (session 134) - never a real epoch, never passed to fmtAge. */
const REMEASURING = -1;

const fmtAge = (ms: number): string => {
    if (!ms) return 'empty';
    const days = (Date.now() - ms) / 86400000;
    return `${days.toFixed(1)}d of history`;
};

/** Fetch + combine completeness across a rollup's bucketed collections. */
const fetchEntryHistory = async (
    def: RollupDef,
): Promise<{ status: 'complete' | 'incomplete' | 'unknown'; oldestMs: number }> => {
    const results = await Promise.all(
        def.completenessCollections.map((c) => fetchOldestBucket(c, def.bucketField)),
    );
    if (results.some((r) => r === null)) return { status: 'unknown', oldestMs: 0 };
    const rs = results as Array<{ n: number; m: number }>;
    const nowSec = Date.now() / 1000;
    const complete = rs.every((r) => r.n > 0 && r.m > 0 && r.m <= nowSec - COMPLETE_SECONDS);
    const anyEmpty = rs.some((r) => r.n === 0 || r.m === 0);
    // weakest-link history: the collection reaching back the LEAST (largest m).
    const oldestMs = anyEmpty ? 0 : Math.max(...rs.map((r) => r.m)) * 1000;
    return { status: complete ? 'complete' : 'incomplete', oldestMs };
};

// ─── panel ────────────────────────────────────────────────────────────────────
const RollupBackfillPanel: React.FC = () => {
    const [loading, setLoading] = useState<boolean>(true);
    const [collStates, setCollStates] = useState<Record<string, CollState>>({});
    const [aggStates, setAggStates] = useState<Record<string, AggState>>({});
    const [busy, setBusy] = useState<boolean>(false);
    const [togglingMaster, setTogglingMaster] = useState<boolean>(false);
    const [clearingAll, setClearingAll] = useState<boolean>(false);
    const [rowOp, setRowOp] = useState<Record<string, 'toggle' | 'clear'>>({});
    const [progress, setProgress] = useState<{ done: number; total: number; current: string }>({
        done: 0,
        total: 0,
        current: '',
    });
    const [notice, setNotice] = useState<string | null>(null);
    const [opError, setOpError] = useState<string | null>(null);
    /** The last run's "still running on the server" summary; persists until the next run. */
    const [runWarn, setRunWarn] = useState<string | null>(null);
    /** Each rollup row's outcome from the last run (utils/backfillPoll.ts). Kept
     *  apart from collStates because refresh() rebuilds those from completeness
     *  alone after every run - which used to erase the failed/truncated marks.
     *  Partial because most rows have none - a plain Record would type every
     *  lookup as present and make the completeness fallback look unreachable. */
    const [runOutcome, setRunOutcome] = useState<Partial<Record<string, RowOutcome>>>({});
    /** false once unmounted → guards every post-await setState. */
    const mountedRef = useRef<boolean>(true);
    /** user-requested cancel → stops dispatching new arms (in-flight + already-
     *  dispatched server-side jobs continue; re-run resumes via idempotency). */
    const cancelRef = useRef<boolean>(false);
    /** synchronous re-entrancy guard — `busy` is async so a double-click could
     *  otherwise launch two pools before the first setBusy(true) commits. */
    const runningRef = useRef<boolean>(false);

    /** Detect per-rollup completeness + aggregation state. */
    const refresh = useCallback(async () => {
        setLoading(true);
        const colls: Record<string, CollState> = {};
        const aggs: Record<string, AggState> = {};
        await Promise.all(
            ROLLUPS.map(async (def) => {
                const [hist, infos] = await Promise.all([
                    fetchEntryHistory(def),
                    Promise.all(def.aggregateSearches.map(fetchSavedSearchInfo)),
                ]);
                colls[def.key] = {
                    status: hist.status,
                    oldestBucketMs: hist.oldestMs,
                    armsDone: 0,
                    armsTotal: 0,
                };
                const existing = infos.filter((i) => i.exists);
                aggs[def.key] = {
                    enabledCount: existing.filter((i) => !i.disabled).length,
                    existCount: existing.length,
                    total: def.aggregateSearches.length,
                    cron: existing[0]?.cronSchedule ?? '',
                    next: existing[0]?.nextScheduled ?? null,
                };
            }),
        );
        if (!mountedRef.current) return;
        setCollStates(colls);
        setAggStates(aggs);
        setLoading(false);
    }, []);

    useEffect(() => {
        mountedRef.current = true;
        cancelRef.current = false;
        refresh();
        return () => {
            mountedRef.current = false;
            cancelRef.current = true; // stop any in-flight dispatch loop
        };
    }, [refresh]);

    const incompleteDefs = ROLLUPS.filter((d) => collStates[d.key]?.status !== 'complete');
    const allComplete = !loading && ROLLUPS.every((d) => collStates[d.key]?.status === 'complete');

    // ── master aggregation state (derived from existing aggregate searches) ──
    let totalExistAgg = 0;
    let totalEnabledAgg = 0;
    ROLLUPS.forEach((d) => {
        const a = aggStates[d.key];
        if (a) {
            totalExistAgg += a.existCount;
            totalEnabledAgg += a.enabledCount;
        }
    });
    const master: 'enabled' | 'disabled' | 'mixed' | 'unknown' =
        totalExistAgg === 0
            ? 'unknown'
            : totalEnabledAgg === totalExistAgg
            ? 'enabled'
            : totalEnabledAgg === 0
            ? 'disabled'
            : 'mixed';

    const anyOtherBusy = busy || togglingMaster || clearingAll;

    /* Window selection. Deliberately NOT persisted: a backfill window is a
     * decision about one run, and a remembered 365 would be an expensive
     * surprise on the next visit. The default is the pre-session-131 constant,
     * so an operator who ignores this control gets exactly the old behaviour:
     * the same window AND, via planChunks, the same single dispatch per arm
     * (build 353 had split it into two; session 132). */
    const [presetDays, setPresetDays] = useState<number | 'custom'>(DEFAULT_PRESET_DAYS);
    const [fromDate, setFromDate] = useState<string>('');
    const [toDate, setToDate] = useState<string>('');

    const winChoice: WindowChoice = presetDays === 'custom'
        ? { kind: 'custom', from: fromDate, to: toDate }
        : { kind: 'preset', days: presetDays };
    /* Resolved every render rather than memoised: it is arithmetic on three
     * small values, and memoising on Date.now() would pin the clock. */
    const winResult = resolveWindow(winChoice, Date.now());
    const fixed30Result = resolveWindow({ kind: 'preset', days: 30 }, Date.now());
    const winOk = winResult.ok && fixed30Result.ok;
    const chunkCount = winResult.ok
        ? planChunks(winResult.window.earliest, winResult.window.latest).length
        : 0;
    const startBackfill = (defs: RollupDef[]): void => {
        if (!winResult.ok || !fixed30Result.ok) return;
        void runBackfill(defs, winResult.window, fixed30Result.window);
    };

    const runBackfill = useCallback(
        async (defs: RollupDef[], win: ResolvedWindow, fixed30: ResolvedWindow) => {
            if (defs.length === 0) return;
            if (runningRef.current) return; // re-entrancy guard (busy is async)
            runningRef.current = true;
            cancelRef.current = false;
            setBusy(true);
            setOpError(null);
            setNotice(null);
            setRunWarn(null);
            setRunOutcome((prev) => {
                const next = { ...prev };
                defs.forEach((d) => {
                    delete next[d.key];
                });
                return next;
            });

            try {
                setCollStates((prev) => {
                    const next = { ...prev };
                    defs.forEach((d) => {
                        next[d.key] = seedColl(prev[d.key], 'running');
                    });
                    return next;
                });

                const items = await buildWorkItems(defs, win, fixed30);
                const failedKeys = items.filter((it) => !it.spl);
                const runnable = items.filter((it) => it.spl);
                const totals: Record<string, number> = {};
                runnable.forEach((it) => {
                    totals[it.key] = (totals[it.key] ?? 0) + 1;
                });
                /* Per-row depth refresh (session 134): a row whose arms have all
                 * finished re-measures its depth at once. Before, it showed its
                 * PRE-run depth until the whole run ended - a just-cleared row read
                 * "empty" after a successful backfill, and in a long multi-rollup
                 * run a finished row stayed stale for hours. */
                const armsLeft: Record<string, number> = { ...totals };
                const remeasure = async (key: string): Promise<void> => {
                    const def = ROLLUPS.find((d) => d.key === key);
                    if (!def || !mountedRef.current) return;
                    setCollStates((prev) => (prev[key]
                        ? { ...prev, [key]: { ...prev[key], oldestBucketMs: REMEASURING } }
                        : prev));
                    const hist = await fetchEntryHistory(def);
                    if (!mountedRef.current) return;
                    setCollStates((prev) => (prev[key]
                        ? { ...prev, [key]: { ...prev[key], oldestBucketMs: hist.oldestMs } }
                        : prev));
                };
                if (mountedRef.current) {
                    setCollStates((prev) => {
                        const next = { ...prev };
                        Object.entries(totals).forEach(([key, t]) => {
                            if (next[key]) next[key] = { ...next[key], armsTotal: t };
                        });
                        failedKeys.forEach((it) => {
                            next[it.key] = { ...seedColl(next[it.key], 'error') };
                        });
                        return next;
                    });
                    setProgress({ done: 0, total: runnable.length, current: '' });
                    if (failedKeys.length) {
                        setRunOutcome((prev) => {
                            const next = { ...prev };
                            failedKeys.forEach((it) => {
                                const merged = mergeRowOutcome(next[it.key], 'failed', null);
                                if (merged) next[it.key] = merged;
                            });
                            return next;
                        });
                    }
                }

                let idx = 0; // claim-an-index: no `await` between read+increment → atomic
                let failCount = 0;
                let truncCount = 0;
                let detachedCount = 0;
                const worker = async (): Promise<void> => {
                    for (;;) {
                        if (cancelRef.current) return;
                        const i = idx;
                        idx += 1;
                        if (i >= runnable.length) return;
                        const it = runnable[i];
                        if (mountedRef.current) {
                            setProgress((p) => ({
                                ...p,
                                current: it.chunkLabel
                                    ? `${it.label} (arm ${it.armIndex}/${it.armCount} · ${it.chunkLabel})`
                                    : `${it.label} (arm ${it.armIndex}/${it.armCount})`,
                            }));
                        }
                        const { verdict, sid } = await runArm(
                            it.spl, it.earliest, it.latest, () => cancelRef.current,
                        );
                        if (verdict === 'failed') failCount += 1;
                        else if (verdict === 'truncated') truncCount += 1;
                        else if (verdict === 'detached') detachedCount += 1;
                        if (!mountedRef.current) return;
                        setRunOutcome((prev) => {
                            const cur = prev[it.key];
                            const merged = mergeRowOutcome(cur, verdict, sid);
                            return merged === cur || !merged ? prev : { ...prev, [it.key]: merged };
                        });
                        setProgress((p) => ({ ...p, done: p.done + 1 }));
                        setCollStates((prev) => {
                            const cur = prev[it.key];
                            if (!cur) return prev;
                            const armsDone = cur.armsDone + 1;
                            const complete = armsDone >= cur.armsTotal;
                            const status: CollStatus =
                                cur.status === 'error' || verdict === 'failed'
                                    ? 'error'
                                    : cur.status === 'truncated' || verdict === 'truncated'
                                    ? 'truncated'
                                    : complete
                                    ? 'done'
                                    : 'running';
                            return { ...prev, [it.key]: { ...cur, armsDone, status } };
                        });
                        armsLeft[it.key] -= 1;
                        if (armsLeft[it.key] === 0) void remeasure(it.key);
                    }
                };
                await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

                if (!mountedRef.current) return;
                const cancelled = cancelRef.current;
                /* A detached search is not a failure: it is still running on the server
                 * and writes its rows when it finishes (utils/backfillPoll.ts). Say so
                 * persistently, not in a notice that times out. */
                setRunWarn(detachedCount
                    ? `${detachedCount} search${detachedCount === 1 ? ' was' : 'es were'} still running `
                      + 'on the server when this panel stopped waiting. They finish on their own and '
                      + 'write their rows; the rollups involved are marked "still running on server" '
                      + '(hover for the search IDs). Re-running those rollups before the searches '
                      + 'finish repeats their work.'
                    : null);
                if (cancelled) {
                    setNotice('Backfill cancelled. Re-run to complete the rest (idempotent).');
                    window.setTimeout(() => mountedRef.current && setNotice(null), 10000);
                } else if (failedKeys.length || failCount || truncCount) {
                    setOpError(
                        'Backfill finished with issues — re-run to retry (idempotent). Affected rollups are marked in the table.',
                    );
                } else if (!detachedCount) {
                    setNotice(
                        `Backfill complete (${win.label}). Each rollup's own row shows the history `
                        + 'it now holds. The two flat Environment Topology collections (inventory, '
                        + 'IP enrichment) were refreshed over the last 30 days regardless of the '
                        + 'chosen window — they describe current state, not history.',
                    );
                    window.setTimeout(() => mountedRef.current && setNotice(null), 10000);
                }
            } finally {
                runningRef.current = false;
                if (mountedRef.current) setBusy(false);
                if (mountedRef.current) await refresh();
            }
        },
        [refresh],
    );

    const handleCancel = useCallback(() => {
        cancelRef.current = true;
    }, []);

    // ── master aggregation toggle ──
    const handleToggleMaster = useCallback(async () => {
        if (master === 'unknown') return;
        const targetEnabled = master !== 'enabled'; // enabled→disable all; disabled/mixed→enable all
        setTogglingMaster(true);
        setOpError(null);
        setNotice(null);
        try {
            const results = await Promise.all(
                ALL_AGG_SEARCHES.map((name) => setSavedSearchEnabled(name, targetEnabled)),
            );
            if (results.some((ok) => !ok)) {
                setOpError('Failed to update one or more aggregation searches. Check admin permissions.');
            } else {
                setNotice(`Hourly aggregation ${targetEnabled ? 'enabled' : 'disabled'} for all rollups.`);
                window.setTimeout(() => mountedRef.current && setNotice(null), 5000);
            }
        } finally {
            if (mountedRef.current) {
                setTogglingMaster(false);
                await refresh();
            }
        }
    }, [master, refresh]);

    // ── per-row aggregation toggle ──
    const handleToggleRow = useCallback(
        async (def: RollupDef) => {
            const a = aggStates[def.key];
            if (!a || a.existCount === 0) return;
            const rowEnabled = a.enabledCount === a.total && a.existCount === a.total;
            const targetEnabled = !rowEnabled;
            setRowOp((p) => ({ ...p, [def.key]: 'toggle' }));
            setOpError(null);
            try {
                const results = await Promise.all(
                    def.aggregateSearches.map((name) => setSavedSearchEnabled(name, targetEnabled)),
                );
                if (results.some((ok) => !ok) && mountedRef.current) {
                    setOpError(`Failed to update aggregation for ${def.label}.`);
                }
            } finally {
                if (mountedRef.current) {
                    setRowOp((p) => {
                        const next = { ...p };
                        delete next[def.key];
                        return next;
                    });
                    await refresh();
                }
            }
        },
        [aggStates, refresh],
    );

    // ── per-row clear ──
    const handleClearRow = useCallback(
        async (def: RollupDef) => {
            const collList = def.collections.join(', ');
            // eslint-disable-next-line no-alert
            if (
                !window.confirm(
                    `Clear all data in the ${def.label} rollup? This deletes every row in: ${collList}. The affected dashboard${
                        def.collections.length > 1 ? '/view' : ''
                    } will be empty until the next hourly aggregation or a backfill repopulates it. This cannot be undone.`,
                )
            )
                return;
            setRowOp((p) => ({ ...p, [def.key]: 'clear' }));
            setOpError(null);
            setNotice(null);
            try {
                const results = await Promise.all(def.collections.map((c) => clearCollection(c)));
                if (results.some((ok) => !ok) && mountedRef.current) {
                    setOpError(`Failed to clear one or more collections for ${def.label}.`);
                } else if (mountedRef.current) {
                    setNotice(`${def.label} rollup cleared. Re-run its backfill or wait for the hourly aggregation to repopulate.`);
                    window.setTimeout(() => mountedRef.current && setNotice(null), 8000);
                }
            } finally {
                if (mountedRef.current) {
                    setRowOp((p) => {
                        const next = { ...p };
                        delete next[def.key];
                        return next;
                    });
                    await refresh();
                }
            }
        },
        [refresh],
    );

    // ── global clear ──
    const handleClearAll = useCallback(async () => {
        const allColls = ALL_COLLECTIONS;
        // eslint-disable-next-line no-alert
        if (
            !window.confirm(
                `CLEAR ALL DASHBOARD ROLLUP DATA? This deletes every row in all ${allColls.length} rollup collections across all ${ROLLUPS.length} rollups (every dashboard AND the Environment Topology graph + detail tabs). Every dashboard will be empty until the hourly aggregation or a backfill repopulates. This action CANNOT be undone.`,
            )
        )
            return;
        setClearingAll(true);
        setOpError(null);
        setNotice(null);
        try {
            const results = await Promise.all(allColls.map((c) => clearCollection(c)));
            if (results.some((ok) => !ok) && mountedRef.current) {
                setOpError('Failed to clear one or more collections. Some rollups may still hold data.');
            } else if (mountedRef.current) {
                setNotice('All dashboard rollups cleared. Run the backfill to repopulate history.');
                window.setTimeout(() => mountedRef.current && setNotice(null), 8000);
            }
        } finally {
            if (mountedRef.current) {
                setClearingAll(false);
                await refresh();
            }
        }
    }, []);

    if (loading && Object.keys(collStates).length === 0) {
        return <FieldStatus $tone="absent">Checking rollup history…</FieldStatus>;
    }

    const pct = progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;

    return (
        <>
            {notice && <Banner $tone="good">{notice}</Banner>}
            {opError && <Banner $tone="error">{opError}</Banner>}
            {runWarn && <Banner $tone="warn">{runWarn}</Banner>}
            {!busy && incompleteDefs.length > 0 && (
                <Banner $tone="warn">
                    Dashboard history backfill needed — {incompleteDefs.length} of {ROLLUPS.length}{' '}
                    rollups don&apos;t yet have a full 30 days of data. Run the backfill below to
                    populate them. Until then those dashboards show only the last hour or two.
                </Banner>
            )}
            {!busy && allComplete && (
                <Banner $tone="good">
                    All {ROLLUPS.length} dashboard rollups have ~30 days of history. No backfill
                    needed.
                </Banner>
            )}

            <SectionHeading>Aggregation &amp; retention</SectionHeading>
            <FieldRow>
                <div>
                    <FieldLabel>Hourly aggregation</FieldLabel>
                    <FieldHint>
                        Master switch for the scheduled saved searches that populate every rollup KV
                        Store collection (one per dashboard, plus the Environment Topology graph and
                        beaconing detection). When off, all dashboards gradually go stale as new
                        events aren&apos;t aggregated; existing data is retained per the window
                        below. Use the per-rollup toggles in the table to control one at a time.
                    </FieldHint>
                </div>
                <ToggleLabel>
                    <input
                        type="checkbox"
                        checked={master === 'enabled'}
                        ref={(el) => {
                            if (el) el.indeterminate = master === 'mixed';
                        }}
                        onChange={handleToggleMaster}
                        disabled={anyOtherBusy || loading || master === 'unknown'}
                    />
                    {togglingMaster
                        ? 'Updating…'
                        : master === 'enabled'
                        ? 'Enabled (all)'
                        : master === 'disabled'
                        ? 'Disabled (all)'
                        : master === 'mixed'
                        ? `Mixed (${totalEnabledAgg}/${totalExistAgg} on)`
                        : 'Unknown'}
                </ToggleLabel>
                <span />
            </FieldRow>
            <FieldRow>
                <div>
                    <FieldLabel>Retention window</FieldLabel>
                    <FieldHint>
                        Bucket rows older than this are trimmed daily by each rollup&apos;s
                        <code> *_retention</code> saved search. Uniform across all rollups — edit
                        default/savedsearches.conf to change.
                    </FieldHint>
                </div>
                <ReadonlyValue>{RETENTION_DISPLAY}</ReadonlyValue>
                <span />
            </FieldRow>

            <SectionHeading>Backfill</SectionHeading>
            <FieldRow>
                <div>
                    <FieldLabel>Backfill window</FieldLabel>
                    <FieldHint>
                        How far back to rebuild. Dates are <strong>UTC whole days</strong>. Use a
                        custom range to match a historical ingest — the{' '}
                        <strong>S3 key dates</strong> you backfilled
                        (<code>logserv/&lt;type&gt;/&lt;sub&gt;/YYYY/MM/DD/</code>), which are the
                        event dates. On the Data TA&apos;s AWS S3 Direct screen those are the{' '}
                        <strong>Scan from</strong> and <strong>Scan until</strong> dates: enter the
                        same two here, for the same rows.
                    </FieldHint>
                    <PresetRow style={{ marginTop: 8 }}>
                        {PRESET_DAYS.map((d) => (
                            <PresetButton
                                key={d}
                                type="button"
                                $on={presetDays === d}
                                disabled={anyOtherBusy || busy}
                                onClick={() => setPresetDays(d)}
                            >
                                {d} days
                            </PresetButton>
                        ))}
                        <PresetButton
                            type="button"
                            $on={presetDays === 'custom'}
                            disabled={anyOtherBusy || busy}
                            onClick={() => {
                                setPresetDays('custom');
                                if (!fromDate) {
                                    setFromDate(toUtcDateString(Date.now() - 30 * 86400000));
                                }
                                if (!toDate) setToDate(toUtcDateString(Date.now()));
                            }}
                        >
                            Custom range
                        </PresetButton>
                    </PresetRow>
                    {presetDays === 'custom' && (
                        <DateRow>
                            <label htmlFor="lsv-bf-from">From</label>
                            <DateInput
                                id="lsv-bf-from"
                                type="date"
                                value={fromDate}
                                disabled={anyOtherBusy || busy}
                                onChange={(e) => setFromDate(e.target.value)}
                            />
                            <label htmlFor="lsv-bf-to">to</label>
                            <DateInput
                                id="lsv-bf-to"
                                type="date"
                                value={toDate}
                                disabled={anyOtherBusy || busy}
                                onChange={(e) => setToDate(e.target.value)}
                            />
                            <span>(inclusive, UTC)</span>
                        </DateRow>
                    )}
                    <WindowSummary $bad={!winResult.ok}>
                        {/* A preset names its own length, so repeating it as a day
                          * count read "last 30 days — 30 day(s)"; show where it
                          * starts instead. A custom range already names its
                          * dates, so it shows the inclusive day count. */}
                        {winResult.ok
                            ? (presetDays === 'custom'
                                ? `Will rebuild ${winResult.window.label} — ${winResult.window.days} day(s)`
                                : `Will rebuild the ${winResult.window.label} (since `
                                  + `${toUtcDateString(winResult.window.earliest * 1000)} UTC)`)
                              + `${chunkCount > 1 ? `, dispatched as ${chunkCount} monthly chunks per search` : ''}.`
                            : winResult.error}
                        {winResult.ok && isCostlyWindow(winResult.window) && (
                            <div style={{ marginTop: 4 }}>
                                That is roughly {Math.round(winResult.window.days / 30)}x the 30-day
                                baseline and can run for hours on a large estate. It is safe to
                                leave the page — dispatched searches finish server-side — and safe
                                to re-run, since every chunk upserts by key.
                            </div>
                        )}
                        <div style={{ marginTop: 4 }}>
                            The two flat Environment Topology collections (inventory, IP enrichment)
                            always refresh over the last 30 days regardless of this setting: they
                            describe current state rather than history, and a longer window resolves
                            fewer partner IPs to SIDs, not more.
                        </div>
                    </WindowSummary>
                </div>
                <span />
                <span />
            </FieldRow>
            <FieldRow>
                <div>
                    <FieldLabel>Run the backfill</FieldLabel>
                    <FieldHint>
                        Required after first install. Fills the window selected above for every
                        rollup KV Store collection that powers the dashboards and the Environment
                        Topology view. Each rollup&apos;s backfill is split into its component
                        searches, then into monthly chunks, and
                        dispatched as top-level jobs (so they complete correctly even at high event
                        volumes — unlike running the bundled <code>*_backfill</code> saved searches
                        directly, which truncate at scale). Idempotent — safe to re-run;
                        already-complete rollups are skipped. Runs server-side; already-dispatched
                        searches keep running if you leave this page, and re-opening resumes any
                        remaining work. Each search is waited on for as long as Splunk reports
                        it running; one still running when you cancel is marked &ldquo;still
                        running on server&rdquo; — not failed.
                    </FieldHint>
                    {/* Build 325 (plan item E2) — the RFC re-key upgrade note. Phrased by
                      * FEATURE, not by version (session-017 sticky: no version numbers in
                      * user-visible strings). Two halves, both load-bearing: (1) plain
                      * Backfill after the upgrade would double-count RFC history
                      * (append=true writes the new per-app-server keys beside the old
                      * collided rows, and this button's completeness check skips the
                      * collection anyway); (2) Clear discards up to a year of graph
                      * history while the backfill restores ~30 days (session-091 sticky e)
                      * — long-established installs deserve the surgical alternative. */}
                    <FieldHint style={{ marginTop: 8 }}>
                        Upgrading note: if this install predates the per-app-server RFC
                        breakdown in the Environment Topology view, use the per-rollup
                        <strong> Clear</strong> and then <strong>Backfill</strong> on
                        &ldquo;Environment Topology (graph)&rdquo; once — the upgrade re-keys
                        that rollup&apos;s RFC rows per app server, so a Backfill without the
                        Clear would double-count RFC history (and the completeness check above
                        will otherwise skip it as already complete). The Clear also discards
                        topology graph history older than the 30-day backfill window; on
                        installs older than that, the release notes describe an RFC-only
                        migration that keeps the rest of the history.
                    </FieldHint>
                    {/* Session 134 (build 358) - two rollups now record corrected values
                      * for existing data, so an upgraded install needs one Clear +
                      * Backfill of each: Change & Configuration no longer stores an
                      * after-hours flag classified in the writer's time zone (it could
                      * store an hour twice); Linux no longer records word fragments as
                      * kernel event types. Session 138 (build 361) adds Beaconing
                      * detection, which this note had missed: build 356 moved its day
                      * key from the writer's midnight to UTC midnight, the same class of
                      * double count (the upgrade guide already named it). Phrased by
                      * feature, no versions (session-017 sticky). */}
                    <FieldHint style={{ marginTop: 8 }}>
                        Upgrading note: three rollups record corrected values and need one
                        <strong> Clear</strong> then <strong>Backfill</strong> after an upgrade
                        &mdash; &ldquo;Beaconing detection&rdquo; (it used to key each day on midnight
                        in the time zone of whichever search wrote it, so a day could be stored twice),
                        &ldquo;Change &amp; Configuration Activity&rdquo; (it used to store an
                        after-hours flag in the time zone of whichever search wrote the row, so an
                        hour could be counted twice) and &ldquo;Linux System &amp; Security&rdquo; (it
                        used to record fragments of ordinary words as kernel event types). All three
                        are rebuilt from the indexed events.
                    </FieldHint>
                    {/* Sessions 139-140 (builds 364-365) - real SAP LogServ records keep the JSON
                      * escapes of the source record and use formats the demo data never had: the
                      * Squid key=value (recommended) format, the HANA audit status of every action,
                      * upper-case password statements. Rows written before the upgrade keep the old
                      * values, some under the old key (none), so the proxy, HANA and cross-stack
                      * rollups need Clear + Backfill; five more only recount what they hold. Same
                      * wording as the upgrade guide. Phrased by feature, no versions (session-017
                      * sticky). */}
                    <FieldHint style={{ marginTop: 8 }}>
                        Upgrading note: real SAP LogServ proxy and HANA audit records are now parsed
                        as they arrive, so rows written before the upgrade hold the old values. Click
                        <strong> Clear</strong> then <strong>Backfill</strong> once on &ldquo;Proxy
                        Analytics&rdquo;, &ldquo;HANA Audit&rdquo; and &ldquo;Cross-Stack
                        Authentication&rdquo;; then <strong>Backfill</strong>, without Clear,
                        &ldquo;Network Perimeter&rdquo;, &ldquo;Environment Health&rdquo;, &ldquo;Beaconing
                        detection&rdquo; and the two &ldquo;Environment Topology&rdquo; rows, which
                        recount what they already hold.
                    </FieldHint>
                </div>
                <ButtonRow>
                    <Button
                        type="button"
                        $variant="primary"
                        onClick={() => startBackfill(
                            incompleteDefs.length ? incompleteDefs : ROLLUPS,
                        )}
                        disabled={anyOtherBusy || loading || !winOk}
                    >
                        {busy
                            ? 'Backfilling…'
                            : incompleteDefs.length
                            ? `Run backfill (${incompleteDefs.length} rollup${incompleteDefs.length === 1 ? '' : 's'})`
                            : 'Re-run backfill (all)'}
                    </Button>
                    {busy && (
                        <Button type="button" $variant="danger" onClick={handleCancel}>
                            Cancel
                        </Button>
                    )}
                </ButtonRow>
                <span />
            </FieldRow>

            {busy && (
                <FieldRow>
                    <div>
                        <FieldLabel>Progress</FieldLabel>
                        <FieldHint>{progress.current || 'Preparing…'}</FieldHint>
                        <ProgressOuter>
                            <ProgressInner $pct={pct} />
                        </ProgressOuter>
                    </div>
                    <FieldStatus $tone="good">
                        {progress.done} / {progress.total} searches ({pct}%)
                    </FieldStatus>
                    <span />
                </FieldRow>
            )}

            <SectionHeading>Rollups</SectionHeading>
            <TableHead>
                <span>Dashboard</span>
                <span>Schedule</span>
                <span>Aggregation</span>
                <span>History</span>
                <span style={{ textAlign: 'right' }}>Actions</span>
            </TableHead>
            {ROLLUPS_SORTED.map((def) => {
                const st = collStates[def.key];
                const a = aggStates[def.key];
                const outcome = runOutcome[def.key];
                /* The last run's outcome outlives the post-run refresh(), which
                 * rebuilds collStates from completeness alone. A row still
                 * backfilling shows its progress first. */
                const status: CollStatus | 'detached' =
                    st?.status === 'running' ? 'running' : outcome?.status ?? st?.status ?? 'unknown';
                const tone: 'good' | 'absent' | 'error' | 'warn' | 'running' =
                    status === 'complete' || status === 'done'
                        ? 'good'
                        : status === 'error'
                        ? 'error'
                        : status === 'truncated' || status === 'detached'
                        ? 'warn'
                        : status === 'running'
                        ? 'running'
                        : status === 'incomplete'
                        ? 'warn'
                        : 'absent';
                const historyText =
                    status === 'running'
                        ? `backfilling ${st?.armsDone ?? 0}/${st?.armsTotal ?? '?'}`
                        : status === 'done' && st?.oldestBucketMs === REMEASURING
                        ? 'refreshing…'
                        : status === 'done' || status === 'complete'
                        ? fmtAge(st?.oldestBucketMs ?? 0)
                        : status === 'error'
                        ? 'failed — re-run'
                        : status === 'truncated'
                        ? 'truncated — re-run'
                        : status === 'detached'
                        ? 'still running on server'
                        : status === 'incomplete'
                        ? fmtAge(st?.oldestBucketMs ?? 0)
                        : '—';
                const historyTitle = outcome && outcome.sids.length
                    ? `Still running on the server when this panel stopped waiting: ${outcome.sids.join(', ')}`
                    : undefined;
                const rowEnabled =
                    !!a && a.existCount === a.total && a.enabledCount === a.total && a.total > 0;
                const rowMixed = !!a && a.enabledCount > 0 && a.enabledCount < a.total;
                const rowToggleText = rowOp[def.key] === 'toggle'
                    ? '…'
                    : a?.existCount === 0
                    ? 'n/a'
                    : rowMixed
                    ? `mixed ${a?.enabledCount}/${a?.total}`
                    : rowEnabled
                    ? 'On'
                    : 'Off';
                const op = rowOp[def.key];
                return (
                    <TableRow key={def.key}>
                        <CellName>{def.label}</CellName>
                        <CellMono title={a?.next ? `next ${a.next}` : undefined}>
                            {a?.cron || '—'}
                        </CellMono>
                        <RowToggle title={def.aggregateSearches.join(', ')}>
                            <input
                                type="checkbox"
                                checked={rowEnabled}
                                ref={(el) => {
                                    if (el) el.indeterminate = rowMixed;
                                }}
                                onChange={() => handleToggleRow(def)}
                                disabled={anyOtherBusy || !!op || a?.existCount === 0}
                            />
                            {rowToggleText}
                        </RowToggle>
                        <HistoryVal $tone={tone} title={historyTitle}>{historyText}</HistoryVal>
                        <RowActions>
                            <SmallButton
                                type="button"
                                onClick={() => startBackfill([def])}
                                disabled={anyOtherBusy || !!op || loading || !winOk}
                            >
                                Backfill
                            </SmallButton>
                            <SmallButton
                                type="button"
                                $variant="danger"
                                onClick={() => handleClearRow(def)}
                                disabled={anyOtherBusy || !!op}
                            >
                                {op === 'clear' ? 'Clearing…' : 'Clear'}
                            </SmallButton>
                        </RowActions>
                    </TableRow>
                );
            })}

            <SectionHeading>Danger zone</SectionHeading>
            <FieldRow>
                <div>
                    <FieldLabel>Clear all rollups</FieldLabel>
                    <FieldHint>
                        Deletes every row from all {ALL_COLLECTIONS.length}{' '}
                        rollup KV Store collections at once. Use sparingly — the typical use is to
                        wipe a contaminated dataset before re-running the backfill against a
                        corrected schema. Every dashboard will be empty until the hourly aggregation
                        or a backfill repopulates.
                    </FieldHint>
                </div>
                <Button
                    type="button"
                    $variant="danger"
                    onClick={handleClearAll}
                    disabled={anyOtherBusy || loading}
                >
                    {clearingAll ? 'Clearing…' : 'Clear all data'}
                </Button>
                <span />
            </FieldRow>
        </>
    );
};

export default RollupBackfillPanel;
