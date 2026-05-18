import React, { useEffect, useRef, useState } from 'react';
import styled from 'styled-components';
import { logservTheme } from '../../styles/logservTheme';
import { ALL_INTEGRATION_TYPES, edgeColor, integrationTypeLabel } from '../../topology/edgeStyle';
import type { IntegrationType } from '../../topology/types';
import type { LayoutSummary } from '../../topology/persistence';
import {
    type LayoutMode,
    ALL_LAYOUT_MODES,
    layoutModeLabel,
    layoutModeDescription,
} from '../../topology/layout';
import LayoutSelectorDropdown from './LayoutSelectorDropdown';

/**
 * Top toolbar for the Environment Topology view.
 *
 * Title + stats left; toolbar buttons right (LAYOUT dropdown / Snap-to-grid
 * toggle / Refresh / Save Layout / Load Layout dropdown).
 *
 * The Live | Lookup mode toggle was removed in session 044. It was wired to
 * a 30-second `setInterval` that re-fetched the KV Store via refreshNonce,
 * but the KV Store collections are populated by HOURLY scheduled saved
 * searches (`logserv_topology_aggregate_*`, cron `5 * * * *`), so 119 of
 * every 120 Live-mode ticks returned byte-identical data. The toggle
 * provided no value for the main graph (which is what most users were
 * looking at) and was misleadingly named. Manual Refresh remains for cases
 * where an admin just dispatched a backfill and wants to see results
 * before waiting on the next hourly aggregation.
 *
 * "Refresh" re-runs all SPL queries that populate the dashboard data
 * while keeping the user's saved layout (node positions + panel sizes)
 * intact — bumps a refreshNonce that threads through useSearch's effect
 * deps. Renamed from "Re-run force" in build 117. The "Reset" and "PNG"
 * buttons were dropped in build 124 / path A.5: PNG was a stub duplicate
 * of the dashboard-wide Download PNG action; Reset became redundant once
 * the named-layouts dropdown shipped (selecting no layout = unsaved
 * fresh state, deleting a layout via the dropdown's × handles the wipe).
 *
 * Below the title row: a compact legend mapping integration type → color so
 * users can read edge colors without hovering. The legend is always visible
 * (the filter chips in the left sidebar are the place to toggle, not the
 * legend itself).
 */

const Bar = styled.div`
    display: flex;
    flex-direction: column;
    gap: ${logservTheme.spacing.sm};
    padding: ${logservTheme.spacing.sm} ${logservTheme.spacing.md};
    background: ${logservTheme.colors.panelBackground};
    border: 1px solid ${logservTheme.colors.panelBorder};
    border-radius: ${logservTheme.radius.small};
`;

const TopRow = styled.div`
    display: flex;
    align-items: baseline;
    gap: ${logservTheme.spacing.lg};
    flex-wrap: wrap;
`;

/* Title + Stats styled components removed in build 134 — the toolbar no
 * longer duplicates the DashboardLayout H1 + subtitle. */

const Spacer = styled.div`
    flex: 1;
`;

const Buttons = styled.div`
    display: flex;
    align-items: center;
    gap: 6px;
`;

const Button = styled.button<{ $accent?: boolean; $active?: boolean }>`
    background: ${(p) =>
        p.$active
            ? logservTheme.colors.cyanAccent
            : p.$accent
              ? logservTheme.colors.hoverBackground
              : 'transparent'};
    color: ${(p) => (p.$active ? logservTheme.colors.textActive : logservTheme.colors.textActive)};
    border: 1px solid ${(p) => (p.$active ? logservTheme.colors.cyanLight : logservTheme.colors.panelBorderWeak)};
    border-radius: ${logservTheme.radius.small};
    padding: 4px 10px;
    font-size: ${logservTheme.fontSize.small};
    font-weight: ${logservTheme.fontWeight.semibold};
    font-family: inherit;
    cursor: pointer;
    transition: background-color 80ms ease-out, border-color 80ms ease-out;

    &:hover {
        background: ${logservTheme.colors.hoverBackground};
        border-color: ${logservTheme.colors.cyanAccent};
    }

    &:focus {
        outline: 2px solid ${logservTheme.colors.cyanAccent};
        outline-offset: -2px;
    }

    &:disabled {
        opacity: 0.45;
        cursor: not-allowed;
    }
`;

/* Layout-mode dropdown styled components — build 202 / session 036.
 * Replaces the build-200 Force/Layered ModeToggle with a single-button +
 * popover-menu pattern so a third mode (Tree) fits without growing the
 * toolbar horizontally. Visual chrome matches the existing LayoutSelectorDropdown. */
const LayoutDropdownWrap = styled.div`
    position: relative;
    display: inline-block;
`;

const LayoutDropdownButton = styled.button<{ $open: boolean }>`
    background: ${(p) =>
        p.$open ? logservTheme.colors.hoverBackground : 'transparent'};
    color: ${logservTheme.colors.textActive};
    border: 1px solid ${(p) =>
        p.$open ? logservTheme.colors.cyanAccent : logservTheme.colors.panelBorderWeak};
    border-radius: ${logservTheme.radius.small};
    padding: 4px 10px;
    font-size: ${logservTheme.fontSize.small};
    font-weight: ${logservTheme.fontWeight.semibold};
    font-family: inherit;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    transition: background-color 80ms ease-out, border-color 80ms ease-out;

    &:hover {
        background: ${logservTheme.colors.hoverBackground};
        border-color: ${logservTheme.colors.cyanAccent};
    }

    &:focus {
        outline: 2px solid ${logservTheme.colors.cyanAccent};
        outline-offset: -2px;
    }

    .label {
        text-transform: uppercase;
        letter-spacing: 0.4px;
        color: ${logservTheme.colors.textMuted};
        font-size: 9.5px;
    }

    .value {
        color: ${logservTheme.colors.cyanLight};
    }

    .caret {
        font-size: 9px;
        color: ${logservTheme.colors.textMuted};
        margin-left: 2px;
    }
`;

const LayoutDropdownMenu = styled.ul`
    position: absolute;
    top: calc(100% + 4px);
    right: 0;
    min-width: 220px;
    margin: 0;
    padding: 4px 0;
    list-style: none;
    background: ${logservTheme.colors.panelBackground};
    border: 1px solid ${logservTheme.colors.cyanAccent};
    border-radius: ${logservTheme.radius.small};
    box-shadow: 0 6px 18px rgba(0, 0, 0, 0.55);
    z-index: 30;
`;

const LayoutDropdownItem = styled.li<{ $active: boolean }>`
    display: flex;
    flex-direction: column;
    align-items: stretch;
    padding: 6px 12px;
    cursor: pointer;
    background: ${(p) =>
        p.$active ? logservTheme.colors.tableHeaderBackground : 'transparent'};
    color: ${(p) =>
        p.$active ? logservTheme.colors.cyanLight : logservTheme.colors.textActive};
    border-left: 3px solid ${(p) =>
        p.$active ? logservTheme.colors.cyanAccent : 'transparent'};

    &:hover {
        background: ${logservTheme.colors.hoverBackground};
        color: ${logservTheme.colors.cyanLight};
    }

    .name {
        font-size: ${logservTheme.fontSize.small};
        font-weight: ${logservTheme.fontWeight.semibold};
        display: flex;
        align-items: center;
        gap: 6px;
    }

    .check {
        color: ${logservTheme.colors.cyanAccent};
        font-size: 10px;
    }

    .desc {
        margin-top: 3px;
        font-size: 10px;
        line-height: 1.35;
        color: ${logservTheme.colors.textMuted};
        font-weight: ${logservTheme.fontWeight.normal};
    }
`;

const LegendRow = styled.div`
    display: flex;
    gap: ${logservTheme.spacing.md};
    flex-wrap: wrap;
    align-items: center;
`;

const LegendItem = styled.span`
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-size: 10.5px;
    color: ${logservTheme.colors.textMuted};
    letter-spacing: 0.3px;
`;

const Swatch = styled.span<{ $color: string }>`
    width: 18px;
    height: 3px;
    background: ${(p) => p.$color};
    border-radius: 1px;
    display: inline-block;
`;

const SavedNotice = styled.span`
    font-size: 10.5px;
    color: ${logservTheme.colors.cyanLight};
`;

const CurrentLayoutChip = styled.span`
    display: inline-flex;
    align-items: center;
    gap: 4px;
    background: ${logservTheme.colors.tableHeaderBackground};
    border: 1px solid ${logservTheme.colors.cyanAccent};
    border-radius: ${logservTheme.radius.small};
    padding: 2px 8px;
    font-size: 10.5px;
    color: ${logservTheme.colors.cyanLight};
    font-weight: ${logservTheme.fontWeight.semibold};

    .label {
        text-transform: uppercase;
        letter-spacing: 0.4px;
        color: ${logservTheme.colors.textMuted};
        font-size: 9.5px;
    }
`;

interface TopologyToolbarProps {
    layoutSavedAt: string | null;
    layoutDirty: boolean;
    snapMode: boolean;
    /** Active layout algorithm — drives the Force / Layered toggle in the
     *  toolbar. Build 200 / session 035. */
    layoutMode: LayoutMode;
    /** True while at least one topology SPL query is in flight (after a Refresh). */
    refreshing?: boolean;
    /** User-visible name of the currently-loaded layout (chip). null = unsaved. */
    currentLayoutName: string | null;
    /** Slug of the currently-loaded layout (highlighted in the dropdown). */
    currentLayoutSlug: string | null;
    /** All saved layouts for the current user, sorted desc by saved_at. */
    availableLayouts: LayoutSummary[];
    /** True while the layout list is being fetched from KV Store. */
    layoutsLoading: boolean;
    /** Opens the LayoutNameModal. */
    onOpenSaveLayoutModal: () => void;
    onRefresh: () => void;
    onToggleSnap: () => void;
    /** Switch the active layout algorithm (Force / Layered). */
    onSetLayoutMode: (mode: LayoutMode) => void;
    /** Load a layout by slug (KV Store fetch). */
    onLoadLayout: (slug: string) => void;
    /** Delete a layout by slug (KV Store DELETE). */
    onDeleteLayout: (slug: string) => void;
    /** Build 216 / session 036 — opens the Manage Layouts modal. */
    onOpenManageLayouts: () => void;
}

/**
 * Layout-mode dropdown. Build 202 / session 036 — replaces the build-200
 * Force/Layered ModeToggle so a third mode (Tree) fits without growing the
 * toolbar horizontally. Click-outside dismisses; Escape dismisses.
 */
interface LayoutModeDropdownProps {
    layoutMode: LayoutMode;
    onSetLayoutMode: (mode: LayoutMode) => void;
}

const LayoutModeDropdown: React.FC<LayoutModeDropdownProps> = ({ layoutMode, onSetLayoutMode }) => {
    const [open, setOpen] = useState(false);
    const wrapRef = useRef<HTMLDivElement | null>(null);

    useEffect(() => {
        if (!open) return undefined;
        const handleClick = (e: MouseEvent): void => {
            if (!wrapRef.current) return;
            if (!wrapRef.current.contains(e.target as Node)) {
                setOpen(false);
            }
        };
        const handleKey = (e: KeyboardEvent): void => {
            if (e.key === 'Escape') setOpen(false);
        };
        window.addEventListener('mousedown', handleClick);
        window.addEventListener('keydown', handleKey);
        return () => {
            window.removeEventListener('mousedown', handleClick);
            window.removeEventListener('keydown', handleKey);
        };
    }, [open]);

    return (
        <LayoutDropdownWrap ref={wrapRef}>
            <LayoutDropdownButton
                type="button"
                $open={open}
                onClick={() => setOpen((o) => !o)}
                aria-haspopup="listbox"
                aria-expanded={open}
                title={layoutModeDescription(layoutMode)}
            >
                <span className="label">layout</span>
                <span className="value">{layoutModeLabel(layoutMode)}</span>
                <span className="caret">{'▾'}</span>
            </LayoutDropdownButton>
            {open && (
                <LayoutDropdownMenu role="listbox" aria-label="Layout algorithm">
                    {ALL_LAYOUT_MODES.map((m) => (
                        <LayoutDropdownItem
                            key={m}
                            role="option"
                            aria-selected={layoutMode === m}
                            $active={layoutMode === m}
                            onClick={() => {
                                onSetLayoutMode(m);
                                setOpen(false);
                            }}
                        >
                            <span className="name">
                                {layoutModeLabel(m)}
                                {layoutMode === m && <span className="check">{'✓'}</span>}
                            </span>
                            <span className="desc">{layoutModeDescription(m)}</span>
                        </LayoutDropdownItem>
                    ))}
                </LayoutDropdownMenu>
            )}
        </LayoutDropdownWrap>
    );
};

const TopologyToolbar: React.FC<TopologyToolbarProps> = ({
    layoutSavedAt,
    layoutDirty,
    snapMode,
    layoutMode,
    refreshing,
    currentLayoutName,
    currentLayoutSlug,
    availableLayouts,
    layoutsLoading,
    onOpenSaveLayoutModal,
    onRefresh,
    onToggleSnap,
    onSetLayoutMode,
    onLoadLayout,
    onDeleteLayout,
    onOpenManageLayouts,
}) => {
    return (
        <Bar role="toolbar" aria-label="Topology toolbar">
            <TopRow>
                {/* Title + stats line are intentionally NOT rendered here as
                 * of build 134 — they would duplicate the DashboardLayout's
                 * H1 + subtitle that already render directly above the
                 * toolbar. The currently-loaded layout chip moved to the
                 * far-left of this row in the same build. */}
                {currentLayoutName && (
                    <CurrentLayoutChip title={`Currently loaded layout: ${currentLayoutName}`}>
                        <span className="label">layout</span>
                        <span>{currentLayoutName}</span>
                    </CurrentLayoutChip>
                )}
                {layoutSavedAt && !layoutDirty && (
                    <SavedNotice>{`Saved ${new Date(layoutSavedAt).toLocaleTimeString()}`}</SavedNotice>
                )}
                {layoutDirty && (
                    <SavedNotice>Unsaved changes</SavedNotice>
                )}
                <Spacer />
                <Buttons>
                    <LayoutModeDropdown
                        layoutMode={layoutMode}
                        onSetLayoutMode={onSetLayoutMode}
                    />
                    <Button type="button" $active={snapMode} onClick={onToggleSnap} aria-pressed={snapMode}>
                        {snapMode ? 'Snap: ON' : 'Snap: OFF'}
                    </Button>
                    <Button
                        type="button"
                        onClick={onRefresh}
                        title="Re-run all data queries (keeps your saved layout)"
                        disabled={refreshing}
                    >
                        {refreshing ? 'Refreshing…' : 'Refresh'}
                    </Button>
                    <Button type="button" onClick={onOpenSaveLayoutModal} $accent>
                        Save Layout
                    </Button>
                    <LayoutSelectorDropdown
                        layouts={availableLayouts}
                        loading={layoutsLoading}
                        currentSlug={currentLayoutSlug}
                        onSelect={onLoadLayout}
                        onDelete={onDeleteLayout}
                        onManage={onOpenManageLayouts}
                    />
                </Buttons>
            </TopRow>
            <LegendRow>
                {ALL_INTEGRATION_TYPES.map((t) => (
                    <LegendItem key={t}>
                        <Swatch $color={edgeColor(t)} />
                        {integrationTypeLabel(t)}
                    </LegendItem>
                ))}
            </LegendRow>
        </Bar>
    );
};

export default TopologyToolbar;
