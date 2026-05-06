# Privacy Tiers

!!! warning "v0.0.5 release: privacy tiers are designed but not exercised — LLM dispatch is disabled"
    The v0.0.5 release ships with the LLM-driven path **disabled at compile time pending internal review**. The privacy tiers described on this page are designed and implemented (the `Hidden<T>` / `Visible<T>` type-system enforcement is always active and will protect any future LLM dispatch), but **no LLM dispatch happens in a v0.0.5 build** — there is no vendor traffic to govern via tier selection. The tier setting in Settings → General is preserved so the configuration survives across releases; it just has no effect until the LLM path is re-enabled in a future release.

The AI Assistant supports three privacy tiers that control what an external LLM vendor sees about your Splunk data. Tier selection is admin-configurable in [Settings → General](settings.md). The active tier is enforced by the TypeScript type system at build time, not by runtime policy: every outbound vendor payload must pass through a single sanitize chokepoint, and the chokepoint's summarizer is what the tier setting controls. For the type-system mechanism, see [AI Assistant Implementation Reference](../developer/ai-assistant-internals.md).

## :material-circle-box:{ .taiconcolor } The Three Tiers at a Glance

| Tier | Vendor traffic? | What the AI sees about each tool result | Use case |
|---|---|---|---|
| **Tier 0** (future release) | None — Ollama local | Same as Tier 1 (count + timing only) | Air-gapped customers, regulated industries with no-outbound-internet constraints |
| **Tier 1** (default) | Cloud LLM (Anthropic / OpenAI / Azure / Bedrock) | `Returned N rows in M ms.` Nothing else. | Most customers — strongest cloud-LLM privacy posture |
| **Tier 2** (admin opt-in) | Same cloud LLM | Tier 1 line + per-column cardinality + top-N values + counts (categorical) + min/max/avg/sum (numeric) + time range. **Still no raw rows.** | Customers who want data-grounded narrative replies and have legal authority to expose aggregate metadata to the vendor |

## :material-circle-box:{ .taiconcolor } Tier 0 — Ollama Local (future release)

**Status:** roadmap, ~1 week of engineering effort. Not yet shipped.

**What it does:** routes the LLM call to a locally-hosted Ollama server instead of a cloud vendor. No outbound internet traffic; no third-party data processor. Strongest possible privacy posture short of disabling free-form prompts entirely (see [Templates-only Build](templates-only-build.md) for that).

**Privacy data flow:**

```
   User question  -->  Local Ollama  -->  AI picks tools  -->  MCP Server
                                                                    |
                                                Hidden<MCPToolResult>
                                                                    |
                                                                    v
                                            sanitize() -> count + timing
                                                                    |
                                                                    v
                                              Local Ollama synthesizes reply
```

**Considerations:**

- Local Ollama latency is substantially higher than cloud LLMs unless the customer has GPU hardware on the search head.
- Model selection is constrained to what Ollama supports locally (Llama-family, Mistral-family, etc.); cloud-only models like Claude Opus aren't available.
- The MCP server prerequisite is unchanged — Tier 0 only changes the LLM endpoint, not the search-execution path.

For customers waiting on Tier 0, the [Templates-only Build](templates-only-build.md) is the interim solution: ship a build with the LLM-driven path disabled at compile time, leaving only the canned-prompt path active.

## :material-circle-box:{ .taiconcolor } Tier 1 — Cloud LLM, Count + Timing Only (default)

**What the LLM sees per tool result:**

```
<TOOL_RESULT_DATA>
Returned 47 rows in 320ms.
</TOOL_RESULT_DATA>
```

That's the entire summary. Nothing about the column names, the row contents, the time range, the distinct counts, or the actual values. The `<TOOL_RESULT_DATA>...</TOOL_RESULT_DATA>` sentinel block is wrapped around every tool-result summary so the AI's primer can teach it that anything inside is data from the customer's environment, never instructions.

**What the AI does with this:** the AI knows the *shape* of what was returned (a count + how long the search took) but not the values. It writes structurally-aware narrative replies — *"the failed-auth saved search returned 47 rows for the rolling window, suggesting a non-trivial number of distinct user/stack pairs"* — without making claims about specific users, IPs, or hosts.

**Decision rule for picking Tier 1:**

- The customer's legal/security team is comfortable with the AI vendor seeing the natural-language question + tool definitions + summaries.
- The customer is **not** comfortable exposing aggregate column metadata (cardinality, top-N values, min/max) to the vendor.
- The customer values determinism: a Tier 1 reply mentions zero specific values, so audit reviewers can sanity-check the narrative against the rendered tile without needing to verify what the AI was told.

**Limitations:** the AI can't write *"the top failing user was xcjadm with 42 attempts"* — it doesn't have that data. The narrative is correspondingly less concrete; the user is expected to read the tile in the right pane for the actual values.

## :material-circle-box:{ .taiconcolor } Tier 2 — Cloud LLM + Aggregated Metadata (admin opt-in)

**What the LLM sees per tool result:**

```
<TOOL_RESULT_DATA>
Returned 47 rows in 320ms.
Time range: 2026-04-15T00:00:00Z → 2026-05-05T23:59:59Z.
Column "user" (distinct=23): xcjadm=8, BKPADMIN=6, ENCRYPTMON=5, sapadm=4, svc_monitor=3 (+18 more).
Column "stack" (distinct=3): Windows=21, HANA=19, SAP=7.
Column "failures" (numeric, distinct=42): min=1 max=4799 avg=87.4 sum=4108.
</TOOL_RESULT_DATA>
```

The AI now sees the column names, top-N values + counts (per-column-cardinality limited to top 10 by default; configurable up to 50 via the AI's `top_n` tool arg), numeric stats, and the time range. **It still does NOT see the raw rows** — there is no way for the AI to know which user issued how many failures across which stacks; only the per-column distributions.

**PII redaction** (Tier 2 only): if the column name matches a known identifier pattern (`email`, `user(name)`, `*_ip`, `mac`, `account`, with hostname opt-in), the values are replaced with stable `<redacted-XXXXXXX>` tags before being shown to the AI. The same value across the run produces the same tag, so the AI can still reason about cardinality + frequency, but never sees the actual identifier. See [OWASP LLM Top 10 — LLM02](owasp-llm-compliance.md).

**What the AI does with this:** the AI can write data-grounded narrative replies — *"the top failing user is `<redacted-4e4945f>` with 42 attempts; the failure mix is 21 Windows, 19 HANA, 7 SAP — Windows is the dominant stack but the spread suggests a coordinated probe rather than a single-source brute-force"*. The AI now grounds its severity assessments in actual numbers instead of inferring from row counts alone.

**Decision rule for picking Tier 2:**

- The customer's legal/security team has reviewed and approved exposing aggregate metadata (column cardinalities, top-N value distributions) to the AI vendor.
- The customer wants narrative replies with concrete values, not just shape descriptions.
- PII concerns are mitigated by the column-name-based redaction (or the customer is comfortable with the redaction's coverage).

**Audit trail for Tier 2:** every Tier 2 vendor call records a `vendor_tier2` audit event including:
- Token counts (input + output)
- USD cost estimate
- Number of PII redactions applied (`tier2RedactionsApplied`)
- The user identity that triggered the call

When elevating from Tier 1 → Tier 2 in Settings, a `vendor_tier2_elevation` audit event captures the admin's identity and timestamp. See [Audit Log](audit-log.md).

## :material-circle-box:{ .taiconcolor } How the Privacy Invariant Is Enforced

The privacy invariant — *no event data ever leaves the customer's environment for the AI vendor* — is enforced mechanically at build time via TypeScript brand types. Tool-result values from the MCP server carry one type; outbound vendor messages carry a different type; the compiler refuses to assign one to the other. The only conversion path produces a non-data summary, and the active privacy tier picks which summary shape is used.

This is the primary defense against [LLM02 — Sensitive Information Disclosure](owasp-llm-compliance.md). For the brand-type mechanism, summarizer call sites, and the `<TOOL_RESULT_DATA>` sentinel pattern, see [AI Assistant Implementation Reference](../developer/ai-assistant-internals.md).

## :material-circle-box:{ .taiconcolor } Switching Tiers

Tier is configured in [Settings → General](settings.md). Switching tiers takes effect on the **next** vendor call — in-flight calls complete with the previously active tier, and the audit event records which tier was active at dispatch time.

**Elevating from Tier 1 → Tier 2:**

1. Open Settings → AI Assistant → General.
2. Change the **Tier** field from 1 to 2.
3. Click Save Defaults. The save records a `vendor_tier2_elevation` audit event with admin identity + timestamp.
4. Optionally enable / disable PII redaction (default: enabled) and toggle hostname-as-PII (default: hostname NOT redacted, since it's often non-sensitive in SAP environments).

**Lowering from Tier 2 → Tier 1 / Tier 0:**

1. Same path. The save is recorded as a regular config change, no special audit event.
2. The next vendor call uses the lower tier.

**No tier:** if the customer wants to disable the LLM-driven path entirely (canned prompts only), use the [Templates-only build variant](templates-only-build.md) — the tier setting becomes moot since there are no vendor calls.

## :material-circle-box:{ .taiconcolor } Decision Matrix

| Question | Answer | Recommended tier |
|---|---|---|
| "Is the AI vendor a third-party data processor?" | Yes; consult your DPA. Anthropic / OpenAI / Azure / Bedrock all publish their own privacy commitments, but they ARE data processors. | Tier 1 if approved as processor; Tier 0 if not approved |
| "Can the customer's compliance team approve aggregate metadata exposure?" | Yes | Tier 2 |
| | No | Tier 1 |
| "Does the customer have outbound internet to the LLM vendor's API?" | Yes | Tier 1 or Tier 2 |
| | No (air-gapped) | Tier 0 (future) or [Templates-only Build](templates-only-build.md) |
| "Does the customer want narrative replies with concrete values, or shape-only?" | Concrete | Tier 2 (with PII redaction on) |
| | Shape-only | Tier 1 |
| "Does the customer want zero LLM dispatch (partner test, demo)?" | Zero | [Templates-only Build](templates-only-build.md) |
