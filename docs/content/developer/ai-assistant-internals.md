# AI Assistant — Implementation Reference

This document covers the implementation details of the LogServ App's AI Assistant subsystem — file paths, type-system patterns, build mechanics, audit-event schemas, and extension recipes. Intended for engineers who need to maintain or extend the AI Assistant code.

For the customer-facing documentation, see the [AI Assistant section](../ai-assistant/overview.md). The customer-facing pages cover what users see and how to use the feature; this page covers how it's built.

---

## :material-circle-box:{ .taiconcolor } File Path Map

The AI Assistant subsystem lives in the LogServ App's React workspace at `packages/log-serv-app/src/main/webapp/pages/home/`. Key files:

| Path | Purpose |
|---|---|
| `hooks/useAIAssistant.ts` | The orchestrator hook. Contains `runCannedPrompt`, `sendUserMessage`, `tier1Summary`, `tier2Summary`, `SYSTEM_PRIMER_TIER1`, `SYSTEM_PRIMER_TIER2`, `POWER_MODE_RULE_SUFFIX`, `SAVED_SEARCH_SPL`, `SAVED_SEARCH_DASHBOARDS`, `SAVED_SEARCH_CHART_HINTS`, `resolveNextSteps`, `wrapAsToolResultData`, `sanitizeAggregateValue`. |
| `state/AIAssistantProvider.tsx` | React context + reducer. `DisplayMessage` shape including `toolResult.spl` / `earliest` / `latest` for drill-down chip URL pre-resolution. |
| `components/ai/types/Hidden.ts` | The `Hidden<T>` and `Visible<T>` brand-type definitions, `markHidden`, `unwrapHidden`, `markVisible`, `unwrapVisible`, `sanitize`. |
| `components/ai/mcp/MCPClient.ts` | MCP client wrapper. Constructs requests, handles cookie + bearer auth, parses responses into `MCPToolResult`. |
| `components/ai/providers/` | Per-vendor provider implementations: `AnthropicProvider.ts`, `OpenAIProvider.ts`, `AzureOpenAIProvider.ts`, `BedrockProvider.ts`, plus shared `credentials.ts`, `sseUtils.ts`, `anthropicEventTranslator.ts`. |
| `components/ai/chat/AIAssistant.tsx` | Top-level chat panel. Builds the `citationLookup: Map<string, { toolUseId; splUrl? }>` from `toolResultsInOrder`. |
| `components/ai/chat/ChatMessage.tsx` | Renders user / assistant_text / tool_call / tool_result / system_notice / guidance messages. Contains `TEXT_PATTERN` regex for citation + severity + bold parsing. |
| `components/ai/chat/ToolResultPanel.tsx` | Renders a single tool result as table / chart / KPI / pie. Contains the actions-slot rendering for `↗ Dashboard` / `↗ Run SPL` / Clear chips. |
| `components/ai/chat/ChatInput.tsx` | Chat input toolbar. `✦ Power` toggle visibility gating + Templates-only gating. |
| `components/ai/chat/PrivacyBanner.tsx` | Tier banner + model picker. Templates-only hides the picker. |
| `components/ai/audit/AuditWriter.ts` | Browser-side audit batch + flush. Dual-writes to local `logserv_ai_assistant_audit` index AND optional HEC forwarder. |
| `components/ai/audit/auditTypes.ts` | All 12 audit-event TypeScript types. |
| `dashboards/AIAssistantSettings.tsx` | The 4-tab Settings page. Templates-only hides the Provider Credentials tab. |
| `utils/splGuard.ts` | SPL static-analysis guard. Blocks `collect`/`outputlookup`/`outputcsv`/`delete`/`sendalert`/`sendemail`/`script`/`run`/`tscollect` for AI-authored ad-hoc SPL. |
| `utils/jailbreakPatterns.ts` | User-prompt jailbreak-pattern detection. FNV-1a hash + matched-groups + char-class fingerprint capture. |
| `utils/piiRedaction.ts` | Tier 2 PII redaction. FNV-1a 32-bit hash → 7-char hex tag, sync. Stable per-value across the run. |
| `utils/rateLimit.ts` | Per-user rolling-1-hour rate limit. Records `rate_limited_prompt` audit event on hit. |
| `utils/dailySpend.ts` | Cumulative-cost daily spend cap. Records `daily_spend_cap_hit` on overflow. |
| `utils/vendorCost.ts` | Per-vendor pricing table for USD cost estimate. |
| `utils/drilldownUrls.ts` | `buildDashboardUrl`, `buildHostDetailsUrl`, `buildSplunkSearchUrl`, `openInNewTab`, `splQuote`, `sourcetypeToDashboardSlug`. |
| `buildFlags.ts` | Build-time feature flags. Currently exports `TEMPLATES_ONLY: boolean`. |
| `utils/aiConfigApi.ts` | Read / write config from `default/ai_assistant_settings.conf` via REST. |
| `utils/passwordsApi.ts` | Read / write credentials from Splunk's encrypted password store via `services/storage/passwords`. |
| `utils/telemetryConfApi.ts` | Splunk-pattern legal-acknowledgement opt-in tracking via `default/ai_assistant_acks.conf`. |
| `state/dashboardRefreshPersistence.ts` | KV Store CRUD for the per-dashboard auto-refresh picker. |
| `default/data/mcp/logserv_intent_map.json` | The 48-prompt catalog. |
| `default/savedsearches.conf` | The 48 saved searches that intent-map prompts dispatch. |
| `default/ai_assistant_settings.conf` | Org-wide AI Assistant config defaults. |
| `default/ai_assistant_acks.conf` | Splunk-pattern legal-acknowledgement opt-in version + acknowledgement timestamps. |

---

## :material-circle-box:{ .taiconcolor } The `Hidden<T>` / `Visible<T>` Brand Type Pattern

The privacy invariant — *"no event data from your Splunk instance is ever transmitted to any AI vendor"* — is mechanically enforced via TypeScript brand types in `components/ai/types/Hidden.ts`:

```typescript
declare const HIDDEN_BRAND: unique symbol;
declare const VISIBLE_BRAND: unique symbol;

export type Hidden<T> = T & { readonly [HIDDEN_BRAND]: true };
export type Visible<T> = T & { readonly [VISIBLE_BRAND]: true };

export const markHidden = <T>(v: T): Hidden<T> => v as Hidden<T>;
export const unwrapHidden = <T>(v: Hidden<T>): T => v;

export const markVisible = <T>(v: T): Visible<T> => v as Visible<T>;
export const unwrapVisible = <T>(v: Visible<T>): T => v;

export const sanitize = <T, S>(
    hidden: Hidden<T>,
    summarizer: (v: T) => S,
): Visible<S> => markVisible(summarizer(unwrapHidden(hidden)));
```

**Invariant:** the only way to obtain a `Visible<S>` from a `Hidden<T>` is via `sanitize(hidden, summarizer)`. The compiler refuses any other coercion path. The summarizer receives the unwrapped data and returns a non-data summary string; the orchestrator's call site picks the summarizer based on the active privacy tier (`tier1Summary` for Tier 1, `tier2Summary` for Tier 2).

**Where the chokepoint runs:** `useAIAssistant.ts` `sendUserMessage` → tool dispatch → `MCPClient` returns `Hidden<MCPToolResult>` → `sanitize(toolResult, tier === 2 ? tier2Summary : tier1Summary)` → resulting `Visible<string>` is appended to the outbound vendor message buffer.

**Where the type system enforces:** every outbound vendor message is built from `Visible<Message>[]`. Anywhere code constructs an outbound message, the types refuse a `Hidden<T>` value. There is no `as any` cast; bypassing requires modifying the brand-type code itself, which is reviewed.

**Augmenting a `Visible<T>`-branded string:** direct concatenation produces a TS error since the brand type can't widen back automatically. The pattern is `unwrapVisible() + new string + markVisible()`. The Power Mode primer augmentation uses this pattern.

---

## :material-circle-box:{ .taiconcolor } The Build Flag Pattern (`TEMPLATES_ONLY` and Future Flags)

### Why compile-time, not runtime

Compile-time flags are baked into the bundle at build time and CANNOT be changed post-deploy. The runtime alternative — an admin toggle that disables a code path — would let any admin flip it on. For deployments where a code path is intentionally not available (e.g., the LLM dispatch path under review), a compile-time variant is the right shape: the bundle has no code path that reaches the disabled feature, and there's no runtime setting that could enable one.

### Single source of truth

`buildFlags.ts` is the canonical module for compile-time flags — it exports each flag as a typed boolean derived from a build-time substitution. Use sites import the flag from `buildFlags.ts` rather than reading the underlying env var directly. After minification + dead-code elimination, unreachable branches are eliminated from the bundle that has the flag off (verified via grep on the minified output for the absence of the underlying env-var token).

The pattern composes: a build can carry multiple flags simultaneously, and DCE ensures each variant is lean.

### Defense-in-depth runtime guards

Even with compile-time gating, defense in depth pairs the UI gating with a runtime guard at the LLM dispatch entry point. When `TEMPLATES_ONLY` is true, the guard short-circuits the dispatch with a system notice directing the user to the prompt browser instead. The UI gating is the primary defense; the function-level guard catches any future code path that might bypass the disabled chat input (keyboard shortcut, programmatic dispatch, etc.).

---

## :material-circle-box:{ .taiconcolor } The Chat Citation Parser

`components/ai/chat/ChatMessage.tsx` parses inline markers in assistant_text + guidance messages. The regex:

```typescript
const TEXT_PATTERN = /\[(?:→|->)\s*([a-zA-Z0-9_:.\-]+)\]|\[severity:(critical|high|medium|low)\]|\*\*([^*]+)\*\*/g;
```

Three numbered capture groups disambiguate which alternative fired:

| Group | Pattern | Renders as |
|---|---|---|
| 1 | `[→ logserv_xxx]` or `[-> logserv_xxx]` | Clickable scroll-to-tile span via `onJumpToResult(toolUseId)`; auto-appends sibling `↗ Dashboard` chip(s) + `↗ Run SPL` chip |
| 2 | `[severity:critical|high|medium|low]` | Glossy colored dot via `<SeverityDot $level={level} />` |
| 3 | `**bold text**` | Bold-stripped: the `**` markers are dropped and the inner text is re-parsed recursively for nested citation / severity markers (build 174 fix) |

**The recursive-parse fix** (build 174): when the AI drifts and emits `**[severity:medium]**` (markdown bold wrapping the severity marker), the bold alternative matches first and would render the inner text as plain string, losing the severity dot. The fix recursively calls `renderTextWithCitations()` on the bold inner content. Save/restore of `TEXT_PATTERN.lastIndex` around the recursive call is required because the regex is module-scoped + `/g`-stateful — not saving would corrupt the outer iteration.

**Why module-scoped state:** `lastIndex` reset at function entry handles the common case. For recursive parses, save/restore around the call is required.

---

## :material-circle-box:{ .taiconcolor } The MCP Tool Definitions Sent on Every Free-Form Request

The AI sees these two tool definitions on every free-form request. The schemas are sent in the system primer's tool-block:

### `splunk_run_saved_search`

```json
{
    "name": "splunk_run_saved_search",
    "description": "Dispatch a saved search from the LogServ App's catalog.",
    "input_schema": {
        "type": "object",
        "properties": {
            "name": {"type": "string", "description": "Saved-search name from the catalog (e.g., logserv_hana_failed_auth)"},
            "earliest_time": {"type": "string", "description": "Splunk earliest token (-24h, -7d, etc.)"},
            "latest_time": {"type": "string", "description": "Splunk latest token (now, etc.)"},
            "render_hint": {"type": "string", "enum": ["table", "timechart", "kpi", "pie"]},
            "top_n": {"type": "integer", "minimum": 1, "maximum": 50, "description": "Width of categorical aggregates the AI receives in Tier 2 summary. Default 10."}
        },
        "required": ["name"]
    }
}
```

### `splunk_run_query`

Same schema shape but accepts a `query` (SPL string) instead of `name`. SPL is run through `utils/splGuard.ts` before dispatch to block write/delete/alert operators.

---

## :material-circle-box:{ .taiconcolor } The SPL Static-Analysis Guard

`utils/splGuard.ts` exposes `analyzeSpl(spl: string): { blocked: boolean; reason?: string; operator?: string }`. Blocked operators:

```typescript
const BLOCKED_OPERATORS = [
    'collect', 'outputlookup', 'outputcsv',
    'delete', 'sendalert', 'sendemail',
    'script', 'run', 'tscollect',
];
```

Detection runs after lowercasing + stripping leading whitespace per pipe segment. Quoted strings are stripped before matching to avoid false positives on legitimate SPL where these tokens appear inside string literals.

**Audit on block:** `security_blocked_spl` event with `spl` (truncated to 1000 chars) + `operator` field. The synthetic error tool_result lets the AI see the failure and recover by writing a different query.

**Scope:** only AI-authored `splunk_run_query` SPL. Pre-authored saved searches dispatched via `splunk_run_saved_search` are NOT subject to the guard — their SPL is reviewed at build time.

---

## :material-circle-box:{ .taiconcolor } Audit Event Schemas

All audit events extend a `BaseAuditEvent` shape:

```typescript
interface BaseAuditEvent {
    category: string;       // discriminator
    timestamp: string;      // ISO-8601 UTC
    user: string;           // Splunk username
    sessionId: string;      // Per-tab session UUID
    seq: number;            // Monotonic per-session sequence
}
```

Per-category extras:

| Category | Extra fields |
|---|---|
| `local_only` (`LocalOnlyEvent`) | `promptId: string`, `spl: string`, `rowCount: number`, `executionMs: number`, `ok: boolean` |
| `vendor_tier1` (`VendorTier1Event`) | `provider`, `model`, `inputTokens`, `outputTokens`, `vendorCostEstimateUsd`, `outboundBytes`, `promptLength`, `turnCount`, `powerMode?: boolean` |
| `vendor_tier2` (extends Tier1Event) | `aggregateKind: string`, `tier2RedactionsApplied: number` |
| `vendor_tier2_elevation` | `previousTier`, `newTier` |
| `security_blocked_spl` (`SecurityBlockedSplEvent`) | `spl` (truncated to 1000 chars), `operator: string` |
| `rate_limited_prompt` (`RateLimitedPromptEvent`) | `cap`, `attemptedCount`, `windowSeconds` |
| `user_prompt_jailbreak_flag` (`UserPromptJailbreakFlagEvent`) | `promptHash` (FNV-1a 32-bit hex), `promptLength`, `matchedGroups: string[]`, `charClassFingerprint: string` |
| `session_tool_cap_hit` (`SessionToolCapHitEvent`) | `cap`, `attemptedCount`, `toolName` |
| `daily_spend_cap_hit` (`DailySpendCapHitEvent`) | `cap`, `currentSpend`, `attemptedSpend` |
| `audit_forwarder_failure` | `destinationUrl` (sanitized — query strings stripped), `reason`, `batchSize` |
| `forwarder_disabled_acceptance` / `ai_assistant_enable_acceptance` | `host` (Splunk-stamped IP), `tcVersion`, `optInChoice`, `disclaimerHash` |

All schemas live at `components/ai/audit/auditTypes.ts`.

### Splunk reserved-field gotcha

The `category` field on these events is a Splunk reserved name. The viewer's SPL uses `| eval category=json_extract(_raw, "category")` after `spath` because `spath` does NOT overwrite reserved fields. Replicate this pattern in custom queries.

---

## :material-circle-box:{ .taiconcolor } Adding a New Predefined Prompt

1. Edit `default/data/mcp/logserv_intent_map.json` — add a new entry to the `prompts` array. Required fields: `promptId`, `savedSearch`, `label`, `description`, `spl`, `renderHint`. Optional: `chartHint`, `chartPalette`, `dashboard`, `interpretation`, `nextSteps`.
2. Edit `default/savedsearches.conf` — add a stanza with the same name as the prompt's `savedSearch` field. The SPL must match byte-for-byte.
3. Bump the intent map's top-level `version` field.
4. Run `yarn intentMap.consistency-test` (or equivalent in your CI) — the test asserts byte-equality between the intent map's SPL and savedsearches.conf for every prompt.
5. **Pre-deploy SPL dry-run.** Dispatch the new prompt's SPL via `services/search/jobs/oneshot` against live data:
   ```bash
   curl -sk -u admin:<pw> --data-urlencode "search=<your spl>" \
       -d output_mode=json -d earliest_time=-30d -d latest_time=now \
       https://localhost:8089/services/search/jobs/oneshot
   ```
   Confirm the result has rows with the expected fields. ~50% of new prompts fail static review with field-extraction issues that only surface against live data.
6. Bump UI App `[install] build` in `app.conf` to bust Splunk Web's static-asset cache.

### Intent map JSON schema

```typescript
interface IntentMapPrompt {
    promptId: string;
    savedSearch: string;
    label: string;
    description: string;
    spl: string;
    renderHint: 'table' | 'timechart' | 'kpi' | 'pie';
    chartHint?: 'timechart' | 'kpi' | 'pie';
    chartPalette?: 'volume' | 'errors' | 'errors-2' | 'errors-3' | 'auth' | 'status' | 'categorical' | 'neutral';
    dashboard?: string | string[];
    interpretation?: string;
    nextSteps?: Array<string | { text: string; savedSearch?: string; spl?: string }>;
}
```

### Splunk risky-command safeguard

Splunk Web's Search app has a safety modal on these commands: `map`, `runshell`, `script`, `delete`, `crawl`, `tscollect`, `loadjob`, `outputlookup`, `outputcsv`, `sendalert`, `sendemail`. URLs to `/app/search/search?q=...` containing one of these triggers the modal.

Scan all SPL — including `nextSteps.spl` deep-dive strings — for risky commands before shipping. Rewrite `map`-style cross-row dispatches to first-class subsearch syntax: `[ search ... | top 1 X | fields X ]`.

---

## :material-circle-box:{ .taiconcolor } Adding a New Audit Event Category

1. Edit `components/ai/audit/auditTypes.ts` — add a new TypeScript interface extending `BaseAuditEvent` with the category-specific fields. Add the type to the `AuditEvent` union.
2. Add the new category id to the discriminator string-literal type.
3. Find the call site that should emit the event. Construct the event object and call `ctx.actions.recordAudit(event)`.
4. Edit `components/AuditLogViewer.tsx` — add the new category id to `AUDIT_CATEGORIES` (the filter chip set) and to `CATEGORY_GRADIENTS` (the chip gradient lookup).
5. Bump the UI App build.

The audit writer (`components/ai/audit/AuditWriter.ts`) sends events to BOTH the local `logserv_ai_assistant_audit` index AND the optional HEC forwarder. No code change needed at the writer layer for new categories.

---

## :material-circle-box:{ .taiconcolor } System Primer Architecture

Two primer variants ship: `SYSTEM_PRIMER_TIER1` and `SYSTEM_PRIMER_TIER2`. Both live in `hooks/useAIAssistant.ts` as exported constants. They share most of their content; the differences:

- **Tier 1** primer instructs the AI that summaries it receives are count + execution-time only, and to write SHAPE-aware narrative ("X rows returned for the search's rolling window") rather than inventing concrete values.
- **Tier 2** primer informs the AI that summaries include aggregated metadata (per-column cardinality, top-N values + counts, numeric stats, time range), and instructs it to ground every claim in the actual values from the aggregates. PII redaction tagging is also explained.

Both primers include:

- The TOOL_RESULT_DATA boundary block (`<TOOL_RESULT_DATA>...</TOOL_RESULT_DATA>` sentinels)
- The TIME-WINDOW REASONING block (build 171)
- The canonical saved-search catalog (48 entries)
- The LogServ data model (sourcetypes + key fields, for ad-hoc SPL)
- The decision rule for `splunk_run_saved_search` vs `splunk_run_query`
- The SYNTHESIS RULES section: lettered finding format, severity-dot rendering, citation format, etc.

**Power Mode augmentation:** when the user has Power Mode on, `POWER_MODE_RULE_SUFFIX` is appended to the primer at dispatch time via `unwrapVisible(content) + suffix` then `markVisible()` (the brand type can't widen back automatically).

---

## :material-circle-box:{ .taiconcolor } Pre-Resolving Drill-Down URLs at the Orchestrator Layer

The drill-down chip URLs (`↗ Dashboard`, `↗ Run SPL`) are pre-resolved at the AIAssistant.tsx layer, where each tool result's exact dispatch window is known. The resolved URLs are stored on the `citationLookup` Map for the chat parser to consume:

```typescript
const citationLookup: Map<string, { toolUseId: string; splUrl?: string }> = new Map();
toolResultsInOrder.forEach((tr) => {
    if (tr.displayName) {
        const splUrl = tr.spl
            ? buildSplunkSearchUrl(tr.spl, tr.earliest, tr.latest)
            : undefined;
        citationLookup.set(tr.displayName, { toolUseId: tr.toolUseId, splUrl });
    }
});
```

The chat-side renderer (`ChatMessage.tsx`) is dumb — it just renders `<a href={entry.splUrl}>` when the lookup carries a URL. This avoids duplicating SPL-lookup logic at every consumer.

Same pattern applies to the dashboard chips (build 156): the `dashboardLinks` are resolved once via `resolveDashboardLinks(slugs)` at the orchestrator and consumed as `{slug, name, url}` triples.

---

## :material-circle-box:{ .taiconcolor } Legal Acknowledgement Modal Trigger Logic

Two compile-time legal modals gate Settings save flows:

- **Enable Acceptance Modal** — gates `enabled = true` saves.
- **Forwarder Disabled Acceptance Modal** — gates `audit_forwarder_enabled = false` saves.

Both follow Splunk's `splunk_instrumentation` `optInVersion` framework with one extension. The trigger logic is:

```typescript
isEnableTcPending = (
    (saved.enabled === false && draft.enabled === true)  // deliberate toggle-on
    OR
    (currentOptInVersion > userAcknowledgedVersion)       // version bumped
)
```

The pure `optInVersion`-only path is what Splunk's stock telemetry uses (acknowledge once per version, durable until bump). We added the deliberate-toggle-transition trigger because re-enabling AI Assistant after a disable is a deliberate user action that warrants re-acknowledgement of the legal posture each time.

`telemetryConfApi.ts` exposes `readTcAcknowledgement(stanza)` / `writeTcAcknowledgement(stanza, choice, version)` parameterized by stanza name. The two modal stanzas are constants: `STANZA_FORWARDER_TC` and `STANZA_ENABLE_TC`.

The conf-writer coerces `yes`/`no` to `'1'`/`'0'`. The audit event preserves the literal string in `_raw`, so the audit event is the canonical record while the conf is the state marker.

---

---

## :material-circle-box:{ .taiconcolor } Why Primer Rules Beat Other Fixes (TIME-WINDOW REASONING)

Three alternative fixes were considered before settling on primer rules for the time-window reasoning behavior:

1. **Surface the dispatch window in Tier 2 metadata even for non-`_time` results.** Would let the AI see the window directly without reasoning about it. Higher engineering effort (~4-6 hours) than primer rules; deferred unless rules alone don't move the needle.
2. **Re-order the regex alternatives so severity matches first.** Doesn't help: bold wraps around the severity, so even if severity tries first, it can't match inside an unmatched bold span.
3. **Update the primer to forbid bold around severity markers.** Helps for future prompts but doesn't repair existing UI. Parser must be tolerant either way.

Primer rules were the cheapest test of "is this a primer-rules issue?" and it worked: same prompt, same data, dramatically better self-correction behavior in one turn instead of needing a follow-up prompt to re-rank cumulative-noise findings.

This is the canonical pattern: when the AI has the data but isn't using it correctly, primer rules are the cheapest first attempt. When the AI doesn't have the data, metadata expansion is the next step.

---

## :material-circle-box:{ .taiconcolor } Splunk Static-Asset Cache Busting

Splunk Web caches the React bundle's asset URL under a hash that includes the `[install] build` integer in `app.conf`. **Re-deploying the same build number with new bytes serves stale assets even after Splunkd restart.** Always bump the build number for any meaningful code change.

The 3-part SemVer in `[id] version` is independent and only changes on user-facing version bumps. AppInspect's pretrained / Splunkbase precert rules require 3-part SemVer, so directory naming uses a 4-part `vMAJOR.MINOR.PATCH.SNAPSHOT` form for snapshot-tracking purposes only — the `app.conf` `[id] version` stays 3-part.

---

## :material-circle-box:{ .taiconcolor } Live UI Refresh on Settings Save

When the admin saves a config change in the General tab that affects what users see (master `enabled` toggle, `mcp_required`, `power_user_roles`, etc.), the React app re-runs `loadAIAssistantConfig()` immediately and re-applies the new config to the running session. No page reload required.

Implementation: `App.tsx` accepts an `onConfigSaved` callback that re-loads config from the storage REST API. The callback is threaded `App → AppShell → AIAssistantSettings → GeneralPanel`, called after `writeAIConfig` succeeds. Affected props are recomputed on the next React render and the dependent UI re-renders accordingly (e.g., the `✦ AI Assistant` button in the top-right nav appears / disappears).
