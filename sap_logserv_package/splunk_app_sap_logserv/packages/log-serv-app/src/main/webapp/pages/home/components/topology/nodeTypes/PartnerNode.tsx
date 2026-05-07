import React, { useCallback, useRef, useState } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import styled from 'styled-components';
import { logservTheme } from '../../../styles/logservTheme';
import CylinderIcon from './CylinderIcon';
import NodeTooltip from './NodeTooltip';

/**
 * Custom node for remote partners (non-SAP systems, external endpoints,
 * partner ABAP gateway hosts).
 *
 * Smaller than SID nodes; rounded square with a `tag` chip below.
 *
 * When `tag === 'DB'` the inner glyph swaps from the default hexagon to a
 * SVG cylinder icon — visually identifies database partners (Oracle, MSSQL,
 * HANA, etc.) at a glance. Detection happens upstream in useTopologyData via
 * the `looksLikeDatabase()` heuristic.
 */

interface PartnerNodeData {
    label: string;
    tag: string;
    eventCount: number;
    [key: string]: unknown;
}

const Wrapper = styled.div<{ $selected: boolean }>`
    display: flex;
    flex-direction: column;
    align-items: center;
    pointer-events: all;
    cursor: grab;
    user-select: none;
    max-width: 160px;
    position: relative;

    /* Build 141: tooltip visibility is now JS-driven on the parent so the
     * tooltip can be portaled to document.body for Z-order escape. The
     * old :hover-driven opacity rule is no longer needed — see
     * NodeTooltip.tsx and the hover handlers below. */

    .square {
        width: 50px;
        height: 50px;
        border-radius: 6px;
        background: ${logservTheme.colors.tableHeaderBackground};
        border: 1.5px solid ${(p) => (p.$selected ? logservTheme.colors.cyanLight : logservTheme.colors.panelBorderWeak)};
        box-shadow: ${(p) => (p.$selected ? `0 0 0 2px ${logservTheme.colors.cyanAccent}` : '0 1px 3px rgba(0, 0, 0, 0.4)')};
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 18px;
        color: ${logservTheme.colors.textDefault};
        font-weight: ${logservTheme.fontWeight.bold};
        transition: box-shadow 120ms ease-out;
    }

    .label {
        margin-top: 4px;
        font-size: ${logservTheme.fontSize.small};
        color: ${logservTheme.colors.textDefault};
        font-weight: ${logservTheme.fontWeight.semibold};
        text-align: center;
        max-width: 160px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
    }

    .tag {
        margin-top: 2px;
        font-size: 10px;
        color: ${logservTheme.colors.textMuted};
        letter-spacing: 0.4px;
    }
`;

const PartnerNode: React.FC<NodeProps> = ({ data, selected }) => {
    const d = data as PartnerNodeData;
    const isDb = d.tag === 'DB';
    const wrapperRef = useRef<HTMLDivElement>(null);
    const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
    const handleMouseEnter = useCallback((): void => {
        if (wrapperRef.current) setAnchorRect(wrapperRef.current.getBoundingClientRect());
    }, []);
    const handleMouseLeave = useCallback((): void => setAnchorRect(null), []);

    return (
        <Wrapper
            ref={wrapperRef}
            $selected={selected ?? false}
            onMouseEnter={handleMouseEnter}
            onMouseLeave={handleMouseLeave}
        >
            <Handle type="target" position={Position.Top} style={{ opacity: 0 }} />
            <NodeTooltip
                name={d.label}
                kind="Remote partner"
                tag={d.tag}
                events={d.eventCount}
                anchorRect={anchorRect}
            />
            <div className="square" aria-label={d.label}>
                {isDb ? <CylinderIcon /> : '⬢'}
            </div>
            <div className="label">{d.label}</div>
            <div className="tag">{d.tag} · {d.eventCount.toLocaleString()}</div>
            <Handle type="source" position={Position.Bottom} style={{ opacity: 0 }} />
        </Wrapper>
    );
};

export default PartnerNode;
