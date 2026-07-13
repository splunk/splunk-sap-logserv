/**
 * LogServ theme — token indirection layer.
 *
 * Since Phase 0 of the Cisco Magnetic re-theme (build 246, plan:
 * cisco_magnetic_theme_plan_v0.1_20260705.md) every COLOR value here is a
 * `var(--lsv-*)` CSS custom-property reference instead of a hex literal.
 * The actual per-mode values (light/dark) are defined on <body> by
 * <GlobalThemeVars> in state/ThemeModeProvider.tsx, sourced from
 * styles/magneticTokens.ts — the single source of truth.
 *
 * Consequences for consumers:
 *  - styled-components / inline `style={{…}}` (CSS positions): keep using
 *    `logservTheme.colors.*` exactly as before — the var() resolves at
 *    paint time and flips automatically with the mode class.
 *  - SVG presentation ATTRIBUTES (stopColor= / fill= / stroke=), color
 *    MATH (colorMath.darken / verticalGradient), and JS color plumbing
 *    (@splunk/visualizations seriesColors, @xyflow markers/minimap):
 *    var() strings DO NOT work there. Use the resolved literal-hex tokens
 *    from `useThemeMode().tokens` (state/ThemeModeProvider.tsx) instead.
 *  - NEVER string-concatenate an alpha suffix onto a color token
 *    (`${colors.cyanLight}80` was the old idiom) — use the dedicated
 *    alpha token (e.g. `cyanLightGlow`) or an rgba literal.
 *
 * Splunk's @splunk/react-ui components render via the nested
 * SplunkThemeScope provider (prisma, colorScheme following our mode);
 * that is intentional so they remain visually first-class Splunk
 * components in both modes.
 */
import { LSV_VARS } from './magneticTokens';

export const logservTheme = {
    /** All values are `var(--lsv-*)` references — see file header. The key
     *  set is derived from magneticTokens.MODE_TOKENS so it can't drift. */
    colors: LSV_VARS,
    spacing: {
        xs: '4px',
        sm: '8px',
        md: '12px',
        lg: '16px',
        xl: '24px',
        xxl: '32px',
    },
    fontSize: {
        small: '11px',
        body: '13px',
        large: '16px',
        xlarge: '20px',
        xxlarge: '28px',
        kpi: '36px',
    },
    fontWeight: {
        normal: 400,
        semibold: 600,
        bold: 700,
    },
    /** Magnetic font stacks (Phase 1b, build 254). The families are bundled
     *  in appserver/static/fonts/ and @font-face-injected pre-mount by
     *  styles/fonts.ts; the fallbacks are Splunk Web's own stack so the app
     *  degrades to the pre-re-theme look if a font file fails to load.
     *  `heading` (Sharp Sans) ships weight 700 ONLY — always pair it with
     *  fontWeight.bold. */
    font: {
        body: '"Inter", "Splunk Platform Sans", "Proxima Nova", Roboto, "Helvetica Neue", Helvetica, Arial, sans-serif',
        heading: '"Sharp Sans", "Inter", "Splunk Platform Sans", "Proxima Nova", Roboto, Arial, sans-serif',
        mono: '"Roboto Mono", ui-monospace, Menlo, Consolas, "Courier New", monospace',
    },
    radius: {
        small: '3px',
        medium: '4px',
    },
    elevation: {
        panelOutline: `1px solid ${LSV_VARS.panelBorder}`,
        panelGap: '12px',
    },
} as const;

export type LogservTheme = typeof logservTheme;
