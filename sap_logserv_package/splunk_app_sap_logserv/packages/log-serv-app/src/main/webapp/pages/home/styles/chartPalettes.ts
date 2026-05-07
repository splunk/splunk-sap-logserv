/**
 * Semantic chart palettes for TimeSeriesChart and PieChart.
 *
 * Charts use the same colors when they show the same KIND of thing — errors
 * are always red-spectrum, throughput/volume always cyan/teal, auth always
 * orange, status codes follow a 2xx-green / 3xx-cyan / 4xx-orange / 5xx-red
 * convention. This lets users parse a dashboard at a glance: "this row is
 * red, so it's all errors".
 *
 * Apply via the `palette` prop on TimeSeriesChart / PieChart.
 *
 * For categorical fields with well-known names (status_cat 2xx/3xx/4xx/5xx,
 * severity info/warning/error/fatal, etc.) we map by field name via
 * `STATUS_FIELD_COLORS` so the color sticks to the meaning regardless of
 * series order in the SPL output.
 */
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
//   Pair 1 (errors)   — deep red + red
//   Pair 2 (errors-2) — red + salmon
//   Pair 3 (errors-3) — orange + red
const ERROR_PAIR_1 = ['#b50101', '#dc4e41']; // Pair 1
const ERROR_PAIR_2 = ['#dc4e41', '#ff7a6b']; // Pair 2
const ERROR_PAIR_3 = ['#f1813f', '#dc4e41']; // Pair 3

const VOLUME_RAMP = ['#0877a6', '#7ee8fa', '#00d4b4', '#9c6aff', '#cdd9e5'];
const AUTH_RAMP = ['#f1813f', '#dc4e41', '#f4a535', '#ffcc00', '#b50101'];

// High-variation 14-color ramp ported verbatim from v0.0.4.2
// `viz_category_trend.options.seriesColors`. Used for high-cardinality
// categorical breakdowns (ABAP wp_category_name, etc.) where the volume
// palette's 5 colors aren't enough to distinguish all series.
const CATEGORICAL_RAMP = [
    '#00d4b4', // teal
    '#9c6aff', // purple
    '#7ee8fa', // light cyan
    '#f4a535', // light orange
    '#5ac8fa', // sky blue
    '#4cd964', // green
    '#dc4e41', // red
    '#34aadc', // medium blue
    '#b97bff', // light purple
    '#ffcc00', // yellow
    '#32ade6', // cyan-blue
    '#ff9500', // orange
    '#dc4e41', // red (dup, matches v0.0.4.2)
    '#dc4e41', // red (dup, matches v0.0.4.2)
];

/** Field-name → color map for status / severity / risk fields. */
export const STATUS_FIELD_COLORS: Record<string, string> = {
    // HTTP status buckets
    '2xx': '#00d4b4',
    '3xx': '#0877a6',
    '4xx': '#f1813f',
    '5xx': '#dc4e41',
    'Other': '#9c6aff',
    'Success (2xx)': '#00d4b4',
    'Redirect (3xx)': '#0877a6',
    'Client Error (4xx)': '#f1813f',
    'Server Error (5xx)': '#dc4e41',

    // Severity (HANA trace, dispatcher, generic)
    info: '#0877a6',
    INFO: '#0877a6',
    Info: '#0877a6',
    warning: '#f1813f',
    WARNING: '#f1813f',
    Warning: '#f1813f',
    warn: '#f1813f',
    error: '#dc4e41',
    ERROR: '#dc4e41',
    Error: '#dc4e41',
    fatal: '#b50101',
    FATAL: '#b50101',
    Fatal: '#b50101',
    critical: '#dc4e41',
    CRITICAL: '#dc4e41',
    Critical: '#dc4e41',

    // Risk levels
    high: '#dc4e41',
    High: '#dc4e41',
    medium: '#f1813f',
    Medium: '#f1813f',
    low: '#0877a6',
    Low: '#0877a6',
};

export const paletteColors = (palette?: ChartPalette): string[] | undefined => {
    if (!palette || palette === 'neutral' || palette === 'status') return undefined;
    switch (palette) {
        case 'errors':
            return ERROR_PAIR_1;
        case 'errors-2':
            return ERROR_PAIR_2;
        case 'errors-3':
            return ERROR_PAIR_3;
        case 'volume':
            return VOLUME_RAMP;
        case 'auth':
            return AUTH_RAMP;
        case 'categorical':
            return CATEGORICAL_RAMP;
        default:
            return undefined;
    }
};
