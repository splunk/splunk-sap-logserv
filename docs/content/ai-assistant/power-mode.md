# Power Mode

!!! info "Requires a configured LLM provider credential"
    Power Mode governs free-form LLM dispatch, so the `✦ Power` toggle appears only where that path is live. The published v0.1.2 App package is the **full-LLM build variant**, but an admin must first configure an [LLM provider credential](settings.md#provider-credentials-tab). The toggle is hidden while **Templates-only mode** is on (Settings → AI Assistant → General) and in a compile-time [templates-only build](templates-only-build.md), since there is then no LLM dispatch to force a saved search before.

Power Mode is a role-gated **`✦ Power`** toggle in the AI Assistant chat-input toolbar. While it is on, the App adds a rule to the system primer of every free-form prompt: the AI must call `splunk_run_saved_search` (or `splunk_run_query`) at least once before it writes any narrative reply (forced-RAG). The rule is an instruction to the model, not a check the App makes: the App does not refuse a reply that comes without a search, so read the tiles to see which searches ran.

## :material-circle-box:{ .taiconcolor } Why Power Mode Exists

The default free-form path lets the AI choose whether to dispatch a tool or reply from prior knowledge. For most questions the AI dispatches appropriately — but for questions that look like the AI knows them already from training data ("What's a HANA audit log?"), it may answer from prior knowledge and skip the tool call. That's fine for explanatory questions, but it's the wrong behavior for investigations: a "what's the failure rate this week?" question deserves a real Splunk dispatch, not a probability-weighted guess.

Power Mode addresses this by adding a forced-RAG rule to the system primer: **for every user message, the AI must call `splunk_run_saved_search` at least once (or `splunk_run_query` if no saved search fits) before generating any narrative answer.**

This is forced-RAG over chosen-RAG: same tools, same MCP path, same privacy tier. Power Mode asks the model for the saved-search-first step; the App does not enforce it. For the primer-augmentation mechanism, see [LogServ App and AI Assistant Internals](../developer/ai-assistant-internals.md).

## :material-circle-box:{ .taiconcolor } Role-Gated Visibility

Power Mode is **opt-in per organization** and **per-role**. The toggle is hidden from users entirely unless their Splunk role is in the configured allow-list. Default: empty list — Power Mode hidden from every user.

**Configuration path** (admin-only):

1. Open Settings → AI Assistant → **General**.
2. Find the **Power Users** section and its **Power Mode roles** field. The list is populated from Splunk's `services/authorization/roles` REST endpoint.
3. Pick the roles that should see the Power toggle (typical: `admin`, `power`, `sc_admin`; add your stack's delegated-admin role, for example `sc_subadmin`, if your admins use one).
4. Click **Save Defaults**.
5. Affected users see the `✦ Power` button in their chat input toolbar on next page load.

Per-user gating would require a custom directory and doesn't compose with Splunk's standard RBAC. Role gating reuses the same primitive admins already manage for everything else (search permissions, app permissions, etc.).

## :material-circle-box:{ .taiconcolor } Toggle UX

The `✦ Power` button is a small pill in the chat input toolbar between **Send** and the keyboard-shortcut hint. State is persisted per-tab in `sessionStorage` under `logserv.aiAssistant.powerMode` — opening a new browser tab resets to OFF.

Visual states:

| State | Button text | Border | Tooltip |
|---|---|---|---|
| OFF (default) | `✦ Power` | panel-border-weak | *"Power Mode OFF — click to enable forced saved-search-first behavior."* |
| ON | `✦ Power ON` | cyan-accent fill | *"Power Mode ON — every prompt forces a saved-search dispatch before AI synthesis. Click to turn off."* |

A11y: `aria-pressed="true"` when on, `aria-pressed="false"` when off.

## :material-circle-box:{ .taiconcolor } What Power Mode Does NOT Change

- **Privacy tier behavior is unchanged.** Tier 1 still gives the AI count + timing only; Tier 2 still gives aggregated metadata only. Power Mode just enforces saved-search-first; tier still controls what AI sees about each search result.
- **Tool dispatch is unchanged.** Same MCP path, same tool definitions (`splunk_run_saved_search`, `splunk_run_query`), same SPL static-analysis guard, same session tool-call cap.
- **Audit categories are unchanged.** A Power Mode prompt records the same `vendor_tier1` audit event as any free-form prompt (one per prompt, whatever the tier); its `powerMode` field records whether the toggle was on, for SOC pivot analysis.
- **Per-user rate limit, daily spend cap, jailbreak detection.** All unchanged.

## :material-circle-box:{ .taiconcolor } When to Use Power Mode

| Use case | Power Mode? |
|---|---|
| Investigations that should be data-grounded ("what's failing right now?") | ON |
| Cross-cutting top-N questions ("find the top 10 issues to attend to") | ON — Power Mode + the [TIME-WINDOW REASONING rules](time-window-reasoning.md) together produce verify-confirmed severity claims |
| Compliance reports that the auditor will cross-check against the rendered tiles | ON (so every claim has a citation) |
| Conceptual questions ("what's a HANA audit log?", "explain risk_level") | OFF (the AI's training knowledge is fine) |
| One-shot follow-ups in an existing conversation where prior tool results already cover the answer | OFF (forces an unnecessary dispatch) |
| Streaming-only chat-only mode (**MCP Required** off) | No effect — the toggle still appears for power-user roles, but with no tool path the App does not add the Power Mode rule to the primer |

## :material-circle-box:{ .taiconcolor } Audit Trail

Every free-form prompt that completes records one `vendor_tier1` audit event, after its last turn, with a `powerMode` flag that captures whether the toggle was on for that prompt. Use cases for the audit field:

- **SOC pivot:** filter audit events to `powerMode=true` to see only the strict-data-grounded turns.
- **Compliance review:** confirm that audit-period investigations were run with Power Mode on (so every cited finding has a tool dispatch behind it).
- **Cost analysis:** prompts with Power Mode on tend to run more searches, and so cost more per prompt. The audit lets finance attribute spend to the gating choice.

Power Mode does NOT generate a separate audit category — it's a flag on the existing `vendor_tier1` event. See [Audit Log](audit-log.md).
