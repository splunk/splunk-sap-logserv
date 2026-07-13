/**
 * Mode-aware color token layer — foundation of the Cisco Magnetic re-theme
 * (plan: cisco_magnetic_theme_plan_v0.1_20260705.md, Phase 0 / build 246).
 *
 * Two surfaces:
 *
 *  Surface 1 — CSS custom properties. `logservTheme.colors.*` values are
 *  `var(--lsv-*)` references; the variables are defined on <body> by
 *  <GlobalThemeVars> (state/ThemeModeProvider.tsx) per mode class:
 *      body                  → dark values (default / pre-mount fallback)
 *      body.lsv-mode-light   → light values
 *  Every styled-components interpolation keeps working untouched and
 *  re-resolves at paint time when the mode class flips. Variables live on
 *  <body> (not the app root) so PORTALED components (NodeTooltip, popovers)
 *  inherit them too.
 *
 *  Surface 2 — resolved literal hex via `resolveTokens(mode)` (or the
 *  `useThemeMode()` hook). Required wherever a color reaches:
 *      - SVG presentation ATTRIBUTES (stopColor= / fill= / stroke=) — CSS
 *        var() does not resolve in attribute position;
 *      - color MATH (colorMath.darken / verticalGradient parse `#rrggbb`);
 *      - third-party JS color plumbing (@splunk/visualizations seriesColors,
 *        @xyflow/react markerEnd.color / MiniMap nodeColor).
 *
 * Phase 0: `light` and `dark` sets are IDENTICAL (today's dark palette) so
 * the app renders pixel-equivalent to build 245 while the plumbing lands.
 * Phase 1 swaps the light set to the extracted Magnetic light tokens;
 * Phase 2 swaps the dark set to the derived Magnetic dark palette.
 */

import { username as splunkUsername } from '@splunk/splunk-utils/config';

export type ThemeMode = 'light' | 'dark';

/* ------------------------------------------------------------------ */
/* Token sets                                                          */
/* ------------------------------------------------------------------ */

/** REAL Magnetic classic-dark palette (Harbor @harbor/elements 2.18.45,
 *  extracted 2026-07-05 to cisco_magnetic/extracted_tokens/ — plan §2.4/§5).
 *  Applied in Phase 1a (build 247) together with the light set below.
 *  Token keys keep their legacy names (cyanAccent = the primary interact
 *  accent, now Magnetic blue-on-dark; navAccent = the OneCD teal). */
const DARK_COLORS = {
    // Backgrounds
    pageBackground: '#0f1214',
    panelBackground: '#23282e',
    navBackground: '#0f1214',

    // Borders
    panelBorder: '#596069',
    panelBorderWeak: '#464c54',

    // Text
    textActive: '#f7f7f7',
    textDefault: '#d0d4d9',
    textMuted: '#889099',

    // Status colors
    red: '#fa5762',
    redSevere: '#cc2d37',
    redLight: '#f7782f',
    orange: '#f0b02f',
    orangeLight: '#f0c243',
    yellow: '#f5d160',
    teal: '#4ad9d9',
    green: '#6bbf41',
    cyanAccent: '#649ef5',
    cyanLight: '#7cadf7',
    cyanLightGlow: '#7cadf780',
    purple: '#9b5ff5',

    // Tables
    tableHeaderBackground: '#373c42',
    tableRowOdd: '#282d33',
    tableRowEven: 'transparent',

    // Interactive states
    hoverBackground: '#2a3442',
    activeAccent: '#649ef5',

    // Magnetic vocabulary (Phase 1a additions)
    focusRing: '#7cadf7',
    info: '#7cadf7',
    surfaceInverse: '#373c42',
    // Text ON the inverse surface — mode-INVARIANT by design (the Magnetic
    // tooltip idiom is a dark surface with light text in BOTH modes).
    // Phase 3 / build 257.
    inverseText: '#f7f7f7',
    inverseTextMuted: '#d0d4d9',
    navAccent: '#16bae8',
    navAccentMuted: '#a6adb6',
    positiveTint: '#395534',
    warningTint: '#5c4d28',
    severeTint: '#644637',
    negativeTint: '#63363e',
    infoTint: '#3e506a',
    dormant: '#6f7680',
    dormantTint: '#464c54',
} as const;

export type ColorTokens = { [K in keyof typeof DARK_COLORS]: string };

/** REAL Magnetic classic-light palette (same extraction; values verified
 *  identical between the boilerplate's committed token file and 2.18.45).
 *  Deviation from the plan §5 table: cyanLight is `#0d5cbd` here (interact
 *  hover-blue) instead of `#7cadf7` — the token doubles as highlight TEXT
 *  color and `#7cadf7` fails contrast on white cards. */
const LIGHT_COLORS: ColorTokens = {
    pageBackground: '#f7f7f7',
    panelBackground: '#ffffff',
    navBackground: '#ffffff',

    panelBorder: '#e1e4e8',
    panelBorderWeak: '#f0f1f2',

    textActive: '#23282e',
    textDefault: '#596069',
    textMuted: '#889099',

    red: '#cc2d37',
    redSevere: '#a01d26',
    redLight: '#f26722',
    orange: '#cc8604',
    orangeLight: '#f0c243',
    yellow: '#f0c243',
    teal: '#04a4b0',
    green: '#45991f',
    cyanAccent: '#1d69cc',
    cyanLight: '#0d5cbd',
    cyanLightGlow: '#0d5cbd59',
    purple: '#753bcc',

    tableHeaderBackground: '#f7f7f7',
    tableRowOdd: '#f7f7f7',
    tableRowEven: 'transparent',

    hoverBackground: '#f0f6ff',
    activeAccent: '#1d69cc',

    focusRing: '#3e84e5',
    info: '#2774d9',
    surfaceInverse: '#373c42',
    inverseText: '#f7f7f7',
    inverseTextMuted: '#d0d4d9',
    navAccent: '#198cb3',
    navAccentMuted: '#687381',
    positiveTint: '#e0f5d5',
    warningTint: '#faefb9',
    severeTint: '#ffeadb',
    negativeTint: '#ffe8e9',
    infoTint: '#e3eeff',
    dormant: '#6f7680',
    dormantTint: '#e1e4e8',
};

/** Magnetic data-viz accent palette a–k per mode (real values). Consumed
 *  by chart-palette work in Phase 1b — exported now so the token layer is
 *  complete. */
export const ACCENT_PALETTE: Record<ThemeMode, string[]> = {
    light: ['#7d8aff', '#b02863', '#f2638c', '#753bcc', '#7da11b', '#ad3907', '#04a4b0', '#006773', '#e85fc6', '#545c8a', '#21a65f'],
    dark: ['#9ca6ff', '#e3447c', '#fcb3c8', '#9b5ff5', '#9dba4c', '#d95a1a', '#4ad9d9', '#028e99', '#f582d8', '#767eb2', '#4cbf7f'],
};

export const MODE_TOKENS: Record<ThemeMode, ColorTokens> = {
    dark: DARK_COLORS,
    light: LIGHT_COLORS,
};

export const resolveTokens = (mode: ThemeMode): ColorTokens => MODE_TOKENS[mode];

/* ------------------------------------------------------------------ */
/* CSS custom-property plumbing                                        */
/* ------------------------------------------------------------------ */

/** camelCase token key → CSS custom-property name (`--lsv-page-background`). */
export const cssVarName = (key: string): string =>
    `--lsv-${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;

/** Token key → `var(--lsv-…)` reference (what logservTheme.colors carries). */
export const varRef = (key: keyof ColorTokens): string => `var(${cssVarName(key)})`;

/** Map of every color token key → its var() reference. logservTheme.colors
 *  is built from this so the key set can never drift from MODE_TOKENS. */
export const LSV_VARS: Readonly<Record<keyof ColorTokens, string>> = Object.freeze(
    (Object.keys(DARK_COLORS) as Array<keyof ColorTokens>).reduce(
        (acc, k) => {
            acc[k] = varRef(k);
            return acc;
        },
        {} as Record<keyof ColorTokens, string>,
    ),
);

/** Emit the `--lsv-*: value;` declaration block for one mode. */
export const cssVariableBlock = (mode: ThemeMode): string =>
    (Object.entries(MODE_TOKENS[mode]) as Array<[string, string]>)
        .map(([k, v]) => `${cssVarName(k)}: ${v};`)
        .join('\n    ');

const THEME_VARS_STYLE_ATTR = 'data-lsv-theme-vars';

/**
 * Inject the `--lsv-*` variable stylesheet into <head>. Idempotent — safe
 * to call from both pages/home/index.tsx (synchronously BEFORE React
 * mounts, so the very first paint resolves the variables — no flash) and
 * ThemeModeProvider's mount effect (safety net for any entry point that
 * skips index.tsx, e.g. tests).
 *
 * Dark is the base `body` block (default + pre-mount fallback, matching
 * the ratified dark default); the light class overrides. Plain <style>
 * injection instead of styled-components' createGlobalStyle — sidesteps
 * the GlobalStyleComponent JSX typing incompatibility with our React 18
 * type set, and guarantees availability independent of the React tree.
 */
export const injectThemeVarStylesheet = (): void => {
    if (typeof document === 'undefined') return;
    if (document.head.querySelector(`style[${THEME_VARS_STYLE_ATTR}]`)) return;
    const el = document.createElement('style');
    el.setAttribute(THEME_VARS_STYLE_ATTR, '');
    el.textContent = `body {
    ${cssVariableBlock('dark')}
}
body.${BODY_CLASS_LIGHT} {
    ${cssVariableBlock('light')}
}
`;
    document.head.appendChild(el);
};

/* ------------------------------------------------------------------ */
/* Mode selection + persistence                                        */
/* ------------------------------------------------------------------ */

/** Body classes mirroring Magnetic's `hbr-mode-dark` idiom. Scoped to our
 *  own `lsv-` prefix so Splunk Web chrome is unaffected. */
export const BODY_CLASS_DARK = 'lsv-mode-dark';
export const BODY_CLASS_LIGHT = 'lsv-mode-light';

/** Per-user persistence key (session-036 convention: namespace by user). */
export const themeModeStorageKey = (): string =>
    `logserv.themeMode.${typeof splunkUsername === 'string' && splunkUsername ? splunkUsername : 'anon'}`;

/** Debug/spike override — `#/route?lsvmode=light|dark` in the hash query
 *  (same idiom as the topology `?topo=` hot-patch framework). Not persisted. */
export const readModeOverrideFromHash = (): ThemeMode | null => {
    try {
        const hash = window.location.hash || '';
        const qIdx = hash.indexOf('?');
        if (qIdx === -1) return null;
        const v = new URLSearchParams(hash.slice(qIdx + 1)).get('lsvmode');
        if (v === 'light' || v === 'dark') return v;
    } catch (_e) {
        /* ignore */
    }
    return null;
};

/** Stored user preference, if any. */
export const readStoredThemeMode = (): ThemeMode | null => {
    try {
        const v = window.localStorage.getItem(themeModeStorageKey());
        if (v === 'light' || v === 'dark') return v;
    } catch (_e) {
        /* ignore */
    }
    return null;
};

export const writeStoredThemeMode = (mode: ThemeMode): void => {
    try {
        window.localStorage.setItem(themeModeStorageKey(), mode);
    } catch (_e) {
        /* ignore */
    }
};

/** Initial mode resolution (ratified plan decision Q1): hash override →
 *  stored user choice → DARK. `prefers-color-scheme` intentionally not
 *  consulted — dark is the product default; light is the explicit opt-in. */
export const readInitialThemeMode = (): ThemeMode =>
    readModeOverrideFromHash() ?? readStoredThemeMode() ?? 'dark';

/** Apply the mode class pair to <body>. Callable pre-React-mount
 *  (pages/home/index.tsx) so the first paint is already in the right mode. */
export const applyBodyModeClass = (mode: ThemeMode): void => {
    try {
        document.body.classList.toggle(BODY_CLASS_DARK, mode === 'dark');
        document.body.classList.toggle(BODY_CLASS_LIGHT, mode === 'light');
    } catch (_e) {
        /* ignore */
    }
};
