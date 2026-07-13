import React, { useId } from 'react';
import styled, { keyframes } from 'styled-components';

/**
 * DocsHelpIcon — circular help-icon affordance for the right edge of
 * a dashboard's title row.
 *
 * Visual: hollow rounded-square outline with a stationary "?" glyph
 * centered inside, both painted with the LogServ brand blue gradient
 * (build 278 / build 255 — previously flat docs-orange #ff9100; the
 * gradient matches the recolored app icon: #2276CE → #0F55A3, mid ≈
 * Cisco blue #1870C5). The square rotates with a 12-second
 * spin-pause-spin-back cycle that mirrors the `.cboxmove` keyframes
 * used throughout the published docs site (`docs/css/extra.css`):
 *
 *     @keyframes material-circle-box {
 *         20%, 40%, 60%, 80% { transform: rotate(1.0turn); }
 *     }
 *     .cboxmove { animation: material-circle-box 12000ms infinite; }
 *
 * Decoded: one full clockwise turn over the first 2.4s, hold for ~7.2s,
 * one full counter-clockwise turn back to start over 2.4s, loop.
 *
 * Implementation notes (build 278/255 gradient conversion):
 *   - A CSS border cannot take a gradient (border-image does not compose
 *     with border-radius), so the square is an SVG rounded-rect with a
 *     gradient STROKE. Radius stays the panel token value: rect inset 1,
 *     rx 3 + 2px stroke = 4px outer radius — identical to the previous
 *     `border-radius: 4px` and to FramedPanel/KpiCard.
 *   - The "?" is SVG <text> with a gradient FILL rather than CSS
 *     `background-clip: text` — html2canvas (the dashboard PNG/PDF
 *     export) does not render background-clip:text, but serializes
 *     sized inline SVGs faithfully.
 *   - The glyph lives in its own NON-rotating svg (the square spins,
 *     the "?" stays static), and each svg carries its OWN gradient def
 *     (cross-svg url(#) references break when svgs are serialized
 *     standalone — the session-078 export-capture lesson).
 *   - Gradient ids are per-instance via useId (DashboardLayout and
 *     PrivacyBanner can both mount one on the same page).
 *
 * Click opens the linked docs page in a new browser tab. The href
 * should come from `utils/docsLinks.resolveDocsUrl(pathname)`. If null
 * (non-dashboard pathname), the component renders nothing.
 */

interface DocsHelpIconProps {
    href: string | null;
    title?: string;
    /** Outer width/height of the icon, in CSS pixels. Default 30. */
    size?: number;
}

const DEFAULT_SIZE = 30;
const DEFAULT_TITLE = 'Open documentation for this dashboard in a new tab';
const DOCS_BLUE_TOP = '#2276CE';
const DOCS_BLUE_BOT = '#0F55A3';

const cboxMoveKeyframes = keyframes`
    20%, 40%, 60%, 80% {
        transform: rotate(1turn);
    }
`;

const Anchor = styled.a<{ $size: number }>`
    display: inline-flex;
    align-items: center;
    justify-content: center;
    position: relative;
    width: ${(p) => p.$size}px;
    height: ${(p) => p.$size}px;
    text-decoration: none;
    border: none;
    background: transparent;
    cursor: pointer;
    flex-shrink: 0;
`;

const SquareSvg = styled.svg<{ $size: number }>`
    position: absolute;
    top: 0;
    left: 0;
    width: ${(p) => p.$size}px;
    height: ${(p) => p.$size}px;
    animation: ${cboxMoveKeyframes} 12000ms infinite;
    will-change: transform;
`;

const GlyphSvg = styled.svg<{ $size: number }>`
    position: absolute;
    top: 0;
    left: 0;
    width: ${(p) => p.$size}px;
    height: ${(p) => p.$size}px;
    pointer-events: none;
    user-select: none;
`;

const DocsHelpIcon: React.FC<DocsHelpIconProps> = ({
    href,
    title = DEFAULT_TITLE,
    size = DEFAULT_SIZE,
}) => {
    /* useId emits ":rN:" — strip the colons so the id is safe inside
     * SVG url(#...) attribute references. */
    const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '');
    if (!href) return null;
    const glyphSize = Math.round(size * 0.65);
    const sqGradId = `docs-help-sq-${uid}`;
    const qGradId = `docs-help-q-${uid}`;
    return (
        <Anchor
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            title={title}
            $size={size}
            aria-label={title}
        >
            <SquareSvg $size={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
                <defs>
                    <linearGradient id={sqGradId} x1="0" x2="0" y1="0" y2="1">
                        <stop offset="0%" stopColor={DOCS_BLUE_TOP} />
                        <stop offset="100%" stopColor={DOCS_BLUE_BOT} />
                    </linearGradient>
                </defs>
                <rect
                    x="1"
                    y="1"
                    width={size - 2}
                    height={size - 2}
                    rx="3"
                    fill="none"
                    stroke={`url(#${sqGradId})`}
                    strokeWidth="2"
                />
            </SquareSvg>
            <GlyphSvg $size={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
                <defs>
                    <linearGradient id={qGradId} x1="0" x2="0" y1="0" y2="1">
                        <stop offset="0%" stopColor={DOCS_BLUE_TOP} />
                        <stop offset="100%" stopColor={DOCS_BLUE_BOT} />
                    </linearGradient>
                </defs>
                <text
                    x="50%"
                    y="50%"
                    textAnchor="middle"
                    dominantBaseline="central"
                    fill={`url(#${qGradId})`}
                    fontWeight="700"
                    fontSize={glyphSize}
                    fontFamily="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"
                >
                    ?
                </text>
            </GlyphSvg>
        </Anchor>
    );
};

export default DocsHelpIcon;
