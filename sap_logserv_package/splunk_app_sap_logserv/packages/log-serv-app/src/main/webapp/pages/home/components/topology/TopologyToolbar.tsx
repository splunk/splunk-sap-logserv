import React from 'react';
import styled from 'styled-components';
import { logservTheme } from '../../styles/logservTheme';
import { ALL_INTEGRATION_TYPES, edgeColor, integrationTypeLabel } from '../../topology/edgeStyle';
import type { IntegrationType } from '../../topology/types';
import type { LayoutSummary } from '../../topology/persistence';
import LayoutSelectorDropdown from './LayoutSelectorDropdown';

/**
 * Top toolbar for the Environment Topology view.
 *
 * Title + stats left; toolbar buttons right (Live | Lookup mode toggle /
 * Snap-to-grid toggle / Refresh / Save Layout / Load Layout dropdown).
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

const ModeToggle = styled.div`
    display: inline-flex;
    border: 1px solid ${logservTheme.colors.panelBorderWeak};
    border-radius: ${logservTheme.radius.small};
    overflow: hidden;
`;

const ModeButton = styled.button<{ $active: boolean }>`
    background: ${(p) => (p.$active ? logservTheme.colors.cyanAccent : 'transparent')};
    color: ${logservTheme.colors.textActive};
    border: none;
    padding: 4px 10px;
    font-size: ${logservTheme.fontSize.small};
    font-weight: ${logservTheme.fontWeight.semibold};
    font-family: inherit;
    cursor: pointer;

    &:hover {
        background: ${(p) =>
            p.$active ? logservTheme.colors.cyanAccent : logservTheme.colors.hoverBackground};
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
    liveMode: boolean;
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
    onToggleLiveMode: () => void;
    /** Load a layout by slug (KV Store fetch). */
    onLoadLayout: (slug: string) => void;
    /** Delete a layout by slug (KV Store DELETE). */
    onDeleteLayout: (slug: string) => void;
}

const TopologyToolbar: React.FC<TopologyToolbarProps> = ({
    layoutSavedAt,
    layoutDirty,
    snapMode,
    liveMode,
    refreshing,
    currentLayoutName,
    currentLayoutSlug,
    availableLayouts,
    layoutsLoading,
    onOpenSaveLayoutModal,
    onRefresh,
    onToggleSnap,
    onToggleLiveMode,
    onLoadLayout,
    onDeleteLayout,
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
                    <ModeToggle role="group" aria-label="Mode" title={liveMode ? 'Live mode — auto-refreshing every 30s' : 'Lookup mode — manual refresh only'}>
                        <ModeButton type="button" $active={liveMode} onClick={onToggleLiveMode} aria-pressed={liveMode}>Live</ModeButton>
                        <ModeButton type="button" $active={!liveMode} onClick={onToggleLiveMode} aria-pressed={!liveMode}>Lookup</ModeButton>
                    </ModeToggle>
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
