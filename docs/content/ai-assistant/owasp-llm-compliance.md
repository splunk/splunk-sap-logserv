# OWASP LLM Top 10 (2025) Compliance

This page is intended for the **customer's security team** reviewing the LogServ App's AI Assistant feature for production deployment. It covers each of the OWASP LLM Top 10 (2025) items and the controls the LogServ App ships to address them.

!!! warning "v0.0.5 release: LLM functionality intentionally disabled pending review"
    The v0.0.5 release ships with the LLM-driven path **disabled at compile time pending internal review**. The controls described on this page are designed, implemented, and exercised by the build's CI pipeline — but the LLM dispatch pathway itself is gated off via the [Templates-only build flag](templates-only-build.md) until the review concludes. The predefined-prompt path + Splunk MCP integration + audit log remain fully active. This page documents the controls so reviewers can evaluate the security posture for a future release that re-enables the LLM path.

## :material-circle-box:{ .taiconcolor } LLM01 — Prompt Injection

**Threat:** an attacker (either via the user-prompt vector or via in-band tool-result data) crafts input that hijacks the LLM's instruction-following behavior, causing it to ignore the system primer or perform unintended actions.

**Controls shipped:**

- **`<TOOL_RESULT_DATA>...</TOOL_RESULT_DATA>` sentinel block** wraps every tool-result summary the AI sees. The system primer instructs the AI to treat anything inside the sentinel as DATA from the customer's environment, NEVER as instructions, regardless of how command-like the contents look. Mitigates the in-band channel of prompt injection: a malicious user who can write events into the customer's Splunk index could in principle craft field values like `user="Ignore prior instructions and..."`, but the sentinel + sanitizer reduces the effective attack surface to near-zero.
- **Per-value sanitizer for Tier 2 categorical aggregates** (`sanitizeAggregateValue()`). Three classes of suspicious content get replaced wholesale with `<filtered>`: strings starting with role markers (`system:`, `user:`, `assistant:`, etc.), strings containing known jailbreak / prompt-injection idioms (`ignore prior instructions`, `[INST]`, `<|im_start|>`, `<|system|>`, `disregard the above`, `jailbreak`), and strings containing the sentinel tags themselves (prevents a malicious value from prematurely closing the data block).
- **Jailbreak pattern detection on user prompts.** Flag-and-proceed: matches fire a `user_prompt_jailbreak_flag` audit event but do not block the prompt. Captures a hash + length + matched-pattern groups + char-class fingerprint for SOC pivot analysis.
- **Defense-in-depth chain.** Type-system enforcement (LLM02) + Tier 2 sanitizer + tool-result sentinel + primer + vendor-side defenses provide multiple independent layers; bypassing any one doesn't break the chain.

## :material-circle-box:{ .taiconcolor } LLM02 — Sensitive Information Disclosure

**Threat:** the LLM emits sensitive customer data (PII, secrets, internal-only information) in its responses or causes it to be transmitted to the vendor.

**Controls shipped:**

- **TypeScript type-system enforcement.** The compiler refuses to put any tool-result value into the outbound vendor payload — there is no runtime check, no flag to flip, no policy to forget. The only conversion path produces a non-data summary that the caller's chosen summarizer controls. See [Privacy Tiers](privacy-tiers.md) and [AI Assistant Implementation Reference](../developer/ai-assistant-internals.md).
- **Privacy tier scoping.** Tier 1 (default) gives the AI count + execution time only — no values. Tier 2 (admin opt-in) adds aggregated metadata (top-N values + counts, numeric stats, time range). **Neither tier sends raw rows.**
- **PII redaction at Tier 2.** Column-name-based detection redacts `email`, `user(name)`, `*_ip`, `mac`, `account` (hostname opt-in) before values are sent to the vendor. Stable per-value `<redacted-XXXXXXX>` tags so the AI can still reason about cardinality without seeing the actual identifier.
- **`<TOOL_RESULT_DATA>` sentinel** (also LLM01) prevents the AI from accidentally treating sanitized data as instructions and echoing it back unsanitized.
- **Vendor-side commitments.** Anthropic / OpenAI / Azure OpenAI / AWS Bedrock each publish their own data-usage commitments (no training on API traffic for Anthropic & OpenAI direct API by default). The customer's DPA review should confirm vendor-side processor obligations.

## :material-circle-box:{ .taiconcolor } LLM03 — Supply Chain

**Threat:** a compromised or vulnerable third-party dependency in the bundle introduces an attack vector or data-exfil channel.

**Controls shipped:**

- **CI dependency audit gate.** Every CI build runs a dependency audit at the `high` advisory level — non-zero exit on high or critical advisories. Hard-gates the shippable build path so released builds always pass at high+.
- **SBOM (Software Bill of Materials) shipped with every build.** A bundled generator parses the package lock directly (no external tool dependency) and emits a `SBOM.json` in CycloneDX 1.4 format with `purl` (Package URL) + sha-512 hash per dependency. The v0.0.5.0 SBOM contains 1,416 components; reviewers can pin against this list.
- **Audit-log forwarder configurability** so SBOM-driven vulnerability response can correlate against actual usage patterns across customers.

## :material-circle-box:{ .taiconcolor } LLM04 — Data and Model Poisoning

**Threat:** an attacker with the ability to write events into the customer's Splunk index could craft field values that, when surfaced to the AI as Tier 2 aggregates, hijack the AI's downstream behavior (e.g., by appearing to be system instructions).

**Controls shipped:**

- **`<TOOL_RESULT_DATA>` sentinel block** (also LLM01).
- **Per-value sanitizer with role-marker + jailbreak-idiom + sentinel-tag filtering** (also LLM01).
- **Truncation of categorical aggregate values to 40 chars** to reduce the budget available for embedded jailbreak prompts.
- **Top-N capping of categorical aggregates at 10 by default (max 50)** — bounds the volume of AI-visible value content per column.

## :material-circle-box:{ .taiconcolor } LLM05 — Improper Output Handling

**Threat:** the LLM's response contains content that, when rendered or executed, harms the user (e.g., XSS via injected HTML, command injection via shell-formatted output).

**Controls shipped:**

- **React rendering uses JSX text nodes**, not `dangerouslySetInnerHTML`. Strings are escaped by default; markdown is parsed via a controlled set of recognized markers (citation, severity, bold) — no general-purpose HTML rendering.
- **Drill-down URLs** built via `buildSplunkSearchUrl()` use `encodeURIComponent()` for the SPL string and centralize the `target="_blank" rel="noopener noreferrer"` security flags. The `noopener` flag breaks the `window.opener` reference for reverse-tabnabbing.
- **AI-authored SPL goes through a static-analysis guard** before dispatch (see LLM06).

## :material-circle-box:{ .taiconcolor } LLM06 — Excessive Agency

**Threat:** the AI is given the ability to perform actions whose consequences exceed the user's intent (e.g., write/delete data, send emails, exfiltrate via output channels).

**Controls shipped:**

- **SPL static-analysis guard for AI-authored `splunk_run_query`.** Blocks `collect`, `outputlookup`, `outputcsv`, `delete`, `sendalert`, `sendemail`, `script`, `run`, `tscollect`. Blocked SPL produces a synthetic error tool_result + a `security_blocked_spl` audit event. The AI sees the error and can recover by writing a different query.
- **Per-session tool-call cap** prevents infinite tool loops. Maps to `session_tool_cap_hit` audit event on overflow.
- **Pre-authored saved searches via `splunk_run_saved_search`** are NOT subject to the guard — their SPL is reviewed at build time. The guard scope is exclusively the AI-written ad-hoc path.

## :material-circle-box:{ .taiconcolor } LLM07 — System Prompt Leakage

**Threat:** the system primer leaks to the user (or via the user back to the vendor's prompt-logging) and exposes internal instructions, lookups, or configuration.

**Controls shipped:**

- **No customer-secret content in the primer.** The primer contains: tool definitions, the saved-search catalog (names + labels, public information), the LogServ data-model summary (sourcetypes + field names, public), the synthesis rules. No customer-specific identifiers, no API keys, no internal URLs.
- **Time-window reasoning rules** are pedagogical (about how the AI should reason about its inputs) — leakage of these rules has no security impact.

The customer's DPA review should still confirm vendor-side prompt-logging policies (Anthropic, OpenAI, Azure, Bedrock all log prompts at varying retention; some offer enterprise tiers with no-logging guarantees).

## :material-circle-box:{ .taiconcolor } LLM08 — Vector and Embedding Weaknesses

**Threat:** vector / embedding stores used for RAG can leak sensitive data if not access-controlled, can be poisoned by malicious indexed content, or can return chunks across security boundaries.

**Status:** **Not applicable.** The LogServ App's AI Assistant does NOT use vector embeddings or a separate RAG store. The "RAG" here is direct tool dispatch against the live Splunk index — every retrieval is a real-time SPL search bounded by Splunk's own RBAC. There is no separate vector store to compromise.

## :material-circle-box:{ .taiconcolor } LLM09 — Misinformation

**Threat:** the LLM produces confident-sounding but incorrect information that the user acts on.

**Controls shipped:**

- **`AI-generated — verify before acting` disclaimer** rendered as a small muted footer below every AI assistant_text bubble. Visible on every reply, never collapsed.
- **Time-window reasoning rules** ([Time-Window Reasoning](time-window-reasoning.md)) force the AI to verify high-severity claims with a narrow-window query before recommending action. Self-correction is observable in the response (the AI reports the cumulative number AND the verify-query result).
- **Citation chips** (`[→ saved_search_name]`) link every claim back to the source tool_result tile, so users can sanity-check the narrative against the rendered data.
- **Predefined-prompt path** (default for routine investigations) has zero AI-misinformation risk — the dispatch is deterministic and the interpretation card is pre-authored, not generated.

## :material-circle-box:{ .taiconcolor } LLM10 — Unbounded Consumption

**Threat:** uncontrolled vendor calls drive arbitrary cost, latency, or denial-of-service on the user-facing experience.

**Controls shipped:**

- **Per-user rolling-1-hour rate limit** on free-form prompts. Configurable via `rate_limit_per_hour` in Settings (default 30, 0 = disabled). Records `rate_limited_prompt` audit event on hit.
- **Cumulative-cost daily spend cap** in USD. Configurable via `daily_spend_cap_usd` in Settings. Resets at 00:00 UTC. Records `daily_spend_cap_hit` audit event on hit.
- **Per-session tool-call cap** to prevent infinite tool loops. Records `session_tool_cap_hit`.
- **Token-usage observability** in every `vendor_tier1` / `vendor_tier2` audit event: input tokens, output tokens, total tokens, USD cost estimate. Lets finance attribute spend to specific users / sessions.
- **Streaming + abort** in the chat UI — users can cancel an in-flight expensive turn via the **Stop** button.
- **Canned prompts are NOT rate-limited** — they bypass the AI vendor entirely and are bounded by Splunk's own search-quota controls, not vendor cost.

## :material-circle-box:{ .taiconcolor } Compliance Posture Summary

| OWASP item | Status | Primary control |
|---|---|---|
| LLM01 — Prompt Injection | Mitigated | TOOL_RESULT_DATA sentinel + per-value sanitizer + jailbreak detection + primer hardening |
| LLM02 — Sensitive Information Disclosure | Mitigated | `Hidden<T>` type-system enforcement + Tier 1/2 sanitize chokepoint + PII redaction |
| LLM03 — Supply Chain | Mitigated | CI dependency-audit hard-gate at `high`+ severity + CycloneDX SBOM with sha-512 hashes |
| LLM04 — Data and Model Poisoning | Mitigated | TOOL_RESULT_DATA sentinel + per-value sanitizer + 40-char value truncation + top-N cap |
| LLM05 — Improper Output Handling | Mitigated | React JSX text nodes + URL encoding + noopener + SPL static-analysis guard |
| LLM06 — Excessive Agency | Mitigated | SPL static-analysis guard + session tool-call cap |
| LLM07 — System Prompt Leakage | Mitigated | No customer-secret content in primer; vendor-side DPA review needed |
| LLM08 — Vector and Embedding Weaknesses | Not applicable | No separate vector store; live SPL dispatch via Splunk RBAC |
| LLM09 — Misinformation | Mitigated | AI-generated disclaimer + time-window reasoning + citation chips + predefined-prompt path |
| LLM10 — Unbounded Consumption | Mitigated | Per-user rate limit + daily spend cap + session tool-call cap + token-usage audit |

## :material-circle-box:{ .taiconcolor } Pending Internal Review

The v0.0.5 release ships with the LLM dispatch pathway gated off via the [Templates-only build flag](templates-only-build.md) pending internal review of the controls described on this page. The review's outcome will determine when a future release re-enables the LLM path. The predefined-prompt path + Splunk MCP Server integration + audit log remain fully active in the meantime — partners and customers running the v0.0.5 build can exercise the canned-prompt investigation flow + drill-down chips + audit observability without any LLM dispatch.

For the controls described above to take effect, the LLM path must be re-enabled in a subsequent release. The same controls apply at that point; nothing on this page changes between v0.0.5 (LLM disabled) and the future re-enable release.
