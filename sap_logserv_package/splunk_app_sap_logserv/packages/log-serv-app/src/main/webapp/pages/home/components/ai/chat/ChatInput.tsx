import React, { useCallback, useState } from 'react';
import styled from 'styled-components';
import { logservTheme } from '../../../styles/logservTheme';

interface ChatInputProps {
    onSend: (text: string) => void;
    onAbort?: () => void;
    onOpenPromptBrowser?: () => void;
    /** When true, the input is disabled (streaming or tool-executing). */
    busy?: boolean;
    placeholder?: string;
    /** Power Mode toggle visibility (build 166 / session 028). When
     *  false (default), the toggle is hidden entirely — non-power
     *  users never see it. When true, the toggle renders between the
     *  Send button and the keyboard-shortcut hint. */
    powerModeAvailable?: boolean;
    /** Power Mode toggle state. Ignored when `powerModeAvailable` is false. */
    powerMode?: boolean;
    /** Power Mode toggle change handler. */
    onPowerModeChange?: (on: boolean) => void;
    /** Runtime templates-only mode. When true, input is disabled +
     *  placeholder explains why; Send + Power Mode toggle hidden /
     *  disabled. Replaces compile-time TEMPLATES_ONLY. */
    templatesOnlyMode?: boolean;
}

const Wrapper = styled.div`
    display: flex;
    flex-direction: column;
    gap: ${logservTheme.spacing.xs};
    padding: ${logservTheme.spacing.md};
    border-top: 1px solid ${logservTheme.colors.panelBorderWeak};
    background: ${logservTheme.colors.panelBackground};
`;

const InputRow = styled.div`
    display: flex;
    gap: ${logservTheme.spacing.sm};
    align-items: flex-end;
`;

const TextArea = styled.textarea`
    flex: 1 1 auto;
    background: ${logservTheme.colors.tableHeaderBackground};
    color: ${logservTheme.colors.textActive};
    border: 1px solid ${logservTheme.colors.panelBorderWeak};
    border-radius: ${logservTheme.radius.small};
    padding: ${logservTheme.spacing.sm};
    font-family: inherit;
    font-size: ${logservTheme.fontSize.body};
    resize: vertical;
    min-height: 60px;
    max-height: 240px;
    outline: none;

    &:focus {
        border-color: ${logservTheme.colors.cyanAccent};
    }

    &:disabled {
        opacity: 0.5;
        cursor: not-allowed;
    }
`;

const Button = styled.button<{ $variant?: 'primary' | 'secondary' | 'danger' }>`
    background: ${(p) =>
        p.$variant === 'danger'
            ? logservTheme.colors.red
            : p.$variant === 'secondary'
            ? 'transparent'
            : logservTheme.colors.cyanAccent};
    color: ${(p) =>
        p.$variant === 'secondary' ? logservTheme.colors.textActive : 'white'};
    border: 1px solid
        ${(p) =>
            p.$variant === 'secondary'
                ? logservTheme.colors.panelBorderWeak
                : 'transparent'};
    padding: 8px 14px;
    border-radius: ${logservTheme.radius.small};
    cursor: pointer;
    font-size: ${logservTheme.fontSize.body};
    font-weight: ${logservTheme.fontWeight.semibold};
    font-family: inherit;
    flex-shrink: 0;

    &:disabled {
        opacity: 0.4;
        cursor: not-allowed;
    }

    &:hover:not(:disabled) {
        opacity: 0.9;
    }
`;

const Toolbar = styled.div`
    display: flex;
    gap: ${logservTheme.spacing.sm};
    align-items: center;
`;

const HintText = styled.span`
    color: ${logservTheme.colors.textMuted};
    font-size: ${logservTheme.fontSize.small};
    margin-left: auto;
`;

/** Power Mode toggle (build 166 / session 028). Cyan-accent border + fill
 *  in the ON state to read as "elevated". Renders only when
 *  `powerModeAvailable` is true. The aria-pressed boolean ties the
 *  visual state to assistive tech state queries. */
const PowerToggle = styled.button<{ $on: boolean }>`
    background: ${(p) =>
        p.$on ? logservTheme.colors.cyanAccent : 'transparent'};
    color: ${(p) =>
        p.$on ? '#ffffff' : logservTheme.colors.cyanLight};
    border: 1px solid
        ${(p) =>
            p.$on
                ? logservTheme.colors.cyanLight
                : logservTheme.colors.panelBorderWeak};
    border-radius: ${logservTheme.radius.small};
    padding: 6px 10px;
    cursor: pointer;
    font-size: ${logservTheme.fontSize.small};
    font-weight: ${logservTheme.fontWeight.semibold};
    font-family: inherit;
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    gap: 5px;
    transition: background-color 80ms ease-out, border-color 80ms ease-out, color 80ms ease-out;
    margin-left: auto;

    &:hover:not(:disabled) {
        border-color: ${logservTheme.colors.cyanLight};
        ${(p) =>
            p.$on
                ? ''
                : `background: ${logservTheme.colors.hoverBackground};`}
    }

    &:focus-visible {
        outline: 2px solid ${logservTheme.colors.cyanAccent};
        outline-offset: 2px;
    }

    &:disabled {
        opacity: 0.5;
        cursor: not-allowed;
    }
`;

const ChatInput: React.FC<ChatInputProps> = ({
    onSend,
    onAbort,
    onOpenPromptBrowser,
    busy = false,
    placeholder = 'Ask about LogServ data, or pick a predefined prompt...',
    powerModeAvailable = false,
    powerMode = false,
    onPowerModeChange,
    templatesOnlyMode = false,
}) => {
    const [text, setText] = useState<string>('');

    const handleSend = useCallback((): void => {
        const trimmed = text.trim();
        if (!trimmed || busy) return;
        onSend(trimmed);
        setText('');
    }, [text, busy, onSend]);

    const handleKeyDown = useCallback(
        (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                handleSend();
            }
        },
        [handleSend],
    );

    // Templates-only mode disables free-form input at runtime. The text
    // field becomes disabled with a guiding placeholder, the Send button
    // is unconditionally disabled, and the Power Mode toggle is hidden
    // (forced-RAG is meaningless when there's no LLM call to force a
    // saved search before). The "Browse prompts" button stays enabled —
    // that's the only entry point in this mode.
    const effectivePlaceholder = templatesOnlyMode
        ? 'Templates-only mode — click "Browse predefined prompts" below to run a saved search.'
        : placeholder;
    const inputDisabled = busy || templatesOnlyMode;

    return (
        <Wrapper>
            <InputRow>
                <TextArea
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder={effectivePlaceholder}
                    disabled={inputDisabled}
                    aria-label="Chat input"
                />
            </InputRow>
            <Toolbar>
                {onOpenPromptBrowser && (
                    <Button $variant="secondary" type="button" onClick={onOpenPromptBrowser}>
                        Browse prompts
                    </Button>
                )}
                {busy && onAbort ? (
                    <Button $variant="danger" type="button" onClick={onAbort}>
                        Stop
                    </Button>
                ) : (
                    <Button type="button" onClick={handleSend} disabled={!text.trim() || busy || templatesOnlyMode}>
                        Send
                    </Button>
                )}
                {powerModeAvailable && !templatesOnlyMode && (
                    <PowerToggle
                        $on={powerMode}
                        type="button"
                        onClick={() => onPowerModeChange?.(!powerMode)}
                        disabled={busy}
                        aria-pressed={powerMode}
                        title={
                            powerMode
                                ? 'Power Mode ON — every prompt forces a saved-search dispatch before AI synthesis. Click to turn off.'
                                : 'Power Mode OFF — click to enable forced saved-search-first behavior.'
                        }
                    >
                        <span aria-hidden>✦</span>
                        <span>Power{powerMode ? ' ON' : ''}</span>
                    </PowerToggle>
                )}
                {!templatesOnlyMode && <HintText>⌘/Ctrl+Enter to send</HintText>}
            </Toolbar>
        </Wrapper>
    );
};

export default ChatInput;
