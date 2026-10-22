# OWASP LLM Top 10 (2025) Compliance

This page is intended for the **customer's security team** reviewing the LogServ App's AI Assistant feature for production deployment. It covers each of the OWASP LLM Top 10 (2025) items and the controls the LogServ App ships to address them.

!!! tip "Companion page"
    For the same controls organized along Google's [Secure AI Framework (SAIF)](https://saif.google/) four-pillar structure plus a coverage matrix of SAIF's 15 Key Risks, see [SAIF Security Architecture](security-architecture.md).

!!! info "These controls govern the path an LLM provider credential unlocks"
    The published v0.1.2 App package is the **full-LLM build variant**, so the controls below (prompt-injection sanitization, the type-system data boundary, tier-gated summaries, SPL static analysis, rate limits, spend caps) actively govern it once an admin configures an [LLM provider credential](settings.md#provider-credentials-tab). Until a credential exists — and wherever **Templates-only mode** is on or a compile-time [templates-only build](templates-only-build.md) is installed — there is no vendor dispatch at all, which is the strongest form of each LLM-specific control. The tamper-evident audit trail and the supply-chain controls are live either way.

## :material-circle-box:{ .taiconcolor } LLM01 — Prompt Injection

**Threat:** an attacker (either via the user-prompt vector or via in-band tool-result data) crafts input that hijacks the LLM's instruction-following behavior, causing it to ignore the system primer or perform unintended actions.

**Controls shipped:**

- **`<TOOL_RESULT_DATA>...</TOOL_RESULT_DATA>` sentinel block** wraps every tool-result summary the AI sees. The system primer instructs the AI to treat anything inside the sentinel as DATA from the customer's environment, NEVER as instructions, regardless of how command-like the contents look. Mitigates the in-band channel of prompt injection: a malicious user who can write events into the customer's Splunk index could in principle craft field values like `user="Ignore prior instructions and..."`, but the sentinel + sanitizer reduces the effective attack surface to near-zero.
- **Per-value sanitizer for Tier 2 categorical aggregates** (`sanitizeAggregateValue()`). Three classes of suspicious content get replaced wholesale with `<filtered>`: strings starting with role markers (`system:`, `user:`, `assistant:`, etc.), strings containing known jailbreak / prompt-injection idioms (`ignore prior instructions`, `[INST]`, `<|im_start|>`, `<|system|>`, `disregard the above`, `jailbreak`), and strings containing the sentinel tags themselves (prevents a malicious value from prematurely closing the data block).
- **No error text in the tool-result channel.** A failed tool call reaches the AI only as a fixed, App-written string built from its HTTP status and an error class. Splunk's or the MCP server's error message, which repeats the failed search and so can carry text an attacker wrote into an event, is never sent (before build 376, up to 200 characters of it were). See [Privacy Tiers → Failed Tool Calls](privacy-tiers.md#failed-tool-calls-every-tier).
- **Jailbreak pattern detection on user prompts.** Flag-and-proceed: matches fire a `user_prompt_jailbreak_flag` audit event but do not block the prompt. Captures a hash + length + matched-pattern groups + char-class fingerprint for SOC pivot analysis.
- **Defense-in-depth chain.** Type-system enforcement (LLM02) + Tier 2 sanitizer + tool-result sentinel + primer + vendor-side defenses provide multiple independent layers; bypassing any one doesn't break the chain.

## :material-circle-box:{ .taiconcolor } LLM02 — Sensitive Information Disclosure

**Threat:** the LLM emits sensitive customer data (PII, secrets, internal-only information) in its responses or causes it to be transmitted to the vendor.

**Controls shipped:**

- **TypeScript type-system enforcement, plus a runtime scan.** The compiler refuses to put any tool-result value into the outbound vendor payload; the only conversion path is the summary that the active tier's summarizer produces. As a second layer, every outbound payload is serialized and scanned at dispatch time and rejected if a Splunk data field name appears as a key; the scan checks the payload's structure, not the text of a summary, so what a summary may say is set by the tier rules below. See [Privacy Tiers](privacy-tiers.md) and [AI Assistant Implementation Reference](../developer/ai-assistant-internals.md).
- **Privacy tier scoping.** Tier 1 (default) gives the AI two numbers per call, a count and a timing — no values. Tier 2 (admin opt-in) adds aggregated metadata: top-N values + counts (field values from the events — filtered, 40 characters each, and with PII redaction on sent in clear only when the App can trace the column to a field that marks no identifier), numeric stats, column names only when Splunk generates them or every word in them was written by the model in its own query or by the App's catalog search that ran (any other name appears as `col_N`), and the time range only as UTC timestamps the App formats. **Neither tier sends raw rows.** Tier 1 limits how much the AI can learn rather than making it zero: for each call it sends a count and a timing, and for a failed call a fixed error class and the HTTP status. A model that writes its own queries can make these depend on event data, so a few bits per call can leak (up to about log2 of the largest row count the server returns through the count, which is the number of result rows whenever the App recognises them). The session tool-call cap (default 100) limits the calls per chat session; clearing the chat resets it, and `0` turns it off. No error text is sent in any tier.
- **No error text to the vendor, in any tier (build 376).** A failed tool call reaches the AI only as `Tool error (HTTP <status>, class=<class>): <fixed hint> The error text is shown to the user only.` — the status only when it is a whole number from 100 to 599, the class one of ten fixed names chosen in the browser. Before build 376, up to 200 characters of the Splunk or MCP Server error text went to the vendor, and a subsearch such as `| inputlookup [search … | eval v=substr(_raw,1,80) | return $v]` could put event text into it. The full error stays in the user's result panel. Refusals the App makes itself (the SPL guard, the saved-search catalog, an undeclared tool, the session tool-call cap) reach the AI as `Tool call refused by the App before it ran: <reason>`; the reason is App-written text, built where the App makes the refusal and never from a tool result.
- **PII redaction at Tier 2.** Every field the App defines has a class in a table the build checks (identifier, address, host, free text, safe), and field-name patterns cover every other name: `email(s)`, `user(name)(s)` and `user_name`, every `*_ip`, `*_addr`, `*_address` and a bare `ip`, the CIM `src`, `dest`, `dst` and `dvc`, `peer`, `mac`, `account`, camelCase `…User` / `…UserName` / `…Email` (`TargetUserName`), id names such as `user_id` (hostname opt-in) — also after `.`, `:`, `-` or a space, so data-model and JSON names such as `Authentication.user`, `All_Traffic.src_ip` and `event.user` and display names such as `"User Name"` match — before values are sent to the vendor. Per-value `<redacted-XXXXXXX>` tags — an HMAC-SHA-256 under a random per-chat-session key — let the AI reason about cardinality without seeing the actual identifier; they cannot be reversed by hashing candidates or linked across sessions. Redaction fails closed: a text column's values are sent in clear only when the App traces the column through constructs it reads in full — the field's own name, a statistics function over one field (`values(user)` → `user`), `AS`, a `rename` without wildcards, `lookup … OUTPUT … AS`, `eval x=<one field>` or a count — to fields that mark no identifier. Every other construct — an `eval` expression (`.` concatenation, functions), `rex`, `spath`, `strcat`, wildcard renames, a pivot's cells, `transpose` / `untable` / `fieldsummary`, a column a subsearch defines, an unknown command, or a reading limit exceeded — leaves the column untraced and every value redacted; a pure count (`dc(user)`) keeps its numbers. While redaction is on, every value of a text column shown as `col_N` is redacted, and a numeric column whose name or a field it reads marks an identifier, or that mixes many fields, sends `values withheld`. Column names are withheld whatever the setting unless Splunk generates them or the model's query or the App's catalog search wrote every word of them. Redaction is name-based: a traced field named nothing like an identifier (an event field such as `message`, `_raw` under an `eval` alias) is sent as it is (see [Security Architecture](security-architecture.md#known-residual-gaps), gaps 10 and 11).
- **`<TOOL_RESULT_DATA>` sentinel** (also LLM01) prevents the AI from accidentally treating sanitized data as instructions and echoing it back unsanitized.
- **Vendor-side commitments.** Anthropic / OpenAI / Azure OpenAI / AWS Bedrock each publish their own data-usage commitments (no training on API traffic for Anthropic & OpenAI direct API by default). The customer's DPA review should confirm vendor-side processor obligations.

## :material-circle-box:{ .taiconcolor } LLM03 — Supply Chain

**Threat:** a compromised or vulnerable third-party dependency in the bundle introduces an attack vector or data-exfil channel.

**Controls shipped:**

- **CI dependency audit gate.** Every CI build runs a dependency audit at the `high` advisory level — non-zero exit on high or critical advisories. Hard-gates the shippable build path so released builds always pass at high+.
- **SBOM (Software Bill of Materials) shipped with every build.** A bundled generator parses the package lock directly (no external tool dependency) and emits a `SBOM.json` in CycloneDX 1.4 format with `purl` (Package URL) + sha-512 hash per dependency. The SBOM enumerates every bundled dependency; reviewers can pin against this list.
- **Audit-log forwarder configurability** so SBOM-driven vulnerability response can correlate against actual usage patterns across customers.

## :material-circle-box:{ .taiconcolor } LLM04 — Data and Model Poisoning

**Threat:** an attacker with the ability to write events into the customer's Splunk index could craft field values that, when surfaced to the AI as Tier 2 aggregates, hijack the AI's downstream behavior (e.g., by appearing to be system instructions).

**Controls shipped:**

- **`<TOOL_RESULT_DATA>` sentinel block** (also LLM01).
- **Per-value sanitizer with role-marker + jailbreak-idiom + sentinel-tag filtering** (also LLM01).
- **Fixed error strings** (also LLM01, LLM02). A failed call's error text, which can repeat values from the index, is not sent to the AI; it gets a fixed status-and-class string instead.
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

- **Saved-search allow-list for `splunk_run_saved_search`.** The AI can run only the saved searches in the App's own prompt catalog, built from the App's intent map — never a rollup aggregation, retention, backfill or Enterprise Security feed. The check runs where every saved-search call is sent to the MCP Server, for predefined prompts and free-form calls alike. A name the AI asks for that is not in the catalog is refused before dispatch, with a synthetic error tool_result and a `security_blocked_spl` audit event; predefined prompts take their names from the catalog itself, and a build gate checks that every one of them is allowed. The list is a copy of the catalog's names taken when the App loads, and no code in the App can add to it while it runs. The App builds the MCP arguments itself (the vetted name, the App — `app` = `splunk_app_sap_logserv` — and the time range) instead of forwarding the model's, and refuses any tool name other than the two it defines, with a `security_blocked_spl` audit event as well.
- **SPL guard for AI-authored `splunk_run_query`: a denylist, an allow-list and Splunk's parser.** The first fence is a denylist of known risky commands. At the start of the query, after a `|` or after a `[` — outside quoted strings, and also when double or single quotes are written into the command word, as in `| "delete"` or `| de'lete'` — it refuses the commands that write to an index (`collect` and its aliases `stash`, `summaryindex` and `sumindex`, `mcollect`, `meventcollect`), write lookups, files or other output (`outputlookup`, `outputcsv`, `outputtext`, `dump`, `tscollect`, `createrss`), delete events (`delete`), trigger alerts or email (`sendalert`, `sendemail`), run scripts (`script` and its alias `run`, `runshellscript`), read REST endpoints (`rest`, which returns stored credentials decrypted from `storage/passwords`) or send data out (`outputtelemetry`, and the third-party `curl`, `wget` and `sendresults`); the Machine Learning Toolkit's `ai` (it sends the rows to an LLM, which the App's no-event-data-to-a-vendor rule forbids) and `deletemodel`; and the commands that run another search (`map`, and `savedsearch`'s aliases `macro` and `savedsplunk`). It refuses `savedsearch` and `savedsplunk` as words anywhere, quoted text included; the external lookup `dnslookup` anywhere (each row becomes a DNS query to an outside name server); a `fit` command followed anywhere later in the query by the word `into` (`fit ... into` saves a model) — each of these also when quotes split it (`| "saved"search X`, `| lookup "dns"lookup`, `| fit X "in"to m`), since the guard assumes the worst where Splunk's reading of quotes is uncertain; and an SPL inline comment, an unmatched backtick, a double quote that is never closed, a backslash-escaped double quote outside a quoted string, and any macro other than the App's own, because a comment, ambiguous quoting or another macro could hide a command from the check. The second fence is an allow-list read by a strict lexer: only the App's list of read-only analytic commands (`search`, `where`, `eval`, `stats`, `tstats`, `timechart`, `lookup`, `inputlookup`, `append`, `join`, `appendpipe` and the rest the primer lists; not `union`, which Splunk's parser rewrites before it runs — `append` combines searches instead), only the LogServ index (no `index` term, no `OR` next to the index macro), only the App's own lookups, subsearches only where they cannot widen the search — so other apps' custom commands and external lookups are refused too. Then Splunk's own search parser reads the query and the App refuses it when the two readings differ (a query that starts with an index macro the user's context shadows included) or when the parser cannot be asked (fail closed). Blocked SPL produces a synthetic error tool_result + a `security_blocked_spl` audit event. The AI is told `Tool call refused by the App before it ran:` followed by the guard's reason — App-written text, so it may be passed on — and can recover by writing a different query.
- **Per-session tool-call cap** prevents infinite tool loops. Maps to `session_tool_cap_hit` audit event on overflow.
- **Catalog saved searches are not run through the SPL guard** — their SPL is reviewed at build time, and none of their searches contains a writing command. The guard scope is the AI-written ad-hoc path.
- **Scope.** These controls protect this App's AI Assistant. Other MCP clients holding a Splunk MCP Server token are governed by the Splunk MCP Server's own controls and by Splunk permissions.

## :material-circle-box:{ .taiconcolor } LLM07 — System Prompt Leakage

**Threat:** the system primer leaks to the user (or via the user back to the vendor's prompt-logging) and exposes internal instructions, lookups, or configuration.

**Controls shipped:**

- **No customer-secret content in the primer.** The primer contains: tool definitions, the saved-search catalog (names + labels, public information), the LogServ data-model summary (sourcetypes + field names, public), the synthesis rules. No customer-specific identifiers, no API keys, no internal URLs.
- **Time-window reasoning rules** are pedagogical (about how the AI should reason about its inputs) — leakage of these rules has no security impact.

The customer's DPA review should still confirm vendor-side prompt-logging policies (Anthropic, OpenAI, Azure, Bedrock all log prompts at varying retention; some offer enterprise tiers with no-logging guarantees).

## :material-circle-box:{ .taiconcolor } LLM08 — Vector and Embedding Weaknesses

**Threat:** vector / embedding stores used for RAG can leak sensitive data if not access-controlled, can be poisoned by malicious indexed content, or can return chunks across security boundaries.

**Status:** **Not applicable.** The LogServ App's AI Assistant does NOT use vector embeddings or a separate RAG store. The "RAG" here is direct tool dispatch against the customer's own Splunk index — every retrieval is an SPL search bounded by Splunk's own RBAC (either a live event search or a read of one of the app's own access-controlled KV-Store rollups; neither is an embedding store). There is no vector store to compromise.

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
- **Cumulative-cost daily spend cap** in USD. Configurable via `daily_spend_cap_usd` in Settings. Resets at local midnight (the browser's calendar day). Records `daily_spend_cap_hit` audit event on hit.
- **Per-session tool-call cap** to prevent infinite tool loops. Records `session_tool_cap_hit`.
- **Token-usage observability** in every `vendor_tier1` audit event (emitted for every vendor call regardless of tier): input tokens, output tokens, total tokens, USD cost estimate. Lets finance attribute spend to specific users / sessions. The estimate uses an exact-id price table, which covers the Claude 5.x models at Anthropic's published first-party rates (cache reads and writes included); an unpriced model reports $0 and does not count toward the daily spend cap.
- **Streaming + abort** in the chat UI — users can cancel an in-flight expensive turn via the **Stop** button.
- **Canned prompts are NOT rate-limited** — they bypass the AI vendor entirely and are bounded by Splunk's own search-quota controls, not vendor cost.

Enforcement of the rate limit and the spend cap is browser-side (`localStorage` keyed by Splunk username), so the caps bound good-faith use rather than a determined user with a second browser or cleared site data; every block still emits an audit event, which is the durable control. The session tool-call cap is likewise in-memory per tab. Server-side enforcement is a tracked follow-up.

## :material-circle-box:{ .taiconcolor } Compliance Posture Summary

| OWASP item | Status | Primary control |
|---|---|---|
| LLM01 — Prompt Injection | Mitigated | TOOL_RESULT_DATA sentinel + per-value sanitizer + jailbreak detection + primer hardening |
| LLM02 — Sensitive Information Disclosure | Mitigated | `Hidden<T>` type-system enforcement + Tier 1/2 sanitize chokepoint + fixed error strings (no error text to the vendor) + PII redaction |
| LLM03 — Supply Chain | Mitigated | CI dependency-audit hard-gate at `high`+ severity + CycloneDX SBOM with sha-512 hashes |
| LLM04 — Data and Model Poisoning | Mitigated | TOOL_RESULT_DATA sentinel + per-value sanitizer + 40-char value truncation + top-N cap |
| LLM05 — Improper Output Handling | Mitigated | React JSX text nodes + URL encoding + noopener + SPL static-analysis guard |
| LLM06 — Excessive Agency | Mitigated | Saved-search allow-list (the App's prompt catalog) + SPL guard (denylist, command / data-scope / lookup allow-list, search-parser cross-check) + session tool-call cap |
| LLM07 — System Prompt Leakage | Mitigated | No customer-secret content in primer; vendor-side DPA review needed |
| LLM08 — Vector and Embedding Weaknesses | Not applicable | No separate vector store; live SPL dispatch via Splunk RBAC |
| LLM09 — Misinformation | Mitigated | AI-generated disclaimer + time-window reasoning + citation chips + predefined-prompt path |
| LLM10 — Unbounded Consumption | Mitigated | Per-user rate limit + daily spend cap + session tool-call cap + token-usage audit |

## :material-circle-box:{ .taiconcolor } When These Controls Are Live

The published v0.1.2 App package is the **full-LLM build variant**: every control on this page actively governs its LLM path once an [LLM provider credential](settings.md#provider-credentials-tab) is configured. Where no credential exists, or **Templates-only mode** is on, or a compile-time [templates-only build](templates-only-build.md) is installed, the LLM-specific items above (LLM01/02/04/07/09/10) are moot by construction — there is no vendor dispatch to attack — while the audit trail, its forwarder, and the supply-chain controls remain live. Nothing about the controls themselves differs between builds beyond whether the path they protect is reachable.
