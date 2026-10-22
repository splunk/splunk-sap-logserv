/**
 * splGuard — static analysis for AI-authored SPL before it reaches MCP.
 *
 * Mitigates OWASP LLM06 (Excessive Agency) for the `splunk_run_query`
 * tool path. The `splunk_run_saved_search` tool is unaffected — its SPL
 * is pre-authored and reviewed at app build time, and only the intent
 * map's saved searches may be run through it (utils/savedSearchAllowList.ts,
 * build 376). Because this App ships saved searches that WRITE (rollup
 * aggregates, backfills, retentions, the ES feeds), an ad-hoc query may not
 * rerun a saved search either: `savedsearch` and its alias `savedsplunk`
 * are refused wherever they appear as a word — `| savedsearch X`,
 * `| from savedsearch:X`, `| union savedsearch:X`, `[savedsearch X]` —
 * its other alias `macro` at command position, and so is `map`, which can
 * run any search per row.
 *
 * TWO FENCES (build 377). `analyzeSpl` is the DENYLIST of build 376: it
 * refuses a known list of risky commands - Splunk's own (with every alias
 * Splunk declares for them; checked against system/default/searchbnf.conf of
 * Splunk 9.4.3) and a few named third-party ones - and passes every other
 * command. `analyzeAdHocSpl` runs it first and then the ALLOW-LIST: the query
 * is read by the strict lexer (utils/splLexer.ts) and refused unless every
 * command is in ALLOWED_SPL_COMMANDS, the query and every subsearch start
 * from the LogServ index macro (or an App lookup, `| tstats ... WHERE` the
 * macro, `| makeresults`), no `index` term or other data source
 * appears, every lookup is one of the App's (ALLOWED_SPL_LOOKUPS), and
 * subsearches sit only where they cannot change the data scope. A custom
 * command or an external lookup of another installed app is therefore
 * refused by the allow-list even when the denylist does not name it. The
 * hook calls `analyzeAdHocSpl`, then has Splunk's own search parser read the
 * query and refuses it when the parser and the lexer disagree
 * (`checkParserAgreement`, components/ai/splParserCheck.ts) - since build
 * 378 also when the lookup a top-level `lookup` / `inputlookup` names, read
 * again from the parser's raw arguments, is not one of the App's.
 *
 * The denylist below is kept, unchanged, as the first fence: its refusals,
 * operators and the SOC queries built on them keep working.
 *
 * Threat model:
 *   - Customer's role permissions on the search head are the
 *     authoritative gate: if `can_delete` / `outputlookup` etc. aren't
 *     granted to the user whose session dispatched the search, the
 *     write fails server-side.
 *   - This guard adds a CLIENT-SIDE pre-flight check so that even when
 *     the user's role HAS the write capability, the AI cannot trigger
 *     one of the side-effecting commands listed here. AI tool calls flow
 *     through the user's own session, so they inherit the user's
 *     permissions; the guard narrows what the AI can do with them.
 *
 * What is refused, in the order analyzeSpl checks it:
 *   1. An SPL inline comment — three backticks anywhere in the query.
 *      Splunk drops a comment before it runs the search, so a comment
 *      placed inside a word (`saved` + comment + `search`, or between
 *      `|` and `outputlookup`) would hide that word from every check
 *      below. An ad-hoc query has no need for one, so any comment is
 *      refused rather than stripped.
 *   2. An unmatched backtick (an odd number of them), so a macro
 *      reference cannot be left open to confuse the macro check.
 *   3. Ambiguous quoting: a double quote that is never closed, or a
 *      backslash-escaped double quote outside a quoted string. Both
 *      would make the guard's idea of what is quoted differ from
 *      Splunk's. Command positions are then read on a copy of the query
 *      in which the CONTENT of every double-quoted string is blanked
 *      (backslash escapes honoured, the quote characters and the length
 *      kept), so quoted text cannot fake a command position (`"[DELETE]"`,
 *      `"(?<tag>[AI])"`). Single quotes are NOT blanked: a `|` or `[` in
 *      a single-quoted field name counts as a command position, which
 *      only ever refuses more.
 *   Every check that could be dodged by splitting a word with quotes also
 *   reads a copy of the query with every quote character — double AND
 *   single — removed and its content kept (`"saved"search` reads as
 *   `savedsearch`, `'in'to` as `into`). Splunk may or may not join such
 *   pieces into one word; the guard assumes it does and fails closed.
 *   4. A forbidden command (FORBIDDEN_SPL_COMMANDS) at command position,
 *      whether written plainly or with quotes (double or single) inside
 *      the command word (`| "delete"`, `| de'lete'`); or a forbidden word
 *      (FORBIDDEN_SPL_WORDS) anywhere in the RAW query, quoted text
 *      included (`| from "savedsearch:X"`), or anywhere in the
 *      quote-characters-removed copy (`| "saved"search X`,
 *      `| from "saved"search:X`). A quoted command word is also refused
 *      when it spells a forbidden word (`| sav"edsearch" X`).
 *   5. An external lookup that sends data off the search head
 *      (EXTERNAL_LOOKUPS: `dnslookup`, Splunk's own, whose every row is a
 *      DNS query — a value built into the host name reaches whoever
 *      answers for that domain). Refused as a word anywhere in the raw
 *      query or in the quote-characters-removed copy: `lookup dnslookup
 *      ...`, a quoted name, a name split by quotes (`"dns"lookup`), the
 *      eval `lookup()` function. Every other lookup, the App's included,
 *      passes.
 *   6. MLTK `fit ... into <model>`, which saves, or overwrites, a model:
 *      a `fit` command word at command position (plain, quoted, or split
 *      by quotes: `fit`, `"fit"`, `f'it'`) and the word `into` ANYWHERE
 *      LATER in the query — in the quote-characters-removed copy, or in a
 *      copy with every quote character turned into a space. The scan does
 *      not stop at the next `|` or `]` (either may sit inside a quoted
 *      field name, `'a|b'`), and quoted text counts (`"in"to`). `fit`
 *      with no `into` after it and `apply` only read and stay allowed.
 *   7. A macro reference that is not one of this App's own macros
 *      (ALLOWED_SPL_MACROS, the stanza names of default/macros.conf). A
 *      macro's definition is not visible here, and the MCP server's own
 *      parser check runs with macros unexpanded, so any other macro
 *      (a customer's, another app's, the search app's `comment(1)`)
 *      could hide any command. The App's macros write nothing and take
 *      no arguments; a reference must match a stanza exactly — the bare
 *      name for a stanza without arguments, `name(a, b)` for a
 *      `name(2)` stanza.
 *
 * Forbidden command list — every command here EITHER writes data
 * somewhere (index, lookup, file, model, RSS feed) OR has a side effect
 * outside the search (alert, email, script execution, an HTTP request,
 * sending rows to an external service) OR, for `rest`, reads REST
 * endpoints — `storage/passwords` returns every stored credential
 * decrypted, in `clear_password`. Read-only analytics commands like
 * `stats` / `eval` / `where` / `timechart` / `top` etc. are not affected.
 * MLTK's `ai` sends the piped rows to the LLM configured in the AI
 * Toolkit, which would break the App's invariant that no event data
 * reaches an AI vendor, so it is refused with the writers.
 *
 * The command match is anchored to the start of the query, a `|`
 * pipe-separator or a `[` subsearch bracket (none of them inside a quoted
 * string), + optional whitespace + the command name as a word boundary.
 * This means a literal field value containing the word `collect` won't
 * false-match (e.g. `... | search action="collect_data"` is fine, and so
 * is a field named `fitness`, `rest_time` or a search term `ai` inside a
 * value), but `... | collect index=foo`, `[| outputlookup x]` and a query
 * that starts with a command (`outputlookup x`) are blocked. (Before build
 * 376 only a `|` anchored the match.)
 *
 * Limitations of the denylist on its own (acknowledged; the allow-list of
 * build 377 closes the first and the macro one for ad-hoc queries):
 *   - Denylist: see above — other apps' custom commands and external
 *     lookups are not covered unless named here.
 *   - Over-blocking, all fail-closed: a forbidden word in quoted text
 *     (`"savedsearch"`, `"dnslookup"`) is refused, and so is one that only
 *     appears once quote characters are removed (`"saved""search"`,
 *     `x="dns"lookup`); a backtick or three backticks inside a quoted
 *     value is refused; a query that STARTS with a command word, plainly
 *     or quoted (`delete`, `"run"`, `'run'`), is refused although Splunk
 *     would read it as a search term; a `|` or `[` inside a single-quoted
 *     string is read as a command position. MLTK: a `fit` command
 *     followed ANYWHERE later in the query by the word `into` is refused,
 *     even when `into` belongs to another command or to quoted text —
 *     `| fit X | stats count by into`, `| fit X by "a into b"`,
 *     `| fit X | eval note="into"`, and a `| fit X` ahead of a subsearch
 *     or a later pipe that holds `into`. A false-positive block prompts
 *     the user / AI to re-query.
 *   - Macros: only the App's own are allowed, and the guard trusts their
 *     NAMES, not their definitions. The definition Splunk expands is the
 *     one in effect for the dispatching user and app: a local/macros.conf
 *     override in this App, the user's own private macro or another app's
 *     globally exported macro of the same name can take precedence over
 *     the definition the App ships. Keeping the three macros unshadowed is
 *     the admin's responsibility (`splunk btool macros list <name>
 *     --debug` shows the one in effect). Adding a macro that takes
 *     arguments needs a review too: its arguments are substituted into
 *     its definition, so one that puts an argument where a command can go
 *     would let the arguments carry any command.
 *   - Subsearches: `[search ... | collect index=x]` is detected
 *     (the `|` before `collect` matches regardless of `[ ]`), and so is
 *     `[| outputlookup x]` / `[collect ...]`.
 *   - Role permissions stay the authoritative gate: the guard is a
 *     defense-in-depth layer, not a replacement for sound role
 *     configuration.
 *
 * Added in build 79 per OWASP LLM Top 10 (2025) compliance review
 * (see design doc Appendix D, recommendation 3). Widened in build 376
 * (session 149): `savedsearch`, `map`, `mcollect`, `meventcollect`,
 * `runshellscript`, `dump`, MLTK's `ai` and `deletemodel` and
 * `fit ... into` added; the `^` / `[` anchors added; inline comments,
 * unmatched backticks and every macro outside the App's own refused;
 * every searchbnf.conf alias of a listed command (`macro`, `savedsplunk`,
 * `stash`, `summaryindex`, `sumindex`), `rest`, `createrss`, `outputtext`,
 * `outputtelemetry`, `curl`, `wget`, `sendresults` and the `dnslookup`
 * external lookup added; quoted text no longer read as SPL structure,
 * and ambiguous quoting refused; a word split by double or single quotes
 * read as the joined word, and `fit` refused whenever `into` follows it
 * anywhere. Build 377: the allow-list (`analyzeAdHocSpl`) behind it, and
 * the agreement check against Splunk's search parser.
 */
import {
    APP_MACRO_DEFINITIONS,
    DATA_MACRO,
    SplCommand,
    SplPipeline,
    SplToken,
    commandName,
    commandSequence,
    lexSpl,
    searchArgsFrom,
} from './splLexer';

export interface SplAnalysisResult {
    /** True if the SPL contains a forbidden operator. */
    blocked: boolean;
    /** The forbidden operator that triggered the block, lowercased. */
    operator?: string;
    /** Human-readable reason (safe to surface to the AI / user). */
    reason?: string;
    /**
     * Build 377: the command, lookup or macro the refusal is about - a short
     * name the model wrote (`fit`, `customer_hr_lookup`), recorded in the
     * audit event's `command` field. Absent when the refusal is not about one.
     */
    command?: string;
}

/**
 * SPL commands that write data, send alerts, run scripts, send data out or
 * otherwise produce side effects, refused at command position. Lowercase,
 * no `|` prefix. `map` stays LAST (the build gate reads this list).
 *
 * Sources:
 *   - Splunk Search Reference (commands marked "writes to", "sends",
 *     or "runs an external script"), and the `is_risky` commands
 *   - The aliases: every `alias =` line of the listed commands' stanzas in
 *     $SPLUNK_HOME/etc/system/default/searchbnf.conf (Splunk 9.4.3, read
 *     on the search head in session 149). Only three of them have one:
 *     [script-command] L3758 (alias L3760), [savedsearch-command] L3791
 *     (alias L3793), [collect-command] L4433 (alias L4435). None of the
 *     other listed built-ins declares an alias, nor does
 *     splunk_instrumentation's searchbnf.conf for `outputtelemetry`.
 *     MLTK and the third-party apps are not installed there, so an alias
 *     they may declare for `ai`, `deletemodel`, `curl`, `wget` or
 *     `sendresults` is not covered.
 *   - Internal review of which commands have permission gates
 *     (`can_delete`, `edit_lookups`, `edit_alerts`, etc.)
 */
export const FORBIDDEN_SPL_COMMANDS = [
    // Writes events to an index — bypasses normal ingest path.
    // searchbnf.conf L4433 [collect-command], L4435:
    // `alias = stash, summaryindex, sumindex`.
    'collect',
    'stash',
    'summaryindex',
    'sumindex',
    // Writes metrics / events to an index (the metrics-store `collect`s;
    // searchbnf.conf L4582, L4662, no alias)
    'mcollect',
    'meventcollect',
    // Writes / replaces / appends a CSV lookup file (L3246, L3217)
    'outputlookup',
    'outputcsv',
    // Rewrites each result's _raw into _xml (L3338)
    'outputtext',
    // Soft-deletes events; needs `can_delete` (L1235)
    'delete',
    // Triggers an alert action (email, script, webhook, custom) (L3824, L3855)
    'sendalert',
    'sendemail',
    // Runs an external script command (Python / shell). searchbnf.conf
    // L3758 [script-command], L3760: `alias = run`. runshellscript: L6497.
    'script',
    'run',
    'runshellscript',
    // Writes the search results to files on the search head (L3187)
    'dump',
    // Writes a tsidx namespace (summary data) to disk (L5469)
    'tscollect',
    // Adds an item to an RSS feed on the search head, creating the feed
    // (L1068; the search app's commands.conf marks it is_risky)
    'createrss',
    // Reads any REST endpoint the user may read (L6150) — including
    // storage/passwords, whose `clear_password` is every stored
    // credential, decrypted.
    'rest',
    // Sends the rows to Splunk's telemetry service. splunk_instrumentation
    // default/searchbnf.conf L1 [outputtelemetry-command], no alias.
    'outputtelemetry',
    // Third-party commands that send data off the search head: HTTP
    // requests to any URL (`curl`, `wget`, e.g. TA-webtools) and emailing
    // results (`sendresults`).
    'curl',
    'wget',
    'sendresults',
    // MLTK / AI Toolkit: `ai` sends the piped rows to an external LLM
    // (the no-event-data-to-a-vendor invariant); `deletemodel` deletes a
    // saved model. (`fit ... into` is refused by fitThenInto below.)
    'ai',
    'deletemodel',
    // savedsearch's aliases: searchbnf.conf L3791 [savedsearch-command],
    // L3793: `alias = macro, savedsplunk`. `macro` is refused at command
    // position only (it is a common word); `savedsearch` and `savedsplunk`
    // are refused anywhere as words too (FORBIDDEN_SPL_WORDS).
    'macro',
    'savedsplunk',
    // Runs a search once per input row — any search, writers included
    // (searchbnf.conf L2942 [map-command], no alias)
    'map',
] as const;

/**
 * Words refused ANYWHERE in the query (quoted text included), not only as
 * a command after `|`: `savedsearch` reruns a saved search as
 * `| savedsearch X`, and also as a dataset — `| from savedsearch:X`,
 * `| union savedsearch:X` — or inside a subsearch; `savedsplunk` is its
 * alias (searchbnf.conf L3793). Matched as a whole word, so a field like
 * `savedsearch_name` is not affected.
 */
export const FORBIDDEN_SPL_WORDS = [
    'savedsearch',
    'savedsplunk',
] as const;

/**
 * External lookups that send data off the search head, refused as a word
 * anywhere in the query. `dnslookup` is Splunk's own
 * (system/default/transforms.conf [dnslookup], `external_cmd =
 * external_lookup.py clienthost clientip`): each row is a DNS query, so a
 * value built into a host name reaches the domain's name server.
 */
export const EXTERNAL_LOOKUPS = [
    'dnslookup',
] as const;

/**
 * The only macros an ad-hoc query may reference: the stanza names of this
 * App's default/macros.conf, exactly (the consistency test and the
 * build gate compare the two). A stanza written `name(n)` takes n
 * arguments and is referenced as `name(a, ...)`.
 */
export const ALLOWED_SPL_MACROS = [
    'sap_logserv_idx_macro',
    'sap_logserv_audit_idx_macro',
    'sap_logserv_cloud_provider_default_macro',
] as const;

/** Operators reported for the refusals that are not a command or a word. */
export const OPERATOR_INLINE_COMMENT = 'inline_comment';
export const OPERATOR_UNBALANCED_BACKTICK = 'unbalanced_backtick';
export const OPERATOR_UNTERMINATED_QUOTE = 'unterminated_quote';
export const OPERATOR_ESCAPED_QUOTE = 'escaped_quote';
export const OPERATOR_EXTERNAL_LOOKUP = 'external_lookup';
export const OPERATOR_FIT_INTO = 'fit_into';
export const OPERATOR_MACRO = 'macro';

/** Splunk's inline comment delimiter: three backticks. */
const INLINE_COMMENT = '```';

/**
 * Pre-built case-insensitive regex matching `<start | pipe | [><whitespace><cmd>`
 * with a word boundary after the command name. Built once at module
 * load to amortize the construction cost across many dispatches. Run on
 * the quote-blanked copy of the query.
 *
 * Pattern: `(?:^|\||\[)\s*(?:collect|outputlookup|...)\b` flags `i` and `g`.
 */
const FORBIDDEN_RE = new RegExp(
    `(?:^|\\||\\[)\\s*(${FORBIDDEN_SPL_COMMANDS.join('|')})\\b`,
    'gi',
);

/** The bare-word match for FORBIDDEN_SPL_WORDS: `\b(?:savedsearch|savedsplunk)\b`, flags `i` and `g`. */
const FORBIDDEN_WORD_RE = new RegExp(
    `\\b(${FORBIDDEN_SPL_WORDS.join('|')})\\b`,
    'gi',
);

/** The word match for EXTERNAL_LOOKUPS, flag `i` only (no state between calls). */
const EXTERNAL_LOOKUP_RE = new RegExp(
    `\\b(${EXTERNAL_LOOKUPS.join('|')})\\b`,
    'i',
);

/**
 * A command word, its quote characters removed, that starts with a
 * forbidden command or a forbidden word (`| "saved"search X`).
 */
const FORBIDDEN_COMMAND_WORD_RE = new RegExp(
    `^(${[...FORBIDDEN_SPL_COMMANDS, ...FORBIDDEN_SPL_WORDS].join('|')})\\b`,
    'i',
);

/** Every quote character, double and single. */
const QUOTE_CHARS_RE = /["']/g;

/** A quote character, double or single (no state between calls). */
const HAS_QUOTE_RE = /["']/;

/**
 * The text with every quote character removed and the quoted content
 * kept, so a word split by quotes reads as one (`"saved"search`).
 */
const removeQuoteChars = (text: string): string => text.replace(QUOTE_CHARS_RE, '');

/**
 * A command position: a `|`, a `[` or the start, then optional whitespace.
 * `^` comes last so that a query starting with `|` or `[` consumes it.
 */
const COMMAND_POSITION_RE = /(?:\||\[|^)\s*/g;

/** The word at a command position: plain characters and whole quoted strings. */
const COMMAND_TOKEN_RE = /^(?:"(?:[^"\\]|\\[\s\S])*"|[^\s"|[\]])+/;

/** MLTK's `fit` at the start of a command word. No `g` flag. */
const FIT_WORD_RE = /^fit\b/i;

/** The word `into`, anywhere. No `g` flag. */
const INTO_WORD_RE = /\binto\b/i;

/** A macro reference: the name, then optionally `(arguments)`. */
const MACRO_REF_RE = /^([A-Za-z0-9_][A-Za-z0-9_.-]*)(?:\(([\s\S]*)\))?$/;

/** The result of blankQuotedStrings. */
export interface QuoteScan {
    /**
     * The query with the content of every double-quoted string replaced by
     * spaces (escape pairs included); the quote characters, every other
     * character and the length are unchanged. Empty when a problem is set.
     */
    text: string;
    /** A double quote that is never closed. */
    unterminated: boolean;
    /** A backslash-escaped double quote outside a quoted string. */
    escapedQuote: boolean;
}

/**
 * Blank the content of every double-quoted string, honouring backslash
 * escapes inside it (`\"` and `\\` do not end the string), so positions in
 * the result are positions in the query. A backslash before a double quote
 * OUTSIDE a quoted string, and a string that is never closed, are reported
 * instead: either would make what the guard reads as quoted differ from
 * what Splunk does.
 */
export const blankQuotedStrings = (query: string): QuoteScan => {
    let out = '';
    let quoted = false;
    for (let i = 0; i < query.length; i += 1) {
        const c = query.charAt(i);
        if (quoted) {
            if (c === '\\' && i + 1 < query.length) {
                out += '  ';
                i += 1;
            } else if (c === '"') {
                quoted = false;
                out += c;
            } else {
                out += ' ';
            }
        } else if (c === '\\' && query.charAt(i + 1) === '"') {
            return { text: '', unterminated: false, escapedQuote: true };
        } else {
            if (c === '"') {
                quoted = true;
            }
            out += c;
        }
    }
    if (quoted) {
        return { text: '', unterminated: true, escapedQuote: false };
    }
    return { text: out, unterminated: false, escapedQuote: false };
};

/**
 * A forbidden command or word written with quotes (double or single) in its
 * command word (`| "delete"`, `| de'lete'`, `| sav"edsearch"`): command
 * positions come from the blanked copy, the word from the query with its
 * quote characters removed. Returns the command, lowercased, or null.
 */
const quotedForbiddenCommand = (query: string, unquoted: string): string | null => {
    COMMAND_POSITION_RE.lastIndex = 0;
    let m = COMMAND_POSITION_RE.exec(unquoted);
    while (m !== null) {
        const at = m.index + m[0].length;
        if (m[0].length === 0) {
            COMMAND_POSITION_RE.lastIndex += 1;
        }
        const tok = COMMAND_TOKEN_RE.exec(query.slice(at));
        if (tok && HAS_QUOTE_RE.test(tok[0])) {
            const w = FORBIDDEN_COMMAND_WORD_RE.exec(removeQuoteChars(tok[0]));
            if (w) {
                return w[1].toLowerCase();
            }
        }
        m = COMMAND_POSITION_RE.exec(unquoted);
    }
    return null;
};

/**
 * MLTK `fit ... into <model>`, fail-closed against any quoting: true when a
 * command word at a command position of the blanked copy is `fit` (read on
 * the blanked copy, or on the query's word with its quote characters
 * removed: `"fit"`, `f'it'`) and the word `into` appears anywhere from
 * there to the END of the query, in a copy with every quote character
 * removed (`"in"to`) or turned into a space (`"a"into`). The first `fit`
 * decides: `into` after any later `fit` is also after the first.
 */
const fitThenInto = (query: string, unquoted: string): boolean => {
    COMMAND_POSITION_RE.lastIndex = 0;
    let m = COMMAND_POSITION_RE.exec(unquoted);
    while (m !== null) {
        const at = m.index + m[0].length;
        if (m[0].length === 0) {
            COMMAND_POSITION_RE.lastIndex += 1;
        }
        const tok = COMMAND_TOKEN_RE.exec(query.slice(at));
        if (FIT_WORD_RE.test(unquoted.slice(at)) || (tok !== null && FIT_WORD_RE.test(removeQuoteChars(tok[0])))) {
            const rest = query.slice(at);
            return INTO_WORD_RE.test(removeQuoteChars(rest)) || INTO_WORD_RE.test(rest.replace(QUOTE_CHARS_RE, ' '));
        }
        m = COMMAND_POSITION_RE.exec(unquoted);
    }
    return false;
};

/**
 * Count a macro reference's arguments: commas outside double quotes, plus
 * one; none when the text between the parentheses is blank.
 */
const countMacroArgs = (args: string): number => {
    if (args.trim().length === 0) return 0;
    let n = 1;
    let quoted = false;
    for (let i = 0; i < args.length; i += 1) {
        const c = args.charAt(i);
        if (c === '\\') {
            i += 1;
        } else if (c === '"') {
            quoted = !quoted;
        } else if (c === ',' && !quoted) {
            n += 1;
        }
    }
    return n;
};

/**
 * True when the text between a pair of backticks references a macro in
 * `allowed` exactly: the bare name of a stanza without arguments, or
 * `name(...)` with as many arguments as a `name(n)` stanza declares.
 * Anything else — whitespace around the name, a case variant, `name()`
 * for a stanza without arguments, a wrong argument count — is refused.
 */
export const macroReferenceAllowed = (
    ref: string,
    allowed: readonly string[] = ALLOWED_SPL_MACROS,
): boolean => {
    const m = MACRO_REF_RE.exec(ref);
    if (!m) return false;
    if (m[2] === undefined) return allowed.indexOf(m[1]) !== -1;
    const n = countMacroArgs(m[2]);
    return n > 0 && allowed.indexOf(`${m[1]}(${n})`) !== -1;
};

const refuse = (operator: string, reason: string): SplAnalysisResult => ({
    blocked: true,
    operator,
    reason,
});

const refuseCommand = (operator: string): SplAnalysisResult => refuse(
    operator,
    `SPL contains the operator "${operator}", which is not permitted ` +
        `in the assistant's ad-hoc queries. Only read-only analytic ` +
        `commands are allowed. Rephrase the query to read data without ` +
        `writing, deleting, or triggering alerts.`,
);

/**
 * The denylist: analyze an SPL string for forbidden commands (checks 1-7).
 *
 * Returns `{ blocked: false }` when none is found. When blocked, returns
 * the matched operator (lowercased, no pipe) and a reason string suitable
 * for surfacing to the AI as the synthetic tool-result error. These
 * reasons name no other command or macro. Ad-hoc queries go through
 * `analyzeAdHocSpl`, which runs this first and then the allow-list; with an
 * allow-list there is no perimeter left to map, so its refusals name the
 * refused command or lookup and the system primer lists the allowed
 * commands exactly.
 */
export const analyzeSpl = (query: string): SplAnalysisResult => {
    if (typeof query !== 'string' || query.length === 0) {
        return { blocked: false };
    }

    // 1. Inline comments hide words from every check below.
    if (query.indexOf(INLINE_COMMENT) !== -1) {
        return refuse(
            OPERATOR_INLINE_COMMENT,
            'SPL inline comments (three backticks) are not permitted in the ' +
                "assistant's ad-hoc queries. Send the query again without the comment.",
        );
    }

    // 2. Backticks come in pairs: each pair is one macro reference.
    const parts = query.split('`');
    if (parts.length % 2 === 0) {
        return refuse(
            OPERATOR_UNBALANCED_BACKTICK,
            'SPL has an unmatched backtick. Close the backtick pair, or remove ' +
                'the stray backtick, and send the query again.',
        );
    }

    // 3. Quoting: quoted text is data, not SPL structure.
    const scan = blankQuotedStrings(query);
    if (scan.unterminated) {
        return refuse(
            OPERATOR_UNTERMINATED_QUOTE,
            'SPL has a double quote that is never closed. Close the quoted ' +
                'string and send the query again.',
        );
    }
    if (scan.escapedQuote) {
        return refuse(
            OPERATOR_ESCAPED_QUOTE,
            'SPL has a backslash-escaped double quote outside a quoted string, ' +
                "which is not permitted in the assistant's ad-hoc queries. Put it " +
                'inside a quoted string, or drop the backslash, and send the query again.',
        );
    }
    const unquoted = scan.text;
    // Every quote character removed, content kept: a word split by quotes.
    const dequoted = removeQuoteChars(query);

    // 4. Forbidden commands (outside quotes) and words (anywhere).
    // Reset regex state for stateful (`g` flag) reuse.
    FORBIDDEN_RE.lastIndex = 0;
    FORBIDDEN_WORD_RE.lastIndex = 0;
    const match = FORBIDDEN_RE.exec(unquoted) ?? FORBIDDEN_WORD_RE.exec(query);
    if (match) {
        return refuseCommand(match[1].toLowerCase());
    }
    FORBIDDEN_WORD_RE.lastIndex = 0;
    const splitWord = FORBIDDEN_WORD_RE.exec(dequoted);
    if (splitWord) {
        return refuseCommand(splitWord[1].toLowerCase());
    }
    const quotedCommand = quotedForbiddenCommand(query, unquoted);
    if (quotedCommand !== null) {
        return refuseCommand(quotedCommand);
    }

    // 5. External lookups send each row's values off the search head.
    if (EXTERNAL_LOOKUP_RE.test(query) || EXTERNAL_LOOKUP_RE.test(dequoted)) {
        return refuse(
            OPERATOR_EXTERNAL_LOOKUP,
            'SPL uses a lookup that queries an outside service, which is not ' +
                "permitted in the assistant's ad-hoc queries. Use the App's own " +
                'lookups, or write the query without it.',
        );
    }

    // 6. MLTK fit ... into saves a model: `into` anywhere after a `fit`.
    if (fitThenInto(query, unquoted)) {
        return refuse(
            OPERATOR_FIT_INTO,
            'SPL saves a model with "fit ... into", which is not permitted in the ' +
                "assistant's ad-hoc queries. Use fit without \"into\", which saves " +
                'nothing, to read data without writing.',
        );
    }

    // 7. Macros: the App's own only (odd indices are the referenced text).
    for (let i = 1; i < parts.length; i += 2) {
        if (!macroReferenceAllowed(parts[i])) {
            return refuse(
                OPERATOR_MACRO,
                'SPL references a macro this App does not define, which is not ' +
                    "permitted in the assistant's ad-hoc queries (a macro can hide " +
                    "any command). Use only this App's own macros, or write the SPL out in full.",
            );
        }
    }

    return { blocked: false };
};

/* ============================================================ allow-list */

/**
 * Build 377: the ONLY commands an ad-hoc query may use. Every other command
 * is refused (`command_not_allowed`), whatever app ships it. Three facts are
 * held by the consistency suite and the build gate: it shares nothing with
 * FORBIDDEN_SPL_COMMANDS; every command of the catalog SPL is on it; and it
 * is a subset of the Tier 2 reader's KNOWN_COMMANDS
 * (utils/vendorColumnText.ts), so the reader reads every allowed command in
 * full. Both system primers list it word for word.
 *
 * Left out on purpose: fieldformat, foreach, map, mvexpand (it can
 * manufacture counts), multisearch, set, uniq, noop, rangemap, return and
 * format (a subsearch that returns its own text could widen the search),
 * fit, apply, from, datamodel, pivot, metadata, metasearch, loadjob,
 * inputcsv, eventcount and dbinspect - and union (user decision, App build
 * 377): Splunk's search parser reports a union rewritten - as search ... |
 * append [...] or as multisearch (live probe P2) - so the parser agreement
 * would refuse every one; `append` does the same job and is reported as
 * itself. A union is refused up front with a reason that says so
 * (COMMAND_INSTEAD).
 */
export const ALLOWED_SPL_COMMANDS = [
    'search', 'where', 'eval', 'stats', 'eventstats', 'streamstats', 'tstats', 'chart', 'timechart', 'top', 'rare',
    'sort', 'head', 'tail', 'dedup', 'reverse', 'table', 'fields', 'rename', 'fillnull', 'filldown', 'bin', 'bucket',
    'rex', 'regex', 'spath', 'lookup', 'inputlookup', 'makeresults', 'addinfo', 'transaction', 'convert', 'iplocation',
    'strcat', 'xyseries', 'untable', 'transpose', 'fieldsummary', 'addtotals', 'addcoltotals', 'makemv', 'nomv',
    'mvcombine', 'append', 'appendcols', 'join', 'appendpipe',
] as const;

/**
 * Build 377: the only lookups an ad-hoc query may name (`lookup`,
 * `inputlookup`): this App's lookup stanzas in default/transforms.conf (a
 * `filename` or a `collection`), minus EXCLUDED_SPL_LOOKUPS. The consistency
 * suite and the build gate compare the two lists with transforms.conf.
 */
export const ALLOWED_SPL_LOOKUPS = [
    'isc_bind_action_lookup',
    'isc_bind_category_lookup',
    'isc_bind_reply_code_lookup',
    'isc_bind_severities_lookup',
    'logserv_abapnet_rollup',
    'logserv_beaconing_detail_rollup',
    'logserv_beaconing_rollup',
    'logserv_cloudconn_rollup',
    'logserv_compliance_rollup',
    'logserv_dns_rollup',
    'logserv_hana_category_rollup',
    'logserv_hana_trace_rollup',
    'logserv_hostdetails_rollup',
    'logserv_hostrole_rollup',
    'logserv_linux_rollup',
    'logserv_mc_rollup',
    'logserv_perimeter_rollup',
    'logserv_pipeline_rollup',
    'logserv_proxy_rollup',
    'logserv_saprouter_rollup',
    'logserv_sapservices_rollup',
    'logserv_severity_rollup',
    'logserv_sourcetype_metadata_lookup',
    'logserv_stmap_rollup',
    'logserv_ti_compromised_credentials',
    'logserv_ti_malicious_domains',
    'logserv_ti_malicious_ips',
    'logserv_topology_detail_rollup',
    'logserv_topology_edges',
    'logserv_topology_inventory',
    'logserv_topology_ip_enrichment',
    'logserv_topology_nodes',
    'logserv_web_timing_rollup',
    'logserv_webdisp_slowtrace_rollup',
    'logserv_windows_rollup',
    'logserv_wp_perf_rollup',
    'logserv_xstack_auth_rollup',
    'squid_actions_lookup',
    'squid_httpstatus_lookup',
] as const;

/**
 * The App's lookups an ad-hoc query may NOT name: the Data Doctor's own
 * collections (reports and platform snapshots, which hold raw samples and
 * user names) and the ES asset and identity feeds (identities; analytics
 * never needs them).
 */
export const EXCLUDED_SPL_LOOKUPS = [
    'logserv_backfill_stage',
    'logserv_diag_platform_snapshot',
    'logserv_diag_reports',
    'splunk_for_sap_logserv_assets',
    'splunk_for_sap_logserv_identities',
] as const;

/** The commands that may hold a subsearch (`[...]`), and how each one reads it. */
export const SUBSEARCH_HOSTS = ['search', 'append', 'appendcols', 'join', 'appendpipe'] as const;

/** The commands a query, or a subsearch arm, may start with (each with its own rule). */
export const START_COMMANDS = ['search', 'inputlookup', 'tstats', 'makeresults'] as const;

/** Field names a filter subsearch may not return: Splunk inserts their values into the outer search as text. */
export const FILTER_SUBSEARCH_RESERVED_FIELDS = ['search', 'query'] as const;

/** Operators of the allow-list refusals (build 377). */
export const OPERATOR_COMMAND_NOT_ALLOWED = 'command_not_allowed';
export const OPERATOR_QUERY_START = 'query_start';
export const OPERATOR_INDEX_NOT_ALLOWED = 'index_not_allowed';
export const OPERATOR_LOOKUP_NOT_ALLOWED = 'lookup_not_allowed';
export const OPERATOR_EVAL_LOOKUP = 'eval_lookup';
export const OPERATOR_SUBSEARCH_NOT_ALLOWED = 'subsearch_not_allowed';
export const OPERATOR_SUBSEARCH_FIELDS = 'subsearch_fields';
export const OPERATOR_MACRO_POSITION = 'macro_position';
export const OPERATOR_AMBIGUOUS_SINGLE_QUOTE = 'ambiguous_single_quote';
export const OPERATOR_UNBALANCED_BRACKET = 'unbalanced_bracket';
/** A backslash outside double quotes (security review of build 377): Splunk reads `\|` as no command boundary. */
export const OPERATOR_ESCAPED_OUTSIDE_QUOTES = 'escaped_outside_quotes';
/** Operators of the agreement check against Splunk's search parser (build 377). */
export const OPERATOR_PARSER_MISMATCH = 'parser_mismatch';
export const OPERATOR_PARSER_REJECTED = 'parser_rejected';
export const OPERATOR_PARSER_UNAVAILABLE = 'parser_unavailable';

/** Every operator the allow-list and the parser check can report, for the docs and the suites. */
export const ALLOW_LIST_OPERATORS = [
    OPERATOR_COMMAND_NOT_ALLOWED, OPERATOR_QUERY_START, OPERATOR_INDEX_NOT_ALLOWED, OPERATOR_LOOKUP_NOT_ALLOWED,
    OPERATOR_EVAL_LOOKUP, OPERATOR_SUBSEARCH_NOT_ALLOWED, OPERATOR_SUBSEARCH_FIELDS,
    OPERATOR_MACRO_POSITION, OPERATOR_AMBIGUOUS_SINGLE_QUOTE, OPERATOR_UNBALANCED_BRACKET, OPERATOR_ESCAPED_OUTSIDE_QUOTES,
    OPERATOR_PARSER_MISMATCH, OPERATOR_PARSER_REJECTED, OPERATOR_PARSER_UNAVAILABLE,
] as const;

const ALLOWED_COMMAND_SET: ReadonlySet<string> = new Set<string>(ALLOWED_SPL_COMMANDS);
const ALLOWED_LOOKUP_SET: ReadonlySet<string> = new Set<string>(ALLOWED_SPL_LOOKUPS);
const SUBSEARCH_HOST_SET: ReadonlySet<string> = new Set<string>(SUBSEARCH_HOSTS);
const FORBIDDEN_NAME_SET: ReadonlySet<string> = new Set<string>([...FORBIDDEN_SPL_COMMANDS, ...FORBIDDEN_SPL_WORDS]);

/** The audit macro: a data source an ad-hoc query may not read. */
const AUDIT_MACRO = 'sap_logserv_audit_idx_macro';

/**
 * An `index` term in the raw query (double-quoted content blanked): `index=`,
 * `index!=`, `index==`, `index::` or `index IN (`, as a word of its own (not
 * `index_name=`, not `x.index=`), case-insensitive.
 */
const INDEX_TERM_RE = /(^|[^A-Za-z0-9_.:$-])index'?\s*(?:!?==?|::|\s+in\s*\()/i;

/** The same with the field name in double quotes (`"index"=main`), read on the raw query. */
const QUOTED_INDEX_TERM_RE = /"index"\s*(?:!?==?|::|\s+in\s*\()/i;

/** OR or NOT right before, or OR right after, the data macro. */
const OR_NEXT_TO_DATA_MACRO_RE = new RegExp(`\\b(?:OR|NOT)\\s*\`${DATA_MACRO}\`|\`${DATA_MACRO}\`\\s*OR\\b`, 'i');

/** A name the model wrote, safe to record in the audit event and to quote back; '(unnamed)' otherwise. */
export const safeName = (s: string): string => (/^[A-Za-z0-9_.:-]{1,64}$/.test(s) ? s : '(unnamed)');

/** The result of `analyzeAdHocSpl`. */
export interface AdHocSplAnalysis extends SplAnalysisResult {
    /**
     * For a query that passed: its top-level command names, macro commands
     * expanded - what Splunk's search parser must report for it.
     */
    commands?: string[];
    /** For a query that passed: true when it is a search that starts with the data macro. */
    startsWithDataMacro?: boolean;
}

const refuseNamed = (operator: string, reason: string, command?: string): AdHocSplAnalysis => (command === undefined
    ? { blocked: true, operator, reason }
    : { blocked: true, operator, reason, command });

const MACRO_REF = `\`${DATA_MACRO}\``;

/**
 * Commands off the allow-list whose refusal says what to write instead (still
 * `command_not_allowed`, the command named as usual). `union` (App build 377,
 * user decision): Splunk's search parser reports a union rewritten - as
 * `search ... | append [...]` when an arm transforms or reads a lookup, as
 * `multisearch` when every arm streams (live probe P2) - so the parser
 * agreement would refuse every union; `append` combines two searches and is
 * reported as itself.
 */
export const COMMAND_INSTEAD: Readonly<Record<string, string>> = Object.freeze({
    union: "Splunk's search parser rewrites a union (as append or multisearch), so the App cannot check it. To "
        + `combine two searches, use append: <first search> | append [search ${MACRO_REF} ...].`,
});

const reasonCommand = (c: string): string => `The command "${c}" is not on the assistant's allow-list for ad-hoc `
    + 'queries, so the query was not run. ' + (Object.prototype.hasOwnProperty.call(COMMAND_INSTEAD, c)
    ? COMMAND_INSTEAD[c] : 'Use only the commands the system primer lists.');

const reasonQueryStart = (c: string): string => 'An ad-hoc query, and every subsearch in it, must start with the '
    + `index macro (${MACRO_REF}) as its first term, or with | inputlookup <one of the App's lookups>, `
    + `| tstats ... WHERE ${MACRO_REF} or | makeresults. This one starts with "${c}".`;

/** One own token of a command: a term whose text, lower-cased, is `w`. */
const isTermWord = (t: SplToken | undefined, w: string): boolean => !!t && t.kind === 'term' && t.text.toLowerCase() === w;

/** A `name=value` option: a term holding `=`, or a term ending in `=` with a quoted value right after it. */
const optionWidth = (tokens: SplToken[], i: number): number => {
    const t = tokens[i];
    if (!t || t.kind !== 'term' || t.text.indexOf('=') <= 0) return 0;
    const next = tokens[i + 1];
    if (t.text.endsWith('=') && next && (next.kind === 'dquote' || next.kind === 'squote') && next.start === t.end) return 2;
    return 1;
};

/**
 * The lookup a `lookup` / `inputlookup` command names: its first token after
 * the options. Security review of build 377: the name must be the one Splunk
 * reads too, so an option whose value is quoted (`x='a b c'`, `x="a"`: Splunk's
 * command-argument reader is not known to group single quotes) and a name with
 * a token glued to it (`logserv_mc_rollup"_x"`) give '(quoted)', which no
 * lookup is - the query is refused.
 */
const lookupNameOf = (cmd: SplCommand): string => {
    let i = 1;
    while (i < cmd.tokens.length) {
        const w = optionWidth(cmd.tokens, i);
        if (w === 0) break;
        if (w !== 1) return '(quoted)';
        i += w;
    }
    const t = cmd.tokens[i];
    if (!t) return '';
    if (t.kind !== 'term') return '(quoted)';
    const before = cmd.tokens[i - 1];
    const after = cmd.tokens[i + 1];
    if ((before && before.end === t.start) || (after && after.start === t.end)) return '(quoted)';
    return t.text;
};

/**
 * The eval `lookup(` function in a command's own tokens: a word ending in
 * `lookup` followed by `(`, with or without whitespace (a newline included)
 * between them - `lookup (` must not get past as another reading of the
 * same call. A search for the word `lookup` before a parenthesized group is
 * refused too; no analytic query needs that.
 */
const hasEvalLookup = (cmd: SplCommand): boolean => cmd.tokens.some((t, i) => t.kind === 'term'
    && /(?:^|[^A-Za-z0-9_])lookup$/i.test(t.text) && !!cmd.tokens[i + 1] && cmd.tokens[i + 1].kind === 'lparen');

type PipelineMode = 'main' | 'filter' | 'arm' | 'pipe';

/** Where a macro may stand (a macro inside quotes never may - analyzeAdHocSpl refuses that first). */
const macroProblem = (p: SplPipeline, k: number, name: string, argsFrom: number, isSource: boolean): AdHocSplAnalysis | null => {
    const cmd = p.commands[k];
    const implicitFirst = k === 0 && isSource && !p.leadingPipe;
    for (let i = 0; i < cmd.tokens.length; i += 1) {
        const t = cmd.tokens[i];
        if (t.kind !== 'macro') continue;
        if (t.text === DATA_MACRO) {
            const atStart = k === 0 && isSource && name === 'search' && i === argsFrom;
            const afterWhere = name === 'tstats' && isTermWord(cmd.tokens[i - 1], 'where');
            if (atStart || afterWhere) continue;
        } else if (t.text === AUDIT_MACRO) {
            return refuseNamed(OPERATOR_INDEX_NOT_ALLOWED, 'Ad-hoc queries read only the LogServ index; the AI '
                + "Assistant's own audit index is not available to them.", AUDIT_MACRO);
        } else if (i === 0 && !implicitFirst && commandName(p, k, !isSource) !== '') {
            // A macro that expands to a command (the cloud-provider macro), used as that whole command.
            continue;
        }
        return refuseNamed(OPERATOR_MACRO_POSITION, `The macro "${safeName(t.text)}" may stand only as the first term `
            + 'of a search, right after WHERE in tstats, or - one that expands to a command - as a whole command.',
        safeName(t.text));
    }
    return null;
};

/**
 * tstats reads the index named after its WHERE - with none, every index the
 * user searches by default - so EVERY tstats, at the start of a query or later
 * in it (`prestats=t append=t`), must have the data macro right after WHERE.
 */
const tstatsProblem = (cmd: SplCommand): AdHocSplAnalysis | null => {
    const w = cmd.tokens.findIndex((t) => isTermWord(t, 'where'));
    const next = w === -1 ? undefined : cmd.tokens[w + 1];
    if (next && next.kind === 'macro' && next.text === DATA_MACRO) return null;
    return refuseNamed(OPERATOR_QUERY_START, 'tstats in an ad-hoc query must name the LogServ index right after '
        + `WHERE: | tstats ... WHERE ${MACRO_REF} ...`, 'tstats');
};

/** The start rule of a query or a subsearch arm (`k === 0`, not an appendpipe group). */
const startProblem = (p: SplPipeline, name: string, argsFrom: number): AdHocSplAnalysis | null => {
    const cmd = p.commands[0];
    switch (name) {
        case 'search': {
            const first = cmd.tokens[argsFrom];
            const groupFirst = cmd.groupAt.length > 0 && cmd.groupAt[0] <= argsFrom;
            if (!groupFirst && first && first.kind === 'macro' && first.text === DATA_MACRO) return null;
            const what = groupFirst ? '[' : first ? (first.kind === 'macro' ? first.text : first.text.split('=')[0]) : '';
            return refuseNamed(OPERATOR_QUERY_START, reasonQueryStart(safeName(what)), safeName(what));
        }
        case 'tstats':
            return tstatsProblem(cmd);
        case 'inputlookup':
        case 'makeresults':
            return null;
        default:
            return refuseNamed(OPERATOR_QUERY_START, reasonQueryStart(safeName(name)), safeName(name));
    }
};

/**
 * A filter subsearch (`search ... [ ... ]`) must end with `fields` or `table`
 * naming the fields it returns - no wildcard, no `-`, not `search` or
 * `query` (Splunk inserts those values into the outer search as text).
 */
const filterEndProblem = (g: SplPipeline): AdHocSplAnalysis | null => {
    const last = g.commands.length - 1;
    const name = commandName(g, last);
    const cmd = g.commands[last];
    const names: string[] = [];
    let ok = (name === 'fields' || name === 'table') && cmd.groups.length === 0;
    for (let i = 1; ok && i < cmd.tokens.length; i += 1) {
        const t = cmd.tokens[i];
        if (t.kind !== 'term') {
            ok = false;
            break;
        }
        t.text.split(',').filter((x) => x.length > 0).forEach((x) => names.push(x));
    }
    ok = ok && names.length > 0 && names.every((x) => /^[A-Za-z_][A-Za-z0-9_.:]*$/.test(x)
        && (FILTER_SUBSEARCH_RESERVED_FIELDS as readonly string[]).indexOf(x.toLowerCase()) === -1);
    return ok ? null : refuseNamed(OPERATOR_SUBSEARCH_FIELDS, 'A filter subsearch must end with fields or table naming '
        + 'the fields it returns (no wildcard, not search or query), so that its result can only filter.',
    name ? safeName(name) : undefined);
};

/** Check one pipeline of the tree; null when every command in it (and below it) is allowed. */
const checkPipeline = (p: SplPipeline, mode: PipelineMode): AdHocSplAnalysis | null => {
    const isSource = mode !== 'pipe';
    if (p.commands.length === 0) {
        return refuseNamed(OPERATOR_QUERY_START, 'The ad-hoc query has an empty search or subsearch.');
    }
    for (let k = 0; k < p.commands.length; k += 1) {
        const cmd = p.commands[k];
        const name = commandName(p, k, !isSource);
        const argsFrom = k === 0 && isSource && !p.leadingPipe ? searchArgsFrom(p) : 1;
        if (name === '') {
            return refuseNamed(OPERATOR_COMMAND_NOT_ALLOWED, 'The ad-hoc query has a command with no name (an empty '
                + 'command, or one that starts with a quote or a bracket), so it was not run.', '(unnamed)');
        }
        if (!ALLOWED_COMMAND_SET.has(name)) {
            return refuseNamed(OPERATOR_COMMAND_NOT_ALLOWED, reasonCommand(safeName(name)), safeName(name));
        }
        const m = macroProblem(p, k, name, argsFrom, isSource);
        if (m) return m;
        if (k === 0 && isSource) {
            const s = startProblem(p, name, argsFrom);
            if (s) return s;
        } else if (name === 'tstats') {
            const s = tstatsProblem(cmd);
            if (s) return s;
        }
        if (name === 'lookup' || name === 'inputlookup') {
            const lk = lookupNameOf(cmd);
            if (!ALLOWED_LOOKUP_SET.has(lk)) {
                return refuseNamed(OPERATOR_LOOKUP_NOT_ALLOWED, `The lookup "${safeName(lk)}" is not one of this App's `
                    + "lookups, so the query was not run. Ad-hoc queries may use only the App's own lookups and rollups.",
                safeName(lk));
            }
        }
        if (hasEvalLookup(cmd)) {
            return refuseNamed(OPERATOR_EVAL_LOOKUP, 'The eval lookup() function is not allowed in ad-hoc queries; use the '
                + "lookup command with one of the App's lookups.", 'lookup');
        }
        if (cmd.groups.length > 0) {
            if (!SUBSEARCH_HOST_SET.has(name) || (name === 'appendpipe' && cmd.groups.length !== 1)) {
                return refuseNamed(OPERATOR_SUBSEARCH_NOT_ALLOWED, 'A subsearch is allowed only in search (as a filter), '
                    + `append, appendcols, join and appendpipe (one group); "${name}" may not hold this one.`, name);
            }
            for (const g of cmd.groups) {
                const sub = checkPipeline(g, name === 'appendpipe' ? 'pipe' : name === 'search' ? 'filter' : 'arm');
                if (sub) return sub;
                if (name === 'search') {
                    const f = filterEndProblem(g);
                    if (f) return f;
                }
            }
        }
    }
    return null;
};

/** The denylist's reason for the `macro` command (savedsearch's alias), as opposed to a foreign macro reference. */
const MACRO_COMMAND_REASON = refuseCommand(OPERATOR_MACRO).reason;

/**
 * The first macro reference (between a pair of backticks) that is not one of
 * the App's own, by its name as the AI wrote it (through `safeName`; the
 * whole reference when it has no name shape); null when every reference is
 * allowed.
 */
const foreignMacroName = (query: string): string | null => {
    const parts = query.split('`');
    for (let i = 1; i < parts.length; i += 2) {
        if (!macroReferenceAllowed(parts[i])) {
            const m = MACRO_REF_RE.exec(parts[i]);
            return safeName(m ? m[1] : parts[i]);
        }
    }
    return null;
};

const LEX_REFUSALS: Readonly<Record<string, [string, string]>> = {
    ambiguous_single_quote: [OPERATOR_AMBIGUOUS_SINGLE_QUOTE, 'The ad-hoc query has a single quote that does not '
        + 'enclose a plain field name (an apostrophe in a search term, or a pipe, a bracket, a quote or a backtick '
        + 'inside single quotes). Put a search term that contains an apostrophe in double quotes, and use single quotes '
        + 'only around field names.'],
    unbalanced_bracket: [OPERATOR_UNBALANCED_BRACKET, "The ad-hoc query's square brackets do not balance outside quoted "
        + 'text.'],
    escaped_outside_quotes: [OPERATOR_ESCAPED_OUTSIDE_QUOTES, 'The ad-hoc query has a backslash outside a double-quoted '
        + 'string. Splunk reads an escaped character there differently (an escaped pipe does not end a command), so the '
        + 'query was not run. Put text that needs a backslash inside double quotes.'],
    macro_adjacent: [OPERATOR_MACRO_POSITION, 'A macro must stand apart from the text around it (a space, a pipe or a '
        + 'square bracket on each side): Splunk expands a macro as text, so anything written against it joins its '
        + 'expansion. Put a space before and after the macro.'],
    too_deep: [OPERATOR_SUBSEARCH_NOT_ALLOWED, 'The ad-hoc query nests subsearches too deep.'],
    unterminated_quote: [OPERATOR_UNTERMINATED_QUOTE, 'SPL has a double quote that is never closed.'],
    unpaired_backtick: [OPERATOR_UNBALANCED_BACKTICK, 'SPL has an unmatched backtick.'],
};

/**
 * The check for an AI-authored ad-hoc query (build 377): the denylist
 * (`analyzeSpl`, checks 1-7), then the data scope on the raw query, then the
 * allow-list on the lexer's command tree.
 *
 * Data scope (operator `index_not_allowed`): no `index` term anywhere (double
 * quoted text aside; a double-quoted `"index"` field name counts); the audit
 * macro never; no OR / NOT next to the data macro (OR binds tighter than the
 * implicit AND, so `index=X OR y` leaves the index). A macro inside a quoted
 * string is refused (`macro_position`).
 *
 * Allow-list, for the query and every subsearch: every command in
 * ALLOWED_SPL_COMMANDS (`command_not_allowed`; a `union` is refused there,
 * with a reason that says to use append - COMMAND_INSTEAD); the query and every
 * subsearch arm start with the data macro as the first term of its search,
 * `| inputlookup`, `| tstats ... WHERE <data macro>` or `| makeresults`
 * (`query_start`), and every tstats anywhere names the data macro
 * right after WHERE (`query_start`); macros only where they cannot change the scope
 * (`macro_position`); lookups only from ALLOWED_SPL_LOOKUPS
 * (`lookup_not_allowed`) and no eval `lookup()` (`eval_lookup`); subsearches
 * only in search (a filter that ends with `fields` / `table`,
 * `subsearch_fields`), append, appendcols, join and appendpipe
 * (`subsearch_not_allowed`);
 * quoting and brackets the lexer can read one way only
 * (`ambiguous_single_quote`, `unbalanced_bracket`); no backslash outside
 * double quotes (`escaped_outside_quotes`) and no macro glued to other text
 * (`macro_position`) - security review of build 377.
 *
 * A refusal names the command, lookup or macro it is about (`command`); a
 * pass carries the top-level command list for `checkParserAgreement`. The
 * denylist's `macro` operator stands both for the `macro` command and for a
 * macro the App does not define: the first is recorded as `macro`, the
 * second by the macro's own name as the AI wrote it (`foreignMacroName`).
 */
export const analyzeAdHocSpl = (query: string): AdHocSplAnalysis => {
    if (typeof query !== 'string' || query.trim().length === 0) {
        return refuseNamed(OPERATOR_QUERY_START, 'The ad-hoc query is empty.');
    }
    const deny = analyzeSpl(query);
    if (deny.blocked) {
        const op = deny.operator ?? '';
        if (op === OPERATOR_MACRO && deny.reason !== MACRO_COMMAND_REASON) {
            const foreign = foreignMacroName(query);
            if (foreign !== null) return { ...deny, command: foreign };
        }
        return FORBIDDEN_NAME_SET.has(op) ? { ...deny, command: op } : { ...deny };
    }
    const bare = blankQuotedStrings(query).text;
    if (bare.split('`').length !== query.split('`').length) {
        return refuseNamed(OPERATOR_MACRO_POSITION, 'A macro inside a quoted string is not allowed in ad-hoc queries.');
    }
    if (INDEX_TERM_RE.test(bare) || QUOTED_INDEX_TERM_RE.test(query)) {
        return refuseNamed(OPERATOR_INDEX_NOT_ALLOWED, 'Ad-hoc queries read only the LogServ index, through the index '
            + 'macro: an index term (index=, index!=, index::, index IN) is not allowed. Remove it and start the query '
            + `with ${MACRO_REF}.`, 'index');
    }
    if (OR_NEXT_TO_DATA_MACRO_RE.test(bare)) {
        return refuseNamed(OPERATOR_INDEX_NOT_ALLOWED, 'OR or NOT next to the index macro would widen the search beyond '
            + `the LogServ index. Put the alternatives after the macro, in parentheses: ${MACRO_REF} (a OR b).`, DATA_MACRO);
    }
    const lex = lexSpl(query);
    if (!lex.ok) {
        const [op, reason] = LEX_REFUSALS[lex.problem];
        if (lex.problem === 'macro_adjacent') {
            // Named like the other macro_position refusals: the macro, as the AI wrote it.
            const close = query.indexOf('`', lex.at + 1);
            return refuseNamed(op, reason, safeName(query.slice(lex.at + 1, close === -1 ? lex.at + 1 : close)));
        }
        return refuseNamed(op, reason);
    }
    const bad = checkPipeline(lex.pipeline, 'main');
    if (bad) return bad;
    const first = lex.pipeline.commands[0];
    const from = searchArgsFrom(lex.pipeline);
    const head = first ? first.tokens[from] : undefined;
    return {
        blocked: false,
        commands: commandSequence(lex.pipeline),
        startsWithDataMacro: !lex.pipeline.leadingPipe && !!head && head.kind === 'macro' && head.text === DATA_MACRO,
    };
};

/* ================================================== search parser agreement */

/**
 * Command names Splunk's parser may report under another name than the
 * lexer: both sides are mapped to the second name before they are compared.
 */
export const PARSER_COMMAND_ALIASES: Readonly<Record<string, string>> = Object.freeze({
    bucket: 'bin',
});

const canonicalCommand = (n: string): string =>
    (Object.prototype.hasOwnProperty.call(PARSER_COMMAND_ALIASES, n) ? PARSER_COMMAND_ALIASES[n] : n);

/** The most nodes of a parser reply walked for nested commands; a larger reply is not read. */
export const PARSER_REPLY_MAX_NODES = 20000;

/** What a search-parser reply (`search/parser`, parse_only, JSON) says. */
export interface ParserReply {
    /** Its top-level commands: lower-cased names and, when present, the raw arguments. */
    top: Array<{ name: string; rawargs?: string }>;
    /**
     * Every `command` name anywhere in the reply (nested ones included, should a reply hold any), lower-cased.
     * The replies live probe P2 recorded held none: a subsearch is text, macros expanded, inside the raw
     * arguments of the command that holds it.
     */
    all: string[];
}

/** Read a search-parser reply; null when it has no list of named commands (or is too large to walk). */
export const readParserReply = (body: unknown): ParserReply | null => {
    if (!body || typeof body !== 'object') return null;
    const list = (body as { commands?: unknown }).commands;
    if (!Array.isArray(list) || list.length === 0) return null;
    const top: ParserReply['top'] = [];
    for (const c of list) {
        if (!c || typeof c !== 'object' || typeof (c as { command?: unknown }).command !== 'string') return null;
        const raw = (c as { rawargs?: unknown }).rawargs;
        top.push({ name: (c as { command: string }).command.toLowerCase(), rawargs: typeof raw === 'string' ? raw : undefined });
    }
    const all: string[] = [];
    const queue: unknown[] = [body];
    let nodes = 0;
    while (queue.length > 0) {
        const n = queue.shift();
        nodes += 1;
        if (nodes > PARSER_REPLY_MAX_NODES) return null;
        if (Array.isArray(n)) {
            n.forEach((x) => queue.push(x));
        } else if (n && typeof n === 'object') {
            const o = n as Record<string, unknown>;
            if (typeof o.command === 'string') all.push(o.command.toLowerCase());
            Object.keys(o).forEach((k) => queue.push(o[k]));
        }
    }
    return { top, all };
};

/** The data macro's shipped definition, normalized: `index=sap_logserv_logs`. */
const DATA_MACRO_TERM = APP_MACRO_DEFINITIONS[DATA_MACRO].replace(/"/g, '').replace(/\s+/g, ' ').trim();

/**
 * True when the parser's raw arguments of the first search start with the
 * data macro's shipped definition, as a term of its own, not followed by OR -
 * so a macro of the same name that the dispatching user's context shadows is
 * caught. Raw arguments that still hold a backtick (the macro unexpanded) or
 * that are absent cannot be judged and are not refused here.
 */
export const dataMacroAsShipped = (rawargs: string): boolean => {
    const n = rawargs.replace(/"/g, '').replace(/\s+/g, ' ').trim().replace(/^search /i, '');
    if (n !== DATA_MACRO_TERM && n.indexOf(`${DATA_MACRO_TERM} `) !== 0) return false;
    return !/^\s*(?:OR|NOT)\b/i.test(n.slice(DATA_MACRO_TERM.length));
};

/** The LogServ index, as the data macro's shipped definition names it (`sap_logserv_logs`). */
const DATA_INDEX = DATA_MACRO_TERM.replace(/^index=/, '');

/**
 * True when a command's raw arguments, as Splunk's search parser reports
 * them (macros expanded), hold an index term that is not the LogServ index:
 * `index!=`, `index IN (...)`, or `index=` / `index::` with another value. The
 * lexer refuses every index term the model writes, so in a query it passed
 * such a term can only come from a macro that expands to something else in
 * the user's context, or from a reading the lexer and Splunk do not share.
 * Read on the raw text, quoted text included, and with the field name quoted
 * or not (`"index"=x`): fail closed - a quoted string that holds an index
 * term refuses the query too. Security review of build 377: the value must
 * also END where a term ends (a space, `)`, `]`, `|` or the end of the text),
 * so text glued to a macro's expansion (`index="sap_logserv_logs"*`,
 * `index="sap_logserv_logs"_archive`) is foreign too.
 */
export const foreignIndexTerm = (rawargs: string): boolean => {
    const re = /(^|[^A-Za-z0-9_.:$-])"?index"?\s*(!?==?|::|\s+in\s*\()\s*/gi;
    let m: RegExpExecArray | null = re.exec(rawargs);
    while (m !== null) {
        if (m[2].charAt(0) === '!' || /in/i.test(m[2])) return true;
        const rest = rawargs.slice(m.index + m[0].length);
        const v = /^"([^"]*)"|^([^\s()[\]|"]*)/.exec(rest);
        const value = v ? (v[1] !== undefined ? v[1] : v[2]) : '';
        if (value.toLowerCase() !== DATA_INDEX) return true;
        const next = rest.charAt(v ? v[0].length : 0);
        if (next !== '' && !/[\s)\]|]/.test(next)) return true;
        m = re.exec(rawargs);
    }
    return false;
};

/**
 * App build 378: the options Splunk documents for a `lookup` / `inputlookup`
 * before the lookup's name - `lookup [local=<bool>] [update=<bool>]
 * [event_time_field=<field>] <lookup-table-name> ...` and `inputlookup
 * [append=<bool>] [strict=<bool>] [start=<int>] [max=<int>] <filename> |
 * <tablename> [WHERE ...]`.
 */
export const PARSER_LOOKUP_OPTIONS: Readonly<Record<string, ReadonlyArray<string>>> = Object.freeze({
    inputlookup: Object.freeze(['append', 'strict', 'start', 'max']),
    lookup: Object.freeze(['local', 'update', 'event_time_field']),
});

/** An option with a plain value, as a word of its own: `max=10`, `local=t`. */
const PARSER_LOOKUP_OPTION_RE = /^([A-Za-z_]+)=([A-Za-z0-9_.:-]+)(?=\s|$)/;

/** A lookup name, as a word of its own: nothing glued to it (a quote, a parenthesis, a bracket). */
const PARSER_LOOKUP_NAME_RE = /^[A-Za-z0-9_.:-]+(?=\s|$)/;

/**
 * App build 378 (the security review of build 377 asked for it; live probe P2
 * recorded the shape): the lookup a top-level `lookup` / `inputlookup` names,
 * read again from the raw arguments Splunk's search parser reports for that
 * command - its text after the command name, macros expanded, such as
 * `logserv_wp_perf_rollup where metric="wperr" ` or
 * `logserv_ti_malicious_ips ip AS dest OUTPUT category AS ti_category, ...`:
 * the first word after the options the command documents
 * (PARSER_LOOKUP_OPTIONS, each with a plain value). Null - the query is then
 * refused - for any shape it cannot read: no raw arguments, an option the
 * command does not document or written in another case, an option value that
 * is quoted or has a quote glued to it, a quoted name, a name with other text
 * glued to it, or no name at all.
 */
export const parserLookupName = (command: string, rawargs: unknown): string | null => {
    if (!Object.prototype.hasOwnProperty.call(PARSER_LOOKUP_OPTIONS, command) || typeof rawargs !== 'string') return null;
    const options = PARSER_LOOKUP_OPTIONS[command];
    let rest = rawargs.replace(/^\s+/, '');
    let opt = PARSER_LOOKUP_OPTION_RE.exec(rest);
    while (opt !== null) {
        if (options.indexOf(opt[1]) === -1) return null;
        rest = rest.slice(opt[0].length).replace(/^\s+/, '');
        opt = PARSER_LOOKUP_OPTION_RE.exec(rest);
    }
    const name = PARSER_LOOKUP_NAME_RE.exec(rest);
    return name ? name[0] : null;
};

/** The refusal for a parser call that failed, timed out or returned no command list. */
export const parserUnavailable = (): SplAnalysisResult => ({
    blocked: true,
    operator: OPERATOR_PARSER_UNAVAILABLE,
    reason: "The App could not have Splunk's search parser check the query (the check failed, timed out or was "
        + 'stopped), so it was not run. Try again; if it keeps failing, use a saved search from the catalog.',
});

/** The refusal for a query Splunk's search parser rejected as invalid SPL (HTTP 400). */
export const parserRejected = (): SplAnalysisResult => ({
    blocked: true,
    operator: OPERATOR_PARSER_REJECTED,
    reason: "Splunk's search parser rejected the query (it is not valid SPL), so it was not run. Check the syntax and "
        + 'send it again.',
});

/**
 * Build 377 (U13 = B): compare a query the allow-list passed with what
 * Splunk's own search parser made of it (the reply of `search/parser`,
 * parse_only, JSON) and refuse on any disagreement (`parser_mismatch`):
 *   - every command the reply names must be allowed (nested ones too, should
 *     a reply hold any - P2's held none: a subsearch is text, macros
 *     expanded, inside the raw arguments of the command that holds it);
 *   - its top-level command list must equal the lexer's (aliases mapped);
 *   - when the query starts with the data macro, the parser's expansion of
 *     it must be the shipped definition (a shadowing macro is caught there;
 *     for the macro after WHERE in tstats or at the start of a subsearch,
 *     only an index term its expansion brings in is caught, by the next rule);
 *   - no top-level command's raw arguments may hold an index term other than
 *     the LogServ index (`foreignIndexTerm`);
 *   - build 378: every top-level `lookup` / `inputlookup` names, in its raw
 *     arguments as the parser reports them, one of ALLOWED_SPL_LOOKUPS
 *     (`parserLookupName`; a shape it cannot read refuses too). A lookup
 *     inside a subsearch is no command of its own in the reply (P2: its text
 *     is part of the raw arguments of the command that holds the subsearch),
 *     so the lexer's reading stays its only check. The same holds for every
 *     command in a subsearch: a command or lookup that a shadowed macro
 *     brings into a subsearch is caught by neither check (only an index
 *     term it brings in is, by `foreignIndexTerm` on the raw arguments of
 *     the command that holds the subsearch).
 * A reply with no command list is `parser_unavailable`.
 */
export const checkParserAgreement = (local: AdHocSplAnalysis, body: unknown): SplAnalysisResult => {
    if (local.blocked) return local;
    const reply = readParserReply(body);
    if (reply === null) return parserUnavailable();
    const mismatch = (what: string, c: string): SplAnalysisResult => ({
        blocked: true,
        operator: OPERATOR_PARSER_MISMATCH,
        reason: `Splunk's search parser reads the query differently from the App's check (${what}), so it was not run. `
            + 'Rewrite it with plain commands from the allow-list.',
        command: safeName(c),
    });
    for (const n of reply.all) {
        if (!ALLOWED_COMMAND_SET.has(canonicalCommand(n))) return mismatch(`it finds the command "${safeName(n)}"`, n);
    }
    const want = (local.commands || []).map(canonicalCommand);
    const got = reply.top.map((t) => canonicalCommand(t.name));
    if (JSON.stringify(want) !== JSON.stringify(got)) {
        let i = 0;
        while (i < want.length && i < got.length && want[i] === got[i]) i += 1;
        const c = got[i] !== undefined ? got[i] : want[i] !== undefined ? want[i] : '';
        return mismatch(`at command ${i + 1}: "${safeName(c)}"`, c);
    }
    if (local.startsWithDataMacro) {
        const raw = reply.top[0].rawargs;
        if (typeof raw === 'string' && raw.indexOf('`') === -1 && !dataMacroAsShipped(raw)) {
            return mismatch('the index macro expands to something else here', DATA_MACRO);
        }
    }
    for (const t of reply.top) {
        if (typeof t.rawargs === 'string' && foreignIndexTerm(t.rawargs)) {
            return mismatch(`its "${safeName(t.name)}" reads an index other than the LogServ index`, t.name);
        }
    }
    for (const t of reply.top) {
        if (t.name !== 'lookup' && t.name !== 'inputlookup') continue;
        const lk = parserLookupName(t.name, t.rawargs);
        if (lk === null) return mismatch(`the lookup its "${safeName(t.name)}" names cannot be read`, t.name);
        if (!ALLOWED_LOOKUP_SET.has(lk)) {
            return mismatch(`its "${safeName(t.name)}" names a lookup that is not one of this App's`, t.name);
        }
    }
    return { blocked: false };
};
