import React, { ReactNode, useEffect, useRef } from 'react';
import { darken } from '../utils/colorMath';

/**
 * GradientWrap — wraps a Splunk chart and post-processes its rendered SVG so
 * each colored chart element fades vertically from its original color at the
 * top to a darker shade at the bottom.
 *
 * Why a DOM walker: `@splunk/visualizations` runs `convertPropsToString` on
 * `seriesColors` / `seriesColorsByField`, so passing a Highcharts gradient
 * object through those props is silently coerced to a string and broken.
 *
 * Why `getComputedStyle`: Highcharts styled mode applies color via CSS
 * classes (`.highcharts-color-0 { fill: …; }`), not inline `fill` attributes.
 * The walker checks the computed style of every chart-color element so it
 * works regardless of whether colors come from attributes, inline styles, or
 * CSS classes.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';
const HEX_RE = /^#[0-9a-fA-F]{6}$/;

const toHex2 = (n: number): string =>
    Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');

/** rgb(r, g, b) or rgba(r, g, b, a) → #rrggbb. Returns null for any other format. */
const rgbToHex = (s: string | null | undefined): string | null => {
    if (!s) return null;
    const m = s.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
    if (!m) return null;
    return `#${toHex2(parseInt(m[1], 10))}${toHex2(parseInt(m[2], 10))}${toHex2(parseInt(m[3], 10))}`;
};

const normalizeFill = (raw: string | null | undefined): string | null => {
    if (!raw) return null;
    if (HEX_RE.test(raw)) return raw.toLowerCase();
    return rgbToHex(raw);
};

interface Props {
    children: ReactNode;
    /** Bottom-stop darkness fraction (0 = same color, 1 = black). Default 0.35. */
    darkenAmount?: number;
}

let nextWrapId = 0;

const GradientWrap: React.FC<Props> = ({ children, darkenAmount = 0.35 }) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const wrapIdRef = useRef<string>(`gw${nextWrapId++}`);

    useEffect(() => {
        const container = containerRef.current;
        if (!container) return undefined;

        // Reentrancy guard so our own DOM mutations don't trigger the observer.
        let applying = false;

        const ensureGradient = (svg: SVGSVGElement, hex: string): string => {
            const id = `${wrapIdRef.current}-${hex.slice(1)}`;

            let defs = svg.querySelector(':scope > defs.logserv-gradients') as SVGDefsElement | null;
            // Reuse the gradient ONLY if it still lives in THIS svg. On a chart
            // re-render (e.g. a time-range change) the viz can swap the <svg>
            // element or wipe its <defs>, so a blindly-cached id would dangle —
            // slices referencing url(#<id>) then paint with no fill (the
            // transparent-donut bug). Verifying against the live svg keeps the
            // gradient defs in lockstep with the elements that reference them.
            if (defs && defs.querySelector(`[id="${id}"]`)) return id;

            if (!defs) {
                defs = document.createElementNS(SVG_NS, 'defs') as SVGDefsElement;
                defs.classList.add('logserv-gradients');
                svg.insertBefore(defs, svg.firstChild);
            }

            const gradient = document.createElementNS(SVG_NS, 'linearGradient');
            gradient.setAttribute('id', id);
            gradient.setAttribute('x1', '0%');
            gradient.setAttribute('y1', '0%');
            gradient.setAttribute('x2', '0%');
            gradient.setAttribute('y2', '100%');

            const stop1 = document.createElementNS(SVG_NS, 'stop');
            stop1.setAttribute('offset', '0%');
            stop1.setAttribute('stop-color', hex);
            const stop2 = document.createElementNS(SVG_NS, 'stop');
            stop2.setAttribute('offset', '100%');
            stop2.setAttribute('stop-color', darken(hex, darkenAmount));
            gradient.appendChild(stop1);
            gradient.appendChild(stop2);
            defs.appendChild(gradient);

            return id;
        };

        const applyToElement = (el: SVGElement, svg: SVGSVGElement): void => {
            const currentInline = el.style && el.style.fill;
            if (currentInline && currentInline.startsWith('url(')) {
                // Already gradient-ized by a prior pass. Decide whether to leave
                // it or re-create the gradient using the source hex we stashed on
                // the element — NOT by parsing currentInline. The browser
                // normalizes `el.style.fill` to `url("#id")` (WITH quotes); a
                // quote-fragile regex that fails to extract the id would make us
                // re-set the fill on every pass → an infinite MutationObserver
                // loop that pegs the main thread (the build-238 hang). Deriving
                // the expected id from data-gw-hex and checking its existence is
                // robust and convergent: when the gradient is present we return
                // WITHOUT mutating, so the observer stops firing.
                const storedHex = el.getAttribute('data-gw-hex');
                if (!storedHex) return; // not ours / unrecoverable — leave it
                const expectedId = `${wrapIdRef.current}-${storedHex.slice(1)}`;
                if (svg.querySelector(`[id="${expectedId}"]`)) return; // intact
                // Gradient was wiped (svg swapped / defs cleared on re-render) —
                // recreate it in the current svg and re-point the element.
                const reId = ensureGradient(svg, storedHex);
                el.setAttribute('fill', `url(#${reId})`);
                if (el.style) el.style.fill = `url(#${reId})`;
                return;
            }

            // Try inline-style or attribute first, fall back to computed style
            // (handles Highcharts CSS-class-based fills).
            const attrFill = el.getAttribute('fill');
            const styleFill = currentInline || null;
            const computedFill = window.getComputedStyle(el).fill;

            const hex =
                normalizeFill(attrFill) ||
                normalizeFill(styleFill) ||
                normalizeFill(computedFill);
            if (!hex) return;
            // Skip transparent / black backgrounds (chart background, axes).
            if (hex === '#000000') return;

            const id = ensureGradient(svg, hex);
            // Stash the source hex so a later pass can recover the gradient if
            // the svg's <defs> are wiped on re-render (the url() branch above).
            el.setAttribute('data-gw-hex', hex);
            // Setting both inline style and the attribute makes our gradient
            // win over both inline `style="fill:#..."` and CSS class rules.
            el.setAttribute('fill', `url(#${id})`);
            if (el.style) el.style.fill = `url(#${id})`;
        };

        const apply = () => {
            if (applying) return;
            applying = true;
            try {
                container.querySelectorAll('svg').forEach((svg) => {
                    // Highcharts marks colored series elements with classes like
                    // `highcharts-color-0..N` and `highcharts-point`. Walk those
                    // first; they're the bars / pie slices / line markers.
                    const colored = svg.querySelectorAll<SVGElement>(
                        '[class*="highcharts-color-"], .highcharts-point, [fill]:not([fill="none"])'
                    );
                    colored.forEach((el) => applyToElement(el, svg as SVGSVGElement));
                });
            } finally {
                applying = false;
            }
        };

        // Initial passes — Splunk charts can take a beat to render after data
        // arrives. Try several times in case the first runs before DOM is ready.
        const initialTimers = [60, 200, 500, 1000].map((ms) => window.setTimeout(apply, ms));

        // Re-apply on any DOM change (chart redraws, theme changes), but
        // coalesce bursts into one pass per animation frame. Defense in depth:
        // even if some future change made apply() emit a mutation each pass, the
        // rAF debounce caps it at ~one pass/frame (the page stays responsive)
        // instead of a synchronous re-entrant storm that freezes the renderer.
        let rafScheduled = false;
        const scheduleApply = () => {
            if (rafScheduled) return;
            rafScheduled = true;
            window.requestAnimationFrame(() => {
                rafScheduled = false;
                apply();
            });
        };
        const observer = new MutationObserver(scheduleApply);
        observer.observe(container, { childList: true, subtree: true, attributes: true, attributeFilter: ['fill', 'style', 'class'] });

        return () => {
            initialTimers.forEach((t) => window.clearTimeout(t));
            observer.disconnect();
        };
    }, [darkenAmount]);

    return <div ref={containerRef}>{children}</div>;
};

export default GradientWrap;
