/**
 * splGuard — static analysis for AI-authored SPL before it reaches MCP.
 *
 * Mitigates OWASP LLM06 (Excessive Agency) for the `splunk_run_query`
 * tool path. The `splunk_run_saved_search` tool is unaffected — its SPL
 * is pre-authored and reviewed at app build time.
 *
 * Threat model:
 *   - Customer's role permissions on the search head are the
 *     authoritative gate: if `can_delete` / `outputlookup` etc. aren't
 *     granted to the user whose session dispatched the search, the
 *     write fails server-side.
 *   - This guard adds a CLIENT-SIDE pre-flight check so that even when
 *     the user's role HAS the write capability, the AI cannot trigger
 *     a side-effecting command. AI tool calls flow through the user's
 *     own session, so they inherit the user's permissions; the guard
 *     restricts the AI to a safe subset of those permissions.
 *
 * Forbidden command list — every command here EITHER writes data
 * somewhere (lookup, index, file) OR triggers a side effect (alert,
 * email, script execution). Read-only analytics commands like
 * `stats` / `eval` / `where` / `timechart` / `top` etc. are not
 * affected.
 *
 * The match is anchored to a `|` pipe-separator + optional whitespace
 * + the command name as a word boundary. This means a literal field
 * value containing the word `collect` won't false-match (e.g.
 * `... | search action="collect_data"` is fine), but
 * `... | collect index=foo` is blocked.
 *
 * Limitations (acknowledged):
 *   - Quoted strings: a query like `... | eval x="| collect"` would
 *     match. False positive. Acceptable trade-off — Claude is highly
 *     unlikely to write such a query for a legitimate reason, and a
 *     false-positive block prompts the user / AI to re-query.
 *   - Splunk macros: a custom macro that internally invokes
 *     `| collect` is not detected. Customers should review their
 *     macros — the guard is a defense-in-depth layer, not a
 *     replacement for sound role configuration.
 *   - Subsearches: `[search ... | collect index=x]` is detected
 *     (the `|` before `collect` matches regardless of `[ ]`).
 *
 * Added in build 79 per OWASP LLM Top 10 (2025) compliance review
 * (see design doc Appendix D, recommendation 3).
 */

export interface SplAnalysisResult {
    /** True if the SPL contains a forbidden operator. */
    blocked: boolean;
    /** The forbidden operator that triggered the block, lowercased. */
    operator?: string;
    /** Human-readable reason (safe to surface to the AI / user). */
    reason?: string;
}

/**
 * SPL commands that write data, send alerts, run scripts, or
 * otherwise produce side effects. Lowercase, no `|` prefix.
 *
 * Sources:
 *   - Splunk Search Reference (commands marked "writes to", "sends",
 *     or "runs an external script")
 *   - Internal review of which commands have permission gates
 *     (`can_delete`, `edit_lookups`, `edit_alerts`, etc.)
 */
export const FORBIDDEN_SPL_COMMANDS = [
    // Writes events to a different index — bypasses normal ingest path
    'collect',
    // Writes / replaces / appends a CSV lookup file
    'outputlookup',
    'outputcsv',
    // Soft-deletes events; needs `can_delete`
    'delete',
    // Triggers an alert action (email, script, webhook, custom)
    'sendalert',
    'sendemail',
    // Runs an external script command (Python / shell)
    'script',
    'run',
    // Streams events to an external system via UDP/TCP/HEC
    'tscollect',
    // Writes lookup file via `inputlookup ... | outputlookup` chain
    // — still blocked by `outputlookup`; included here as alias
    // for future commands following the `output*` naming pattern
    // (no current matches beyond the two above).
] as const;

/**
 * Pre-built case-insensitive regex matching `<pipe><whitespace><cmd>`
 * with a word boundary after the command name. Built once at module
 * load to amortize the construction cost across many dispatches.
 *
 * Pattern: `\|\s*(?:collect|outputlookup|...)\b` flags `i` and `g`.
 */
const FORBIDDEN_RE = new RegExp(
    `\\|\\s*(${FORBIDDEN_SPL_COMMANDS.join('|')})\\b`,
    'gi',
);

/**
 * Analyze an SPL string for forbidden commands.
 *
 * Returns `{ blocked: false }` when safe. When blocked, returns the
 * matched operator (lowercased, no pipe) and a reason string suitable
 * for surfacing to the AI as the synthetic tool-result error. The
 * reason intentionally does NOT enumerate which commands ARE allowed
 * — that would give the AI a blueprint to map the perimeter.
 */
export const analyzeSpl = (query: string): SplAnalysisResult => {
    if (typeof query !== 'string' || query.length === 0) {
        return { blocked: false };
    }

    // Reset regex state for stateful (`g` flag) reuse.
    FORBIDDEN_RE.lastIndex = 0;
    const match = FORBIDDEN_RE.exec(query);
    if (!match) {
        return { blocked: false };
    }

    const operator = match[1].toLowerCase();
    return {
        blocked: true,
        operator,
        reason:
            `SPL contains the operator "${operator}", which is not permitted ` +
            `for AI-dispatched ad-hoc queries. Only read-only analytic ` +
            `commands are allowed. Rephrase the query to read data without ` +
            `writing, deleting, or triggering alerts.`,
    };
};
