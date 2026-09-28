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
    pageBackground: '#0b1322',
    panelBackground: '#111d31',
    navBackground: '#101a2c',

    // Borders
    panelBorder: '#2b3f5f',
    panelBorderWeak: '#1e304c',

    // Text
    textActive: '#e8eef9',
    textDefault: '#c8d5ea',
    textMuted: '#9fb2d1',

    // Status colors
    red: '#ef4a4a',
    redSevere: '#b24343',
    redLight: '#eb6f33',
    orange: '#e79a22',
    orangeLight: '#f0c243',
    yellow: '#f5d160',
    teal: '#4ad9d9',
    green: '#2fb56f',
    cyanAccent: '#3b82f6',
    cyanLight: '#76a8f9',
    cyanLightGlow: '#76a8f959',
    purple: '#9b5ff5',

    // Tables
    tableHeaderBackground: '#16253d',
    tableRowOdd: '#16253d',
    tableRowEven: 'transparent',

    // Interactive states
    hoverBackground: '#3b82f62e',
    activeAccent: '#3b82f6',

    // Magnetic vocabulary (Phase 1a additions)
    focusRing: '#5e98f8',
    info: '#3b82f6',
    surfaceInverse: '#c8d5ea',
    // Text ON the inverse surface — mode-INVARIANT by design (the Magnetic
    // tooltip idiom is a dark surface with light text in BOTH modes).
    // Phase 3 / build 257.
    inverseText: '#132038',
    inverseTextMuted: '#2f4567',
    navAccent: '#16bae8',
    navAccentMuted: '#a6adb6',
    positiveTint: '#2fb56f29',
    warningTint: '#e79a222e',
    severeTint: '#ac31312e',
    negativeTint: '#ef44442e',
    infoTint: '#3b82f62e',
    dormant: '#7288aa',
    dormantTint: '#1e304c',
} as const;

export type ColorTokens = { [K in keyof typeof DARK_COLORS]: string };

/** REAL Magnetic classic-light palette (same extraction; values verified
 *  identical between the boilerplate's committed token file and 2.18.45).
 *  Deviation from the plan §5 table: cyanLight is `#0d5cbd` here (interact
 *  hover-blue) instead of `#7cadf7` — the token doubles as highlight TEXT
 *  color and `#7cadf7` fails contrast on white cards. */
const LIGHT_COLORS: ColorTokens = {
    pageBackground: '#f5f7fb',
    panelBackground: '#ffffff',
    navBackground: '#ffffff',

    panelBorder: '#dde2e6',
    panelBorderWeak: '#e7ebee',

    textActive: '#1a1f26',
    textDefault: '#4a535c',
    textMuted: '#7e868f',

    red: '#d33c3c',
    redSevere: '#ac3131',
    redLight: '#eb6f33',
    orange: '#a06b16',
    orangeLight: '#b18f30',
    yellow: '#b18f30',
    teal: '#04a4b0',
    green: '#258651',
    cyanAccent: '#3372da',
    cyanLight: '#2a5eb1',
    cyanLightGlow: '#2a5eb159',
    purple: '#753bcc',

    tableHeaderBackground: '#eff1f4',
    tableRowOdd: '#eff1f4',
    tableRowEven: 'transparent',

    hoverBackground: '#3b82f61a',
    activeAccent: '#3372da',

    focusRing: '#3b82f6',
    info: '#3372da',
    surfaceInverse: '#2c333d',
    inverseText: '#f7f9fa',
    inverseTextMuted: '#c1c6cc',
    navAccent: '#198cb3',
    navAccentMuted: '#687381',
    positiveTint: '#e8f8f0',
    warningTint: '#fffbeb',
    severeTint: '#f3e2e2',
    negativeTint: '#fef2f2',
    infoTint: '#3b82f61a',
    dormant: '#6f767f',
    dormantTint: '#e7ebee',
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
/* Shell backdrop (Phase 7, build 344)                                 */
/* ------------------------------------------------------------------ */

/**
 * The content area's layered backdrop, carried byte-for-byte from the
 * Workbench-scaffold palette in the Magnetic preview
 * (`jan_magnetic/logserv-magnetic-preview.html`, `--mag-shell-bg-overlay`
 * on `:root` and `[data-theme="dark"]`).
 *
 * Two mirrored radial lobes plus a vertical wash. Session 128 part 5
 * reworked the lobes to be an exact mirror of one another — same size, same
 * alpha, same stop, x reflected to `100 - x` — so they are emitted here as a
 * matched pair and must stay that way; an edit to one belongs on both.
 *
 * NOT a `--lsv-*` colour token, deliberately. `ColorTokens` is a COLOUR
 * vocabulary: `resolveTokens()` feeds it to chart `seriesColors`, SVG
 * presentation attributes and `colorMath`, all of which would choke on a
 * multi-stop gradient. This is applied through the body mode class instead
 * (see AppShell's `Main`), which is why both values live here together
 * rather than in the light/dark token blocks.
 *
 * The dark variant's wash is `rgba(11, 19, 34, …)`, which is
 * `DARK_COLORS.pageBackground` — they must not drift apart.
 */
export const SHELL_BACKDROP_LIGHT = `
    radial-gradient(1000px 480px at 15% 0%, rgba(59, 130, 246, 0.08), transparent 62%),
    radial-gradient(1000px 480px at 85% 0%, rgba(59, 130, 246, 0.08), transparent 62%),
    linear-gradient(180deg, rgba(255, 255, 255, 0.62) 0%, rgba(255, 255, 255, 0) 34%)
`.trim();

export const SHELL_BACKDROP_DARK = `
    radial-gradient(1200px 560px at 12% -8%, rgba(59, 130, 246, 0.24), transparent 64%),
    radial-gradient(1200px 560px at 88% -8%, rgba(59, 130, 246, 0.24), transparent 64%),
    linear-gradient(180deg, rgba(11, 19, 34, 0.06) 0%, rgba(11, 19, 34, 0.34) 42%, rgba(11, 19, 34, 0.52) 100%)
`.trim();

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

/** Apply the mode class pair to <body>, and the matching `color-scheme` to
 *  the root element. Callable pre-React-mount (pages/home/index.tsx) so the
 *  first paint is already in the right mode.
 *
 *  The root `color-scheme` (build 359) is what the browser reads when it
 *  draws its OWN parts of the page. The page scrollbar is one of them: the
 *  document scrolls, not an inner div (see AppShell's Page). Left at its
 *  initial `normal`, the browser drew its light scrollbar down the side of
 *  the dark app. It has to be the root element: the viewport scrollbar takes
 *  its scheme from <html> only, and the same declaration on <body> leaves it
 *  light (measured, session 135).
 *
 *  The property is inherited, so it also covers every inner scrollbar and
 *  native form control that sets no scheme of its own, including the ones
 *  portaled to <body>. @splunk/react-ui components already set theirs through
 *  the prisma theme's reset mixin, so they are unchanged. */
export const applyBodyModeClass = (mode: ThemeMode): void => {
    try {
        document.body.classList.toggle(BODY_CLASS_DARK, mode === 'dark');
        document.body.classList.toggle(BODY_CLASS_LIGHT, mode === 'light');
        document.documentElement.style.setProperty('color-scheme', mode);
    } catch (_e) {
        /* ignore */
    }
};
