import React, { useCallback, useEffect, useRef, useState } from 'react';
import styled from 'styled-components';
import { logservTheme } from '../styles/logservTheme';

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
const POLL_INTERVAL_MS = 2500;
/** Per-arm poll backstops so a reaped/stuck job can never wedge the pool. A
 *  30-day arm at extreme scale can run many minutes — the cap is generous but
 *  bounded so the button always re-enables. */
const MAX_POLLS = 2000; // ~83 min/arm ceiling
const MAX_NULL_STREAK = 24; // ~60s of consecutive poll failures → sid likely gone
/** A rollup is "complete" if its oldest bucket reaches back ~30 days. NOTE: this
 *  is an oldest-bucket heuristic — it proves history reaches back, not that every
 *  interior bucket is dense. A prior *truncated* union-backfill could leave the
 *  right oldest bucket with gaps and read as complete; "Re-run backfill (all)"
 *  recovers it (idempotent). A fresh install via this panel is always dense. */
const COMPLETE_SECONDS = 29 * 86400;
/** Uniform retention window across every rollup (set in the *_retention saved
 *  searches). Displayed read-only; change default/savedsearches.conf to alter. */
const RETENTION_DISPLAY = '365 days';

/** A logical rollup. One entry may span multiple KV collections / aggregate
 *  searches / backfill stanzas (the Environment Topology graph = 3 each, the
 *  beaconing-detection pair = 2 each); single-dashboard rollups are 1 each.
 *  Reconciled exhaustively against default/{savedsearches,collections}.conf in
 *  session 063 — every *_aggregate / *_backfill / logserv_*_rollup collection
 *  appears exactly once below. */
interface RollupDef {
    /** unique id used to key per-row state. */
    key: string;
    /** human label (the dashboard this rollup powers). */
    label: string;
    /** every KV collection this rollup writes (Clear fans out over all). */
    collections: string[];
    /** subset of `collections` whose oldest bucket gates completeness — excludes
     *  flat (non-time-bucketed) collections like the topology inventory. */
    completenessCollections: string[];
    /** the *_aggregate saved search(es) the master/row enable toggle acts on. */
    aggregateSearches: string[];
    /** the *_backfill saved search stanza name(s) — full name, fetched + split
     *  into top-level arms. */
    backfillStanzas: string[];
    /** the *_retention saved search(es) — informational. */
    retentionSearches: string[];
    /** the time-bucket field the completeness collections use. */
    bucketField: 'bucket_ts' | 'day_ts';
}

/** Build a standard single-collection rollup entry (1 collection / 1 of each
 *  search). `coll` defaults to `logserv_<key>_rollup` (the hana row overrides it
 *  because its collection is logserv_hana_category_rollup, key 'hana'). */
const single = (
    key: string,
    label: string,
    coll?: string,
    bucketField: 'bucket_ts' | 'day_ts' = 'bucket_ts',
): RollupDef => {
    const collection = coll ?? `logserv_${key}_rollup`;
    return {
        key,
        label,
        collections: [collection],
        completenessCollections: [collection],
        aggregateSearches: [`logserv_${key}_aggregate`],
        backfillStanzas: [`logserv_${key}_backfill`],
        retentionSearches: [`logserv_${key}_retention`],
        bucketField,
    };
};

const ROLLUPS: RollupDef[] = [
    single('wp_perf', 'Work Process Performance'),
    single('severity', 'Environment Health'),
    single('hana', 'HANA Audit', 'logserv_hana_category_rollup'),
    single('compliance', 'Change & Configuration Activity'),
    single('saprouter', 'SAP Router'),
    single('abapnet', 'ABAP Network & Security'),
    single('xstack_auth', 'Cross-Stack Authentication'),
    single('perimeter', 'Network Perimeter'),
    single('linux', 'Linux System & Security'),
    single('web_timing', 'Web & API Performance'),
    single('hana_trace', 'HANA Trace'),
    single('windows', 'Windows'),
    single('sapservices', 'SAP Services'),
    single('mc', 'Multi-Cloud Overview'),
    single('cloudconn', 'Cloud Connector'),
    single('proxy', 'Proxy Analytics'),
    single('dns', 'DNS Analytics'),
    single('pipeline', 'Data Pipeline Overview'),
    single('hostdetails', 'Host Details'),
    single('webdisp_slowtrace', 'Web Dispatcher Slowest Traces'),
    single('topology_detail', 'Environment Topology (detail tabs)'),
    single('stmap', 'Sourcetype Mapping (Host Details / Data Pipeline)'),
    single('hostrole', 'Host Role Activity (Host Details)'),
    // Beaconing detection — two day-bucketed rollups (the count rollup +
    // the build-237 per-(query,src) gap-stats detail rollup) folded into one row.
    {
        key: 'beaconing',
        label: 'Beaconing detection (Environment Health / DNS / Network Perimeter)',
        collections: ['logserv_beaconing_rollup', 'logserv_beaconing_detail_rollup'],
        completenessCollections: ['logserv_beaconing_rollup', 'logserv_beaconing_detail_rollup'],
        aggregateSearches: ['logserv_beaconing_aggregate', 'logserv_beaconing_detail_aggregate'],
        backfillStanzas: ['logserv_beaconing_backfill', 'logserv_beaconing_detail_backfill'],
        retentionSearches: ['logserv_beaconing_retention', 'logserv_beaconing_detail_retention'],
        bucketField: 'day_ts',
    },
    // Environment Topology graph — nodes/edges (bucketed) + inventory (flat).
    // Completeness checks the two bucketed collections; inventory is a current
    // snapshot (no time dimension) so it's backfilled + cleared but not
    // history-gated. Backfill now uses the per-arm top-level dispatch (was the
    // old Topology tab's truncation-prone single-union saved-search dispatch).
    {
        key: 'topology_graph',
        label: 'Environment Topology (graph)',
        collections: [
            'logserv_topology_nodes',
            'logserv_topology_edges',
            'logserv_topology_inventory',
        ],
        completenessCollections: ['logserv_topology_nodes', 'logserv_topology_edges'],
        aggregateSearches: [
            'logserv_topology_aggregate_nodes',
            'logserv_topology_aggregate_edges',
            'logserv_topology_aggregate_inventory',
        ],
        backfillStanzas: [
            'logserv_topology_backfill_nodes',
            'logserv_topology_backfill_edges',
            'logserv_topology_backfill_inventory',
        ],
        retentionSearches: ['logserv_topology_retention'],
        bucketField: 'bucket_ts',
    },
];

/** Flattened views of the static registry (concat — Array.flat/flatMap need an
 *  ES2019 lib; this tsconfig targets earlier). */
const ALL_AGG_SEARCHES: string[] = ([] as string[]).concat(
    ...ROLLUPS.map((d) => d.aggregateSearches),
);
const ALL_COLLECTIONS: string[] = ([] as string[]).concat(...ROLLUPS.map((d) => d.collections));
/** The per-rollup table is rendered alphabetically by dashboard label (ascending)
 *  so admins can scan it by name; the registry array stays in its logical
 *  definition order (which everything else iterates — order-independent). */
const ROLLUPS_SORTED: RollupDef[] = [...ROLLUPS].sort((a, b) => a.label.localeCompare(b.label));

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
const dispatchAdHoc = async (spl: string): Promise<string | null> => {
    const norm = /^\s*(search\b|\|)/i.test(spl) ? spl : `search ${spl}`;
    const params = new URLSearchParams();
    params.set('search', norm);
    params.set('earliest_time', BACKFILL_EARLIEST);
    params.set('latest_time', BACKFILL_LATEST);
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

interface JobState {
    isDone: boolean;
    failed: boolean;
    truncated: boolean;
    dispatchState: string;
}

const pollJobOnce = async (sid: string): Promise<JobState | null> => {
    try {
        const res = await fetch(`${NS_PREFIX}/search/jobs/${encodeURIComponent(sid)}?output_mode=json`, {
            credentials: 'same-origin',
            headers: getHeaders(),
        });
        if (!res.ok) return null;
        const json = await res.json();
        const c = json?.entry?.[0]?.content ?? {};
        const isDone = c.isDone === true || c.isDone === '1' || c.isDone === 1;
        const state = String(c.dispatchState ?? '');
        const messages: Array<{ type?: string; text?: string }> = Array.isArray(c.messages)
            ? c.messages
            : [];
        // top-level arms should never hit a wall-clock/output cap — flag if one does.
        const truncated = messages.some((m) =>
            /time limit|auto.?finaliz|maxout|truncat|results may be incomplete/i.test(
                String(m.text ?? ''),
            ),
        );
        return { isDone, failed: state === 'FAILED', truncated, dispatchState: state };
    } catch {
        return null;
    }
};

type ArmResult = 'done' | 'truncated' | 'failed' | 'cancelled';

/** Dispatch a single arm + poll to completion. Bounded (MAX_POLLS / null-streak)
 *  so a reaped or stuck job can never wedge the pool, and cancellable. */
const runArm = async (spl: string, shouldCancel: () => boolean): Promise<ArmResult> => {
    const sid = await dispatchAdHoc(spl);
    if (!sid) return 'failed';
    let nullStreak = 0;
    for (let polls = 0; polls < MAX_POLLS; polls += 1) {
        if (shouldCancel()) return 'cancelled';
        await new Promise((r) => window.setTimeout(r, POLL_INTERVAL_MS));
        if (shouldCancel()) return 'cancelled';
        const st = await pollJobOnce(sid);
        if (!st) {
            nullStreak += 1;
            if (nullStreak >= MAX_NULL_STREAK) return 'failed'; // sid gone / auth lapsed
            continue;
        }
        nullStreak = 0;
        if (st.failed) return 'failed';
        if (st.isDone) return st.truncated ? 'truncated' : 'done';
    }
    return 'failed'; // exceeded the poll ceiling
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
}
const buildWorkItems = async (defs: RollupDef[]): Promise<WorkItem[]> => {
    const items: WorkItem[] = [];
    for (const def of defs) {
        const spls = await Promise.all(def.backfillStanzas.map(fetchBackfillSpl));
        const armSpls: string[] = [];
        spls.forEach((spl) => {
            if (!spl) return;
            const { arms, tail } = parseUnion(spl);
            if (arms.length === 0) armSpls.push(spl);
            else arms.forEach((arm) => armSpls.push(`${arm} ${tail}`));
        });
        if (armSpls.length === 0) {
            // every stanza was unreadable → one failed sentinel item
            items.push({ key: def.key, label: def.label, spl: '', armIndex: 1, armCount: 1 });
        } else {
            armSpls.forEach((spl, i) => {
                items.push({
                    key: def.key,
                    label: def.label,
                    spl,
                    armIndex: i + 1,
                    armCount: armSpls.length,
                });
            });
        }
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
    font-size: ${logservTheme.fontSize.small};
    font-weight: ${logservTheme.fontWeight.semibold};
    &:first-child {
        margin-top: 0;
    }
`;
const FieldRow = styled.div`
    display: grid;
    grid-template-columns: 220px 1fr auto;
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
    font-size: ${logservTheme.fontSize.small};
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
    font-size: ${logservTheme.fontSize.small};
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
            ? '#ffffff'
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
    font-size: ${logservTheme.fontSize.small};
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
    font-size: ${logservTheme.fontSize.small};
    font-weight: ${logservTheme.fontWeight.semibold};
`;
const TableRow = styled.div`
    display: grid;
    grid-template-columns: ${ROW_COLS};
    gap: ${logservTheme.spacing.md};
    align-items: center;
    padding: 5px 0;
    border-bottom: 1px solid ${logservTheme.colors.panelBorderWeak};
    font-size: ${logservTheme.fontSize.small};
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

    const runBackfill = useCallback(
        async (defs: RollupDef[]) => {
            if (defs.length === 0) return;
            if (runningRef.current) return; // re-entrancy guard (busy is async)
            runningRef.current = true;
            cancelRef.current = false;
            setBusy(true);
            setOpError(null);
            setNotice(null);

            try {
                setCollStates((prev) => {
                    const next = { ...prev };
                    defs.forEach((d) => {
                        next[d.key] = seedColl(prev[d.key], 'running');
                    });
                    return next;
                });

                const items = await buildWorkItems(defs);
                const failedKeys = items.filter((it) => !it.spl);
                const runnable = items.filter((it) => it.spl);
                const totals: Record<string, number> = {};
                runnable.forEach((it) => {
                    totals[it.key] = (totals[it.key] ?? 0) + 1;
                });
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
                }

                let idx = 0; // claim-an-index: no `await` between read+increment → atomic
                let failCount = 0;
                let truncCount = 0;
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
                                current: `${it.label} (arm ${it.armIndex}/${it.armCount})`,
                            }));
                        }
                        const result = await runArm(it.spl, () => cancelRef.current);
                        if (result === 'cancelled') return;
                        if (result === 'failed') failCount += 1;
                        else if (result === 'truncated') truncCount += 1;
                        if (!mountedRef.current) return;
                        setProgress((p) => ({ ...p, done: p.done + 1 }));
                        setCollStates((prev) => {
                            const cur = prev[it.key];
                            if (!cur) return prev;
                            const armsDone = cur.armsDone + 1;
                            const complete = armsDone >= cur.armsTotal;
                            const status: CollStatus =
                                cur.status === 'error' || result === 'failed'
                                    ? 'error'
                                    : cur.status === 'truncated' || result === 'truncated'
                                    ? 'truncated'
                                    : complete
                                    ? 'done'
                                    : 'running';
                            return { ...prev, [it.key]: { ...cur, armsDone, status } };
                        });
                    }
                };
                await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

                if (!mountedRef.current) return;
                const cancelled = cancelRef.current;
                if (cancelled) {
                    setNotice('Backfill cancelled. Already-dispatched searches finish server-side; re-run to complete the rest (idempotent).');
                    window.setTimeout(() => mountedRef.current && setNotice(null), 10000);
                } else if (failedKeys.length || failCount || truncCount) {
                    setOpError(
                        'Backfill finished with issues — re-run to retry (idempotent). Affected rollups are marked in the table.',
                    );
                } else {
                    setNotice('Backfill complete. All targeted rollups now hold 30 days of history.');
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
                    <FieldLabel>One-time 30-day backfill</FieldLabel>
                    <FieldHint>
                        Required after first install. Fills the last 30 days of every rollup KV
                        Store collection that powers the dashboards and the Environment Topology
                        view. Each rollup&apos;s backfill is split into its component searches and
                        dispatched as top-level jobs (so they complete correctly even at high event
                        volumes — unlike running the bundled <code>*_backfill</code> saved searches
                        directly, which truncate at scale). Idempotent — safe to re-run;
                        already-complete rollups are skipped. Runs server-side; already-dispatched
                        searches keep running if you leave this page, and re-opening resumes any
                        remaining work.
                    </FieldHint>
                </div>
                <ButtonRow>
                    <Button
                        type="button"
                        $variant="primary"
                        onClick={() => runBackfill(incompleteDefs.length ? incompleteDefs : ROLLUPS)}
                        disabled={anyOtherBusy || loading}
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
                const status = st?.status ?? 'unknown';
                const tone: 'good' | 'absent' | 'error' | 'warn' | 'running' =
                    status === 'complete' || status === 'done'
                        ? 'good'
                        : status === 'error'
                        ? 'error'
                        : status === 'truncated'
                        ? 'warn'
                        : status === 'running'
                        ? 'running'
                        : status === 'incomplete'
                        ? 'warn'
                        : 'absent';
                const historyText =
                    status === 'running'
                        ? `backfilling ${st?.armsDone ?? 0}/${st?.armsTotal ?? '?'}`
                        : status === 'done' || status === 'complete'
                        ? fmtAge(st?.oldestBucketMs ?? 0)
                        : status === 'error'
                        ? 'failed — re-run'
                        : status === 'truncated'
                        ? 'truncated — re-run'
                        : status === 'incomplete'
                        ? fmtAge(st?.oldestBucketMs ?? 0)
                        : '—';
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
                        <HistoryVal $tone={tone}>{historyText}</HistoryVal>
                        <RowActions>
                            <SmallButton
                                type="button"
                                onClick={() => runBackfill([def])}
                                disabled={anyOtherBusy || !!op || loading}
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
