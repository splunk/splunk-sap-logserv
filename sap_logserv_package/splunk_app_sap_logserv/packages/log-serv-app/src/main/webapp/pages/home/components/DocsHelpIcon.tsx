import React from 'react';
import styled, { keyframes } from 'styled-components';

/**
 * DocsHelpIcon — circular help-icon affordance for the right edge of
 * a dashboard's title row.
 *
 * Visual: hollow orange rounded square outline with a stationary
 * orange "?" glyph centered inside. The square rotates with a 12-second
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
 * The "?" sits in a sibling element that does NOT rotate, so the glyph
 * stays static while the square spins.
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
const DOCS_ORANGE = '#ff9100';

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

const Square = styled.span<{ $size: number }>`
    position: absolute;
    top: 0;
    left: 0;
    width: ${(p) => p.$size}px;
    height: ${(p) => p.$size}px;
    border: 2px solid ${DOCS_ORANGE};
    border-radius: 4px;
    box-sizing: border-box;
    animation: ${cboxMoveKeyframes} 12000ms infinite;
    will-change: transform;
`;

const Glyph = styled.span<{ $size: number }>`
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    color: ${DOCS_ORANGE};
    font-weight: 700;
    font-size: ${(p) => p.$size}px;
    line-height: 1;
    pointer-events: none;
    user-select: none;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
`;

const DocsHelpIcon: React.FC<DocsHelpIconProps> = ({
    href,
    title = DEFAULT_TITLE,
    size = DEFAULT_SIZE,
}) => {
    if (!href) return null;
    const glyphSize = Math.round(size * 0.65);
    return (
        <Anchor
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            title={title}
            $size={size}
            aria-label={title}
        >
            <Square $size={size} aria-hidden="true" />
            <Glyph $size={glyphSize} aria-hidden="true">
                ?
            </Glyph>
        </Anchor>
    );
};

export default DocsHelpIcon;
