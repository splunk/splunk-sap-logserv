# AI Assistant — Overview

!!! warning "v0.0.5 release: LLM functionality intentionally disabled pending review"
    The v0.0.5 release of Splunk for SAP LogServ ships with the LLM-driven AI Assistant path **disabled at compile time pending internal review**. The predefined-prompt path + Splunk MCP Server integration + tool tiles + drill-down chips + audit log all stay fully active. The free-form chat input is disabled, the model picker is hidden, and the Provider Credentials Settings tab is hidden. See [Templates-only Build](templates-only-build.md) for the build mechanism. The LLM-driven path will be re-enabled in a future release once review concludes.

## :material-circle-box:{ .taiconcolor } What the AI Assistant Is

The AI Assistant is a Splunk-aware chat panel embedded in the LogServ App that lets analysts run pre-canned investigations and free-form questions against their Splunk data. It sits to the right of every dashboard as a togglable side panel, accessed via the **`✦ AI Assistant`** button in the top-right of the app's nav bar.

It has **two distinct paths** with different cost, latency, and privacy properties:

- **Predefined prompts (no LLM call).** The user opens the prompt browser and clicks one of 48 cataloged prompts. The orchestrator dispatches the saved search via the [Splunk MCP Server](mcp-setup.md), renders the result tile in the right pane, and appends a static interpretation + suggested-next-steps card. **No vendor LLM is invoked.** Free, instant (search latency only), zero data egress.
- **Free-form prompts (LLM-driven).** The user types a natural-language question. The orchestrator sends a system primer + the question + tool definitions to the active vendor (Anthropic / OpenAI / Azure OpenAI / AWS Bedrock). The vendor picks tools, the orchestrator dispatches them via MCP, the vendor sees only the privacy-tier-bounded summary, and the vendor synthesizes a narrative response. Vendor-cost-bearing, dependent on LLM credentials, governed by the active [privacy tier](privacy-tiers.md).

## :material-circle-box:{ .taiconcolor } The Privacy Invariant

> **No event data from your Splunk instance is ever transmitted to any AI vendor.**

This is not policy; it is **enforced by the type system at build time**. The TypeScript compiler refuses to put any tool-result value from MCP into an outbound vendor payload — there is no runtime check, no flag to flip, no policy to forget. The only conversion path produces a non-data summary whose contents are gated by the active **privacy tier** ([Tier 0](privacy-tiers.md) / Tier 1 / Tier 2):

- **Tier 0** (future) — air-gapped Ollama; no vendor traffic at all.
- **Tier 1 (default)** — `count + execution_time` only. The AI sees no values.
- **Tier 2 (admin opt-in)** — adds aggregated metadata: per-column cardinality, top-N values + counts (categorical), min/max/avg/sum (numeric), time range. **Still no raw rows.**

What the AI vendor sees: your natural-language question, schema descriptions, tool definitions, the AI's own summaries. What the AI vendor does **not** see: any field value from any event in your `sap_logserv_logs` index.

For details, see [Privacy Tiers](privacy-tiers.md).

## :material-circle-box:{ .taiconcolor } Architecture at a Glance

```
   User question
        |
        v
   AI vendor  -->  AI picks tools  -->  Splunk MCP Server  -->  Splunk search-job
        |                                                              |
        |                                  (raw rows stay client-side) |
        |  <-----  privacy-tier summary  <----+ (count + timing,
        |                                       optionally aggregates)
        |
        v  AI synthesizes narrative reply
   Chat panel (left pane)        Tool result tiles (right pane)
```

Every saved-search dispatch produces a tool-result tile in the right pane (table / chart / KPI / pie based on the prompt's `renderHint`). The user sees the actual rendered data; the AI sees only the privacy-tier-bounded summary. Drill-down chips (`↗ Dashboard`, `↗ Run SPL`) on each tile (and beside chat citations) connect the conversation back into the dashboards or Splunk's universal Search app — see [Drill-down Chips](drill-down-chips.md).

For the build-time type-system mechanism that makes this guarantee non-bypassable, see [AI Assistant Implementation Reference](../developer/ai-assistant-internals.md).

## :material-circle-box:{ .taiconcolor } Key Capabilities

- **48 predefined prompts** in three packs (sap_basis 13, security 14, operations 13) plus a context-aware **Dashboard Focused** tab that auto-filters to prompts relevant to the dashboard you currently have open. See [Predefined Prompts](predefined-prompts.md).
- **Four LLM providers** for the free-form path: Anthropic (direct API), OpenAI (direct API), Azure OpenAI (composed with Azure auth), AWS Bedrock (Claude on Bedrock with Bedrock API Keys). Per-user model-picker in the chat header lets users switch within the active provider's model list. See [Settings & Configuration](settings.md).
- **[Power Mode](power-mode.md)** — admin-granted role-gated `✦ Power` toggle that forces a saved-search dispatch before LLM synthesis (forced-RAG). Guarantees data-grounded answers; never responds from prior knowledge alone.
- **[Time-window reasoning](time-window-reasoning.md)** — primer rules teach the AI to identify the dispatch window, normalize cumulative count to per-hour or per-day rate, run a verify-query before declaring high-severity, and state the window precisely in narrative.
- **[Audit log](audit-log.md)** — every action (canned dispatch, vendor call, security block, privacy-tier elevation, legal acknowledgement) lands in a dedicated `_ai_assistant_audit` index. In-app browser + optional [HEC forwarder](audit-log.md#hec-forwarder) for tamper-evidence.
- **[OWASP LLM Top 10 (2025) compliance](owasp-llm-compliance.md)** — every item has a matching control: prompt-injection sanitization, type-bounded data redaction, supply-chain SBOM, audit hash chain, per-user rate limit, USD spend cap, SPL static-analysis guard, jailbreak detection, PII redaction.
- **[Templates-only build variant](templates-only-build.md)** — a deployable variant of the LogServ App that disables the LLM-driven flow at compile time. The MCP path + canned prompts + audit log stay fully active.

## :material-circle-box:{ .taiconcolor } Prerequisites

- **Splunk 9.4.3 or later.**
- **[Splunk MCP Server (Splunkbase App 7931)](https://splunkbase.splunk.com/app/7931) v1.1.0 or later** installed on the same search head as the LogServ App. See [Splunk MCP Setup](mcp-setup.md). Cookie auth from the same Splunk Web session works by default; the optional bearer token layers on top.
- **One of the four supported LLM providers** with a valid API credential — only required for the free-form path. Predefined prompts work without any LLM provider.
- **Admin user role** to configure provider credentials, set the privacy tier, manage Power Mode roles, and view the Audit Log tab.

## :material-circle-box:{ .taiconcolor } First-time UX

1. Click **`✦ AI Assistant`** in the top-right nav. The right-side panel opens.
2. If MCP isn't healthy, the panel shows a setup wizard with diagnostic guidance — see [Splunk MCP Setup](mcp-setup.md). Otherwise, the empty chat panel renders.
3. Click **Browse predefined prompts** to open the catalog modal. Pick a prompt from the SAP Basis / Security / Operations / Dashboard Focused tab.
4. The prompt dispatches via MCP and renders a tool tile in the right pane along with a static "How to read this result" guidance card on the left.
5. Click any of the drill-down chips on the tile (`↗ Dashboard`, `↗ Run SPL`) to investigate further.

For free-form prompts, type a natural-language question in the chat input and press **Send** (or `Cmd/Ctrl+Enter`). The chat status indicator shows when the AI is generating a response or running a search.

## :material-circle-box:{ .taiconcolor } When to Use Which Path

| Use case | Recommended path |
|---|---|
| Routine "show me X" investigations on the cataloged dimensions | Predefined prompts |
| Compliance / audit reports with a fixed cadence | Predefined prompts (deterministic, zero vendor traffic) |
| Free-form questions about the data the catalog doesn't cover | Free-form, with [Power Mode](power-mode.md) on if available |
| Cross-cutting "what's most critical right now?" investigations | Free-form (the AI dispatches multiple saved searches in parallel and synthesizes) |
| Demonstration environments where vendor-LLM access is intentionally unavailable | [Templates-only build](templates-only-build.md) |
| Air-gapped environment with no outbound internet | Tier 0 (future — see [Privacy Tiers](privacy-tiers.md)) |

## :material-circle-box:{ .taiconcolor } Where to Go Next

- **[Privacy Tiers](privacy-tiers.md)** — full breakdown of what each tier exposes and the decision matrix for picking one.
- **[Predefined Prompts](predefined-prompts.md)** — the 48 prompts, the prompt browser UX, and the intent-map customization story.
- **[Free-form Prompts](free-form-prompts.md)** — the LLM-driven flow, tool dispatch, citations, rate limiting, and Power Mode.
- **[Splunk MCP Setup](mcp-setup.md)** — installing and configuring the prerequisite MCP server.
- **[Settings & Configuration](settings.md)** — the 4-tab admin Settings page (General / Provider Credentials / Splunk MCP / Audit Log).
- **[Audit Log](audit-log.md)** — what's logged, the in-app viewer, and the optional HEC forwarder for tamper-evidence.
- **[OWASP LLM Top 10 Compliance](owasp-llm-compliance.md)** — security controls posture for compliance reviews.
