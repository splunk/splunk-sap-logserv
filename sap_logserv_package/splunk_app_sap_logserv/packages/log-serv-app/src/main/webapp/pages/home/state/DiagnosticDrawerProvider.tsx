import React, {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useRef,
    useState,
} from 'react';
import { createPortal } from 'react-dom';
import { useLocation } from 'react-router-dom';
import styled from 'styled-components';
import { logservTheme } from '../styles/logservTheme';
import Spinner from '../components/Spinner';
import { PanelFacts, PanelMode, Verdict, diagnosisMode } from '../utils/panelDiagnosis';
import { probeSpl, scalarTwinFieldFor, ColumnOrigin } from '../utils/splProbe';
import { ColumnCoverageSummary } from '../utils/columnCoverage';
import { beginDiagnosis, endDiagnosis, isDiagnosisActive, ProbeRunner } from '../utils/diagProbe';
import {
    gatherPanelEvidence,
    collectRawSamples,
    RawSampleSet,
    PanelEvidence,
    ProbeNote,
} from '../utils/diagEvidence';
import {
    diagnosePanel,
    Diagnosis,
    shouldShowIngestPointer,
    INGEST_POINTER_SENTENCE,
} from '../utils/diagCascade';
import {
    buildPanelReportModel,
    PRODUCER_SPL_INTRO,
    producerSplCompleteness,
    producerSplForOpenInSearch,
    backfillHedge,
    ROLLUP_SEARCHES_HEADING,
} from '../utils/diagReport';
import { copyText } from '../utils/clipboard';
import { buildOpenInSearchUrl, openInNewTab } from '../utils/drilldownUrls';
import { downloadReport } from '../utils/diagReportPdf';
import { findDashboardByPath } from '../routes/dashboardRegistry';
import { APP_VERSION, APP_BUILD, APP_BUILD_DATE, TEMPLATES_ONLY } from '../buildFlags';
import { username as splunkUsername } from '@splunk/splunk-utils/config';

/**
 * DiagnosticDrawerProvider — the "Run full diagnosis" surface
 * (session 095, Phase 2 of the Missing-Data Diagnostic).
 *
 * WHY A SINGLE APP-LEVEL DRAWER RATHER THAN ONE PER PANEL
 * ------------------------------------------------------
 * Two reasons, both from the design review (§12.10 / §12.11):
 *
 *  1. `FramedPanel`'s Root is `overflow: hidden`. A drawer rendered where the
 *     link lives is a descendant of that clipping box, so on every panel in a
 *     grid it would be cut off at the panel border. This one is PORTALED to
 *     `document.body` with `position: fixed`. A portal still preserves React
 *     context, so the theme and everything else resolve normally.
 *  2. The failure this tool exists to diagnose — ingest stopped, or the search
 *     head saturated — empties EVERY panel on a dashboard at once. If each
 *     empty panel owned its own drawer, an operator clicking three of them
 *     while the first felt slow would triple the load on the machine they are
 *     trying to rescue. One drawer, one diagnosis, enforced here and again by
 *     the `beginDiagnosis` singleton underneath.
 *
 * NO DESTRUCTIVE CONTROLS, EVER. Every `logserv_*` KV collection is
 * `write: [*]`, so a Clear or backfill button on this surface would actually
 * succeed for a non-admin. Those stay behind the Settings admin gate; this
 * drawer only ever names where to go.
 */

export interface DiagnosticRequest {
    /** Panel title, for the drawer header. */
    title: string;
    facts: PanelFacts;
    /** §18.8a-1/2 — the values-free column-coverage summary, resolved from the
     *  renderer-published side channel at request-build time. TRANSIENT: it
     *  lives on the request, never on facts, so the report builder (which
     *  serialises facts wholesale) can never see even the counts unrequested. */
    columnCoverage?: ColumnCoverageSummary | null;
    /** §18.8a-12 — blank-column origin resolutions from the panel's own SPL. */
    columnOrigins?: Record<string, ColumnOrigin> | null;
}

interface Ctx {
    open: (req: DiagnosticRequest) => void;
    isOpen: boolean;
}

const NOOP: Ctx = { open: () => undefined, isOpen: false };
const DiagnosticDrawerContext = createContext<Ctx>(NOOP);

export const useDiagnosticDrawer = (): Ctx => useContext(DiagnosticDrawerContext);

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------

const Backdrop = styled.div`
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.45);
    z-index: 9500;
`;

const Panel = styled.aside`
    position: fixed;
    top: 0;
    right: 0;
    bottom: 0;
    width: min(560px, 100vw);
    display: flex;
    flex-direction: column;
    background: ${logservTheme.colors.panelBackground};
    border-left: 1px solid ${logservTheme.colors.cyanAccent};
    color: ${logservTheme.colors.textDefault};
    font-family: ${logservTheme.font.body};
    font-size: ${logservTheme.fontSize.body};
    z-index: 9501;
    box-shadow: -8px 0 24px rgba(0, 0, 0, 0.35);
`;

const Header = styled.div`
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: ${logservTheme.spacing.md};
    padding: ${logservTheme.spacing.lg} ${logservTheme.spacing.xl};
    border-bottom: 1px solid ${logservTheme.colors.panelBorderWeak};
`;

const Title = styled.div`
    font-size: ${logservTheme.fontSize.large};
    font-weight: ${logservTheme.fontWeight.semibold};
    color: ${logservTheme.colors.textActive};
`;

const SubTitle = styled.div`
    margin-top: 2px;
    color: ${logservTheme.colors.textMuted};
    font-size: ${logservTheme.fontSize.small};
`;

const CloseBtn = styled.button`
    flex: 0 0 auto;
    background: transparent;
    border: 1px solid ${logservTheme.colors.panelBorderWeak};
    border-radius: ${logservTheme.radius.small};
    color: ${logservTheme.colors.textMuted};
    padding: 4px 10px;
    cursor: pointer;
    &:hover {
        color: ${logservTheme.colors.textActive};
        border-color: ${logservTheme.colors.cyanAccent};
    }
`;

const Body = styled.div`
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    padding: ${logservTheme.spacing.xl};
`;

const Verdicts = styled.div`
    margin-bottom: ${logservTheme.spacing.xl};
`;

const Headline = styled.p`
    margin: 0 0 ${logservTheme.spacing.sm};
    font-size: ${logservTheme.fontSize.large};
    line-height: 1.45;
    color: ${logservTheme.colors.textActive};
`;

const Detail = styled.p`
    margin: 0 0 ${logservTheme.spacing.md};
    line-height: 1.55;
    color: ${logservTheme.colors.textDefault};
`;

const Tag = styled.span<{ $tone: 'fault' | 'ok' | 'unknown' }>`
    display: inline-block;
    margin-right: ${logservTheme.spacing.sm};
    padding: 2px 8px;
    border-radius: ${logservTheme.radius.small};
    font-size: ${logservTheme.fontSize.small};
    background: ${(p) =>
        p.$tone === 'fault'
            ? logservTheme.colors.red
            : p.$tone === 'ok'
              ? logservTheme.colors.green
              : logservTheme.colors.tableHeaderBackground};
    color: ${(p) =>
        p.$tone === 'unknown' ? logservTheme.colors.textMuted : logservTheme.colors.inverseText};
`;

const SectionTitle = styled.h3`
    margin: ${logservTheme.spacing.xl} 0 ${logservTheme.spacing.sm};
    font-size: ${logservTheme.fontSize.body};
    font-weight: ${logservTheme.fontWeight.semibold};
    color: ${logservTheme.colors.cyanLight};
    text-transform: uppercase;
    letter-spacing: 0.06em;
`;

const Row = styled.div`
    display: grid;
    grid-template-columns: 18px 1fr auto;
    gap: ${logservTheme.spacing.sm};
    padding: 6px 0;
    border-bottom: 1px solid ${logservTheme.colors.panelBorderWeak};
    line-height: 1.4;
`;

const Muted = styled.span`
    color: ${logservTheme.colors.textMuted};
    font-size: ${logservTheme.fontSize.small};
`;

const Mono = styled.pre`
    margin: ${logservTheme.spacing.sm} 0 0;
    padding: ${logservTheme.spacing.md};
    background: ${logservTheme.colors.tableHeaderBackground};
    border: 1px solid ${logservTheme.colors.panelBorderWeak};
    border-radius: ${logservTheme.radius.small};
    font-family: ${logservTheme.font.mono};
    font-size: ${logservTheme.fontSize.small};
    white-space: pre-wrap;
    word-break: break-word;
    color: ${logservTheme.colors.textDefault};
`;

/* Session 113 — the corner-action overlay on a producer-SPL block (Copy /
 * Open in Search). The top-right corner is RESERVED via padding rather than
 * letting the buttons float over the text: Mono is pre-wrap with no
 * horizontal scroll, so any text a floating button covered would stay
 * covered forever. The Mono's own top margin moves onto the wrapper so the
 * absolute positioning anchors at the block's real top edge. */
const MonoWrap = styled.div`
    position: relative;
    margin-top: ${logservTheme.spacing.sm};
    ${Mono} {
        margin-top: 0;
        padding-right: 64px;
    }
`;

const MonoActions = styled.div`
    position: absolute;
    top: 6px;
    right: 6px;
    display: flex;
    gap: 4px;
`;

const MonoIconBtn = styled.button`
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    padding: 0;
    background: ${logservTheme.colors.tableHeaderBackground};
    border: 1px solid ${logservTheme.colors.panelBorderWeak};
    border-radius: ${logservTheme.radius.small};
    color: ${logservTheme.colors.textMuted};
    cursor: pointer;
    svg {
        width: 14px;
        height: 14px;
        fill: none;
        stroke: currentColor;
        stroke-width: 1.5;
        stroke-linecap: round;
        stroke-linejoin: round;
    }
    &:hover {
        color: ${logservTheme.colors.textActive};
        border-color: ${logservTheme.colors.cyanAccent};
    }
`;

const Footer = styled.div`
    flex: 0 0 auto;
    display: flex;
    gap: ${logservTheme.spacing.sm};
    padding: ${logservTheme.spacing.lg} ${logservTheme.spacing.xl};
    border-top: 1px solid ${logservTheme.colors.panelBorderWeak};
`;

const Btn = styled.button`
    background: transparent;
    border: 1px solid ${logservTheme.colors.panelBorderWeak};
    border-radius: ${logservTheme.radius.small};
    color: ${logservTheme.colors.textDefault};
    padding: 6px 12px;
    cursor: pointer;
    font-size: ${logservTheme.fontSize.body};
    &:hover {
        border-color: ${logservTheme.colors.cyanAccent};
        color: ${logservTheme.colors.textActive};
    }
`;

const Disclosure = styled.button`
    background: transparent;
    border: none;
    padding: 0;
    color: ${logservTheme.colors.cyanLight};
    cursor: pointer;
    font-size: ${logservTheme.fontSize.body};
    text-decoration: underline dotted;
`;

const CONFIDENCE_LABEL: Record<string, string> = {
    confirmed: 'Confirmed',
    likely: 'Likely',
    possible: 'Possible',
    expected: 'Working as intended',
    'not-evaluated': 'Not checked',
};

const OWNER_LABEL: Record<string, string> = {
    user: 'You can change this',
    'splunk-admin': 'Needs a Splunk administrator',
    ingest: 'Needs whoever sends the logs',
    vendor: 'A defect in this app',
    nobody: 'No action needed',
};

const toneFor = (v: Verdict): 'fault' | 'ok' | 'unknown' => {
    if (v.confidence === 'expected') return 'ok';
    if (v.confidence === 'not-evaluated') return 'unknown';
    return 'fault';
};

const STATUS_GLYPH: Record<ProbeNote['status'], string> = {
    ok: '✓',
    error: '!',
    skipped: '–',
    superseded: '–',
};

/** Clipboard, with the fallback the estate needs: `navigator.clipboard`
 *  requires a secure context and these instances are HTTP-only. */
// copyText extracted to utils/clipboard.ts (session 099 / build 314) so the
// Diagnostics page's command-card Copy buttons share the HTTP-safe fallback.

const buildSummary = (
    req: DiagnosticRequest,
    diag: Diagnosis | null,
    ev: PanelEvidence | null,
): string => {
    const lines: string[] = [];
    lines.push('LogServ Data Doctor — technical summary');
    lines.push(`Panel: ${req.title || '(untitled)'}`);
    lines.push(`Window: ${req.facts.earliest} -> ${req.facts.latest}`);
    lines.push(`Rows returned: ${req.facts.rowCount === null ? '(none yet)' : req.facts.rowCount}`);
    if (req.facts.errorMessage) lines.push(`Search error: ${req.facts.errorMessage}`);
    lines.push('');
    if (diag) {
        lines.push(`VERDICT: ${diag.top.headline}`);
        lines.push(`  confidence: ${diag.top.confidence} · owner: ${diag.top.owner}`);
        if (diag.top.detail) lines.push(`  ${diag.top.detail}`);
        // §19.8a-19 — the ingest pointer rides the support paste too, under
        // the SAME condition the drawer renders it.
        if (ev && shouldShowIngestPointer(diag.top.id, ev)) {
            lines.push(`  ${INGEST_POINTER_SENTENCE}`);
        }
        lines.push('');
        lines.push('All checks:');
        diag.all.forEach((v) => {
            lines.push(`  [${v.confidence}] ${v.id}: ${v.headline}`);
            v.evidence.forEach((e) => lines.push(`      - ${e}`));
        });
        lines.push('');
    }
    if (ev) {
        lines.push('Evidence gathered:');
        ev.notes.forEach((n) =>
            lines.push(
                `  ${n.status.toUpperCase()} ${n.check}: ${n.detail}${
                    n.durationMs ? ` (${n.durationMs} ms)` : ''
                }`,
            ),
        );
        if (ev.canaryMs !== null) lines.push(`  Search-head canary: ${ev.canaryMs} ms`);
        lines.push('');
    }
    lines.push('Dispatched SPL:');
    lines.push(req.facts.spl);
    /* §20.2 — the rollup-populating SPL rides the support paste too, from the
     * SAME evidence field the drawer renders (the two surfaces cannot
     * disagree). Own guard: this block sits outside `if (ev)`. */
    if (ev && Array.isArray(ev.producerSpl) && ev.producerSpl.length > 0) {
        lines.push('');
        lines.push(`${ROLLUP_SEARCHES_HEADING}:`);
        lines.push(PRODUCER_SPL_INTRO);
        const completeness = producerSplCompleteness(ev.producerSpl);
        if (completeness) lines.push(completeness);
        ev.producerSpl.forEach((p) => {
            const where = p.collection
                ? `currently configured to populate ${p.collection}`
                : `registered for this rollup (populates one of: ${p.rollupCollections.join(', ')})`;
            lines.push('');
            lines.push(`  ${p.name} — ${where}${p.cron ? ` · cron: ${p.cron}` : ''}`);
            if (p.updated) lines.push(`  definition last modified: ${p.updated}`);
            if (p.spl) {
                lines.push(p.spl);
                if (p.backfill) lines.push(`  ${backfillHedge(p.backfill)}`);
            } else {
                lines.push(`  Could not be read — ${p.error}`);
            }
        });
    }
    return lines.join('\n');
};

/* Icon glyphs match the PanelActions toolbar set (16-viewBox, stroke-based,
 * currentColor; the magnifier is the same glyph the panel toolbar uses for
 * its own Open-in-Search action). */
const CopyGlyph: React.FC = () => (
    <svg viewBox="0 0 16 16" aria-hidden>
        <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
        <path d="M2.5 10.5 v-6.5 a1.5 1.5 0 0 1 1.5 -1.5 h6.5" />
    </svg>
);
const CheckGlyph: React.FC = () => (
    <svg viewBox="0 0 16 16" aria-hidden>
        <polyline points="3,8.5 6.5,12 13,4.5" />
    </svg>
);
const SearchGlyph: React.FC = () => (
    <svg viewBox="0 0 16 16" aria-hidden>
        <circle cx="7" cy="7" r="4.2" />
        <line x1="10.2" y1="10.2" x2="14" y2="14" />
    </svg>
);

/**
 * A producer-SPL block with its two corner actions (session 113):
 *
 *  - Copy — the definition VERBATIM, including the `| outputlookup` write
 *    (a clipboard copy is inert). Brief checkmark feedback, per instance.
 *  - Open in Search — via `producerSplForOpenInSearch`, which removes the
 *    terminal `| outputlookup` write FIRST: opened verbatim, one Enter press
 *    in the Search app over an arbitrary window would upsert partial bucket
 *    rows over correct summary rows. This drawer is a no-destructive-controls
 *    surface (see the file header), so when the write cannot be removed with
 *    certainty the button is not rendered at all — fail closed.
 *
 * The diagnosed window rides along as `earliest`/`latest` so the opened
 * search is scoped to what was being diagnosed rather than the Search app's
 * default range.
 */
const ProducerSplBlock: React.FC<{ spl: string; earliest: string; latest: string }> = ({
    spl,
    earliest,
    latest,
}) => {
    const [copied, setCopied] = useState(false);
    const copiedTimer = useRef<number | null>(null);
    useEffect(
        () => () => {
            if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
        },
        [],
    );
    const openable = producerSplForOpenInSearch(spl);
    const onCopy = (): void => {
        copyText(spl);
        setCopied(true);
        if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
        copiedTimer.current = window.setTimeout(() => setCopied(false), 1600);
    };
    return (
        <MonoWrap>
            <MonoActions>
                <MonoIconBtn
                    type="button"
                    onClick={onCopy}
                    title={copied ? 'Copied' : 'Copy this SPL to the clipboard'}
                    aria-label="Copy this SPL to the clipboard"
                >
                    {copied ? <CheckGlyph /> : <CopyGlyph />}
                </MonoIconBtn>
                {openable !== null && (
                    <MonoIconBtn
                        type="button"
                        onClick={() =>
                            openInNewTab(buildOpenInSearchUrl(openable, earliest, latest))
                        }
                        title={
                            'Open in the Search app (new tab) over the diagnosed window — ' +
                            'the terminal | outputlookup write is removed so running it ' +
                            'cannot modify the summary'
                        }
                        aria-label="Open this SPL in the Search app in a new tab"
                    >
                        <SearchGlyph />
                    </MonoIconBtn>
                )}
            </MonoActions>
            <Mono>{spl}</Mono>
        </MonoWrap>
    );
};

const DrawerContents: React.FC<{ req: DiagnosticRequest; onClose: () => void }> = ({
    req,
    onClose,
}) => {
    const [notes, setNotes] = useState<ProbeNote[]>([]);
    const [evidence, setEvidence] = useState<PanelEvidence | null>(null);
    const [diag, setDiag] = useState<Diagnosis | null>(null);
    const [running, setRunning] = useState(true);
    const [fatal, setFatal] = useState<string | null>(null);
    const [showDetail, setShowDetail] = useState(false);
    const runnerRef = useRef<ProbeRunner | null>(null);
    const mountedRef = useRef(true);

    /* §18.8a-5/6 — the mode drives the header AND the dispatch decision (the
     * classification is `diagnosisMode`, single-sourced with the cascade). A
     * request whose WINDOW is unknown REFUSES to dispatch entirely: a gather
     * with empty bounds probes ALL TIME (the review's W-2 blocker). */
    const mode: PanelMode = diagnosisMode(req.facts);
    const windowKnown = !!(req.facts.earliest && req.facts.latest);
    const refused = mode === 'unknown' || !windowKnown;
    const headerTitle = mode === 'partial' ? 'Panel diagnosis' : 'Why is this empty?';

    useEffect(() => {
        mountedRef.current = true;
        setFatal(null);
        if (refused) {
            // No probes, no verdicts — a static, honest refusal (§18.8a-5).
            setRunning(false);
            return () => {
                mountedRef.current = false;
            };
        }
        const runner = beginDiagnosis({ budgetMs: 90000, concurrency: 2 });
        runnerRef.current = runner;
        const probe = probeSpl(req.facts.spl);
        void gatherPanelEvidence(
            runner,
            probe,
            req.facts.earliest,
            req.facts.latest,
            (n) => {
                if (mountedRef.current) setNotes(n);
            },
            // §17.8a-16 — the drawer is the ONLY caller that runs deep probes
            // (21 raw scan + 25 bisect). The sweep never passes these.
            // §18.8a-8/23 — the effective-empty (zeroValued) request passes
            // rowCount 0 to the GATES while facts keep the true count for the
            // report; partial mode carries the coverage + origins.
            {
                deep: true,
                rawAlternate: req.facts.rawAlternate ?? null,
                rowCount: req.facts.zeroValued === true ? 0 : req.facts.rowCount,
                mode: mode === 'partial' ? 'partial' : 'empty',
                columnCoverage: req.columnCoverage ?? null,
                columnOrigins: req.columnOrigins ?? null,
                zeroValued: req.facts.zeroValued === true,
                scalarTwinField:
                    req.facts.zeroValued === true && req.facts.rawAlternate
                        ? scalarTwinFieldFor(req.facts.spl, req.facts.rawAlternate)
                        : null,
            },
        )
            .then((ev) => {
                if (!mountedRef.current) return;
                // Release the singleton on COMPLETION, not just on close —
                // otherwise `isDiagnosisActive` stays true for the rest of the
                // 90 s budget after the verdict already rendered (session 095,
                // finding 11).
                endDiagnosis(runner);
                setEvidence(ev);
                setDiag(diagnosePanel(req.facts, ev));
                setRunning(false);
            })
            .catch((e: unknown) => {
                /* Without this the drawer spins on "Checking…" forever if any
                 * evidence extractor or the cascade throws — the session-055
                 * wedged-orchestrator class (session 095, finding 6). The
                 * message is surfaced verbatim: a diagnosis that failed must
                 * say so, not go quiet. */
                if (!mountedRef.current) return;
                endDiagnosis(runner);
                setFatal(e instanceof Error ? e.message : String(e));
                setRunning(false);
            });
        return () => {
            mountedRef.current = false;
            // Cancels server-side too: every probe carries auto_cancel.
            endDiagnosis(runner);
        };
    }, [req]);

    const cancel = useCallback(() => {
        if (runnerRef.current) endDiagnosis(runnerRef.current);
        setRunning(false);
    }, []);

    /* Session 095 — the panel-level "Download PDF" (design §7, decision 5's
     * download half). Renders the SAME diagnosis the drawer shows as the
     * branded Data Doctor report, plus its machine-readable .json twin.
     *
     * SS16.6 — the opt-in raw samples. Default OFF, reset per request, never
     * sticky. Collection runs on a SHORT dedicated runner at download time
     * (the drawer's own runner was already released on completion — session
     * 095 finding 11), released in `finally`; the button is disabled while
     * any diagnosis is active so the singleton is never superseded by a
     * download (SS16.8a-27). Sample-bearing reports are download-only —
     * `downloadReport`/`persistReport` enforce the never-persist rule. */
    const [pdfBusy, setPdfBusy] = useState(false);
    const [includeSamples, setIncludeSamples] = useState(false);
    useEffect(() => {
        setIncludeSamples(false);
    }, [req]);
    const handleDownloadPdf = useCallback(async (): Promise<void> => {
        if (!diag || !evidence || pdfBusy) return;
        if (includeSamples && isDiagnosisActive()) return;
        setPdfBusy(true);
        try {
            const probe = probeSpl(req.facts.spl);
            let rawSamples: RawSampleSet | null = null;
            if (includeSamples) {
                const sts =
                    probe.sourcetypes.length > 0
                        ? probe.sourcetypes
                        : evidence.sourceScope
                          ? evidence.sourceScope.sourcetypes
                          : [];
                const excluded: string[] = [];
                if (probe.hostFilter) {
                    excluded.push(
                        probe.hostFilter.form === 'topn'
                            ? `Top-${probe.hostFilter.topN || 'N'} host selection`
                            : `host filter (${probe.hostFilter.hosts.length} host(s))`,
                    );
                }
                if (probe.cloudFilter) excluded.push(`cloud_provider=${probe.cloudFilter.provider}`);
                if (probe.grainFilters.length > 0) excluded.push(probe.grainFilters.join(', '));
                const sampleRunner = beginDiagnosis({ budgetMs: 20000, concurrency: 1 });
                try {
                    rawSamples = await collectRawSamples(
                        sampleRunner,
                        sts,
                        excluded,
                        req.facts.earliest,
                        req.facts.latest,
                    );
                } finally {
                    endDiagnosis(sampleRunner);
                }
            }
            const path = (window.location.hash || '').replace(/^#/, '').split('?')[0];
            const dash = findDashboardByPath(path);
            const model = buildPanelReportModel({
                panelTitle: req.title,
                dashboardLabel: dash ? dash.name : path || '(unknown)',
                facts: req.facts,
                probe,
                diag,
                evidence,
                rawSamples,
                meta: {
                    appVersion: APP_VERSION,
                    appBuild: APP_BUILD,
                    appBuildDate: APP_BUILD_DATE,
                    templatesOnly: TEMPLATES_ONLY,
                    username: splunkUsername || '',
                },
            });
            await downloadReport(model);
        } catch (e) {
            // eslint-disable-next-line no-console
            console.error('[DiagnosticDrawer] PDF report failed', e);
        } finally {
            if (mountedRef.current) setPdfBusy(false);
        }
    }, [diag, evidence, pdfBusy, includeSamples, req]);

    const top = diag ? diag.top : null;

    return (
        <>
            <Header>
                <div>
                    <Title>{headerTitle}</Title>
                    <SubTitle>
                        {req.title || 'This panel'}
                        {windowKnown ? ` · ${req.facts.earliest} -> ${req.facts.latest}` : ''}
                    </SubTitle>
                </div>
                <CloseBtn onClick={onClose} aria-label="Close">
                    Close
                </CloseBtn>
            </Header>

            <Body>
                {refused && (
                    <Detail>
                        This panel’s search state is unknown —{' '}
                        {windowKnown
                            ? 'it has not reported a row count (still loading, or never classified)'
                            : 'its time window could not be established'}
                        , so nothing was diagnosed. No checks were dispatched: probing without a
                        known window would scan all time. Let the panel finish loading and try
                        again.
                    </Detail>
                )}
                {running && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <Spinner radius={8} dotSize={3} />
                        <span>Checking…</span>
                    </div>
                )}

                {fatal && (
                    <Detail style={{ color: logservTheme.colors.red }}>
                        The diagnosis itself failed: {fatal}. Close and retry — and include this
                        message if you contact support.
                    </Detail>
                )}

                {top && (
                    <Verdicts>
                        <div style={{ marginBottom: 8 }}>
                            <Tag $tone={toneFor(top)}>
                                {CONFIDENCE_LABEL[top.confidence] || top.confidence}
                            </Tag>
                            <Muted>{OWNER_LABEL[top.owner] || top.owner}</Muted>
                        </div>
                        <Headline>{top.headline}</Headline>
                        {top.detail && <Detail>{top.detail}</Detail>}
                        {/* §19.5 — the pointer to the Diagnostics-page paste
                            (UI-side only: the gather stays noiseless, reports
                            carry the ask via the boundary section). Suppressed
                            when facts already answer the boundary question or
                            when the facts read failed (§19.8a-18). */}
                        {evidence && shouldShowIngestPointer(top.id, evidence) && (
                            <Detail>{INGEST_POINTER_SENTENCE}</Detail>
                        )}
                        {diag && diag.incomplete && (
                            <Muted>
                                Some checks did not run — the detail below says which, and why.
                            </Muted>
                        )}
                    </Verdicts>
                )}

                <SectionTitle>What was checked</SectionTitle>
                {notes.length === 0 && !running && <Muted>Nothing was checked.</Muted>}
                {notes.map((n, i) => (
                    <Row key={`${n.check}-${i}`}>
                        <span aria-hidden>{STATUS_GLYPH[n.status]}</span>
                        <span>
                            {n.check}
                            <br />
                            <Muted>{n.detail}</Muted>
                        </span>
                        <Muted>{n.durationMs ? `${n.durationMs} ms` : ''}</Muted>
                    </Row>
                ))}

                {diag && (
                    <>
                        <SectionTitle>
                            <Disclosure onClick={() => setShowDetail((s) => !s)}>
                                {showDetail ? 'Hide technical detail' : 'Show technical detail'}
                            </Disclosure>
                        </SectionTitle>
                        {showDetail && (
                            <>
                                {diag.all.map((v, i) => (
                                    <Row key={`${v.id}-${i}`}>
                                        <span aria-hidden>
                                            {v.confidence === 'not-evaluated' ? '–' : '•'}
                                        </span>
                                        <span>
                                            {v.headline}
                                            {v.evidence.map((e, j) => (
                                                <span key={j}>
                                                    <br />
                                                    <Muted>{e}</Muted>
                                                </span>
                                            ))}
                                        </span>
                                        <Muted>{CONFIDENCE_LABEL[v.confidence]}</Muted>
                                    </Row>
                                ))}
                                <SectionTitle>Dispatched search</SectionTitle>
                                <Mono>{req.facts.spl}</Mono>
                                {/* §20.2 — the rollup-populating SPL, from the
                                    deep-gated evidence capture. Array.isArray:
                                    older evidence shapes leave it undefined. */}
                                {evidence &&
                                    Array.isArray(evidence.producerSpl) &&
                                    evidence.producerSpl.length > 0 && (
                                        <>
                                            <SectionTitle>{ROLLUP_SEARCHES_HEADING}</SectionTitle>
                                            <Muted>{PRODUCER_SPL_INTRO}</Muted>
                                            {producerSplCompleteness(evidence.producerSpl) && (
                                                <Muted>
                                                    {producerSplCompleteness(evidence.producerSpl)}
                                                </Muted>
                                            )}
                                            {evidence.producerSpl.map((p, i) => (
                                                <div key={`${p.name}-${i}`}>
                                                    <Detail>
                                                        {p.name}
                                                        {' — '}
                                                        {p.collection
                                                            ? `currently configured to populate ${p.collection}`
                                                            : `registered for this rollup (populates one of: ${p.rollupCollections.join(', ')})`}
                                                        {p.cron ? ` · cron: ${p.cron}` : ''}
                                                    </Detail>
                                                    {p.updated && (
                                                        <Muted>
                                                            definition last modified: {p.updated}
                                                        </Muted>
                                                    )}
                                                    {p.spl ? (
                                                        <>
                                                            <ProducerSplBlock
                                                                spl={p.spl}
                                                                earliest={req.facts.earliest}
                                                                latest={req.facts.latest}
                                                            />
                                                            {p.backfill && (
                                                                <Muted>
                                                                    {backfillHedge(p.backfill)}
                                                                </Muted>
                                                            )}
                                                        </>
                                                    ) : (
                                                        <Muted>Could not be read — {p.error}</Muted>
                                                    )}
                                                </div>
                                            ))}
                                        </>
                                    )}
                            </>
                        )}
                    </>
                )}
            </Body>

            <Footer>
                {running ? (
                    <Btn onClick={cancel}>Cancel</Btn>
                ) : (
                    <>
                        <Btn onClick={() => copyText(buildSummary(req, diag, evidence))}>
                            Copy technical summary
                        </Btn>
                        {diag && evidence && (
                            <>
                                <label
                                    style={{
                                        display: 'inline-flex',
                                        alignItems: 'center',
                                        gap: 6,
                                        fontSize: 12,
                                        color: logservTheme.colors.textMuted,
                                        cursor: 'pointer',
                                    }}
                                    title={
                                        'Adds up to 5 recent events of the sourcetype(s) this view reads, ' +
                                        'credential-scrubbed and email/user-redacted, each included in ' +
                                        'full. A report with samples is download-only - it is ' +
                                        'NOT saved to the Saved reports list.'
                                    }
                                >
                                    <input
                                        type="checkbox"
                                        checked={includeSamples}
                                        onChange={(e) => setIncludeSamples(e.target.checked)}
                                        aria-label="Include raw event samples in the PDF"
                                    />
                                    Include raw event samples
                                </label>
                                <Btn onClick={handleDownloadPdf} disabled={pdfBusy}>
                                    {pdfBusy ? 'Rendering…' : 'Download PDF'}
                                </Btn>
                            </>
                        )}
                    </>
                )}
                <Btn onClick={onClose}>Close</Btn>
            </Footer>
        </>
    );
};

export const DiagnosticDrawerProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const [req, setReq] = useState<DiagnosticRequest | null>(null);

    const open = useCallback((r: DiagnosticRequest) => setReq(r), []);
    const close = useCallback(() => setReq(null), []);

    /* SS16.8a-30 (C10) — close on ROUTE CHANGE, driven from the router, not a
     * `hashchange` listener: react-router's hash history navigates via
     * `history.pushState`, which fires neither `hashchange` nor `popstate`,
     * so a DOM listener would catch browser Back but MISS every in-app nav
     * click — the exact shape being fixed. `useLocation` fires for both.
     * Deps deliberately EXCLUDE `req`: opening the drawer must not re-run
     * this effect (the location is unchanged, and a run would close it
     * immediately); a location change re-renders first, so the effect's
     * closure reads the current `req`. Closing mid-run is safe — unmount
     * flips `mountedRef` and releases the runner (session-097 ordering). */
    const location = useLocation();
    useEffect(() => {
        if (req) close();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [location.pathname, location.search, close]);

    useEffect(() => {
        if (!req) return undefined;
        const onKey = (e: KeyboardEvent): void => {
            if (e.key === 'Escape') close();
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [req, close]);

    const value = useMemo<Ctx>(() => ({ open, isOpen: req !== null }), [open, req]);

    return (
        <DiagnosticDrawerContext.Provider value={value}>
            {children}
            {req !== null &&
                createPortal(
                    <>
                        <Backdrop onClick={close} />
                        <Panel role="dialog" aria-label="Panel diagnosis">
                            <DrawerContents req={req} onClose={close} />
                        </Panel>
                    </>,
                    document.body,
                )}
        </DiagnosticDrawerContext.Provider>
    );
};

export default DiagnosticDrawerProvider;
