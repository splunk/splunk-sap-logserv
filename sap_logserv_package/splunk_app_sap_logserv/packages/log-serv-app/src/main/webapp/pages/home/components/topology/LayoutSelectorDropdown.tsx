import React, { useEffect, useRef, useState } from 'react';
import styled from 'styled-components';
import { logservTheme } from '../../styles/logservTheme';
import type { LayoutSummary } from '../../topology/persistence';

/**
 * Topology toolbar dropdown that lists the user's saved layouts and
 * lets them load or delete a single layout.
 *
 * Behavior:
 *   - Trigger button shows "Load Layout ▾" (active state when open).
 *   - Popover opens below the trigger, lists layouts sorted by saved_at
 *     desc (the parent passes them already sorted via listLayouts()).
 *   - Each row: layout name + "saved Xm ago" + delete affordance.
 *   - Delete confirms in-place — first click on the × turns the row red
 *     and shows "Confirm" + "Cancel"; second click on Confirm fires
 *     onDelete; clicking Cancel or any other row reverts.
 *   - Loading state shows a single muted line.
 *   - Empty state shows a hint "No saved layouts yet — click Save to add one".
 *   - Click outside closes the popover.
 *   - Currently-loaded layout (matched by slug) is bold.
 *
 * Build 121 / session 024 path A.4.
 */

interface LayoutSelectorDropdownProps {
    layouts: LayoutSummary[];
    loading: boolean;
    /** Slug of the currently-loaded layout (bolded in the list). */
    currentSlug: string | null;
    onSelect: (slug: string) => void;
    onDelete: (slug: string) => void;
    /** Build 216 / session 036 — opens the Manage Layouts modal where
     *  the user picks a default layout for each layout mode. */
    onManage: () => void;
}

const Wrap = styled.div`
    position: relative;
    display: inline-flex;
`;

const Trigger = styled.button<{ $active: boolean }>`
    background: ${(p) => (p.$active ? logservTheme.colors.hoverBackground : 'transparent')};
    color: ${logservTheme.colors.textActive};
    border: 1px solid ${(p) => (p.$active ? logservTheme.colors.cyanAccent : logservTheme.colors.panelBorderWeak)};
    border-radius: ${logservTheme.radius.small};
    padding: 4px 10px;
    font-size: ${logservTheme.fontSize.small};
    font-weight: ${logservTheme.fontWeight.semibold};
    font-family: inherit;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 4px;

    &:hover {
        background: ${logservTheme.colors.hoverBackground};
        border-color: ${logservTheme.colors.cyanAccent};
    }

    &:focus {
        outline: 2px solid ${logservTheme.colors.cyanAccent};
        outline-offset: -2px;
    }
`;

const Popover = styled.div`
    position: absolute;
    right: 0;
    top: calc(100% + 4px);
    min-width: 280px;
    max-width: 340px;
    max-height: 360px;
    overflow-y: auto;
    background: ${logservTheme.colors.panelBackground};
    border: 1px solid ${logservTheme.colors.cyanAccent};
    border-radius: ${logservTheme.radius.small};
    box-shadow: 0 6px 16px rgba(0, 0, 0, 0.4);
    z-index: 1100;
    padding: 4px 0;
`;

const RowList = styled.ul`
    list-style: none;
    margin: 0;
    padding: 0;
`;

const Row = styled.li<{ $confirming: boolean }>`
    display: grid;
    grid-template-columns: 1fr auto;
    align-items: center;
    gap: 4px;
    padding: 6px 10px;
    background: ${(p) => (p.$confirming ? 'rgba(220, 78, 65, 0.12)' : 'transparent')};
    border-bottom: 1px solid ${logservTheme.colors.panelBorderWeak};

    &:last-child {
        border-bottom: none;
    }
`;

const NameButton = styled.button<{ $current: boolean }>`
    background: transparent;
    color: ${(p) => (p.$current ? logservTheme.colors.cyanLight : logservTheme.colors.textActive)};
    border: none;
    text-align: left;
    cursor: pointer;
    font-family: inherit;
    font-size: ${logservTheme.fontSize.body};
    font-weight: ${(p) => (p.$current ? logservTheme.fontWeight.bold : logservTheme.fontWeight.normal)};
    padding: 2px 0;
    display: flex;
    flex-direction: column;
    gap: 2px;

    &:hover {
        color: ${logservTheme.colors.cyanLight};
    }
`;

const RowMeta = styled.span`
    color: ${logservTheme.colors.textMuted};
    font-size: 10px;
`;

const IconButton = styled.button<{ $danger?: boolean }>`
    background: transparent;
    color: ${(p) => (p.$danger ? logservTheme.colors.red : logservTheme.colors.textMuted)};
    border: 1px solid ${(p) => (p.$danger ? logservTheme.colors.red : 'transparent')};
    border-radius: ${logservTheme.radius.small};
    padding: 2px 6px;
    cursor: pointer;
    font-family: inherit;
    font-size: 11px;
    font-weight: ${logservTheme.fontWeight.semibold};

    &:hover {
        background: ${(p) => (p.$danger ? 'rgba(220, 78, 65, 0.18)' : logservTheme.colors.hoverBackground)};
        color: ${(p) => (p.$danger ? logservTheme.colors.red : logservTheme.colors.textActive)};
    }
`;

const ConfirmRow = styled.div`
    display: inline-flex;
    gap: 4px;
`;

const EmptyState = styled.div`
    padding: 14px 12px;
    color: ${logservTheme.colors.textMuted};
    font-size: ${logservTheme.fontSize.small};
    text-align: center;
`;

/* Build 216 / session 036 — top-of-menu Manage Layouts entry. Stays
 * visible regardless of saved-layout count so users can ALWAYS reach
 * the per-mode default-picker. Visually separated from the layout
 * rows below by a 1 px divider. */
const ManageRow = styled.button`
    width: 100%;
    background: transparent;
    color: ${logservTheme.colors.cyanLight};
    border: none;
    border-bottom: 1px solid ${logservTheme.colors.panelBorderWeak};
    cursor: pointer;
    font-family: inherit;
    font-size: ${logservTheme.fontSize.small};
    font-weight: ${logservTheme.fontWeight.semibold};
    text-align: left;
    padding: 8px 12px;
    display: flex;
    align-items: center;
    gap: 6px;

    &:hover {
        background: ${logservTheme.colors.hoverBackground};
        color: ${logservTheme.colors.cyanAccent};
    }

    .gear {
        font-size: 11px;
        opacity: 0.85;
    }
`;

const formatRelative = (iso: string): string => {
    if (!iso) return '';
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return '';
    const delta = Math.floor((Date.now() - t) / 1000);
    if (delta < 0) return 'just now';
    if (delta < 60) return `${delta}s ago`;
    if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
    if (delta < 86400) return `${Math.floor(delta / 3600)}h ago`;
    if (delta < 86400 * 30) return `${Math.floor(delta / 86400)}d ago`;
    return `${Math.floor(delta / 86400 / 30)}mo ago`;
};

const LayoutSelectorDropdown: React.FC<LayoutSelectorDropdownProps> = ({
    layouts,
    loading,
    currentSlug,
    onSelect,
    onDelete,
    onManage,
}) => {
    const [open, setOpen] = useState(false);
    const [confirmingSlug, setConfirmingSlug] = useState<string | null>(null);
    const wrapRef = useRef<HTMLDivElement | null>(null);

    // Click-outside-to-close.
    useEffect(() => {
        if (!open) return undefined;
        const onDocClick = (e: MouseEvent): void => {
            if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
                setOpen(false);
                setConfirmingSlug(null);
            }
        };
        window.addEventListener('mousedown', onDocClick);
        return () => window.removeEventListener('mousedown', onDocClick);
    }, [open]);

    // Reset confirm-state when popover closes.
    useEffect(() => {
        if (!open) setConfirmingSlug(null);
    }, [open]);

    const handleSelect = (slug: string): void => {
        onSelect(slug);
        setOpen(false);
    };

    const handleDeleteClick = (slug: string): void => {
        if (confirmingSlug === slug) {
            // Second click on the same row's × — fire delete.
            onDelete(slug);
            setConfirmingSlug(null);
        } else {
            // First click — switch row to confirm mode.
            setConfirmingSlug(slug);
        }
    };

    return (
        <Wrap ref={wrapRef}>
            <Trigger
                type="button"
                $active={open}
                onClick={() => setOpen((o) => !o)}
                aria-haspopup="listbox"
                aria-expanded={open}
            >
                {`Load Layout ${open ? '▴' : '▾'}`}
            </Trigger>
            {open && (
                <Popover role="listbox">
                    {/* Build 216 / session 036 — Manage Layouts top-of-menu
                      * entry. Always visible. Opens the per-mode default
                      * picker modal. Closes the dropdown on click. */}
                    <ManageRow
                        type="button"
                        onClick={() => {
                            setOpen(false);
                            onManage();
                        }}
                        title="Pick a default layout for each layout mode"
                    >
                        <span className="gear" aria-hidden>{'⚙'}</span>
                        Manage Layouts…
                    </ManageRow>
                    {loading && (
                        <EmptyState>Loading saved layouts…</EmptyState>
                    )}
                    {!loading && layouts.length === 0 && (
                        <EmptyState>
                            No saved layouts yet. Click Save Layout to create one.
                        </EmptyState>
                    )}
                    {!loading && layouts.length > 0 && (
                        <RowList>
                            {layouts.map((layout) => {
                                const isConfirming = confirmingSlug === layout.slug;
                                const isCurrent = layout.slug === currentSlug;
                                return (
                                    <Row key={layout.slug} $confirming={isConfirming} role="option" aria-selected={isCurrent}>
                                        <NameButton
                                            type="button"
                                            $current={isCurrent}
                                            onClick={() => handleSelect(layout.slug)}
                                            title={`Load "${layout.name}"`}
                                        >
                                            <span>{layout.name}{isCurrent ? ' ·  current' : ''}</span>
                                            <RowMeta>{`saved ${formatRelative(layout.savedAt)}`}</RowMeta>
                                        </NameButton>
                                        {isConfirming ? (
                                            <ConfirmRow>
                                                <IconButton
                                                    type="button"
                                                    $danger
                                                    onClick={() => handleDeleteClick(layout.slug)}
                                                    aria-label={`Confirm delete ${layout.name}`}
                                                >
                                                    Confirm
                                                </IconButton>
                                                <IconButton
                                                    type="button"
                                                    onClick={() => setConfirmingSlug(null)}
                                                >
                                                    Cancel
                                                </IconButton>
                                            </ConfirmRow>
                                        ) : (
                                            <IconButton
                                                type="button"
                                                onClick={() => handleDeleteClick(layout.slug)}
                                                aria-label={`Delete ${layout.name}`}
                                                title="Delete layout"
                                            >
                                                ×
                                            </IconButton>
                                        )}
                                    </Row>
                                );
                            })}
                        </RowList>
                    )}
                </Popover>
            )}
        </Wrap>
    );
};

export default LayoutSelectorDropdown;
