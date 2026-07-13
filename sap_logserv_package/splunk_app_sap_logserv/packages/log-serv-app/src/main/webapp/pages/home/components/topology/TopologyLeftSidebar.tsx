import React, { useMemo } from 'react';
import styled from 'styled-components';
import FramedPanel from '../FramedPanel';
import { logservTheme } from '../../styles/logservTheme';
import { ALL_INTEGRATION_TYPES, edgeColor, integrationTypeLabel } from '../../topology/edgeStyle';
import { useThemeMode } from '../../state/ThemeModeProvider';
import type { IntegrationType, TopologyEdge, TopologyNode } from '../../topology/types';

/**
 * Left sidebar — two stacked FramedPanels:
 *   1. Systems list (focused + secondary SIDs with event counts + a tiny
 *      bar visual to compare volumes at a glance)
 *   2. Integration types — vertical checkbox list, one row per type with
 *      colored swatch (matches edge stroke color) and label.
 *
 * The Integration / Business Process focus toggle and the Business processes
 * filter panel were removed in build 112 — both were stubs that didn't drive
 * any data change. If we add a real Business Process focus mode later, swap
 * the focus toggle back in then.
 */

const Stack = styled.div`
    display: flex;
    flex-direction: column;
    gap: ${logservTheme.spacing.md};
`;

const SystemList = styled.ul`
    list-style: none;
    margin: 0;
    padding: 0;
`;

const SystemRow = styled.li<{ $selected: boolean }>`
    display: grid;
    grid-template-columns: 56px 1fr auto;
    align-items: center;
    gap: 6px;
    padding: 6px 4px;
    border-radius: ${logservTheme.radius.small};
    background: ${(p) => (p.$selected ? logservTheme.colors.hoverBackground : 'transparent')};
    cursor: pointer;

    &:hover {
        background: ${logservTheme.colors.hoverBackground};
    }
`;

const SidLabel = styled.span<{ $kind: TopologyNode['kind'] }>`
    font-weight: ${logservTheme.fontWeight.semibold};
    color: ${(p) => (p.$kind === 'sid_focused' ? logservTheme.colors.red : logservTheme.colors.textActive)};
    font-size: ${logservTheme.fontSize.body};
`;

const BarTrack = styled.div`
    height: 5px;
    background: ${logservTheme.colors.tableHeaderBackground};
    border-radius: 2px;
    overflow: hidden;
`;

const BarFill = styled.div<{ $pctOfMax: number; $color: string }>`
    height: 100%;
    width: ${(p) => `${Math.max(2, p.$pctOfMax)}%`};
    background: ${(p) => p.$color};
    transition: width 250ms ease-out;
`;

const Count = styled.span`
    color: ${logservTheme.colors.textMuted};
    font-size: ${logservTheme.fontSize.small};
    font-variant-numeric: tabular-nums;
    text-align: right;
`;

const TypeList = styled.ul`
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
`;

const TypeRow = styled.label`
    display: grid;
    grid-template-columns: auto 22px 1fr;
    align-items: center;
    gap: 8px;
    padding: 4px 4px;
    cursor: pointer;
    border-radius: ${logservTheme.radius.small};
    user-select: none;

    &:hover {
        background: ${logservTheme.colors.hoverBackground};
    }
`;

const TypeCheckbox = styled.input.attrs({ type: 'checkbox' })`
    /* Use native rendering — accent-color tints check + box. */
    accent-color: ${logservTheme.colors.cyanAccent};
    cursor: pointer;
    margin: 0;
`;

const TypeSwatch = styled.span<{ $color: string }>`
    display: inline-block;
    width: 18px;
    height: 3px;
    background: ${(p) => p.$color};
    border-radius: 1.5px;
`;

const TypeLabelText = styled.span<{ $active: boolean }>`
    color: ${(p) => (p.$active ? logservTheme.colors.textActive : logservTheme.colors.textMuted)};
    font-size: ${logservTheme.fontSize.small};
    transition: color 80ms ease-out;
`;

const StatLine = styled.div`
    color: ${logservTheme.colors.textMuted};
    font-size: ${logservTheme.fontSize.small};
    margin-bottom: ${logservTheme.spacing.sm};
`;

/** Small buffer below the panel title — passed as a `subtitle` value so it
 *  occupies the FramedPanel's subtitle slot with a fixed (small) height
 *  rather than the natural line-height of `fontSize.small` text. Both
 *  Systems and Integration types panels use the same height for visual
 *  parity. Original NBSP-string approach gave ~16 px (text line-height);
 *  this thin placeholder gives a tighter ~6 px buffer. */
const HeaderBuffer = styled.div`
    height: 6px;
`;

const ToggleAllRow = styled.div`
    display: flex;
    gap: 6px;
    margin-top: 4px;
`;

const TextLink = styled.button`
    background: transparent;
    color: ${logservTheme.colors.cyanLight};
    border: none;
    padding: 0;
    font-size: 10px;
    font-family: inherit;
    cursor: pointer;
    text-decoration: underline;

    &:focus {
        outline: 2px solid ${logservTheme.colors.cyanAccent};
        outline-offset: 1px;
    }
`;

const CollapseChevron = styled.button`
    background: transparent;
    color: ${logservTheme.colors.textMuted};
    border: 1px solid ${logservTheme.colors.panelBorderWeak};
    border-radius: ${logservTheme.radius.small};
    width: 22px;
    height: 22px;
    cursor: pointer;
    font-size: 12px;
    font-weight: ${logservTheme.fontWeight.bold};
    font-family: inherit;
    line-height: 1;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0;

    &:hover {
        color: ${logservTheme.colors.cyanLight};
        border-color: ${logservTheme.colors.cyanAccent};
    }

    &:focus {
        outline: 2px solid ${logservTheme.colors.cyanAccent};
        outline-offset: -2px;
    }
`;

interface TopologyLeftSidebarProps {
    nodes: TopologyNode[];
    /** All edges in the topology — used to compute per-SID edge call totals
     *  (sum of incident edge.callCount). Build 195 / session 035: pre-KV-Store
     *  parity — the previous on-demand SPL path summed connected-edge calls
     *  per SID to display "5,661" for XCP; the KV Store path's per-node
     *  event_count is a different (smaller) number. Showing both side-by-side
     *  preserves both meanings without forcing the user to reverse-engineer
     *  the discrepancy. */
    edges: TopologyEdge[];
    totalCalls: number;
    /** Active integration-type filters. Empty Set = none enabled (all dimmed). */
    enabledTypes: Set<IntegrationType>;
    onToggleType: (type: IntegrationType) => void;
    onToggleAllTypes: (enable: boolean) => void;
    selectedNodeId: string | null;
    onSelectNode: (id: string) => void;
    /** Optional collapse handler — renders a "‹" chevron in the systems panel header. */
    onCollapse?: () => void;
}

const TopologyLeftSidebar: React.FC<TopologyLeftSidebarProps> = ({
    nodes,
    edges,
    totalCalls,
    enabledTypes,
    onToggleType,
    onToggleAllTypes,
    selectedNodeId,
    onSelectNode,
    onCollapse,
}) => {
    /* Resolved tokens for edgeColor() — swatches match the graph edges
     * (build 246 / Phase 0). */
    const { tokens } = useThemeMode();
    const sidNodes = nodes.filter((n) => n.kind !== 'partner');
    const allTypesOn = enabledTypes.size === ALL_INTEGRATION_TYPES.length;

    /** Per-SID edge call totals: sum of edge.callCount where the node is
     *  source OR target. Mirrors the pre-KV-Store on-demand-path metric
     *  that user reference screenshots show ("XCP=5,661"). Build 197 reverted
     *  from the build-195 two-bar (EVT + CALL) layout back to a single bar
     *  using only this metric — the eventCount metric was confusing and the
     *  edge-call total IS what the original app showed. */
    const edgeCallsByNodeId = useMemo(() => {
        const m = new Map<string, number>();
        edges.forEach((e) => {
            m.set(e.source, (m.get(e.source) ?? 0) + e.callCount);
            m.set(e.target, (m.get(e.target) ?? 0) + e.callCount);
        });
        return m;
    }, [edges]);
    const maxEdgeCalls = sidNodes.reduce(
        (m, n) => Math.max(m, edgeCallsByNodeId.get(n.id) ?? 0),
        1,
    );

    return (
        <Stack>
            <FramedPanel
                title="Systems · Integration"
                subtitle={<HeaderBuffer aria-hidden />}
                actions={onCollapse ? (
                    <CollapseChevron type="button" onClick={onCollapse} title="Collapse panel" aria-label="Collapse left panel">
                        {'‹'}
                    </CollapseChevron>
                ) : undefined}
            >
                <StatLine>
                    {`${sidNodes.length} systems · ${totalCalls.toLocaleString()} calls · ${nodes.length - sidNodes.length} partners`}
                </StatLine>
                <SystemList>
                    {sidNodes.map((n) => {
                        const edgeCalls = edgeCallsByNodeId.get(n.id) ?? 0;
                        return (
                            <SystemRow
                                key={n.id}
                                $selected={selectedNodeId === n.id}
                                onClick={() => onSelectNode(n.id)}
                                role="button"
                                tabIndex={0}
                                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onSelectNode(n.id); }}
                                title="Calls: sum of call_count for every edge incident to this SID (source OR target). Matches the pre-KV-Store metric."
                            >
                                <SidLabel $kind={n.kind}>{n.label}</SidLabel>
                                <BarTrack>
                                    <BarFill
                                        $pctOfMax={(edgeCalls / maxEdgeCalls) * 100}
                                        $color={n.kind === 'sid_focused' ? logservTheme.colors.red : logservTheme.colors.cyanLight}
                                    />
                                </BarTrack>
                                <Count>{edgeCalls.toLocaleString()}</Count>
                            </SystemRow>
                        );
                    })}
                </SystemList>
            </FramedPanel>

            <FramedPanel
                title="Integration types"
                subtitle={<HeaderBuffer aria-hidden />}
            >
                <StatLine>
                    {`${enabledTypes.size}/${ALL_INTEGRATION_TYPES.length} active`}
                </StatLine>
                <TypeList>
                    {ALL_INTEGRATION_TYPES.map((t) => {
                        const active = enabledTypes.has(t);
                        return (
                            <li key={t}>
                                <TypeRow>
                                    <TypeCheckbox
                                        checked={active}
                                        onChange={() => onToggleType(t)}
                                    />
                                    <TypeSwatch $color={edgeColor(t, tokens)} aria-hidden />
                                    <TypeLabelText $active={active}>
                                        {integrationTypeLabel(t)}
                                    </TypeLabelText>
                                </TypeRow>
                            </li>
                        );
                    })}
                </TypeList>
                <ToggleAllRow>
                    <TextLink type="button" onClick={() => onToggleAllTypes(true)} disabled={allTypesOn}>All</TextLink>
                    <TextLink type="button" onClick={() => onToggleAllTypes(false)} disabled={enabledTypes.size === 0}>None</TextLink>
                </ToggleAllRow>
            </FramedPanel>
        </Stack>
    );
};

export default TopologyLeftSidebar;
