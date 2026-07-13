import React, { useState } from 'react';
import styled from 'styled-components';
import { logservTheme } from '../../../styles/logservTheme';
import { useThemeMode } from '../../../state/ThemeModeProvider';
import { darken, lighten } from '../../../utils/colorMath';
import { DisplayMessage } from '../../../state/AIAssistantProvider';
import { SAVED_SEARCH_DASHBOARDS } from '../../../hooks/useAIAssistant';
import { resolveDashboardLinks } from '../../../routes/dashboardLinks';

/**
 * ChatMessage — renders a single DisplayMessage in the chat scroll.
 *
 * Six kinds:
 *   - 'user'             — right-aligned bubble with user text
 *   - 'assistant_text'   — left-aligned bubble with AI text + AI disclaimer
 *   - 'tool_call'        — collapsible card showing the SPL being run
 *   - 'tool_result'      — minimal placeholder; the actual data renders
 *                          in the right pane via ToolResultPanel. The
 *                          chat just shows "Result rendered →" with a
 *                          jump-to-pane affordance.
 *   - 'system_notice'    — italic muted line (errors, warnings)
 *   - 'guidance'         — left-aligned card with static interpretation +
 *                          bulleted next-step suggestions. Surfaced after
 *                          a canned-prompt tool_result. NOT AI-generated
 *                          (no AI disclaimer) — sourced from the intent
 *                          map's per-prompt `interpretation` and
 *                          `nextSteps` fields. Build 140.
 */

interface ChatMessageProps {
    message: DisplayMessage;
    /** When provided, called to scroll the right pane to the matching tool result. */
    onJumpToResult?: (toolUseId: string) => void;
    /**
     * Build 146 — maps saved-search displayName (e.g. `logserv_hana_failed_auth`) →
     * toolUseId, so inline citations like `[→ logserv_hana_failed_auth]` in
     * assistant_text bodies can resolve to a click-to-jump target. When a
     * citation's name is absent from the map (older messages, AI hallucinated
     * a name, lookup not yet hydrated), the citation renders as muted plain
     * text — no broken link, no console error.
     *
     * Build 172 — extended to ALSO carry an optional `splUrl` (resolved
     * pre-time at the AIAssistant.tsx layer using the dispatch's actual
     * earliest/latest, NOT the user's current TimeRange picker). When
     * present, the citation renders an "↗ Run SPL" chip after the
     * dashboard chips, opening Splunk's Search app in a new tab.
     */
    citationLookup?: Map<string, { toolUseId: string; splUrl?: string }>;
}

const Bubble = styled.div<{ $align: 'left' | 'right'; $tone?: 'default' | 'muted' }>`
    align-self: ${(p) => (p.$align === 'right' ? 'flex-end' : 'flex-start')};
    max-width: 85%;
    padding: ${logservTheme.spacing.sm} ${logservTheme.spacing.md};
    border-radius: ${logservTheme.radius.medium};
    background: ${(p) =>
        p.$align === 'right'
            ? logservTheme.colors.cyanAccent
            : logservTheme.colors.tableHeaderBackground};
    /* Right-aligned = the USER bubble on the interact-blue fill: light
       text in BOTH modes (inverseText) — textActive is near-black in light
       mode and unreadable on the blue (user report, build 259). */
    color: ${(p) =>
        p.$align === 'right'
            ? logservTheme.colors.inverseText
            : p.$tone === 'muted'
            ? logservTheme.colors.textMuted
            : logservTheme.colors.textActive};
    font-size: ${logservTheme.fontSize.body};
    white-space: pre-wrap;
    word-break: break-word;
    line-height: 1.4;
`;

const ToolCallCard = styled.div`
    align-self: flex-start;
    max-width: 95%;
    border: 1px solid ${logservTheme.colors.panelBorderWeak};
    border-left: 3px solid ${logservTheme.colors.cyanAccent};
    border-radius: ${logservTheme.radius.small};
    background: ${logservTheme.colors.panelBackground};
    padding: ${logservTheme.spacing.sm} ${logservTheme.spacing.md};
    color: ${logservTheme.colors.textDefault};
    font-size: ${logservTheme.fontSize.small};
`;

const ToolCallHeader = styled.button`
    display: flex;
    align-items: center;
    justify-content: space-between;
    width: 100%;
    background: transparent;
    border: 0;
    color: ${logservTheme.colors.textActive};
    font-size: ${logservTheme.fontSize.small};
    font-weight: ${logservTheme.fontWeight.semibold};
    text-align: left;
    cursor: pointer;
    padding: 0;
    font-family: inherit;
`;

const Caret = styled.span`
    color: ${logservTheme.colors.textMuted};
    margin-right: ${logservTheme.spacing.xs};
    font-size: 10px;
`;

const SplBlock = styled.pre`
    background: ${logservTheme.colors.tableHeaderBackground};
    color: ${logservTheme.colors.cyanLight};
    padding: ${logservTheme.spacing.sm};
    border-radius: ${logservTheme.radius.small};
    margin: ${logservTheme.spacing.sm} 0 0 0;
    overflow-x: auto;
    white-space: pre-wrap;
    word-break: break-all;
    font-size: 12px;
    line-height: 1.4;
`;

const ToolResultLine = styled.button`
    align-self: flex-start;
    background: transparent;
    border: 0;
    color: ${logservTheme.colors.cyanLight};
    cursor: pointer;
    font-size: ${logservTheme.fontSize.small};
    text-decoration: underline dotted;
    padding: ${logservTheme.spacing.xs} 0;
    font-family: inherit;

    &:hover { color: ${logservTheme.colors.textActive}; }
`;

const SystemNoticeLine = styled.div`
    color: ${logservTheme.colors.textMuted};
    font-style: italic;
    font-size: ${logservTheme.fontSize.small};
    align-self: center;
    padding: ${logservTheme.spacing.xs} 0;
`;

/* OWASP LLM09 (Misinformation) — every AI-generated reply carries a
   visible verify-before-acting cue. The disclaimer is intentionally
   subtle (muted colour, smaller font) so it doesn't dominate the chat,
   but is always present and never collapsible. */
const AssistantBlock = styled.div`
    display: flex;
    flex-direction: column;
    align-self: flex-start;
    gap: 2px;
    max-width: 85%;
`;

const AIDisclaimer = styled.div`
    color: ${logservTheme.colors.textMuted};
    font-size: 11px;
    font-style: italic;
    padding-left: ${logservTheme.spacing.sm};
    opacity: 0.85;
`;

/* Guidance card — static interpretation + next-step suggestions
   surfaced after a canned-prompt result. Visually distinct from
   assistant_text bubbles (no chat-bubble styling, cyan-light left
   border to signal "system info, not AI"). Build 140. */
const GuidanceCard = styled.div`
    align-self: flex-start;
    max-width: 95%;
    border: 1px solid ${logservTheme.colors.panelBorderWeak};
    border-left: 3px solid ${logservTheme.colors.cyanLight};
    border-radius: ${logservTheme.radius.small};
    background: ${logservTheme.colors.panelBackground};
    padding: ${logservTheme.spacing.md};
    color: ${logservTheme.colors.textActive};
    font-size: ${logservTheme.fontSize.body};
    line-height: 1.5;
`;

const GuidanceHeader = styled.div`
    color: ${logservTheme.colors.cyanLight};
    font-size: ${logservTheme.fontSize.small};
    font-weight: ${logservTheme.fontWeight.semibold};
    text-transform: uppercase;
    letter-spacing: 0.06em;
    margin-bottom: ${logservTheme.spacing.sm};
`;

const GuidanceParagraph = styled.div`
    color: ${logservTheme.colors.textActive};
    margin-bottom: ${logservTheme.spacing.md};
`;

const GuidanceSubheader = styled.div`
    color: ${logservTheme.colors.cyanLight};
    font-size: ${logservTheme.fontSize.small};
    font-weight: ${logservTheme.fontWeight.semibold};
    text-transform: uppercase;
    letter-spacing: 0.06em;
    margin-bottom: ${logservTheme.spacing.xs};
`;

const GuidanceList = styled.ul`
    margin: 0;
    padding-left: ${logservTheme.spacing.lg};
    color: ${logservTheme.colors.textDefault};
    font-size: ${logservTheme.fontSize.small};
    line-height: 1.5;

    & > li {
        margin-bottom: ${logservTheme.spacing.xs};
    }
    & > li:last-child {
        margin-bottom: 0;
    }
`;

/* Link styling for next-step entries that carry a deep-dive Splunk
   search URL. Cyan-light to signal "interactive", with a subtle
   underline. The `↗` glyph at the end signals "opens in a new tab" —
   matches the affordance pattern used by the dashboards' "More Info"
   buttons and the cross-dashboard navigation. Build 141. */
const GuidanceLink = styled.a`
    color: ${logservTheme.colors.cyanLight};
    text-decoration: underline dotted;
    text-decoration-color: ${logservTheme.colors.cyanAccent};
    text-underline-offset: 2px;
    cursor: pointer;

    &:hover {
        color: ${logservTheme.colors.textActive};
        text-decoration-color: ${logservTheme.colors.textActive};
    }

    &:focus-visible {
        outline: 2px solid ${logservTheme.colors.cyanAccent};
        outline-offset: 2px;
        border-radius: 2px;
    }
`;

const GuidanceLinkArrow = styled.span`
    margin-left: 4px;
    font-size: 0.85em;
    opacity: 0.85;
`;

/* Inline citation link in assistant_text bodies. Build 146.
   Renders `[→ logserv_xxx]` patterns as clickable spans that scroll the
   right pane to the matching tool-result tile. Styled like a subtle inline
   link — cyan-light text, dotted-underline accent, button reset so the
   pre-wrap whitespace of the surrounding bubble is preserved. */
const CitationLink = styled.button`
    background: transparent;
    border: 0;
    color: ${logservTheme.colors.cyanLight};
    cursor: pointer;
    font-family: inherit;
    font-size: inherit;
    line-height: inherit;
    padding: 0 2px;
    margin: 0;
    text-decoration: underline dotted;
    text-decoration-color: ${logservTheme.colors.cyanAccent};
    text-underline-offset: 2px;
    white-space: nowrap;

    &:hover {
        color: ${logservTheme.colors.textActive};
        text-decoration-color: ${logservTheme.colors.textActive};
    }

    &:focus-visible {
        outline: 2px solid ${logservTheme.colors.cyanAccent};
        outline-offset: 2px;
        border-radius: 2px;
    }
`;

/* A "broken" citation — name didn't resolve to a toolUseId. Rendered as
   muted plain text instead of a button so the user sees the AI's intent
   but doesn't get a non-functional click target. */
const CitationFallback = styled.span`
    color: ${logservTheme.colors.textMuted};
    opacity: 0.7;
    font-size: 0.95em;
`;

/* Sibling "Open dashboard ↗" link rendered next to the `[→ logserv_xxx]`
   citation when the cited saved-search has a related-dashboard mapping in
   `SAVED_SEARCH_DASHBOARDS`. Same visual language as CitationLink (cyan-
   light + dotted underline) but renders as an <a> so the click opens the
   dashboard in a new tab. Multi-dashboard prompts produce one chip per
   slug, separated by hairspaces. Build 156 / session 027. */
const DashboardChip = styled.a`
    background: transparent;
    border: 0;
    color: ${logservTheme.colors.cyanLight};
    cursor: pointer;
    font-family: inherit;
    font-size: 0.9em;
    line-height: inherit;
    padding: 0 2px;
    margin: 0 0 0 4px;
    text-decoration: underline dotted;
    text-decoration-color: ${logservTheme.colors.cyanAccent};
    text-underline-offset: 2px;
    white-space: nowrap;

    &:hover {
        color: ${logservTheme.colors.textActive};
        text-decoration-color: ${logservTheme.colors.textActive};
    }

    &:focus-visible {
        outline: 2px solid ${logservTheme.colors.cyanAccent};
        outline-offset: 2px;
        border-radius: 2px;
    }
`;

/* Severity dot — small colored circle rendered inline next to a finding's
   alpha letter, signaling operational impact. Each dot has a radial
   gradient (highlight at top-left, base mid-tone, darker edge) so it
   reads as a glossy bead instead of a flat circle — same visual character
   as the donut-chart segments in the brief image. Color gradient mirrors
   the warm heat-map palette: yellow (low) → orange (medium) → red (high)
   → dark-red (critical). Build 148, gradient refresh build 149. */
/** Mode-resolved glossy severity bead (Phase 4 / build 258): base colors
 *  come from the sentiment tokens (critical=redSevere, high=red,
 *  medium=redLight, low=yellow) and the 3-stop gloss is computed via
 *  lighten/darken — SEVERITY dots follow the palette in both modes.
 *  Rendered as a COMPONENT (not a bare styled.span) so the text-marker
 *  parser below can keep creating elements without threading tokens. */
const SeverityDotSpan = styled.span<{ $grad: string }>`
    display: inline-block;
    width: 12px;
    height: 12px;
    border-radius: 50%;
    background: ${(p) => p.$grad};
    margin: 0 6px 0 2px;
    /* Sit on the text baseline rather than top-aligning. */
    vertical-align: middle;
    /* Don't expand line height — the dot fits within the surrounding
       text's leading. */
    flex-shrink: 0;
`;

interface SeverityDotProps {
    $level: string;
    'aria-label'?: string;
    title?: string;
}

const SeverityDot: React.FC<SeverityDotProps> = ({ $level, title, ...rest }) => {
    const { tokens } = useThemeMode();
    const base =
        $level === 'critical' ? tokens.redSevere :
        $level === 'high' ? tokens.red :
        $level === 'medium' ? tokens.redLight :
        $level === 'low' ? tokens.yellow : null;
    const grad = base
        ? `radial-gradient(circle at 35% 30%, ${lighten(base, 0.35)} 0%, ${base} 55%, ${darken(base, 0.45)} 100%)`
        : logservTheme.colors.textMuted;
    return <SeverityDotSpan $grad={grad} title={title} aria-label={rest['aria-label']} />;
};

/* Combined parser pattern — three alternatives in priority order, with
   numbered capture groups (TS target is < ES2018, no named groups):
     - group 1 (citation): `[→ logserv_xxx]` or `[-> logserv_xxx]`
     - group 2 (severity): `[severity:critical|high|medium|low]`
     - group 3 (bold):     `**text**` (markdown-bold marker — stripped, inner text kept)
   Build 148 — extends the build-146 citation parser. */
const TEXT_PATTERN = /\[(?:→|->)\s*([a-zA-Z0-9_:.\-]+)\]|\[severity:(critical|high|medium|low)\]|\*\*([^*]+)\*\*/g;

/**
 * Parse free-form text into a flat array of strings and citation-link
 * React nodes. Plain text segments are returned verbatim (whitespace
 * preserved); citation matches are turned into clickable <CitationLink>
 * when the name resolves via citationLookup, or muted fallback spans
 * when it doesn't.
 *
 * Used by the `assistant_text` branch (build 146) AND the `guidance`
 * branch's interpretation paragraph + plain-string next-step entries
 * (build 146 follow-up). Skipped inside `{text, url}` next-step entries
 * because those are already navigation links — nesting a button-citation
 * inside a parent <a> is invalid HTML.
 */
function renderTextWithCitations(
    text: string | undefined,
    citationLookup?: Map<string, { toolUseId: string; splUrl?: string }>,
    onJumpToResult?: (toolUseId: string) => void,
): React.ReactNode[] {
    if (!text) return [];
    const nodes: React.ReactNode[] = [];
    let lastIndex = 0;
    let match: RegExpExecArray | null;
    let key = 0;

    // Reset regex state — module-level TEXT_PATTERN has the /g flag
    // and would otherwise carry state across calls.
    TEXT_PATTERN.lastIndex = 0;

    while ((match = TEXT_PATTERN.exec(text)) !== null) {
        if (match.index > lastIndex) {
            nodes.push(text.slice(lastIndex, match.index));
        }
        // Disambiguate by which numbered group matched (only one alternative
        // fires per match). Group order: 1=citation, 2=severity, 3=bold.
        const citationName = match[1];
        const severityLevel = match[2];
        const boldInner = match[3];

        if (citationName) {
            // [→ logserv_xxx] — clickable scroll-to-tile link
            const entry = citationLookup?.get(citationName);
            const toolUseId = entry?.toolUseId;
            if (toolUseId && onJumpToResult) {
                nodes.push(
                    <CitationLink
                        key={`cite-${key++}`}
                        type="button"
                        onClick={() => onJumpToResult(toolUseId)}
                        title={`Jump to ${citationName} in the right pane`}
                    >
                        → {citationName}
                    </CitationLink>,
                );
            } else {
                nodes.push(
                    <CitationFallback key={`cite-${key++}`}>[→ {citationName}]</CitationFallback>,
                );
            }
            // Build 156 — auto-append sibling "Open dashboard ↗" link(s)
            // when the cited saved-search has a related-dashboard mapping
            // in the intent map. Multi-dashboard prompts emit one chip
            // per slug. The lookup is keyed by saved-search name; ad-hoc
            // SPL or unrecognized names produce no chip.
            const dashSlugs = SAVED_SEARCH_DASHBOARDS[citationName];
            if (dashSlugs) {
                const links = resolveDashboardLinks(dashSlugs);
                for (const d of links) {
                    nodes.push(
                        <DashboardChip
                            key={`dash-${key++}`}
                            href={d.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            title={`Open ${d.name} in a new tab`}
                        >
                            ↗ {d.name}
                        </DashboardChip>,
                    );
                }
            }
            // Build 172 — auto-append sibling "↗ Run SPL" chip after the
            // dashboard chips when the citation lookup carries an splUrl
            // for this displayName. Same visual idiom as DashboardChip
            // (cyan-light + dotted underline + ↗ glyph). The URL was
            // pre-built at the AIAssistant.tsx layer using the dispatch's
            // exact earliest/latest, so the user lands in Splunk Search
            // at the same time window the AI just queried.
            if (entry?.splUrl) {
                nodes.push(
                    <DashboardChip
                        key={`spl-${key++}`}
                        href={entry.splUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        title="Open this SPL in Splunk's Search app (new tab)"
                    >
                        ↗ Run SPL
                    </DashboardChip>,
                );
            }
        } else if (severityLevel) {
            // [severity:LEVEL] — colored impact dot. Build 148.
            nodes.push(
                <SeverityDot
                    key={`sev-${key++}`}
                    $level={severityLevel}
                    aria-label={`Severity: ${severityLevel}`}
                    title={`Severity: ${severityLevel}`}
                />,
            );
        } else if (boldInner) {
            // **text** — strip the markdown-bold marker AND recursively
            // re-parse the inner content so any nested severity / citation
            // markers (e.g. when the AI drifts and emits
            // `**[severity:medium]**`) still resolve to colored dots and
            // clickable chips instead of being rendered as literal text.
            // Build 148 added the bold-strip; build 174 added the
            // recursive re-parse to catch nested markers introduced by
            // model drift (observed mid-response on long top-N answers
            // where findings A-C rendered correctly but D+ wrapped their
            // severity markers in bold).
            //
            // Save + restore the regex's lastIndex around the recursive
            // call because TEXT_PATTERN is module-scoped and
            // /g-stateful — a recursive parse advances lastIndex, which
            // would corrupt the outer loop's iteration if not restored.
            const savedIdx = TEXT_PATTERN.lastIndex;
            const innerNodes = renderTextWithCitations(
                boldInner,
                citationLookup,
                onJumpToResult,
            );
            for (const n of innerNodes) {
                nodes.push(n);
            }
            TEXT_PATTERN.lastIndex = savedIdx;
        }
        lastIndex = TEXT_PATTERN.lastIndex;
    }
    if (lastIndex < text.length) {
        nodes.push(text.slice(lastIndex));
    }
    return nodes.length > 0 ? nodes : [text];
}

const ChatMessage: React.FC<ChatMessageProps> = ({ message, onJumpToResult, citationLookup }) => {
    const [splExpanded, setSplExpanded] = useState<boolean>(true);

    if (message.kind === 'user') {
        return <Bubble $align="right">{message.text}</Bubble>;
    }
    if (message.kind === 'assistant_text') {
        // Build 146 — parse `[→ logserv_xxx]` citations in the AI's
        // narrative and render them as clickable scroll-to-tile spans.
        // Falls back to raw text rendering when no citations are present
        // or no lookup is provided.
        return (
            <AssistantBlock>
                <Bubble $align="left">
                    {renderTextWithCitations(message.text, citationLookup, onJumpToResult)}
                </Bubble>
                <AIDisclaimer>AI-generated — verify before acting.</AIDisclaimer>
            </AssistantBlock>
        );
    }
    if (message.kind === 'system_notice') {
        return <SystemNoticeLine>{message.text}</SystemNoticeLine>;
    }
    if (message.kind === 'guidance' && message.guidance) {
        const { interpretation, nextSteps } = message.guidance;
        // Build 146 follow-up — guidance cards now also support inline
        // `[→ logserv_xxx]` citations in:
        //   - the interpretation paragraph
        //   - plain-string next-step entries
        // Citations are SKIPPED inside `{text, url}` next-step link entries
        // because those are already wrapped in a navigation <a>; nesting
        // a button-citation inside a parent <a> is invalid HTML and would
        // create competing click targets.
        return (
            <GuidanceCard>
                <GuidanceHeader>How to read this result</GuidanceHeader>
                <GuidanceParagraph>
                    {renderTextWithCitations(interpretation, citationLookup, onJumpToResult)}
                </GuidanceParagraph>
                {nextSteps.length > 0 && (
                    <>
                        <GuidanceSubheader>Suggested next steps</GuidanceSubheader>
                        <GuidanceList>
                            {nextSteps.map((step, i) => {
                                if (typeof step === 'string') {
                                    return (
                                        <li key={i}>
                                            {renderTextWithCitations(
                                                step,
                                                citationLookup,
                                                onJumpToResult,
                                            )}
                                        </li>
                                    );
                                }
                                // Link entry — open Splunk search app in a
                                // new tab with the deep-dive SPL pre-loaded.
                                // Build 141. Citations skipped here (would
                                // collide with the parent <a>).
                                return (
                                    <li key={i}>
                                        <GuidanceLink
                                            href={step.url}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            title="Open this deep-dive search in Splunk (new tab)"
                                        >
                                            {step.text}
                                            <GuidanceLinkArrow aria-hidden>↗</GuidanceLinkArrow>
                                        </GuidanceLink>
                                    </li>
                                );
                            })}
                        </GuidanceList>
                    </>
                )}
            </GuidanceCard>
        );
    }
    if (message.kind === 'tool_call' && message.toolCall) {
        const { toolName, spl } = message.toolCall;
        return (
            <ToolCallCard>
                <ToolCallHeader onClick={() => setSplExpanded((v) => !v)} type="button">
                    <span>
                        <Caret>{splExpanded ? '▼' : '▶'}</Caret>
                        Running: <code>{toolName}</code>
                    </span>
                </ToolCallHeader>
                {splExpanded && spl && <SplBlock>{spl}</SplBlock>}
            </ToolCallCard>
        );
    }
    if (message.kind === 'tool_result' && message.toolResult) {
        return (
            <ToolResultLine
                type="button"
                onClick={() =>
                    onJumpToResult && onJumpToResult(message.toolResult!.toolUseId)
                }
            >
                ✓ Result rendered → (click to jump)
            </ToolResultLine>
        );
    }
    return null;
};

export default ChatMessage;
