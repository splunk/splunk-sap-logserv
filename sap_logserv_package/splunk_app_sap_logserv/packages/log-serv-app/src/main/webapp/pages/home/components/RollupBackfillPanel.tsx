import React, { useCallback, useEffect, useRef, useState } from 'react';
import styled from 'styled-components';
import { logservTheme } from '../styles/logservTheme';

/**
 * Dashboard Rollup Backfill — admin control to populate the last 30 days of the
 * time-bucketed KV Store rollups that power the dashboard suite (the 15
 * logserv_*_rollup collections). Required once after first install (and after a
 * rollup-schema change), because the hourly aggregation only fills the leading
 * edge — without a backfill the dashboards show only the last hour or two.
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
 * Session 056 / build 230.
 */

const APP = 'splunk_app_sap_logserv';
/* Splunk Web's REST proxy requires the `/en-US/splunkd/__raw/` prefix — direct
 * `/servicesNS/...` URLs hit Splunk Web's rewriter and 404. Same convention as
 * TopologySettingsPanel.tsx + topology/persistence.ts. */
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

interface RollupDef {
    /** saved-search stanza short-name: [logserv_<name>_backfill] */
    name: string;
    /** KV Store collection written by the backfill (name != collection for hana) */
    collection: string;
    /** time-bucket field used by the collection (beaconing uses day_ts) */
    bucketField: 'bucket_ts' | 'day_ts';
    /** human label (the dashboard this rollup powers) */
    label: string;
}

const ROLLUPS: RollupDef[] = [
    { name: 'wp_perf', collection: 'logserv_wp_perf_rollup', bucketField: 'bucket_ts', label: 'Work Process Performance' },
    { name: 'severity', collection: 'logserv_severity_rollup', bucketField: 'bucket_ts', label: 'Environment Health' },
    { name: 'hana', collection: 'logserv_hana_category_rollup', bucketField: 'bucket_ts', label: 'HANA Audit' },
    { name: 'compliance', collection: 'logserv_compliance_rollup', bucketField: 'bucket_ts', label: 'Change & Configuration Activity' },
    { name: 'saprouter', collection: 'logserv_saprouter_rollup', bucketField: 'bucket_ts', label: 'SAP Router' },
    { name: 'abapnet', collection: 'logserv_abapnet_rollup', bucketField: 'bucket_ts', label: 'ABAP Network & Security' },
    { name: 'xstack_auth', collection: 'logserv_xstack_auth_rollup', bucketField: 'bucket_ts', label: 'Cross-Stack Authentication' },
    { name: 'perimeter', collection: 'logserv_perimeter_rollup', bucketField: 'bucket_ts', label: 'Network Perimeter' },
    { name: 'linux', collection: 'logserv_linux_rollup', bucketField: 'bucket_ts', label: 'Linux System & Security' },
    { name: 'web_timing', collection: 'logserv_web_timing_rollup', bucketField: 'bucket_ts', label: 'Web & API Performance' },
    { name: 'hana_trace', collection: 'logserv_hana_trace_rollup', bucketField: 'bucket_ts', label: 'HANA Trace' },
    { name: 'windows', collection: 'logserv_windows_rollup', bucketField: 'bucket_ts', label: 'Windows' },
    { name: 'sapservices', collection: 'logserv_sapservices_rollup', bucketField: 'bucket_ts', label: 'SAP Services' },
    { name: 'mc', collection: 'logserv_mc_rollup', bucketField: 'bucket_ts', label: 'Multi-Cloud Overview' },
    { name: 'beaconing', collection: 'logserv_beaconing_rollup', bucketField: 'day_ts', label: 'Beaconing (Environment Health / DNS)' },
    { name: 'cloudconn', collection: 'logserv_cloudconn_rollup', bucketField: 'bucket_ts', label: 'Cloud Connector' },
    { name: 'proxy', collection: 'logserv_proxy_rollup', bucketField: 'bucket_ts', label: 'Proxy Analytics' },
    { name: 'dns', collection: 'logserv_dns_rollup', bucketField: 'bucket_ts', label: 'DNS Analytics' },
    { name: 'pipeline', collection: 'logserv_pipeline_rollup', bucketField: 'bucket_ts', label: 'Data Pipeline Overview' },
    { name: 'hostdetails', collection: 'logserv_hostdetails_rollup', bucketField: 'bucket_ts', label: 'Host Details' },
    { name: 'webdisp_slowtrace', collection: 'logserv_webdisp_slowtrace_rollup', bucketField: 'bucket_ts', label: 'Web Dispatcher Slowest Traces' },
    { name: 'topology_detail', collection: 'logserv_topology_detail_rollup', bucketField: 'bucket_ts', label: 'Environment Topology (detail tabs)' },
];

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
 *  the job returns empty/errors (session-048 sticky #4). The 13 union arms already
 *  start with `search \`macro\``; the 2 single-pipeline backfills (hana_trace,
 *  beaconing) start with the bare macro, so we normalize a leading `search` here. */
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
        // Widened beyond the subsearch "time limit" text to catch top-level cap
        // families (maxout / result truncation / generic auto-finalize).
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
 *  collection; m = oldest bucket epoch (0 if empty). */
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
            // a quote closes/opens a string only if preceded by an EVEN number of
            // backslashes (odd = the quote itself is escaped: \")
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
 *  for single-pipeline backfills) for the given collections. */
interface WorkItem {
    name: string;
    label: string;
    spl: string;
    armIndex: number;
    armCount: number;
}
const buildWorkItems = async (defs: RollupDef[]): Promise<WorkItem[]> => {
    const items: WorkItem[] = [];
    for (const def of defs) {
        const spl = await fetchBackfillSpl(`logserv_${def.name}_backfill`);
        if (!spl) {
            items.push({ name: def.name, label: def.label, spl: '', armIndex: 1, armCount: 1 });
            continue;
        }
        const { arms, tail } = parseUnion(spl);
        if (arms.length === 0) {
            // single-pipeline backfill (hana_trace, beaconing) → whole SPL is one
            // top-level search (dispatchAdHoc prepends the leading `search`)
            items.push({ name: def.name, label: def.label, spl, armIndex: 1, armCount: 1 });
        } else {
            arms.forEach((arm, i) => {
                items.push({
                    name: def.name,
                    label: def.label,
                    spl: `${arm} ${tail}`,
                    armIndex: i + 1,
                    armCount: arms.length,
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
const ButtonRow = styled.div`
    display: flex;
    gap: ${logservTheme.spacing.sm};
    align-items: center;
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
const StatusList = styled.div`
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 2px ${logservTheme.spacing.md};
    margin-top: ${logservTheme.spacing.sm};
    font-size: ${logservTheme.fontSize.small};
`;
const StatusName = styled.span`
    color: ${logservTheme.colors.textDefault};
`;
const StatusVal = styled.span<{ $tone: 'good' | 'absent' | 'error' | 'warn' | 'running' }>`
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
    text-align: right;
    font-variant-numeric: tabular-nums;
`;

type CollStatus = 'complete' | 'incomplete' | 'running' | 'done' | 'error' | 'truncated' | 'unknown';
interface CollState {
    status: CollStatus;
    oldestBucketMs: number; // 0 if empty
    armsDone: number;
    armsTotal: number;
}
const seedState = (prev: CollState | undefined, status: CollStatus): CollState => ({
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

// ─── panel ────────────────────────────────────────────────────────────────────
const RollupBackfillPanel: React.FC = () => {
    const [loading, setLoading] = useState<boolean>(true);
    const [collStates, setCollStates] = useState<Record<string, CollState>>({});
    const [busy, setBusy] = useState<boolean>(false);
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

    /** Detect per-collection completeness (oldest bucket reaches ~30 days back). */
    const refresh = useCallback(async () => {
        setLoading(true);
        const nowSec = Date.now() / 1000;
        const states: Record<string, CollState> = {};
        await Promise.all(
            ROLLUPS.map(async (def) => {
                const r = await fetchOldestBucket(def.collection, def.bucketField);
                if (r === null) {
                    states[def.name] = { status: 'unknown', oldestBucketMs: 0, armsDone: 0, armsTotal: 0 };
                    return;
                }
                const complete = r.n > 0 && r.m > 0 && r.m <= nowSec - COMPLETE_SECONDS;
                states[def.name] = {
                    status: complete ? 'complete' : 'incomplete',
                    oldestBucketMs: r.m ? r.m * 1000 : 0,
                    armsDone: 0,
                    armsTotal: 0,
                };
            }),
        );
        if (!mountedRef.current) return;
        setCollStates(states);
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

    const incompleteDefs = ROLLUPS.filter((d) => collStates[d.name]?.status !== 'complete');
    const allComplete = !loading && ROLLUPS.every((d) => collStates[d.name]?.status === 'complete');

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
                // mark targeted collections running
                setCollStates((prev) => {
                    const next = { ...prev };
                    defs.forEach((d) => {
                        next[d.name] = seedState(prev[d.name], 'running');
                    });
                    return next;
                });

                // build the flat work list (fetch each backfill SPL, split into arms)
                const items = await buildWorkItems(defs);
                const failedDefs = items.filter((it) => !it.spl);
                const runnable = items.filter((it) => it.spl);
                const totals: Record<string, number> = {};
                runnable.forEach((it) => {
                    totals[it.name] = (totals[it.name] ?? 0) + 1;
                });
                if (mountedRef.current) {
                    setCollStates((prev) => {
                        const next = { ...prev };
                        Object.entries(totals).forEach(([name, t]) => {
                            if (next[name]) next[name] = { ...next[name], armsTotal: t };
                        });
                        // collections whose backfill SPL was unreadable → error
                        failedDefs.forEach((it) => {
                            next[it.name] = { ...seedState(next[it.name], 'error') };
                        });
                        return next;
                    });
                    setProgress({ done: 0, total: runnable.length, current: '' });
                }

                // limited-concurrency pool over the work items. failCount/truncCount
                // are plain locals incremented after each arm's await — safe because
                // JS is single-threaded and they're only read after Promise.all.
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
                            const cur = prev[it.name];
                            if (!cur) return prev;
                            const armsDone = cur.armsDone + 1;
                            const complete = armsDone >= cur.armsTotal;
                            // sticky per-collection failure: a prior failed/truncated
                            // arm keeps the collection in that state.
                            const status: CollStatus =
                                cur.status === 'error' || result === 'failed'
                                    ? 'error'
                                    : cur.status === 'truncated' || result === 'truncated'
                                    ? 'truncated'
                                    : complete
                                    ? 'done'
                                    : 'running';
                            return { ...prev, [it.name]: { ...cur, armsDone, status } };
                        });
                    }
                };
                await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

                if (!mountedRef.current) return;
                const cancelled = cancelRef.current;
                if (cancelled) {
                    setNotice('Backfill cancelled. Already-dispatched searches finish server-side; re-run to complete the rest (idempotent).');
                    window.setTimeout(() => mountedRef.current && setNotice(null), 10000);
                } else if (failedDefs.length || failCount || truncCount) {
                    setOpError(
                        `Backfill finished with issues — re-run to retry (idempotent). Affected rollups are marked below.`,
                    );
                } else {
                    setNotice('Backfill complete. All targeted rollups now hold 30 days of history.');
                    window.setTimeout(() => mountedRef.current && setNotice(null), 10000);
                }
            } finally {
                runningRef.current = false;
                if (mountedRef.current) setBusy(false);
                // re-detect completeness from the freshly-written rollups
                if (mountedRef.current) await refresh();
            }
        },
        [refresh],
    );

    const handleCancel = useCallback(() => {
        cancelRef.current = true;
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

            <SectionHeading>Backfill</SectionHeading>
            <FieldRow>
                <div>
                    <FieldLabel>One-time 30-day backfill</FieldLabel>
                    <FieldHint>
                        Required after first install. Fills the last 30 days of every rollup KV
                        Store collection that powers the dashboards. Each rollup&apos;s backfill is
                        split into its component searches and dispatched as top-level jobs (so they
                        complete correctly even at high event volumes — unlike running the
                        bundled <code>*_backfill</code> saved searches directly, which truncate at
                        scale). Idempotent — safe to re-run; already-complete rollups are skipped.
                        Runs server-side; already-dispatched searches keep running if you leave this
                        page, and re-opening resumes any remaining work.
                    </FieldHint>
                </div>
                <ButtonRow>
                    <Button
                        type="button"
                        $variant="primary"
                        onClick={() => runBackfill(incompleteDefs.length ? incompleteDefs : ROLLUPS)}
                        disabled={busy || loading}
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

            <SectionHeading>Rollup status</SectionHeading>
            <FieldRow>
                <div>
                    <FieldLabel>Per-dashboard history</FieldLabel>
                    <FieldHint>
                        Oldest bucket present in each rollup collection. ~30 days = complete. Updated
                        on page open and after a backfill.
                    </FieldHint>
                </div>
                <StatusList>
                    {ROLLUPS.map((def) => {
                        const st = collStates[def.name];
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
                        const text =
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
                        return (
                            <React.Fragment key={def.name}>
                                <StatusName>{def.label}</StatusName>
                                <StatusVal $tone={tone}>{text}</StatusVal>
                            </React.Fragment>
                        );
                    })}
                </StatusList>
                <span />
            </FieldRow>
        </>
    );
};

export default RollupBackfillPanel;
