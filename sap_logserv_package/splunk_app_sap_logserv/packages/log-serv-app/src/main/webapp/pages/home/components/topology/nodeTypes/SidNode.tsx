import React, { useCallback, useRef, useState } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import styled from 'styled-components';
import { logservTheme } from '../../../styles/logservTheme';
import { useThemeMode } from '../../../state/ThemeModeProvider';
import { darken } from '../../../utils/colorMath';
import { isDatabaseTag } from '../../../topology/types';
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
    id?: string;
    label: string;
    kind: 'sid_focused' | 'sid_secondary';
    tag: string;
    eventCount: number;
    healthPct?: number;
    /** Build 206 / session 036 — drives the thin outer call-bucket ring. */
    callBuckets?: { normal: number; warning: number; error: number };
    [key: string]: unknown;
}

const haloColor = (pct?: number): string => {
    if (pct == null) return logservTheme.colors.cyanAccent;
    if (pct >= 95) return logservTheme.colors.teal;
    if (pct >= 90) return logservTheme.colors.orange;
    return logservTheme.colors.red;
};

/** SVG arc-path helper. Returns a path string for a circular arc going
 *  CLOCKWISE from `startAngle` to `endAngle` (both in degrees, where 0 is
 *  the top of the circle). Used by `CallBucketRing` to draw three colored
 *  arcs proportional to the normal/warning/error bucket sizes. */
const arcPath = (cx: number, cy: number, r: number, startAngle: number, endAngle: number): string => {
    const a0 = ((startAngle - 90) * Math.PI) / 180;
    const a1 = ((endAngle - 90) * Math.PI) / 180;
    const x0 = cx + r * Math.cos(a0);
    const y0 = cy + r * Math.sin(a0);
    const x1 = cx + r * Math.cos(a1);
    const y1 = cy + r * Math.sin(a1);
    const large = endAngle - startAngle > 180 ? 1 : 0;
    return `M ${x0} ${y0} A ${r} ${r} 0 ${large} 1 ${x1} ${y1}`;
};

/* Build 207 / session 036 — bucket palette uses green/orange/red, NOT teal
 * (teal was a hold-over from build 206; user feedback said "green not teal"
 * to match the rest of the dashboard chart conventions). The vertical
 * gradient pattern (top-to-bottom, 100%→darken(0.4)) matches HourlyChart /
 * ActivityTrendChart / TimeSeriesChart's GradientWrap aesthetic.
 *
 * Build 246 / Phase 0 Magnetic re-theme — the bucket colors are read from
 * the RESOLVED mode tokens inside BucketGradientDefs (useThemeMode) rather
 * than module-level logservTheme constants: SVG stopColor is an ATTRIBUTE
 * (var() refs don't resolve there) and darken() needs literal hex. */
/* Build 212 / session 036 — gradient darken halved (0.4 → 0.2) per
 * user feedback that the existing gradient was too pronounced. The
 * lighter falloff keeps the top-to-bottom shading subtle while still
 * matching the dashboard chart aesthetic (HourlyChart / ActivityTrendChart
 * still use 0.4 because their bars span more vertical pixels than a
 * thin ring stroke; the visual weight of the gradient on a 5.5 px
 * stroke at canvas-zoom is roughly 1/4 of an HourlyChart bar).
 * Phase 3 / build 257 — per-mode: light gets 0.15 (near-flat, matching
 * GradientWrap's light fade per plan §8), dark keeps 0.2. */
const BUCKET_GRAD_DARKEN: Record<'light' | 'dark', number> = { dark: 0.2, light: 0.15 };

/** Render the 3 vertical-gradient `<linearGradient>` SVG defs used by both
 *  the circular and square call-bucket indicators. Same structure as
 *  HourlyChart's gradient — top: full color, bottom: 40% darker. The
 *  unique IDs include the kind name so multiple SVGs on the same page
 *  don't collide. */
interface BucketGradientDefsProps {
    idPrefix: string; // e.g. 'sid-focused-1' to scope ids
}
const BucketGradientDefs: React.FC<BucketGradientDefsProps> = ({ idPrefix }) => {
    const { tokens, mode } = useThemeMode();
    const bucketDarken = BUCKET_GRAD_DARKEN[mode];
    const normal = tokens.green;
    const warning = tokens.orange;
    const error = tokens.red;
    return (
        <defs>
            <linearGradient id={`${idPrefix}-normal`} x1="0" x2="0" y1="0" y2="1">
                <stop offset="0%" stopColor={normal} stopOpacity="1" />
                <stop offset="100%" stopColor={darken(normal, bucketDarken)} stopOpacity="1" />
            </linearGradient>
            <linearGradient id={`${idPrefix}-warning`} x1="0" x2="0" y1="0" y2="1">
                <stop offset="0%" stopColor={warning} stopOpacity="1" />
                <stop offset="100%" stopColor={darken(warning, bucketDarken)} stopOpacity="1" />
            </linearGradient>
            <linearGradient id={`${idPrefix}-error`} x1="0" x2="0" y1="0" y2="1">
                <stop offset="0%" stopColor={error} stopOpacity="1" />
                <stop offset="100%" stopColor={darken(error, bucketDarken)} stopOpacity="1" />
            </linearGradient>
        </defs>
    );
};

/** Compute proportional segment ranges along a 0..1 normalized span for
 *  the 3 bucket buckets. Returns [{key, gradKey, t0, t1}] where t-coords
 *  are fractions of the total perimeter / 360°. The minimum-sliver +
 *  gap-between rules ensure all 3 colors are distinguishable even when
 *  one bucket is a tiny minority. */
interface BucketSegment {
    key: 'normal' | 'warning' | 'error';
    gradKey: string;            // gradient id key suffix
    t0: number;                 // start fraction (0..1)
    t1: number;                 // end fraction (0..1)
}
const computeBucketSegments = (
    buckets: { normal: number; warning: number; error: number },
    minSlivPct: number = 0.02,  // 2% minimum sliver per non-zero bucket
    gapPct: number = 0.012,     // 1.2% gap between segments
): BucketSegment[] => {
    const total = buckets.normal + buckets.warning + buckets.error;
    if (total === 0) return [];
    const fractions: { key: BucketSegment['key']; gradKey: string; value: number }[] = [
        { key: 'normal', gradKey: 'normal', value: buckets.normal },
        { key: 'warning', gradKey: 'warning', value: buckets.warning },
        { key: 'error', gradKey: 'error', value: buckets.error },
    ];
    const nonZero = fractions.filter((f) => f.value > 0);
    const reservedMin = nonZero.length * minSlivPct;
    const totalGap = nonZero.length > 1 ? gapPct * nonZero.length : 0;
    const remaining = Math.max(0, 1 - reservedMin - totalGap);
    const sumNonZero = nonZero.reduce((s, f) => s + f.value, 0);
    let cursor = 0;
    const segs: BucketSegment[] = [];
    fractions.forEach((f) => {
        if (f.value === 0) return;
        const proportional = (f.value / sumNonZero) * remaining;
        const segLen = minSlivPct + proportional;
        segs.push({
            key: f.key,
            gradKey: f.gradKey,
            t0: cursor,
            t1: cursor + segLen,
        });
        cursor += segLen + gapPct;
    });
    return segs;
};

/** Thin three-segment outer ring around a SID disc. Build 206 / session 036.
 *  Build 207 — colors switched to green/orange/red and stroke uses
 *  vertical-gradient defs matching HourlyChart's idiom. Ring radius
 *  bumped further out from the disc to clear the focused-SID 4 px
 *  halo border + 3 px cyan-accent selection glow (which would otherwise
 *  visually overlap the ring). */
interface CallBucketRingProps {
    diameter: number;          // Disc diameter (defines ring center + sizing)
    buckets: { normal: number; warning: number; error: number };
    isFocused: boolean;        // Focused SIDs need a wider ring offset
    nodeId: string;            // For unique gradient ids per node
}

const CallBucketRing: React.FC<CallBucketRingProps> = ({ diameter, buckets, isFocused, nodeId }) => {
    const segs = computeBucketSegments(buckets);
    /* Build 227 / session 037 — render a solid full-circle ring for two
     * cases the segmented arc-path approach can't draw:
     *
     *   1. Empty buckets (all 0): render solid green so empty nodes
     *      still display the health visual ("healthy by default").
     *   2. Single-bucket case (only normal > 0, OR only warning > 0,
     *      OR only error > 0): the arcPath helper rendering a 0..360°
     *      arc produces a degenerate "arc to itself" that's invisible.
     *      A full <circle> draws the same visual cleanly.
     *
     * Detect both: count non-zero buckets. 0 or 1 → render solid circle
     * with the dominant bucket's color (green for empty, else the
     * single non-zero bucket's gradient). 2+ → segmented arcs render
     * fine via the existing path-mapping branch. */
    const nonZeroBuckets: Array<'normal' | 'warning' | 'error'> = [];
    if (buckets.normal > 0) nonZeroBuckets.push('normal');
    if (buckets.warning > 0) nonZeroBuckets.push('warning');
    if (buckets.error > 0) nonZeroBuckets.push('error');
    const isSolid = nonZeroBuckets.length <= 1;
    const solidGradKey = nonZeroBuckets[0] ?? 'normal';
    /* Build 207 — clear gap from the disc visuals.
     * Focused: 4 px halo border + 3 px cyan-accent glow when selected =
     * disc visually ends at radius (diameter/2 + 7). Push ring out 8 px
     * past that to leave breathing room. Total = diameter/2 + 15.
     * Secondary: 2 px white border + 2 px cyan-accent glow = +4. Push 8 px
     * past = diameter/2 + 12. */
    /* Build 208 — diameter is now the disc's BORDER-BOX size (passed from
     * SidNode as 100 / 68 for focused / secondary), so ringRadius is
     * 14 px past the visible disc edge regardless of focused/secondary —
     * leaves clean breathing room past the cyan-accent selection
     * box-shadow + soft cyanLight glow for the selected state. */
    const ringRadius = diameter / 2 + 14;
    /* Build 208 — stroke bumped 3.5 → 5.5 for visibility at common
     * topology zoom levels (~0.35-0.45 of native size after fitView).
     * At 0.35× zoom: 3.5 px stroke ≈ 1.2 px on screen (easily missed);
     * 5.5 px stroke ≈ 1.9 px (clearly visible). */
    const strokeW = 5.5;
    const svgSize = (ringRadius + strokeW) * 2;
    const cx = svgSize / 2;
    const cy = svgSize / 2;
    const idPrefix = `sid-bucket-${nodeId.slice(0, 8)}`;

    return (
        <svg
            width={svgSize}
            height={svgSize}
            viewBox={`0 0 ${svgSize} ${svgSize}`}
            style={{
                position: 'absolute',
                top: '50%',
                left: '50%',
                transform: 'translate(-50%, -50%)',
                pointerEvents: 'none',
                overflow: 'visible',
            }}
            aria-hidden
        >
            <BucketGradientDefs idPrefix={idPrefix} />
            {isSolid ? (
                /* Solid full-circle ring. Build 227 — empty buckets render
                 * green; single-bucket cases render with that bucket's
                 * color so the visual remains continuous. */
                <circle
                    cx={cx}
                    cy={cy}
                    r={ringRadius}
                    fill="none"
                    stroke={`url(#${idPrefix}-${solidGradKey})`}
                    strokeWidth={strokeW}
                />
            ) : (
                segs.map((s, i) => (
                    <path
                        key={i}
                        d={arcPath(cx, cy, ringRadius, s.t0 * 360, s.t1 * 360)}
                        fill="none"
                        stroke={`url(#${idPrefix}-${s.gradKey})`}
                        strokeWidth={strokeW}
                        strokeLinecap="round"
                    />
                ))
            )}
        </svg>
    );
};

/** Export the segment-math + gradient defs so PartnerNode can render the
 *  same call-bucket data along the perimeter of a rounded square instead
 *  of a circle.
 *
 *  Build 213 / session 036 — also export CallBucketRing so PartnerNode
 *  can render a CIRCULAR ring (instead of square outline) for partners
 *  tagged as databases. User feedback: "if the database gets assigned a
 *  database icon and is tagged as HANA then it should be treated as a
 *  database with a health ring with same HANA rules applied" — DB-tagged
 *  partner nodes should look + behave like SidNode database SIDs. */
export {
    BUCKET_GRAD_DARKEN,
    BucketGradientDefs,
    computeBucketSegments,
    CallBucketRing,
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

    .discWrap {
        /* Build 206 / session 036 — positioned wrapper around the disc so
         * the CallBucketRing SVG can absolute-position centered on the
         * disc.
         *
         * Build 208 / session 036 — wrapper size BUMPED to match the
         * disc's BORDER BOX (CSS width + 2 * border-width), not its
         * content-box. Reason: with box-sizing content-box (the
         * disc's default), width 92px + border 4px produces a
         * 100×100 border box. If discWrap stays at 92×92, the disc's
         * top-left aligns with discWrap's top-left but its border
         * extends 4 px past on the right + bottom — putting the disc's
         * VISUAL CENTER at (50, 50) of a 100×100 box while discWrap
         * center is (46, 46). The SVG ring (positioned via
         * top:50% + left:50% + translate(-50%,-50%) on discWrap)
         * landed at (46, 46) — visibly offset from the disc by the
         * border-width.
         * Fix: discWrap = 100×100 (focused) or 90×90 (secondary), so
         * its center matches the disc visual center exactly. Confirmed
         * in build-207 DOM diagnostic: XCP discWrap=92 vs disc=100 →
         * 4-px offset per direction.
         *
         * Build 277 / session 080 — secondary SIDs enlarged to 90% of
         * the focused size (border-box 68 → 90; disc CSS 64 → 86 with
         * the 2 px border unchanged). Inner label / cylinder scale in
         * proportion. Derived geometry updated in lockstep:
         * FloatingEdge.tsx anchorFor (sid_secondary cy +34 → +45,
         * r 52 → 63), layoutLayered/layoutMrtree sizeForNode
         * (115×145 → 135×165), layout.ts DEFAULT_COLLIDE_SECONDARY
         * (100 → 120). DB-tagged PARTNER nodes keep the old 68 px
         * disc — they are partners, not SIDs. */
        position: relative;
        width: ${(p) => (p.$kind === 'sid_focused' ? '100px' : '90px')};
        height: ${(p) => (p.$kind === 'sid_focused' ? '100px' : '90px')};
        /* Build 207 — explicit overflow:visible so the larger SVG ring
         * (now further out from the disc) isn't clipped by the wrapper. */
        overflow: visible;
        /* Build 208 — center the disc inside the now-larger discWrap
         * via flex centering. Disc is content-box 92 + 4 border = 100
         * total, which matches discWrap exactly with this layout. */
        display: flex;
        align-items: center;
        justify-content: center;
    }

    .disc {
        width: ${(p) => (p.$kind === 'sid_focused' ? '92px' : '86px')};
        height: ${(p) => (p.$kind === 'sid_focused' ? '92px' : '86px')};
        border-radius: 50%;
        background: ${logservTheme.colors.panelBackground};
        border: ${(p) => (p.$kind === 'sid_focused' ? `4px solid ${p.$halo}` : `2px solid ${logservTheme.colors.textDefault}`)};
        box-shadow: ${(p) => (p.$selected ? `0 0 0 3px ${logservTheme.colors.cyanAccent}, 0 0 14px ${logservTheme.colors.cyanLightGlow}` : '0 2px 6px rgba(0, 0, 0, 0.45)')};
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
            /* Build 277 — secondary font scales with the 90%-of-focused
             * disc (20 * 0.9 = 18; DB 14 * 0.9 ≈ 13) so label/disc
             * proportions match the focused variant. */
            if (p.$isDb) return p.$kind === 'sid_focused' ? '14px' : '13px';
            return p.$kind === 'sid_focused' ? '20px' : '18px';
        }};
    }

    .label {
        /* Build 208 / session 036 — margin-top bumped 4 → 22 px to push
         * the SID label clear of the call-bucket health ring's visible
         * extent below the disc. After build 208's larger ring (radius
         * disc/2 + 14, stroke 5.5), the SVG extends approximately
         * 19.5 px past the discWrap on every side. Without the bump,
         * the ring's bottom arc visually overlapped the "ECC · 0" /
         * "DB · 0" label. 22 px = 19.5 + 2.5 px breathing room. */
        margin-top: 22px;
        font-size: ${logservTheme.fontSize.small};
        color: ${logservTheme.colors.textMuted};
        font-weight: ${logservTheme.fontWeight.semibold};
        letter-spacing: 0.4px;
    }
`;

const SidNode: React.FC<NodeProps> = ({ id, data, selected }) => {
    const d = data as SidNodeData;
    const halo = haloColor(d.healthPct);
    /* Build 211 / session 036 — accept any vendor-specific DB tag
     * (HANA / ORACLE / MSSQL / POSTGRES / DB2) plus the generic DB
     * fallback. SidNode renders the cylinder icon + label-stack
     * layout for any of these. The actual vendor is preserved in
     * `d.tag` so the tooltip + label show specific vendor. */
    const isDb = isDatabaseTag(d.tag as never);
    const tagPlusCount = `${d.tag} · ${d.eventCount.toLocaleString()}`;
    const cylSize = d.kind === 'sid_focused'
        ? { w: 28, h: 32 }
        : { w: 25, h: 29 };
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

    /* Build 208 / session 036 — disc DIAMETER passed to CallBucketRing is
     * the disc's BORDER-BOX size (CSS width + 2 * border-width), NOT the
     * CSS width. Disc has content-box + border, so border-box = visible
     * disc diameter. Ring radius computes from this so the gap between
     * disc visual edge and ring inner is consistent. */
    const discDiameter = d.kind === 'sid_focused' ? 100 : 90;

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
            <div className="discWrap">
                {/* Build 206 / session 036 — thin outer call-bucket ring
                  * (3 segments: normal green / warning orange / error red).
                  * Build 207 — colors switched to green/orange/red with
                  * vertical-gradient strokes + ring offset bumped past
                  * the focused-SID halo + selection glow.
                  * Suppressed when buckets are absent or all 0. */}
                {d.callBuckets && (
                    <CallBucketRing
                        diameter={discDiameter}
                        buckets={d.callBuckets}
                        isFocused={d.kind === 'sid_focused'}
                        nodeId={id ?? d.label}
                    />
                )}
                <div className="disc">
                    {isDb && <CylinderIcon width={cylSize.w} height={cylSize.h} />}
                    <span>{d.label}</span>
                </div>
            </div>
            <div className="label">{tagPlusCount}</div>
            <Handle type="source" position={Position.Bottom} style={{ opacity: 0 }} />
        </Wrapper>
    );
};

export default SidNode;
