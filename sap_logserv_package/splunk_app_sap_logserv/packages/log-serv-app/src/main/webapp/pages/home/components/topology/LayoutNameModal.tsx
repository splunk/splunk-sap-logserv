import React, { useEffect, useRef, useState } from 'react';
import styled from 'styled-components';
import { logservTheme } from '../../styles/logservTheme';
import { slugifyLayoutName } from '../../topology/persistence';

/**
 * Modal that prompts the admin for a name when saving a topology layout.
 *
 * Behavior:
 *   - Autofocuses the text input on open.
 *   - Live-derives the slug as the user types and checks it against the
 *     existing-slugs set passed by the parent. When the slug matches an
 *     existing layout, the Submit button switches to "Overwrite" with a
 *     warning hint.
 *   - Submit on Enter; Cancel on Escape OR clicking the backdrop.
 *   - Trims whitespace before submit; blocks empty-after-trim names.
 *
 * Build 121 / session 024 path A.4.
 */

interface LayoutNameModalProps {
    open: boolean;
    /** Default value for the input — usually the current layout name. */
    defaultValue?: string;
    /** Existing layout slugs for overwrite detection. */
    existingSlugs: Set<string>;
    /** Called when user submits a valid name. */
    onSubmit: (name: string) => void;
    /** Called when user clicks Cancel, presses Escape, or clicks the backdrop. */
    onCancel: () => void;
}

const Backdrop = styled.div`
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.6);
    z-index: 9000;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
`;

const Dialog = styled.div`
    background: ${logservTheme.colors.panelBackground};
    border: 1px solid ${logservTheme.colors.cyanAccent};
    border-radius: ${logservTheme.radius.small};
    width: 100%;
    max-width: 460px;
    color: ${logservTheme.colors.textActive};
    font-family: inherit;
    display: flex;
    flex-direction: column;
`;

const Header = styled.div`
    padding: 14px 18px 10px;
    border-bottom: 1px solid ${logservTheme.colors.panelBorderWeak};
`;

const Title = styled.h3`
    margin: 0;
    font-size: ${logservTheme.fontSize.large};
    font-weight: ${logservTheme.fontWeight.semibold};
`;

const Body = styled.div`
    padding: 16px 18px;
    display: flex;
    flex-direction: column;
    gap: 10px;
`;

const FieldLabel = styled.label`
    font-size: ${logservTheme.fontSize.small};
    color: ${logservTheme.colors.textMuted};
    text-transform: uppercase;
    letter-spacing: 0.5px;
`;

const Input = styled.input`
    background: ${logservTheme.colors.tableHeaderBackground};
    color: ${logservTheme.colors.textActive};
    border: 1px solid ${logservTheme.colors.panelBorderWeak};
    border-radius: ${logservTheme.radius.small};
    padding: 8px 10px;
    font-family: inherit;
    font-size: ${logservTheme.fontSize.body};

    &:focus {
        outline: none;
        border-color: ${logservTheme.colors.cyanAccent};
    }
`;

const Hint = styled.div<{ $tone: 'muted' | 'warn' | 'error' }>`
    font-size: ${logservTheme.fontSize.small};
    min-height: 14px;
    color: ${(p) =>
        p.$tone === 'warn'
            ? logservTheme.colors.orange
            : p.$tone === 'error'
              ? logservTheme.colors.red
              : logservTheme.colors.textMuted};
`;

const Footer = styled.div`
    padding: 12px 18px;
    border-top: 1px solid ${logservTheme.colors.panelBorderWeak};
    display: flex;
    justify-content: flex-end;
    gap: 8px;
`;

const Button = styled.button<{ $variant?: 'primary' | 'warn' }>`
    background: ${(p) =>
        p.$variant === 'warn'
            ? logservTheme.colors.orange
            : p.$variant === 'primary'
              ? logservTheme.colors.cyanAccent
              : 'transparent'};
    color: ${logservTheme.colors.textActive};
    border: 1px solid ${(p) =>
        p.$variant === 'warn'
            ? logservTheme.colors.orange
            : p.$variant === 'primary'
              ? logservTheme.colors.cyanAccent
              : logservTheme.colors.panelBorderWeak};
    border-radius: ${logservTheme.radius.small};
    padding: 6px 14px;
    font-size: ${logservTheme.fontSize.small};
    font-weight: ${logservTheme.fontWeight.semibold};
    font-family: inherit;
    cursor: pointer;

    &:hover {
        background: ${(p) =>
            p.$variant === 'warn'
                ? logservTheme.colors.orange
                : p.$variant === 'primary'
                  ? logservTheme.colors.cyanLight
                  : logservTheme.colors.hoverBackground};
    }

    &:disabled {
        opacity: 0.45;
        cursor: not-allowed;
    }

    &:focus {
        outline: 2px solid ${logservTheme.colors.cyanAccent};
        outline-offset: -2px;
    }
`;

const LayoutNameModal: React.FC<LayoutNameModalProps> = ({
    open,
    defaultValue,
    existingSlugs,
    onSubmit,
    onCancel,
}) => {
    const [name, setName] = useState<string>(defaultValue ?? '');
    const inputRef = useRef<HTMLInputElement>(null);

    // Reset local state every time the modal opens.
    useEffect(() => {
        if (open) {
            setName(defaultValue ?? '');
            // Defer focus until after the dialog mounts.
            setTimeout(() => inputRef.current?.focus(), 0);
        }
    }, [open, defaultValue]);

    // Close on Escape.
    useEffect(() => {
        if (!open) return undefined;
        const onKey = (e: KeyboardEvent): void => {
            if (e.key === 'Escape') onCancel();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [open, onCancel]);

    if (!open) return null;

    const trimmed = name.trim();
    const slug = slugifyLayoutName(trimmed);
    const willOverwrite = !!slug && existingSlugs.has(slug);
    const validName = !!slug;

    const submit = (): void => {
        if (!validName) return;
        onSubmit(trimmed);
    };

    const onKeyDown = (e: React.KeyboardEvent): void => {
        if (e.key === 'Enter' && validName) {
            e.preventDefault();
            submit();
        }
    };

    return (
        <Backdrop role="dialog" aria-modal="true" aria-label="Save layout" onClick={onCancel}>
            <Dialog onClick={(e) => e.stopPropagation()}>
                <Header>
                    <Title>{willOverwrite ? 'Overwrite layout?' : 'Save layout'}</Title>
                </Header>
                <Body>
                    <FieldLabel htmlFor="layout-name-input">Layout name</FieldLabel>
                    <Input
                        id="layout-name-input"
                        ref={inputRef}
                        type="text"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        onKeyDown={onKeyDown}
                        maxLength={60}
                        placeholder="e.g. HANA tenant overview"
                    />
                    <Hint $tone={willOverwrite ? 'warn' : !validName && trimmed.length > 0 ? 'error' : 'muted'}>
                        {willOverwrite
                            ? `A layout named "${trimmed}" already exists. Saving will overwrite it.`
                            : !validName && trimmed.length > 0
                              ? 'Name must contain at least one alphanumeric character.'
                              : slug
                                ? `Stored as "${slug}".`
                                : 'Up to 60 characters.'}
                    </Hint>
                </Body>
                <Footer>
                    <Button type="button" onClick={onCancel}>Cancel</Button>
                    <Button
                        type="button"
                        $variant={willOverwrite ? 'warn' : 'primary'}
                        onClick={submit}
                        disabled={!validName}
                    >
                        {willOverwrite ? 'Overwrite' : 'Save'}
                    </Button>
                </Footer>
            </Dialog>
        </Backdrop>
    );
};

export default LayoutNameModal;
