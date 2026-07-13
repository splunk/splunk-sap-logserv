/**
 * Semantic chart palettes for TimeSeriesChart and PieChart — MODE-AWARE
 * since Phase 1b of the Cisco Magnetic re-theme (build 254).
 *
 * Charts use the same colors when they show the same KIND of thing — errors
 * are always red-spectrum, throughput/volume always blue/teal, auth always
 * orange, status codes follow a 2xx-green / 3xx-blue / 4xx-orange / 5xx-red
 * convention. This lets users parse a dashboard at a glance: "this row is
 * red, so it's all errors".
 *
 * Apply via the `palette` prop on TimeSeriesChart / PieChart; those
 * components resolve the active theme mode via useThemeMode() and call
 * `paletteColors(palette, mode)` / `statusFieldColors(mode)`. Series colors
 * reach Highcharts as LITERAL hex through @splunk/visualizations props
 * (Surface 2 of the token architecture — CSS var() does not survive that
 * plumbing), which is why this module carries per-mode hex tables instead
 * of var() references.
 *
 * The hex values are the REAL Magnetic palette (Harbor 2.18.45 sentiment +
 * dataviz accents — see styles/magneticTokens.ts / plan §5): sentiment
 * colors for the semantic ramps, the 11-color a–k accent palette for
 * categorical breakdowns.
 *
 * For categorical fields with well-known names (status_cat 2xx/3xx/4xx/5xx,
 * severity info/warning/error/fatal, etc.) we map by field name via
 * `statusFieldColors(mode)` so the color sticks to the meaning regardless
 * of series order in the SPL output.
 */
import { ACCENT_PALETTE, MODE_TOKENS, ThemeMode } from './magneticTokens';

export type ChartPalette =
    | 'errors'
    | 'errors-2'
    | 'errors-3'
    | 'volume'
    | 'auth'
    | 'status'
    | 'categorical'
    | 'neutral';

// THE ONLY THREE permitted pairings for error / warning 2-series charts.
// Use exactly as defined — first color = first series, second color = second
// series. No other red/orange/yellow combinations are allowed on
// error / warning charts.
//   Pair 1 (errors)   — deep red + red        (redSevere + negative)
//   Pair 2 (errors-2) — red + salmon          (negative + accent-c pink)
//   Pair 3 (errors-3) — orange + red          (severe + negative)
const ERROR_PAIR_1: Record<ThemeMode, string[]> = {
    dark: ['#cc2d37', '#fa5762'],
    light: ['#a01d26', '#cc2d37'],
};
const ERROR_PAIR_2: Record<ThemeMode, string[]> = {
    dark: ['#fa5762', '#fcb3c8'],
    light: ['#cc2d37', '#f2638c'],
};
const ERROR_PAIR_3: Record<ThemeMode, string[]> = {
    dark: ['#f7782f', '#fa5762'],
    light: ['#f26722', '#cc2d37'],
};

// Volume/throughput ramp: interact blue → accent-a indigo → teal → purple →
// muted gray. Blue-spectrum = "flow" per the dashboard conventions.
const VOLUME_RAMP: Record<ThemeMode, string[]> = {
    dark: ['#649ef5', '#9ca6ff', '#4ad9d9', '#9b5ff5', '#889099'],
    light: ['#1d69cc', '#7d8aff', '#04a4b0', '#753bcc', '#889099'],
};

// Auth ramp: severe orange → red → warning yellow → gold → deep red.
const AUTH_RAMP: Record<ThemeMode, string[]> = {
    dark: ['#f7782f', '#fa5762', '#f0c243', '#f5d160', '#cc2d37'],
    light: ['#f26722', '#cc2d37', '#cc8604', '#f0c243', '#a01d26'],
};

/** Field-name → color map for status / severity / risk fields, per mode.
 *  Semantics: 2xx/success = positive green, 3xx/info/low = info blue,
 *  4xx/warning/medium = severe orange, 5xx/error/critical/high = negative
 *  red, fatal = deep red, Other = purple. */
export const statusFieldColors = (mode: ThemeMode): Record<string, string> => {
    const t = MODE_TOKENS[mode];
    const positive = t.green;
    const infoBlue = t.info;
    const severe = t.redLight; // Magnetic "severe" orange-red
    const negative = t.red;
    const deepRed = t.redSevere;
    const warning = t.orange;
    return {
        // HTTP status buckets
        '2xx': positive,
        '3xx': infoBlue,
        '4xx': severe,
        '5xx': negative,
        'Other': t.purple,
        'Success (2xx)': positive,
        'Redirect (3xx)': infoBlue,
        'Client Error (4xx)': severe,
        'Server Error (5xx)': negative,

        // Severity (HANA trace, dispatcher, generic)
        info: infoBlue,
        INFO: infoBlue,
        Info: infoBlue,
        warning,
        WARNING: warning,
        Warning: warning,
        warn: warning,
        error: negative,
        ERROR: negative,
        Error: negative,
        fatal: deepRed,
        FATAL: deepRed,
        Fatal: deepRed,
        critical: negative,
        CRITICAL: negative,
        Critical: negative,

        // Risk levels
        high: negative,
        High: negative,
        medium: severe,
        Medium: severe,
        low: infoBlue,
        Low: infoBlue,
    };
};

/** @deprecated Mode-blind snapshot (dark values) kept so stragglers compile;
 *  every live call site passes the active mode via `statusFieldColors(mode)`. */
export const STATUS_FIELD_COLORS: Record<string, string> = statusFieldColors('dark');

export const paletteColors = (
    palette?: ChartPalette,
    mode: ThemeMode = 'dark',
): string[] | undefined => {
    if (!palette || palette === 'neutral' || palette === 'status') return undefined;
    switch (palette) {
        case 'errors':
            return ERROR_PAIR_1[mode];
        case 'errors-2':
            return ERROR_PAIR_2[mode];
        case 'errors-3':
            return ERROR_PAIR_3[mode];
        case 'volume':
            return VOLUME_RAMP[mode];
        case 'auth':
            return AUTH_RAMP[mode];
        case 'categorical':
            // The Magnetic 11-color a–k dataviz accent palette (replaces the
            // legacy 14-color v0.0.4.2 ramp; charts cycle when they run out).
            return ACCENT_PALETTE[mode];
        default:
            return undefined;
    }
};
