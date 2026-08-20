import React from 'react';
import {
    BaseEdge,
    EdgeText,
    useInternalNode,
    type EdgeProps,
    type InternalNode,
} from '@xyflow/react';

/**
 * Floating edge — P4 of topology_force_layout_plan_v0.1_20260706.md
 * (build 268 / session 077).
 *
 * The node components wire FIXED invisible handles (target = top-center,
 * source = bottom-center), so every default edge exited a node's bottom
 * and entered the peer's top regardless of where the peer actually is —
 * the maximally curve-producing configuration for the radial star-system
 * layout (a leaf placed left of its hub got an S-bend). This custom edge
 * ignores the handles entirely: the path runs CENTER-TO-CENTER between
 * the two nodes, clipped at each node's VISIBLE shape boundary, so the
 * arrowhead always meets the node head-on along the actual node-to-node
 * direction. Combined with the build-260/262 angular seeding, edges render
 * as gently bowed radial spokes (build 269 — subtle quadratic curve per
 * user preference; build 268 shipped them dead-straight).
 *
 * Geometry: the anchor shape per node type mirrors the rendered chrome
 * (node boxes include the label BELOW the disc/square, so the box center
 * is NOT the visual center). Build 270 — clip radii moved OUT to the
 * health ring / outline OUTER edge (user feedback: arrowheads were
 * landing inside the ring). Derivation from the node chrome:
 *   - sid_focused:   circle, center (boxCenterX, top + 50), r 69
 *                    (discWrap 100 -> disc half 50 + ring offset 14
 *                    + ring half-stroke ~2.75 = 66.75 outer, +2 pad)
 *   - sid_secondary: circle, center (boxCenterX, top + 45), r 63
 *                    (build 277 — secondary enlarged to 90% of focused:
 *                    discWrap 90 -> 45 + 14 + 2.75 = 61.75, +1 pad)
 *   - partner (DB):  circle, center (boxCenterX, top + 34), r 52
 *                    (DB partners keep the 68px disc + ring variant —
 *                    they did NOT grow with the build-277 secondary-SID
 *                    resize; discWrap 68 -> 34 + 14 + 2.75 = 50.75, +1)
 *   - partner:       rect,   center (boxCenterX, top + 26.5), 40x40
 *                    half-extents (square half 25 + outline offset 12
 *                    + outline half-stroke 2.5 = 39.5, rounded up)
 *
 * Bidirectional pairs (A->B and B->A both exist) each shift 7 px to the
 * RIGHT of their own travel direction, separating the two straight lines
 * by 14 px so labels + arrowheads stay readable (data.hasReverse is set
 * by TopologyGraph's edge-sync effect).
 *
 * Interaction: BaseEdge renders the standard interaction path, so edge
 * click -> Edge Details keeps working; style / markerEnd / animated /
 * label props pass through from the edge-sync effect unchanged.
 */

/* DB-vendor tags duplicated from topology/types.ts isDatabaseTag — a
 * partner with one of these renders the circular disc variant. */
const DB_TAGS = new Set(['DB', 'HANA', 'ORACLE', 'MSSQL', 'POSTGRES', 'DB2']);

interface AnchorShape {
    cx: number;
    cy: number;
    /** Circle radius (circle anchors) */
    r: number;
    /** Rect half-extents (rect anchors); undefined => circle */
    hw?: number;
    hh?: number;
}

const anchorFor = (node: InternalNode): AnchorShape => {
    const { x, y } = node.internals.positionAbsolute;
    const w = node.measured?.width ?? 0;
    const cx = x + w / 2;
    if (node.type === 'sid_focused') {
        return { cx, cy: y + 50, r: 69 };
    }
    if (node.type === 'sid_secondary') {
        /* Build 324 — Regular Traffic SIDs adopt the former focused
         * geometry (100 px wrap / 92 px disc / 4 px halo), so the clip
         * circle matches sid_focused exactly. */
        return { cx, cy: y + 50, r: 69 };
    }
    const tag = (node.data as { tag?: string } | undefined)?.tag;
    if (tag === 'TENANT') {
        /* Build 324 — HANA tenant partners render as SID-format 100 px
         * circles (PartnerNode .tenantDisc), same clip as SIDs. */
        return { cx, cy: y + 50, r: 69 };
    }
    if (tag && DB_TAGS.has(tag)) {
        return { cx, cy: y + 34, r: 52 };
    }
    return { cx, cy: y + 26.5, r: 40, hw: 40, hh: 40 };
};

/** Point where a ray from the shape's center toward (dx, dy) exits it. */
const clipToShape = (a: AnchorShape, dx: number, dy: number): { x: number; y: number } => {
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len;
    const uy = dy / len;
    if (a.hw !== undefined && a.hh !== undefined) {
        /* Rect: slab method — smallest t where the ray crosses a side. */
        const tx = ux !== 0 ? a.hw / Math.abs(ux) : Infinity;
        const ty = uy !== 0 ? a.hh / Math.abs(uy) : Infinity;
        const t = Math.min(tx, ty);
        return { x: a.cx + ux * t, y: a.cy + uy * t };
    }
    return { x: a.cx + ux * a.r, y: a.cy + uy * a.r };
};

/** Perpendicular offset applied to each direction of a bidirectional pair. */
const REVERSE_PAIR_OFFSET = 7;

const FloatingEdge: React.FC<EdgeProps> = ({
    source,
    target,
    style,
    markerEnd,
    label,
    labelStyle,
    labelBgStyle,
    labelBgPadding,
    labelBgBorderRadius,
    data,
    interactionWidth,
}) => {
    const sourceNode = useInternalNode(source);
    const targetNode = useInternalNode(target);
    if (!sourceNode || !targetNode) return null;

    const sa = anchorFor(sourceNode);
    const ta = anchorFor(targetNode);

    let sx = sa.cx;
    let sy = sa.cy;
    let tx = ta.cx;
    let ty = ta.cy;

    const hasReverse = (data as { hasReverse?: boolean } | undefined)?.hasReverse === true;
    if (hasReverse) {
        /* Shift the whole line to the RIGHT of the travel direction —
         * each direction of the pair shifts to ITS OWN right, so the two
         * lines separate deterministically without coordination. */
        const dx = tx - sx;
        const dy = ty - sy;
        const len = Math.hypot(dx, dy) || 1;
        const nx = (dy / len) * REVERSE_PAIR_OFFSET;
        const ny = (-dx / len) * REVERSE_PAIR_OFFSET;
        sx += nx;
        sy += ny;
        tx += nx;
        ty += ny;
    }

    const start = clipToShape({ ...sa, cx: sx, cy: sy }, tx - sx, ty - sy);
    const end = clipToShape({ ...ta, cx: tx, cy: ty }, sx - tx, sy - ty);

    /* Build 269 — subtle quadratic bow (user preference over dead-straight
     * spokes). Control point sits perpendicular to the chord, to the RIGHT
     * of the travel direction — the same side as the reverse-pair shift,
     * so bidirectional pairs arc apart symmetrically. Visible apex
     * deviation is HALF the control offset: ~5 px on short satellite
     * edges up to ~22 px on the longest spokes — a soft organic curve
     * that keeps the arrowhead near-head-on at the node boundary. */
    const cdx = end.x - start.x;
    const cdy = end.y - start.y;
    const clen = Math.hypot(cdx, cdy) || 1;
    const bow = Math.min(44, Math.max(10, clen * 0.1));
    const ctrlX = (start.x + end.x) / 2 + (cdy / clen) * bow;
    const ctrlY = (start.y + end.y) / 2 + (-cdx / clen) * bow;
    const path = `M ${start.x},${start.y} Q ${ctrlX},${ctrlY} ${end.x},${end.y}`;
    /* Quadratic bezier point at t=0.5 — the curve's apex, where the label
     * reads as "on the line". */
    const labelX = 0.25 * start.x + 0.5 * ctrlX + 0.25 * end.x;
    const labelY = 0.25 * start.y + 0.5 * ctrlY + 0.25 * end.y;

    return (
        <>
            <BaseEdge path={path} style={style} markerEnd={markerEnd} interactionWidth={interactionWidth} />
            {label !== undefined && label !== null && label !== '' && (
                <EdgeText
                    x={labelX}
                    y={labelY}
                    label={label}
                    labelStyle={labelStyle}
                    labelShowBg
                    labelBgStyle={labelBgStyle}
                    labelBgPadding={labelBgPadding}
                    labelBgBorderRadius={labelBgBorderRadius}
                />
            )}
        </>
    );
};

export default FloatingEdge;
