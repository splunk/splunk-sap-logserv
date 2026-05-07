import React, { useCallback, useRef, useState } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import styled from 'styled-components';
import { logservTheme } from '../../../styles/logservTheme';
import CylinderIcon from './CylinderIcon';
import NodeTooltip from './NodeTooltip';

/**
 * Custom node for SAP SIDs (focused + secondary).
 *
 * Focused SIDs render as a large circle with a colored health-percentage
 * halo (red < 90, orange 90-94, teal >= 95). Secondary SIDs render as a
 * smaller white-bordered disc.
 *
 * When `tag === 'DB'` (HANA SIDs detected via SID prefix or via the
 * `knownHanaSystems` set in useTopologyData) the inner disc content swaps
 * from a single SID label to a flex-column layout: small cylinder icon
 * above + smaller SID label below. The disc shape + outer ring color stay
 * the same so users still parse "this is a SID" at a glance — only the
 * inner content signals "this SID is a database".
 *
 * Visual identity ties to the rest of the app via `logservTheme` colors —
 * the cyan accent for selected state matches the panel-outline cyan used
 * across all 21 dashboards.
 */

interface SidNodeData {
    label: string;
    kind: 'sid_focused' | 'sid_secondary';
    tag: string;
    eventCount: number;
    healthPct?: number;
    [key: string]: unknown;
}

const haloColor = (pct?: number): string => {
    if (pct == null) return logservTheme.colors.cyanAccent;
    if (pct >= 95) return logservTheme.colors.teal;
    if (pct >= 90) return logservTheme.colors.orange;
    return logservTheme.colors.red;
};

const Wrapper = styled.div<{
    $kind: 'sid_focused' | 'sid_secondary';
    $selected: boolean;
    $halo: string;
    $isDb: boolean;
}>`
    display: flex;
    flex-direction: column;
    align-items: center;
    pointer-events: all;
    cursor: grab;
    user-select: none;
    position: relative;

    /* Build 141: tooltip visibility moved from CSS-only :hover to JS
     * state on the parent so the tooltip can be portaled to document.body
     * for Z-order escape. Hover-in/-out triggers two re-renders per node
     * — measured as imperceptible vs. @xyflow/react drag responsiveness.
     * The :hover-driven .node-tooltip opacity rule is no longer needed
     * and has been removed. */

    .disc {
        width: ${(p) => (p.$kind === 'sid_focused' ? '92px' : '64px')};
        height: ${(p) => (p.$kind === 'sid_focused' ? '92px' : '64px')};
        border-radius: 50%;
        background: ${logservTheme.colors.panelBackground};
        border: ${(p) => (p.$kind === 'sid_focused' ? `4px solid ${p.$halo}` : `2px solid ${logservTheme.colors.textDefault}`)};
        box-shadow: ${(p) => (p.$selected ? `0 0 0 3px ${logservTheme.colors.cyanAccent}, 0 0 14px ${logservTheme.colors.cyanLight}80` : '0 2px 6px rgba(0, 0, 0, 0.45)')};
        display: flex;
        align-items: center;
        justify-content: center;
        font-weight: ${logservTheme.fontWeight.bold};
        color: ${(p) => (p.$kind === 'sid_focused' ? p.$halo : logservTheme.colors.textActive)};
        transition: box-shadow 120ms ease-out;
        /* DB variant: stack cylinder above SID label, shrink font slightly
         * so both fit comfortably inside the same disc footprint. */
        flex-direction: ${(p) => (p.$isDb ? 'column' : 'row')};
        gap: ${(p) => (p.$isDb ? '1px' : '0')};
        font-size: ${(p) => {
            if (p.$isDb) return p.$kind === 'sid_focused' ? '14px' : '11px';
            return p.$kind === 'sid_focused' ? '20px' : '14px';
        }};
    }

    .label {
        margin-top: 4px;
        font-size: ${logservTheme.fontSize.small};
        color: ${logservTheme.colors.textMuted};
        font-weight: ${logservTheme.fontWeight.semibold};
        letter-spacing: 0.4px;
    }
`;

const SidNode: React.FC<NodeProps> = ({ data, selected }) => {
    const d = data as SidNodeData;
    const halo = haloColor(d.healthPct);
    const isDb = d.tag === 'DB';
    const tagPlusCount = `${d.tag} · ${d.eventCount.toLocaleString()}`;
    const cylSize = d.kind === 'sid_focused'
        ? { w: 28, h: 32 }
        : { w: 22, h: 26 };
    const kindLabel = d.kind === 'sid_focused' ? 'Focused SAP SID' : 'Secondary SAP SID';

    // Build 141: hover-driven anchor rect for the portaled tooltip. The
    // wrapper ref captures the node's screen position via
    // getBoundingClientRect on hover-in; the rect is passed to NodeTooltip
    // which renders via createPortal in document.body. Escapes every
    // ancestor `overflow: hidden` (FramedPanel + xyflow chrome).
    const wrapperRef = useRef<HTMLDivElement>(null);
    const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
    const handleMouseEnter = useCallback((): void => {
        if (wrapperRef.current) setAnchorRect(wrapperRef.current.getBoundingClientRect());
    }, []);
    const handleMouseLeave = useCallback((): void => setAnchorRect(null), []);

    return (
        <Wrapper
            ref={wrapperRef}
            $kind={d.kind}
            $selected={selected ?? false}
            $halo={halo}
            $isDb={isDb}
            onMouseEnter={handleMouseEnter}
            onMouseLeave={handleMouseLeave}
        >
            <Handle type="target" position={Position.Top} style={{ opacity: 0 }} />
            <NodeTooltip
                name={d.label}
                kind={kindLabel}
                tag={d.tag}
                events={d.eventCount}
                anchorRect={anchorRect}
            />
            <div className="disc">
                {isDb && <CylinderIcon width={cylSize.w} height={cylSize.h} />}
                <span>{d.label}</span>
            </div>
            <div className="label">{tagPlusCount}</div>
            <Handle type="source" position={Position.Bottom} style={{ opacity: 0 }} />
        </Wrapper>
    );
};

export default SidNode;
