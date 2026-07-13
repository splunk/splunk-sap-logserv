import React, { useCallback, useEffect, useRef, useState } from 'react';
import styled from 'styled-components';
import { useCloudProvider, CloudProvider } from '../state/CloudProviderProvider';
import { logservTheme } from '../styles/logservTheme';

/**
 * CloudProviderPicker — title-row dropdown for the global cloud-provider
 * filter (session 082). Renders in DashboardLayout's ActionsBlock, to the
 * LEFT of RefreshIntervalPicker, on every dashboard except Multi-Cloud
 * Overview / Environment Topology / Settings (they set noCloudFilter).
 *
 * Reads/writes the app-wide selection via CloudProviderProvider (one
 * choice applies everywhere, persisted per user). Options: All / aws /
 * azure / gcp. When a specific provider is active the button carries the
 * accent border (a filter is in effect), matching the RefreshIntervalPicker
 * "auto-on" affordance so the two controls read as one coherent strip.
 */

interface Option {
    label: string;
    value: CloudProvider;
}

const OPTIONS: Option[] = [
    { label: 'All', value: 'all' },
    { label: 'aws', value: 'aws' },
    { label: 'azure', value: 'azure' },
    { label: 'gcp', value: 'gcp' },
];

const labelFor = (p: CloudProvider): string => {
    const opt = OPTIONS.find((o) => o.value === p);
    return opt ? opt.label : p;
};

const Wrapper = styled.div`
    position: relative;
    display: inline-flex;
    align-items: center;
`;

const PickerButton = styled.button<{ $active: boolean; $filtered: boolean }>`
    background: ${(p) => (p.$active ? logservTheme.colors.hoverBackground : 'transparent')};
    color: ${(p) =>
        p.$active || p.$filtered ? logservTheme.colors.cyanLight : logservTheme.colors.textActive};
    border: 1px solid
        ${(p) =>
            p.$active || p.$filtered
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
`;

const Caret = styled.span`
    margin-left: 2px;
`;

const Menu = styled.div`
    position: absolute;
    top: calc(100% + 4px);
    right: 0;
    min-width: 140px;
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

const CloudProviderPicker: React.FC = () => {
    const { provider, setProvider } = useCloudProvider();
    const [open, setOpen] = useState<boolean>(false);
    const wrapperRef = useRef<HTMLDivElement | null>(null);

    // Close on outside click / escape — matches RefreshIntervalPicker.
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
        (value: CloudProvider) => () => {
            setProvider(value);
            setOpen(false);
        },
        [setProvider],
    );

    const filtered = provider !== 'all';

    return (
        <Wrapper ref={wrapperRef}>
            <PickerButton
                type="button"
                onClick={() => setOpen((v) => !v)}
                $active={open}
                $filtered={filtered}
                aria-haspopup="menu"
                aria-expanded={open}
                aria-label={`Cloud provider filter: ${labelFor(provider)}`}
                title={
                    filtered
                        ? `Filtering all dashboards to cloud provider "${labelFor(provider)}" — click to change`
                        : 'Cloud provider: showing all providers — click to filter'
                }
            >
                {`Cloud: ${labelFor(provider)}`}
                <Caret aria-hidden>▾</Caret>
            </PickerButton>
            {open && (
                <Menu role="menu">
                    {OPTIONS.map((opt) => {
                        const selected = opt.value === provider;
                        return (
                            <MenuItem
                                key={opt.value}
                                type="button"
                                role="menuitem"
                                $selected={selected}
                                onClick={handleSelect(opt.value)}
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

export default CloudProviderPicker;
