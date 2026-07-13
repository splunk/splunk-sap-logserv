import React, { useEffect, useMemo } from 'react';
import styled from 'styled-components';
import { logservTheme } from '../../styles/logservTheme';
import type { LayoutSummary } from '../../topology/persistence';

/**
 * Manage Layouts modal — lets the admin pick a default layout for each
 * layout mode (Force / Layered / Tree). The default auto-loads when the
 * topology view opens OR when the user switches to that mode via the
 * LAYOUT dropdown.
 *
 * Build 216 / session 036 — addresses user direction: "I need a way to
 * manage the saved layouts so that the user can pick a saved layout as
 * the default to load when on the layout type (Force, Layered, Tree)."
 *
 * Behavior:
 *   - One section per mode, each listing all saved layouts whose
 *     `layoutMode === mode` (filtered by the persisted layoutMode field
 *     captured on save in build 215).
 *   - Each section has a "(none)" radio at top + one radio per layout.
 *   - Picking a radio immediately calls onSetDefault — no separate Save
 *     button. Modal stays open for further changes; Close dismisses.
 *   - Layouts saved before build 215 (no `layoutMode` field) are
 *     bucketed under Force per the upstream default-on-load behavior.
 *   - Empty section: "No saved layouts in this mode yet."
 *   - Backdrop click + Escape close the modal.
 */

interface ManageLayoutsModalProps {
    open: boolean;
    layouts: LayoutSummary[];
    /** Currently-active default slug per layout mode; null = no default. */
    defaultSlugs: { force: string | null; layered: string | null; tree: string | null };
    /** Set (or clear if `slug == null`) the default for a mode. */
    onSetDefault: (mode: 'force' | 'layered' | 'tree', slug: string | null) => void;
    /** Build 231 / session 037 — user's explicit "open in this mode by
     *  default" preference. Cross-browser per user (KV Store). null
     *  means no explicit default — the dashboard opens in whatever
     *  mode the user last selected on this browser. Mutex across
     *  modes (only one mode can be the default at a time). */
    defaultMode: 'force' | 'layered' | 'tree' | null;
    /** Set (or clear if `mode == null`) the user's default mode. */
    onSetDefaultMode: (mode: 'force' | 'layered' | 'tree' | null) => void;
    onClose: () => void;
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
    max-width: 640px;
    max-height: 86vh;
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

const Subtitle = styled.div`
    margin-top: 4px;
    font-size: ${logservTheme.fontSize.small};
    color: ${logservTheme.colors.textMuted};
    line-height: 1.4;
`;

const Body = styled.div`
    padding: 14px 18px;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 18px;
`;

const Section = styled.div`
    display: flex;
    flex-direction: column;
    gap: 6px;
`;

const SectionHeader = styled.div`
    display: flex;
    align-items: baseline;
    gap: 8px;
    padding-bottom: 4px;
    border-bottom: 1px solid ${logservTheme.colors.panelBorderWeak};
`;

const SectionName = styled.span`
    font-size: ${logservTheme.fontSize.body};
    font-weight: ${logservTheme.fontWeight.semibold};
    color: ${logservTheme.colors.cyanLight};
`;

const SectionCount = styled.span`
    font-size: 11px;
    color: ${logservTheme.colors.textMuted};
`;

/* Build 231 / session 037 — "Open in this mode by default" checkbox
 * pinned to the right edge of the section header. The checkbox + label
 * are visually paired with the section's other controls so the user
 * understands "this is the default mode AND its default layout below". */
const DefaultModeCheckbox = styled.label`
    margin-left: auto;
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
    color: ${logservTheme.colors.textMuted};
    cursor: pointer;
    user-select: none;

    input[type='checkbox'] {
        cursor: pointer;
        accent-color: ${logservTheme.colors.cyanAccent};
    }

    &:hover {
        color: ${logservTheme.colors.textActive};
    }
`;

const RadioRow = styled.label<{ $checked: boolean; $isNone?: boolean }>`
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 8px;
    border-radius: ${logservTheme.radius.small};
    cursor: pointer;
    background: ${(p) =>
        p.$checked ? logservTheme.colors.tableHeaderBackground : 'transparent'};
    border: 1px solid ${(p) =>
        p.$checked ? logservTheme.colors.cyanAccent : 'transparent'};
    transition: background 80ms ease-out, border-color 80ms ease-out;

    &:hover {
        background: ${logservTheme.colors.hoverBackground};
    }

    input[type="radio"] {
        accent-color: ${logservTheme.colors.cyanAccent};
        cursor: pointer;
    }
`;

const RowName = styled.span<{ $muted?: boolean }>`
    flex: 1;
    font-size: ${logservTheme.fontSize.small};
    color: ${(p) => (p.$muted ? logservTheme.colors.textMuted : logservTheme.colors.textActive)};
    font-style: ${(p) => (p.$muted ? 'italic' : 'normal')};
`;

const RowMeta = styled.span`
    font-size: 10px;
    color: ${logservTheme.colors.textMuted};
    font-variant-numeric: tabular-nums;
`;

const EmptyHint = styled.div`
    font-size: 11px;
    font-style: italic;
    color: ${logservTheme.colors.textMuted};
    padding: 6px 8px;
`;

const Footer = styled.div`
    padding: 10px 18px 14px;
    border-top: 1px solid ${logservTheme.colors.panelBorderWeak};
    display: flex;
    justify-content: flex-end;
    gap: 8px;
`;

const Button = styled.button<{ $primary?: boolean }>`
    background: ${(p) => (p.$primary ? logservTheme.colors.cyanAccent : 'transparent')};
    /* Filled variant gets light text in BOTH modes (Phase-5 sweep) —
       textActive resolves near-black in light mode, unreadable on the fill. */
    color: ${(p) => (p.$primary ? logservTheme.colors.inverseText : logservTheme.colors.textActive)};
    border: 1px solid ${(p) =>
        p.$primary ? logservTheme.colors.cyanAccent : logservTheme.colors.panelBorderWeak};
    border-radius: ${logservTheme.radius.small};
    padding: 6px 14px;
    font-size: ${logservTheme.fontSize.small};
    font-weight: ${logservTheme.fontWeight.semibold};
    font-family: inherit;
    cursor: pointer;

    &:hover {
        background: ${(p) =>
            p.$primary ? logservTheme.colors.cyanAccent : logservTheme.colors.hoverBackground};
        border-color: ${logservTheme.colors.cyanLight};
    }
`;

const formatRelative = (iso: string): string => {
    if (!iso) return '';
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return '';
    const ageSec = Math.max(0, (Date.now() - t) / 1000);
    if (ageSec < 60) return 'just now';
    if (ageSec < 3600) return `${Math.floor(ageSec / 60)}m ago`;
    if (ageSec < 86400) return `${Math.floor(ageSec / 3600)}h ago`;
    return `${Math.floor(ageSec / 86400)}d ago`;
};

interface ModeSectionProps {
    label: string;
    mode: 'force' | 'layered' | 'tree';
    layouts: LayoutSummary[];
    selectedSlug: string | null;
    onSetDefault: (mode: 'force' | 'layered' | 'tree', slug: string | null) => void;
    /** Build 231 — true when this mode is the user's cross-browser
     *  default-mode preference. Toggling the checkbox flips it. */
    isDefaultMode: boolean;
    onToggleDefaultMode: (mode: 'force' | 'layered' | 'tree' | null) => void;
}

const ModeSection: React.FC<ModeSectionProps> = ({
    label,
    mode,
    layouts,
    selectedSlug,
    onSetDefault,
    isDefaultMode,
    onToggleDefaultMode,
}) => {
    const groupName = `default-layout-${mode}`;
    const handleToggle = (): void => {
        onToggleDefaultMode(isDefaultMode ? null : mode);
    };
    return (
        <Section>
            <SectionHeader>
                <SectionName>{label}</SectionName>
                <SectionCount>{layouts.length === 0 ? 'no saved layouts' : `${layouts.length} saved`}</SectionCount>
                <DefaultModeCheckbox>
                    <input
                        type="checkbox"
                        checked={isDefaultMode}
                        onChange={handleToggle}
                        aria-label={`Open in ${label} by default`}
                    />
                    <span>Open in {label} by default</span>
                </DefaultModeCheckbox>
            </SectionHeader>
            <RadioRow $checked={selectedSlug == null} $isNone>
                <input
                    type="radio"
                    name={groupName}
                    checked={selectedSlug == null}
                    onChange={() => onSetDefault(mode, null)}
                />
                <RowName $muted>(no default — fresh layout each time)</RowName>
            </RadioRow>
            {layouts.length === 0 ? (
                <EmptyHint>
                    No saved layouts in {label}. Switch to {label}, arrange the canvas, click Save Layout, then come back here to set it as the default.
                </EmptyHint>
            ) : (
                layouts.map((l) => {
                    const checked = selectedSlug === l.slug;
                    return (
                        <RadioRow key={l.slug} $checked={checked}>
                            <input
                                type="radio"
                                name={groupName}
                                checked={checked}
                                onChange={() => onSetDefault(mode, l.slug)}
                            />
                            <RowName>{l.name}</RowName>
                            <RowMeta>{`saved ${formatRelative(l.savedAt)}`}</RowMeta>
                        </RadioRow>
                    );
                })
            )}
        </Section>
    );
};

const ManageLayoutsModal: React.FC<ManageLayoutsModalProps> = ({
    open,
    layouts,
    defaultSlugs,
    onSetDefault,
    defaultMode,
    onSetDefaultMode,
    onClose,
}) => {
    /* Close on Escape. */
    useEffect(() => {
        if (!open) return undefined;
        const onKey = (e: KeyboardEvent): void => {
            if (e.key === 'Escape') onClose();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [open, onClose]);

    /* Group layouts by mode. Pre-215 layouts (no `layoutMode` field)
     * default to 'force' since that was the only mode at the time those
     * layouts existed in user pockets. */
    const grouped = useMemo(() => {
        const out: Record<'force' | 'layered' | 'tree', LayoutSummary[]> = {
            force: [],
            layered: [],
            tree: [],
        };
        layouts.forEach((l) => {
            const mode = l.layoutMode ?? 'force';
            out[mode].push(l);
        });
        return out;
    }, [layouts]);

    if (!open) return null;
    return (
        <Backdrop onMouseDown={onClose}>
            <Dialog onMouseDown={(e) => e.stopPropagation()}>
                <Header>
                    <Title>Manage saved layouts</Title>
                    <Subtitle>
                        Pick a default layout for each mode. The default loads automatically when
                        you open the topology view or switch to that mode. Tick &quot;Open in this
                        mode by default&quot; on one section to set the dashboard&apos;s startup mode
                        on every browser you log into.
                    </Subtitle>
                </Header>
                <Body>
                    <ModeSection
                        label="Force"
                        mode="force"
                        layouts={grouped.force}
                        selectedSlug={defaultSlugs.force}
                        onSetDefault={onSetDefault}
                        isDefaultMode={defaultMode === 'force'}
                        onToggleDefaultMode={onSetDefaultMode}
                    />
                    <ModeSection
                        label="Layered"
                        mode="layered"
                        layouts={grouped.layered}
                        selectedSlug={defaultSlugs.layered}
                        onSetDefault={onSetDefault}
                        isDefaultMode={defaultMode === 'layered'}
                        onToggleDefaultMode={onSetDefaultMode}
                    />
                    <ModeSection
                        label="Tree"
                        mode="tree"
                        layouts={grouped.tree}
                        selectedSlug={defaultSlugs.tree}
                        onSetDefault={onSetDefault}
                        isDefaultMode={defaultMode === 'tree'}
                        onToggleDefaultMode={onSetDefaultMode}
                    />
                </Body>
                <Footer>
                    <Button type="button" onClick={onClose}>Close</Button>
                </Footer>
            </Dialog>
        </Backdrop>
    );
};

export default ManageLayoutsModal;
