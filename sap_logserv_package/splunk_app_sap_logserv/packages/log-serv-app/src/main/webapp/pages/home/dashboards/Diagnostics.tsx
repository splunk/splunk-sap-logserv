/**
 * Diagnostics — the LogServ Data Doctor's environment page (`#/diagnostics`,
 * build 311 / session 096, design §13 + the §13.8a review corrections).
 *
 * Live environment health for the whole data pipeline — index, sourcetypes,
 * every rollup collection, platform facts — plus the saved Data Doctor
 * reports. NOT admin-gated: every check on this page is non-admin-readable,
 * and the page carries NO destructive controls (every logserv_* collection is
 * world-writable, so a Clear button here would actually succeed — destructive
 * controls stay in the admin-gated Settings page; here admin actions render
 * as text).
 *
 * Data layer = gatherEnvironmentEvidence (build 310), run through the
 * beginDiagnosis singleton (one diagnosis app-wide) on mount, on every
 * TimeRange picker change, and on the nav-bar global Refresh. The
 * RefreshIntervalPicker is suppressed (noRefreshPicker): nothing on this page
 * consumes its nonce, and a page dispatching ~40 probes must not be re-armed
 * every 30 seconds.
 *
 * RUN-IDENTITY GUARD (§13.8a correction 1): a superseded/cancelled gather
 * RESOLVES (skipped probes, not-checked rows) rather than rejecting, so every
 * completion path checks the run sequence AND runner.isCancelled() before any
 * setState. Evidence is stored WITH the window it was gathered under
 * (correction 2) — the visible "as of" line and the Download report's window
 * label come from that tuple, never from the live picker.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import styled from 'styled-components';
import { username as splunkUsername } from '@splunk/splunk-utils/config';
import DashboardLayout from '../components/DashboardLayout';
import FramedPanel from '../components/FramedPanel';
import StatusTag, { Sentiment } from '../components/StatusTag';
import Spinner from '../components/Spinner';
import { logservTheme } from '../styles/logservTheme';
import { useTimeRange } from '../state/TimeRangeProvider';
import { useGlobalRefresh } from '../state/GlobalRefreshProvider';
import { beginDiagnosis, endDiagnosis, ProbeRunner } from '../utils/diagProbe';
import {
    gatherEnvironmentEvidence,
    EnvironmentEvidence,
    classifyRollupHistory,
    combineRollupHistory,
    RollupHistoryStatus,
    COMPANION_APPS,
} from '../utils/diagEnvironment';
import { ROLLUPS } from '../routes/rollupRegistry';
import {
    buildEnvironmentReportModel,
    ReportMeta,
    cannotCheckLines,
} from '../utils/diagReport';
import {
    IngestFacts,
    scrubPaste,
    parseIngestPaste,
    writeIngestFacts,
    ingestFactsSummary,
    provenanceLine,
    factsAreStale,
} from '../utils/diagIngestFacts';
import { copyText } from '../utils/clipboard';
import { downloadReport, renderReportPdf } from '../utils/diagReportPdf';
import { triggerDownload } from '../utils/download';
import {
    listReports,
    fetchReportModel,
    DiagReportListRow,
    RETENTION_MAX_ROWS,
} from '../utils/diagPersistence';
import { ProbeNote } from '../utils/diagEvidence';
import { APP_VERSION, APP_BUILD, APP_BUILD_DATE, TEMPLATES_ONLY } from '../buildFlags';

// ---------------------------------------------------------------------------
// Styled
// ---------------------------------------------------------------------------

const Stack = styled.div`
    display: flex;
    flex-direction: column;
    gap: ${logservTheme.spacing.lg};
`;

const StatusRow = styled.div`
    display: flex;
    align-items: center;
    gap: ${logservTheme.spacing.md};
    min-height: 30px;
    color: ${logservTheme.colors.textDefault};
`;

/* §15.2 — the printed ask (grounding §1.10; endpoint name corrected from the
 * original design). The generic <deployment-server> form is what customer
 * docs show; a single-instance install substitutes this host. The HF REST
 * endpoint is deliberately NOT offered (it returns shipped defaults — the
 * §15.8a-12 trap), the generated file is. */
const REST_COMMAND =
    'curl -k -u <splunk-admin> "https://<deployment-server>:8089/servicesNS/nobody/' +
    'splunk_ta_sap_logserv/splunk_ta_sap_logserv_settings/filter_settings?output_mode=json"';
const HF_COMMAND = 'sudo cat /opt/splunk/etc/apps/splunk_ta_sap_logserv/local/transforms.conf';

const Btn = styled.button`
    background: transparent;
    border: 1px solid ${logservTheme.colors.panelBorderWeak};
    border-radius: ${logservTheme.radius.small};
    color: ${logservTheme.colors.textDefault};
    padding: 6px 12px;
    cursor: pointer;
    font-size: ${logservTheme.fontSize.body};
    white-space: nowrap;
    &:hover:not(:disabled) {
        border-color: ${logservTheme.colors.cyanAccent};
        color: ${logservTheme.colors.textActive};
    }
    &:disabled {
        opacity: 0.5;
        cursor: default;
    }
`;

const Muted = styled.span`
    color: ${logservTheme.colors.textMuted};
    font-size: ${logservTheme.fontSize.small};
`;

/* §15.2 — the operator paste box. Mono visual family (the drawer's Mono
 * precedent); vertical resize only so the page column never scrolls
 * horizontally. */
const PasteBox = styled.textarea`
    width: 100%;
    min-height: 120px;
    resize: vertical;
    box-sizing: border-box;
    background: ${logservTheme.colors.tableHeaderBackground};
    border: 1px solid ${logservTheme.colors.panelBorderWeak};
    border-radius: ${logservTheme.radius.small};
    color: ${logservTheme.colors.textDefault};
    font-family: ${logservTheme.font.mono};
    font-size: ${logservTheme.fontSize.small};
    padding: ${logservTheme.spacing.sm};
    &:focus {
        outline: none;
        border-color: ${logservTheme.colors.cyanAccent};
    }
`;

const CmdRow = styled.div`
    display: flex;
    align-items: flex-start;
    gap: ${logservTheme.spacing.sm};
    margin: 0 0 ${logservTheme.spacing.sm};
`;

const CmdText = styled.code`
    flex: 1;
    display: block;
    background: ${logservTheme.colors.tableHeaderBackground};
    border: 1px solid ${logservTheme.colors.panelBorderWeak};
    border-radius: ${logservTheme.radius.small};
    color: ${logservTheme.colors.textDefault};
    font-family: ${logservTheme.font.mono};
    font-size: ${logservTheme.fontSize.small};
    padding: ${logservTheme.spacing.sm};
    overflow-x: auto;
    white-space: pre;
`;

const Notice = styled.div<{ $tone: 'warn' | 'good' | 'neutral' }>`
    padding: ${logservTheme.spacing.sm} ${logservTheme.spacing.md};
    border-radius: ${logservTheme.radius.small};
    border: 1px solid
        ${(p) =>
            p.$tone === 'warn'
                ? logservTheme.colors.orange
                : p.$tone === 'good'
                  ? logservTheme.colors.green
                  : logservTheme.colors.panelBorderWeak};
    background: ${(p) =>
        p.$tone === 'warn'
            ? logservTheme.colors.warningTint
            : p.$tone === 'good'
              ? logservTheme.colors.positiveTint
              : logservTheme.colors.tableHeaderBackground};
    color: ${logservTheme.colors.textDefault};
    line-height: 1.45;
`;

const KvGrid = styled.div`
    display: grid;
    grid-template-columns: 220px 1fr;
    gap: 6px ${logservTheme.spacing.lg};
    line-height: 1.45;
`;

const KvLabel = styled.span`
    color: ${logservTheme.colors.textMuted};
`;

const KvValue = styled.span`
    color: ${logservTheme.colors.textDefault};
    word-break: break-word;
`;

const Table = styled.table`
    width: 100%;
    border-collapse: collapse;
    font-size: ${logservTheme.fontSize.body};
    th {
        text-align: left;
        padding: 6px 10px;
        background: ${logservTheme.colors.tableHeaderBackground};
        color: ${logservTheme.colors.textMuted};
        font-size: ${logservTheme.fontSize.small};
        font-weight: ${logservTheme.fontWeight.semibold};
        white-space: nowrap;
    }
    td {
        padding: 6px 10px;
        border-bottom: 1px solid ${logservTheme.colors.panelBorderWeak};
        color: ${logservTheme.colors.textDefault};
        vertical-align: top;
    }
`;

/* The drawer's "What was checked" ledger idiom (Row + glyph map) — replicated
 * here because those styled components are module-private to the drawer. */
const LedgerRow = styled.div`
    display: grid;
    grid-template-columns: 18px 1fr auto;
    gap: ${logservTheme.spacing.sm};
    padding: 6px 0;
    border-bottom: 1px solid ${logservTheme.colors.panelBorderWeak};
    line-height: 1.4;
`;

const STATUS_GLYPH: Record<ProbeNote['status'], string> = {
    ok: '✓',
    error: '!',
    skipped: '–',
    superseded: '–',
};

const RowError = styled.div`
    color: ${logservTheme.colors.red};
    font-size: ${logservTheme.fontSize.small};
    margin-top: 2px;
`;

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

const fmtEpochUtc = (n: number | null): string => {
    if (n === null || !Number.isFinite(n) || n <= 0) return '—';
    const d = new Date(n * 1000);
    const p = (x: number): string => (x < 10 ? `0${x}` : String(x));
    return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(
        d.getUTCHours(),
    )}:${p(d.getUTCMinutes())} UTC`;
};

const FRESHNESS_LABEL: Record<string, string> = {
    ok: 'OK',
    stale: 'STALE',
    empty: 'NEVER BUILT',
    'not-checked': 'NOT CHECKED',
};

const FRESHNESS_SENTIMENT: Record<string, Sentiment> = {
    ok: 'positive',
    stale: 'warning',
    empty: 'negative',
    'not-checked': 'dormant',
};

const HISTORY_LABEL: Record<RollupHistoryStatus, string> = {
    complete: 'COMPLETE',
    incomplete: 'INCOMPLETE',
    empty: 'NEVER BUILT',
    unknown: 'NOT CHECKED',
};

const HISTORY_SENTIMENT: Record<RollupHistoryStatus, Sentiment> = {
    complete: 'positive',
    incomplete: 'warning',
    empty: 'negative',
    unknown: 'dormant',
};

// ---------------------------------------------------------------------------

/** Evidence bound to the window it was gathered under (§13.8a correction 2). */
interface GatheredEnv {
    env: EnvironmentEvidence;
    earliest: string;
    latest: string;
    gatheredAtMs: number;
    /** True when the user pressed Cancel mid-run (partial, kept + labeled). */
    partial: boolean;
}

const Diagnostics: React.FC = () => {
    const { timeRange } = useTimeRange();
    const { globalRefreshNonce } = useGlobalRefresh();

    const [running, setRunning] = useState(true);
    const [progress, setProgress] = useState('Starting checks…');
    const [gathered, setGathered] = useState<GatheredEnv | null>(null);
    const [superseded, setSuperseded] = useState(false);
    const [fatal, setFatal] = useState<string | null>(null);
    const [rerunNonce, setRerunNonce] = useState(0);
    const [pdfBusy, setPdfBusy] = useState(false);

    const [reports, setReports] = useState<DiagReportListRow[] | null>(null);
    const [reportsUnavailable, setReportsUnavailable] = useState(false);
    const [rowBusy, setRowBusy] = useState<string | null>(null);
    const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
    // §15.2 — the operator-supply paste flow. The DISPLAY of supplied facts
    // reads gathered.env.ingestFacts ONLY (the single frozen source,
    // §15.8a-27); a successful Save re-runs the checks so the display, the
    // boundary line and any report all move together.
    const [paste, setPaste] = useState('');
    const [saveBusy, setSaveBusy] = useState(false);
    const [saveMsg, setSaveMsg] = useState<{ tone: 'good' | 'warn'; text: string } | null>(null);

    const mountedRef = useRef(true);
    const runSeqRef = useRef(0);
    const cancelRequestedRef = useRef(false);
    const runnerRef = useRef<ProbeRunner | null>(null);

    useEffect(
        () => () => {
            mountedRef.current = false;
        },
        [],
    );

    // ---- the gather run -----------------------------------------------------
    useEffect(() => {
        runSeqRef.current += 1;
        const seq = runSeqRef.current;
        cancelRequestedRef.current = false;
        setFatal(null);
        setSuperseded(false);
        setRunning(true);
        setProgress('Starting checks…');
        const runner = beginDiagnosis({ budgetMs: 120_000, concurrency: 2 });
        runnerRef.current = runner;
        // Capture the window from THIS run's closure — the label the evidence
        // renders and reports under must be the one it was measured for.
        const earliest = timeRange.earliest;
        const latest = timeRange.latest;
        void gatherEnvironmentEvidence(runner, earliest, latest, (label) => {
            // A superseded run's rollup loop keeps ticking after cancellation —
            // never let it churn the NEW run's progress label.
            if (mountedRef.current && runSeqRef.current === seq && !runner.isCancelled()) {
                setProgress(label);
            }
        })
            .then((env) => {
                if (!mountedRef.current || runSeqRef.current !== seq) return;
                // Read the cancellation state BEFORE releasing the singleton:
                // endDiagnosis() cancels the runner as part of the release, so
                // reading isCancelled() afterwards is unconditionally true and
                // every completed run would be misclassified as an outside
                // supersede — the page could never render evidence (the
                // session-097 rendered-UI G1/G2 failure, fixed in build 312).
                const wasCancelled = runner.isCancelled();
                endDiagnosis(runner);
                setRunning(false);
                if (wasCancelled) {
                    if (cancelRequestedRef.current) {
                        // User pressed Cancel: keep the partial, say so.
                        setGathered({
                            env,
                            earliest,
                            latest,
                            gatheredAtMs: Date.now(),
                            partial: true,
                        });
                    } else {
                        // Superseded from outside (a drawer diagnosis or the
                        // Actions menu): DISCARD the junk partial and keep the
                        // last completed evidence, labeled with ITS window.
                        setSuperseded(true);
                    }
                    return;
                }
                setGathered({ env, earliest, latest, gatheredAtMs: Date.now(), partial: false });
            })
            .catch((e: unknown) => {
                if (!mountedRef.current || runSeqRef.current !== seq) return;
                endDiagnosis(runner);
                setRunning(false);
                // Keep last-good evidence (still labeled with its own window).
                setFatal(e instanceof Error ? e.message : String(e));
            });
        return () => {
            endDiagnosis(runner);
        };
    }, [timeRange.earliest, timeRange.latest, rerunNonce, globalRefreshNonce]);

    const handleCancel = useCallback((): void => {
        cancelRequestedRef.current = true;
        if (runnerRef.current) endDiagnosis(runnerRef.current);
    }, []);

    const handleRerun = useCallback((): void => {
        setRerunNonce((n) => n + 1);
    }, []);

    // ---- saved reports ------------------------------------------------------
    const refreshReports = useCallback(async (): Promise<void> => {
        const rows = await listReports(50);
        if (!mountedRef.current) return;
        if (rows === null) {
            setReportsUnavailable(true);
            setReports([]);
        } else {
            setReportsUnavailable(false);
            setReports(rows);
        }
    }, []);

    useEffect(() => {
        void refreshReports();
    }, [refreshReports]);

    /** §15.2 — scrub -> parse -> store -> re-run. Save is disabled while the
     *  checks run (§15.8a-27), needs no runner discipline (no probes), and
     *  guards every post-await setState with mountedRef. */
    const handleSaveFacts = useCallback(async (): Promise<void> => {
        if (saveBusy || running) return;
        const raw = paste;
        if (!raw.trim()) return;
        setSaveBusy(true);
        setSaveMsg(null);
        try {
            const nowSec = Math.floor(Date.now() / 1000);
            const scrubbed = scrubPaste(raw);
            const parsed = parseIngestPaste(scrubbed, nowSec);
            const facts: IngestFacts = {
                ...parsed,
                suppliedAt: nowSec,
                suppliedBy: splunkUsername || '',
                scrubbedRaw: scrubbed,
            };
            const res = await writeIngestFacts(facts, APP_BUILD);
            if (!mountedRef.current) return;
            if (res.ok) {
                setSaveMsg({
                    tone: 'good',
                    text:
                        `Saved (${parsed.parseStatus}, ${parsed.inputShape})` +
                        (parsed.parseNote ? ` — ${parsed.parseNote}` : '') +
                        ' Re-running the checks with the supplied configuration…',
                });
                setPaste('');
                setRerunNonce((n) => n + 1);
            } else {
                setSaveMsg({ tone: 'warn', text: `Save failed: ${res.reason}` });
            }
        } catch (e) {
            if (mountedRef.current) {
                setSaveMsg({
                    tone: 'warn',
                    text: `Save failed: ${e instanceof Error ? e.message : String(e)}`,
                });
            }
        } finally {
            if (mountedRef.current) setSaveBusy(false);
        }
    }, [saveBusy, running, paste]);

    const reportMeta = useCallback(
        (): ReportMeta => ({
            appVersion: APP_VERSION,
            appBuild: APP_BUILD,
            appBuildDate: APP_BUILD_DATE,
            templatesOnly: TEMPLATES_ONLY,
            username: splunkUsername || '',
        }),
        [],
    );

    const handleDownloadEnvironmentReport = useCallback(async (): Promise<void> => {
        if (!gathered || running || pdfBusy) return;
        setPdfBusy(true);
        try {
            const model = buildEnvironmentReportModel({
                env: gathered.env,
                // The window the evidence was GATHERED under — never the live
                // picker (§13.8a correction 2).
                windowLabel: `${gathered.earliest} -> ${gathered.latest}`,
                meta: reportMeta(),
            });
            await downloadReport(model);
            // The persist inside downloadReport is fire-and-forget; give it a
            // beat before refreshing the list (a manual Refresh also exists).
            window.setTimeout(() => {
                void refreshReports();
            }, 1200);
        } catch (e) {
            // eslint-disable-next-line no-console
            console.error('[Diagnostics] environment report failed', e);
        } finally {
            if (mountedRef.current) setPdfBusy(false);
        }
    }, [gathered, running, pdfBusy, reportMeta, refreshReports]);

    const rowFail = useCallback((key: string, message: string): void => {
        setRowErrors((prev) => ({ ...prev, [key]: message }));
    }, []);

    /* Saved-report re-downloads go through renderReportPdf + triggerDownload
     * DIRECTLY — never downloadReport — so a re-download can never re-persist
     * (§13.8a correction 9). */
    const handleRowPdf = useCallback(
        async (row: DiagReportListRow): Promise<void> => {
            if (rowBusy) return;
            setRowBusy(`${row.key}:pdf`);
            setRowErrors((prev) => ({ ...prev, [row.key]: '' }));
            try {
                const model = await fetchReportModel(row.key);
                if (!model) {
                    rowFail(row.key, 'This report could not be loaded (missing, too large, or malformed).');
                    return;
                }
                const blob = await renderReportPdf(model);
                triggerDownload(blob, `${model.filenameBase}.pdf`);
            } catch (e) {
                rowFail(row.key, `PDF re-render failed: ${e instanceof Error ? e.message : String(e)}`);
            } finally {
                if (mountedRef.current) setRowBusy(null);
            }
        },
        [rowBusy, rowFail],
    );

    const handleRowJson = useCallback(
        async (row: DiagReportListRow): Promise<void> => {
            if (rowBusy) return;
            setRowBusy(`${row.key}:json`);
            setRowErrors((prev) => ({ ...prev, [row.key]: '' }));
            try {
                const model = await fetchReportModel(row.key);
                if (!model) {
                    rowFail(row.key, 'This report could not be loaded (missing, too large, or malformed).');
                    return;
                }
                const blob = new Blob([JSON.stringify(model.json, null, 2)], {
                    type: 'application/json',
                });
                triggerDownload(blob, `${model.filenameBase}.json`);
            } catch (e) {
                rowFail(row.key, `JSON export failed: ${e instanceof Error ? e.message : String(e)}`);
            } finally {
                if (mountedRef.current) setRowBusy(null);
            }
        },
        [rowBusy, rowFail],
    );

    // ---- derived views ------------------------------------------------------
    const rollupView = useMemo(() => {
        if (!gathered) return null;
        const nowSec = Math.floor(gathered.gatheredAtMs / 1000);
        const rows = gathered.env.rollups
            .map((r) => ({
                ...r,
                history: classifyRollupHistory(r.probed, r.oldest, r.newest, nowSec),
            }))
            .sort((a, b) => {
                const byLabel = a.label.localeCompare(b.label);
                return byLabel !== 0 ? byLabel : a.collection.localeCompare(b.collection);
            });
        // Per-rollup weakest-link History verdict — the counts the banner
        // mirrors against Settings -> Dashboard Data. Derived from the
        // registry-shaped rows, never hardcoded (there are 27 completeness
        // collections across the 25 rollups; the flat topology inventory is
        // deliberately absent).
        const perKey: Record<string, RollupHistoryStatus[]> = {};
        rows.forEach((r) => {
            if (!perKey[r.key]) perKey[r.key] = [];
            perKey[r.key].push(r.history);
        });
        let total = 0;
        let needsBackfill = 0;
        let unknown = 0;
        Object.keys(perKey).forEach((k) => {
            total += 1;
            const combined = combineRollupHistory(perKey[k]);
            if (combined === 'incomplete' || combined === 'empty') needsBackfill += 1;
            else if (combined === 'unknown') unknown += 1;
        });
        const freshnessTally: Record<string, number> = {};
        rows.forEach((r) => {
            freshnessTally[r.status] = (freshnessTally[r.status] || 0) + 1;
        });
        return { rows, total, needsBackfill, unknown, freshnessTally };
    }, [gathered]);

    const sourcetypeRows = useMemo(() => {
        if (!gathered) return null;
        const win = gathered.env.sourcetypeWindowCounts;
        const seen = gathered.env.sourcetypeLastSeen;
        if (win === null && seen === null) return null;
        const keys: Record<string, true> = {};
        if (win) Object.keys(win).forEach((k) => (keys[k] = true));
        if (seen) Object.keys(seen).forEach((k) => (keys[k] = true));
        return Object.keys(keys)
            .sort()
            .map((st) => ({
                sourcetype: st,
                // The windowed tstats emits NO row for a zero-count sourcetype:
                // absence from a SUCCESSFUL probe is a genuine 0.
                windowCount: win === null ? null : typeof win[st] === 'number' ? win[st] : 0,
                lastSeen: seen === null ? null : typeof seen[st] === 'number' ? seen[st] : null,
            }));
    }, [gathered]);

    const eventsInWindow = useMemo(() => {
        if (!gathered || gathered.env.indexCounts === null) return null;
        const c = gathered.env.indexCounts;
        return Object.keys(c).reduce((a, k) => a + c[k], 0);
    }, [gathered]);

    const env = gathered ? gathered.env : null;

    // ---- render -------------------------------------------------------------
    return (
        <DashboardLayout
            category="PLATFORM"
            title="Diagnostics"
            subtitle="Data Doctor — live environment health for the LogServ data pipeline, and saved diagnostic reports"
            noCloudFilter
            noRefreshPicker
            titleRowActions={
                <>
                    {running ? (
                        <Btn type="button" onClick={handleCancel}>
                            Cancel
                        </Btn>
                    ) : (
                        <Btn type="button" onClick={handleRerun}>
                            Re-run checks
                        </Btn>
                    )}
                    <Btn
                        type="button"
                        onClick={() => {
                            void handleDownloadEnvironmentReport();
                        }}
                        disabled={running || !gathered || pdfBusy}
                        title={
                            running || !gathered
                                ? 'Available once the checks complete'
                                : 'Download the environment Data Doctor report (PDF + JSON)'
                        }
                    >
                        {pdfBusy ? 'Rendering…' : 'Download report (PDF)'}
                    </Btn>
                </>
            }
        >
            <Stack>
                <StatusRow>
                    {running && (
                        <>
                            <Spinner radius={8} dotSize={3} />
                            <span>{progress}</span>
                        </>
                    )}
                    {!running && gathered && (
                        <Muted>
                            Evidence as of {new Date(gathered.gatheredAtMs).toLocaleString()} for
                            window {gathered.earliest} {'->'} {gathered.latest}
                            {gathered.partial ? ' — cancelled, partial results' : ''}
                        </Muted>
                    )}
                    {!running && !gathered && !fatal && (
                        <Muted>No checks have completed yet.</Muted>
                    )}
                </StatusRow>

                {superseded && (
                    <Notice $tone="neutral">
                        This page&apos;s checks were superseded by another diagnosis (a panel
                        drawer or the Actions menu). Use Re-run checks to gather fresh evidence.
                    </Notice>
                )}
                {fatal && (
                    <Notice $tone="warn">
                        The checks themselves failed: {fatal}. Use Re-run checks — and include
                        this message if you contact support.
                    </Notice>
                )}

                {env && (
                    <FramedPanel title="Summary" noToolbar>
                        <KvGrid>
                            <KvLabel>Events in window</KvLabel>
                            <KvValue>
                                {eventsInWindow === null ? '—' : eventsInWindow.toLocaleString()}
                            </KvValue>
                            <KvLabel>Sourcetypes in window</KvLabel>
                            <KvValue>
                                {env.sourcetypeWindowCounts === null
                                    ? '—'
                                    : Object.keys(env.sourcetypeWindowCounts).length}
                            </KvValue>
                            <KvLabel>Index (from the app macro)</KvLabel>
                            <KvValue>
                                {env.macroIndexes === null ? '—' : env.macroIndexes.join(', ')}
                            </KvValue>
                            <KvLabel>Search-head canary</KvLabel>
                            <KvValue>
                                {env.canaryMs === null ? '—' : `${env.canaryMs} ms round-trip`}
                            </KvValue>
                            <KvLabel>Splunk</KvLabel>
                            <KvValue>
                                {env.serverVersion || '—'}
                                {env.serverName ? ` on ${env.serverName}` : ''}
                            </KvValue>
                            <KvLabel>Search-head time</KvLabel>
                            <KvValue>{env.serverTimeLabel || '—'}</KvValue>
                            <KvLabel>Companion apps</KvLabel>
                            <KvValue>
                                {env.appsPresent === null
                                    ? '—'
                                    : COMPANION_APPS.map(
                                          (a) =>
                                              `${a.id}: ${
                                                  (env.appsPresent as Record<string, boolean>)[a.id]
                                                      ? 'present'
                                                      : 'absent'
                                              }${a.note ? ` (${a.note})` : ''}`,
                                      ).join(' · ')}
                            </KvValue>
                        </KvGrid>
                    </FramedPanel>
                )}

                {rollupView && (
                    <FramedPanel
                        title="Summarised data (rollup collections)"
                        subtitle="Freshness = how recently the hourly/daily aggregation last wrote. History = whether ~30 days of backfilled history exists (the Settings -> Dashboard Data completeness convention)."
                        noToolbar
                    >
                        <Stack>
                            {rollupView.needsBackfill > 0 && (
                                <Notice $tone="warn">
                                    {rollupView.needsBackfill} of {rollupView.total} dashboard
                                    rollups don&apos;t yet have a full 30 days of data — a Splunk
                                    administrator can run the backfill in Settings {'->'} Dashboard
                                    Data. Until then those dashboards show only recent history.
                                </Notice>
                            )}
                            {rollupView.unknown > 0 && (
                                <Notice $tone="neutral">
                                    {rollupView.unknown} rollup
                                    {rollupView.unknown === 1 ? ' was' : 's were'} not checked
                                    (budget exhausted or cancelled) — use Re-run checks.
                                </Notice>
                            )}
                            {rollupView.needsBackfill === 0 &&
                                rollupView.unknown === 0 &&
                                rollupView.total > 0 && (
                                    <Notice $tone="good">
                                        All {rollupView.total} dashboard rollups have ~30 days of
                                        history.
                                    </Notice>
                                )}
                            <div style={{ overflowX: 'auto' }}>
                                <Table>
                                    <thead>
                                        <tr>
                                            <th>Dashboard</th>
                                            <th>Collection</th>
                                            <th>Grain</th>
                                            <th>Oldest</th>
                                            <th>Newest</th>
                                            <th>Freshness</th>
                                            <th>History</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {rollupView.rows.map((r) => (
                                            <tr key={`${r.key}:${r.collection}`}>
                                                <td>{r.label}</td>
                                                <td>
                                                    <Muted>{r.collection}</Muted>
                                                </td>
                                                <td>{r.grain}</td>
                                                <td>{fmtEpochUtc(r.oldest)}</td>
                                                <td>{fmtEpochUtc(r.newest)}</td>
                                                <td>
                                                    <StatusTag
                                                        sentiment={
                                                            FRESHNESS_SENTIMENT[r.status] ||
                                                            'dormant'
                                                        }
                                                        title={
                                                            r.status === 'stale' &&
                                                            r.lagSeconds !== null
                                                                ? `${(r.lagSeconds / 3600).toFixed(1)} h behind`
                                                                : undefined
                                                        }
                                                    >
                                                        {FRESHNESS_LABEL[r.status] || r.status}
                                                    </StatusTag>
                                                </td>
                                                <td>
                                                    <StatusTag
                                                        sentiment={HISTORY_SENTIMENT[r.history]}
                                                    >
                                                        {HISTORY_LABEL[r.history]}
                                                    </StatusTag>
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </Table>
                            </div>
                            <Muted>
                                Healthy freshness lag is up to ~2.5 hours for hourly collections
                                and ~48.5 hours for daily ones (the aggregates run at staggered
                                minutes over the previous completed hour/day).
                            </Muted>
                        </Stack>
                    </FramedPanel>
                )}

                {env && (
                    <FramedPanel
                        title="Platform health (snapshot)"
                        subtitle="Hourly Tier-B snapshot of scheduler, concurrency and pipeline signals from index=_internal - context, never a cause."
                        noToolbar
                    >
                        {env.platform.status !== 'live' ? (
                            <p style={{ margin: 0, lineHeight: 1.5 }}>
                                <Muted>
                                    {'Platform snapshot NOT AVAILABLE - '}
                                    {env.platform.status === 'not-checked'
                                        ? 'it could not be read.'
                                        : env.platform.status === 'empty'
                                          ? env.platformProducerDisabled === true
                                              ? 'the hourly snapshot search is DISABLED.'
                                              : env.platformProducerHasRun === false
                                                ? 'the hourly snapshot search has not run yet (it runs at two minutes past each hour).'
                                                : env.platformProducerHasRun === true
                                                  ? 'the snapshot search has run but written nothing - most often because index=_internal is not searchable for nobody-owned scheduled searches on this instance.'
                                                  : 'the snapshot collection is empty.'
                                          : `its newest snapshot is ${
                                                env.platform.ageSeconds !== null
                                                    ? Math.round(env.platform.ageSeconds / 3600)
                                                    : '?'
                                            } hour(s) old (stale) - only ${env.platform.bucketsPresent} of the last ${env.platform.bucketsExpected} hourly snapshots are present, which is itself a scheduler symptom.`}
                                    {' Scheduler and throughput figures are omitted rather than guessed.'}
                                </Muted>
                            </p>
                        ) : (
                            <Stack>
                                <p style={{ margin: 0, lineHeight: 1.5 }}>
                                    <Muted>
                                        {`Live - newest hourly bucket ${
                                            env.platform.ageSeconds !== null
                                                ? Math.round(env.platform.ageSeconds / 60)
                                                : '?'
                                        } min old; ${env.platform.bucketsPresent}/${env.platform.bucketsExpected} recent buckets`}
                                        {env.platform.truncated ? '; 24h read truncated (partial window)' : ''}
                                        {env.platform.futureDropped > 0
                                            ? `; ${env.platform.futureDropped} future-dated row(s) ignored`
                                            : ''}
                                        {env.ownJobs
                                            ? `. Search jobs visible to you: ${env.ownJobs.returned}${env.ownJobs.capped ? '+' : ''} (${env.ownJobs.queued} queued, ${env.ownJobs.running} running - includes this page's own probes).`
                                            : '.'}
                                    </Muted>
                                </p>
                                {env.platform.skips.length > 0 ? (
                                    <div style={{ overflowX: 'auto' }}>
                                        <Table>
                                            <thead>
                                                <tr>
                                                    <th>Skipped/deferred search</th>
                                                    <th>App</th>
                                                    <th>Status</th>
                                                    <th>Times</th>
                                                    <th>Reason</th>
                                                </tr>
                                            </thead>
                                            <tbody>
                                                {env.platform.skips
                                                    .slice()
                                                    .sort((a, b) => b.n - a.n)
                                                    .slice(0, 10)
                                                    .map((s, i) => (
                                                        // eslint-disable-next-line react/no-array-index-key
                                                        <tr key={`${s.search}:${i}`}>
                                                            <td>{s.search}</td>
                                                            <td>{s.app}</td>
                                                            <td>{s.status}</td>
                                                            <td>{s.n}</td>
                                                            <td>{s.reason}</td>
                                                        </tr>
                                                    ))}
                                            </tbody>
                                        </Table>
                                    </div>
                                ) : (
                                    <p style={{ margin: 0 }}>
                                        <Muted>
                                            No scheduler skips or deferrals recorded in the last 24
                                            hours.
                                        </Muted>
                                    </p>
                                )}
                            </Stack>
                        )}
                    </FramedPanel>
                )}

                {sourcetypeRows && (
                    <FramedPanel
                        title="Sourcetypes"
                        subtitle="Events per sourcetype in the selected window, and when each was last seen (all time)."
                        noToolbar
                    >
                        <div style={{ overflowX: 'auto' }}>
                            <Table>
                                <thead>
                                    <tr>
                                        <th>Sourcetype</th>
                                        <th>Events in window</th>
                                        <th>Last seen (all time)</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {sourcetypeRows.map((r) => (
                                        <tr key={r.sourcetype}>
                                            <td>{r.sourcetype}</td>
                                            <td>
                                                {r.windowCount === null
                                                    ? '—'
                                                    : r.windowCount.toLocaleString()}
                                            </td>
                                            <td>{fmtEpochUtc(r.lastSeen)}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </Table>
                        </div>
                    </FramedPanel>
                )}

                {env && (
                    <FramedPanel title="What was checked" noToolbar>
                        {env.notes.length === 0 && <Muted>Nothing was checked.</Muted>}
                        {env.notes.map((n, i) => (
                            // eslint-disable-next-line react/no-array-index-key
                            <LedgerRow key={`${n.check}:${i}`}>
                                <span aria-hidden>{STATUS_GLYPH[n.status]}</span>
                                <span>
                                    {n.check} <Muted>{n.detail}</Muted>
                                </span>
                                <Muted>{n.durationMs ? `${n.durationMs} ms` : ''}</Muted>
                            </LedgerRow>
                        ))}
                        {env.budgetExhausted && (
                            <Muted>
                                Some checks were skipped (budget exhausted or cancelled) — their
                                rows read NOT CHECKED, never OK.
                            </Muted>
                        )}
                    </FramedPanel>
                )}

                <FramedPanel title="What cannot be checked from here" noToolbar>
                    {cannotCheckLines(gathered ? gathered.env.ingestFacts : null).map((line) => (
                        <p key={line.slice(0, 40)} style={{ margin: '0 0 8px', lineHeight: 1.5 }}>
                            <Muted>{line}</Muted>
                        </p>
                    ))}
                </FramedPanel>

                <FramedPanel
                    title="Ingest-tier filters (operator-supplied)"
                    subtitle="The one thing this page cannot see for itself — supply it, and the diagnosis can rule the ingest filters in or out."
                    noToolbar
                >
                    <p style={{ margin: '0 0 10px', lineHeight: 1.5 }}>
                        The Data TA&rsquo;s include/exclude rules and days-in-past cutoff run on the
                        ingest tier and silently discard events before they are indexed. Run ONE of
                        the commands below where your Data TA configuration lives, paste the output
                        here, and every diagnosis on this instance gains checks that can name the
                        exact rule. The paste is credential-scrubbed before it is stored, and
                        everything derived from it is always labelled as operator-supplied.
                    </p>
                    <p style={{ margin: '0 0 6px' }}>
                        <Muted>
                            Deployment server (distributed install) — or this host on a
                            single-instance install:
                        </Muted>
                    </p>
                    <CmdRow>
                        <CmdText>{REST_COMMAND}</CmdText>
                        <Btn type="button" onClick={() => copyText(REST_COMMAND)}>
                            Copy
                        </Btn>
                    </CmdRow>
                    <p style={{ margin: '0 0 6px' }}>
                        <Muted>
                            Heavy forwarder (its REST endpoint shows shipped defaults, NOT the
                            pushed configuration — paste the generated file instead):
                        </Muted>
                    </p>
                    <CmdRow>
                        <CmdText>{HF_COMMAND}</CmdText>
                        <Btn type="button" onClick={() => copyText(HF_COMMAND)}>
                            Copy
                        </Btn>
                    </CmdRow>
                    <p style={{ margin: '0 0 10px' }}>
                        <Muted>
                            The XML form (without ?output_mode=json) and the settings conf
                            (local/splunk_ta_sap_logserv_settings.conf) are also accepted.
                        </Muted>
                    </p>
                    <PasteBox
                        value={paste}
                        onChange={(e) => setPaste(e.target.value)}
                        placeholder="Paste the command output here…"
                        aria-label="Ingest filter configuration paste box"
                    />
                    <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 8 }}>
                        <Btn
                            type="button"
                            onClick={() => {
                                void handleSaveFacts();
                            }}
                            disabled={saveBusy || running || paste.trim().length === 0}
                            title={
                                running
                                    ? 'Wait for the running checks to finish, then save.'
                                    : 'Scrub, parse and store the supplied configuration, then re-run the checks.'
                            }
                        >
                            {saveBusy ? 'Saving…' : 'Save supplied configuration'}
                        </Btn>
                        <Muted>
                            Re-pasting overwrites the previous supply. There is no delete — the
                            newest paste is simply the one that counts.
                        </Muted>
                    </div>
                    {saveMsg && (
                        <div style={{ marginTop: 10 }}>
                            <Notice $tone={saveMsg.tone}>{saveMsg.text}</Notice>
                        </div>
                    )}
                    {gathered && gathered.env.ingestFacts && (
                        <div style={{ marginTop: 14 }}>
                            <KvGrid>
                                <KvLabel>Currently supplied</KvLabel>
                                <KvValue>{ingestFactsSummary(gathered.env.ingestFacts)}</KvValue>
                                <KvLabel>Provenance</KvLabel>
                                <KvValue>{provenanceLine(gathered.env.ingestFacts)}</KvValue>
                            </KvGrid>
                            {factsAreStale(
                                gathered.env.ingestFacts,
                                Math.floor(Date.now() / 1000),
                            ) && (
                                <div style={{ marginTop: 8 }}>
                                    <Notice $tone="warn">
                                        The supplied configuration is more than 7 days old — the
                                        Data TA&rsquo;s filters may have changed since. Re-supply it
                                        to be sure.
                                    </Notice>
                                </div>
                            )}
                        </div>
                    )}
                    {gathered && !gathered.env.ingestFacts && (
                        <p style={{ margin: '10px 0 0' }}>
                            <Muted>
                                Nothing supplied yet{running ? ' (checks still running)' : ''} — the
                                diagnosis currently treats the ingest filters as unknowable.
                            </Muted>
                        </p>
                    )}
                </FramedPanel>

                <FramedPanel
                    title="Saved Data Doctor reports"
                    subtitle={`Every downloaded report is saved here automatically. Kept for 365 days, newest ${RETENTION_MAX_ROWS}.`}
                    noToolbar
                    actions={
                        <Btn
                            type="button"
                            onClick={() => {
                                void refreshReports();
                            }}
                        >
                            Refresh list
                        </Btn>
                    }
                >
                    <Stack>
                        {reportsUnavailable && (
                            <Notice $tone="warn">
                                The saved-reports list could not be read — the KV Store may be
                                unavailable. Try Refresh list.
                            </Notice>
                        )}
                        {reports !== null && reports.length === 0 && !reportsUnavailable && (
                            <Muted>
                                No saved reports yet. Reports appear here whenever a Data Doctor
                                PDF is downloaded — from a panel&apos;s diagnosis drawer, the
                                Actions menu, or this page.
                            </Muted>
                        )}
                        {reports === null && <Muted>Loading…</Muted>}
                        {reports !== null && reports.length > 0 && (
                            <div style={{ overflowX: 'auto' }}>
                                <Table>
                                    <thead>
                                        <tr>
                                            <th>Generated</th>
                                            <th>Scope</th>
                                            <th>Report</th>
                                            <th>Summary</th>
                                            <th>By</th>
                                            <th>Build</th>
                                            <th>Download</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {reports.map((r) => (
                                            <tr key={r.key}>
                                                <td>
                                                    {new Date(r.generatedAt * 1000).toLocaleString()}
                                                </td>
                                                <td>{r.scope || '—'}</td>
                                                <td>{r.scopeLabel || r.key}</td>
                                                <td>{r.verdictSummary || '—'}</td>
                                                <td>{r.username || '—'}</td>
                                                <td>{r.appBuild || '—'}</td>
                                                <td>
                                                    {r.truncated ? (
                                                        <Muted>
                                                            not stored (too large) — only the copy
                                                            downloaded at generation time exists
                                                        </Muted>
                                                    ) : (
                                                        <>
                                                            <Btn
                                                                type="button"
                                                                onClick={() => {
                                                                    void handleRowPdf(r);
                                                                }}
                                                                disabled={rowBusy !== null}
                                                            >
                                                                {rowBusy === `${r.key}:pdf`
                                                                    ? '…'
                                                                    : 'PDF'}
                                                            </Btn>{' '}
                                                            <Btn
                                                                type="button"
                                                                onClick={() => {
                                                                    void handleRowJson(r);
                                                                }}
                                                                disabled={rowBusy !== null}
                                                            >
                                                                {rowBusy === `${r.key}:json`
                                                                    ? '…'
                                                                    : 'JSON'}
                                                            </Btn>
                                                        </>
                                                    )}
                                                    {rowErrors[r.key] ? (
                                                        <RowError>{rowErrors[r.key]}</RowError>
                                                    ) : null}
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </Table>
                            </div>
                        )}
                        <Muted>
                            Saved reports are visible to all users of this app and, like every
                            app collection, writable by them — treat them as shared,
                            unauthenticated-integrity artifacts. The authoritative copy of a
                            report is the one downloaded when it was generated.
                        </Muted>
                    </Stack>
                </FramedPanel>
            </Stack>
        </DashboardLayout>
    );
};

export default Diagnostics;
