import React from 'react';
import styled, { keyframes } from 'styled-components';

/**
 * Windows 11-style "circle of dots" loading spinner.
 *
 * Originally built into the AI Assistant chat panel as the
 * streaming/tool-executing indicator (build 150). Extracted here as a
 * shared component in build 166 (session 028) so other dashboards can
 * reuse the same visual language for "something is in flight".
 *
 * Eight orange radial-gradient dots arranged on a circle of `radius` px;
 * the brightness wave travels around once per `periodSec` seconds.
 *
 * Pure CSS — no GIF, no JS animation loop. Sharper at any DPI than a
 * rasterized image, and the orange tone matches the medium-severity dot
 * used elsewhere in the chat narrative so the visual language reads as
 * "in flight, working on it".
 */

interface SpinnerProps {
    /** Radius of the circle of dots, in CSS pixels. Default 9 (chat-input
     *  size). Increase to roughly 20-28 for a topology-canvas-scale
     *  spinner. */
    radius?: number;
    /** Diameter of each dot, in CSS pixels. Default 3. */
    dotSize?: number;
    /** Brightness-wave period in seconds. Default 1.2. */
    periodSec?: number;
    /** Optional aria-label override (default "Loading"). */
    label?: string;
    /** Pause the brightness-wave animation. Default false (running).
     *  When true, all dots render at full opacity at their radial
     *  position and stay still. Useful for icon contexts that activate
     *  on hover (set to false on hover, true otherwise). */
    paused?: boolean;
}

const DEFAULT_RADIUS = 9;
const DEFAULT_DOT_SIZE = 3;
const DEFAULT_PERIOD_S = 1.2;
const DOT_COUNT = 8;

const dotPulse = (radius: number) => keyframes`
    0%, 70%, 100% { opacity: 0.15; transform: rotate(var(--angle, 0deg)) translateY(-${radius}px) scale(0.85); }
    20%           { opacity: 1;    transform: rotate(var(--angle, 0deg)) translateY(-${radius}px) scale(1); }
`;

const Wrap = styled.span<{ $radius: number; $dotSize: number }>`
    position: relative;
    display: inline-block;
    width: ${(p) => p.$radius * 2 + p.$dotSize * 2}px;
    height: ${(p) => p.$radius * 2 + p.$dotSize * 2}px;
    flex-shrink: 0;
    vertical-align: middle;
`;

/**
 * Two separate styled-components for the Dot — one with the
 * brightness-wave animation, one stationary at full opacity. We
 * intentionally do NOT collapse these into a single styled-component
 * with conditional CSS; interpolating the `keyframes(...)` call inside
 * a function-returned string template hides the keyframes call from
 * styled-components' template processor (it never gets injected into
 * the stylesheet) and in some styled-components versions throws during
 * render — which crashes the dashboard with a white screen on the
 * paused → animated transition.
 */

const DotBase = `
    position: absolute;
    top: 50%;
    left: 50%;
    border-radius: 50%;
    background: radial-gradient(circle at 35% 30%, #ffb785 0%, #f1813f 55%, #a04f1d 100%);
    will-change: opacity, transform;
`;

const DotAnimated = styled.span<{
    $angle: number;
    $delay: number;
    $radius: number;
    $dotSize: number;
    $periodSec: number;
}>`
    ${DotBase}
    width: ${(p) => p.$dotSize}px;
    height: ${(p) => p.$dotSize}px;
    margin-left: ${(p) => -p.$dotSize / 2}px;
    margin-top: ${(p) => -p.$dotSize / 2}px;
    --angle: ${(p) => p.$angle}deg;
    transform: rotate(${(p) => p.$angle}deg) translateY(-${(p) => p.$radius}px);
    animation: ${(p) => dotPulse(p.$radius)} ${(p) => p.$periodSec}s ease-in-out infinite;
    animation-delay: ${(p) => p.$delay}s;
`;

const DotPaused = styled.span<{
    $angle: number;
    $radius: number;
    $dotSize: number;
}>`
    ${DotBase}
    width: ${(p) => p.$dotSize}px;
    height: ${(p) => p.$dotSize}px;
    margin-left: ${(p) => -p.$dotSize / 2}px;
    margin-top: ${(p) => -p.$dotSize / 2}px;
    transform: rotate(${(p) => p.$angle}deg) translateY(-${(p) => p.$radius}px);
    opacity: 1;
`;

const Spinner: React.FC<SpinnerProps> = ({
    radius = DEFAULT_RADIUS,
    dotSize = DEFAULT_DOT_SIZE,
    periodSec = DEFAULT_PERIOD_S,
    label = 'Loading',
    paused = false,
}) => (
    <Wrap $radius={radius} $dotSize={dotSize} aria-label={label} role="status">
        {Array.from({ length: DOT_COUNT }).map((_, i) => {
            const angle = i * (360 / DOT_COUNT);
            return paused ? (
                <DotPaused key={i} $angle={angle} $radius={radius} $dotSize={dotSize} />
            ) : (
                <DotAnimated
                    key={i}
                    $angle={angle}
                    $delay={i * (periodSec / DOT_COUNT)}
                    $radius={radius}
                    $dotSize={dotSize}
                    $periodSec={periodSec}
                />
            );
        })}
    </Wrap>
);

export default Spinner;
