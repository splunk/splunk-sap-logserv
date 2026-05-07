import React, { useCallback, useEffect, useRef, useState } from 'react';
import styled from 'styled-components';
import { useRefreshContext } from '../state/RefreshProvider';
import { logservTheme } from '../styles/logservTheme';

/**
 * RefreshIntervalPicker — title-row dropdown that lets the user pick a
 * per-dashboard auto-refresh cadence (build 155 / session 027). Reads /
 * writes via the surrounding `RefreshProvider`; one record per
 * (user, dashboard_id) is persisted to KV Store under collection
 * `logserv_dashboard_refresh`.
 *
 * Options: Never / 30s / 1m / 5m / 15m / 30m / 1hr.
 *
 * Visual design: matches `ActionsDropdown` in the global NavigationBar so
 * the right-edge title-row cluster (HostDetails picker · Refresh
 * dropdown) reads as a coherent control strip. 32 px height, 1 px panel
 * border, cyan-accent on hover/focus, popup menu with the same panel
 * background as the rest of the dashboard chrome. Active interval is
 * pinned to the button label (e.g. "Refresh: 5m") so the current state
 * is visible at a glance without opening the menu.
 *
 * The picker stays disabled while the saved value is hydrating from KV
 * Store (a few hundred ms on first mount per dashboard) — this prevents
 * a "Never → user picks 5m → KV value lands and overwrites to whatever
 * was saved" flicker.
 */

interface Option {
    label: string;
    valueMs: number;
}

const OPTIONS: Option[] = [
    { label: 'Never', valueMs: 0 },
    { label: '30s', valueMs: 30_000 },
    { label: '1m', valueMs: 60_000 },
    { label: '5m', valueMs: 5 * 60_000 },
    { label: '15m', valueMs: 15 * 60_000 },
    { label: '30m', valueMs: 30 * 60_000 },
    { label: '1hr', valueMs: 60 * 60_000 },
];

const labelFor = (ms: number): string => {
    const opt = OPTIONS.find((o) => o.valueMs === ms);
    return opt ? opt.label : `${ms} ms`;
};

const Wrapper = styled.div`
    position: relative;
    display: inline-flex;
    align-items: center;
`;

const PickerButton = styled.button<{ $active: boolean; $autoOn: boolean }>`
    background: ${(p) => (p.$active ? logservTheme.colors.hoverBackground : 'transparent')};
    color: ${(p) =>
        p.$active
            ? logservTheme.colors.cyanLight
            : p.$autoOn
              ? logservTheme.colors.cyanLight
              : logservTheme.colors.textActive};
    border: 1px solid
        ${(p) =>
            p.$active || p.$autoOn
                ? logservTheme.colors.cyanAccent
                : logservTheme.colors.panelBorderWeak};
    border-radius: ${logservTheme.radius.small};
    box-sizing: border-box;
    height: 32px;
    padding: 0 12px;
    align-self: center;
    cursor: pointer;
    font-size: ${logservTheme.fontSize.body};
    font-weight: ${logservTheme.fontWeight.semibold};
    font-family: inherit;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    transition: background-color 80ms ease-out, border-color 80ms ease-out, color 80ms ease-out;

    &:hover:not(:disabled) {
        background: ${logservTheme.colors.hoverBackground};
        border-color: ${logservTheme.colors.cyanAccent};
    }

    &:focus {
        outline: 2px solid ${logservTheme.colors.cyanAccent};
        outline-offset: -2px;
    }

    &:disabled {
        opacity: 0.6;
        cursor: not-allowed;
    }
`;

const Caret = styled.span`
    margin-left: 2px;
`;

const Menu = styled.div`
    position: absolute;
    top: calc(100% + 4px);
    right: 0;
    min-width: 160px;
    background: ${logservTheme.colors.panelBackground};
    border: 1px solid ${logservTheme.colors.panelBorder};
    border-radius: ${logservTheme.radius.small};
    box-shadow: 0 6px 16px rgba(0, 0, 0, 0.5);
    z-index: 1000;
    padding: 4px 0;
`;

const MenuItem = styled.button<{ $selected: boolean }>`
    background: ${(p) => (p.$selected ? logservTheme.colors.hoverBackground : 'transparent')};
    border: none;
    color: ${(p) => (p.$selected ? logservTheme.colors.cyanLight : logservTheme.colors.textActive)};
    font-family: inherit;
    font-size: ${logservTheme.fontSize.body};
    padding: 8px 12px;
    width: 100%;
    text-align: left;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;

    &:hover:not(:disabled) {
        background: ${logservTheme.colors.hoverBackground};
        color: ${logservTheme.colors.cyanLight};
    }
`;

const Tick = styled.span`
    color: ${logservTheme.colors.cyanLight};
    font-size: 12px;
    line-height: 1;
`;

const Icon = styled.span`
    /* Subtle "auto-refresh" glyph — the pulsing dot is purely decorative
     * (CSS animation, no JS) so it doesn't add to the React render budget. */
    display: inline-block;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: ${logservTheme.colors.cyanLight};
    box-shadow: 0 0 6px ${logservTheme.colors.cyanLight};
    animation: refresh-pulse 1500ms ease-in-out infinite;

    @keyframes refresh-pulse {
        0%, 100% { opacity: 0.4; transform: scale(0.85); }
        50% { opacity: 1; transform: scale(1); }
    }
`;

const RefreshIntervalPicker: React.FC = () => {
    const { intervalMs, setIntervalMs, loading } = useRefreshContext();
    const [open, setOpen] = useState<boolean>(false);
    const wrapperRef = useRef<HTMLDivElement | null>(null);

    // Close on outside click / escape — matches ActionsDropdown.
    useEffect(() => {
        if (!open) return undefined;
        const onDocClick = (e: MouseEvent): void => {
            const node = e.target as Node | null;
            if (wrapperRef.current && node && !wrapperRef.current.contains(node)) {
                setOpen(false);
            }
        };
        const onKey = (e: KeyboardEvent): void => {
            if (e.key === 'Escape') setOpen(false);
        };
        document.addEventListener('mousedown', onDocClick);
        document.addEventListener('keydown', onKey);
        return () => {
            document.removeEventListener('mousedown', onDocClick);
            document.removeEventListener('keydown', onKey);
        };
    }, [open]);

    const handleSelect = useCallback(
        (ms: number) => () => {
            setIntervalMs(ms);
            setOpen(false);
        },
        [setIntervalMs],
    );

    const autoOn = intervalMs > 0;
    const buttonLabel = `Refresh: ${labelFor(intervalMs)}`;

    return (
        <Wrapper ref={wrapperRef}>
            <PickerButton
                type="button"
                onClick={() => setOpen((v) => !v)}
                $active={open}
                $autoOn={autoOn}
                aria-haspopup="menu"
                aria-expanded={open}
                aria-label={`Auto-refresh interval: ${labelFor(intervalMs)}`}
                disabled={loading}
                title={
                    autoOn
                        ? `Auto-refreshing every ${labelFor(intervalMs)} — click to change`
                        : 'Auto-refresh off — click to pick a cadence'
                }
            >
                {autoOn && <Icon aria-hidden />}
                {buttonLabel}
                <Caret aria-hidden>▾</Caret>
            </PickerButton>
            {open && (
                <Menu role="menu">
                    {OPTIONS.map((opt) => {
                        const selected = opt.valueMs === intervalMs;
                        return (
                            <MenuItem
                                key={opt.valueMs}
                                type="button"
                                role="menuitem"
                                $selected={selected}
                                onClick={handleSelect(opt.valueMs)}
                                aria-checked={selected}
                            >
                                <span>{opt.label}</span>
                                {selected && <Tick aria-hidden>✓</Tick>}
                            </MenuItem>
                        );
                    })}
                </Menu>
            )}
        </Wrapper>
    );
};

export default RefreshIntervalPicker;
