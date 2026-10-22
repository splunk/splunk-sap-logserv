/**
 * splLexer - the strict reader behind the AI Assistant's command allow-list
 * (App build 377). It splits an AI-authored ad-hoc SPL query into a tree of
 * commands, so that `splGuard.analyzeAdHocSpl` can check every command, every
 * subsearch and every place a macro is used.
 *
 * It is strict on purpose: anything whose structure Splunk could read in more
 * than one way is reported as a problem instead of guessed at, and the guard
 * refuses the query.
 *   - Double quotes: a string runs to the next unescaped `"`; a backslash
 *     escapes the next character inside it. Its content is data.
 *   - Single quotes: outside double quotes, every `'` pairs with the NEXT `'`,
 *     and the text between them may not hold `|`, `[`, `]`, `"`, a backtick,
 *     a backslash or a line break. A single-quoted string is therefore only
 *     ever a field name (`eval 'User Name'=user`). Anything else - a stray
 *     apostrophe in a search term (`don't`), a pipe inside single quotes
 *     (`'a|b'`) - is the problem `ambiguous_single_quote`: put such a term in
 *     double quotes.
 *   - Backslashes: outside double quotes a backslash is the problem
 *     `escaped_outside_quotes` (security review of build 377). Splunk reads
 *     `\|` as a literal pipe passed to the command, not as a command
 *     boundary, and a backslash may escape a bracket or a quote the same way;
 *     a reader that split there would check a subsearch under the wrong
 *     command (an appendpipe group that is really a filter subsearch).
 *   - Backticks: a pair is one macro reference, and it must stand apart:
 *     whitespace, `|`, `[`, `]` or the start or end of the text on each side,
 *     else the problem `macro_adjacent` (security review of build 377).
 *     Splunk expands a macro as text, so text glued to it joins its
 *     expansion (`` `m`* `` is `index="sap_logserv_logs"*`, `` where`m` `` is
 *     `whereindex=...`).
 *   - Square brackets must balance outside quotes (`unbalanced_bracket`); a
 *     `[` ... `]` group is a subsearch that belongs to the command it sits in.
 *     Groups nest at most MAX_LEX_DEPTH deep (`too_deep`).
 *   - A `|` outside quotes and outside the current group ends a command.
 *
 * What it does not do: decide what is allowed. That is splGuard's job; this
 * module only reports structure. Pure: no imports, so the build gate can
 * evaluate it from its own text.
 */

/**
 * The App's macros and their definitions: the last `definition` of each
 * stanza of default/macros.conf, exactly (the consistency test and the build
 * gate compare them). None takes arguments.
 */
export const APP_MACRO_DEFINITIONS: Readonly<Record<string, string>> = Object.freeze({
    sap_logserv_idx_macro: 'index="sap_logserv_logs"',
    sap_logserv_audit_idx_macro: 'index="logserv_ai_assistant_audit"',
    sap_logserv_cloud_provider_default_macro: 'eval cloud_provider=coalesce(cloud_provider, "aws")',
});

/** The macro that selects the LogServ index: the only data source of an ad-hoc search. */
export const DATA_MACRO = 'sap_logserv_idx_macro';

/** The deepest subsearch group the lexer reads; deeper is the problem `too_deep`. */
export const MAX_LEX_DEPTH = 8;

export type SplTokenKind = 'term' | 'dquote' | 'squote' | 'macro' | 'pipe' | 'open' | 'close' | 'lparen' | 'rparen';

export interface SplToken {
    kind: SplTokenKind;
    /** The token as written; for a macro, the text between the backticks. */
    text: string;
    start: number;
    end: number;
}

export interface SplCommand {
    /** This command's own tokens, in order; the tokens of its subsearch groups are not here. */
    tokens: SplToken[];
    /** Its subsearch groups (`[...]`), in order. */
    groups: SplPipeline[];
    /** True when a `|` came before it in its pipeline. */
    piped: boolean;
    /** Index of the token, in `tokens`, that each group came after (groups[i] follows tokens[groupAt[i] - 1]). */
    groupAt: number[];
}

export interface SplPipeline {
    commands: SplCommand[];
    /** True when the pipeline starts with `|` (a generating command, not the implicit search). */
    leadingPipe: boolean;
    /** Nesting depth: 0 for the query itself. */
    depth: number;
}

export type SplLexProblem =
    | 'ambiguous_single_quote'
    | 'escaped_outside_quotes'
    | 'macro_adjacent'
    | 'unbalanced_bracket'
    | 'unterminated_quote'
    | 'unpaired_backtick'
    | 'too_deep';

export type SplLexResult =
    | { ok: true; pipeline: SplPipeline }
    | { ok: false; problem: SplLexProblem; at: number };

const SPECIAL = '"\'`|[]()\\';

const isSpace = (c: string): boolean => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v';

/** What may stand right before or after a macro reference: a space, `|`, `[`, `]`, or nothing (the text's start or end). */
const macroNeighbourOk = (c: string): boolean => c === '' || isSpace(c) || c === '|' || c === '[' || c === ']';

/** Split a query into tokens, or report the first problem. */
export const tokenizeSpl = (query: string): { ok: true; tokens: SplToken[] } | { ok: false; problem: SplLexProblem; at: number } => {
    const tokens: SplToken[] = [];
    const n = query.length;
    let i = 0;
    while (i < n) {
        const c = query.charAt(i);
        if (isSpace(c)) {
            i += 1;
            continue;
        }
        if (c === '\\') return { ok: false, problem: 'escaped_outside_quotes', at: i };
        if (c === '"') {
            let j = i + 1;
            let closed = false;
            while (j < n) {
                const d = query.charAt(j);
                if (d === '\\') {
                    j += 2;
                    continue;
                }
                if (d === '"') {
                    closed = true;
                    break;
                }
                j += 1;
            }
            if (!closed) return { ok: false, problem: 'unterminated_quote', at: i };
            tokens.push({ kind: 'dquote', text: query.slice(i, j + 1), start: i, end: j + 1 });
            i = j + 1;
            continue;
        }
        if (c === "'") {
            const j = query.indexOf("'", i + 1);
            if (j === -1 || /[|[\]"`\\\r\n]/.test(query.slice(i + 1, j))) {
                return { ok: false, problem: 'ambiguous_single_quote', at: i };
            }
            tokens.push({ kind: 'squote', text: query.slice(i, j + 1), start: i, end: j + 1 });
            i = j + 1;
            continue;
        }
        if (c === '`') {
            const j = query.indexOf('`', i + 1);
            if (j === -1) return { ok: false, problem: 'unpaired_backtick', at: i };
            if (!macroNeighbourOk(query.charAt(i - 1)) || !macroNeighbourOk(query.charAt(j + 1))) {
                return { ok: false, problem: 'macro_adjacent', at: i };
            }
            tokens.push({ kind: 'macro', text: query.slice(i + 1, j), start: i, end: j + 1 });
            i = j + 1;
            continue;
        }
        if (c === '|' || c === '[' || c === ']' || c === '(' || c === ')') {
            const kind: SplTokenKind = c === '|' ? 'pipe' : c === '[' ? 'open' : c === ']' ? 'close' : c === '(' ? 'lparen' : 'rparen';
            tokens.push({ kind, text: c, start: i, end: i + 1 });
            i += 1;
            continue;
        }
        let j = i + 1;
        while (j < n && !isSpace(query.charAt(j)) && SPECIAL.indexOf(query.charAt(j)) === -1) j += 1;
        tokens.push({ kind: 'term', text: query.slice(i, j), start: i, end: j });
        i = j;
    }
    return { ok: true, tokens };
};

const newCommand = (piped: boolean): SplCommand => ({ tokens: [], groups: [], piped, groupAt: [] });

const isEmptyCommand = (c: SplCommand): boolean => c.tokens.length === 0 && c.groups.length === 0;

/**
 * Read a query into a command tree. Built with an explicit stack (no
 * recursion), so a hostile nesting cannot exhaust the call stack.
 */
export const lexSpl = (query: string): SplLexResult => {
    const tk = tokenizeSpl(query);
    if (!tk.ok) return tk;
    const root: SplPipeline = { commands: [], leadingPipe: false, depth: 0 };
    interface Frame { pipeline: SplPipeline; cmd: SplCommand; open: number }
    const stack: Frame[] = [{ pipeline: root, cmd: newCommand(false), open: 0 }];
    const finish = (f: Frame): void => {
        // A leading `|` leaves an empty first command: it marks a generating
        // command, it is not a command itself.
        if (isEmptyCommand(f.cmd) && f.pipeline.commands.length === 0 && !f.cmd.piped) return;
        f.pipeline.commands.push(f.cmd);
    };
    for (const t of tk.tokens) {
        const top = stack[stack.length - 1];
        if (t.kind === 'pipe') {
            if (isEmptyCommand(top.cmd) && top.pipeline.commands.length === 0 && !top.cmd.piped) {
                // A leading `|`: the next command is a generating one. It is
                // marked piped, so an empty command right after it (`| |`)
                // is still reported.
                top.pipeline.leadingPipe = true;
                top.cmd = newCommand(true);
                continue;
            }
            finish(top);
            top.cmd = newCommand(true);
            continue;
        }
        if (t.kind === 'open') {
            if (stack.length > MAX_LEX_DEPTH) return { ok: false, problem: 'too_deep', at: t.start };
            const child: SplPipeline = { commands: [], leadingPipe: false, depth: stack.length };
            top.cmd.groups.push(child);
            top.cmd.groupAt.push(top.cmd.tokens.length);
            stack.push({ pipeline: child, cmd: newCommand(false), open: t.start });
            continue;
        }
        if (t.kind === 'close') {
            if (stack.length === 1) return { ok: false, problem: 'unbalanced_bracket', at: t.start };
            const f = stack.pop() as Frame;
            finish(f);
            continue;
        }
        top.cmd.tokens.push(t);
    }
    if (stack.length !== 1) return { ok: false, problem: 'unbalanced_bracket', at: stack[stack.length - 1].open };
    finish(stack[0]);
    return { ok: true, pipeline: root };
};

/** A plain command word: letters, digits and underscores, not starting with a digit. */
export const COMMAND_WORD_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The name of the command at `index` of `p`, lower-cased, as Splunk reads it
 * (with `firstIsCommand` for an appendpipe group, whose first word is always a
 * command): the first command of a pipeline that does not start with `|` is
 * the search command - named by an explicit `search` word or implicit; any
 * other command is named by its first token, which must be a plain word.
 * A command made of one App macro that expands to a command (the
 * cloud-provider macro) is named by its definition's first word. Returns ''
 * for a command that has no name (an empty command, a quoted or a punctuation
 * first token).
 */
export const commandName = (p: SplPipeline, index: number, firstIsCommand = false): string => {
    const c = p.commands[index];
    if (!c) return '';
    if (index === 0 && !p.leadingPipe && !firstIsCommand) return 'search';
    const t = c.tokens[0];
    if (!t || c.groupAt[0] === 0) return '';
    if (t.kind === 'term') return COMMAND_WORD_RE.test(t.text) ? t.text.toLowerCase() : '';
    if (t.kind === 'macro' && Object.prototype.hasOwnProperty.call(APP_MACRO_DEFINITIONS, t.text)) {
        const w = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s/.exec(APP_MACRO_DEFINITIONS[t.text]);
        // A macro whose definition starts with a search term (`index=...`)
        // is not a command.
        return w && !/^index$/i.test(w[1]) ? w[1].toLowerCase() : '';
    }
    return '';
};

/**
 * The index, in the first command's tokens, of the first argument of an
 * implicit or explicit search: 1 after an explicit `search` word, else 0.
 */
export const searchArgsFrom = (p: SplPipeline): number => {
    const c = p.commands[0];
    if (!c || p.leadingPipe) return 1;
    const t = c.tokens[0];
    return t && t.kind === 'term' && t.text.toLowerCase() === 'search' && c.groupAt[0] !== 0 ? 1 : 0;
};

/** The top-level command names of a pipeline, in order (macro commands expanded). */
export const commandSequence = (p: SplPipeline, firstIsCommand = false): string[] =>
    p.commands.map((_c, i) => commandName(p, i, firstIsCommand));
