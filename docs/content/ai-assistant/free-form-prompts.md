# Free-form Prompts

!!! info "Requires a configured LLM provider credential"
    The published v0.1.2 App package is the **full-LLM build variant**, so the path this page describes is present in it — but it stays **inert until an admin configures an [LLM provider credential](settings.md#provider-credentials-tab)**. An upgrade creates no credential, so nothing reaches a vendor until someone sets one. An admin can also restrict a deployment to predefined prompts at run time with the **Templates-only mode** toggle (Settings → AI Assistant → General), and a compile-time [templates-only build variant](templates-only-build.md) exists for deployments where that restriction must not be reversible in the field.

Free-form prompts are the LLM-driven path through the AI Assistant. The user types a natural-language question; the orchestrator sends a system primer + the question + tool definitions to one of four supported LLM providers; the vendor picks tools, the orchestrator dispatches them via the [Splunk MCP Server](mcp-setup.md), and the vendor synthesizes a narrative response from the privacy-tier-bounded summaries. The narrative ends up in the chat panel on the left; the actual data lands in tool-result tiles on the right.

This path requires a configured [LLM provider credential](settings.md#provider-credentials-tab), is governed by the active [privacy tier](privacy-tiers.md), and can be switched off — at run time with the **Templates-only mode** toggle, or irreversibly in the [Templates-only build variant](templates-only-build.md).

## :material-circle-box:{ .taiconcolor } The Four Supported Providers

| Provider | API Endpoint | Auth | Models |
|---|---|---|---|
| **Anthropic** | `api.anthropic.com` (direct) | API key | Claude Opus 4.8 / Sonnet 5 / Haiku 4.5 baseline + any model discovered from `/v1/models` |
| **OpenAI** | `api.openai.com` (direct) | API key | GPT-5.1 / GPT-5 / GPT-4o / o3 baseline + discovered chat-capable models |
| **Azure OpenAI** | Customer's Azure deployment URL | Azure auth + URL pattern | Per Azure deployment configuration (deployments auto-discovered) |
| **AWS Bedrock** | Bedrock API (Claude on Bedrock) | Bedrock API Keys (no SigV4 signing) | Claude on Bedrock — baseline + `ListFoundationModels` discovery |

Active provider + default model are admin-configured in [Settings → General](settings.md). Per-user model picker in the chat panel's privacy banner lets users switch within the active provider's model list — the curated baseline plus any vendor-discovered models (see [How model discovery works](settings.md#how-model-discovery-works)).

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

**Failed tool calls.** In every tier, a tool call that fails reaches the AI only as its HTTP status and a fixed error class, for example `Tool error (HTTP 400, class=parse_error): Splunk could not parse the query; check the SPL syntax. The error text is shown to the user only.` Splunk's or the MCP server's error text is never sent, because it repeats the search and can carry event data. The full error stays in the tile in the right pane. A call the App refuses itself (the SPL guard, the saved-search catalog, an undeclared tool, the session tool-call cap) reaches the AI as `Tool call refused by the App before it ran: <reason>`, with the App's own reason. See [Privacy Tiers](privacy-tiers.md#failed-tool-calls-every-tier).

## :material-circle-box:{ .taiconcolor } The Two MCP Tools the AI Sees

The AI's tool definitions on every free-form request are:

### `splunk_run_saved_search`

Dispatch a saved search from the LogServ App's catalog (one of the catalogued prompts described in [Predefined Prompts](predefined-prompts.md)).

Only the catalog's names are dispatched. The orchestrator checks the name where every saved-search call is sent to the MCP Server; any other name — a rollup aggregation, retention or backfill, an Enterprise Security feed, or a name the AI made up — is refused with a synthetic error tool_result and a `security_blocked_spl` audit event, and nothing reaches the MCP Server. The MCP arguments are built from the vetted name, the App (`app` = `splunk_app_sap_logserv`) and the time range; other keys the AI supplies are not forwarded. A tool name other than the two on this page is refused the same way.

| Arg | Type | Description |
|---|---|---|
| `name` | string (required) | Saved-search name from the catalog (e.g., `logserv_hana_failed_auth`) |
| `earliest_time` | string (optional) | Splunk earliest token (e.g., `-24h`, `-7d`). If omitted, the saved search's own configured time range applies; the AI's primer instructs it to pass an explicit window. |
| `latest_time` | string (optional) | Splunk latest token (e.g., `now`). |
| `render_hint` | string (optional) | One of `table` / `timechart` / `kpi` / `pie`. Falls back to the catalog's per-prompt `renderHint`. |
| `top_n` | integer (optional, default 10, max 50) | Width of categorical aggregates the AI receives in Tier 2 summary. The AI passes this when the user asks for "top 25 X" or similar. |

### `splunk_run_query`

Dispatch ad-hoc SPL written by the AI. Used when no saved search fits the user's question.

| Arg | Type | Description |
|---|---|---|
| `query` | string (required) | SPL string. Must start with the LogServ macro `\`sap_logserv_idx_macro\`` as its first term — or with `\| inputlookup` of one of the App's lookups, `\| tstats` with the macro right after `WHERE` or `\| makeresults` — and use only the allowed commands. The App enforces both (below). |
| `earliest_time` | string (optional) | Defaults to the user's currently selected time range when omitted. |
| `latest_time` | string (optional) | Same as above. |
| `render_hint` | string (optional) | Same as above. |
| `top_n` | integer (optional) | Same as above. |

**SPL guard** ([LLM06 — Excessive Agency](owasp-llm-compliance.md)): the orchestrator checks every `splunk_run_query` query three times before dispatch, and a query any check refuses is never sent to Splunk:

1. **The denylist** of known risky commands (below), the first fence.
2. **The allow-list.** The App reads the query with a strict lexer and refuses it unless every command in it, subsearches included, is on the list, and it reads only what free-form analysis needs (details after the denylist).
3. **Splunk's own search parser.** The App then sends the query to `search/parser` (parse only, nothing runs; through Splunk Web's splunkd proxy, as the signed-in user, in this App's namespace) and refuses it when the parser reads it differently from the App: another list of commands, a command not on the list, a query starting with the data macro whose expansion is not the App's definition (a macro of the same name the user's context shadows — where the macro stands after `WHERE` in `tstats` or starts a subsearch, only an index term its expansion brings in is caught), an index term other than the LogServ index, or a `lookup` / `inputlookup` outside a subsearch whose lookup, as the parser reports it, is not one of the App's or cannot be read. The parser reports a subsearch as text inside the command that holds it, not as commands of its own, so the commands and lookups inside a subsearch are checked by the App's lexer only: a command or lookup that a shadowed macro brings into a subsearch is not caught (an index term it brings in is). If the parser cannot be asked — the call fails, times out or returns no command list — the query is refused (`parser_unavailable`); a query the parser rejects as invalid SPL is refused too (`parser_rejected`). It fails closed.

The denylist refuses these commands at the start of the query, after a `|` or after a `[`, outside quoted strings — also when double or single quotes are written into the command word, as in `| "delete"` or `| de'lete'`:

- **Write to an index:** `collect` and its aliases `stash`, `summaryindex` and `sumindex`; `mcollect`; `meventcollect`.
- **Write lookups, files or other output:** `outputlookup`, `outputcsv`, `outputtext`, `dump`, `tscollect`, `createrss`.
- **Delete events:** `delete`.
- **Trigger alerts or email:** `sendalert`, `sendemail`.
- **Run scripts:** `script` and its alias `run`; `runshellscript`.
- **Read REST endpoints:** `rest` — `storage/passwords` returns stored credentials decrypted.
- **Send data out:** `outputtelemetry`, and the third-party `curl`, `wget` and `sendresults`.
- **Machine Learning Toolkit:** `ai` (it sends the rows to an LLM) and `deletemodel`.
- **Run other searches:** `map`, and `savedsearch`'s aliases `macro` and `savedsplunk`.

It also refuses `savedsearch` and `savedsplunk` as words anywhere in the query, quoted text included (`| from savedsearch:X`), also when quotes split them (`| "saved"search X`, `| sav"edsearch" X`); the external lookup `dnslookup` anywhere, also split by quotes (`| lookup "dns"lookup`), because each row becomes a DNS query to an outside name server; a `fit` command (plain, quoted or split by quotes) followed anywhere later in the query by the word `into`, because `fit ... into` saves a model (`fit` with no `into` after it, and `apply`, stay allowed); an SPL inline comment (three backticks); an unmatched backtick; a double quote that is never closed, or a backslash-escaped double quote outside a quoted string; and a macro other than the App's own (`sap_logserv_idx_macro`, `sap_logserv_audit_idx_macro`, `sap_logserv_cloud_provider_default_macro`), because a comment, ambiguous quoting or another macro could hide a command. Apart from those words, `dnslookup`, an `into` after a `fit`, and backticks, double-quoted text is read as data, so a bracketed tag inside a quoted string, such as `search "[DELETE]"`, is not mistaken for a command. Where Splunk's reading of quotes is uncertain, the guard assumes the worst and refuses. That includes a word that forms only once the quotes are removed (`"saved""search"`), a `|` or `[` inside single quotes (read as a command position), and any `into` after a `fit`, even one that belongs to another command or to quoted text (`| fit X | stats count by into`, `| fit X by "a into b"`).

**The allow-list.** A query the denylist passes must also pass these rules (operators in brackets, as the audit event records them):

- **Commands** (`command_not_allowed`): only `search`, `where`, `eval`, `stats`, `eventstats`, `streamstats`, `tstats`, `chart`, `timechart`, `top`, `rare`, `sort`, `head`, `tail`, `dedup`, `reverse`, `table`, `fields`, `rename`, `fillnull`, `filldown`, `bin`, `bucket`, `rex`, `regex`, `spath`, `lookup`, `inputlookup`, `makeresults`, `addinfo`, `transaction`, `convert`, `iplocation`, `strcat`, `xyseries`, `untable`, `transpose`, `fieldsummary`, `addtotals`, `addcoltotals`, `makemv`, `nomv`, `mvcombine`, `append`, `appendcols`, `join`, `appendpipe`. Everything else is refused, whatever it does and whichever app ships it — custom search commands of other apps, `fit` and `apply`, `datamodel`, `metadata`, `loadjob`, `inputcsv`, `foreach`, `map`, `mvexpand`, `fieldformat`, `rangemap`, `return`, `format`, `multisearch`, `union`. Every allowed command is one the Tier 2 summarizer reads in full. `union` is refused because Splunk's search parser rewrites it before it runs (into `search … | append [...]`, or `multisearch` when every arm streams), so the App cannot check it against the parser's reading; **use `append` to combine two searches** — `` `sap_logserv_idx_macro` sourcetype=a | stats count by host | append [search `sap_logserv_idx_macro` sourcetype=b | stats count by host] `` — and the refusal of a `union` tells the model so.
- **Where a query starts** (`query_start`): the query, and every subsearch arm, starts with `` `sap_logserv_idx_macro` `` as the first term of its search, or with `| inputlookup <one of the App's lookups>`, ``| tstats … WHERE `sap_logserv_idx_macro` `` or `| makeresults`; an `appendpipe […]` group starts with a command (`stats`, `eval`, …), never with the macro. Every `tstats`, anywhere in the query, names the macro right after `WHERE`.
- **Data scope** (`index_not_allowed`): no `index=`, `index!=`, `index::` or `index IN` term anywhere, no audit macro, and no `OR` or `NOT` right next to the LogServ macro — Splunk binds `OR` tighter than the implied `AND`, so `` `sap_logserv_idx_macro` OR index=main `` would leave the index. Put alternatives after the macro, in parentheses: `` `sap_logserv_idx_macro` (sourcetype=a OR sourcetype=b) ``.
- **Lookups** (`lookup_not_allowed`, `eval_lookup`): `lookup` and `inputlookup` only name the App's own lookups — its rollups, its threat-intel lookups, its sourcetype metadata and the ISC BIND and Squid lookups. The Data Doctor's collections, the Enterprise Security asset and identity feeds and the Settings backfill's scratch collection (`logserv_backfill_stage`) are excluded, and so is every other app's lookup and the eval `lookup()` function (also written `lookup (` or across a line break). The lookup's name must be the one Splunk reads too: an option before it may not have a quoted value (`max="5"`, `event_time_field='…'`), and nothing may be written against the name (`logserv_mc_rollup"_x"`). Splunk's parser must agree: for every `lookup` and `inputlookup` outside a subsearch the App reads the lookup again from the parser's reply (step 3 above) and refuses the query (`parser_mismatch`) unless it is one of the App's.
- **Subsearches** (`subsearch_not_allowed`, `subsearch_fields`): only as a filter in `search`, ending with `| fields` or `| table` naming the fields it returns (no wildcard, not `search` or `query`, whose values Splunk would insert as text), or in `append`, `appendcols`, `join` and `appendpipe` (one group).
- **Macros** (`macro_position`): the LogServ macro only as the first term of a search or right after `WHERE` in `tstats`; a macro inside quoted text is refused. A macro must stand apart, with a space, a `|` or a square bracket on each side: Splunk expands a macro as text, so anything written against it joins its expansion (`` `sap_logserv_idx_macro`* `` would become `index="sap_logserv_logs"*`, `` where`sap_logserv_idx_macro` `` would lose the `WHERE`).
- **Quoting and brackets** (`ambiguous_single_quote`, `unbalanced_bracket`, `escaped_outside_quotes`): single quotes only around field names (`eval 'User Name'=user`) — every `'` pairs with the next one, with no `|`, bracket, double quote, backtick, backslash or line break between them. A search term that contains an apostrophe goes in double quotes: `"don't"`. Square brackets must balance outside quoted text. A backslash may appear only inside double-quoted text (a `rex` or `regex` pattern, a quoted value): Splunk reads `\|` as a pipe character passed to the command rather than the end of a command, so an escaped pipe, bracket or quote outside double quotes would make Splunk and the App see different commands.

The AI's primer lists the allowed commands exactly, and a refusal names the command, lookup or macro it is about, so the model can rewrite the query. Splunk role permissions remain the authoritative gate. Blocked SPL produces a synthetic error tool_result + a `security_blocked_spl` audit event (with the `operator` and, when the refusal is about one, the `command`). The AI is told `Tool call refused by the App before it ran:` followed by the guard's reason, which is text the App wrote, so it can recover by writing a different query.

## :material-circle-box:{ .taiconcolor } The System Primer

A system-message prelude is sent on every free-form request. The primer teaches the AI:

- A data-boundary rule that distinguishes customer data from instructions (mitigates [LLM01 / LLM04](owasp-llm-compliance.md))
- The full saved-search catalog, built from the intent map at compile time (so the AI prefers `splunk_run_saved_search` when a saved search fits)
- The LogServ data model (sourcetypes + key fields) for ad-hoc SPL
- The exact list of commands allowed in `splunk_run_query`, and where a query must start, what it may read and how to quote
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
2. Surfaces a system_notice in chat stating the limit was reached, how many free-form prompts were counted against the hourly threshold, roughly how long until the oldest prompt ages out, and which admin setting (`rate_limit_per_hour`) raises the cap.
3. Records a `rate_limited_prompt` audit event with the user's identity, the cap value, and the timestamp.
4. Does NOT invoke the LLM vendor.

The cap is per-user, not per-session — opening a new browser tab doesn't reset it. Enforcement is browser-side (`localStorage`), so it is per-user **per browser**: a second browser or device gets its own budget, and clearing site data resets the counter. The `rate_limited_prompt` / `daily_spend_cap_hit` audit events still fire on every block, so the SOC record survives either way — treat both caps as defense-in-depth, not a hard quota; vendor-side limits and your billing dashboard remain the enforcement of record. Maps to [LLM10 — Unbounded Consumption](owasp-llm-compliance.md).

## :material-circle-box:{ .taiconcolor } Token-Usage Audit + USD Cost Estimate

Every vendor call — whichever tier is active — records a **`vendor_tier1`** audit event with:

- Provider (anthropic / openai / azure_openai / bedrock)
- Model
- Input tokens, output tokens, total tokens
- USD cost estimate (per-vendor pricing table — see [AI Assistant Implementation Reference](../developer/ai-assistant-internals.md))
- Outbound bytes
- Prompt length (chars)
- Number of tool turns in this dispatch
- `tier2RedactionsApplied` — number of PII redactions applied on this turn (0 at Tier 1)
- `powerMode` — whether the forced-RAG [Power Mode](power-mode.md) was active

The Audit Log tab in Settings provides aggregate views; the USD cost estimate is a sticker price (not the customer's negotiated rate, which we don't know) and should be treated as an order-of-magnitude indicator. See [Audit Log](audit-log.md).

## :material-circle-box:{ .taiconcolor } Daily Spend Cap

To prevent runaway vendor spend, the orchestrator enforces a per-user (per browser) daily USD spend cap (configurable in Settings, default $X / day; admin sets per organization risk tolerance). When a vendor call would push cumulative cost over the cap, the orchestrator:

1. Refuses the dispatch.
2. Records a `daily_spend_cap_hit` audit event.
3. Surfaces a system_notice stating the cap was reached, how much of the budget is spent, and that the tally resets at local midnight (the browser's calendar day).

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
