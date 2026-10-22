/**
 * Tier 2: what the AI vendor is told about a tool result's columns - their
 * names, the `_time` range and the per-column aggregates (build 376,
 * session 149, rounds 5 to 8; review findings 0 and 8 of round 4, 0-4 and
 * 6-9 of round 5, 0, 1, 4 and 10 of round 6, 0-9 of round 7).
 *
 * Why this exists.
 * ----------------
 * Before this module the Tier 2 summary sent every column NAME and the
 * `_time` min / max strings exactly as Splunk returned them. Both can be
 * event data:
 *   - `timechart count by user`, `chart count over host by user`,
 *     `xyseries` and `transpose` turn the values of a field into column
 *     names, so usernames and hostnames went out as names even with PII
 *     redaction on;
 *   - `eval {f}=1` turns any text - up to a whole `_raw` - into a column
 *     name;
 *   - `timechart count by user | stats sum(*)` makes `sum(jsmith)`;
 *   - `_time` can be set by `eval` to any string;
 *   - value redaction keyed on the literal column name, so `values(user)`,
 *     `eval w=user."@".domain` or an alias sent the values in clear.
 *
 * The rules (the product owner's: text the model or the App wrote tells the
 * vendor nothing new; anything the App cannot prove safe is withheld):
 *   1. A column NAME reaches the vendor only when it is
 *        - FIXED: one of the names Splunk itself generates, listed in
 *          `FIXED_COLUMN_NAMES` (`count`, `percent`, `NULL`, `OTHER`, ...);
 *          or
 *        - AUTHORED: every word in it (a run of `[A-Za-z0-9_]`; `values(user)`
 *          is `values` and `user`) is a word of the AUTHOR TEXT - exactly,
 *          case included - and the name has a conservative shape: at most 40
 *          characters, an ordinary field name (`FIELD_NAME_RE`) or one
 *          function call over one (`fn(arg)`, `fn(*)`, `fn()`), or a display
 *          alias the author text writes in quotes after `AS` (`rename
 *          sourcetype AS "Source Type"`: words joined by single spaces,
 *          `QUOTED_ALIAS_RE`).
 *      The author text is the text the model or the App wrote for this call:
 *      the model's own query for `splunk_run_query` (all of it, quoted parts
 *      included), or the catalog SPL of the saved search that produced the
 *      result (all catalog SPL when the name is not the catalog's).
 *      Either way the hook's value filter (`sanitizeAggregateValue`, passed
 *      in as `sanitizeValue`) must leave the name unchanged.
 *      Any other name is replaced by `col_N`, N being the column's position
 *      among the result's columns that do not start with an underscore. The
 *      name itself is never echoed, in part or in full; one line says how
 *      many names were withheld.
 *   2. At most `MAX_SUMMARY_COLUMNS` columns are summarized; the rest are
 *      reported only as a count ("N more columns not summarized.").
 *   3. VALUES fail closed (round 8). Each author text is read as a pipeline,
 *      command by command (`traceColumn`), and a column is TRACED when its
 *      definition resolves entirely through constructs the reader fully
 *      understands:
 *        - the field itself, by its own name (a by / over / top / rare /
 *          table / fields / stats-by field, a raw or lookup field);
 *        - a statistics function over one field, nested or not
 *          (`latest(user)`, `values(Authentication.user)`), with or without
 *          `AS alias`; `field AS alias`; a rename without wildcards; a lookup
 *          `OUTPUT field [AS alias]`;
 *        - `eval x=<one bare field name or one single-quoted field
 *          reference>` (`eval w=user`, `eval w='Authentication.user'`);
 *        - a count (`count`, `dc(...)`, `count(eval(...))`, top / rare's
 *          `count` and `percent`): its values are counts, not identifiers.
 *      Anything else makes the column UNTRACED: any other eval expression
 *      (`.` concatenation and function calls included), `strcat`, `rex`,
 *      `spath`, a wildcard rename or `AS` (`rename user* AS w*`,
 *      `values(*) AS *_x`), a dynamic eval target (`eval {f}=...`), the
 *      cells of a `chart` / `timechart` / `xyseries` split-by column, the
 *      columns of `transpose` / `untable` / `fieldsummary`, two different
 *      definitions of one name, a column a subsearch defines (`append`,
 *      `join`, ...), a command the reader does not know, a text longer than
 *      `MAX_QUERY_CHARS`, more than `MAX_TRACE_COMMANDS` commands or
 *      subsearches deeper than `MAX_SUBSEARCH_DEPTH`.
 *   4. With PII redaction on, a TEXT column's values are sent only when the
 *      column is named, traced, not a pivot cell, and none of its source
 *      fields (nor its own name) marks an identifier
 *      (`isIdentifierColumnName`: the piiRedaction name patterns - user,
 *      users, *_ip(s), email, mac, account, src / dest / dvc,
 *      TargetUserName, dotted CIM names such as `Authentication.user`,
 *      host(s) when hostnames are redacted - plus id / uuid / ssn / phone /
 *      employee_id / ...). Every other text column has every value
 *      redacted to a stable tag. With redaction off, values are sent as
 *      before (filtered and capped).
 *   5. NUMERIC columns keep min / max / avg / sum unless, with redaction on,
 *      the column is not a count and its own name or one of the fields its
 *      definition may read marks an identifier (for an untraced column every
 *      field it may read is checked - for an opaque construct, every word
 *      of the author text), or its values mix many fields (`transpose`,
 *      `untable`, `fieldsummary`). A constant whose name is withheld or that
 *      marks an identifier is withheld, redaction on or off.
 *   6. The `_time` range is sent only when EVERY `_time` value parses as an
 *      epoch (seconds, 0 .. 2100-01-01) or a strict ISO-8601 timestamp with
 *      a zone; it is then rendered by the App as two ISO-8601 UTC strings
 *      built from the parsed numbers (`new Date(ms).toISOString()`), and the
 *      line says `(UTC)` - no zone from the data. One value that does not
 *      parse withholds the range ("not shown"). Build 377: and only when the
 *      author text traces `_time` to a time source field (TIME_SOURCE_FIELDS:
 *      `_time`, `bucket_ts`, `day_ts` - `timechart`, `bin _time`, `tstats ...
 *      by _time`, `eval _time=bucket_ts`, `rename bucket_ts AS _time`); a
 *      `_time` the query computes from other fields
 *      (`eval _time=len(src_ip)*100000000`) is withheld with
 *      TIME_NOT_SHOWN_COMPUTED.
 *   7. Categorical VALUES: top-N, through the hook's `sanitizeAggregateValue`
 *      (passed in as `sanitizeValue`), then rule 4, then a 40-character cap,
 *      within a 160-character line.
 *
 * Build 377 (the Tier 2 known gaps of build 376):
 *   - a single-quoted token is a field reference only (no `|`, bracket,
 *     quote or line break inside), so a stray apostrophe cannot hide the
 *     pipes from the reader (the guard refuses such a query anyway);
 *   - `rex` reads `(?'name')` groups as well as `(?<name>)` / `(?P<name>)`;
 *     the words of its pattern, of an spath path and of an eval string
 *     literal count as fields the column may read (`ssn`, `user.id`); rex
 *     and spath keep the earlier value of their output (they set it only
 *     where they match);
 *   - `fieldformat` leaves the column untraced, reading both definitions;
 *   - a lookup OUTPUT field inherits the fields it was matched on
 *     (`lookup ip_map ip AS src_ip OUTPUT hostname` reads `src_ip`), an
 *     output that echoes a match field is that field, except the curated
 *     threat-intel metadata (CURATED_LOOKUP_OUTPUTS);
 *   - a distinct count (`dc`, `estdc`) is a count only over a traced field;
 *   - `appendpipe [...]` starts with a command, never an implicit search;
 *   - `top 10 uri` (a positional limit) is read; more than
 *     MAX_WILDCARD_PATTERNS wildcard definitions in one text leave every
 *     column untraced (they cost 2^k to resolve);
 *   - the App's own field names are classified one by one
 *     (utils/fieldClassification.ts) on top of the name patterns;
 *   - security review of build 377: `makemv` is read like `rex` (its values
 *     are substrings of the field, cut by a delimiter or a tokenizer regex:
 *     untraced, reading the field and the words of the delimiter /
 *     tokenizer); `bin` / `bucket` with `AS` is a new definition of the alias
 *     (`bin n AS _time` no longer leaves `_time` traced to `_time`); stacked
 *     `appendpipe` groups share one definition function evaluated once per
 *     name (memoDef), so their cost is linear, not 2^k.
 *
 * What this does not do: Tier 2 sends aggregated event values by design. A
 * field held by a name that marks no identifier - a raw field the search
 * extracts, a lookup column, or `stats count by w` over a field `w` an event
 * carries - is sent as it is. PII redaction is name-based hygiene for
 * ordinary queries, not a content filter. Counts can still carry a few bits
 * a query manufactures (`stats count by <a computed multivalue>` then
 * `stats count`, counts of filtered rows): documented, not traced.
 *
 * Pure: no React, no JSON import - loadable by bin/check-diagnostics.js.
 */
import { isPiiColumn, redactValueIfPII, PiiRedactionOptions } from './piiRedaction';
import { isClassifiedIdentifier } from './fieldClassification';

/** An ordinary field name: the shape of a sendable name that is not a call. */
export const FIELD_NAME_RE = /^[A-Za-z_][A-Za-z0-9_.:-]{0,39}$/;

/** One function call over one field-name-shaped argument, `*` or nothing. */
export const FUNCTION_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*\((?:[A-Za-z_][A-Za-z0-9_.:-]*|\*)?\)$/;

/** A display alias the author text quotes after `AS`: words joined by single spaces. */
export const QUOTED_ALIAS_RE = /^[A-Za-z_][A-Za-z0-9_.:-]*(?: [A-Za-z0-9_.:-]+)*$/;

/** The longest name sent. */
export const MAX_NAME_CHARS = 40;

/** A word of a column name or of the author text. */
export const NAME_WORD_RE = /[A-Za-z0-9_]+/g;

const STAT_FUNCTIONS = [
    'c', 'count', 'dc', 'distinct_count', 'estdc', 'estdc_error', 'avg', 'mean', 'sum', 'sumsq', 'min', 'max',
    'range', 'median', 'mode', 'stdev', 'stdevp', 'var', 'varp', 'first', 'last', 'earliest', 'latest',
    'earliest_time', 'latest_time', 'values', 'list', 'rate', 'rate_avg', 'rate_sum', 'per_second', 'per_minute',
    'per_hour', 'per_day', 'p[1-9][0-9]?', 'perc[1-9][0-9]?', 'exactperc[1-9][0-9]?', 'upperperc[1-9][0-9]?',
].join('|');

/** A statistics-function NAME on its own (`avg`, `perc95`). */
const STAT_FUNCTION_WORD_RE = new RegExp(`^(?:${STAT_FUNCTIONS})$`);

/** A counting function: its value is a count, never an identifier. */
export const COUNT_FUNCTION_RE = /^(?:c|count|dc|distinct_count|estdc|estdc_error)$/;

/** An eval expression that is one bare field name (no `.`, `-` or `:`: those are operators in eval). */
const BARE_FIELD_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Column names Splunk itself generates (stats / top / rare / timechart /
 * transpose / addtotals / fieldsummary), sent whatever the author text says.
 */
export const FIXED_COLUMN_NAMES: ReadonlySet<string> = new Set<string>([
    'count', 'percent', 'total', 'Total', 'NULL', 'OTHER', 'column', 'sum', 'avg', 'min', 'max', 'dc', 'values',
    'earliest', 'latest', 'first', 'last', 'median', 'mode', 'stdev', 'range', 'rate', 'field', 'distinct_count',
    'is_exact', 'numeric_count', 'mean',
]);

export const MAX_SUMMARY_COLUMNS = 30;
export const PLACEHOLDER_PREFIX = 'col_';
export const VALUE_MAX_CHARS = 40;
export const MAX_LINE_CHARS = 160;
/** 2100-01-01T00:00:00Z - the latest epoch second accepted as a `_time`. */
export const MAX_EPOCH_SECONDS = 4102444800;
/** The longest author text read, per text; a longer text leaves every column untraced. */
export const MAX_QUERY_CHARS = 20000;
/** The most fields one untraced definition lists; past it, every word of the text. */
export const MAX_SOURCE_STEPS = 64;
/** The most commands read per text, subsearches included; past it, every column is untraced. */
export const MAX_TRACE_COMMANDS = 256;
/** The deepest subsearch read; deeper, every column is untraced. */
export const MAX_SUBSEARCH_DEPTH = 8;
/**
 * The column name the values of a redacted column are redacted under (rule
 * 4): a piiRedaction name pattern, so every value becomes a tag.
 */
export const PII_STAND_IN_COLUMN = 'user';

export const TIME_NOT_SHOWN = 'Time range: not shown (the _time values are not all timestamps).';

/** Build 377: the line when `_time` is not traced to a time source field. */
export const TIME_NOT_SHOWN_COMPUTED = 'Time range: not shown (the query computes _time from other fields).';

/** Build 377: the fields a `_time` may be traced to for its range to be sent (the App rollups' epochs). */
export const TIME_SOURCE_FIELDS: ReadonlySet<string> = new Set<string>(['_time', 'bucket_ts', 'day_ts']);

/** Build 377: the most wildcard definitions one text may hold; past it, every column is untraced. */
export const MAX_WILDCARD_PATTERNS = 12;

/**
 * Build 377: the outputs of the App's curated threat-intel lookups that
 * keep their own trace (they do not inherit the field the lookup matched
 * on): the category, source and date the customer's feed curates. The
 * `notes` columns are free text that can name a person, and inherit.
 */
export const CURATED_LOOKUP_OUTPUTS: Readonly<Record<string, ReadonlyArray<string>>> = Object.freeze({
    logserv_ti_malicious_ips: ['category', 'source', 'added_date'],
    logserv_ti_malicious_domains: ['category', 'source', 'added_date'],
    logserv_ti_compromised_credentials: ['added_date'],
});

/* ------------------------------------------------------------ tokens */

interface QueryToken {
    text: string;
    kind: 'word' | 'quoted' | 'other';
    start: number;
    end: number;
}

/*
 * Build 377: a single-quoted token is a field reference only - it can never
 * hold a `|`, a bracket, a double quote or a line break - so any other `'`
 * is a one-character token and the pipes after it stay visible (the guard,
 * utils/splGuard.ts, refuses such a query outright).
 */
const QUERY_TOKEN_RE = /"(?:[^"\\]|\\.)*"|'[^'|[\]"\r\n]*'|`[^`]*`|[A-Za-z_][A-Za-z0-9_.:-]*|\S/g;

const tokenize = (s: string): QueryToken[] => {
    const toks: QueryToken[] = [];
    const re = new RegExp(QUERY_TOKEN_RE.source, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(s)) !== null) {
        const text = m[0];
        const c = text.charAt(0);
        let kind: QueryToken['kind'] = 'other';
        if ((c === '"' || c === "'") && text.length >= 2 && text.charAt(text.length - 1) === c) kind = 'quoted';
        else if (/^[A-Za-z_]/.test(text)) kind = 'word';
        toks.push({ text, kind, start: m.index, end: m.index + text.length });
    }
    return toks;
};

const nameOf = (t: QueryToken | undefined): string | null => {
    if (!t) return null;
    if (t.kind === 'word') return t.text;
    if (t.kind === 'quoted') return t.text.slice(1, -1).replace(/\\(.)/g, '$1');
    return null;
};

const isWord = (t: QueryToken | undefined, w: string): boolean =>
    !!t && t.kind === 'word' && t.text.toLowerCase() === w;

/**
 * A field name or glob at `j`: a quoted token, or adjacent word and `*`
 * tokens joined (`user*`, `*_x`, `Authentication.*`); null when neither.
 */
const readGlobName = (toks: QueryToken[], j: number, b: number): { name: string; next: number } | null => {
    if (j >= b) return null;
    if (toks[j].kind === 'quoted') return { name: nameOf(toks[j]) as string, next: j + 1 };
    let e = j;
    let out = '';
    while (e < b && (toks[e].kind === 'word' || toks[e].text === '*') && (e === j || toks[e].start === toks[e - 1].end)) {
        out += toks[e].text;
        e += 1;
    }
    return e === j ? null : { name: out, next: e };
};

/* ------------------------------------------------------------ traces */

/** How one column's values are defined (rule 3). */
export interface ColumnTrace {
    /** True when the definition resolves entirely through understood constructs. */
    traced: boolean;
    /** True when every definition is a count. */
    count: boolean;
    /** True for the cells of a chart / timechart / xyseries split-by column. */
    cell: boolean;
    /** True when the values mix many fields (transpose, untable, fieldsummary). */
    mixed: boolean;
    /**
     * Traced: the source fields the values come from. Untraced: every field
     * the definition may read (an opaque construct: every word of the text).
     */
    fields: ReadonlyArray<string>;
    /** Why the column is untraced; '' when traced. */
    why: string;
}

const COUNT_TRACE: ColumnTrace = { traced: true, count: true, cell: false, mixed: false, fields: [], why: '' };

const baseTrace = (name: string): ColumnTrace => ({
    traced: true, count: false, cell: false, mixed: false, fields: [name], why: '',
});

const uniqSorted = (xs: ReadonlyArray<string>): string[] => Array.from(new Set(xs)).sort();

/** One author text being read. */
interface Scope {
    s: string;
    toks: QueryToken[];
    /** Every word of the text: what an opaque construct may read. */
    words: string[];
    commands: number;
    over: boolean;
    /** Build 377: the wildcard definitions this text has added (capped at MAX_WILDCARD_PATTERNS). */
    patternCount?: number;
}

const untraced = (scope: Scope, why: string, fields: ReadonlyArray<string>, mixed = false, count = false): ColumnTrace => {
    let f = uniqSorted(fields);
    let w = why;
    if (f.length > MAX_SOURCE_STEPS) {
        f = scope.words.slice();
        w = `${why} (more than ${MAX_SOURCE_STEPS} fields: every word of the text)`;
    }
    return { traced: false, count, cell: false, mixed, fields: f, why: w };
};

const opaque = (scope: Scope, why: string, mixed = false): ColumnTrace => untraced(scope, why, scope.words, mixed);

const sameTrace = (a: ColumnTrace, b: ColumnTrace): boolean => a === b || (a.traced === b.traced && a.count === b.count
    && a.cell === b.cell && a.mixed === b.mixed && a.fields.join('\u0000') === b.fields.join('\u0000'));

/**
 * Two definitions of one name: equal, both counts, or untraced (the reason
 * an untraced one gives, else "several definitions").
 */
const mergeTraces = (scope: Scope, a: ColumnTrace, b: ColumnTrace): ColumnTrace => {
    if (sameTrace(a, b)) return a;
    if (a.count && b.count) {
        return {
            traced: a.traced && b.traced, count: true, cell: a.cell || b.cell, mixed: false, fields: [],
            why: a.why || b.why,
        };
    }
    return untraced(scope, a.why || b.why || 'several definitions', [...a.fields, ...b.fields], a.mixed || b.mixed);
};

const mergeNullable = (scope: Scope, a: ColumnTrace | null, b: ColumnTrace | null): ColumnTrace | null => {
    if (a === null) return b;
    if (b === null) return a;
    return mergeTraces(scope, a, b);
};

const forceUntraced = (t: ColumnTrace, why: string): ColumnTrace =>
    (t.traced ? { traced: false, count: t.count, cell: false, mixed: t.mixed, fields: t.fields, why } : t);

/* ------------------------------------------------------------- state */

interface Pattern {
    re: RegExp;
    at: (m: RegExpExecArray) => ColumnTrace;
}

/** The fields at one point of a pipeline. */
interface FieldState {
    /** Names the pipeline defined so far. */
    env: Map<string, ColumnTrace>;
    /** Wildcard definitions (`rename user* AS w*`, `eval {f}=...`). */
    patterns: Pattern[];
    /** Any other name: a raw field (`baseTrace`), nothing (null) or a pivot cell / opaque. */
    def: (name: string) => ColumnTrace | null;
}

const rawState = (): FieldState => ({ env: new Map(), patterns: [], def: baseTrace });

const copyState = (st: FieldState): FieldState => ({ env: new Map(st.env), patterns: st.patterns.slice(), def: st.def });

/**
 * A definition function evaluated at most once per name. Security review of
 * build 377: an appendpipe group copies the pipeline's state, so the group's
 * definition function and the pipeline's both call the one before them; k
 * stacked groups that each wrap it (an spath, a lookup without OUTPUT) made a
 * column the text does not define cost 2^k calls - 22 groups froze the tab
 * for 30 s. Each group now shares one memoised function, so the cost is
 * linear. Definition functions are pure (they read only the text's words
 * and the traces they close over), so the memo changes no result.
 */
const memoDef = (def: (name: string) => ColumnTrace | null): ((name: string) => ColumnTrace | null) => {
    const seen = new Map<string, ColumnTrace | null>();
    return (name: string) => {
        if (seen.has(name)) return seen.get(name) as ColumnTrace | null;
        const t = def(name);
        seen.set(name, t);
        return t;
    };
};

const lookupIn = (scope: Scope, st: FieldState, name: string): ColumnTrace | null => {
    const e = st.env.get(name);
    if (e) return e;
    let out = st.def(name);
    for (const p of st.patterns) {
        const m = p.re.exec(name);
        if (m) out = mergeNullable(scope, out, p.at(m));
    }
    return out;
};

/** A field read at this point: an absent one is untraced (fail closed). */
const sourceOf = (scope: Scope, st: FieldState, name: string): ColumnTrace =>
    lookupIn(scope, st, name) || untraced(scope, 'not a field at this point', [name]);

/** A command the reader does not fully understand: every column is untraced. */
const opaqueAll = (scope: Scope, st: FieldState, why: string, mixed = false): void => {
    const o = opaque(scope, why, mixed);
    st.env.forEach((v, k) => st.env.set(k, mergeTraces(scope, v, o)));
    const old = st.def;
    st.def = (n: string) => {
        const d = old(n);
        return d ? mergeTraces(scope, d, o) : o;
    };
};

const addPattern = (scope: Scope, st: FieldState, re: RegExp, at: (m: RegExpExecArray) => ColumnTrace): void => {
    // Build 377: each pattern resolves through the ones before it, so k
    // stacked wildcard definitions cost 2^k per column; past the cap every
    // column is untraced instead.
    scope.patternCount = (scope.patternCount || 0) + 1;
    if (scope.patternCount > MAX_WILDCARD_PATTERNS) {
        opaqueAll(scope, st, `more than ${MAX_WILDCARD_PATTERNS} wildcard definitions`);
        return;
    }
    st.patterns.push({ re, at });
    st.env.forEach((v, k) => {
        const m = re.exec(k);
        if (m) st.env.set(k, mergeTraces(scope, v, at(m)));
    });
};

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A glob (`user*`, `*_x`) as an anchored regular expression, one group per `*`. */
const globRe = (p: string): RegExp => new RegExp(`^${p.split('*').map(escapeRe).join('([\\s\\S]*)')}$`);

/** The name a glob's captures give in another glob, or null when the stars do not pair up. */
const substGlob = (p: string, m: RegExpExecArray): string | null => {
    const parts = p.split('*');
    if (parts.length !== m.length) return null;
    let out = parts[0];
    for (let i = 1; i < parts.length; i += 1) out += `${m[i]}${parts[i]}`;
    return out;
};

/* ------------------------------------------------------------ reader */

/*
 * Commands that change no column's definition. Security review of build 377:
 * `makemv` is not one of them - it cuts a field's value into substrings by a
 * delimiter or a tokenizer regex (an extraction, like rex) - and has its own
 * case in readCommand. `nomv` and `mvcombine` only join values the field
 * already held.
 */
const KEEP_COMMANDS: ReadonlySet<string> = new Set<string>([
    'search', 'where', 'regex', 'sort', 'head', 'tail', 'dedup', 'reverse', 'uniq', 'fields', 'table', 'fillnull',
    'filldown', 'addinfo', 'mvexpand', 'nomv', 'mvcombine', 'makeresults', 'noop',
]);

const APPEND_COMMANDS: ReadonlySet<string> = new Set<string>([
    'append', 'appendcols', 'join', 'union', 'multisearch', 'set',
]);

/**
 * Every command `readCommand` reads (the others make every column untraced).
 * Exported for the guard's suite: every command on splGuard's allow-list is
 * one of these (build 377).
 */
export const KNOWN_COMMANDS: ReadonlySet<string> = new Set<string>([
    ...Array.from(KEEP_COMMANDS), ...Array.from(APPEND_COMMANDS), 'eval', 'fieldformat', 'rename', 'stats', 'tstats',
    'eventstats', 'streamstats', 'chart', 'timechart', 'xyseries', 'untable', 'transpose', 'fieldsummary', 'top', 'rare',
    'lookup', 'inputlookup', 'rex', 'spath', 'strcat', 'bin', 'bucket', 'convert', 'transaction', 'iplocation',
    'addtotals', 'addcoltotals', 'appendpipe', 'foreach', 'map', 'makemv',
]);

/** Past a `name=value` option: the `=` and the value's adjacent tokens. */
const skipOption = (toks: QueryToken[], j: number, b: number): number => {
    let e = j + 2;
    while (e + 1 < b && toks[e + 1].start === toks[e].end) e += 1;
    return Math.min(e + 1, b);
};

const isOption = (toks: QueryToken[], j: number, b: number): boolean =>
    toks[j].kind === 'word' && j + 1 < b && toks[j + 1].text === '=' && !(j + 2 < b && toks[j + 2].text === '=');

/** The index of the bracket closing the one at `open`, or `b - 1`. */
const closingAt = (toks: QueryToken[], open: number, b: number): number => {
    let depth = 0;
    for (let e = open; e < b; e += 1) {
        const x = toks[e].text;
        if (x === '(' || x === '[') depth += 1;
        else if (x === ')' || x === ']') {
            depth -= 1;
            if (depth === 0) return e;
        }
    }
    return b - 1;
};

/** The options of a command (`name=value`), lower-cased names, values unquoted. */
const readOptions = (toks: QueryToken[], a: number, b: number): Map<string, string> => {
    const out = new Map<string, string>();
    for (let j = a; j < b; j += 1) {
        if (isOption(toks, j, b)) out.set(toks[j].text.toLowerCase(), nameOf(toks[j + 2]) ?? (toks[j + 2] ? toks[j + 2].text : ''));
    }
    return out;
};

/** The non-option word / quoted tokens of a command, commas skipped; null on any other token. */
const plainArgs = (toks: QueryToken[], a: number, b: number): QueryToken[] | null => {
    const out: QueryToken[] = [];
    for (let j = a; j < b;) {
        if (isOption(toks, j, b)) {
            j = skipOption(toks, j, b);
        } else if (toks[j].text === ',') {
            j += 1;
        } else if (toks[j].kind === 'word' || toks[j].kind === 'quoted') {
            out.push(toks[j]);
            j += 1;
        } else {
            return null;
        }
    }
    return out;
};

/**
 * The fields an expression may read: every word outside double-quoted
 * strings (`user."@".host` reads `user` and `host`), the contents of
 * single quotes (eval's field references), and what those resolve to. A
 * macro reads anything: every word of the text. Build 377: the words of
 * double-quoted literals count too, as they are - not resolved as fields -
 * so `eval n=if(x="ssn", ...)` marks the column by `ssn` (the identifier
 * check only; such a column is untraced already).
 */
const expressionFields = (scope: Scope, st: FieldState, toks: ReadonlyArray<QueryToken>): { fields: string[]; mixed: boolean } => {
    const cands: string[] = [];
    const literal: string[] = [];
    for (const t of toks) {
        if (t.text.charAt(0) === '`') return { fields: scope.words.slice(), mixed: false };
        if (t.kind === 'word') {
            cands.push(t.text);
            (t.text.match(NAME_WORD_RE) || []).forEach((w) => cands.push(w));
        } else if (t.kind === 'quoted' && t.text.charAt(0) === "'") {
            const n = nameOf(t) as string;
            cands.push(n);
            (n.match(NAME_WORD_RE) || []).forEach((w) => cands.push(w));
        } else if (t.kind === 'quoted') {
            (t.text.match(NAME_WORD_RE) || []).forEach((w) => literal.push(w));
        }
    }
    const out: string[] = [];
    let mixed = false;
    for (const c of uniqSorted(cands)) {
        out.push(c);
        const tr = lookupIn(scope, st, c);
        if (tr) {
            tr.fields.forEach((f) => out.push(f));
            if (tr.mixed) mixed = true;
        }
    }
    literal.forEach((w) => out.push(w));
    return { fields: out, mixed };
};

const untracedExpr = (scope: Scope, st: FieldState, why: string, toks: ReadonlyArray<QueryToken>, extra: string[] = []): ColumnTrace => {
    const e = expressionFields(scope, st, toks);
    return untraced(scope, why, [...extra, ...e.fields], e.mixed);
};

/** One aggregation of a stats-family command. */
interface Aggregation {
    /** The column name Splunk gives it without an alias (the text as written). */
    name: string;
    alias: string | null;
    fn: string | null;
    /** The argument tokens [from, to) of a call. */
    from: number;
    to: number;
}

interface StatsArgs {
    aggs: Aggregation[];
    over: string[];
    by: string[];
}

/** A stats / eventstats / streamstats / tstats / chart / timechart argument list, or null when malformed. */
const readStatsArgs = (scope: Scope, a: number, b: number): StatsArgs | null => {
    const { toks, s } = scope;
    const out: StatsArgs = { aggs: [], over: [], by: [] };
    let mode: 'aggs' | 'over' | 'by' = 'aggs';
    let j = a;
    while (j < b) {
        const t = toks[j];
        const tl = t.kind === 'word' ? t.text.toLowerCase() : '';
        if (isOption(toks, j, b)) {
            j = skipOption(toks, j, b);
            continue;
        }
        if (t.text === ',') {
            j += 1;
            continue;
        }
        if (tl === 'by') {
            mode = 'by';
            j += 1;
            continue;
        }
        if (mode === 'aggs' && tl === 'over') {
            mode = 'over';
            j += 1;
            continue;
        }
        if (tl === 'where') {
            // tstats WHERE ... BY; timechart ... BY x WHERE <filter>
            if (mode !== 'aggs') return out;
            j += 1;
            while (j < b && !isWord(toks[j], 'by')) j = toks[j].text === '(' || toks[j].text === '[' ? closingAt(toks, j, b) + 1 : j + 1;
            continue;
        }
        if (mode === 'aggs' && tl === 'from') {
            // tstats FROM datamodel=X / FROM datamodel:X
            j += 1;
            if (j < b && isOption(toks, j, b)) j = skipOption(toks, j, b);
            else while (j + 1 < b && toks[j + 1].start === toks[j].end) j += 1;
            if (j < b && !isOption(toks, j, b) && toks[j].kind === 'word' && !isWord(toks[j], 'by')
                && !isWord(toks[j], 'where')) j += 1;
            continue;
        }
        if (mode === 'aggs') {
            let agg: Aggregation;
            if (t.kind === 'word' && j + 1 < b && toks[j + 1].text === '(' && toks[j + 1].start === t.end) {
                const e = closingAt(toks, j + 1, b);
                agg = { name: s.slice(t.start, toks[e].end), alias: null, fn: t.text, from: j + 2, to: e };
                j = e + 1;
            } else if (t.kind === 'word') {
                agg = { name: t.text, alias: null, fn: null, from: j, to: j };
                j += 1;
            } else {
                return null;
            }
            if (j < b && isWord(toks[j], 'as')) {
                const alias = readGlobName(toks, j + 1, b);
                if (alias === null) return null;
                agg.alias = alias.name;
                j = alias.next;
            }
            out.aggs.push(agg);
            continue;
        }
        const f = nameOf(t);
        if (f === null) return null;
        (mode === 'over' ? out.over : out.by).push(f);
        j += 1;
    }
    return out;
};

/**
 * A statistics function over tokens [from, to): one field (`latest(user)`),
 * a field named like a call (`latest(values(user))` after a `stats
 * values(user)`), a nested statistics function, or a count.
 */
const callTrace = (scope: Scope, st: FieldState, fn: string, from: number, to: number): ColumnTrace => {
    const { toks, s } = scope;
    const inner = toks.slice(from, to);
    if (COUNT_FUNCTION_RE.test(fn)) {
        // Build 377: `c` / `count` count rows. A distinct count is a count
        // only over a traced field: over a field the query computes
        // (`eval r=mvrange(0,len(user)) | stats dc(r)`) it can carry the
        // computed number, and reads what that field reads.
        if (fn === 'c' || fn === 'count') return COUNT_TRACE;
        if (inner.length === 1 && (inner[0].kind === 'word' || inner[0].kind === 'quoted')) {
            const f = nameOf(inner[0]) as string;
            const src = sourceOf(scope, st, f);
            if (src.traced && !src.mixed && !src.cell) return COUNT_TRACE;
            return untraced(scope, 'a distinct count of a computed field', [f, ...src.fields], src.mixed);
        }
        return untracedExpr(scope, st, `an expression in ${fn}()`, inner);
    }
    if (STAT_FUNCTION_WORD_RE.test(fn)) {
        if (inner.length === 1 && (inner[0].kind === 'word' || inner[0].kind === 'quoted')) {
            return sourceOf(scope, st, nameOf(inner[0]) as string);
        }
        if (inner.length >= 3 && inner[0].kind === 'word' && inner[1].text === '(' && inner[1].start === inner[0].end
            && closingAt(toks, from + 1, to) === to - 1) {
            const named = st.env.get(s.slice(inner[0].start, inner[inner.length - 1].end));
            return named || callTrace(scope, st, inner[0].text, from + 2, to - 1);
        }
    }
    return untracedExpr(scope, st, `an expression in ${fn}()`, inner);
};

/** What one aggregation's values are (rule 3). */
const aggregationTrace = (scope: Scope, st: FieldState, g: Aggregation): ColumnTrace => {
    if (g.fn === null) {
        return COUNT_FUNCTION_RE.test(g.name) ? COUNT_TRACE : untraced(scope, 'a bare word', [g.name, ...sourceOf(scope, st, g.name).fields]);
    }
    return callTrace(scope, st, g.fn, g.from, g.to);
};

/** A wildcard aggregation (`values(*)`, `values(*) AS *_x`, `sum(*)`): a pattern. */
const wildcardAggregation = (scope: Scope, st: FieldState, g: Aggregation, into: FieldState): boolean => {
    const arg = g.fn !== null ? scope.s.slice(scope.toks[g.from] ? scope.toks[g.from].start : 0, scope.toks[g.to] ? scope.toks[g.to].start : 0) : '';
    const aliasStar = g.alias !== null && g.alias.indexOf('*') !== -1;
    if (arg.indexOf('*') === -1 && !aliasStar && g.name.indexOf('*') === -1) return false;
    const snap = copyState(st);
    const out = g.alias !== null ? g.alias : g.name;
    const argOnly = arg.trim();
    const counting = g.fn !== null && COUNT_FUNCTION_RE.test(g.fn);
    addPattern(scope, into, globRe(out), (m) => {
        if (counting) return COUNT_TRACE;
        const src = argOnly.indexOf('*') !== -1 ? substGlob(argOnly, m) : null;
        if (src === null || !/^[A-Za-z_][A-Za-z0-9_.:-]*$/.test(src)) return opaque(scope, 'a wildcard aggregation');
        const tr = sourceOf(scope, snap, src);
        return untraced(scope, 'a wildcard aggregation', [src, ...tr.fields], tr.mixed);
    });
    return true;
};

const setDefinition = (scope: Scope, st: FieldState, name: string, t: ColumnTrace, mergeExisting: boolean): void => {
    const prev = st.env.get(name);
    st.env.set(name, mergeExisting && prev ? mergeTraces(scope, prev, t) : t);
};

/** Merge what a subsearch or sub-pipeline outputs into the main pipeline. */
const mergeSub = (scope: Scope, st: FieldState, sub: FieldState, orig: FieldState | null): void => {
    const subDefined = (n: string, t: ColumnTrace): ColumnTrace =>
        (sameTrace(t, baseTrace(n)) ? t : forceUntraced(t, 'defined in a subsearch'));
    const newPatterns = sub.patterns.filter((p) => !orig || orig.patterns.indexOf(p) === -1);
    const subLook = (n: string): ColumnTrace | null => {
        const e = sub.env.get(n);
        if (e) return orig && orig.env.get(n) === e ? null : subDefined(n, e);
        let out = orig && sub.def === orig.def ? null : sub.def(n);
        for (const p of newPatterns) {
            const m = p.re.exec(n);
            if (m) out = mergeNullable(scope, out, forceUntraced(p.at(m), 'defined in a subsearch'));
        }
        return out;
    };
    const names = new Set<string>();
    st.env.forEach((_v, k) => names.add(k));
    sub.env.forEach((_v, k) => names.add(k));
    const oldDef = st.def;
    const oldLook = (n: string): ColumnTrace | null => lookupIn(scope, st, n);
    const merged = new Map<string, ColumnTrace>();
    names.forEach((n) => {
        const r = mergeNullable(scope, oldLook(n), subLook(n));
        if (r) merged.set(n, r);
    });
    st.env = merged;
    newPatterns.forEach((p) => st.patterns.push({ re: p.re, at: (m) => forceUntraced(p.at(m), 'defined in a subsearch') }));
    if (!orig || sub.def !== orig.def) {
        const subDef = sub.def;
        st.def = (n: string) => mergeNullable(scope, oldDef(n), subDef(n));
    }
};

/** The bracket groups ([open, close] token indexes) at the top of a command's range. */
const bracketGroups = (toks: QueryToken[], a: number, b: number): Array<[number, number]> => {
    const out: Array<[number, number]> = [];
    for (let j = a; j < b; j += 1) {
        if (toks[j].text === '[') {
            const e = closingAt(toks, j, b);
            out.push([j, e]);
            j = e;
        }
    }
    return out;
};

/** The commands in tokens [from, to): token ranges split at the `|`s outside brackets. */
const splitCommands = (toks: QueryToken[], from: number, to: number): Array<{ a: number; b: number; piped: boolean }> => {
    const cmds: Array<{ a: number; b: number; piped: boolean }> = [];
    let d = 0;
    let a = from;
    let piped = false;
    for (let i = from; i < to; i += 1) {
        const x = toks[i].text;
        if (x === '[') d += 1;
        else if (x === ']') d = Math.max(0, d - 1);
        else if (x === '|' && d === 0) {
            if (i > a) cmds.push({ a, b: i, piped });
            a = i + 1;
            piped = true;
        }
    }
    if (to > a) cmds.push({ a, b: to, piped });
    return cmds;
};

/**
 * The name the reader gives a command: after a pipe, or in a pipeline whose
 * first word is always a command (`firstIsCommand`: appendpipe), its first
 * word; the first command with no pipe is read as that command when it is a
 * known command name (more definitions, never fewer), otherwise as the
 * implicit search.
 */
const readerCommandName = (toks: QueryToken[], c: { a: number; piped: boolean }, firstIsCommand: boolean): string => {
    const head = toks[c.a];
    const word = head.kind === 'word' ? head.text.toLowerCase() : '';
    return c.piped || firstIsCommand ? word : (KNOWN_COMMANDS.has(word) ? word : 'search');
};

/**
 * Build 377: the top-level command names the reader sees in a text, in
 * order - for the guard's suite, which checks that the guard's lexer and
 * this reader split every query the guard passes into the same commands.
 */
export const readerCommandNames = (text: string): string[] => {
    const toks = tokenize(text);
    return splitCommands(toks, 0, toks.length).map((c) => readerCommandName(toks, c, false));
};

/** Read the commands in tokens [from, to) into `st` (`firstIsCommand`: an appendpipe group). */
const readPipeline = (scope: Scope, st: FieldState, from: number, to: number, depth: number, firstIsCommand = false): void => {
    const { toks } = scope;
    const cmds = splitCommands(toks, from, to);
    cmds.forEach((c, idx) => {
        if (scope.over) return;
        scope.commands += 1;
        if (scope.commands > MAX_TRACE_COMMANDS) {
            scope.over = true;
            opaqueAll(scope, st, `more than ${MAX_TRACE_COMMANDS} commands`);
            return;
        }
        readCommand(scope, st, readerCommandName(toks, c, firstIsCommand && idx === 0), c.a + 1, c.b, idx === 0, depth);
    });
};

const readSubsearches = (scope: Scope, st: FieldState, a: number, b: number, depth: number): boolean => {
    const groups = bracketGroups(scope.toks, a, b);
    if (groups.length === 0) return false;
    for (const [open, close] of groups) {
        if (depth + 1 > MAX_SUBSEARCH_DEPTH) {
            opaqueAll(scope, st, 'subsearches nested too deep');
            return true;
        }
        const sub = rawState();
        readPipeline(scope, sub, open + 1, close, depth + 1);
        mergeSub(scope, st, sub, null);
    }
    return true;
};

/** One command (`name` lower-cased; '' for a token the reader cannot name). */
const readCommand = (scope: Scope, st: FieldState, name: string, a: number, b: number, first: boolean, depth: number): void => {
    const { toks } = scope;
    if (KEEP_COMMANDS.has(name)) return;
    switch (name) {
        case 'eval':
        case 'fieldformat': {
            let j = a;
            while (j < b) {
                let k = j;
                let dd = 0;
                for (; k < b; k += 1) {
                    const x = toks[k].text;
                    if (x === '(' || x === '[') dd += 1;
                    else if (x === ')' || x === ']') dd -= 1;
                    else if (dd === 0 && (x === '=' || x === ',')) break;
                }
                if (k >= b || toks[k].text !== '=' || k === j || (k + 1 < b && toks[k + 1].text === '=')) {
                    opaqueAll(scope, st, 'an eval the reader cannot split');
                    return;
                }
                let e = k + 1;
                dd = 0;
                for (; e < b; e += 1) {
                    const x = toks[e].text;
                    if (x === '(' || x === '[') dd += 1;
                    else if (x === ')' || x === ']') dd -= 1;
                    else if (dd === 0 && x === ',') break;
                }
                const expr = toks.slice(k + 1, e);
                let tr: ColumnTrace;
                if (expr.length === 1 && ((expr[0].kind === 'word' && BARE_FIELD_RE.test(expr[0].text))
                    || (expr[0].kind === 'quoted' && expr[0].text.charAt(0) === "'"))) {
                    tr = sourceOf(scope, st, nameOf(expr[0]) as string);
                } else {
                    tr = untracedExpr(scope, st, 'an eval expression', expr);
                }
                const target = toks.slice(j, k);
                const tname = target.length === 1 ? nameOf(target[0]) : null;
                if (tname !== null && tname.indexOf('*') === -1 && tname.indexOf('{') === -1 && tname !== '') {
                    // Build 377: fieldformat formats a column that keeps its
                    // own values: untraced, reading both definitions.
                    st.env.set(tname, name === 'fieldformat'
                        ? mergeTraces(scope, sourceOf(scope, st, tname), forceUntraced(tr, 'fieldformat')) : tr);
                } else if (target.some((t) => t.text.indexOf('{') !== -1 || t.text.indexOf('*') !== -1)) {
                    const dyn = forceUntraced(tr, 'a dynamic eval target');
                    addPattern(scope, st, /^[\s\S]*$/, () => dyn);
                } else {
                    opaqueAll(scope, st, 'an eval target the reader cannot name');
                    return;
                }
                j = e + 1;
            }
            return;
        }
        case 'rename': {
            for (let j = a; j < b;) {
                if (toks[j].text === ',') {
                    j += 1;
                    continue;
                }
                const s1 = readGlobName(toks, j, b);
                const s2 = s1 && s1.next < b && isWord(toks[s1.next], 'as') ? readGlobName(toks, s1.next + 1, b) : null;
                if (s1 === null || s2 === null) {
                    opaqueAll(scope, st, 'a rename the reader cannot split');
                    return;
                }
                const src = s1.name;
                const dst = s2.name;
                j = s2.next;
                if (src.indexOf('*') !== -1 || dst.indexOf('*') !== -1) {
                    const snap = copyState(st);
                    addPattern(scope, st, globRe(dst), (m) => {
                        const from = substGlob(src, m);
                        if (from === null) return opaque(scope, 'a wildcard rename');
                        const tr = sourceOf(scope, snap, from);
                        return untraced(scope, 'a wildcard rename', [from, ...tr.fields], tr.mixed, tr.count);
                    });
                } else {
                    const moved = sourceOf(scope, st, src);
                    st.env.delete(src);
                    st.env.set(dst, moved);
                }
            }
            return;
        }
        case 'stats':
        case 'tstats':
        case 'eventstats':
        case 'streamstats': {
            const args = readStatsArgs(scope, a, b);
            if (args === null || args.over.length > 0) {
                opaqueAll(scope, st, `a ${name} the reader cannot split`);
                return;
            }
            const rebuild = name === 'stats' || name === 'tstats';
            const into: FieldState = rebuild ? { env: new Map(), patterns: [], def: () => null } : st;
            if (rebuild) args.by.forEach((f) => setDefinition(scope, into, f, sourceOf(scope, st, f), true));
            for (const g of args.aggs) {
                if (wildcardAggregation(scope, st, g, into)) continue;
                setDefinition(scope, into, g.alias !== null ? g.alias : g.name, aggregationTrace(scope, st, g), rebuild);
            }
            if (rebuild) {
                st.env = into.env;
                st.patterns = into.patterns;
                st.def = into.def;
            }
            return;
        }
        case 'chart':
        case 'timechart': {
            const args = readStatsArgs(scope, a, b);
            if (args === null || args.aggs.length === 0) {
                opaqueAll(scope, st, `a ${name} the reader cannot split`);
                return;
            }
            let x: string | null;
            let split: string | null;
            if (name === 'timechart') {
                x = '_time';
                split = args.by.length > 0 ? args.by[0] : null;
            } else if (args.over.length > 0) {
                x = args.over[0];
                split = args.by.length > 0 ? args.by[0] : null;
            } else {
                x = args.by.length > 0 ? args.by[0] : null;
                split = args.by.length > 1 ? args.by[1] : null;
            }
            const into: FieldState = { env: new Map(), patterns: [], def: () => null };
            if (x !== null) into.env.set(x, sourceOf(scope, st, x));
            if (split === null) {
                for (const g of args.aggs) {
                    if (wildcardAggregation(scope, st, g, into)) continue;
                    setDefinition(scope, into, g.alias !== null ? g.alias : g.name, aggregationTrace(scope, st, g), true);
                }
            } else {
                if (args.aggs.some((g) => g.name.indexOf('*') !== -1)) {
                    opaqueAll(scope, st, 'a wildcard pivot');
                    return;
                }
                const cells = args.aggs.map((g) => aggregationTrace(scope, st, g));
                const cell = cells.reduce((p, q) => mergeTraces(scope, p, q));
                const cellTrace: ColumnTrace = { ...cell, cell: true };
                into.def = () => cellTrace;
            }
            st.env = into.env;
            st.patterns = into.patterns;
            st.def = into.def;
            return;
        }
        case 'xyseries':
        case 'untable': {
            const args = plainArgs(toks, a, b);
            if (args === null || args.length < 3 || (name === 'untable' && args.length !== 3)) {
                opaqueAll(scope, st, `a ${name} the reader cannot split`);
                return;
            }
            const names = args.map((t) => nameOf(t) as string);
            const into: FieldState = { env: new Map(), patterns: [], def: () => null };
            into.env.set(names[0], sourceOf(scope, st, names[0]));
            if (name === 'xyseries') {
                const cell = names.slice(2).map((n) => sourceOf(scope, st, n)).reduce((p, q) => mergeTraces(scope, p, q));
                const cellTrace: ColumnTrace = { ...cell, cell: true };
                into.def = () => cellTrace;
            } else {
                const mixed = opaque(scope, 'untable', true);
                into.env.set(names[1], mixed);
                into.env.set(names[2], mixed);
            }
            st.env = into.env;
            st.patterns = into.patterns;
            st.def = into.def;
            return;
        }
        case 'transpose': {
            const mixed = opaque(scope, 'transpose', true);
            st.env = new Map();
            st.patterns = [];
            st.def = () => mixed;
            return;
        }
        case 'fieldsummary': {
            const mixed = opaque(scope, 'fieldsummary', true);
            st.env = new Map<string, ColumnTrace>([
                ['field', mixed], ['values', mixed], ['max', mixed], ['min', mixed], ['mean', mixed], ['stdev', mixed],
                ['count', COUNT_TRACE], ['distinct_count', COUNT_TRACE], ['numeric_count', COUNT_TRACE], ['is_exact', COUNT_TRACE],
            ]);
            st.patterns = [];
            st.def = () => null;
            return;
        }
        case 'top':
        case 'rare': {
            const opts = readOptions(toks, a, b);
            const args: string[] = [];
            const by: string[] = [];
            let inBy = false;
            // Build 377: a positional limit (`top 10 uri`) is a run of
            // adjacent one-digit tokens before the fields.
            let j0 = a;
            if (j0 < b && /^[0-9]$/.test(toks[j0].text)) {
                while (j0 + 1 < b && /^[0-9]$/.test(toks[j0 + 1].text) && toks[j0 + 1].start === toks[j0].end) j0 += 1;
                j0 += 1;
            }
            for (let j = j0; j < b;) {
                if (isOption(toks, j, b)) {
                    j = skipOption(toks, j, b);
                    continue;
                }
                const t = toks[j];
                j += 1;
                if (t.text === ',') continue;
                if (isWord(t, 'by')) {
                    inBy = true;
                    continue;
                }
                const f = nameOf(t);
                if (f === null || f.indexOf('*') !== -1) {
                    opaqueAll(scope, st, `a ${name} the reader cannot split`);
                    return;
                }
                (inBy ? by : args).push(f);
            }
            if (args.length === 0) {
                opaqueAll(scope, st, `a ${name} with no field`);
                return;
            }
            const into: FieldState = { env: new Map(), patterns: [], def: () => null };
            [...args, ...by].forEach((f) => setDefinition(scope, into, f, sourceOf(scope, st, f), true));
            into.env.set(opts.get('countfield') || 'count', COUNT_TRACE);
            into.env.set(opts.get('percentfield') || 'percent', COUNT_TRACE);
            st.env = into.env;
            st.patterns = into.patterns;
            st.def = into.def;
            return;
        }
        case 'lookup': {
            let kw = -1;
            for (let j = a; j < b; j += 1) {
                if (isWord(toks[j], 'output') || isWord(toks[j], 'outputnew')) {
                    kw = j;
                    break;
                }
            }
            if (kw === -1) {
                opaqueAll(scope, st, 'a lookup that outputs every lookup field');
                return;
            }
            // Build 377: the lookup's name and its match pairs
            // (`lookupField [AS eventField]`, before OUTPUT). An output
            // that echoes a match field is that event field; any other
            // output inherits what the match fields read - a mapping keyed
            // on an identifier is an identifier - except the curated
            // threat-intel metadata (CURATED_LOOKUP_OUTPUTS).
            let mj = a;
            while (mj < kw && isOption(toks, mj, kw)) mj = skipOption(toks, mj, kw);
            const lookupName = mj < kw ? nameOf(toks[mj]) : null;
            mj += 1;
            const matches: Array<{ lf: string; ef: string }> = [];
            while (mj < kw) {
                if (toks[mj].text === ',') {
                    mj += 1;
                    continue;
                }
                if (isOption(toks, mj, kw)) {
                    mj = skipOption(toks, mj, kw);
                    continue;
                }
                const lf = nameOf(toks[mj]);
                if (lf === null || lf.indexOf('*') !== -1) {
                    opaqueAll(scope, st, 'a lookup match the reader cannot name');
                    return;
                }
                let ef = lf;
                mj += 1;
                if (mj < kw && isWord(toks[mj], 'as')) {
                    const e2 = nameOf(toks[mj + 1]);
                    if (e2 === null || e2.indexOf('*') !== -1) {
                        opaqueAll(scope, st, 'a lookup match the reader cannot name');
                        return;
                    }
                    ef = e2;
                    mj += 2;
                }
                matches.push({ lf, ef });
            }
            const matchTraces = matches.map((m) => sourceOf(scope, st, m.ef));
            const matchFields: string[] = [];
            matchTraces.forEach((t) => t.fields.forEach((f) => matchFields.push(f)));
            const matchTraced = matchTraces.every((t) => t.traced && !t.cell);
            const matchMixed = matchTraces.some((t) => t.mixed);
            const curated = lookupName !== null && Object.prototype.hasOwnProperty.call(CURATED_LOOKUP_OUTPUTS, lookupName)
                ? CURATED_LOOKUP_OUTPUTS[lookupName] : [];
            const outputNew = isWord(toks[kw], 'outputnew');
            for (let j = kw + 1; j < b;) {
                if (toks[j].text === ',') {
                    j += 1;
                    continue;
                }
                const o = nameOf(toks[j]);
                if (o === null || o.indexOf('*') !== -1) {
                    opaqueAll(scope, st, 'a lookup output the reader cannot name');
                    return;
                }
                let target = o;
                j += 1;
                if (j < b && isWord(toks[j], 'as')) {
                    const al = nameOf(toks[j + 1]);
                    if (al === null || al.indexOf('*') !== -1) {
                        opaqueAll(scope, st, 'a lookup output the reader cannot name');
                        return;
                    }
                    target = al;
                    j += 2;
                }
                const echo = matches.findIndex((m) => m.lf === o);
                let t: ColumnTrace;
                if (echo !== -1) {
                    t = matchTraces[echo];
                } else if (curated.indexOf(o) !== -1 || matches.length === 0) {
                    t = baseTrace(o);
                } else {
                    const fields = uniqSorted([o, ...matchFields]);
                    t = matchTraced
                        ? { traced: true, count: false, cell: false, mixed: matchMixed, fields, why: '' }
                        : untraced(scope, 'a lookup keyed on an untraced field', fields, matchMixed);
                }
                st.env.set(target, outputNew ? (mergeNullable(scope, lookupIn(scope, st, target), t) as ColumnTrace) : t);
            }
            return;
        }
        case 'inputlookup':
            if (!first) opaqueAll(scope, st, 'an inputlookup inside a pipeline');
            return;
        case 'rex': {
            const opts = readOptions(toks, a, b);
            let re: QueryToken | null = null;
            for (let j = a; j < b;) {
                if (isOption(toks, j, b)) {
                    j = skipOption(toks, j, b);
                    continue;
                }
                if (toks[j].kind === 'quoted' && re === null) re = toks[j];
                j += 1;
            }
            if (re === null) {
                opaqueAll(scope, st, 'a rex with no expression');
                return;
            }
            const field = opts.get('field') || '_raw';
            const src = sourceOf(scope, st, field);
            // Build 377: the words of the pattern count as read fields
            // (`rex "ssn=(?<n>\d{9})"` marks n by `ssn`).
            const patternWords = (nameOf(re) || '').match(NAME_WORD_RE) || [];
            const t = untraced(scope, 'rex', [field, ...src.fields, ...patternWords], src.mixed);
            if ((opts.get('mode') || '').toLowerCase() === 'sed') st.env.set(field, t);
            // Build 377: `(?'name')` groups as well as `(?<name>)` and `(?P<name>)`.
            const groups = re.text.match(/\(\?(?:P?<[A-Za-z_][A-Za-z0-9_]*>|'[A-Za-z_][A-Za-z0-9_]*')/g) || [];
            for (const g of groups) {
                const n = g.replace(/^\(\?P?[<']/, '').replace(/[>']$/, '');
                if (/^_(?:KEY|VAL)_/.test(n)) {
                    opaqueAll(scope, st, 'a rex with dynamic field names');
                    return;
                }
                // rex sets the group only where it matches: other rows keep
                // the earlier value (build 377).
                st.env.set(n, mergeNullable(scope, lookupIn(scope, st, n), t) as ColumnTrace);
            }
            const off = opts.get('offset_field');
            if (off) st.env.set(off, t);
            return;
        }
        case 'spath': {
            const opts = readOptions(toks, a, b);
            const args = plainArgs(toks, a, b);
            const input = opts.get('input') || '_raw';
            const src = sourceOf(scope, st, input);
            // Build 377: the words of the path (and of the output name) count
            // as read fields (`spath path=user.id` marks the column by `id`).
            const pathText = [opts.get('path') || '', opts.get('output') || '',
                ...(args || []).map((x) => nameOf(x) || '')].join(' ');
            const t = untraced(scope, 'spath', [input, ...src.fields, ...(pathText.match(NAME_WORD_RE) || [])], src.mixed);
            const out = opts.get('output') || opts.get('path') || (args && args.length === 1 ? nameOf(args[0]) : null);
            if (!out || out.indexOf('*') !== -1 || out.indexOf('{') !== -1) {
                opaqueAll(scope, st, 'an spath that extracts every path');
                return;
            }
            // spath sets the output only where the path exists (build 377).
            st.env.set(out, mergeNullable(scope, lookupIn(scope, st, out), t) as ColumnTrace);
            return;
        }
        case 'strcat': {
            const args = plainArgs(toks, a, b);
            if (args === null || args.length < 2 || nameOf(args[args.length - 1]) === null) {
                opaqueAll(scope, st, 'a strcat the reader cannot split');
                return;
            }
            const dest = nameOf(args[args.length - 1]) as string;
            st.env.set(dest, untracedExpr(scope, st, 'strcat', args.slice(0, -1).map((t) => (
                t.kind === 'quoted' && t.text.charAt(0) === '"' ? t : { ...t, kind: 'word' as const }))));
            return;
        }
        case 'makemv': {
            // Security review of build 377: makemv cuts the field's value into
            // substrings (`delim=" "`: every token of it; `tokenizer="user=(\S+)"`:
            // a regex extraction, like rex), so the field becomes untraced,
            // reading its earlier definition and the words of the delimiter and
            // the tokenizer.
            const opts = readOptions(toks, a, b);
            const args = plainArgs(toks, a, b);
            if (args === null || args.length !== 1 || nameOf(args[0]) === null) {
                opaqueAll(scope, st, 'a makemv the reader cannot split');
                return;
            }
            const field = nameOf(args[0]) as string;
            const src = sourceOf(scope, st, field);
            const cutWords = `${opts.get('delim') || ''} ${opts.get('tokenizer') || ''}`.match(NAME_WORD_RE) || [];
            st.env.set(field, untraced(scope, 'makemv', [field, ...src.fields, ...cutWords], src.mixed));
            return;
        }
        case 'bin':
        case 'bucket': {
            const args = plainArgs(toks, a, b);
            if (args === null || args.length === 0) {
                opaqueAll(scope, st, `a ${name} the reader cannot split`);
                return;
            }
            const field = nameOf(args[0]) as string;
            const alias = args.length >= 3 && isWord(args[1], 'as') ? nameOf(args[2]) : null;
            if (args.length !== 1 && alias === null) {
                opaqueAll(scope, st, `a ${name} the reader cannot split`);
                return;
            }
            const target = alias !== null ? alias : field;
            // `bin _time span=1h` keeps the field's own trace. Security review
            // of build 377: with AS, the alias is a NEW definition - it reads
            // the binned field (`bin n span=1 AS _time` must not leave `_time`
            // traced to `_time`); only a field traced to a time source field
            // binned into `_time` keeps that trace (`bin bucket_ts span=1d AS
            // _time`), so its range is still shown.
            if (alias === null && target.charAt(0) === '_') return;
            const src = sourceOf(scope, st, field);
            if (target === '_time' && src.traced && !src.count && !src.cell && !src.mixed && src.fields.length > 0
                && src.fields.every((f) => TIME_SOURCE_FIELDS.has(f))) {
                st.env.set(target, src);
                return;
            }
            st.env.set(target, untraced(scope, name, [field, ...src.fields], src.mixed));
            return;
        }
        case 'convert': {
            for (let j = a; j < b;) {
                if (isOption(toks, j, b)) {
                    j = skipOption(toks, j, b);
                    continue;
                }
                if (toks[j].text === ',') {
                    j += 1;
                    continue;
                }
                const t = toks[j];
                if (t.kind !== 'word' || !(j + 1 < b && toks[j + 1].text === '(')) {
                    opaqueAll(scope, st, 'a convert the reader cannot split');
                    return;
                }
                const e = closingAt(toks, j + 1, b);
                const inner = toks.slice(j + 2, e);
                const arg = inner.length === 1 ? nameOf(inner[0]) : null;
                if (arg === null || arg.indexOf('*') !== -1) {
                    opaqueAll(scope, st, 'a convert the reader cannot split');
                    return;
                }
                j = e + 1;
                let target = arg;
                if (j < b && isWord(toks[j], 'as')) {
                    const al = nameOf(toks[j + 1]);
                    if (al === null) {
                        opaqueAll(scope, st, 'a convert the reader cannot split');
                        return;
                    }
                    target = al;
                    j += 2;
                }
                const src = sourceOf(scope, st, arg);
                st.env.set(target, untraced(scope, 'convert', [arg, ...src.fields], src.mixed));
            }
            return;
        }
        case 'transaction':
            st.env.set('duration', untraced(scope, 'transaction', ['duration']));
            ['eventcount', 'linecount', 'closed_txn', 'field_match_sum'].forEach((n) => st.env.set(n, COUNT_TRACE));
            return;
        case 'iplocation': {
            const opts = readOptions(toks, a, b);
            const args = plainArgs(toks, a, b);
            if (args === null || args.length !== 1) {
                opaqueAll(scope, st, 'an iplocation the reader cannot split');
                return;
            }
            const field = nameOf(args[0]) as string;
            const src = sourceOf(scope, st, field);
            const prefix = opts.get('prefix') || '';
            ['City', 'Country', 'Region', 'lat', 'lon', 'Continent', 'MetroCode', 'Timezone'].forEach((n) => {
                st.env.set(`${prefix}${n}`, untraced(scope, 'iplocation', [field, ...src.fields], src.mixed));
            });
            return;
        }
        case 'addtotals':
        case 'addcoltotals': {
            const opts = readOptions(toks, a, b);
            const args = plainArgs(toks, a, b);
            if (args === null) {
                opaqueAll(scope, st, `an ${name} the reader cannot split`);
                return;
            }
            if (name === 'addtotals' && !/^(?:f|false|0)$/i.test(opts.get('row') || '')) {
                const read = args.length > 0 ? untracedExpr(scope, st, 'addtotals', args) : opaque(scope, 'addtotals');
                st.env.set(opts.get('fieldname') || 'Total', read);
            }
            const lf = opts.get('labelfield');
            if (lf) {
                const prev = sourceOf(scope, st, lf);
                st.env.set(lf, untraced(scope, `${name} label`, [lf, ...prev.fields], prev.mixed));
            }
            return;
        }
        case 'appendpipe': {
            const groups = bracketGroups(toks, a, b);
            if (groups.length !== 1 || depth + 1 > MAX_SUBSEARCH_DEPTH) {
                opaqueAll(scope, st, 'an appendpipe the reader cannot split');
                return;
            }
            // Security review of build 377: the group and the pipeline share one
            // memoised definition function (memoDef), so stacked groups cost
            // linear time.
            st.def = memoDef(st.def);
            const orig = copyState(st);
            const sub = copyState(st);
            // Build 377: an appendpipe group starts with a command, never an
            // implicit search, so an unknown first command is opaque.
            readPipeline(scope, sub, groups[0][0] + 1, groups[0][1], depth + 1, true);
            mergeSub(scope, st, sub, orig);
            return;
        }
        default:
            if (APPEND_COMMANDS.has(name)) {
                if (!readSubsearches(scope, st, a, b, depth)) opaqueAll(scope, st, `a ${name} with no subsearch`);
                return;
            }
            opaqueAll(scope, st, name ? `the command ${name}` : 'a command the reader cannot name');
    }
};

/* ------------------------------------------------------- author text */

/** One author text, read. */
interface TextReading {
    /** The column `name` of this text's output, or null when the text outputs no such column. */
    lookup: (name: string) => ColumnTrace | null;
    words: string[];
}

/** What the model or the App wrote for one call (rules 1 and 3). */
export interface AuthorContext {
    /** Every word (`NAME_WORD_RE`) of the author text, quoted parts included. */
    words: ReadonlySet<string>;
    /** Every display alias the author text quotes after `AS` (`AS "Source Type"`), unquoted. */
    quotedAliases: ReadonlySet<string>;
    /** Each author text read as a pipeline (rule 3). */
    readings: ReadonlyArray<TextReading>;
}

/**
 * The author context of a call: `texts` is the model's own query, or the
 * catalog SPL of the saved search that ran (all catalog SPL when the name
 * is not the catalog's). Anything that is not a string is skipped; each
 * text is read up to `MAX_QUERY_CHARS`, and a longer one leaves every column
 * untraced.
 */
export const buildAuthorContext = (texts: ReadonlyArray<unknown>): AuthorContext => {
    const words = new Set<string>();
    const quotedAliases = new Set<string>();
    const readings: TextReading[] = [];
    for (const text of texts) {
        if (typeof text !== 'string') continue;
        const s = text.slice(0, MAX_QUERY_CHARS);
        const w = s.match(NAME_WORD_RE);
        if (w) w.forEach((x) => words.add(x));
        const toks = tokenize(s);
        toks.forEach((t, i) => {
            if (t.kind === 'quoted' && i > 0 && isWord(toks[i - 1], 'as')) quotedAliases.add(nameOf(t) as string);
        });
        if (toks.length === 0) continue;
        const scope: Scope = { s, toks, words: uniqSorted(w || []), commands: 0, over: false };
        const st = rawState();
        readPipeline(scope, st, 0, toks.length, 0);
        if (scope.over) opaqueAll(scope, st, `more than ${MAX_TRACE_COMMANDS} commands`);
        if (text.length > MAX_QUERY_CHARS) opaqueAll(scope, st, `a text longer than ${MAX_QUERY_CHARS} characters`);
        readings.push({ lookup: (name: string) => lookupIn(scope, st, name), words: scope.words });
    }
    return { words, quotedAliases, readings };
};

/** The empty author context: nothing is authored. */
export const NO_AUTHOR: AuthorContext = { words: new Set<string>(), quotedAliases: new Set<string>(), readings: [] };

/**
 * Rule 3: how a column's values are defined, over every author text that
 * outputs it. A column no text outputs is untraced.
 */
export const traceColumn = (name: string, author: AuthorContext = NO_AUTHOR): ColumnTrace => {
    const all: string[] = [];
    author.readings.forEach((r) => r.words.forEach((x) => all.push(x)));
    const scope: Scope = { s: '', toks: [], words: uniqSorted(all), commands: 0, over: false };
    let out: ColumnTrace | null = null;
    for (const r of author.readings) {
        const t = r.lookup(name);
        if (t !== null) out = out === null ? t : mergeTraces(scope, out, t);
    }
    return out !== null ? out : untraced(scope, 'not a column the author text outputs', scope.words);
};

/**
 * Rule 6, build 377: the `_time` range is sent only when the author text
 * traces `_time` - every definition of it - to time source fields
 * (TIME_SOURCE_FIELDS) through understood constructs.
 */
export const timeRangeAllowed = (author: AuthorContext = NO_AUTHOR): boolean => {
    const t = traceColumn('_time', author);
    return t.traced && !t.count && !t.cell && !t.mixed && t.fields.length > 0
        && t.fields.every((f) => TIME_SOURCE_FIELDS.has(f));
};

/* ---------------------------------------------------------------- names */

/** Rule 1's shape: at most 40 characters, a field name or one call over one. */
export const isNameShaped = (name: string): boolean =>
    name.length <= MAX_NAME_CHARS && (FIELD_NAME_RE.test(name) || FUNCTION_NAME_RE.test(name));

/** The words of a name (`values(user)` -> `values`, `user`). */
export const nameWords = (name: string): string[] => name.match(NAME_WORD_RE) || [];

/**
 * Rule 1: true when a column name may be sent - FIXED, or every word of it
 * is a word of the author text and it has the shape (or is a display alias
 * the author text quotes after `AS`, at most 40 characters). The value
 * filter is checked by the caller.
 */
export const isSendableColumnName = (name: string, author: AuthorContext = NO_AUTHOR): boolean => {
    if (FIXED_COLUMN_NAMES.has(name)) return true;
    const shaped = isNameShaped(name)
        || (author.quotedAliases.has(name) && name.length <= MAX_NAME_CHARS && QUOTED_ALIAS_RE.test(name));
    if (!shaped) return false;
    const w = nameWords(name);
    return w.length > 0 && w.every((x) => author.words.has(x));
};

/* ------------------------------------------------------- identifiers */

const ID_NAME_RE = new RegExp(
    '(?:^|[_.:\\s-])(?:id|uid|gid|guid|uuid|pid|ssn|iban|phone|msisdn|imsi|imei|acct|account_?(?:no|number|id)'
    + '|card_?(?:no|number)|employee_?(?:id|no|number)|personnel_?(?:id|no|number))$',
    'i',
);
/* Security review of build 377: Windows `TargetUserSid`, `SubjectUserSid`, `LogonGuid` as well. */
const CAMEL_ID_RE = /[a-z0-9](?:Id|ID|Sid|SID|Guid|GUID)$/;

/**
 * True when a NAME marks an identifier (rules 4 and 5). Build 377: the
 * App's own field names are classified one by one
 * (utils/fieldClassification.ts: an identifier or an address, a host name
 * with the hostname opt-in); the name patterns apply to every name as well,
 * so the table can only add identifiers.
 */
export const isIdentifierColumnName = (name: string, piiOpts: PiiRedactionOptions = {}): boolean =>
    isClassifiedIdentifier(name, piiOpts.redactHostnames === true)
    || ID_NAME_RE.test(name) || CAMEL_ID_RE.test(name)
    || isPiiColumn(name, { enabled: true, redactHostnames: piiOpts.redactHostnames === true });

/** What rules 4 and 5 decide for one column. */
export interface ColumnValueRule {
    trace: ColumnTrace;
    /** The column's own name or one of the fields its definition may read marks an identifier. */
    identifier: boolean;
    /** Rule 4: a text column's values may be sent in clear (with the name shown). */
    textSafe: boolean;
    /** Rule 5: a numeric column's statistics are withheld with redaction on. */
    numericIdentifier: boolean;
}

export const columnValueRule = (
    name: string,
    author: AuthorContext = NO_AUTHOR,
    piiOpts: PiiRedactionOptions = {},
): ColumnValueRule => {
    const trace = traceColumn(name, author);
    const identifier = isIdentifierColumnName(name, piiOpts) || trace.fields.some((f) => isIdentifierColumnName(f, piiOpts));
    return {
        trace,
        identifier,
        // A count holds numbers: text in a column traced to a count is not what the reader expected.
        textSafe: trace.traced && !trace.count && !trace.cell && !trace.mixed && !identifier,
        numericIdentifier: !trace.count && (identifier || trace.mixed),
    };
};

/* ----------------------------------------------------------------- plan */

export interface ColumnShape {
    /** The real column name - never sent unless `named`. */
    name: string;
    /** 1-based position among the result's columns not starting with `_`. */
    position: number;
    numeric: boolean;
}

export interface PlannedColumn extends ColumnShape {
    /** True when the label carries the name. */
    named: boolean;
    /** `"name"` when named, else `col_N`. */
    label: string;
}

export interface ColumnPlan {
    /** The columns to summarize, in order, at most `maxColumns`. */
    columns: PlannedColumn[];
    /** Columns beyond the cap: reported only as a count. */
    omitted: number;
    /** Summarized columns whose name is replaced by a placeholder. */
    withheld: number;
}

export interface PlanOptions {
    /** The call's author text (`buildAuthorContext`). */
    author?: AuthorContext;
    maxColumns?: number;
    /** The hook's value filter; a name it would change is never sent. */
    sanitizeName?: (raw: string) => string;
}

/** Rules 1 and 2: which names reach the vendor, for one result. */
export const planVendorColumns = (cols: ReadonlyArray<ColumnShape>, opts: PlanOptions = {}): ColumnPlan => {
    const max = typeof opts.maxColumns === 'number' && opts.maxColumns >= 1
        ? Math.floor(opts.maxColumns) : MAX_SUMMARY_COLUMNS;
    const author = opts.author || NO_AUTHOR;
    let withheld = 0;
    const columns = cols.slice(0, max).map((c): PlannedColumn => {
        const named = isSendableColumnName(c.name, author) && (!opts.sanitizeName || opts.sanitizeName(c.name) === c.name);
        if (!named) withheld += 1;
        return {
            name: c.name,
            position: c.position,
            numeric: c.numeric,
            named,
            label: named ? `"${c.name}"` : `${PLACEHOLDER_PREFIX}${c.position}`,
        };
    });
    return { columns, omitted: cols.length - columns.length, withheld };
};

export type NumericDisclosure = 'full' | 'withheld' | 'withheld-identifier';

/**
 * Rule 5: how much of a numeric column's values reach the vendor.
 * `identifier`: the column's statistics would disclose an identifier
 * (`columnValueRule(...).numericIdentifier`).
 */
export const numericDisclosure = (
    named: boolean,
    identifier: boolean,
    distinct: number,
    piiOpts: PiiRedactionOptions = {},
): NumericDisclosure => {
    if (piiOpts.enabled !== false && identifier) return 'withheld-identifier';
    if (distinct <= 1 && (!named || identifier)) return 'withheld';
    return 'full';
};

/* ----------------------------------------------------------------- time */

const EPOCH_STRING_RE = /^\d{1,10}(?:\.\d{1,6})?$/;
const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:?\d{2})$/;

const inEpochRange = (seconds: number): boolean =>
    Number.isFinite(seconds) && seconds >= 0 && seconds <= MAX_EPOCH_SECONDS;

/**
 * A `_time` value as epoch milliseconds, or null when it is not an epoch
 * (number or digit string, seconds, 0 .. 2100-01-01) or a strict ISO-8601
 * timestamp with a zone (`Z`, `+hh:mm` or `+hhmm`).
 */
export const parseVendorTime = (v: unknown): number | null => {
    if (typeof v === 'number') return inEpochRange(v) ? Math.round(v * 1000) : null;
    if (typeof v !== 'string' || v.length > 40) return null;
    if (EPOCH_STRING_RE.test(v)) {
        const n = Number(v);
        return inEpochRange(n) ? Math.round(n * 1000) : null;
    }
    const m = ISO_RE.exec(v);
    if (!m) return null;
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    const h = Number(m[4]);
    const mi = Number(m[5]);
    const s = Number(m[6]);
    if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return null;
    const ms = m[7] ? Number(`${m[7]}00`.slice(0, 3)) : 0;
    let offsetMin = 0;
    if (m[8] !== 'Z') {
        const sign = m[8].charAt(0) === '-' ? -1 : 1;
        const digits = m[8].slice(1).replace(':', '');
        const oh = Number(digits.slice(0, 2));
        const om = Number(digits.slice(2, 4));
        if (oh > 14 || om > 59) return null;
        offsetMin = sign * (oh * 60 + om);
    }
    const utc = Date.UTC(y, mo - 1, d, h, mi, s, ms);
    const check = new Date(Date.UTC(y, mo - 1, d));
    if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return null;
    const t = utc - offsetMin * 60000;
    return inEpochRange(t / 1000) ? t : null;
};

/** The App's own rendering of a parsed time: ISO-8601, UTC. */
export const formatVendorTime = (ms: number): string => new Date(ms).toISOString();

/** Rule 6: the `Time range:` line, or null when no row has a `_time`. */
export const vendorTimeRangeLine = (values: ReadonlyArray<unknown>): string | null => {
    let lo = Infinity;
    let hi = -Infinity;
    let any = false;
    for (const v of values) {
        if (v === null || v === undefined) continue;
        any = true;
        const t = parseVendorTime(v);
        if (t === null) return TIME_NOT_SHOWN;
        if (t < lo) lo = t;
        if (t > hi) hi = t;
    }
    if (!any) return null;
    return `Time range: ${formatVendorTime(lo)} → ${formatVendorTime(hi)} (UTC).`;
};

/* ---------------------------------------------------------------- lines */

const formatNumber = (n: number): string => {
    if (!Number.isFinite(n)) return String(n);
    if (Number.isInteger(n)) return n.toLocaleString();
    return n.toFixed(2);
};

const truncate = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

export const withheldNote = (n: number): string =>
    `Column names withheld: ${n}. Each such column is shown as col_N, N being its position among the result's`
    + ' columns that do not start with an underscore.';

export interface VendorColumnOptions {
    /** Top-N categorical values per column. */
    topN: number;
    /** The hook's per-value filter (sanitizeAggregateValue). */
    sanitizeValue: (raw: string) => string;
    piiOpts?: PiiRedactionOptions;
    /** Called once per redaction: a value, or an identifier column's values. */
    onRedaction?: () => void;
    /** The call's author text (`buildAuthorContext`); none: nothing authored. */
    author?: AuthorContext;
    maxColumns?: number;
}

/**
 * Every Tier 2 summary line after "Returned N rows in M ms." - the time
 * range, the withheld-names note and one line per summarized column. The
 * only text in them that came from the result is: a name allowed by rule 1,
 * numbers, and categorical values after `sanitizeValue`, rule 4 and the
 * 40-character cap.
 */
export const vendorColumnLines = (
    rows: ReadonlyArray<Record<string, unknown>>,
    opts: VendorColumnOptions,
): string[] => {
    const piiOpts = opts.piiOpts || {};
    const redactOn = piiOpts.enabled !== false;
    const author = opts.author || NO_AUTHOR;
    const lines: string[] = [];

    const seen = new Set<string>();
    const allKeys: string[] = [];
    for (const row of rows) {
        for (const k of Object.keys(row)) {
            if (!seen.has(k)) {
                seen.add(k);
                allKeys.push(k);
            }
        }
    }

    if (seen.has('_time')) {
        const line = vendorTimeRangeLine(rows.map((r) => r._time));
        // Build 377: a parsed range only when `_time` is traced to a time source field.
        if (line !== null) lines.push(line === TIME_NOT_SHOWN || timeRangeAllowed(author) ? line : TIME_NOT_SHOWN_COMPUTED);
    }

    interface Facts extends ColumnShape {
        numericValues: number[];
        stringValues: string[];
        distinct: number;
    }
    const facts: Facts[] = [];
    let position = 0;
    for (const key of allKeys) {
        // `_time` (rule 6) and every other underscore field are never summarized.
        if (key.startsWith('_')) continue;
        position += 1;
        const valuesRaw = rows.map((r) => r[key]).filter((v) => v !== null && v !== undefined);
        if (valuesRaw.length === 0) continue; // a silent-null column says nothing
        const numericValues: number[] = [];
        for (const v of valuesRaw) {
            const n = typeof v === 'number' ? v : Number(String(v));
            if (Number.isFinite(n)) numericValues.push(n);
        }
        const numeric = numericValues.length / valuesRaw.length >= 0.8;
        const stringValues = valuesRaw.map((v) => String(v));
        const distinct = new Set(stringValues).size;
        // A categorical constant (a static `eval`, transpose's `column`) is
        // noise: not summarized. A numeric constant is kept - it is usually
        // the KPI the query asked for.
        if (distinct <= 1 && !numeric) continue;
        facts.push({ name: key, position, numeric, numericValues, stringValues, distinct });
    }

    const plan = planVendorColumns(facts, { author, maxColumns: opts.maxColumns, sanitizeName: opts.sanitizeValue });
    if (plan.withheld > 0) lines.push(withheldNote(plan.withheld));

    plan.columns.forEach((col, idx) => {
        const f = facts[idx];
        const rule = columnValueRule(col.name, author, piiOpts);
        if (col.numeric) {
            const disclosure = numericDisclosure(col.named, rule.numericIdentifier, f.distinct, piiOpts);
            if (disclosure !== 'full') {
                if (disclosure === 'withheld-identifier' && opts.onRedaction) opts.onRedaction();
                lines.push(`Column ${col.label} (numeric, distinct=${f.distinct}): values withheld.`);
                return;
            }
            const nums = f.numericValues;
            const min = nums.reduce((a, b) => Math.min(a, b));
            const max = nums.reduce((a, b) => Math.max(a, b));
            const sum = nums.reduce((a, b) => a + b, 0);
            const avg = sum / nums.length;
            lines.push(
                `Column ${col.label} (numeric, distinct=${f.distinct}): min=${formatNumber(min)} max=${formatNumber(max)} avg=${formatNumber(avg)} sum=${formatNumber(sum)}.`,
            );
            return;
        }
        // Categorical: top-N value counts. With redaction on, every value is
        // redacted unless the column is named and its values are traced safe
        // (rule 4).
        const redactAll = redactOn && (!col.named || !rule.textSafe);
        const counts: Record<string, number> = {};
        for (const s of f.stringValues) {
            counts[s] = (counts[s] ?? 0) + 1;
        }
        const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
        const requested = sorted.slice(0, opts.topN);
        const prefix = `Column ${col.label} (distinct=${f.distinct}): `;
        const budget = MAX_LINE_CHARS - prefix.length - 30; // reserve for the trailer
        const segs: string[] = [];
        let used = 0;
        let consumed = 0;
        for (const [v, c] of requested) {
            const sanitized = opts.sanitizeValue(v);
            let valueOut = sanitized;
            if (redactAll && sanitized !== '<filtered>') {
                const redacted = redactValueIfPII(PII_STAND_IN_COLUMN, sanitized, piiOpts);
                if (redacted !== sanitized) {
                    valueOut = redacted;
                    if (opts.onRedaction) opts.onRedaction();
                }
            }
            const seg = `${truncate(valueOut, VALUE_MAX_CHARS)}=${c}`;
            const segLen = seg.length + (segs.length > 0 ? 2 : 0); // ", "
            if (used + segLen > budget && segs.length > 0) break;
            segs.push(seg);
            used += segLen;
            consumed += 1;
        }
        const remaining = sorted.length - consumed;
        const trailer = remaining > 0 ? ` (+${remaining} more)` : '';
        lines.push(`${prefix}${segs.join(', ')}${trailer}.`);
    });

    if (plan.omitted > 0) lines.push(`${plan.omitted} more columns not summarized.`);
    return lines;
};
