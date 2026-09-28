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

/* The two colours in these ramps with NO token equivalent: an accent-c pink
 * and an accent-a indigo. Left as literals ON PURPOSE rather than mapped to
 * the nearest token, which would change the ramp. Everything else below is
 * token-derived so a palette swap carries into the charts -- before session
 * 129 these ramps were hardcoded Harbor hex and did not follow one. */
const RAMP_PINK: Record<ThemeMode, string> = { dark: '#fcb3c8', light: '#f2638c' };
const RAMP_INDIGO: Record<ThemeMode, string> = { dark: '#9ca6ff', light: '#7d8aff' };

// THE ONLY THREE permitted pairings for error / warning 2-series charts.
// Use exactly as defined — first color = first series, second color = second
// series. No other red/orange/yellow combinations are allowed on
// error / warning charts.
//   Pair 1 (errors)   — deep red + red        (redSevere + negative)
//   Pair 2 (errors-2) — red + salmon          (negative + accent-c pink)
//   Pair 3 (errors-3) — orange + red          (severe + negative)
const ERROR_PAIR_1: Record<ThemeMode, string[]> = {
    dark: [MODE_TOKENS.dark.redSevere, MODE_TOKENS.dark.red],
    light: [MODE_TOKENS.light.redSevere, MODE_TOKENS.light.red],
};
const ERROR_PAIR_2: Record<ThemeMode, string[]> = {
    dark: [MODE_TOKENS.dark.red, RAMP_PINK.dark],
    light: [MODE_TOKENS.light.red, RAMP_PINK.light],
};
const ERROR_PAIR_3: Record<ThemeMode, string[]> = {
    dark: [MODE_TOKENS.dark.redLight, MODE_TOKENS.dark.red],
    light: [MODE_TOKENS.light.redLight, MODE_TOKENS.light.red],
};

// Volume/throughput ramp: interact blue → accent-a indigo → teal → purple →
// muted gray. Blue-spectrum = "flow" per the dashboard conventions.
const VOLUME_RAMP: Record<ThemeMode, string[]> = {
    dark: [MODE_TOKENS.dark.cyanAccent, RAMP_INDIGO.dark, MODE_TOKENS.dark.teal, MODE_TOKENS.dark.purple, MODE_TOKENS.dark.textMuted],
    light: [MODE_TOKENS.light.cyanAccent, RAMP_INDIGO.light, MODE_TOKENS.light.teal, MODE_TOKENS.light.purple, MODE_TOKENS.light.textMuted],
};

// Auth ramp: severe orange → red → warning yellow → gold → deep red.
const AUTH_RAMP: Record<ThemeMode, string[]> = {
    dark: [MODE_TOKENS.dark.redLight, MODE_TOKENS.dark.red, MODE_TOKENS.dark.orangeLight, MODE_TOKENS.dark.yellow, MODE_TOKENS.dark.redSevere],
    light: [MODE_TOKENS.light.redLight, MODE_TOKENS.light.red, MODE_TOKENS.light.orange, MODE_TOKENS.light.orangeLight, MODE_TOKENS.light.redSevere],
};

/** Field-name → color map for status / severity / risk fields, per mode.
 *  Semantics: 2xx/success = positive green, 3xx/info/low = info blue,
 *  4xx/warning/medium = severe orange, 5xx/error/high = negative red,
 *  critical/fatal = deep red, Other = purple. Each word is listed in lower,
 *  Title and UPPER case -- a series name matches only exactly. */
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
        // critical outranks error/high, so it takes fatal's deep red. With it
        // on `negative`, Windows' severity vocabulary (critical / high /
        // medium / informational) drew critical and high in the IDENTICAL
        // red (measured session 132, Severity Distribution Over Time).
        critical: deepRed,
        CRITICAL: deepRed,
        Critical: deepRed,

        // Risk levels
        // UPPER case added session 132: HANA Audit's Risk-Tiered Event
        // Timeline emits HIGH / MEDIUM / LOW, which matched nothing here, so
        // Splunk's defaults drew HIGH purple and MEDIUM teal.
        high: negative,
        High: negative,
        HIGH: negative,
        medium: severe,
        Medium: severe,
        MEDIUM: severe,
        low: infoBlue,
        Low: infoBlue,
        LOW: infoBlue,
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

/* ------------------------------------------------------------------ */
/* Count-aware resolution (session 131)                                */
/* ------------------------------------------------------------------ */

/** The RAMP palettes: ordered shade sequences for series that form a SCALE
 *  (error severity, auth outcome, volume band). Their hue range is narrow on
 *  purpose — which is exactly what makes them unusable for naming arbitrary
 *  categories, and why a donut of usernames tagged `auth` reads as one
 *  orange ring. `status` is NOT here: it maps field VALUES to fixed colours
 *  rather than positions to shades. */
const RAMP_PALETTES: ReadonlySet<string> = new Set([
    'errors',
    'errors-2',
    'errors-3',
    'auth',
    'volume',
]);

export const isRampPalette = (palette?: ChartPalette): boolean =>
    palette != null && RAMP_PALETTES.has(palette);

/**
 * Palette resolution that knows how many series will actually be drawn.
 *
 * Splunk CYCLES `seriesColors`, so a palette shorter than the series count
 * silently repaints series N with series 0's colour. The three `errors*`
 * ramps are TWO colours each, so a 9-wedge donut tagged `errors` was drawn
 * in two alternating reds. Falling back to the 11-hue categorical palette
 * can only fire in cases that were already repeating, so it never makes a
 * chart worse than it was.
 *
 * Beyond 11 series even categorical cycles — unavoidable, and far better
 * than cycling at 2. Pie wedges are capped well below that upstream.
 */
export const paletteColorsFor = (
    seriesCount: number,
    palette?: ChartPalette,
    mode: ThemeMode = 'dark',
): string[] | undefined => {
    const chosen = paletteColors(palette, mode);
    if (!chosen) return undefined;
    if (seriesCount <= chosen.length) return chosen;
    return paletteColors('categorical', mode) ?? chosen;
};

/**
 * Wedge colours for a pie/donut.
 *
 * A wedge NAMES a category — a user, a sourcetype, a port — so a ramp is the
 * wrong instrument regardless of how many wedges there are, and the prompt
 * catalogue proves the mistake is easy to make: 14 of 26 pie prompts carry a
 * ramp chosen for the prompt's SUBJECT ("this one is about auth") rather than
 * for the shape of its data. Ramps are therefore ignored here.
 *
 * Deliberately still honoured: an explicit `categorical`, and `status`, whose
 * wedge values carry fixed meaning (2xx/4xx, INFO/ERROR) and which resolves
 * through the categorical fallback below.
 */
export const piePaletteColors = (
    wedgeCount: number,
    palette?: ChartPalette,
    mode: ThemeMode = 'dark',
): string[] | undefined => {
    const effective: ChartPalette = isRampPalette(palette) ? 'categorical' : palette ?? 'categorical';
    return paletteColorsFor(wedgeCount, effective, mode) ?? paletteColors('categorical', mode);
};
