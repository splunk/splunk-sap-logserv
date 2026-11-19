/**
 * aliasSeries.ts - the names a chart shows for its series when the series are
 * host values (TimeSeriesChart's `aliasSeries`, App build 400), and the
 * row-to-columnar step that draws the series under those names.
 *
 * Pure: no React, no DOM, no network, no imports. The namer is handed in: it is
 * useHostAlias().displayNames, which gives each raw value its name from
 * Settings > Host Names (two values that would share a name get their short
 * form or raw value after it). Display only: the values are always read under
 * the raw field names, and the search and its results keep the raw values.
 *
 * Without a namer (a chart without aliasSeries) every function here returns
 * what the chart built before build 400: the raw field names, the same array.
 */

/** Series names Splunk writes into chart results itself: "OTHER" (timechart /
 *  chart with useother, the default, beyond the series limit) and "NULL"
 *  (usenull), at their default otherstr and nullstr. Such a series adds up
 *  results that are not one host, so it never takes a host's name: it keeps the
 *  name Splunk gave it. A host whose value is exactly "OTHER" or "NULL" is not
 *  told apart from them, and is shown under its raw value too. */
export const SPLUNK_SERIES_NAMES: ReadonlyArray<string> = ['OTHER', 'NULL'];

/** True for a series name Splunk reserves (SPLUNK_SERIES_NAMES, exact case). */
export const isSplunkSeriesName = (field: string): boolean => SPLUNK_SERIES_NAMES.indexOf(field) !== -1;

/** useHostAlias().displayNames: one shown name per raw value, in order. */
// eslint-disable-next-line no-unused-vars -- a parameter name in a function type (the base rule is not TypeScript-aware)
export type SeriesNamer = (raws: string[]) => string[];

export interface ShownSeries {
    /** The name each value field is shown under: one per field, in the same
     *  order. Without a namer it is the valueKeys array itself. */
    shownKeys: string[];
    /** Raw value field -> shown name, for the colour map; null without a namer. */
    shownByRaw: Record<string, string> | null;
}

/** The namer's names for the value fields, Splunk's own series left as they are
 *  (they are not handed to the namer, so they take no name and take no part in
 *  its collision step); null when the namer does not give one name per field. */
const namedFields = (valueKeys: string[], namer: SeriesNamer): string[] | null => {
    if (!valueKeys.some(isSplunkSeriesName)) {
        return namer(valueKeys);
    }
    const hostKeys = valueKeys.filter((k) => !isSplunkSeriesName(k));
    const hostNames = namer(hostKeys);
    if (hostNames.length !== hostKeys.length) {
        return null;
    }
    let next = 0;
    return valueKeys.map((k) => {
        if (isSplunkSeriesName(k)) {
            return k;
        }
        const name = hostNames[next];
        next += 1;
        return name;
    });
};

/**
 * The names a chart shows for its value fields (the series).
 *
 * Without a namer: the value fields themselves (the same array) and no map.
 * With one: each field's name from the namer, except Splunk's own OTHER and NULL
 * series, which keep theirs. The names are used only when there is one per field,
 * none starts with '_' unless it is the field's own raw name (Splunk's charts
 * treat a field starting with '_' as internal and do not draw it), and no two are
 * the same (two series would merge); otherwise EVERY series keeps its raw name.
 * `shownByRaw` maps each raw field to the name it is shown under.
 */
export const shownSeriesNames = (valueKeys: string[], namer: SeriesNamer | null): ShownSeries => {
    if (namer === null) {
        return { shownKeys: valueKeys, shownByRaw: null };
    }
    const named = namedFields(valueKeys, namer);
    const namedOk =
        named !== null &&
        named.length === valueKeys.length &&
        named.every((n, i) => n === valueKeys[i] || (n.length > 0 && n.charAt(0) !== '_')) &&
        new Set(named).size === named.length;
    const shownKeys = namedOk && named !== null ? named : valueKeys;
    const shownByRaw: Record<string, string> = {};
    valueKeys.forEach((k, i) => {
        shownByRaw[k] = shownKeys[i];
    });
    return { shownKeys, shownByRaw };
};

/** The rows as a chart data source: one field per name in `shownNames` (by
 *  default the field names themselves) and one column per field, its values
 *  ALWAYS read from the rows under the raw field name at the same position. A
 *  missing or null value is null. */
export const rowsToColumnar = (
    rows: Array<Record<string, unknown>>,
    fieldNames: string[],
    shownNames: string[] = fieldNames
): { fields: { name: string }[]; columns: (string | number | null)[][] } => {
    const fields = shownNames.map((name) => ({ name }));
    const columns = fieldNames.map((name) =>
        rows.map((row) => {
            const v = row[name];
            if (v === null || typeof v === 'undefined') {
                return null;
            }
            return v as string | number;
        })
    );
    return { fields, columns };
};

/** A colour keyed by a raw value also colours the name the series is shown
 *  under: a copy of `colors` in which each such raw value's colour is also set
 *  under its shown name, where that differs from the raw value. */
export const withShownNames = (colors: Record<string, string>, shownByRaw: Record<string, string>): Record<string, string> => {
    const out = { ...colors };
    Object.keys(shownByRaw).forEach((raw) => {
        if (Object.prototype.hasOwnProperty.call(colors, raw) && shownByRaw[raw] !== raw) {
            out[shownByRaw[raw]] = colors[raw];
        }
    });
    return out;
};
