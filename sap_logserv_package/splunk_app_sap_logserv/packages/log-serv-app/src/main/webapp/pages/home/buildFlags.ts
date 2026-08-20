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
 * canned-prompts-only mode.
 *
 * HOW IT IS ENFORCED (rewritten build 300 / session 092)
 * ------------------------------------------------------
 * Session 030 moved the user-facing gating to the RUNTIME setting
 * `templates_only_mode` (admin-controlled, no rebuild). Rather than
 * duplicate every one of those guards behind the compile flag, this flag
 * now simply FORCES that runtime value on:
 *
 *   1. `utils/aiConfigApi.ts` — `parseRawContent` (the single normalizer
 *      for BOTH the KV Store row and the conf-file stanza) and
 *      `DEFAULT_AI_CONFIG` (the both-reads-failed fallback) OR the flag
 *      in. Every read path therefore reports `templates_only_mode: true`,
 *      no matter what is stored. This is the enforcement point.
 *   2. `state/AIAssistantConfig.ts` — the pre-load default, so the brief
 *      window before the async config read resolves can't show an
 *      LLM-enabled UI.
 *   3. `hooks/useAIAssistant.ts` — the `sendUserMessage` guard is OR'd
 *      with the flag directly, so the LLM dispatch path is dead even if
 *      the runtime value never reached the hook.
 *
 * Why forcing the value beats patching only the shipped conf default:
 * KV Store WINS over the conf, so a customer upgrading from a full-LLM
 * build (whose KV row holds `templates_only_mode = 0`) would otherwise
 * keep the LLM path enabled. The build also patches the STAGED conf
 * default to `true` (see `bin/build.js`) so the artifact is
 * self-describing, but that is cosmetic — the webapp force is the gate.
 *
 * WHAT THE USER SEES (all driven by the forced runtime value)
 * -----------------------------------------------------------
 *   - Free-form prompt input is disabled (chat input read-only, Send
 *     button disabled).
 *   - The free-form `sendUserMessage` code path bails immediately with a
 *     system notice — defense in depth in case any other entry point
 *     reaches it.
 *   - The model picker in the privacy banner is hidden.
 *   - The Power Mode toggle is hidden (forced-RAG only matters with an
 *     LLM).
 *   - The Provider Credentials Settings sub-tab is hidden, and a banner
 *     at the top of the Settings page explains that the provider /
 *     model / tier / Power-Mode fields on it have no effect. (Those
 *     fields still render — they are inert, not hidden.)
 *   - The Settings "Templates-only mode" toggle itself is hidden: it
 *     could not turn the LLM path back on, so showing it would be a
 *     control that lies.
 *   - Model discovery is compile-time inert (`components/ai/
 *     modelDiscovery.ts`) — no vendor model-list calls, and its two
 *     Settings rows are hidden.
 *   - A persistent banner at the top of the chat tells the user that
 *     LLM dispatch is disabled.
 *
 * The canned-prompt path stays fully functional: the user opens the
 * prompt browser, picks a saved search, and the result tile + static
 * guidance card render exactly as in the regular build. The MCP server
 * is still required (it's the only way to dispatch SPL).
 *
 * NOT part of this flag: the vendor provider modules are still present
 * in the bundle (v0.1.1 ships them; the frozen v0.0.6 line deletes them
 * from source instead). Bundle-level stripping was explicitly declined —
 * this is a functional disable, so vendor endpoint strings remaining in
 * `home.js` is expected.
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

/**
 * App version (`[id] version`) and build number (`[install] build`), read
 * from the shipped `default/app.conf` by webpack at compile time and
 * substituted here by DefinePlugin — same mechanism as TEMPLATES_ONLY
 * above. Displayed by the About modal (Build 302 / session 092).
 *
 * DERIVED, NOT TYPED. app.conf is the single source of truth the release
 * process already bumps, so these can never drift from the installed app.
 * Do not replace them with literals: build 301 had to sweep a hard-coded
 * prompt count out of five places precisely because a number typed into a
 * user-visible string goes stale silently.
 *
 * The `|| ''` fallbacks only apply outside a webpack build (e.g. Jest,
 * where Node's real process.env has no such keys); the webpack build
 * itself fails loudly if either value is missing from app.conf.
 */
export const APP_VERSION: string = process.env.LOGSERV_APP_VERSION || '';
export const APP_BUILD: string = process.env.LOGSERV_APP_BUILD || '';

/**
 * UTC date this bundle was compiled, as `YYYY-MM-DD` (Build 303).
 *
 * Date only, not a full timestamp — see the rationale in
 * `webpack.config.js`: same-day builds stay byte-comparable, and the
 * build NUMBER is what distinguishes two builds from one day.
 */
export const APP_BUILD_DATE: string = process.env.LOGSERV_APP_BUILD_DATE || '';
