/**
 * savedSearchAllowList - which saved searches the AI Assistant may run, and
 * the exact arguments it sends to the Splunk MCP Server for one (build 376,
 * session 149).
 *
 * Why it exists. The free-form assistant's `splunk_run_saved_search` tool
 * took any name. This App ships saved searches that WRITE - every rollup
 * aggregate, backfill and retention, and the ES asset / identity feeds - and
 * run on demand with a time range the model picked, one of them can write
 * lower counts over complete rows or empty a collection. Three more ways
 * round a plain name check existed: model-supplied `arguments` were spread
 * into the MCP arguments (so `arguments.saved_search_name` replaced the
 * vetted name), `splunk_run_query` could rerun a saved search through
 * `| savedsearch`, `from savedsearch:` or `union savedsearch:` (splGuard.ts
 * now blocks those), and an undeclared tool name was forwarded to MCP as is.
 *
 * The rules, all enforced here or at the one dispatch point that uses them
 * (MCPClient.runSavedSearch):
 *
 *   - A name is allowed only when it is EXACTLY one of the intent map's
 *     saved searches - the same list that feeds the system primer's catalog
 *     and the Prompt Browser, so the allow-list cannot drift from what the
 *     assistant is told it may run. Case-sensitive, no prefixes, no
 *     patterns, no trimming: anything else is refused before a request is
 *     sent. The allow-list buildAllowedSavedSearches returns is immutable -
 *     no add, delete or clear, not even behind a cast - so no code that
 *     holds it can widen it at run time.
 *   - The MCP arguments are built field by field: the vetted name, this
 *     App's id, and the time range. Nothing a caller or the model passes can
 *     add, replace or remove a key.
 *   - Only the two tools declared to the model can be dispatched.
 *   - A refusal never lists the allowed names (it would hand the model a map
 *     of the perimeter); the catalog in the primer is the only list.
 *
 * Scope: this protects this App's AI Assistant only. Another MCP client
 * holding a token, or a user at the search bar, is not affected by it.
 *
 * This module imports nothing - in particular not the intent-map JSON, which
 * the build-time gate (bin/check-diagnostics.js) cannot load. The caller
 * builds the allowed set from the prompts it already holds.
 */

/** This App's id. Sent as `app` on every saved-search call so the MCP
 *  server resolves the name in this App, not the first app (alphabetically)
 *  that happens to carry a stanza of the same name. */
export const LOGSERV_APP = 'splunk_app_sap_logserv';

export const TOOL_RUN_SAVED_SEARCH = 'splunk_run_saved_search';
export const TOOL_RUN_QUERY = 'splunk_run_query';

/** The only tools the assistant may dispatch - the two it is offered. */
export const DISPATCHABLE_TOOLS: ReadonlyArray<string> = [TOOL_RUN_SAVED_SEARCH, TOOL_RUN_QUERY];

/** Audit `operator` values for the two refusals recorded here (category
 *  `security_blocked_spl`, the same as a blocked ad-hoc query). */
export const OPERATOR_SAVED_SEARCH_NOT_IN_CATALOG = 'saved_search_not_in_catalog';
export const OPERATOR_TOOL_NOT_DECLARED = 'tool_not_declared';

/** What a catalog name can look like. Every intent-map name is lower-case
 *  letters, digits and underscores; this shape is deliberately a little
 *  wider (no catalog name is refused by it) but has no whitespace, quote,
 *  pipe, bracket, backtick, colon or control character. It is a second
 *  fence only - the allow-list itself is exact set membership. */
const NAME_SHAPE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,199}$/;

export interface SavedSearchCheck {
    allowed: boolean;
    /** Why the name was refused. Safe to show to the model and the user;
     *  never lists the allowed names. */
    reason?: string;
}

/** The time range a saved-search call may carry. */
export interface SavedSearchTimeRange {
    earliest_time?: string;
    latest_time?: string;
}

/** The complete argument object sent to the MCP server's
 *  `splunk_run_saved_search` tool. */
export interface SavedSearchMcpArgs {
    saved_search_name: string;
    app: string;
    earliest_time?: string;
    latest_time?: string;
}

export type ToolCallVerdict =
    | { ok: true }
    | { ok: false; operator: string; reason: string; auditSpl: string };

/** A model-supplied value made safe to quote in a message: control
 *  characters replaced, length capped. */
const printable = (value: unknown, max = 120): string => {
    let s: string;
    if (typeof value === 'string') s = value;
    else {
        try {
            s = JSON.stringify(value) ?? String(value);
        } catch {
            s = String(value);
        }
    }
    // eslint-disable-next-line no-control-regex
    s = s.replace(/[\u0000-\u001f\u007f]/g, '?');
    return s.length > max ? `${s.slice(0, max)}...` : s;
};

/**
 * A read-only view of `names`: a frozen plain object with the ReadonlySet
 * members only - no add, delete or clear - over a private copy held in a
 * closure. A cast to Set<string> finds no add to call, Set.prototype.add
 * refuses it as a receiver (it is not a Set), a reassigned member is
 * refused by the freeze, and forEach hands its callback this view, never
 * the private copy. Nothing that holds the view can change what it allows.
 */
const readOnlyNames = (names: Iterable<string>): ReadonlySet<string> => {
    const inner = new Set<string>(names);
    const view: ReadonlySet<string> = {
        has: (value: string): boolean => inner.has(value),
        get size(): number {
            return inner.size;
        },
        forEach: (cb, thisArg): void => {
            inner.forEach((v) => cb.call(thisArg, v, v, view));
        },
        entries: () => inner.entries(),
        keys: () => inner.keys(),
        values: () => inner.values(),
        [Symbol.iterator]: () => inner.values(),
    };
    return Object.freeze(view);
};

/**
 * Build the allowed set from the intent map's prompt objects. Typed loosely
 * on purpose: the caller passes the parsed JSON as it is. A prompt whose
 * `savedSearch` is not a string, or does not look like a catalog name, is
 * left out (the consistency test pins that every real one gets in).
 *
 * The result is IMMUTABLE (readOnlyNames): it has no add, delete or clear,
 * not even behind a cast, and it is a copy - a later change to `prompts`
 * does not reach it.
 */
export const buildAllowedSavedSearches = (prompts: ReadonlyArray<unknown> | null | undefined): ReadonlySet<string> => {
    const out = new Set<string>();
    for (const p of prompts ?? []) {
        const n = p !== null && typeof p === 'object' ? (p as { savedSearch?: unknown }).savedSearch : undefined;
        if (typeof n === 'string' && NAME_SHAPE.test(n)) out.add(n);
    }
    return readOnlyNames(out);
};

/**
 * May the assistant run this saved search? Exact, case-sensitive membership
 * of `allowed`, after a shape check that refuses anything no catalog name
 * could be (non-strings, empty, padded, quoted, piped, bracketed, multi-line).
 */
export const checkSavedSearchName = (name: unknown, allowed: ReadonlySet<string>): SavedSearchCheck => {
    if (typeof name !== 'string') {
        return { allowed: false, reason: 'The saved search name must be a single catalog name (a string).' };
    }
    if (name.length === 0) {
        return { allowed: false, reason: 'No saved search name was given. Use a name from the catalog in your system primer.' };
    }
    if (!NAME_SHAPE.test(name)) {
        return {
            allowed: false,
            reason:
                'The saved search name is not a catalog name: it contains characters no catalog name has. ' +
                'Use a name from the catalog in your system primer exactly as written.',
        };
    }
    if (!allowed.has(name)) {
        return {
            allowed: false,
            reason:
                `The saved search "${name}" is not in the catalog in your system primer, so it was not run. ` +
                'Only catalog searches can be run by the assistant; choose one from the catalog, ' +
                'or answer with a read-only splunk_run_query.',
        };
    }
    return { allowed: true };
};

/**
 * Take the time range - and nothing else - from a tool call's arguments.
 * Only the top-level `earliest_time` / `latest_time` strings are read; any
 * other key (`arguments`, `saved_search_name`, `app`, `args`, ...) is
 * ignored.
 */
export const pickSavedSearchTimeRange = (args: Readonly<Record<string, unknown>> | null | undefined): SavedSearchTimeRange => {
    const out: SavedSearchTimeRange = {};
    if (!args) return out;
    const e = args.earliest_time;
    const l = args.latest_time;
    if (typeof e === 'string' && e.length > 0) out.earliest_time = e;
    if (typeof l === 'string' && l.length > 0) out.latest_time = l;
    return out;
};

/**
 * The exact MCP arguments for a vetted saved search: its name, this App, and
 * the time range when one is given. Built key by key - no spread - so a
 * `time` object carrying any other key cannot add or replace one.
 */
export const buildSavedSearchArgs = (name: string, time: SavedSearchTimeRange = {}): SavedSearchMcpArgs => {
    const out: SavedSearchMcpArgs = { saved_search_name: name, app: LOGSERV_APP };
    const e = time ? time.earliest_time : undefined;
    const l = time ? time.latest_time : undefined;
    if (typeof e === 'string' && e.length > 0) out.earliest_time = e;
    if (typeof l === 'string' && l.length > 0) out.latest_time = l;
    return out;
};

/**
 * The pre-dispatch verdict for one tool call from the model: refuse a tool
 * that was not offered, and a saved search that is not in the catalog. An
 * ad-hoc query passes here - its SPL is checked by splGuard.analyzeSpl.
 * `auditSpl` is what the `security_blocked_spl` audit event records.
 */
export const vetToolCall = (
    toolName: string,
    args: Readonly<Record<string, unknown>>,
    allowed: ReadonlySet<string>,
): ToolCallVerdict => {
    if (DISPATCHABLE_TOOLS.indexOf(toolName) === -1) {
        return {
            ok: false,
            operator: OPERATOR_TOOL_NOT_DECLARED,
            reason:
                `The tool "${printable(toolName)}" is not available to the assistant, so it was not run. ` +
                `Use ${TOOL_RUN_SAVED_SEARCH} or ${TOOL_RUN_QUERY}.`,
            auditSpl: `(tool) ${printable(toolName, 200)}`,
        };
    }
    if (toolName === TOOL_RUN_SAVED_SEARCH) {
        const name = args ? args.name : undefined;
        const verdict = checkSavedSearchName(name, allowed);
        if (!verdict.allowed) {
            return {
                ok: false,
                operator: OPERATOR_SAVED_SEARCH_NOT_IN_CATALOG,
                reason: verdict.reason ?? 'The saved search is not in the catalog.',
                auditSpl: `(saved search) ${printable(name, 200)}`,
            };
        }
    }
    return { ok: true };
};
