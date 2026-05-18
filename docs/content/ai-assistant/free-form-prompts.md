# Free-form Prompts

!!! warning "v0.0.5 release: this entire feature is disabled pending review"
    The free-form / LLM-driven path is **disabled at compile time** in the v0.0.5 release pending internal review. Chat input is greyed out, Send button is disabled, model picker and Power Mode toggle are hidden, and the Provider Credentials Settings tab is hidden. None of the behavior described on this page is reachable in a v0.0.5 build. This page is preserved as the design reference for the future release that re-enables the LLM path. See [Templates-only Build](templates-only-build.md) for the build mechanism and [OWASP LLM Top 10 Compliance](owasp-llm-compliance.md) for the security posture under review.

Free-form prompts are the LLM-driven path through the AI Assistant. The user types a natural-language question; the orchestrator sends a system primer + the question + tool definitions to one of four supported LLM providers; the vendor picks tools, the orchestrator dispatches them via the [Splunk MCP Server](mcp-setup.md), and the vendor synthesizes a narrative response from the privacy-tier-bounded summaries. The narrative ends up in the chat panel on the left; the actual data lands in tool-result tiles on the right.

This path requires a configured [LLM provider credential](settings.md#provider-credentials-tab), is governed by the active [privacy tier](privacy-tiers.md), and is **disabled at compile time in the [Templates-only build variant](templates-only-build.md)**.

## :material-circle-box:{ .taiconcolor } The Four Supported Providers

| Provider | API Endpoint | Auth | Models |
|---|---|---|---|
| **Anthropic** | `api.anthropic.com` (direct) | API key | Claude Opus 4.7 / Sonnet 4.6 / Haiku 4.5 |
| **OpenAI** | `api.openai.com` (direct) | API key | GPT-4o / GPT-5 family (per OpenAI catalog) |
| **Azure OpenAI** | Customer's Azure deployment URL | Azure auth + URL pattern | Per Azure deployment configuration |
| **AWS Bedrock** | Bedrock API (Claude on Bedrock) | Bedrock API Keys (no SigV4 signing) | Claude on Bedrock — same models as Anthropic direct |

Active provider + default model are admin-configured in [Settings → General](settings.md). Per-user model picker in the chat panel's privacy banner lets users switch within the active provider's `models[]` list.

AWS Bedrock support currently requires Bedrock API Keys. IAM-only credentials (no Bedrock API Key) aren't supported — the React app can't sign SigV4 requests from the browser.

## :material-circle-box:{ .taiconcolor } The Free-form Flow

```
   User types question  -->  Orchestrator builds system primer + tools + history
                                                          |
                                                          v
                                       LLM vendor (streamed response)
                                                          |
                                  AI emits zero or more tool_use blocks
                                                          |
                                                          v
                          For each tool_use, orchestrator dispatches via MCP
                                                          |
                                              MCP returns Hidden<MCPToolResult>
                                                          |
                                  sanitize() chokepoint -> Tier 1 / Tier 2 summary
                                                          |
                                                          v
                                  AI continues, may emit more tool_use blocks
                                                          |
                          (loop until AI emits a final assistant_text response)
                                                          |
                                                          v
                                  Narrative renders in chat; tiles render in right pane
```

Tool dispatch is **parallelized** — when the AI emits multiple `tool_use` blocks in a single turn (e.g., dispatching 5 saved searches at once for a "find the top issues" question), the orchestrator dispatches all of them concurrently via `Promise.all`. The slowest one bounds the turn latency, not the sum.

## :material-circle-box:{ .taiconcolor } The Two MCP Tools the AI Sees

The AI's tool definitions on every free-form request are:

### `splunk_run_saved_search`

Dispatch a saved search from the LogServ App's catalog (one of the 48 prompts described in [Predefined Prompts](predefined-prompts.md)).

| Arg | Type | Description |
|---|---|---|
| `name` | string (required) | Saved-search name from the catalog (e.g., `logserv_hana_failed_auth`) |
| `earliest_time` | string (optional) | Splunk earliest token (e.g., `-24h`, `-7d`). Falls back to the dashboard's TimeRange picker. |
| `latest_time` | string (optional) | Splunk latest token (e.g., `now`). |
| `render_hint` | string (optional) | One of `table` / `timechart` / `kpi` / `pie`. Falls back to the catalog's per-prompt `renderHint`. |
| `top_n` | integer (optional, default 10, max 50) | Width of categorical aggregates the AI receives in Tier 2 summary. The AI passes this when the user asks for "top 25 X" or similar. |

### `splunk_run_query`

Dispatch ad-hoc SPL written by the AI. Used when no saved search fits the user's question.

| Arg | Type | Description |
|---|---|---|
| `query` | string (required) | SPL string. Must start with the LogServ macro `\`sap_logserv_idx_macro\`` (the AI's primer enforces this) and use only read-only commands. |
| `earliest_time` | string (optional) | Same as above. |
| `latest_time` | string (optional) | Same as above. |
| `render_hint` | string (optional) | Same as above. |
| `top_n` | integer (optional) | Same as above. |

**SPL static-analysis guard** ([LLM06 — Excessive Agency](owasp-llm-compliance.md)): the orchestrator runs every `splunk_run_query` SPL through a guard that blocks `collect`, `outputlookup`, `outputcsv`, `delete`, `sendalert`, `sendemail`, `script`, `run`, `tscollect`. Blocked SPL produces a synthetic error tool_result + a `security_blocked_spl` audit event. The AI sees the error and can recover by writing a different query.

## :material-circle-box:{ .taiconcolor } The System Primer

A system-message prelude is sent on every free-form request. The primer teaches the AI:

- A data-boundary rule that distinguishes customer data from instructions (mitigates [LLM01 / LLM04](owasp-llm-compliance.md))
- The catalog of 48 saved searches (so the AI prefers `splunk_run_saved_search` when a saved search fits)
- The LogServ data model (sourcetypes + key fields) for ad-hoc SPL
- The read-only-operators list for `splunk_run_query`
- The [time-window reasoning rules](time-window-reasoning.md) that kick in for severity claims
- Synthesis rules — lettered findings, severity dots, citation format

Two primer variants ship — one for each cloud tier — and the active tier picks which one is sent. For the primer's full architecture (boundary block, primer constants, per-variant content), see [AI Assistant Implementation Reference](../developer/ai-assistant-internals.md).

## :material-circle-box:{ .taiconcolor } Citation + Drill-Down Chips in the Narrative

The AI's narrative response uses a citation format `[→ saved_search_name]` to attribute each finding to its dispatched tool. Each citation in the chat becomes a clickable scroll-to-tile span (clicking it scrolls the right pane to the matching tile). The parser also auto-appends `↗ Dashboard` chips (one per related OOTB dashboard) and a `↗ Run SPL` chip on the same line — see [Drill-down Chips](drill-down-chips.md).

Severity markers (`[severity:critical|high|medium|low]`) are rendered as glossy colored dots inline next to the finding's alpha letter. The finding format is enforced by the primer:

```
A. [severity:high] Cross-stack auth failures concentrated on Windows.
[→ logserv_cross_stack_auth_failures] 7 of the top-10 failing-stack rows are
Windows; one user account hit 4,732 cumulative attempts — verify-query (-24h)
confirmed 412 of those landed today, ~17/hr, an active rate.
```

## :material-circle-box:{ .taiconcolor } Per-User Rate Limiting

Free-form prompts are subject to a per-user rolling-1-hour rate limit, configurable in [Settings → General](settings.md) (default 30 prompts/hour, 0 = disabled). Canned-prompt dispatches are intentionally NOT rate-limited — they bypass the AI vendor entirely (no token cost) and are bounded by Splunk's own search-quota controls.

When a user hits the cap, the next prompt:

1. Renders the user message in chat as usual (preserves history continuity).
2. Surfaces a system_notice in chat: *"Rate limit reached: N prompts in the last hour. Try again at HH:MM."*
3. Records a `rate_limited_prompt` audit event with the user's identity, the cap value, and the timestamp.
4. Does NOT invoke the LLM vendor.

The cap is per-user, not per-session — opening a new browser tab doesn't reset it. Maps to [LLM10 — Unbounded Consumption](owasp-llm-compliance.md).

## :material-circle-box:{ .taiconcolor } Token-Usage Audit + USD Cost Estimate

Every Tier 1 / Tier 2 vendor call records a `vendor_tier1` or `vendor_tier2` audit event with:

- Provider (anthropic / openai / azure_openai / bedrock)
- Model
- Input tokens, output tokens, total tokens
- USD cost estimate (per-vendor pricing table — see [AI Assistant Implementation Reference](../developer/ai-assistant-internals.md))
- Outbound bytes
- Prompt length (chars)
- Number of tool turns in this dispatch
- For Tier 2: number of PII redactions applied

The Audit Log tab in Settings provides aggregate views; the USD cost estimate is a sticker price (not the customer's negotiated rate, which we don't know) and should be treated as an order-of-magnitude indicator. See [Audit Log](audit-log.md).

## :material-circle-box:{ .taiconcolor } Daily Spend Cap

To prevent runaway vendor spend, the orchestrator enforces a per-app-instance daily USD spend cap (configurable in Settings, default $X / day; admin sets per organization risk tolerance). When a vendor call would push cumulative cost over the cap, the orchestrator:

1. Refuses the dispatch.
2. Records a `daily_spend_cap_hit` audit event.
3. Surfaces a system_notice: *"Daily spend cap reached ($X.XX of $Y.YY budgeted). Resets at 00:00 UTC. Contact your admin to raise the cap."*

The cap is **cumulative-cost-based**, not request-count-based — a single high-token-count free-form turn counts against the budget the same way many cheap turns do. Maps to [LLM10 — Unbounded Consumption](owasp-llm-compliance.md).

## :material-circle-box:{ .taiconcolor } Streaming + Abort

The vendor response is streamed token-by-token. The chat-side rendering shows partial responses as they arrive, including partial tool_use blocks. The status indicator switches between three states:

- **streaming** — AI is generating text or about to emit a tool_use
- **tool_executing** — orchestrator is dispatching a tool the AI requested
- **idle** — turn complete

A red **Stop** button appears in the chat input toolbar during streaming / tool_executing states. Clicking it aborts the in-flight vendor call (closes the SSE stream) and any pending tool dispatches. The conversation history preserves what was emitted up to the abort point so the user can iterate from there.

## :material-circle-box:{ .taiconcolor } Jailbreak Pattern Detection

Every user prompt is run through a jailbreak-pattern analyzer before dispatch. The analyzer is **flag-and-proceed**: a match fires a `user_prompt_jailbreak_flag` audit event but does NOT block the prompt. The defense-in-depth chain (type-system enforcement + Tier 2 sanitizer + tool-result sentinel + primer + vendor-side defenses) already covers the threat; the analyzer adds SOC observability for the user-prompt vector. Each flag captures a hash of the prompt (so SOC can correlate without archiving plain text), which patterns matched, and a character-class fingerprint to surface unusual encodings.

For the analyzer's pattern groups + audit event schema, see [AI Assistant Implementation Reference](../developer/ai-assistant-internals.md). Maps to [LLM01 — Prompt Injection](owasp-llm-compliance.md).

## :material-circle-box:{ .taiconcolor } Session Tool-Call Cap

In addition to the per-user rate limit, every chat session has a per-session tool-dispatch cap to prevent infinite tool loops (a misbehaving model emitting tool_use after tool_use without ever producing a final assistant_text). Counter resets on chat clear. When exceeded, dispatch is refused with a synthetic error tool_result and a `session_tool_cap_hit` audit event records the hit. Maps to [LLM06 — Excessive Agency](owasp-llm-compliance.md).
