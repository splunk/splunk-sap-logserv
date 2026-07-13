import React, { useCallback, useEffect, useRef, useState } from 'react';
import styled, { keyframes } from 'styled-components';
import { logservTheme } from '../../../styles/logservTheme';
import { useThemeMode } from '../../../state/ThemeModeProvider';
import { darken } from '../../../utils/colorMath';
import { useAIAssistantContext } from '../../../state/AIAssistantProvider';
import { useAIAssistant } from '../../../hooks/useAIAssistant';
import { useIsPowerUser } from '../../../hooks/useIsPowerUser';
import { useMCPHealth } from '../../../hooks/useMCPHealth';
import MCPSetupWizard from '../mcp/MCPSetupWizard';
import ChatMessage from './ChatMessage';
import ChatInput from './ChatInput';
import PromptBrowser from './PromptBrowser';
import ToolResultPanel from './ToolResultPanel';
import PrivacyBanner, { AuditModal } from './PrivacyBanner';
import { buildSplunkSearchUrl } from '../../../utils/drilldownUrls';

const DEFAULT_LEFT_PCT = 40;
const MIN_LEFT_PCT = 18;
const MAX_LEFT_PCT = 82;
const SESSION_KEY_LEFT_PCT = 'logserv.aiAssistant.split.leftPct';

const readPctFromSession = (): number => {
    try {
        const v = window.sessionStorage.getItem(SESSION_KEY_LEFT_PCT);
        if (v === null) return DEFAULT_LEFT_PCT;
        const n = Number(v);
        if (!Number.isFinite(n)) return DEFAULT_LEFT_PCT;
        return Math.max(MIN_LEFT_PCT, Math.min(MAX_LEFT_PCT, n));
    } catch (_e) { /* ignore */ }
    return DEFAULT_LEFT_PCT;
};

const writePctToSession = (pct: number): void => {
    try { window.sessionStorage.setItem(SESSION_KEY_LEFT_PCT, String(pct)); } catch (_e) { /* ignore */ }
};

/**
 * AIAssistant — the chat orchestrator.
 *
 * Two-pane layout (per design §6.3):
 *   - Left (~40%): chat scroll + input
 *   - Right (~60%): tool-result panels (one per executed tool call)
 *
 * Renders the MCPSetupWizard if MCP health check fails. Otherwise
 * shows the chat. Privacy banner pinned to the top.
 *
 * Used by:
 *   - The top-level /ai-assistant dashboard (full-page)
 *   - The SidePanel wrapper (collapsible drawer on every dashboard)
 */

const Container = styled.div`
    display: flex;
    flex-direction: column;
    height: 100%;
    /* min-height intentionally NOT set: when the parent (SidePanel
     * ContentSlot, or any embedding container) is shorter than the
     * AIAssistant's content — typical when the user zooms the browser
     * past 100% — the Container must shrink to fit the parent so the
     * inner ChatScroll can take over scrolling. A previous min-height
     * of 600px caused the chat input to be pushed below the visible
     * area at zoom levels above ~125% with no recoverable scroll. */
    min-height: 0;
    background: ${logservTheme.colors.pageBackground};
`;

const TwoPane = styled.div<{ $singleColumn: boolean; $leftPct: number }>`
    display: grid;
    grid-template-columns: ${(p) =>
        p.$singleColumn ? '1fr' : `${p.$leftPct}% 6px ${100 - p.$leftPct}%`};
    flex: 1 1 auto;
    overflow: hidden;
`;

const LeftPane = styled.div<{ $hasRightPane: boolean }>`
    display: flex;
    flex-direction: column;
    border-right: ${(p) =>
        p.$hasRightPane ? `1px solid ${logservTheme.colors.panelBorderWeak}` : '0'};
    overflow: hidden;
    min-width: 0;
`;

const RightPane = styled.div`
    overflow-y: auto;
    padding: ${logservTheme.spacing.md};
    background: ${logservTheme.colors.pageBackground};
    min-width: 0;
`;

const SplitDivider = styled.div`
    cursor: col-resize;
    background: ${logservTheme.colors.panelBorderWeak};
    width: 6px;
    transition: background 120ms ease;

    &:hover, &:active {
        background: ${logservTheme.colors.cyanAccent};
    }
`;

const ChatScroll = styled.div`
    flex: 1 1 auto;
    overflow-y: auto;
    padding: ${logservTheme.spacing.md};
    display: flex;
    flex-direction: column;
    gap: ${logservTheme.spacing.sm};
`;

const StatusLine = styled.div`
    display: inline-flex;
    align-items: center;
    gap: 8px;
    color: ${logservTheme.colors.textMuted};
    font-size: ${logservTheme.fontSize.small};
    font-style: italic;
    /* Build 150 — pin status (spinner + text) to the right edge of the
     * chat scroll so the spinner doesn't crowd the assistant's text
     * bubbles on the left. Spinner is rendered after the label text so
     * it's the rightmost element in the row. */
    align-self: flex-end;
`;

/* Windows 11 — style "circle of dots" loading spinner. Build 150.
 *
 * 8 small dots arranged on a 9 px-radius circle, each dot a radial-gradient
 * orange bead matching the medium-severity dot from the chat narrative
 * (so the visual language is: orange = "something is in flight"). The
 * brightness wave travels around the circle once per 1.2 s — same character
 * as Windows 11's progress indicator.
 *
 * Implemented as a CSS animation rather than a GIF because:
 *   - sharper at any DPI (no rasterization)
 *   - smaller bundle (no embedded image data)
 *   - matches the radial-gradient bead exactly
 *   - easy to tweak colors / size without re-rendering an image
 */
const SPINNER_PERIOD_S = 1.2;
const SPINNER_DOT_COUNT = 8;
const SPINNER_RADIUS_PX = 9;
const SPINNER_DOT_PX = 3;

const dotPulse = keyframes`
    0%, 70%, 100% { opacity: 0.15; transform: rotate(var(--angle, 0deg)) translateY(-${SPINNER_RADIUS_PX}px) scale(0.85); }
    20%           { opacity: 1;    transform: rotate(var(--angle, 0deg)) translateY(-${SPINNER_RADIUS_PX}px) scale(1); }
`;

const SpinnerWrap = styled.span`
    position: relative;
    display: inline-block;
    width: ${SPINNER_RADIUS_PX * 2 + SPINNER_DOT_PX * 2}px;
    height: ${SPINNER_RADIUS_PX * 2 + SPINNER_DOT_PX * 2}px;
    flex-shrink: 0;
    vertical-align: middle;
`;

const SpinnerDot = styled.span<{ $angle: number; $delay: number; $c1: string; $c2: string; $c3: string }>`
    position: absolute;
    top: 50%;
    left: 50%;
    width: ${SPINNER_DOT_PX}px;
    height: ${SPINNER_DOT_PX}px;
    margin-left: ${-SPINNER_DOT_PX / 2}px;
    margin-top: ${-SPINNER_DOT_PX / 2}px;
    border-radius: 50%;
    background: radial-gradient(circle at 35% 30%, ${(p) => p.$c1} 0%, ${(p) => p.$c2} 55%, ${(p) => p.$c3} 100%);
    /* Each dot's --angle CSS variable feeds the keyframe transform so the
     * dot stays at its position on the circle while the brightness wave
     * travels around. */
    --angle: ${(p) => p.$angle}deg;
    transform: rotate(${(p) => p.$angle}deg) translateY(-${SPINNER_RADIUS_PX}px);
    animation: ${dotPulse} ${SPINNER_PERIOD_S}s ease-in-out infinite;
    animation-delay: ${(p) => p.$delay}s;
    will-change: opacity, transform;
`;

const Spinner: React.FC = () => {
    // Magnetic interact-blue bead (Phase 4 / build 258) — same treatment as
    // the shared components/Spinner.tsx, mode-resolved.
    const { tokens } = useThemeMode();
    return (
        <SpinnerWrap aria-label="Loading" role="status">
            {Array.from({ length: SPINNER_DOT_COUNT }).map((_, i) => (
                <SpinnerDot
                    key={i}
                    $angle={i * (360 / SPINNER_DOT_COUNT)}
                    $delay={i * (SPINNER_PERIOD_S / SPINNER_DOT_COUNT)}
                    $c1={tokens.cyanLight}
                    $c2={tokens.cyanAccent}
                    $c3={darken(tokens.cyanAccent, 0.45)}
                />
            ))}
        </SpinnerWrap>
    );
};

const ErrorLine = styled.div`
    color: ${logservTheme.colors.red};
    font-size: ${logservTheme.fontSize.small};
    align-self: flex-start;
`;

const RightPaneEmpty = styled.div`
    color: ${logservTheme.colors.textMuted};
    text-align: center;
    padding: ${logservTheme.spacing.xxl};
    font-size: ${logservTheme.fontSize.body};
`;

const ResultsToolbar = styled.div`
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: ${logservTheme.spacing.sm};
    padding: 0 ${logservTheme.spacing.xs} ${logservTheme.spacing.sm};
    color: ${logservTheme.colors.textMuted};
    font-size: ${logservTheme.fontSize.small};
`;

const ClearAllButton = styled.button`
    background: transparent;
    border: 1px solid ${logservTheme.colors.panelBorderWeak};
    color: ${logservTheme.colors.textMuted};
    border-radius: ${logservTheme.radius.small};
    padding: 4px 12px;
    cursor: pointer;
    font-family: inherit;
    font-size: ${logservTheme.fontSize.small};

    &:hover {
        color: ${logservTheme.colors.red};
        border-color: ${logservTheme.colors.red};
    }
`;

const ChatOnlyBanner = styled.div`
    background: rgba(244, 165, 53, 0.12);
    border-bottom: 1px solid ${logservTheme.colors.orangeLight};
    color: ${logservTheme.colors.textActive};
    font-size: ${logservTheme.fontSize.small};
    padding: ${logservTheme.spacing.xs} ${logservTheme.spacing.md};
    display: flex;
    align-items: center;
    gap: ${logservTheme.spacing.xs};
`;

/* Templates-only build banner — cyan-accent (informational), distinct
   from the orange ChatOnlyBanner (warning). Build 173. */
const TemplatesOnlyBanner = styled.div`
    background: rgba(8, 119, 166, 0.12);
    border-bottom: 1px solid ${logservTheme.colors.cyanAccent};
    color: ${logservTheme.colors.textActive};
    font-size: ${logservTheme.fontSize.small};
    padding: ${logservTheme.spacing.xs} ${logservTheme.spacing.md};
    display: flex;
    align-items: center;
    gap: ${logservTheme.spacing.xs};
`;

interface AIAssistantProps {
    /** Privacy tier from config; affects banner styling. */
    tier?: 0 | 1 | 2;
    /** When false, the MCP health gate is bypassed and the chat operates
     *  in "MCP-less chat mode" — Claude streaming works, no tool dispatch.
     *  Default: true (gate enforced). */
    mcpRequired?: boolean;
    /** Per-user free-form prompt rate limit (rolling 1-hour window).
     *  0 = disabled. Read by the parent (typically `index.tsx`) from
     *  `ai_assistant_settings.conf [defaults] rate_limit_per_hour`.
     *  Default: 30. Maps to OWASP LLM10. Build 80 / session 019. */
    rateLimitPerHour?: number;
    /** Per-chat-session cap on total MCP tool dispatches across all
     *  messages. 0 = disabled. From `ai_assistant_settings.conf
     *  [defaults] tool_calls_per_session_cap`. Default: 100. Maps to
     *  OWASP LLM06. Build 88 / session 020. */
    toolCallsPerSessionCap?: number;
    /** Per-user daily vendor spend cap in USD (resets at local
     *  midnight). 0 = disabled. From `ai_assistant_settings.conf
     *  [defaults] daily_spend_cap_usd`. Default: 50.00. Maps to
     *  OWASP LLM10. Build 89 / session 020. */
    dailySpendCapUsd?: number;
    /** Tier 2 PII column redaction. When true (default), Tier 2
     *  categorical aggregates redact identifier-class column values
     *  (`user`, `*_ip`, `email`, `mac`, `account`) with stable
     *  `<redacted-XXXXXXX>` tags before they cross the privacy
     *  boundary. From `ai_assistant_settings.conf [defaults]
     *  tier2_pii_redaction`. Maps to OWASP LLM02. Build 94. */
    tier2PiiRedaction?: boolean;
    /** When true, also redact host / hostname columns. From
     *  `ai_assistant_settings.conf [defaults] tier2_redact_hostnames`.
     *  Default false — Splunk dashboards routinely show hostnames.
     *  Build 94 / session 022. */
    tier2RedactHostnames?: boolean;
    /** Comma-separated Splunk role names whose members see the Power
     *  Mode toggle in the chat input toolbar. From
     *  `ai_assistant_settings.conf [defaults] power_user_roles`.
     *  Empty (default) hides the toggle for everyone. Build 166 /
     *  session 028. */
    powerUserRoles?: string;
    /** Runtime templates-only mode. When true, free-form chat is
     *  disabled (read-only input, hidden model picker + Power toggle,
     *  templates-only banner shown). Replaces the compile-time
     *  TEMPLATES_ONLY build flag with admin-controlled runtime config. */
    templatesOnlyMode?: boolean;
}

const AIAssistant: React.FC<AIAssistantProps> = ({
    tier = 1,
    mcpRequired = true,
    rateLimitPerHour = 30,
    toolCallsPerSessionCap = 100,
    dailySpendCapUsd = 50.0,
    tier2PiiRedaction = true,
    tier2RedactHostnames = false,
    powerUserRoles = '',
    templatesOnlyMode = false,
}) => {
    const ctx = useAIAssistantContext();
    /* Power Mode role-membership check (build 166 / session 028). The
     * hook returns false until the async `current-context` fetch lands;
     * non-power users never see the toggle even after it resolves. The
     * actual toggle state lives in the AIAssistantProvider context so
     * sendUserMessage / runCannedPrompt can read it consistently. */
    const isPowerUser = useIsPowerUser(powerUserRoles);
    const { runCannedPrompt, sendUserMessage, abort } = useAIAssistant({
        mcpAvailable: mcpRequired,
        tier,
        rateLimitPerHour,
        toolCallsPerSessionCap,
        dailySpendCapUsd,
        tier2PiiRedaction,
        tier2RedactHostnames,
        powerMode: ctx.powerMode,
        templatesOnlyMode,
    });
    const [healthRetryNonce, setHealthRetryNonce] = useState<number>(0);
    const health = useMCPHealth({ enabled: mcpRequired, retryNonce: healthRetryNonce });
    /* Lazy model-discovery TTL trigger (session 079 / build 275) — the
     * chat panel opening is the signal that this browser session is
     * actually using the AI Assistant, so it's the right moment for
     * the background vendor model-list refresh (governed by the
     * `model_discovery_enabled` admin setting; skips the mock
     * provider; at most one attempt per provider per page load; the
     * 24h TTL lives in modelDiscovery.ts). Fire-and-forget — never
     * blocks the panel. */
    const { maybeRefreshModels } = ctx;
    useEffect(() => {
        maybeRefreshModels();
    }, [maybeRefreshModels]);
    const [showPromptBrowser, setShowPromptBrowser] = useState<boolean>(false);
    const [showAuditModal, setShowAuditModal] = useState<boolean>(false);
    const [leftPct, setLeftPct] = useState<number>(readPctFromSession);
    const chatBottomRef = useRef<HTMLDivElement>(null);
    const twoPaneRef = useRef<HTMLDivElement>(null);
    const dragStartRef = useRef<{ startX: number; startPct: number; widthPx: number } | null>(null);

    const onDividerMouseDown = useCallback((e: React.MouseEvent): void => {
        const rect = twoPaneRef.current?.getBoundingClientRect();
        if (!rect) return;
        dragStartRef.current = { startX: e.clientX, startPct: leftPct, widthPx: rect.width };
        e.preventDefault();

        const onMove = (ev: MouseEvent): void => {
            const start = dragStartRef.current;
            if (!start || start.widthPx === 0) return;
            const deltaPx = ev.clientX - start.startX;
            const deltaPct = (deltaPx / start.widthPx) * 100;
            const next = Math.max(MIN_LEFT_PCT, Math.min(MAX_LEFT_PCT, start.startPct + deltaPct));
            setLeftPct(next);
        };
        const onUp = (): void => {
            const start = dragStartRef.current;
            dragStartRef.current = null;
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
            // Persist on release rather than every mousemove tick to avoid
            // sessionStorage thrash during drags. Read the latest pct off
            // state via a functional setState trick — using closure-captured
            // leftPct here would write the pre-drag value.
            setLeftPct((p) => { writePctToSession(p); void start; return p; });
        };
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
    }, [leftPct]);

    // Auto-scroll chat to bottom when new messages arrive.
    useEffect(() => {
        chatBottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [ctx.state.messages.length]);

    // Click-to-jump: scrolls the right pane to the matching ToolResultPanel.
    // Each panel is wrapped in <div id={`toolresult-${toolUseId}`}> below;
    // scrollIntoView walks up to the nearest scrollable ancestor (RightPane).
    // Build 140 fix — previously ChatMessage received no onJumpToResult so
    // the link was a no-op.
    const handleJumpToResult = useCallback((toolUseId: string): void => {
        const el = document.getElementById(`toolresult-${toolUseId}`);
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, []);

    // Health check gating — only when MCP is required.
    if (mcpRequired && health.status !== 'ok') {
        return (
            <Container>
                <MCPSetupWizard
                    health={health}
                    onRetry={() => setHealthRetryNonce((n) => n + 1)}
                />
            </Container>
        );
    }

    const localOnlyCount = ctx.state.auditEvents.filter((e) => e.category === 'local_only').length;
    const tier1Count = ctx.state.auditEvents.filter((e) => e.category === 'vendor_tier1').length;
    const tier2Count = ctx.state.auditEvents.filter((e) => e.category === 'vendor_tier2').length;

    const toolResultsInOrder = ctx.state.messages
        .filter((m) => m.kind === 'tool_result' && m.toolResult)
        .map((m) => m.toolResult!);

    // Build 146 — citation lookup. Maps the canonical saved-search name
    // (which the AI cites inline as `[→ logserv_xxx]`) to the toolUseId
    // of its rendered tile in the right pane, so the parser in
    // ChatMessage can turn each citation into a clickable scroll target.
    // Built once per render from toolResultsInOrder; lookups in the parser
    // cost O(1).
    //
    // Build 172 — extended to also carry a pre-resolved Splunk-Search
    // drill-down URL (`splUrl`) when the dispatched tool result has the
    // SPL + window plumbed through. ChatMessage uses this to render an
    // "↗ Run SPL" chip alongside the existing dashboard chip(s) on the
    // citation line. Single source of truth: the URL is built once here
    // (using the dispatch's exact earliest/latest, not the global
    // TimeRange picker), so the chat-side renderer stays dumb.
    const citationLookup: Map<string, { toolUseId: string; splUrl?: string }> = new Map();
    toolResultsInOrder.forEach((tr) => {
        if (tr.displayName) {
            const splUrl = tr.spl ? buildSplunkSearchUrl(tr.spl, tr.earliest, tr.latest) : undefined;
            citationLookup.set(tr.displayName, { toolUseId: tr.toolUseId, splUrl });
        }
    });

    const handleClearAll = (): void => {
        // eslint-disable-next-line no-alert
        if (window.confirm('Clear the entire conversation? This removes every prompt and result from this tab.')) {
            ctx.actions.clearConversation();
        }
    };

    const busy = ctx.state.status === 'streaming' || ctx.state.status === 'tool_executing';

    return (
        <Container>
            <PrivacyBanner
                provider={ctx.provider}
                tier={tier}
                localOnlyCount={localOnlyCount}
                tier1Count={tier1Count}
                tier2Count={tier2Count}
                onOpenAudit={() => setShowAuditModal(true)}
                selectedModel={ctx.selectedModel}
                onModelChange={ctx.setSelectedModel}
                models={ctx.effectiveModels}
                templatesOnlyMode={templatesOnlyMode}
            />
            {!mcpRequired && (
                <ChatOnlyBanner role="status">
                    <span aria-hidden>⚠</span>
                    Chat-only mode — tool execution disabled (MCP not configured). The AI can answer
                    questions but cannot run searches against your Splunk data.
                </ChatOnlyBanner>
            )}
            {templatesOnlyMode && (
                <TemplatesOnlyBanner role="status">
                    <span aria-hidden>ℹ</span>
                    Templates-only mode — free-form prompts and LLM dispatch are disabled. Use
                    "Browse predefined prompts" to run any of the 48 saved searches against your
                    Splunk data via MCP.
                </TemplatesOnlyBanner>
            )}
            <TwoPane ref={twoPaneRef} $singleColumn={!mcpRequired} $leftPct={leftPct}>
                <LeftPane $hasRightPane={mcpRequired}>
                    <ChatScroll>
                        {ctx.state.messages.map((m) => (
                            <ChatMessage
                                key={m.id}
                                message={m}
                                onJumpToResult={handleJumpToResult}
                                citationLookup={citationLookup}
                            />
                        ))}
                        {ctx.state.status === 'streaming' && (
                            <StatusLine>
                                AI is generating response
                                <Spinner />
                            </StatusLine>
                        )}
                        {ctx.state.status === 'tool_executing' && (
                            <StatusLine>
                                Running search…
                                <Spinner />
                            </StatusLine>
                        )}
                        {ctx.state.error && (
                            <ErrorLine>Error: {ctx.state.error.message}</ErrorLine>
                        )}
                        <div ref={chatBottomRef} />
                    </ChatScroll>
                    <ChatInput
                        onSend={(text) => {
                            void sendUserMessage(text);
                        }}
                        onAbort={busy ? abort : undefined}
                        onOpenPromptBrowser={
                            mcpRequired ? () => setShowPromptBrowser(true) : undefined
                        }
                        busy={busy}
                        powerModeAvailable={isPowerUser}
                        powerMode={ctx.powerMode}
                        onPowerModeChange={ctx.setPowerMode}
                        templatesOnlyMode={templatesOnlyMode}
                    />
                </LeftPane>
                {mcpRequired && (
                    <SplitDivider
                        role="separator"
                        aria-orientation="vertical"
                        aria-label="Resize chat / results split"
                        onMouseDown={onDividerMouseDown}
                    />
                )}
                {mcpRequired && (
                    <RightPane>
                        {toolResultsInOrder.length === 0 ? (
                            <RightPaneEmpty>
                                Tool results will render here as the AI runs queries against your Splunk
                                data. Try a predefined prompt to see it work.
                            </RightPaneEmpty>
                        ) : (
                            <>
                                <ResultsToolbar>
                                    <span>
                                        {toolResultsInOrder.length} result{toolResultsInOrder.length === 1 ? '' : 's'}
                                    </span>
                                    <ClearAllButton
                                        type="button"
                                        onClick={handleClearAll}
                                        aria-label="Clear all results and chat history"
                                    >
                                        Clear All
                                    </ClearAllButton>
                                </ResultsToolbar>
                                {toolResultsInOrder.map((tr) => (
                                    <div
                                        key={tr.toolUseId}
                                        id={`toolresult-${tr.toolUseId}`}
                                        style={{ scrollMarginTop: 12 }}
                                    >
                                        <ToolResultPanel
                                            // Build 146: dropped the legacy "Result N" prefix so
                                            // the tile title is just the saved-search displayName
                                            // (or a generic fallback). The "Result N" numbering
                                            // was dispatch order, which doesn't correspond to the
                                            // narrative's priority ordering and was confusing.
                                            // The total count still surfaces via the
                                            // "N result(s)" label in the toolbar above.
                                            title={tr.displayName || 'Tool result'}
                                            result={tr.result}
                                            renderHint={tr.renderHint}
                                            chartHint={tr.chartHint}
                                            chartPalette={tr.chartPalette}
                                            dashboard={tr.dashboard}
                                            spl={tr.spl}
                                            earliest={tr.earliest}
                                            latest={tr.latest}
                                            onClear={() => ctx.actions.removeToolResult(tr.toolUseId)}
                                        />
                                    </div>
                                ))}
                            </>
                        )}
                    </RightPane>
                )}
            </TwoPane>
            {showPromptBrowser && (
                <PromptBrowser
                    onClose={() => setShowPromptBrowser(false)}
                    onPromptSelected={(p, tr) => {
                        void runCannedPrompt({
                            promptId: p.id,
                            label: `${p.label} — ${tr.label}`,
                            spl: p.spl,
                            savedSearchName: p.savedSearch,
                            renderHint: p.renderHint,
                            chartHint: p.chartHint,
                            chartPalette: p.chartPalette,
                            interpretation: p.interpretation,
                            nextSteps: p.nextSteps,
                            earliestTime: tr.earliest,
                            latestTime: tr.latest,
                        });
                    }}
                />
            )}
            {showAuditModal && (
                <AuditModal
                    events={ctx.state.auditEvents}
                    onClose={() => setShowAuditModal(false)}
                />
            )}
        </Container>
    );
};

export default AIAssistant;
