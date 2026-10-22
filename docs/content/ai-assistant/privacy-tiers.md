# Privacy Tiers

!!! info "Applies once an LLM provider credential is configured"
    The privacy tier governs what a vendor dispatch may carry, so it has something to govern only where that path is live. The published v0.1.2 App package is the **full-LLM build variant**, but it makes **no vendor calls until an admin configures an [LLM provider credential](settings.md#provider-credentials-tab)** — and none at all where **Templates-only mode** is on or a compile-time [templates-only build](templates-only-build.md) is installed. Once a credential exists, the tier selected in Settings → AI Assistant → General governs every vendor dispatch. The `Hidden<T>` / `Visible<T>` type-system enforcement is compile-time in every build: a tool result reaches an outbound vendor payload only through the active tier's summary, so no raw row and no unsummarized result is sent in any tier. What that summary may carry depends on the tier, as described below — in Tier 2 it includes aggregated values taken from the events.

The AI Assistant supports three privacy tiers that control what an external LLM vendor sees about your Splunk data. Tier selection is admin-configurable in [Settings → General](settings.md). The active tier is enforced by the TypeScript type system at build time, not by runtime policy: every outbound vendor payload must pass through a single sanitize chokepoint, and the chokepoint's summarizer is what the tier setting controls. For the type-system mechanism, see [AI Assistant Implementation Reference](../developer/ai-assistant-internals.md).

## :material-circle-box:{ .taiconcolor } The Three Tiers at a Glance

| Tier | Vendor traffic? | What the AI sees about each tool result | Use case |
|---|---|---|---|
| **Tier 0** (future release) | None — Ollama local | Same as Tier 1 (count + timing only) | Air-gapped customers, regulated industries with no-outbound-internet constraints |
| **Tier 1** (default) | Cloud LLM (Anthropic / OpenAI / Azure / Bedrock) | `Returned N rows in M ms.` — two numbers, a count and a timing. Nothing else. | Most customers — strongest cloud-LLM privacy posture |
| **Tier 2** (admin opt-in) | Same cloud LLM | The `Returned N rows in M ms.` line (N is the number of result rows, 0 for an empty result) + per-column cardinality + top-N values + counts (categorical; filtered, 40 characters each; with PII redaction on, sent in clear only when the App can trace the column to a field that marks no identifier, otherwise as `<redacted-…>` tags) + min/max/avg/sum (numeric) + the time range as UTC timestamps the App formats. A column name is sent only when Splunk generates it, or when every word in it was written by the model in its own query or by the App's catalog search that ran; any other name appears as `col_N`. **No raw rows.** | Customers who want data-grounded narrative replies and have legal authority to expose aggregate metadata to the vendor |

The table describes successful calls. In every tier, a **failed** call reaches the vendor only as its HTTP status and a fixed error class, never as Splunk's error text. See [Failed Tool Calls](#failed-tool-calls-every-tier).

## :material-circle-box:{ .taiconcolor } Tier 0 — Ollama Local (future release)

**Status:** roadmap — not yet shipped. Selecting `ollama` today silently falls back to the mock provider.

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

That's the entire summary: two numbers. Nothing about the column names, the row contents, the time range, the distinct counts, or the actual values. The `<TOOL_RESULT_DATA>...</TOOL_RESULT_DATA>` sentinel block is wrapped around every tool-result summary so the AI's primer can teach it that anything inside is data from the customer's environment, never instructions.

- **The count** is the number of result rows whenever the App recognises rows in the MCP reply — the same rows Tier 2 counts, so a search that matched nothing reads `Returned 0 rows`. With the Splunk MCP Server that is the length of the result list in its reply. Only a reply in which the App finds no rows — plain text, for example — is counted another way: the number of items in its `content` list, or the total row count a server reports (`totalRowCount`). Up to build 375 the count was always the length of the `content` list, so with the Splunk MCP Server it read `Returned 1 rows` whatever the search returned.
- **The timing** is the server's execution time when the reply carries one, otherwise the time the browser measured for the call.

**What the AI does with this:** the AI knows that the search ran, how many rows it returned and how long it took, but not what the rows hold. It writes structurally-aware narrative replies — *"the failed-auth saved search completed in 320 ms; its results are in the tile on the right"* — without making claims about specific users, IPs, or hosts.

**Decision rule for picking Tier 1:**

- The customer's legal/security team is comfortable with the AI vendor seeing the natural-language question + tool definitions + summaries.
- The customer is **not** comfortable exposing aggregate column metadata (cardinality, top-N values, min/max) to the vendor.
- The customer values determinism: a Tier 1 reply mentions zero specific values, so audit reviewers can sanity-check the narrative against the rendered tile without needing to verify what the AI was told.

**Limitations:** the AI can't write *"the top failing user was xcjadm with 42 attempts"* — it doesn't have that data. The narrative is correspondingly less concrete; the user is expected to read the tile in the right pane for the actual values.

Tier 1 limits how much the vendor can learn; it does not make that zero. For each call the vendor gets two numbers, a count and a timing, and for a failed call a fixed error class and the HTTP status (see [Failed Tool Calls](#failed-tool-calls-every-tier)). A model that writes its own queries can make these depend on event data — the timing, whether a search fails and which class its error gets, and the row count — so a few bits per call can leak: up to about log2 of the largest row count the server returns through the count. The session tool-call cap (`tool_calls_per_session_cap`, default 100) limits the calls per chat session; clearing the chat (**Clear All** in the results pane) starts a new session and resets the count, and `0` turns the cap off. No error text is sent in any tier.

## :material-circle-box:{ .taiconcolor } Failed Tool Calls — Every Tier

When a tool call fails, the AI vendor is told only that it failed, with the HTTP status and a fixed error class. It never gets Splunk's or the MCP server's error text. This is the same in Tier 0, 1 and 2:

```
<TOOL_RESULT_DATA>
Tool error (HTTP 400, class=missing_lookup): the query names a lookup that does not exist here. The error text is shown to the user only.
</TOOL_RESULT_DATA>
```

- **The status** is included only when it is a whole number from 100 to 599. Otherwise the line reads `Tool error (class=…)`.
- **The class** is one of `parse_error`, `unknown_command`, `missing_lookup`, `missing_saved_search`, `permission`, `timeout`, `rate_limited`, `not_found`, `server_error` or `other`. The browser picks it with fixed rules over the error message, or from the status when no rule matches. Each class has its own fixed hint, written by the App.
- **The error text itself** is shown only in the result panel on the user's screen. It is not sent to the vendor, and it is not written to the audit index.

The text is withheld because a Splunk error message repeats the search that failed, and a subsearch can put event data into that search. For example, `| inputlookup [search … | eval v=substr(_raw,1,80) | return $v]` can fail with an error that names the first 80 characters of an event as the missing lookup table. Before build 376, up to 200 characters of the error text went to the vendor.

**Refusals the App makes itself** are different, because their text is the App's own. These are calls the App stops before anything is sent: the SPL guard, the saved-search catalog check, the undeclared-tool check and the session tool-call cap. The vendor gets `Tool call refused by the App before it ran: <reason>`, so the model can rephrase:

- The reason is written by the App. It may quote the tool name or saved-search name the model itself sent, or the command, lookup or macro name of the model's query that the SPL guard refused.
- It is capped at 1,000 characters. Control characters other than tab and line breaks become spaces, and `<TOOL_RESULT_DATA>` tags are replaced with `<filtered>`.
- The App builds this text where it makes the refusal, never from a tool result. A server error that merely looks like a refusal is reduced to a class like any other error.

## :material-circle-box:{ .taiconcolor } Tier 2 — Cloud LLM + Aggregated Metadata (admin opt-in)

**What the LLM sees per tool result:**

For a `stats count by user, stack` result of 47 rows:

```
<TOOL_RESULT_DATA>
Returned 47 rows in 320ms.
Column "user" (distinct=8): <redacted-f86a9fe>=6, <redacted-0e3cb9c>=6, <redacted-e849a33>=6, <redacted-ac446fb>=6 (+4 more).
Column "stack" (distinct=3): Windows=16, HANA=16, SAP=15.
Column "count" (numeric, distinct=47): min=1 max=95 avg=47.11 sum=2,214.
</TOOL_RESULT_DATA>
```

The `user` column above shows the shipped default (`tier2_pii_redaction = true`): a column whose values come from an identifier field arrives as `<redacted-…>` tags, stable within the chat session. `stack` keeps its values because the query takes it from the events by its own name; had the query computed it with an `eval` — as the App's own cross-stack catalog search does — its values would arrive as tags too (see *Which values are sent* below). With `tier2_pii_redaction = false` the same line carries the raw values (`xcjadm=6, BKPADMIN=6, …`). The column names `user` and `stack` are sent because the query that produced the result wrote them (for a saved search, the App's catalog search does), and `count` because Splunk generates it. In Tier 2 the `Returned N rows` line counts the result rows the App finds in the reply; a search that matched nothing reads `Returned 0 rows in 210ms (no events matched the query in the selected time range).` and sends nothing else. A reply in which the App finds no rows at all — plain text, for example — is sent only as `Returned a result that is not in row form, in 210ms.`: no count, no column name and no value.

For a `timechart span=1h count by host` result:

```
<TOOL_RESULT_DATA>
Returned 3 rows in 210ms.
Time range: 2026-10-01T00:00:00.000Z → 2026-10-01T02:00:00.000Z (UTC).
Column names withheld: 2. Each such column is shown as col_N, N being its position among the result's columns that do not start with an underscore.
Column col_1 (numeric, distinct=3): min=0 max=2 avg=1 sum=3.
Column col_2 (numeric, distinct=3): min=0 max=4 avg=2 sum=6.
</TOOL_RESULT_DATA>
```

The column names of a timechart split by `host` are host names — values from the events that the query did not write — so they are shown as `col_N`, with PII redaction on or off and whatever the hostname setting. Had the query named the hosts itself (`host=sapdb01 OR host=sapapp01 | timechart span=1h count by host`), the names would be the model's own text and would be sent. The same holds when the cells hold text: for `timechart latest(action) by user` the user names are shown as `col_N` unless the query wrote them, and while redaction is on every value of a column shown as `col_N` arrives as a `<redacted-…>` tag, since nothing tells the AI what the column holds — and the text cells of a split-by column are redacted in any case (see *Which values are sent* below).

**What a Tier 2 summary contains, and what it leaves out:**

- **No raw rows.** The AI never gets a row: it cannot tell which user had how many failures on which stack, only the per-column distributions.
- **Values.** Each categorical column sends its top-N values with their counts (top 10 by default; the AI's `top_n` tool argument can ask for up to 50). Each value passes the value filter — a value that starts with a role marker (`system:`, `assistant:`, …), contains a known prompt-injection phrase or contains a `<TOOL_RESULT_DATA>` tag becomes `<filtered>`, and control characters become spaces — then PII redaction (below), then a 40-character cap, within a 160-character line. Each numeric column sends min / max / avg / sum. Columns whose name starts with `_`, all-empty columns and single-valued categorical columns are left out.
- **Column names.** A name is sent only when one of these holds, and it passes the value filter unchanged:
    - it is a name Splunk itself generates: `count`, `percent`, `total`, `Total`, `NULL`, `OTHER`, `column`, a bare statistics-function name (`sum`, `avg`, `mean`, `min`, `max`, `dc`, `distinct_count`, `values`, `earliest`, `latest`, `first`, `last`, `median`, `mode`, `stdev`, `range`, `rate`), or `fieldsummary`'s `field`, `is_exact` and `numeric_count`; or
    - every word in it was written by the model or the App. Each run of letters, digits and `_` in the name (`values(user)` is `values` and `user`; `ip-10-1-2-3` is `ip`, `10`, `1`, `2` and `3`) must appear as a whole word, in the same letter case, in the call's *author text*: the query the model wrote itself for `splunk_run_query`, or the SPL of the App's catalog search that produced the result for `splunk_run_saved_search`. Any word of that text counts, wherever it stands — a field name, an alias, a search term, a compared value, quoted text — because text the model or the App wrote tells the vendor nothing it does not already have. The name must also be at most 40 characters and have the shape of a field name (a letter or `_`, then letters, digits and `_ . : -`) or of one function call over one, `*` or nothing (`avg(duration)`, `sum(*)`) — or it must be a display alias that the author text writes in quotes right after `AS` (`rename sourcetype AS "Source Type"`, `count AS "Event Count"`): it starts with a letter or `_` and is made of letters, digits and `_ . : -`, in words separated by single spaces.

    Any other name is shown as `col_N` — N is the column's position among the result's columns that do not start with `_` — and is never sent, in full or in part; the summary says how many names were withheld. The rule is the same with PII redaction on or off. So `stats count as failures by host` keeps `failures` and `host`, `table _time host process message` keeps `host`, `process` and `message`, and a split-by value the query typed (`user=jsmith | timechart count by user`) keeps its name. `sum(jsmith)`, from `timechart count by user | stats sum(*)`, is shown as `col_N` — even when it is the only column — because the query wrote `sum` but not `jsmith`; it would be sent only if the query itself contained the word `jsmith`. A name is not sent because the query contains part of it: `username` is withheld when the query writes only `user`. A quoted alias is held to the same 40 characters and to the single-space shape: `"Source  Type"` (two spaces) or `"Events (%)"` is shown as `col_N`.

- **Which values are sent — fail closed.** With PII redaction on, a text column's values are sent in clear only when the App can *trace* the column — when the author text defines it entirely through constructs the App reads in full — to fields that mark no identifier. The App reads each author text as Splunk runs it, command by command, and a column is traced through:

    - the field itself, by its own name: a field of the events or of a lookup, a `by` or `over` field, a field of `top`, `rare` (with or without a positional limit, `top 10 uri`), `table` or `fields`;
    - a statistics function over one field, nested or not, with or without `AS` (`latest(user)` → `user`, `values(src_ip) AS ips` → `src_ip`, `latest(values(user))` → `user`);
    - `<field> AS <alias>`, a `rename` without wildcards (`rename user AS u`, `rename sourcetype AS "Source Type"`), and `lookup … OUTPUT <field> [AS <alias>]`. A lookup output that echoes the field the lookup matched on is that event field (`lookup t w AS user OUTPUT w` is `user`); any other output also reads the event fields the lookup matched on, so a lookup keyed on an identifier is treated like that identifier (`lookup … ip AS src_ip OUTPUT hostname` is redacted). The curated metadata of the App's own threat-intel lookups — their category, source and date added — keeps its own trace; their free-text notes inherit the match like any other output;
    - `eval <name>=<field>`, when the expression is one bare field name or one field reference in single quotes (`eval w=user`, `eval w='Authentication.user'`). A single-quoted token is only ever a field reference: it cannot hold a `|`, a bracket, a double quote or a line break, so a stray apostrophe can no longer hide the commands after it (and the allow-list refuses such a query outright);
    - a count: `count` or `c`, bare or as a call (`count(eval(action="failure"))`), the `count` and `percent` of `top` and `rare`, and `dc`, `distinct_count`, `estdc` or `estdc_error` over one field the App traces (`dc(user)`). Its values are counts, not identifiers. A distinct count of a field the query computes (`eval r=mvrange(0,len(user)) | stats dc(r)`) is not a count: it reads what that field reads.

    These steps chain as far as the query takes them, in the order Splunk runs them: `eval a=user | eval b=a | rename b AS c` leads `c` back to `user`. Every other construct leaves the column **untraced**, and with redaction on every value of an untraced text column arrives as a `<redacted-…>` tag, whatever it holds:

    - any other `eval` expression — string concatenation with `.` (`eval w=user."@".domain`), any function (`lower(action)`, `case(…)`, `coalesce(…)`, `substr(_raw,1,200)`), even a literal (`eval x="a"`);
    - `fieldformat`, which only changes how a value is displayed: the column stays untraced and reads both its earlier definition and the format expression;
    - the outputs of `rex` (named groups written `(?<name>…)`, `(?P<name>…)` or `(?'name'…)`), `spath`, `strcat`, `bin`, `convert` and `iplocation`, `transaction`'s `duration` and the totals of `addtotals`; and a field `makemv` cuts into pieces — by a delimiter or a `tokenizer` pattern, which extracts like `rex` — reading the field and the words of the delimiter or the pattern;
    - a wildcard `rename` or `AS` (`rename user* AS w*`, `stats values(*) AS *_x`) and a dynamic `eval` target (`eval {action}=…`);
    - the cells of a `chart`, `timechart` or `xyseries` split-by column, and every column of `transpose`, `untable` and `fieldsummary`, which mix the values of many fields;
    - a name defined in two different ways (for example once in the main search and once in a subsearch); a column that an `append`, `appendcols`, `join`, `union`, `multisearch`, `set` or `appendpipe` subsearch defines — a field it only passes through by its own name stays traced, and a subsearch that only filters (`index=x [search … | fields host]`) changes nothing; and a column the author text does not output;
    - every column after a command the App does not read in full: `lookup` without `OUTPUT`, `inputlookup` after the first command, a macro used as a command (a macro at the start of the query is read as the search), an `eval` or `rename` it cannot split, or — in the App's own catalog SPL — any command it does not know. The first command inside `appendpipe […]` is always read as a command, never as a search, so an unknown one there makes the columns untraced too. A free-form query cannot use a command the App does not read: every command on the allow-list (see the [Security Architecture](security-architecture.md)) is one the App reads in full.

    The limits on reading fail closed too: a text longer than 20,000 characters, more than 256 commands, subsearches nested more than 8 deep, or more than 12 wildcard definitions (wildcard renames and `AS`, dynamic `eval` targets — each one resolves through the ones before it) leave every column untraced. Stacked `appendpipe` groups are read in time proportional to their number, so they cannot freeze the browser tab either. A column traced to a count that holds text is redacted as well. So `stats count by action` sends the actions; `stats values(target_user) AS new_users` and `rename user AS u` are redacted as user names; and `eval stack=case(…)`, `rex "peer=(?<peer>\S+)"` and `eval w=action."-".status` are redacted although they hold no identifier. To keep values readable, aggregate the field by its own name. With PII redaction off, every column's values are sent, filtered and capped, traced or not.

- **Values of a column shown as `col_N`.** While PII redaction is on, every value of a categorical (text) column whose name is shown as `col_N` is redacted as an identifier and sent as a `<redacted-…>` tag, whatever the column holds; the App cannot tell from a placeholder whether its values are user names. A column whose name is sent is redacted unless it is traced to fields that mark no identifier, as above.
- **At most 30 columns** are summarized; the rest are reported as `R more columns not summarized.`.
- **Numeric values withheld.** With PII redaction on, a numeric column sends `values withheld` instead of its statistics, at any cardinality, when it is not a count and either its own name or a field its definition may read marks an identifier, or its values mix many fields (`transpose`, `untable`, `fieldsummary`). For a traced column those fields are its source fields; for an untraced one, every field its expression reads (`eval n=len(user) | stats avg(n) AS a` is withheld) — and after a command the App does not read in full, every word of the author text. A definition that reads more than 64 fields is taken to read every word of the author text, so that limit fails closed as well. The words of a `rex` pattern, of an `spath` path and of the quoted strings in an `eval` count as fields the column reads, so `rex "ssn=(?<n>\d{9})" | stats max(n) AS n` and `spath output=n path=user.id` are withheld; and a field set by `rex` or `spath` keeps its earlier value on the events where the pattern or the path does not match, so it reads both definitions. Every other numeric column keeps its statistics, untraced ones included (`rex "took (?<ms>\d+)" | stats avg(ms) AS a`), and so does a count (`dc(user) AS users`). A field marks an identifier when it matches a PII redaction pattern (below) or names an id: `id`, `uid`, `gid`, `guid`, `uuid`, `pid`, `ssn`, `iban`, `phone`, `msisdn`, `imsi`, `imei`, `acct` and account / card / employee / personnel numbers — as the whole name or its last part after `_`, `.`, `:` or `-` (`user_id`, `card_no`) — and camelCase names ending in `Id`, `ID`, `Sid`, `SID`, `Guid` or `GUID` (Windows `TargetUserSid`, `LogonGuid`). A column with a single distinct value also sends `values withheld`, whatever the redaction setting, when its name is withheld, or when it is not a count and marks an identifier or mixes many fields. A named single-value column such as `total_events` — usually the KPI the query asked for — still sends its value.
- **The time range.** The `Time range:` line is sent only when every `_time` value is a timestamp: an epoch in seconds (a number or a string of digits, from 1970 up to 2100-01-01) or a strict ISO-8601 timestamp with a zone (`Z`, `+hh:mm` or `+hhmm`) on a real calendar date. The App then writes both ends itself, as ISO-8601 UTC timestamps, and the line says so: `Time range: 2026-10-01T00:00:00.000Z → 2026-10-01T02:00:00.000Z (UTC).` No time zone from the data is sent. If any value is not a timestamp, the line reads `Time range: not shown (the _time values are not all timestamps).` and no `_time` text is sent. The range is also sent only when the author text traces `_time` — every definition of it — to a time source field: `_time` itself, or the epochs `bucket_ts` and `day_ts` of the App's rollups (`timechart`, `bin _time`, `tstats … by _time`, `stats latest(_time) AS _time`, `eval _time=bucket_ts`, `rename bucket_ts AS _time`, `bin bucket_ts span=1d AS _time`). A `_time` the query computes from other fields (`eval _time=len(src_ip)*100000000`, `eval _time=strptime(…)`, or a `bin` / `bucket` of another field into `_time`: `bin n span=1 AS _time`) reads `Time range: not shown (the query computes _time from other fields).` A result without a `_time` column, such as a `stats by …` aggregate, has no time-range line.
- **What the AI is told about these shapes.** The Tier 2 primer explains `col_N` and the withheld-names line, `<redacted-…>` tags, `values withheld`, `Returned a result that is not in row form` and `Time range: not shown`. It says that a tag is stable within the chat session only, and tells the model never to guess, recover or attribute what a placeholder or a tag stands for, to name a user, host, IP address or account only when that exact value appears in clear, and how to get readable values: re-query with `stats … by <field>`, aggregate a field by its own name rather than computing a new one, or write the values into its own query.

**What the naming rule withholds:** any name that neither Splunk, the model's query nor the App's catalog search wrote, and any name that does not have the shape — a name with spaces that the query does not quote right after `AS` (`eval "Source Type"=…`), an unaliased `count(eval(…))`, a nested call such as `upper95(prediction(count))`, a name over 40 characters. Besides split-by values, that includes fields a search returns without its text naming them — fields of raw events (`host`, `sourcetype` and the like, when the query does not write them), automatically extracted or `spath` fields, and the columns of an `inputlookup` that the search does not list. The AI can relate a placeholder to its own query's columns by position, but the primer tells it never to guess which value — which host, user or series — a `col_N` column stands for. A catalog trend split by a value is named only where its catalog search writes the value itself: the stacks of the cross-stack authentication-failure trend (`HANA`, `Windows`) are named, the host names of the noisy-hosts trend are not. The tiles in the results pane are not affected.

**What Tier 2 still sends from the events.** Tier 2 sends aggregated event values by design: the top-N values of every text column (with redaction on, of every traced column whose name is sent and whose fields mark no identifier), and the statistics of every numeric column that is not withheld — a column shown as `col_N` or untraced included. Redaction is decided by field names, so a value is sent as it is when its column is traced to a field named nothing like an identifier: an event field such as `message`, a lookup column that is not keyed on an identifier — or `_raw` itself, so a model can write `eval m=_raw` and receive up to 40 characters of an event. A number computed from event text is sent unless a field it reads marks an identifier. A name made only of words the model wrote is sent even if the model copied into its query a value it had seen; that text is the model's own. PII redaction is name-based hygiene for ordinary queries, not a content filter; where no event value may be sent, use Tier 1.

**PII redaction** (Tier 2 only, on by default): a field name marks an identifier in two ways.

- **The App's own fields, one by one.** Every field name the App defines — its extractions, aliases and calculated fields, its rollup columns and the columns of its lookups, about 440 names — has a class in a table the build checks: an identifier (user names, statements that name users such as `sql_statement` and `command`, the HANA audit target `object`, `identity`, `info_sid`, `supplied_by`, `fetched_by`, the topology `canonical_value` and `label`, the compliance rollup's `operator` and the topology rollup's `error_detail`), an address (`src`, `dest`, `local_ip`, `peer_ip`, `icm_peer_ip`, `ssl_peer_ip`, `remote_address`, the lastlog `FROM`, `fw_dst`, the topology rollups' `scope` and `spl_filter_clauses`, the HANA audit client host `src_host` and its extraction `audit_hostname`, the SAP Router target `saprouter_target_ip`, the gateway's `gw_remgw_target` and `gw_client_ip`, the RFC client's `gw_client_hostname`, …), a host name (`host`, `Computer`, `db_hostname`, `hana_host`, … — redacted only with the hostname opt-in), free text, or safe. The client host names `audit_hostname` and `gw_client_hostname` are classed as addresses, because a workstation's name can identify the person who uses it, so they are redacted by default, while a server's host name such as `db_hostname` is redacted only with the hostname opt-in. The `hostnames` column of the topology IP-enrichment lookup, which also holds client workstation names, stays a host name (see *What remains* below). The build fails if a new App field has no class, so no extraction ships unclassified, and it fails if a rollup column that a free-form query can read with `inputlookup` is classified weaker than the fields its rollup search writes into it directly; the check looks one step back, so a column filled through an intermediate field, such as `hostnames`, is not covered. The fields Splunk's automatic key-value extraction finds in the LogServ Linux events are classified too: pam's `rhost` (an address), `ruser`, `logname` and `euid`, and sudo's `PWD` and `COMMAND`.
- **Name patterns, for every name** (the App's and any other) — ignoring letter case, as the whole name or after `_`, `.`, `:`, `-` or a space: `email` or `emails`; `user`, `username`, `user_name`, `users` or `usernames` (and `"User Name"`); `src`, `source`, `client`, `remote`, `dest`, `destination` or `dvc` followed by `ip` or `addr`, with or without `_`, singular or plural (`src_ip`, `client_ips`, `remote_addr`, `dvc_ip`); any `ip`, `addr` or `address` — a bare `ip` and every `*_ip`, `*_addr` and `*_address` (`peer_ip`, `local_ip`, `"Client IP"`); the CIM `src`, `dest`, `dst` and `dvc` themselves, singular or plural, alone or followed by `_host` (`src`, `dests`, `src_host`, `fw_src`, `fw_dst`) — the App's own field aliases put client IP addresses and host names into `src` and `dest`; `peer` or `peers`; `mac` or `mac_addr`; `account`, `account_name` or `"Account Name"`; and, with the hostname opt-in, `host`, `hostname`, `host_name`, `"Host Name"`, `hosts` or `hostnames`. So `src_user`, `new_users` and the dotted data-model and JSON names `Authentication.user`, `All_Traffic.src_ip`, `All_Traffic.dest` and `event.user` all match. A camelCase name ending in `User`, `UserName` or `Email`, optionally plural, matches too (Windows `TargetUserName`, `SubjectUserName`; letter case counts here), and so does one ending in `Address`, `IpAddress`, `IPAddress` or `MacAddress` (Windows `IpAddress`) and — with the hostname opt-in — in `WorkstationName`, `HostName`, `ComputerName` or `MachineName`. The table only ever adds to the patterns.

A text column with such a field — or with an id-named one (above) — sends every value as a `<redacted-XXXXXXX>` tag, and a numeric one sends `values withheld`. These are not matched: `source`, `destination`, `src_port`, `dest_port`, `src_category`, `dvc_type`, `user_agent` and `sap_sid`; admins with strict postures should verify their own field names against the pattern list. The tag is the first 7 hex digits of a keyed hash (HMAC-SHA-256) of the value, under a random key the browser makes for each chat session and keeps in memory only; clearing the chat starts a new session with a new key, while closing and reopening the chat panel keeps the session and its key. So the same value gets the same tag within a chat session — the AI can still reason about cardinality and frequency — while tags of different sessions cannot be linked, and nobody without the key can recover a value by hashing candidates (every IPv4 address, short user names, SAP's standard users). Within a session the model can still compare tags, including tags of values it writes into its own query (see *What remains* below). While redaction is on it also redacts every value of a text column that is shown as `col_N` or is not traced to fields that mark no identifier (above). See [OWASP LLM Top 10 — LLM02](owasp-llm-compliance.md).

**What the AI does with this:** the AI can write data-grounded narrative replies — *"8 distinct users across 3 stacks, with up to 95 failures for one user on one stack and 2,214 in total; the user/stack pairs split 16 Windows, 16 HANA, 15 SAP, so no single stack dominates"*. The AI grounds its severity assessments in actual numbers instead of inferring from the shape of the result alone.

**Decision rule for picking Tier 2:**

- The customer's legal/security team has reviewed and approved exposing aggregate metadata (column cardinalities, top-N value distributions) to the AI vendor.
- The customer wants narrative replies with concrete values, not just shape descriptions.
- PII concerns are mitigated by the fail-closed, field-name-based redaction (or the customer is comfortable with the redaction's coverage).

**Audit trail:** every free-form prompt that completes — whichever tier is active — records one **`vendor_tier1`** audit event (the `vendor_tier2` category is declared but never emitted) including:
- Token counts (input + output)
- USD cost estimate
- Number of PII redactions applied (`tier2RedactionsApplied`): each redacted value (the values of a text column shown as `col_N` or untraced included) and each numeric column whose values are withheld under redaction — because a field it reads marks an identifier, or because it mixes many fields. A withheld column name is not counted. It is 0 in Tier 1, with redaction off, and in a Tier 2 prompt where nothing needed redacting
- The user identity that triggered the call

When elevating to Tier 2 in Settings (from Tier 0 or Tier 1), a `vendor_tier2_elevation` audit event captures the admin's identity and timestamp. See [Audit Log](audit-log.md).

### :material-circle-box:{ .taiconcolor } Known Gaps in Build 376: Closed, and What Remains { #known-gaps-in-build-376 }

Build 376 listed cases in which, with PII redaction on, Tier 2 could still carry an identifier or event text to the vendor, to be closed together with a list of the commands free-form queries may use. They are closed now:

- **The time range.** The range is sent only when `_time` is traced to `_time`, `bucket_ts` or `day_ts`; a `_time` the query computes from other fields reads `Time range: not shown (the query computes _time from other fields).`
- **Quoting.** A single-quoted token is only a field reference, so a stray apostrophe can no longer hide the commands after it from the App — and the allow-list refuses a free-form query whose single quotes do not each enclose a plain field name. A search term with an apostrophe goes in double quotes (`"don't"`).
- **Commands read too generously.** `rex` groups written `(?'name'…)` are read; `fieldformat` leaves the column untraced; a lookup output that echoes its match field is that field, and any other output reads the fields the lookup matched on; the first command inside `appendpipe […]` is always read as a command. `fieldformat`, `rangemap`, `foreach`, `mvexpand` and every other command the App does not read in full are not on the allow-list.
- **Field names the patterns missed.** Every field the App defines has a class, checked by the build, and the patterns now match every `*_ip`, `*_addr` and `*_address`, a bare `ip`, `user_name`, a bare `peer`, `dst` and a space as a separator (see PII redaction above).
- **Numbers.** The words of a `rex` pattern, an `spath` path and an `eval`'s quoted strings count as fields a column reads; `rex` and `spath` keep the earlier value where they do not match; a distinct count of a computed field is not a count; and `mvexpand`, which can manufacture rows from a value, is not on the allow-list.
- **The redaction tag** is a keyed HMAC per chat session instead of an unsalted 28-bit hash, so it can no longer be reversed by hashing candidates.
- **Usability and speed.** `top 10 uri` is read like `top limit=10 uri`; more than 12 wildcard definitions make every column untraced instead of freezing the browser tab; and a command the App does not read can no longer appear in a free-form query.
- **Found by the security review before release.** `makemv`, which cuts a field into pieces by a delimiter or a tokenizer pattern, was read as a command that changes nothing: it is now read like `rex`. A `bin` or `bucket` of another field into `_time` (`bin n span=1 AS _time`) kept the range: it now withholds it. Stacked `appendpipe` groups could freeze the browser tab: they are now read in linear time. Four rollup columns that hold user names or addresses — `operator`, `error_detail`, `scope`, `spl_filter_clauses` — were classified as safe or free text: they are identifiers and addresses now, and the build derives every rollup column's class from its rollup search. And several field names the LogServ sourcetypes carry — pam's `rhost` and `ruser`, sudo's `PWD` and `COMMAND`, Windows `IpAddress`, `TargetUserSid` and `WorkstationName` — are identifiers now. The allow-list also refuses three readings Splunk may not share: a backslash outside double-quoted text, a macro written against other text and a quoted value before a lookup's name (see [Free-form Prompts](free-form-prompts.md)).

**What remains.** Tier 2 sends aggregated event values by design, and the App's reading of a query is name-based hygiene, not a content filter:

- **Manufactured counts.** A count still carries a few bits that a query computes: `stats count by <a multivalue field computed from an identifier>` followed by `stats count`, or the count of rows a filter on an identifier keeps. Counts are not traced to the fields that shaped them. This is documented rather than closed; where it matters, use Tier 1.
- **Fields named nothing like an identifier.** A value is sent in clear when its column is traced to a field that neither the App's table nor the patterns mark — an event field such as `message`, a field another app extracts, a field Splunk's automatic key-value extraction finds under a name the App does not know, or `_raw` (up to 40 characters).
- **Workstation names in the topology IP enrichment.** The `hostnames` column of `logserv_topology_ip_enrichment`, which a free-form query can read with `inputlookup`, holds the host names of client workstations (HANA clients and Windows `WorkstationName`). It is classed as a host name, so Tier 2 redacts it only with the hostname opt-in. Turn the opt-in on, or use Tier 1, where those names must not reach the vendor.
- **Text the model wrote.** A column name or a value made only of words the model wrote in its query is sent, even if the model copied a value it had seen into the query.
- **Confirming a guess within a chat session.** The model can test identifiers it guesses. A name made of its own words is sent, so a query that filters on guessed user names and splits by `user` (`user="alice" OR user="bob" … | timechart count by user`) returns, as column names, exactly the guesses that exist in the data. And a tag is the same for the same value within a chat session, so a column of values the model writes into its own query (`eval guess="jsmith"`) carries the same tags as the real values. The keyed tag stops anyone without the key from reversing tags offline; it does not stop the model from comparing tags online within the session. Where that matters, use Tier 1.
## :material-circle-box:{ .taiconcolor } How the Privacy Invariant Is Enforced

The privacy invariant — *no raw event and no unsummarized tool result leaves the customer's environment for the AI vendor* — is enforced mechanically at build time via TypeScript brand types. Tool-result values from the MCP server carry one type; outbound vendor messages carry a different type; the compiler refuses to assign one to the other. The only conversion path is the active tier's summarizer: in Tier 1 it produces two numbers, in Tier 2 the aggregated metadata described above, which includes values from the events. The type system guarantees that every result goes through a summarizer; the rules above decide what each summarizer may say. A type cannot tell an error message from data, so the summarizers do not pass error text on at all: a failed call's summary is one of a fixed set of App-written strings, chosen by its HTTP status and error class (see [Failed Tool Calls](#failed-tool-calls-every-tier)).

This is the primary defense against [LLM02 — Sensitive Information Disclosure](owasp-llm-compliance.md). For the brand-type mechanism, summarizer call sites, and the `<TOOL_RESULT_DATA>` sentinel pattern, see [AI Assistant Implementation Reference](../developer/ai-assistant-internals.md).

## :material-circle-box:{ .taiconcolor } Switching Tiers

Tier is configured in [Settings → General](settings.md). Switching tiers takes effect on the **next** vendor call — in-flight calls complete with the previously active tier. Note the emitted `vendor_tier1` event does not carry the active tier: the tier in force at a given time is derivable only from the Settings history (`vendor_tier2_elevation` events) plus a non-zero `tier2RedactionsApplied`.

**Elevating from Tier 1 → Tier 2:**

1. Open Settings → AI Assistant → General.
2. Change the **Tier** field from 1 to 2.
3. Click Save Defaults. The save records a `vendor_tier2_elevation` audit event with admin identity + timestamp.
4. Optionally enable / disable PII redaction (default: enabled) and toggle hostname-as-PII (default: hostname NOT redacted, since it's often non-sensitive in SAP environments).

**Lowering from Tier 2 → Tier 1 / Tier 0:**

1. Same path. A downgrade produces **no audit event and no conf-change record** — settings persist to the `logserv_ai_assistant_settings` KV Store collection, so only elevation to Tier 2 is audited (`vendor_tier2_elevation`).
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
