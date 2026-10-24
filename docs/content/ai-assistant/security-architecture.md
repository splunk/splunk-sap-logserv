# Security Architecture — SAIF Alignment

This page is for **customer security teams** evaluating the LogServ App's AI Assistant feature against Google's [Secure AI Framework (SAIF)](https://saif.google/). It complements the [OWASP LLM Top 10 Compliance](owasp-llm-compliance.md) page — same set of controls, organized along SAIF's four-pillar structure and mapped to SAIF's 15 Key Risks catalog.

!!! info "The AI-specific risk surface appears once an LLM provider credential is configured"
    The published v0.1.2 App package is the **full-LLM build variant**, so the architecture described below is the one that governs it — but the vendor-dispatch path that architecture protects is **inert until an admin configures an [LLM provider credential](settings.md#provider-credentials-tab)**. Until then, and wherever **Templates-only mode** is on or a compile-time [templates-only build](templates-only-build.md) is installed, there is no vendor dispatch and the AI-specific surface does not exist. The audit trail and the type-system data boundary are live in every build.

## :material-circle-box:{ .taiconcolor } The Privacy Boundary

The LogServ AI Assistant is designed around one flagship security property: **no raw event and no unsummarized search result from your Splunk indexes is ever transmitted to any AI vendor; the vendor gets only the summary the active privacy tier allows.** This isn't a policy commitment — it's enforced by the TypeScript type system at compile time.

- Tool results returned from Splunk via MCP are typed as `Hidden<T>`.
- The compiler refuses to put a `Hidden<T>` value into an outbound LLM payload.
- The only conversion path is `sanitize(hidden, summarizer)` — which forces the caller to supply a summary string; the active tier picks the summarizer.
- There is no runtime flag, no policy toggle, no override.

What the AI sees:

| Privacy Tier | What's sent to the vendor LLM |
|---|---|
| **Tier 0** (Ollama, not available in this release) | Planned: nothing, fully on-host. Today Tier 0 summarizes like Tier 1 and sends to the selected provider; do not select it ([Privacy Tiers](privacy-tiers.md#tier-0-and-the-ollama-provider-do-not-select)) |
| **Tier 1** (default) | Two numbers per call: a count and a timing. No values. |
| **Tier 2** (admin opt-in) | Tool result aggregated metadata: cardinality, top-N values + counts (field values from the events — filtered, 40 characters each, and with PII redaction on sent in clear only when the App can trace the column to a field that marks no identifier), numeric stats, and the time range as UTC timestamps the App formats. A column name only when Splunk generates it or every word in it was written by the model in its own query or by the App's catalog search that ran; any other name appears as `col_N`. **No raw rows.** |

In every tier, a tool call that **fails** reaches the vendor only as its HTTP status and one of ten fixed error classes, with a hint the App writes (`Tool error (HTTP 400, class=missing_lookup): …`). Splunk's or the MCP server's error text is never sent: a Splunk error repeats the search that failed, and a subsearch can put event data into that search. The full error stays in the result panel on the user's screen. A call the App refuses itself, before anything is sent, reaches the vendor as `Tool call refused by the App before it ran: <reason>`, with the App's own reason.

Detail: [Privacy Tiers](privacy-tiers.md).

---

## :material-circle-box:{ .taiconcolor } SAIF Four-Pillar Mapping

Google's SAIF organizes AI security controls into four pillars. Here's how the LogServ AI Assistant maps to each.

### :material-database-eye-outline:{ .taiconcolor } Data

SAIF's Data pillar covers how AI systems handle training data, user data, and the data flowing between system boundaries.

**Training data — N/A.** The LogServ AI Assistant does not train, fine-tune, or update any model. It uses third-party LLMs (Anthropic, OpenAI, Azure OpenAI, AWS Bedrock) through their public APIs. The data-poisoning, unauthorized-training-data, and training-data-sanitization controls in SAIF apply to those vendors, not to LogServ.

**User Data Management — fully enforced.** The Privacy Boundary (above) is the core control:

- `Hidden<T>` type system blocks raw event and unsummarized result egress at compile time.
- Tier 1 (default) sends only count + timing.
- Tier 2 sends aggregates only. A column name is sent only when Splunk generates it (`count`, `percent`, `NULL`, `OTHER`, …) or every word in it appears in the text the model or the App wrote for the call — the model's own query, or the SPL of the App's catalog search that ran; any other name, such as a split-by value (`timechart … by user`) or `sum(jsmith)` that the query did not type, is replaced with a `col_N` placeholder, with PII redaction on or off. With redaction on, the values of a text column shown as `col_N` are all redacted. A result the App finds no rows in is reported only as `Returned a result that is not in row form`. The `_time` range is sent only as UTC timestamps the App formats (see [Privacy Tiers](privacy-tiers.md#tier-2-cloud-llm-aggregated-metadata-admin-opt-in)).
- A failed tool call, in every tier, sends only its HTTP status and a fixed error class, never the error text (see [Failed Tool Calls](privacy-tiers.md#failed-tool-calls-every-tier)).
- Tier 2 PII redaction replaces the values of identifier columns with a per-value pseudonym tag (`<redacted-XXXXXXX>`: 7 hex digits of an HMAC-SHA-256 under a random key made per chat session and kept in the browser's memory only). The tag is stable within the chat session, so the LLM can still reason about cardinality, and it cannot be linked across sessions or reversed by hashing candidate values. Every field the App defines is classified one by one (identifier, address, host, free text, safe), checked by the build, and name patterns cover every other field. It fails closed: a text column's values are sent in clear only when the App can trace the column, through constructs it reads in full, to fields that mark no identifier; any other column is redacted. Hostname redaction is opt-in via Settings. The exact patterns and tracing rules are in [Privacy Tiers → Tier 2](privacy-tiers.md#tier-2-cloud-llm-aggregated-metadata-admin-opt-in).
- Every elevation from Tier 0/1 → Tier 2 is recorded in the audit log with the admin's user identity, timestamp, and previous tier.

### :material-server-network:{ .taiconcolor } Model

SAIF's Model pillar covers model integrity, exfiltration risk, and supply chain.

**Model Source Tampering — partial coverage:**

- **Our supply chain:** a Software Bill of Materials (`SBOM.json`, CycloneDX 1.4) ships in every release with per-dependency `purl` + sha-512 hashes; it enumerates every bundled dependency. A dependency-audit script (`yarn audit:ci`, high and critical advisories) exists, but the build that produces the release package does not run it.
- **Distribution integrity:** each release package passes Splunk AppInspect in Splunk Cloud precert mode (`--mode precert --included-tags cloud`) with 0 errors and 0 failures before it is published; the results are published beside the packages. The packages are not published on Splunkbase. The Splunk Deployment Server delivers the Data TA to heavy forwarders over Splunk's management port, encrypted with TLS; whether each side also verifies the other's certificate depends on your Splunk TLS settings.
- **Vendor model weight integrity** is the LLM vendor's responsibility. The customer's DPA review should confirm vendor-side controls.

**Model Exfiltration — N/A.** The LogServ App does not host model weights. Cloud LLM models live in vendor infrastructure (Anthropic, OpenAI, Azure, Bedrock). Tier 0 Ollama (not available in this release) would run on the customer's own host, with model weights under the customer's existing storage controls.

**Model Reverse Engineering — N/A.** The LogServ App exposes a known vendor LLM behind a thin wrapper. The system primer is publishable (see the [free-form prompts documentation](free-form-prompts.md)) — there's no proprietary prompt engineering to reverse-engineer.

### :material-application-cog-outline:{ .taiconcolor } Application

SAIF's Application pillar covers input validation, access management, and output handling for the AI-using application.

**Input Validation — multi-layered:**

- **User-prompt anomaly detection.** Five pattern groups (role redefinition, persona shift, system-prompt leak, control tokens, long base64 blobs) run on every user prompt before dispatch; prompt length and a character-class fingerprint are captured as recorded signals alongside the matched groups. **Flag-and-proceed semantics:** matches fire a `user_prompt_jailbreak_flag` audit event for SOC review but do not block the prompt — regex-based detection has false positives, and blocking would cripple legitimate investigative queries.
- **SPL static analysis on AI-authored queries.** Every `splunk_run_query` call from the AI runs through two fences and a cross-check before it is sent. The first fence is a denylist of commands that write, delete, alert, email, run scripts, read REST endpoints, send data out or run other searches, plus the quoting tricks, inline comments and foreign macros that could hide one. The second fence is an allow-list read by a strict lexer: only the App's read-only analytic commands, only the LogServ index, only the App's own lookups, and subsearches only where they cannot widen the search, so other apps' custom commands and external lookups are refused even when the denylist does not name them. Then Splunk's own search parser reads the query (`search/parser`, parse only), and the App refuses it when the two readings differ or when the parser cannot be asked (fail closed). The AI can rephrase a refused query. Blocked queries surface as a `security_blocked_spl` audit event with the `operator` and the `command`. The full lists and rules: [Free-form Prompts → The SPL Guard](free-form-prompts.md#spl-guard); the audit fields: [Audit Log](audit-log.md).
- **Saved-search allow-list.** `splunk_run_saved_search` accepts only the names in the App's own prompt catalog; any other name is refused before it reaches the MCP Server and recorded as a `security_blocked_spl` audit event. The list is a copy of the catalog's names taken when the App loads, and it cannot be changed while the App runs.
- **Tool-result sanitization.** AI-authored tool arguments are schema-validated. Tier 2 categorical aggregates pass through a per-value sanitizer that replaces strings matching known jailbreak idioms with `<filtered>`.
- **`<TOOL_RESULT_DATA>` sentinel block** wraps every tool-result summary the AI sees. The system primer instructs the AI to treat anything inside the sentinel as data from the customer's environment, never as instructions.

**Application Access Management:**

- **Per-user prompt rate limit** (configurable; default tunable in Settings) bounds free-form prompt volume per hour.
- **Per-user daily spend cap** (default **50.00 USD**; set to `0` to disable) bounds vendor cost per day. Tally resets at local midnight. Predefined-prompt executions don't accumulate against the cap.
- **Per-chat-session MCP tool-dispatch cap** is defense-in-depth above the per-message limit of at most 8 tool turns. Prevents runaway tool-loops in adversarial automation.
- **Feature toggle.** The master `enabled` switch in Settings gates the entire feature; transitions from OFF to ON require admin acceptance of a liability acknowledgement modal (recorded with the admin's user identity, timestamp, disclaimer hash, and version per Splunk's standard opt-in pattern).

**Output Validation:**

- **The LLM's output is never executed.** Tool calls are schema-validated against a closed catalog of MCP tools; a tool name outside it is refused, and a saved-search name outside the App's prompt catalog is refused. There is no `eval`-style path from LLM output to system action.
- **React rendering uses JSX text nodes**, not `dangerouslySetInnerHTML`. Strings are escaped by default. Citation markers, severity badges, and bold markdown are parsed via a controlled set of recognized patterns; no general-purpose HTML rendering.
- **Drill-down URLs** are built via a centralized `buildSplunkSearchUrl()` helper that uses `encodeURIComponent()` and applies `target="_blank" rel="noopener noreferrer"` flags to break reverse-tabnabbing attacks.

### :material-robot-outline:{ .taiconcolor } Agent

SAIF's Agent pillar — newer in SAIF 2.0 — covers autonomous agent behavior, permissions, user control, and observability.

**Agent Permissions — a closed catalog.** The AI is offered two MCP tools, and the App refuses any other tool name it emits:

- `splunk_run_query` — dispatches an ad-hoc SPL query against the customer's data, subject to the static-analysis guard (see Input Validation above).
- `splunk_run_saved_search` — dispatches a saved search **from the App's own catalog only**: the prompt library built from the App's intent map. The check runs where every saved-search call is sent to the MCP Server, so a name outside the catalog is refused — never a rollup aggregation, retention, backfill or Enterprise Security feed — and recorded as a `security_blocked_spl` audit event. The App builds the MCP arguments itself (the vetted name, the App — `app` = `splunk_app_sap_logserv` — and the time range); other keys the model supplies are not forwarded.

Free-form queries refuse the commands the guard knows to write, delete, alert, run scripts, read REST endpoints, send data out or run other searches — `collect`, `outputlookup`, `outputcsv`, `delete`, `rest`, `curl`, `savedsearch`, `map`, `mcollect`, `meventcollect`, `runshellscript`, `dump` and the rest of the guard's list (see Input Validation above). Beyond Splunk searches, the AI has no config writes, no user creation, no permission changes, and no outbound network actions of any kind beyond the LLM API call. Within a search, the guard refuses the outbound commands and lookups it names (`outputtelemetry`, `curl`, `wget`, `sendresults`, `dnslookup`), and the allow-list refuses every command and lookup that is not on its list, including any another installed app adds.

These controls protect **this App's AI Assistant**. Another MCP client holding a Splunk MCP Server token is governed by the Splunk MCP Server's own controls and by Splunk permissions, not by this App. Running MCP tools needs the MCP Server's `mcp_tool_execute` capability, which it grants by default only to `admin` and `sc_admin`; every AI Assistant user needs it too ([Splunk MCP Setup → Roles and Capabilities](mcp-setup.md#roles-and-capabilities)).

**Agent User Control:**

- **Tier selection** by an admin in Settings, at any time — Tier 1 (default) or Tier 2; Tier 0 is not available in this release.
- **Master enable toggle** — admin-controlled, default OFF.
- **Per-prompt opt-in** — every free-form prompt is user-initiated. There is no autonomous loop, no scheduled prompt execution, no background activity.
- **Power Mode** is a per-browser-tab toggle, shown only to the roles an admin names. While it is on, the primer asks the model to run a saved search before answering; each prompt's audit event records whether it was on.
- **Acknowledgement modals** at Settings save time — an admin must answer a liability acknowledgement to (a) turn the feature on and (b) save with the audit forwarder off. A tier elevation needs no acknowledgement; it records a `vendor_tier2_elevation` audit event.

**Agent Observability:**

- **Sequenced audit log.** Every meaningful AI Assistant event (canned prompt execution, free-form vendor call, blocked SPL, rate-limit hit, spend-cap hit, prompt anomaly, tier elevation, legal acknowledgement, model discovery) lands in the `logserv_ai_assistant_audit` index with a stable per-tab session ID + monotonic per-session sequence number, so gaps and reordering are detectable. The browser writes the events as the signed-in user, which needs Splunk's `edit_tcp` or `edit_log_alert_event` capability (by default `admin` holds both, `power` holds `edit_log_alert_event` and `user` neither); a user without either is not audited, and the chat panel says so ([Who can write audit events](audit-log.md#who-can-write-audit-events)); tamper-evidence comes from the optional HEC forwarder to a separately-administered destination. The chat panel surfaces "AI is generating response" status; the [Audit Log viewer](audit-log.md) in Settings lets reviewers filter by category, user, and time range.
- **Who can read the audit index** follows each role's allowed indexes; Splunk's default `user` role allows every non-internal index, so narrow it ([Restricting who can read the audit index](audit-log.md#restricting-who-can-read-the-audit-index)).
- **HEC audit forwarder.** Admin can configure a Splunk HEC destination (e.g., a separate indexer, a SIEM, S3-with-Object-Lock owned by a different admin team) for tamper-evident off-host audit copies. Forwarder failures themselves are recorded locally so an off-host divergence is detectable.
- **Vendor token-usage audit events** capture provider, model, input/output tokens, USD cost estimate (computed locally from list pricing), and turn count — letting SOC teams pivot on cost-anomaly indicators.

---

## :material-circle-box:{ .taiconcolor } SAIF 15 Key Risks — Coverage Matrix

The table below maps each SAIF Key Risk to LogServ's posture. **Strong** = flagship property of the architecture; **Partial** = mitigation in place with documented residual surface; **N/A** = out of scope because LogServ does not train or host models.

| # | SAIF Risk | LogServ Posture | Key Controls |
|---|---|---|---|
| 1 | Data Poisoning (DP) | N/A | LogServ does not train models. |
| 2 | Unauthorized Training Data (UTD) | N/A | LogServ does not train models. No raw event or unsummarized result leaves the privacy boundary. |
| 3 | Model Source Tampering (MST) | Partial | SBOM in every release; a dependency-audit script the release build does not run. AppInspect (Splunk Cloud precert mode) on every release package. Model weight integrity is vendor responsibility. |
| 4 | Excessive Data Handling (EDH) | **Strong** | `Hidden<T>` privacy boundary, Tier 1 default, Tier 2 PII redaction. |
| 5 | Model Exfiltration (MXF) | N/A | LogServ does not host models. |
| 6 | Model Deployment Tampering (MDT) | Partial | AppInspect before release + DS-channel distribution. Tarball GPG signing is a known gap. |
| 7 | Denial of ML Service (DMS) | Partial | Per-user prompt rate limit + per-user daily spend cap + per-session tool dispatch cap (browser-side enforcement — see Known Residual Gaps). |
| 8 | Model Reverse Engineering (MRE) | N/A | Publishable system primer, no proprietary prompt engineering. |
| 9 | Insecure Integrated Component (IIC) | **Strong** | Closed tool catalog, saved-search allow-list, schema-validated tool calls, SPL static-analysis guard. |
| 10 | Prompt Injection (PIJ) | Partial | Tool-result vector physically blocked by `Hidden<T>` + sentinel + per-value sanitizer; a failed call's error text is not sent at all (fixed error classes only). User-prompt vector flagged (five pattern groups), not blocked. |
| 11 | Model Evasion (MEV) | N/A | LogServ has no classifiers to evade; ML-evasion is vendor-side. |
| 12 | Sensitive Data Disclosure (SDD) | **Strong** | Same controls as EDH (privacy boundary + redaction). |
| 13 | Inferred Sensitive Data (ISD) | Partial | Strong by construction (Tier 1 = no values; Tier 2 = redacted aggregates). Hostname redaction is opt-in — small inference surface for environment topology when off. |
| 14 | Insecure Model Output (IMO) | **Strong** | LLM output never executed; no `dangerouslySetInnerHTML`; drill-down URLs encoded + tab-nabbing flags. |
| 15 | Rogue Actions (RA) | **Strong** | Catalog-only saved searches + write-command guard on free-form SPL, no autonomous loop, sequenced audit log + off-host HEC forwarder. |

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
| MRE (N/A here) | LLM07 — System Prompt Leakage (related) |
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
2. **Hostname redaction at Tier 2 is opt-in (default off).** Hostname patterns can leak environment topology. Admins can flip the default in Settings if their threat model requires it. (Host names that become column names, as in `timechart count by host`, are shown as `col_N` whatever this setting, unless the query itself wrote them.)
3. **Tarball GPG signing is not yet implemented.** AppInspect checks before release + DS-channel distribution cover most of the threat model, but a signed tarball would provide an additional integrity proof point. Tracked as a follow-up item.
4. **The rate limit and daily spend cap are enforced browser-side** (`localStorage` keyed by Splunk username). They bound good-faith use; a user with a second browser or cleared storage can exceed them. Every block still writes an audit event, so attempts remain visible. Server-side enforcement is a tracked follow-up.
5. **The saved-search allow-list and the SPL guard protect this App's assistant only.** Other MCP clients holding a Splunk MCP Server token, and users of Splunk's own search bar, can still run any saved search their Splunk permissions allow, the App's rollup and retention searches included; Splunk roles and the Splunk MCP Server's own settings govern them. The SPL guard matches command names in the query text, accepts only the App's own macros and refuses inline comments; Splunk's search parser, which expands the macros, cross-checks every free-form query (see gap 8).
6. **The saved-search allow-list matches names, not search text.** A build gate proves that the shipped (`default/`) definitions of the catalog searches are read-only. A `local/` edit of a catalog search, or a private saved search of the same name in this App, runs under its allowed name. Keeping such overrides read-only is the Splunk admin's responsibility; to see which definition is in effect, run `splunk btool savedsearches list <name> --app=splunk_app_sap_logserv --debug`.
7. **The SPL guard's command list is the App's.** Free-form queries may use only the commands and lookups on the App's allow-list, and Splunk's search parser cross-checks every query. What remains is what the allowed commands themselves do: they read the LogServ index and the App's lookups, and a query can still be expensive (a wide `transaction`, a large `join`); the rate limit, the session tool-call cap and Splunk's own search quotas bound that. Splunk role permissions remain the authoritative gate.
8. **Macro definitions are checked through Splunk's own parser.** Splunk expands whichever definition of a macro is in effect for the dispatching user and app: a `local/macros.conf` override in this App, the user's own private macro of the same name, or another app's globally exported macro of the same name can take precedence over the definition the App ships. The App has Splunk's search parser expand every free-form query in the user's context and refuses it when the parser finds a command not on the list, a different command list, a query starting with a data macro that does not expand to the App's definition, an index other than the LogServ index, or a lookup outside a subsearch that is not one of the App's. What remains: the definition is compared only where the query starts with the macro — where the macro stands after `WHERE` in `tstats` or starts a subsearch, a shadowing macro is caught only when its expansion names another index (Splunk's parser reports a subsearch as text inside the command that holds it, so a command or lookup such a macro brings into a subsearch is not caught); the check relies on the parser being reachable (when it is not, every free-form query is refused, `parser_unavailable`), and catalog searches are not checked this way — keeping the three macros (`sap_logserv_idx_macro`, `sap_logserv_audit_idx_macro`, `sap_logserv_cloud_provider_default_macro`) unshadowed stays the Splunk admin's responsibility. Catalog searches run in the LogServ App's context; to see the definition a search there gets for a given user, run `splunk btool macros list <name> --app=splunk_app_sap_logserv --user=<user> --debug` (without `--app` and `--user`, btool shows the global merge, which is not what those searches use), or list every copy with `| rest /servicesNS/-/-/configs/conf-macros splunk_server=local | search title=<name> | table eai:acl.app eai:acl.owner eai:acl.sharing definition`. Both the LogServ App and the Data TA ship `sap_logserv_idx_macro`; where both are on the search head, keep the two copies the same ([Renaming an index](../install-setup/install-ta.md#renaming-an-index)).
9. **Tier 1 limits what the vendor can learn; it does not make it zero.** The vendor gets two numbers for each call, a count and a timing, and for a failed call a fixed error class and the HTTP status. A model that writes its own queries can make these depend on event data — the timing, whether a search fails and which class its error gets, and the count, which is the number of result rows whenever the App recognises them — so a few bits per call can leak, up to about log2 of the largest row count the server returns through the count. The session tool-call cap (default 100) limits the calls per chat session; clearing the chat resets it, and `0` turns it off. Error text, which could carry far more, is not sent in any tier (see [Failed Tool Calls](privacy-tiers.md#failed-tool-calls-every-tier)).
10. **Tier 2 sends aggregated event values by design.** Its top-N values are field values from the events (filtered, 40 characters each, and with PII redaction on sent in clear only for columns the App traces to fields that mark no identifier), and a column shown as `col_N` keeps its numeric statistics. Redaction fails closed for anything the App cannot trace, but it is decided by field names: a value held by a field named nothing like an identifier (an event field such as `message`, a field another app extracts) is sent as it is, and so is `_raw` under a plain alias — `eval m=_raw` sends up to 40 characters of an event. A number computed from event text is sent unless a field it reads marks an identifier. A column name made only of words the model wrote in its own query is its own text and is sent even if it copies a value it has seen, and a count can still carry a few bits a query manufactures (`stats count by <a multivalue field computed from an identifier>` then `stats count`). Where no event value may be sent, use Tier 1, which sends no values (subject to gap 9).
11. **Tier 2's reading of the query.** The value rules of gap 10 depend on the App reading the model's query. The cases earlier builds listed as read wrongly or not at all — a `_time` the query sets, a stray apostrophe, `rex` groups written `(?'name'…)`, `fieldformat`, a lookup that echoes or maps the field it matches on, an unknown first command inside `appendpipe`, the App's own identifier fields the patterns missed, `rex` patterns and `spath` paths in the numeric rule, and a redaction tag that could be reversed offline — are closed, and free-form queries are limited to commands the App reads in full. What remains is listed in [Privacy Tiers — Known Limits of Tier 2](privacy-tiers.md#known-gaps-in-build-376): manufactured counts (documented, not traced), fields named nothing like an identifier, and text the model wrote itself.

---

## :material-circle-box:{ .taiconcolor } What Customers Can Do

Concrete actions a customer's security team can take to validate or strengthen the posture:

- **Review the audit log regularly.** Open Settings → AI Assistant → Audit Log. Filter by category to investigate anomalies. Categories worth scheduled review: `user_prompt_jailbreak_flag`, `security_blocked_spl`, `rate_limited_prompt`, `daily_spend_cap_hit`, `vendor_tier2_elevation`.
- **Check what the AI's searches can reach.** Free-form queries read only the LogServ index and the App's own lookups, with the commands of the App's allow-list, and Splunk's search parser cross-checks each one in the user's context. Review which roles may use the AI Assistant and run searches, and confirm that the App's three macros are not shadowed for the catalog searches: `splunk btool macros list <name> --app=splunk_app_sap_logserv --user=<user> --debug` (the user who runs them) for each of `sap_logserv_idx_macro`, `sap_logserv_audit_idx_macro`, `sap_logserv_cloud_provider_default_macro`. A steady stream of `parser_unavailable` refusals in the audit log means the App cannot reach the search parser.
- **Configure the HEC audit forwarder** to a separate destination — a different Splunk indexer, a SIEM, an S3 bucket with Object Lock, or any HEC-compatible sink. The acceptance modal recorded when the forwarder is left disabled is a useful compliance artifact.
- **Pick the tier that matches your risk appetite.** Tier 1 is the safest default (count + timing only). Tier 2 is more powerful but ships aggregated metadata to the vendor. Tier 0 (Ollama, local) is not available in this release; where nothing may reach a vendor, use Templates-only mode ([Restricting the LLM Path](templates-only-build.md)).
- **Set the daily spend cap** to a number that bounds your monthly liability. The cap can be raised or removed at any time via Settings.
- **Validate the SBOM** against your organization's vulnerability scanning. The `SBOM.json` ships at the root of the App tarball.

---

## :material-circle-box:{ .taiconcolor } Further Reading

- [OWASP LLM Top 10 Compliance](owasp-llm-compliance.md) — same controls organized by attack pattern
- [Privacy Tiers](privacy-tiers.md) — the type-system privacy boundary explained
- [Settings](settings.md) — admin-controlled toggles and configuration
- [Audit Log](audit-log.md) — viewer + filter conventions + tamper-evidence model
- [Free-Form Prompts](free-form-prompts.md) — system primer + tool catalog
- [Restricting the LLM Path](templates-only-build.md) — Templates-only mode, the compile-time templates-only build, and the v0.0.6 line
- Google's [Secure AI Framework (SAIF)](https://saif.google/) — the external reference framework this page maps against
