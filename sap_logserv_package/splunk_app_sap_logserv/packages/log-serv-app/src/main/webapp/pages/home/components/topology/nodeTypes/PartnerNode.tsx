import React, { useCallback, useContext, useRef, useState } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import styled from 'styled-components';
import { logservTheme } from '../../../styles/logservTheme';
import CylinderIcon from './CylinderIcon';
import NodeTooltip from './NodeTooltip';
import {
    BucketGradientDefs,
    computeBucketSegments,
    CallBucketRing,
} from './SidNode';
import { isDatabaseTag, displayTag } from '../../../topology/types';
import AppServersDbIcon from './AppServersDbIcon';
import IpEnrichmentContext from '../IpEnrichmentContext';
import { nodeUserLine } from '../../../topology/enrichment';

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
 *
 * Build 207 / session 036 — added the same call-bucket health indicator
 * SidNode has, but rendered as a SQUARE outline (matching the partner
 * node's rounded-square shape) instead of a circular ring. Implementation
 * uses SVG `<rect>` with stroke-dasharray to paint each bucket segment
 * along the perimeter; same green/orange/red palette + vertical gradient
 * stroke as SidNode for visual cohesion.
 */

interface PartnerNodeData {
    label: string;
    tag: string;
    eventCount: number;
    callBuckets?: { normal: number; warning: number; error: number };
    /** Build 326 — the Details-panel selection (the cyan chrome), decoupled
     *  from RF `selected`, which now means group membership (design §8a). */
    inspected?: boolean;
    [key: string]: unknown;
}

/** Square / rounded-square outline indicator for the partner node's
 *  call-bucket buckets. Build 207 / session 036. Mirrors SidNode's
 *  CallBucketRing but uses rectangle perimeter segments instead of arcs.
 *  Implementation: 3 stacked `<rect>` elements with `stroke-dasharray`
 *  and `stroke-dashoffset` to control which portion of the perimeter
 *  each segment paints.
 *
 *  The starting point on a SVG `<rect>` is the top-left corner; stroke
 *  is drawn clockwise from there. We rotate via dashoffset so the first
 *  bucket starts at TOP-CENTER (matching the SidNode ring's 12-o'clock
 *  start point), giving visual consistency between circle + square. */
interface CallBucketSquareProps {
    width: number;
    height: number;
    cornerR: number;
    buckets: { normal: number; warning: number; error: number };
    nodeId: string;
}

const CallBucketSquare: React.FC<CallBucketSquareProps> = ({ width, height, cornerR, buckets, nodeId }) => {
    const segs = computeBucketSegments(buckets);
    /* Build 227 / session 037 — see CallBucketRing for rationale. Render
     * a solid full-perimeter outline for two cases: empty buckets (all
     * 0 → green) AND single-bucket cases (only normal/warning/error >
     * 0 — segmented dasharray rendering with t0=0,t1=1 produces an
     * invisible "dash to itself"). 2+ non-zero buckets render fine via
     * the existing dasharray-mapping branch. */
    const nonZeroBuckets: Array<'normal' | 'warning' | 'error'> = [];
    if (buckets.normal > 0) nonZeroBuckets.push('normal');
    if (buckets.warning > 0) nonZeroBuckets.push('warning');
    if (buckets.error > 0) nonZeroBuckets.push('error');
    const isSolid = nonZeroBuckets.length <= 1;
    const solidGradKey = nonZeroBuckets[0] ?? 'normal';
    /* Build 208 — stroke bumped 3 → 5 to match the SidNode ring's 5.5
     * for visibility at common topology zoom levels (~0.35-0.45 fitView
     * scale). At 0.35× zoom, the 3 px stroke rendered as ~1 px which
     * was easy to miss; 5 px renders as ~1.75 px — clearly visible. */
    const strokeW = 5;
    /* Outer outline sits 12 px outside the partner square's outer edge
     * (was 6 px in build 207). Bumped to give a clear gap between the
     * square's selection-state cyan-accent box-shadow (2 px solid) plus
     * any visual chrome the user perceives as "around the square". */
    const offset = 12;
    const rectW = width + offset * 2;
    const rectH = height + offset * 2;
    /* Corner radius of the OUTER outline grows proportionally so the
     * shape stays visually similar to the inner square. */
    const outerR = cornerR + offset;
    /* Approximate perimeter of a rounded rectangle: straight portions +
     * 4 quarter-circles (= 1 full circle of radius outerR). */
    const straightPerim = 2 * (rectW - 2 * outerR) + 2 * (rectH - 2 * outerR);
    const cornerPerim = 2 * Math.PI * outerR;
    const perimeter = straightPerim + cornerPerim;
    const svgSize = Math.max(rectW, rectH) + strokeW * 2;
    const svgPad = (svgSize - rectW) / 2;
    const svgPadV = (svgSize - rectH) / 2;
    const idPrefix = `partner-bucket-${nodeId.slice(0, 8)}`;

    /* Native `<rect>` stroke begins drawing at the top-left corner going
     * clockwise. Shift the start point to top-center by negating
     * dashoffset by 1/4 perimeter minus half the top straight portion. */
    const topStraightHalf = (rectW - 2 * outerR) / 2;
    const startShift = -topStraightHalf;

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
                /* Solid full-perimeter outline. Build 227 — empty
                 * buckets render green; single-bucket cases render
                 * with that bucket's gradient. */
                <rect
                    x={svgPad}
                    y={svgPadV}
                    width={rectW}
                    height={rectH}
                    rx={outerR}
                    ry={outerR}
                    fill="none"
                    stroke={`url(#${idPrefix}-${solidGradKey})`}
                    strokeWidth={strokeW}
                />
            ) : (
                segs.map((s, i) => {
                    const segLen = (s.t1 - s.t0) * perimeter;
                    /* Per-segment dashoffset: shift so the segment starts at
                     * (top-center + s.t0 * perimeter). Negative offset moves
                     * the visible portion CW along the path. */
                    const segStart = s.t0 * perimeter;
                    const dashOffset = startShift - segStart;
                    return (
                        <rect
                            key={i}
                            x={svgPad}
                            y={svgPadV}
                            width={rectW}
                            height={rectH}
                            rx={outerR}
                            ry={outerR}
                            fill="none"
                            stroke={`url(#${idPrefix}-${s.gradKey})`}
                            strokeWidth={strokeW}
                            strokeLinecap="round"
                            strokeDasharray={`${segLen} ${perimeter - segLen}`}
                            strokeDashoffset={dashOffset}
                        />
                    );
                })
            )}
        </svg>
    );
};

const Wrapper = styled.div<{
    /** Details-panel selection (cyan chrome). Build 326: renamed from
     *  $selected — fed from data.inspected, NOT the RF selected prop. */
    $inspected: boolean;
    /** Build 326 — RF group membership (Shift+drag / modifier-click).
     *  Paint-only dashed outline on each variant element; geometry
     *  untouched. */
    $grouped: boolean;
}>`
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

    .squareWrap {
        /* Build 207 / session 036 — positioned wrapper around the partner
         * square so the CallBucketSquare SVG can absolute-position
         * centered on it.
         *
         * Build 208 / session 036 — wrapper size BUMPED to match the
         * partner square's BORDER BOX (CSS width + 2 times border-width),
         * NOT its content-box size. With box-sizing content-box
         * (browser default), width 50px + border 1.5px produces a
         * 53x53 border box. If squareWrap stayed at 50x50, the partner
         * square overflowed by 1.5 px on the right/bottom and the
         * SVG outline (centered on squareWrap) was off-center by
         * 1.5 px from the visible square. Same bug as the SID ring;
         * fixed in lockstep here. */
        position: relative;
        width: 53px;
        height: 53px;
        overflow: visible;
        /* Build 208 — flex centering ensures the inner square sits at
         * the squareWrap's center now that squareWrap is sized for the
         * border box. */
        display: flex;
        align-items: center;
        justify-content: center;
    }

    .square {
        width: 50px;
        height: 50px;
        border-radius: 6px;
        background: ${logservTheme.colors.tableHeaderBackground};
        border: 1.5px solid ${(p) => (p.$inspected ? logservTheme.colors.cyanLight : logservTheme.colors.panelBorderWeak)};
        box-shadow: ${(p) => (p.$inspected ? `0 0 0 2px ${logservTheme.colors.cyanAccent}` : '0 1px 3px rgba(0, 0, 0, 0.4)')};
        /* Build 326 — §8a-11: group-membership outline (neutral textActive
         * ink, dashed). offset 5px sits inside the free corridor between
         * the inspected shadow (+2px) and the CallBucketSquare (+9.5px).
         * Paint-only. */
        outline: ${(p) => (p.$grouped ? `2px dashed ${logservTheme.colors.textActive}` : 'none')};
        outline-offset: 5px;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 18px;
        color: ${logservTheme.colors.textDefault};
        font-weight: ${logservTheme.fontWeight.bold};
        transition: box-shadow 120ms ease-out;
    }

    /* Build 213 / session 036 — DB-variant rendering for partner nodes
     * tagged as a database vendor (HANA / Oracle / MSSQL / Postgres /
     * DB2 / generic DB). Circular disc + cylinder icon, mimicking
     * SidNode's secondary-SID look. Sized to match SidNode secondary
     * (CSS 64 + 2 px border = 68 px border-box) so the call-bucket
     * ring offset math from SidNode (diameter / 2 + 14) lands at the
     * right radius. */
    .dbDiscWrap {
        position: relative;
        width: 68px;
        height: 68px;
        overflow: visible;
        display: flex;
        align-items: center;
        justify-content: center;
    }
    .dbDisc {
        width: 64px;
        height: 64px;
        border-radius: 50%;
        background: ${logservTheme.colors.panelBackground};
        border: 2px solid ${(p) => (p.$inspected ? logservTheme.colors.cyanLight : logservTheme.colors.textDefault)};
        box-shadow: ${(p) => (p.$inspected ? `0 0 0 3px ${logservTheme.colors.cyanAccent}, 0 0 14px ${logservTheme.colors.cyanLightGlow}` : '0 2px 6px rgba(0, 0, 0, 0.45)')};
        /* Build 326 — §8a-11: group outline; offset 5px clears the
         * inspected glow (+3px) inside the DB ring corridor. Paint-only. */
        outline: ${(p) => (p.$grouped ? `2px dashed ${logservTheme.colors.textActive}` : 'none')};
        outline-offset: 5px;
        display: flex;
        align-items: center;
        justify-content: center;
        color: ${logservTheme.colors.textActive};
        transition: box-shadow 120ms ease-out;
    }

    /* Build 324 / session 109 — HANA TENANT partners render as a
     * SID-format circle (the former focused geometry: 100 px wrap,
     * 92 px disc, 4 px accent border) with the "app servers + DB"
     * combined icon inside (session-109 selection) + the tenant name
     * at 14 px, mimicking SidNode's interior. Derived geometry in
     * lockstep: FloatingEdge anchorFor TENANT → cy+50/r69, ELK
     * sizeForNode tenant → 145×175, layout collide → 130. */
    .tenantDiscWrap {
        position: relative;
        width: 100px;
        height: 100px;
        overflow: visible;
        display: flex;
        align-items: center;
        justify-content: center;
    }
    .tenantDisc {
        width: 92px;
        height: 92px;
        border-radius: 50%;
        background: ${logservTheme.colors.panelBackground};
        border: 4px solid ${(p) => (p.$inspected ? logservTheme.colors.cyanLight : logservTheme.colors.cyanAccent)};
        box-shadow: ${(p) => (p.$inspected ? `0 0 0 3px ${logservTheme.colors.cyanAccent}, 0 0 14px ${logservTheme.colors.cyanLightGlow}` : '0 2px 6px rgba(0, 0, 0, 0.45)')};
        /* Build 326 — §8a-11: group outline; offset 6px (SID-format
         * geometry — corridor between the glow +3px and the ring
         * +11.25px). Paint-only. */
        outline: ${(p) => (p.$grouped ? `2px dashed ${logservTheme.colors.textActive}` : 'none')};
        outline-offset: 6px;
        display: flex;
        flex-direction: column;
        gap: 1px;
        align-items: center;
        justify-content: center;
        font-weight: ${logservTheme.fontWeight.bold};
        font-size: 14px;
        color: ${logservTheme.colors.cyanAccent};
        transition: box-shadow 120ms ease-out;
    }

    .label {
        /* Build 208 / session 036 — margin-top bumped 4 → 20 px so the
         * partner-node label clears the call-bucket square outline.
         * After build 208's larger outline (offset 12, stroke 5), the
         * SVG extends approximately 17 px past the squareWrap on every
         * side. 20 px = 17 + 3 px breathing room. Same fix as the SID
         * ring overlap; applied in lockstep. */
        margin-top: 20px;
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

    /* Build 329 / session 112 — IP enrichment lines, rendered directly under
     * the IP label (user-ratified placement) when the node's label hits the
     * logserv_topology_ip_enrichment index: the resolved hostname, then the
     * user line (single name, or an "N users" count — decision 1). Both are
     * SEPARATE elements: the .label stays the raw IP, so refineTag (which
     * classifies from the LABEL) can never be flipped by an enrichment
     * string (session-107 trap). Height cost ~26 px is carried in lockstep
     * by the ELK sizeForNode partner boxes (95x145 -> 95x175) + the d3
     * collide radius — see layoutLayered/layoutMrtree/layout.ts. */
    .enrichHost {
        margin-top: 1px;
        font-size: 11px;
        color: ${logservTheme.colors.textDefault};
        text-align: center;
        max-width: 160px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
    }

    .enrichUser {
        margin-top: 1px;
        font-size: 10px;
        color: ${logservTheme.colors.textMuted};
        text-align: center;
        max-width: 160px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
    }

    /* Build 327 — on the TENANT variant the name renders INSIDE the disc,
     * so the .tag chip is the first element BELOW tenantDiscWrap — at the
     * shared 2 px margin the circular health ring's bottom arc (radius
     * 100/2 + 14, stroke 5.5 → extends ~19.5 px past the wrap) crossed
     * straight through it (user-reported, build-324 regression: the chip
     * margin was never bumped when tenants grew to the SID-format ring).
     * 22 px = SidNode's .label clearance for the identical ring geometry.
     * Height grows ~20 px; ELK sizeForNode tenant (145×175) still has
     * ~39 px slack, FloatingEdge anchors measure from the node TOP, and
     * the collide radius is center-circular — no lockstep changes. */
    .tagTenant {
        margin-top: 22px;
    }
`;

const PartnerNode: React.FC<NodeProps> = ({ id, data, selected }) => {
    const d = data as PartnerNodeData;
    /* Build 211 / session 036 — accept any DB-vendor tag (HANA / ORACLE /
     * MSSQL / POSTGRES / DB2) plus the generic DB fallback. */
    const isDb = isDatabaseTag(d.tag as never);
    /* Build 324 — tenant_db endpoints carry the TENANT tag (assigned in
     * useTopologyData) and get the SID-format circle + combo icon. */
    const isTenant = d.tag === 'TENANT';
    /* Build 329 / session 112 — IP-keyed enrichment index (context, never
     * node data — the HostCountContext delivery rule). Hostname-labeled
     * partners simply miss the map. */
    const enrichIndex = useContext(IpEnrichmentContext);
    const enrichEntry = enrichIndex.get(d.label);
    const enrichUserLine = enrichEntry ? nodeUserLine(enrichEntry) : null;
    const wrapperRef = useRef<HTMLDivElement>(null);
    const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
    const handleMouseEnter = useCallback((): void => {
        if (wrapperRef.current) setAnchorRect(wrapperRef.current.getBoundingClientRect());
    }, []);
    const handleMouseLeave = useCallback((): void => setAnchorRect(null), []);

    return (
        <Wrapper
            ref={wrapperRef}
            $inspected={d.inspected ?? false}
            $grouped={selected ?? false}
            /* Build 326 — §8a-17: announce group membership; the prop
             * updates with RF selection (a static node.domAttributes
             * would go stale under applyNodeChanges). */
            aria-selected={selected ?? false}
            onMouseEnter={handleMouseEnter}
            onMouseLeave={handleMouseLeave}
        >
            <Handle type="target" position={Position.Top} style={{ opacity: 0 }} />
            {/* Build 325 note: NO `hosts` row here, by design. Of the nodes
              * this component renders, only tenants would carry a count —
              * and a tenant's label-scoped count is the APPLICATION system's
              * hosts (the label collision), which a name/value tooltip row
              * cannot hedge. The sidebar's facts row covers tenants WITH the
              * hedge a sentence can carry (review fold, session 110). */}
            <NodeTooltip
                name={d.label}
                kind="Remote partner"
                tag={displayTag(d.tag as never)}
                events={d.eventCount}
                anchorRect={anchorRect}
            />
            {isTenant ? (
                /* Build 324 / session 109 — HANA tenant: SID-format circle
                 * with the combined app-servers+DB icon above the tenant
                 * name (the tenant IS the application's database side).
                 * Circular health ring like SIDs (isFocused = the 4 px
                 * border geometry). */
                <div className="tenantDiscWrap">
                    {d.callBuckets && (
                        <CallBucketRing
                            diameter={100}
                            buckets={d.callBuckets}
                            isFocused
                            nodeId={id ?? d.label}
                        />
                    )}
                    <div className="tenantDisc" aria-label={d.label}>
                        <AppServersDbIcon width={44} height={29} />
                        <span>{d.label}</span>
                    </div>
                </div>
            ) : isDb ? (
                /* Build 213 / session 036 — DB-tagged partners render as
                 * a CIRCULAR disc + circular health ring + cylinder icon
                 * (mimicking SidNode's secondary-SID visual). User
                 * direction: any DB-vendor-tagged node should be
                 * treated as a database with the same health-ring
                 * format as HANA SIDs. The ring uses the same
                 * green/orange/red bucket math (with HANA-specific
                 * slow-query warning rule applied upstream in
                 * IntegrationTopology liveNodes when tag === 'HANA'). */
                <div className="dbDiscWrap">
                    {d.callBuckets && (
                        <CallBucketRing
                            diameter={68}
                            buckets={d.callBuckets}
                            isFocused={false}
                            nodeId={id ?? d.label}
                        />
                    )}
                    <div className="dbDisc" aria-label={d.label}>
                        <CylinderIcon width={26} height={30} />
                    </div>
                </div>
            ) : (
                <div className="squareWrap">
                    {/* Build 207 / session 036 — square-shaped call-bucket
                      * health indicator on non-DB partner nodes. Same
                      * green/orange/red gradients as the SidNode ring, but
                      * rendered as a rounded-rect outline tracing the
                      * partner square's shape. Suppressed when buckets are
                      * absent or all 0. */}
                    {d.callBuckets && (
                        <CallBucketSquare
                            /* Build 208 — width/height = partner square's
                             * BORDER-BOX size (50 CSS width + 2*1.5 border =
                             * 53). Outer outline rect is computed from this
                             * + the offset, so it sits cleanly outside the
                             * visible square. */
                            width={53}
                            height={53}
                            cornerR={6}
                            buckets={d.callBuckets}
                            nodeId={id ?? d.label}
                        />
                    )}
                    <div className="square" aria-label={d.label}>
                        {'⬢'}
                    </div>
                </div>
            )}
            {/* Build 324 — tenant name renders INSIDE the disc (SID style),
              * so the below-disc label would duplicate it; chip uses the
              * SHORT display-tag form ("HANA TENANT"), full form in the
              * tooltip + right-pane Tag row (session-109 decision). */}
            {!isTenant && <div className="label">{d.label}</div>}
            {/* Build 329 / session 112 — enrichment lines under the IP label
              * (resolved hostname + user name/count). Rendered only when the
              * label hits the IP-keyed index, so hostname-labeled squares are
              * untouched. Titles carry the full strings past the ellipsis. */}
            {!isTenant && enrichEntry?.hostname && (
                <div className="enrichHost" title={enrichEntry.hostname}>{enrichEntry.hostname}</div>
            )}
            {!isTenant && enrichEntry && enrichUserLine && (
                <div
                    className="enrichUser"
                    title={enrichEntry.users.map((u) => u.name).join(', ')}
                >
                    {enrichUserLine}
                </div>
            )}
            <div className={isTenant ? 'tag tagTenant' : 'tag'}>{displayTag(d.tag as never, { short: true })} · {d.eventCount.toLocaleString()}</div>
            <Handle type="source" position={Position.Bottom} style={{ opacity: 0 }} />
        </Wrapper>
    );
};

export default PartnerNode;
