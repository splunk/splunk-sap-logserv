import React from 'react';
import { createPortal } from 'react-dom';
import styled from 'styled-components';
import { variables } from '@splunk/themes';
import { logservTheme } from '../../../styles/logservTheme';

/**
 * Hover tooltip shared by SidNode + PartnerNode in the Environment Topology
 * graph. Replaces the native browser title attribute (bland white-on-light
 * styling + ~500 ms appearance delay) with a dark-theme overlay that matches
 * the rest of the dashboard.
 *
 * Build 141 / session 025 — tooltip is now portaled to `document.body` and
 * positioned with `position: fixed` from the anchor node's
 * `getBoundingClientRect()`. The previous in-tree implementation was being
 * clipped by ancestor `overflow: hidden` declarations (the topology
 * FramedPanel + several @xyflow/react chrome containers), so when the
 * tooltip extended beyond the topology panel boundary it got obscured by
 * neighbouring UI. Portaling escapes every clipping ancestor; the high
 * z-index keeps it above all other dashboard chrome.
 *
 * Trade-off: switched from CSS-only `:hover` visibility (set by the parent
 * Wrapper) to JS hover state in the parent. Each hover-in/hover-out
 * triggers two re-renders per node — measured as imperceptible vs.
 * @xyflow/react drag responsiveness, since hover events don't fire during
 * the drag itself.
 *
 * Build history: 128 (initial) · 129 (2× sizing) · 130-132 (typography
 * polish) · 133 (CSS class rename to dodge global collisions) · 141
 * (portal + position-fixed for Z-order escape) · 144 (~60% sizing +
 * Splunk-Sans font-family + antialiasing — the portal lands on
 * document.body, which sits outside AppShell's font scope, so we set
 * variables.fontFamily explicitly here to match the rest of the app).
 */

const FIXED_OFFSET_PX = 10;  // gap between tooltip bottom and node top

const Wrap = styled.div`
    position: fixed;
    /* top and left are supplied via inline style from the anchor's
     * getBoundingClientRect at hover time. The transform anchors the
     * tooltip's bottom-center to the (top, left) coordinates so it
     * floats above the node, horizontally centered. */
    transform: translate(-50%, calc(-100% - ${FIXED_OFFSET_PX}px));
    /* Magnetic INVERSE-SURFACE tooltip (Phase 3, build 257): dark surface
     * with light text in BOTH modes — the mode-invariant tooltip idiom.
     * Borderless (the inverse fill carries the contrast); the caret below
     * matches the fill. The portal still inherits the --lsv-* vars from
     * <body> (session-075 spike b), so var() tokens resolve here. */
    background: ${logservTheme.colors.surfaceInverse};
    color: ${logservTheme.colors.inverseText};
    border-radius: 6px;
    padding: 10px 14px;
    box-shadow: 0 4px 14px rgba(0, 0, 0, 0.35);
    font-size: 13px;
    /* Portal mounts on document.body, outside AppShell's font scope —
     * declare the Magnetic body stack here (Splunk stack as fallback) so
     * the tooltip matches the rest of the dashboard. Plus subpixel-AA
     * hints for crisp glyph edges. Build 144; stack updated build 257. */
    font-family: ${logservTheme.font.body}, ${variables.fontFamily};
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
    text-rendering: geometricPrecision;
    white-space: nowrap;
    pointer-events: none;
    /* High z-index in document.body's stacking context — guaranteed
     * above every other dashboard chrome element. Build 141. */
    z-index: 10000;
    line-height: 1.4;

    .tt-row {
        display: grid;
        grid-template-columns: 67px 1fr;
        gap: 12px;
        align-items: baseline;
    }

    .tt-label {
        color: ${logservTheme.colors.inverseTextMuted};
        font-size: 16px;
        font-weight: ${logservTheme.fontWeight.semibold};
    }

    .tt-value {
        color: ${logservTheme.colors.inverseText};
        font-weight: ${logservTheme.fontWeight.semibold};
        font-variant-numeric: tabular-nums;
    }

    /* Caret pointing down to the node — drawn at the tooltip's bottom
     * edge. Since transform centers the tooltip on the anchor x-axis,
     * the caret sits directly above the node's top-center. */
    &::after {
        content: '';
        position: absolute;
        top: 100%;
        left: 50%;
        transform: translateX(-50%);
        border: 7px solid transparent;
        border-top-color: ${logservTheme.colors.surfaceInverse};
    }
`;

interface NodeTooltipProps {
    name: string;
    kind: string;
    tag: string;
    events: number;
    /** Bounding rect of the anchor node, captured by the parent on hover-in.
     *  When null (mouse not hovering), the tooltip is unmounted. Build 141. */
    anchorRect: DOMRect | null;
}

const NodeTooltip: React.FC<NodeTooltipProps> = ({ name, kind, tag, events, anchorRect }) => {
    // Early-out when not hovered. Combined with portal mounting below,
    // means we render zero DOM nodes for un-hovered nodes — much lighter
    // than the prior approach of always-rendering with opacity:0.
    if (!anchorRect) return null;
    if (typeof document === 'undefined') return null;  // SSR safety

    const left = anchorRect.left + anchorRect.width / 2;
    const top = anchorRect.top;  // tooltip's transform places it above this

    return createPortal(
        <Wrap className="node-tooltip" role="tooltip" style={{ top, left }}>
            <div className="tt-row"><span className="tt-label">Name</span><span className="tt-value">{name}</span></div>
            <div className="tt-row"><span className="tt-label">Kind</span><span className="tt-value">{kind}</span></div>
            <div className="tt-row"><span className="tt-label">Tag</span><span className="tt-value">{tag}</span></div>
            <div className="tt-row"><span className="tt-label">Events</span><span className="tt-value">{events.toLocaleString()}</span></div>
        </Wrap>,
        document.body,
    );
};

export default NodeTooltip;
