# Security Architecture — SAIF Alignment

This page is for **customer security teams** evaluating the LogServ App's AI Assistant feature against Google's [Secure AI Framework (SAIF)](https://saif.google/). It complements the [OWASP LLM Top 10 Compliance](owasp-llm-compliance.md) page — same set of controls, organized along SAIF's four-pillar structure and mapped to SAIF's 15 Key Risks catalog.

!!! warning "Current release: LLM functionality intentionally disabled pending review"
    The current release ships with the LLM-driven path **disabled at compile time pending internal review**. The controls described on this page are designed, implemented, and exercised by the build's CI pipeline — but the LLM dispatch pathway itself is gated off via the [Templates-only build flag](templates-only-build.md) until the review concludes. The predefined-prompt path + Splunk MCP integration + audit log remain fully active. This page documents the security architecture so reviewers can evaluate the posture for a future release that re-enables the LLM path.

## :material-circle-box:{ .taiconcolor } The Privacy Boundary

The LogServ AI Assistant is designed around one flagship security property: **no event data from your Splunk indexes is ever transmitted to any AI vendor.** This isn't a policy commitment — it's enforced by the TypeScript type system at compile time.

- Tool results returned from Splunk via MCP are typed as `Hidden<T>`.
- The compiler refuses to put a `Hidden<T>` value into an outbound LLM payload.
- The only conversion path is `sanitize(hidden, summarizer)` — which forces the caller to supply a non-data summary string.
- There is no runtime flag, no policy toggle, no override.

What the AI sees:

| Privacy Tier | What's sent to the vendor LLM |
|---|---|
| **Tier 0** (Ollama, planned) | Nothing — fully on-host |
| **Tier 1** (default) | Tool execution metadata only: row count + timing. No values. |
| **Tier 2** (admin opt-in) | Tool result aggregated metadata: cardinality, top-N values + counts, numeric stats, time range. **Still no raw rows.** Plus PII redaction on identifier columns. |

Detail: [Privacy Tiers](privacy-tiers.md).

---

## :material-circle-box:{ .taiconcolor } SAIF Four-Pillar Mapping

Google's SAIF organizes AI security controls into four pillars. Here's how the LogServ AI Assistant maps to each.

### :material-database-eye-outline:{ .taiconcolor } Data

SAIF's Data pillar covers how AI systems handle training data, user data, and the data flowing between system boundaries.

**Training data — N/A.** The LogServ AI Assistant does not train, fine-tune, or update any model. It uses third-party LLMs (Anthropic, OpenAI, Azure OpenAI, AWS Bedrock) through their public APIs. The data-poisoning, unauthorized-training-data, and training-data-sanitization controls in SAIF apply to those vendors, not to LogServ.

**User Data Management — fully enforced.** The Privacy Boundary (above) is the core control:

- `Hidden<T>` type system blocks event data egress at compile time.
- Tier 1 (default) sends only count + timing.
- Tier 2 PII redaction hashes identifier columns (email, user, username, IP, MAC, account) using a per-value tag (`<redacted-XXXXXXX>`) so the LLM can still reason about cardinality without seeing the raw value. Hostname redaction is opt-in via Settings.
- Every elevation from Tier 0/1 → Tier 2 is recorded in the audit log with the admin's user identity, timestamp, and previous tier.

### :material-server-network:{ .taiconcolor } Model

SAIF's Model pillar covers model integrity, exfiltration risk, and supply chain.

**Model Source Tampering — partial coverage:**

- **Our supply chain:** every CI build runs a dependency audit at the `high` advisory level. A Software Bill of Materials (`SBOM.json`, CycloneDX 1.4) ships in every release with per-dependency `purl` + sha-512 hashes. The SBOM enumerates every bundled dependency.
- **Distribution integrity:** the released tarball is precert-validated by Splunkbase AppInspect before publication. The Splunk deployment server distributes the Data TA to Heavy Forwarders over Splunk's mutually-authenticated channel.
- **Vendor model weight integrity** is the LLM vendor's responsibility. The customer's DPA review should confirm vendor-side controls.

**Model Exfiltration — N/A.** The LogServ App does not host model weights. Cloud LLM models live in vendor infrastructure (Anthropic, OpenAI, Azure, Bedrock). Tier 0 Ollama (planned) would run on the customer's own host — model weights would be under the customer's existing storage controls.

**Model Reverse Engineering — N/A.** The LogServ App exposes a known vendor LLM behind a thin wrapper. The system primer is publishable (see the [free-form prompts documentation](free-form-prompts.md)) — there's no proprietary prompt engineering to reverse-engineer.

### :material-application-cog-outline:{ .taiconcolor } Application

SAIF's Application pillar covers input validation, access management, and output handling for the AI-using application.

**Input Validation — multi-layered:**

- **User-prompt anomaly detection.** Eight pattern groups (role redefinition, persona shift, system prompt leak, control tokens, long base64 blobs, system impersonation, tool extraction, excessive length) run on every user prompt before dispatch. **Flag-and-proceed semantics:** matches fire a `user_prompt_jailbreak_flag` audit event for SOC review but do not block the prompt — regex-based detection has false positives, and blocking would cripple legitimate investigative queries.
- **SPL static analysis on AI-authored queries.** Every `splunk_run_query` call from the AI runs through a guard that blocks forbidden operators (`collect`, `outputlookup`, `delete`, `sendalert`, `script`, etc.). Blocked queries surface as a `security_blocked_spl` audit event.
- **Tool-result sanitization.** AI-authored tool arguments are schema-validated. Tier 2 categorical aggregates pass through a per-value sanitizer that replaces strings matching known jailbreak idioms with `<filtered>`.
- **`<TOOL_RESULT_DATA>` sentinel block** wraps every tool-result summary the AI sees. The system primer instructs the AI to treat anything inside the sentinel as data from the customer's environment, never as instructions.

**Application Access Management:**

- **Per-user prompt rate limit** (configurable; default tunable in Settings) bounds free-form prompt volume per hour.
- **Per-user daily spend cap** (configurable; default `0` = no cap) bounds vendor cost per day. Tally resets at local midnight. Predefined-prompt executions don't accumulate against the cap.
- **Per-chat-session MCP tool-dispatch cap** is defense-in-depth above the per-message `MAX_TOOL_TURNS` limit. Prevents runaway tool-loops in adversarial automation.
- **Feature toggle.** The master `enabled` switch in Settings gates the entire feature; transitions from OFF to ON require admin acceptance of a liability acknowledgement modal (recorded with the admin's user identity, timestamp, disclaimer hash, and version per Splunk's standard opt-in pattern).

**Output Validation:**

- **The LLM's output is never executed.** Tool calls are schema-validated against a closed catalog of MCP tools. There is no `eval`-style path from LLM output to system action.
- **React rendering uses JSX text nodes**, not `dangerouslySetInnerHTML`. Strings are escaped by default. Citation markers, severity badges, and bold markdown are parsed via a controlled set of recognized patterns; no general-purpose HTML rendering.
- **Drill-down URLs** are built via a centralized `buildSplunkSearchUrl()` helper that uses `encodeURIComponent()` and applies `target="_blank" rel="noopener noreferrer"` flags to break reverse-tabnabbing attacks.

### :material-robot-outline:{ .taiconcolor } Agent

SAIF's Agent pillar — newer in SAIF 2.0 — covers autonomous agent behavior, permissions, user control, and observability.

**Agent Permissions — read-only.** The MCP tool catalog exposed to the AI is explicitly read-only:

- `splunk_run_query` — dispatches an arbitrary SPL query against the customer's data (subject to the static-analysis guard).
- `splunk_run_saved_search` — dispatches a vetted, named saved search from the App's intent map.

There are no destructive operations available to the AI: no event deletion, no config writes, no user creation, no permission changes, no outbound network actions of any kind beyond the LLM API call.

**Agent User Control:**

- **Tier selection** at install time (admin) — Tier 0 / 1 / 2.
- **Master enable toggle** — admin-controlled, default OFF.
- **Per-prompt opt-in** — every free-form prompt is user-initiated. There is no autonomous loop, no scheduled prompt execution, no background activity.
- **Power Mode** is opt-in per-prompt — a single forced-saved-search-first behavior available to designated power users, recorded in the audit log.
- **Acknowledgement modals** at Settings save time — admin must accept liability disclaimers for (a) enabling the feature, (b) tier elevations, (c) disabling the audit forwarder.

**Agent Observability:**

- **Hash-chained audit log.** Every meaningful AI Assistant event (canned prompt execution, free-form vendor call, blocked SPL, rate-limit hit, spend-cap hit, prompt anomaly, tier elevation, settings change) lands in the `logserv_ai_assistant_audit` index with a stable per-tab session ID + monotonic sequence number. The chat panel surfaces "AI is generating response" status; the [Audit Log viewer](audit-log.md) in Settings lets reviewers filter by category, user, and time range.
- **HEC audit forwarder.** Admin can configure a Splunk HEC destination (e.g., a separate indexer, a SIEM, S3-with-Object-Lock owned by a different admin team) for tamper-evident off-host audit copies. Forwarder failures themselves are recorded locally so an off-host divergence is detectable.
- **Vendor token-usage audit events** capture provider, model, input/output tokens, USD cost estimate (computed locally from list pricing), and turn count — letting SOC teams pivot on cost-anomaly indicators.

---

## :material-circle-box:{ .taiconcolor } SAIF 15 Key Risks — Coverage Matrix

The table below maps each SAIF Key Risk to LogServ's posture. **Strong** = flagship property of the architecture; **Partial** = mitigation in place with documented residual surface; **N/A** = out of scope because LogServ does not train or host models.

| # | SAIF Risk | LogServ Posture | Key Controls |
|---|---|---|---|
| 1 | Data Poisoning (DP) | N/A | LogServ does not train models. |
| 2 | Unauthorized Training Data (UTD) | N/A | LogServ does not train models. No event data ever leaves the privacy boundary. |
| 3 | Model Source Tampering (MST) | Partial | Dependency audit + SBOM. Splunkbase AppInspect precert on distribution. Model weight integrity is vendor responsibility. |
| 4 | Excessive Data Handling (EDH) | **Strong** | `Hidden<T>` privacy boundary, Tier 1 default, Tier 2 PII redaction. |
| 5 | Model Exfiltration (MXF) | N/A | LogServ does not host models. |
| 6 | Model Deployment Tampering (MDT) | Partial | Splunkbase precert + DS-channel distribution. Tarball GPG signing is a known gap. |
| 7 | Denial of ML Service (DMS) | Partial | Per-user prompt rate limit + per-user daily spend cap + per-session tool dispatch cap. |
| 8 | Model Reverse Engineering (MRE) | N/A | Publishable system primer, no proprietary prompt engineering. |
| 9 | Insecure Integrated Component (IIC) | **Strong** | Read-only tool catalog, schema-validated tool calls, SPL static-analysis guard. |
| 10 | Prompt Injection (PIJ) | Partial | Tool-result vector physically blocked by `Hidden<T>` + sentinel + per-value sanitizer. User-prompt vector flagged (8 pattern groups), not blocked. |
| 11 | Model Evasion (MEV) | N/A | LogServ has no classifiers to evade; ML-evasion is vendor-side. |
| 12 | Sensitive Data Disclosure (SDD) | **Strong** | Same controls as EDH (privacy boundary + redaction). |
| 13 | Inferred Sensitive Data (ISD) | Partial | Strong by construction (Tier 1 = no values; Tier 2 = redacted aggregates). Hostname redaction is opt-in — small inference surface for environment topology when off. |
| 14 | Insecure Model Output (IMO) | **Strong** | LLM output never executed; no `dangerouslySetInnerHTML`; drill-down URLs encoded + tab-nabbing flags. |
| 15 | Rogue Actions (RA) | **Strong** | Read-only tool surface, no autonomous loop, hash-chained audit log + off-host forwarder. |

**Summary:** 5 Strong, 5 Partial, 5 N/A. Zero "Not covered" — every SAIF risk in scope for LogServ's architecture has at least partial mitigation.

---

## :material-circle-box:{ .taiconcolor } Cross-Reference: SAIF ↔ OWASP LLM Top 10

The [OWASP LLM Top 10 Compliance](owasp-llm-compliance.md) page covers the same controls organized by attack pattern instead of structural pillar. Most LogServ controls map to both frameworks:

| SAIF Risk | OWASP LLM Item |
|---|---|
| EDH / SDD / ISD | LLM02 — Sensitive Information Disclosure |
| MST | LLM03 — Supply Chain |
| DP / UTD (N/A here) | LLM04 — Data and Model Poisoning |
| IMO | LLM05 — Improper Output Handling |
| IIC / RA | LLM06 — Excessive Agency |
| PIJ | LLM01 — Prompt Injection |
| MEV (N/A here) | LLM07 — System Prompt Leakage (related) |
| DMS | LLM10 — Unbounded Consumption |

---

## :material-circle-box:{ .taiconcolor } What's Out of Scope

Items in SAIF that don't apply to LogServ's architecture:

- **Model training, fine-tuning, RAG with embedded sensitive data** — the AI Assistant does not train, fine-tune, embed, or persist any customer data into any model.
- **Vendor model integrity and vendor data handling** — these are the LLM vendor's responsibility. Anthropic, OpenAI, Azure OpenAI, and AWS Bedrock each publish their own data-usage commitments and security posture; the customer's DPA review should confirm processor obligations.
- **Customer Splunk infrastructure security** — Splunk's own access controls, role-based ACLs, and indexer encryption apply normally. The AI Assistant inherits the security posture the customer has configured for Splunk Web access.

---

## :material-circle-box:{ .taiconcolor } Known Residual Gaps

Honesty matters in a security architecture page. The following gaps are documented:

1. **User-prompt jailbreak detection is flag-and-proceed, not block.** Regex pattern matching has false positives. Pattern coverage will grow as new attack patterns surface in the wild. The flag-and-proceed posture lets SOC teams review while preserving legitimate investigative use.
2. **Hostname redaction at Tier 2 is opt-in (default off).** Hostname patterns can leak environment topology. Admins can flip the default in Settings if their threat model requires it.
3. **Tarball GPG signing is not yet implemented.** Splunkbase AppInspect precert + DS-channel distribution cover most of the threat model, but a signed tarball would provide an additional integrity proof point. Tracked as a follow-up item.

---

## :material-circle-box:{ .taiconcolor } What Customers Can Do

Concrete actions a customer's security team can take to validate or strengthen the posture:

- **Review the audit log regularly.** Navigate to AI Assistant → Settings → Audit Log. Filter by category to investigate anomalies. Categories worth scheduled review: `user_prompt_jailbreak_flag`, `security_blocked_spl`, `rate_limited_prompt`, `daily_spend_cap_hit`, `vendor_tier2_elevation`.
- **Configure the HEC audit forwarder** to a separate destination — a different Splunk indexer, a SIEM, an S3 bucket with Object Lock, or any HEC-compatible sink. The acceptance modal recorded when the forwarder is left disabled is a useful compliance artifact.
- **Pick the tier that matches your risk appetite.** Tier 1 is the safest default (count + timing only). Tier 2 is more powerful but ships aggregated metadata to the vendor. Tier 0 (Ollama, planned) eliminates the vendor egress entirely.
- **Set the daily spend cap** to a number that bounds your monthly liability. The cap can be raised or removed at any time via Settings.
- **Validate the SBOM** against your organization's vulnerability scanning. The `SBOM.json` ships at the root of the App tarball.

---

## :material-circle-box:{ .taiconcolor } Further Reading

- [OWASP LLM Top 10 Compliance](owasp-llm-compliance.md) — same controls organized by attack pattern
- [Privacy Tiers](privacy-tiers.md) — the type-system privacy boundary explained
- [Settings](settings.md) — admin-controlled toggles and configuration
- [Audit Log](audit-log.md) — viewer + filter conventions + tamper-evidence model
- [Free-Form Prompts](free-form-prompts.md) — system primer + tool catalog
- [Templates-only Build Flag](templates-only-build.md) — the current LLM-disabled gating mechanism
- Google's [Secure AI Framework (SAIF)](https://saif.google/) — the external reference framework this page maps against
