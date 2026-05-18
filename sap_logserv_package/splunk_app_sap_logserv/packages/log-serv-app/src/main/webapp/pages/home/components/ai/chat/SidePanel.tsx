import React, { useCallback, useEffect, useRef, useState } from 'react';
import styled from 'styled-components';
import { logservTheme } from '../../../styles/logservTheme';
import AIAssistant from './AIAssistant';

/**
 * SidePanel — docked AI Assistant.
 *
 * Per design §6.2 (refined session 016 task 4): the entry point lives in
 * the top NavigationBar (next to the time range picker), not as a fixed
 * right-edge vertical strip. The strip was obscuring the dashboard's
 * right edge — see screenshot in session memory.
 *
 *   - When `expanded === false`: renders nothing
 *   - When `expanded === true`: 600px-wide overlay (does NOT shift the
 *     dashboard content, sits on top); resizable via drag handle, range
 *     320–1200 px
 *   - Width persists across sessions via sessionStorage; expanded state
 *     persists too so a page refresh keeps the panel where it was
 *   - Conversation persists in-memory (cleared on tab close)
 *   - Per-user persistence is Phase G (Splunk user-prefs)
 */

const DEFAULT_EXPANDED_WIDTH = 600;
const MIN_EXPANDED_WIDTH = 320;
/** Hard ceiling, used when window.innerWidth is unavailable (SSR / tests).
 *  Most of the time the runtime cap is `window.innerWidth - PANEL_LEFT_MARGIN`
 *  so the user can drag the panel to fill almost the whole viewport. */
const MAX_EXPANDED_WIDTH_FALLBACK = 2400;
/** Minimum gap on the left side so the user can always grab the dashboard /
 *  app nav even when the panel is at maximum width. */
const PANEL_LEFT_MARGIN = 80;

const computeMaxWidth = (): number => {
    try {
        if (typeof window !== 'undefined' && window.innerWidth) {
            return Math.max(MIN_EXPANDED_WIDTH, window.innerWidth - PANEL_LEFT_MARGIN);
        }
    } catch (_e) { /* ignore */ }
    return MAX_EXPANDED_WIDTH_FALLBACK;
};

const SESSION_KEY_WIDTH = 'logserv.aiAssistant.sidePanel.width';

const Strip = styled.aside<{ $width: number }>`
    position: fixed;
    top: 84px; /* below Splunk Web's app-name bar; ~Phase G refines */
    right: 0;
    bottom: 0;
    width: ${(p) => p.$width}px;
    background: ${logservTheme.colors.panelBackground};
    border-left: 1px solid ${logservTheme.colors.panelBorder};
    z-index: 1000;
    display: flex;
    flex-direction: column;
    box-shadow: -4px 0 12px rgba(0, 0, 0, 0.5);
`;

const ResizeHandle = styled.div`
    position: absolute;
    left: 0;
    top: 0;
    bottom: 0;
    width: 5px;
    cursor: ew-resize;
    background: transparent;

    &:hover { background: ${logservTheme.colors.cyanAccent}; opacity: 0.5; }
`;

const HeaderBar = styled.div`
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: ${logservTheme.spacing.sm} ${logservTheme.spacing.md};
    border-bottom: 1px solid ${logservTheme.colors.panelBorderWeak};
    background: ${logservTheme.colors.tableHeaderBackground};
`;

const HeaderTitle = styled.span`
    color: ${logservTheme.colors.textActive};
    font-size: ${logservTheme.fontSize.body};
    font-weight: ${logservTheme.fontWeight.semibold};
`;

const HeaderButton = styled.button`
    background: transparent;
    border: 0;
    color: ${logservTheme.colors.textMuted};
    cursor: pointer;
    font-size: ${logservTheme.fontSize.body};
    padding: 4px 8px;
    font-family: inherit;

    &:hover { color: ${logservTheme.colors.textActive}; }
`;

const ContentSlot = styled.div`
    flex: 1 1 auto;
    /* min-height of 0 lets this flex child shrink below its content
     * size, which is what enables an inner overflow:auto (or the inner
     * AIAssistant ChatScroll) to actually take over scrolling. Without
     * this, a flex item defaults to min-height: auto (i.e. content
     * size), the slot refuses to shrink, and any overflow leaks past
     * the panel — wheel events then hit the page beneath instead of
     * scrolling the panel. Combined with overflow: auto here, this
     * acts as a safety net: if AIAssistant ever renders content too
     * tall to fit (e.g. the user zooms in heavily), the panel itself
     * scrolls rather than swallowing the gesture. */
    min-height: 0;
    overflow: auto;
`;

const readNumberFromSession = (key: string, fallback: number): number => {
    try {
        const v = window.sessionStorage.getItem(key);
        if (v === null) return fallback;
        const n = Number(v);
        if (!Number.isFinite(n)) return fallback;
        return n;
    } catch (_e) { /* ignore */ }
    return fallback;
};

const writeToSession = (key: string, value: string): void => {
    try {
        window.sessionStorage.setItem(key, value);
    } catch (_e) { /* ignore */ }
};

interface SidePanelProps {
    /** Tier from config (passed through to AIAssistant for the banner). */
    tier?: 0 | 1 | 2;
    /** When false, AIAssistant bypasses the MCP health gate (chat-only mode). */
    mcpRequired?: boolean;
    /** Per-user free-form prompt rate limit (rolling 1-hour window).
     *  0 = disabled. Threaded through to AIAssistant → useAIAssistant.
     *  Build 80 / session 019. */
    rateLimitPerHour?: number;
    /** Per-chat-session cap on total MCP tool dispatches. 0 = disabled.
     *  Threaded through to AIAssistant → useAIAssistant. Build 88. */
    toolCallsPerSessionCap?: number;
    /** Per-user daily vendor spend cap in USD. 0 = disabled.
     *  Threaded through to AIAssistant → useAIAssistant. Build 89. */
    dailySpendCapUsd?: number;
    /** Tier 2 PII column redaction. When true (default), Tier 2
     *  categorical aggregates redact identifier-class column values.
     *  Threaded through to AIAssistant → useAIAssistant. Build 94. */
    tier2PiiRedaction?: boolean;
    /** When true, also redact host / hostname columns. Default false.
     *  Build 94 / session 022. */
    tier2RedactHostnames?: boolean;
    /** CSV of Splunk role names whose members see the Power Mode toggle.
     *  Build 166 / session 028. */
    powerUserRoles?: string;
    /** Runtime templates-only mode. Threaded through to AIAssistant.
     *  Replaces the prior compile-time TEMPLATES_ONLY build flag. */
    templatesOnlyMode?: boolean;
    /** Whether the panel is open. Owned by parent (AppShell). */
    expanded: boolean;
    /** Called when the user clicks the close button in the panel header. */
    onClose: () => void;
}

const SidePanel: React.FC<SidePanelProps> = ({
    tier = 1,
    mcpRequired = true,
    rateLimitPerHour = 30,
    toolCallsPerSessionCap = 100,
    dailySpendCapUsd = 50.0,
    tier2PiiRedaction = true,
    tier2RedactHostnames = false,
    powerUserRoles = '',
    templatesOnlyMode = false,
    expanded,
    onClose,
}) => {
    const [width, setWidth] = useState<number>(() =>
        readNumberFromSession(SESSION_KEY_WIDTH, DEFAULT_EXPANDED_WIDTH),
    );

    const dragStartRef = useRef<{ startX: number; startWidth: number } | null>(null);

    const setWidthAndPersist = useCallback((next: number): void => {
        const clamped = Math.max(MIN_EXPANDED_WIDTH, Math.min(computeMaxWidth(), next));
        setWidth(clamped);
        writeToSession(SESSION_KEY_WIDTH, String(clamped));
    }, []);

    // Keep the panel within bounds when the browser window itself shrinks.
    useEffect(() => {
        if (typeof window === 'undefined') return undefined;
        const onResize = (): void => {
            const max = computeMaxWidth();
            setWidth((current) => (current > max ? max : current));
        };
        window.addEventListener('resize', onResize);
        return () => window.removeEventListener('resize', onResize);
    }, []);

    const onMouseDownResize = useCallback(
        (e: React.MouseEvent): void => {
            dragStartRef.current = { startX: e.clientX, startWidth: width };
            e.preventDefault();

            const onMove = (ev: MouseEvent): void => {
                const start = dragStartRef.current;
                if (!start) return;
                const delta = start.startX - ev.clientX; // dragging left grows width
                setWidthAndPersist(start.startWidth + delta);
            };
            const onUp = (): void => {
                dragStartRef.current = null;
                window.removeEventListener('mousemove', onMove);
                window.removeEventListener('mouseup', onUp);
            };
            window.addEventListener('mousemove', onMove);
            window.addEventListener('mouseup', onUp);
        },
        [width, setWidthAndPersist],
    );

    useEffect(() => {
        // Cleanup any dangling listeners if the panel unmounts mid-drag.
        return () => {
            dragStartRef.current = null;
        };
    }, []);

    if (!expanded) return null;

    return (
        <Strip $width={width}>
            <ResizeHandle onMouseDown={onMouseDownResize} aria-label="Resize panel" />
            <HeaderBar>
                <HeaderTitle>AI Assistant</HeaderTitle>
                <HeaderButton
                    type="button"
                    onClick={onClose}
                    aria-label="Close AI Assistant"
                >
                    ✕
                </HeaderButton>
            </HeaderBar>
            <ContentSlot>
                <AIAssistant tier={tier} mcpRequired={mcpRequired} rateLimitPerHour={rateLimitPerHour} toolCallsPerSessionCap={toolCallsPerSessionCap} dailySpendCapUsd={dailySpendCapUsd} tier2PiiRedaction={tier2PiiRedaction} tier2RedactHostnames={tier2RedactHostnames} powerUserRoles={powerUserRoles} templatesOnlyMode={templatesOnlyMode} />
            </ContentSlot>
        </Strip>
    );
};

export default SidePanel;
