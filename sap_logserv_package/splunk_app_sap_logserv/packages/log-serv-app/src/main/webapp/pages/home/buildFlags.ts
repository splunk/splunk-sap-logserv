/**
 * Build-time feature flags. The values here are baked into the bundle at
 * webpack-compile time (via DefinePlugin in webpack.config.js) and CANNOT
 * be changed post-deploy by an admin or end-user — that's the point.
 *
 * Set via environment variable at build time:
 *   LOGSERV_TEMPLATES_ONLY=true yarn build
 *
 * Or via the dedicated npm script:
 *   yarn build:templates-only
 *
 * Build 173 / session 029.
 *
 * ---
 *
 * **TEMPLATES_ONLY** — when true, the AI Assistant operates in a
 * canned-prompts-only mode:
 *
 *   - Free-form prompt input is disabled (chat input greyed out, Send
 *     button disabled).
 *   - The free-form `sendUserMessage` code path bails immediately with a
 *     system notice — defense in depth in case any other entry point
 *     reaches it.
 *   - The model picker in the privacy banner is hidden.
 *   - The Power Mode toggle is hidden (forced-RAG only matters with an
 *     LLM).
 *   - LLM-related fields in the Settings page (provider, default_model,
 *     tier, power_user_roles, tier2_pii_redaction) and the Provider
 *     Credentials tab are hidden.
 *   - A persistent banner at the top of the chat tells the user that
 *     LLM dispatch is disabled.
 *
 * The canned-prompt path stays fully functional: the user opens the
 * prompt browser, picks a saved search, and the result tile + static
 * guidance card render exactly as in the regular build. The MCP server
 * is still required (it's the only way to dispatch SPL).
 *
 * Use case: ship a partner-facing build where the partner can test the
 * LogServ solution end-to-end (canned prompts, Splunk MCP, dashboards,
 * audit log) without being able to enable any LLM provider.
 */

// Webpack DefinePlugin replaces this expression with the string literal
// "true" or "false" at compile time. The triple-equals comparison then
// produces a real boolean. Dead-code elimination kicks in for the
// regular build (the entire TEMPLATES_ONLY = false branches collapse).
//
// We intentionally read process.env.LOGSERV_TEMPLATES_ONLY (a string
// comparison) rather than something like __LOGSERV_TEMPLATES_ONLY__ — the
// process.env path is the canonical one for webpack apps, plays well
// with Jest (where Node's real process.env applies), and keeps TS happy
// without a global type declaration.
export const TEMPLATES_ONLY: boolean =
    process.env.LOGSERV_TEMPLATES_ONLY === 'true';
