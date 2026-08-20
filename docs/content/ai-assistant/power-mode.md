# Power Mode

!!! warning "Full-LLM build variant only"
    The published v0.1.1 App package is the [templates-only build](templates-only-build.md): there is no LLM dispatch to force a saved-search before, so the `✦ Power` toggle is hidden there. This page applies to the separately-built **full-LLM variant** used in approved deployments.

Power Mode is a role-gated **`✦ Power`** toggle in the AI Assistant chat-input toolbar that forces a saved-search dispatch before LLM synthesis on every prompt. When Power Mode is on, the AI MUST call `splunk_run_saved_search` (or `splunk_run_query`) at least once before generating any narrative response — forced-RAG. Reasoning from prior knowledge alone is disallowed; every reply is data-grounded.

## :material-circle-box:{ .taiconcolor } Why Power Mode Exists

The default free-form path lets the AI choose whether to dispatch a tool or reply from prior knowledge. For most questions the AI dispatches appropriately — but for questions that look like the AI knows them already from training data ("What's a HANA audit log?"), it may answer from prior knowledge and skip the tool call. That's fine for explanatory questions, but it's the wrong behavior for investigations: a "what's the failure rate this week?" question deserves a real Splunk dispatch, not a probability-weighted guess.

Power Mode resolves this by adding a forced-RAG rule to the system primer: **for every user message, the AI MUST call `splunk_run_saved_search` at least once (or `splunk_run_query` if no saved search fits) BEFORE generating any narrative answer.**

This is forced-RAG over chosen-RAG: same tools, same MCP path, same privacy tier — Power Mode just enforces the saved-search-first step. For the primer-augmentation mechanism, see [AI Assistant Implementation Reference](../developer/ai-assistant-internals.md).

## :material-circle-box:{ .taiconcolor } Role-Gated Visibility

Power Mode is **opt-in per organization** and **per-role**. The toggle is hidden from users entirely unless their Splunk role is in the configured allow-list. Default: empty list — Power Mode hidden from every user.

**Configuration path** (admin-only):

1. Open Settings → AI Assistant → **General**.
2. Find the **Power Users** subsection. The Multiselect is populated from Splunk's `services/authorization/roles` REST endpoint.
3. Pick the roles that should see the Power toggle (typical: `admin`, `power`, `sc_admin`; on Splunk Cloud deployments where `sc_admin` is reserved for Splunk Ops, use `sc_subadmin`).
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
- **Audit categories are unchanged.** Power Mode runs through the same `vendor_tier1` audit event (emitted for every vendor call regardless of tier); the new field `powerMode?: boolean` records whether the toggle was on at dispatch time, for SOC pivot analysis.
- **Per-user rate limit, daily spend cap, jailbreak detection.** All unchanged.

## :material-circle-box:{ .taiconcolor } When to Use Power Mode

| Use case | Power Mode? |
|---|---|
| Investigations that should be data-grounded ("what's failing right now?") | ON |
| Cross-cutting top-N questions ("find the top 10 issues to attend to") | ON — Power Mode + the [TIME-WINDOW REASONING rules](time-window-reasoning.md) together produce verify-confirmed severity claims |
| Compliance reports that the auditor will cross-check against the rendered tiles | ON (so every claim has a citation) |
| Conceptual questions ("what's a HANA audit log?", "explain risk_level") | OFF (the AI's training knowledge is fine) |
| One-shot follow-ups in an existing conversation where prior tool results already cover the answer | OFF (forces an unnecessary dispatch) |
| Streaming-only chat-only mode (`mcp_required=false`) | Leave it OFF — the toggle still appears for power-user roles, but there is no tool path to force, so the injected must-run-a-saved-search rule cannot be satisfied |

## :material-circle-box:{ .taiconcolor } Audit Trail

Every free-form vendor call records a `vendor_tier1` audit event with a `powerMode` flag that captures whether the toggle was on for that turn. Use cases for the audit field:

- **SOC pivot:** filter audit events to `powerMode=true` to see only the strict-data-grounded turns.
- **Compliance review:** confirm that audit-period investigations were run with Power Mode on (so every cited finding has a tool dispatch behind it).
- **Cost analysis:** Power Mode-on turns dispatch more tools per turn → higher per-turn cost. The audit lets finance attribute spend to the gating choice.

Power Mode does NOT generate a separate audit category — it's a flag on the existing `vendor_tier1` event. See [Audit Log](audit-log.md).
