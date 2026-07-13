/**
 * Tiny color helpers shared by chart wrappers.
 *
 * Kept dependency-free so it can be imported from styled-components
 * tagged templates without pulling in any heavyweight color library.
 */

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

const toHex2 = (n: number): string =>
    Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');

/**
 * Darken a `#rrggbb` color by `amount` (0 = no change, 1 = black).
 * Returns the input unchanged if it isn't a 6-char hex.
 *
 * Use the same `amount` everywhere a chart's vertical-gradient is
 * applied (default 0.4 — see DEFAULT_GRADIENT_DARKEN in TimeSeriesChart)
 * so colored bars / swatches across the app share one visual identity.
 */
export const darken = (hex: string, amount: number): string => {
    if (!HEX_RE.test(hex)) return hex;
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    const f = 1 - amount;
    return `#${toHex2(r * f)}${toHex2(g * f)}${toHex2(b * f)}`;
};

/**
 * CSS `linear-gradient(to bottom, color 0%, darken(color, amount) 100%)`.
 * Convenient one-liner for HTML/CSS contexts that mirror the SVG gradient
 * applied by GradientWrap.
 */
export const verticalGradient = (hex: string, amount: number): string =>
    `linear-gradient(to bottom, ${hex} 0%, ${darken(hex, amount)} 100%)`;

/** Mix a #rrggbb color toward white by `amount` (0 = unchanged, 1 = white).
 *  Mirror of `darken` — used for gradient highlight stops (severity dots,
 *  spinner beads) where the light stop must track the mode-resolved base.
 *  Phase 4 / build 258. Non-hex input returns unchanged (same soft-fail
 *  contract as darken). */
export const lighten = (hex: string, amount: number): string => {
    const m = /^#([0-9a-fA-F]{6})$/.exec(hex);
    if (!m) return hex;
    const n = parseInt(m[1], 16);
    const mix = (c: number): number => Math.round(c + (255 - c) * amount);
    const r = mix((n >> 16) & 0xff);
    const g = mix((n >> 8) & 0xff);
    const b = mix(n & 0xff);
    // eslint-disable-next-line no-bitwise
    return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
};
