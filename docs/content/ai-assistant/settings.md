# Application Settings

The **Application Settings** page holds the LogServ App's admin settings. Open it with **Settings** in the LogServ App's navigation rail (near the bottom, above **About**); its URL is `#/settings` inside the App, and the old `#/settings/ai-assistant` URL still opens it. The page has two tabs:

- **AI Assistant**: everything that governs the AI Assistant, on four sub-tabs (below). To turn the AI Assistant on for the first time, follow [Set Up the AI Assistant](enable.md).
- **Dashboard Data**: the KV Store rollups behind every dashboard and the Environment Topology view: backfill, late-arriving data, retention and clear. See [Dashboard Data: Backfill and Freshness](../logserv-app/dashboard-data.md).

```
Application Settings
+-- AI Assistant              (top-level tab)
|   +-- General               (sub-tab)
|   +-- Provider Credentials  (sub-tab; hidden while Templates-only mode is on)
|   +-- Splunk MCP            (sub-tab)
|   +-- Audit Log             (sub-tab)
+-- Dashboard Data            (top-level tab)
```

![Application Settings — two-level tab hierarchy (AI Assistant ▸ General sub-tab)](../../images/settings-general.png)

## :material-circle-box:{ .taiconcolor } The Two Top-Level Tabs

| Tab | Scope |
|---|---|
| **AI Assistant** | Everything specific to the AI Assistant feature, split across four sub-tabs (below). |
| **Dashboard Data** | App-wide admin controls for the KV Store rollup data layer that powers every dashboard **and** the Environment Topology view: the aggregation master switch, retention, the backfill, per-rollup status and clear ([see below](#dashboard-data-tab)). |

### AI Assistant sub-tabs

| Sub-tab | Scope |
|---|---|
| **General** | Org-wide AI Assistant defaults: on/off, Templates-only mode, provider, model, privacy tier, the MCP gate, server URL and timeout, rate limit, spend cap, Power Mode roles, the audit index and the audit forwarder |
| **Provider Credentials** | LLM provider credentials (Anthropic / OpenAI / Azure OpenAI / AWS Bedrock). Hidden while **Templates-only mode** is on, and in a compile-time [templates-only build](templates-only-build.md) |
| **Splunk MCP** | The MCP Server bearer token and the audit forwarder's HEC token |
| **Audit Log** | Read-only browser of the audit events in the `logserv_ai_assistant_audit` index |

While **Templates-only mode** is on, an info banner at the top of the **AI Assistant** tab says that the provider, model, tier and Power Mode fields have no effect.

## :material-circle-box:{ .taiconcolor } Who Can Open the Page { #who-can-open-the-page }

The LogServ App treats a user as an admin only when one of their roles is named exactly `admin`, `sc_admin` or `sc_subadmin`. Only those users see **Settings** in the navigation rail. Anyone else who opens `#/settings` gets **403 — Admin access required**, and cannot change the AI Assistant settings or run **Dashboard Data** Clear and Backfill. A delegated-admin role with any other name, on Splunk Cloud Platform or Splunk Enterprise, is not recognized; give such users one of the three roles itself (whether a role that only imports one of them is enough has not been tested). The page's own checks are not the security boundary: the KV Store collections and the knowledge objects behind it accept writes only from the same three roles (below).

### Where the AI Assistant settings are stored

The **General** sub-tab's settings and the state of the two legal acknowledgements live in KV Store collections of the LogServ App, not in `.conf` files:

- `logserv_ai_assistant_settings`: one row, keyed `defaults`, holding every **General** setting.
- `logserv_ai_assistant_acks`: one row per acknowledgement, holding the version last answered, the answer and its time. An acknowledgement is recorded once for the deployment, not per user; the audit event records who answered.
- `logserv_ai_models`: the discovered-model cache ([How model discovery works](#how-model-discovery-works)).

All three ship with `read : [ * ]`, because every page load reads them, and `write : [ admin, sc_admin, sc_subadmin ]` in the App's `metadata/default.meta`. Writing a KV Store row needs only that collection-level permission, not `admin_all_objects`, so a delegated admin role without `admin_all_objects` (common on Splunk Cloud Platform) can still click **Save Defaults** and answer the acknowledgements. The shipped `default/ai_assistant_settings.conf` holds the defaults the App uses until the first save. On the first page load by an admin-tier user, the App copies any values left in `local/ai_assistant_settings.conf` and `local/ai_assistant_acks.conf` by an older build into these rows.

The dashboard rollup, Environment Topology and platform-snapshot collections take writes from the same three roles, which is why **Dashboard Data** Clear and Backfill need one of them; the scheduled searches that fill those collections run as Splunk's system user.

## :material-circle-box:{ .taiconcolor } General Tab

The **General** sub-tab is divided into five sections: **Feature**, **Limits & Quotas**, **Privacy**, **Power Users** and **Audit & Telemetry**. Each table below lists the settings by their label on screen, then the key they are stored under (the same key as in `default/ai_assistant_settings.conf`).

On a fresh install, the settings that matter for the predefined prompts are the **Enable AI Assistant** and **Templates-only mode** switches, the MCP rows and **Audit & Telemetry**. The provider, model, tier, **Limits & Quotas**, **Privacy** and **Power Users** settings govern free-form questions only, so they have nothing to govern until an admin selects a provider and stores its credential.

The **Save Defaults** button, at the bottom, is active once something has changed; **Revert** discards the unsaved changes. **Save Defaults** records an audit event in three cases: a save that raises **Privacy Tier** to 2 (`vendor_tier2_elevation`; no dialog asks first), and an answer, Yes or No, to either acknowledgement dialog (`ai_assistant_enable_acceptance`, `forwarder_disabled_acceptance`). Other saves record none.

### Feature

| Setting | Key | Default | What it does |
|---|---|---|---|
| **Enable AI Assistant** | `enabled` | Off | Master switch. When off, the **AI Assistant** button is hidden for every user and the MCP check never runs. Every save that turns it on opens the [liability acknowledgement](#legal-acknowledgement-modals) first. |
| **Templates-only mode** | `templates_only_mode` | Off (reads **Full LLM path**) | When on, the free-form, LLM-driven path is off at run time: the chat input is read-only, the model picker and the Power Mode toggle are hidden, the **Provider Credentials** sub-tab is hidden, and an info banner explains the mode. The predefined prompts, the Splunk MCP Server integration and the audit log stay active, and so does **Model discovery** while it is on (a metadata-only call to the active provider's model-listing API). Any admin can turn it off again. In a compile-time [templates-only build](templates-only-build.md) this row is hidden and the mode is always on. |
| **Active Provider** | `provider` | Mock (development only) | The LLM vendor every user's free-form questions go to: **Mock (development only)**, **Anthropic (Claude)**, **OpenAI (GPT)**, **Azure OpenAI**, **AWS Bedrock (Claude)** or **Ollama (Tier 0 — local)**. Mock contacts no vendor and gives a canned reply. **Do not select Ollama in this release:** it runs the Mock provider ([Privacy Tiers](privacy-tiers.md#tier-0-and-the-ollama-provider-do-not-select)). |
| **Default Model** | `default_model` | `mock-fast` | The model selected when a user opens the AI Assistant. The list is the provider's curated models plus any discovered ones ([How model discovery works](#how-model-discovery-works)); each user's picker in the chat panel switches within the same list. |
| **Model discovery** | `model_discovery_enabled` | On | Lets the model lists refresh from the vendor's own model-listing API. When off, the App never calls a vendor model-listing endpoint and the pickers offer the curated list only. Hidden in a compile-time templates-only build. |
| **Discovered models** | — | — | Status row, shown while **Model discovery** is on: how many models were discovered for the active provider, when the list was last fetched, and the error of the last failed refresh, with a **Refresh model list** button. |
| **Privacy Tier** | `tier` | Tier 1 | What a free-form vendor call may carry about your data: [Privacy Tiers](privacy-tiers.md). **Do not select Tier 0 in this release:** it summarizes like Tier 1 and still sends to the selected provider. Raising the tier to 2 records a `vendor_tier2_elevation` audit event. |
| **MCP Required** | `mcp_required` | On (reads **Required**) | When on, the chat waits for the MCP health check. When off, the AI Assistant runs in MCP-less chat mode: LLM streaming with no searches and no prompt browser ([Splunk MCP Setup](mcp-setup.md#mcp-less-chat-mode)). |
| **MCP Server URL** | `mcp_server_url` | blank | The MCP endpoint. Blank uses `/en-US/splunkd/__raw/services/mcp` on this Splunk instance. See [Splunk MCP Setup](mcp-setup.md). |
| **MCP request timeout (seconds)** | `mcp_timeout_seconds` | `60` | How long the browser waits for each MCP request (a search, a saved-search run, the health check) before it aborts it. If a slow prompt shows `signal is aborted without reason`, raise it. The MCP Server has its own timeout (next row), and the lower of the two applies, so to let a search run past 60 seconds raise both. Range `5`–`600`. |
| **MCP server timeout (read-only)** | — (`mcp.conf [server] timeout` of the MCP Server app) | — | Shows the Splunk MCP Server's own request timeout next to the client timeout, or **Not detected** when the MCP Server is not installed or reachable. To change it, edit the MCP Server app's `mcp.conf` and restart Splunk: that app caches the value in a persistent process, so it cannot be changed from here. |

### Limits & Quotas

| Setting | Key | Default | What it does |
|---|---|---|---|
| **Rate limit (free-form prompts/hour)** | `rate_limit_per_hour` | `30` | Per-user limit on free-form prompts in a rolling hour. Predefined prompts never count. `0` turns it off. Maps to [LLM10](owasp-llm-compliance.md). |
| **Session tool-call cap** | `tool_calls_per_session_cap` | `100` | Per-chat-session limit on searches the AI may run (saved searches and ad-hoc queries together), above the per-message limit of 8 tool turns. Clearing the chat starts a new session. `0` turns it off. Maps to [LLM06](owasp-llm-compliance.md). |
| **Daily spend cap (USD)** | `daily_spend_cap_usd` | `50.00` | Per-user daily limit on estimated free-form vendor spend (from token counts). The tally resets at local midnight; the prompt that crosses the cap still completes. `0` turns it off. Maps to [LLM10](owasp-llm-compliance.md). |

### Privacy

| Setting | Key | Default | What it does |
|---|---|---|---|
| **Tier 2 PII column redaction** | `tier2_pii_redaction` | On (reads **Redact identifiers**) | In Tier 2, redacts the values of identifier columns before they are sent to the LLM. Every field the App defines is classified one by one (user names, statements that name users, addresses, and host names with the hostname opt-in), and name patterns cover every other field: `email`, `user(name)` and `user_name` and their plurals, every `*_ip`, `*_addr` and `*_address` and a bare `ip`, the CIM `src`, `dest`, `dst` and `dvc`, `peer`, `mac`, `account`, camelCase `…User` / `…UserName` / `…Email`, and id names such as `user_id`, also after `.`, `:`, `-` or a space as in `Authentication.user` ([Privacy Tiers](privacy-tiers.md) has the exact rules). It fails closed: a text column's values are sent in clear only when the App can trace the column through the SPL to fields that mark no identifier. `values(user)` or an alias of `user` count as `user`, and a pivot's text cells or a column computed by an `eval` expression, `rex`, `spath` or any other construct the App does not trace are redacted whatever they hold. Each value becomes a `<redacted-XXXXXXX>` tag, a keyed hash under a random key per chat session: the same value keeps its tag within a chat session, so cardinality reasoning still works, and tags cannot be linked across sessions or reversed by hashing candidates. While on, it also redacts every value of a text column shown as `col_N`, and sends `values withheld` for numeric columns whose name or a field they read marks an identifier, or that mix many fields. Column names are withheld as `col_N` whatever this setting, unless Splunk generates them or the query wrote every word of them. No effect in Tier 0 or Tier 1. |
| **Tier 2 hostname redaction** | `tier2_redact_hostnames` | Off (reads **Send hostnames**) | Also redacts host-name columns under the Tier 2 rule. Off by default, since host names are often not sensitive in SAP environments. Can be changed only while **Tier 2 PII column redaction** is on. |

### Power Users

| Setting | Key | Default | What it does |
|---|---|---|---|
| **Power Mode roles** | `power_user_roles` | empty | The Splunk roles whose members see the `✦ Power` toggle in the chat input ([Power Mode](power-mode.md)). Empty hides the toggle for everyone. The list offers the roles defined on this Splunk instance. |

### Audit & Telemetry

| Setting | Key | Default | What it does |
|---|---|---|---|
| **Audit index name** | `audit_index_name` | `logserv_ai_assistant_audit` | The index that receives audit writes. Rename it together with the `sap_logserv_audit_idx_macro` macro, which controls reads ([Renaming an index](../install-setup/install-ta.md#renaming-an-index)). |
| **Audit log forwarder** | `audit_forwarder_enabled` | Off (reads **Local-only**) | When on, every audit event is also sent to the HEC endpoint below, on a separate Splunk instance or SIEM, for tamper-evidence. The destination HEC must allow cross-origin requests from this Splunk Web address. Saving with it off opens the [audit-log integrity acknowledgement](#legal-acknowledgement-modals) until that is answered at its current version. See [Audit Log → HEC Forwarder](audit-log.md#hec-forwarder). |
| **Forwarder HEC URL** | `audit_forwarder_url` | blank | HEC base URL, for example `https://siem.example.com:8088`; the App appends `/services/collector/event`. Required when forwarding is on. |
| **Forwarder remote index (optional)** | `audit_forwarder_index` | blank | Index on the destination. Blank uses the HEC token's default index. |
| **Forwarder source field** | `audit_forwarder_source` | `logserv_ai_assistant_remote` | `source` of every forwarded event, distinct from the local copies (sourcetype `logserv:ai_assistant:audit`), so the two can be told apart. |

## :material-circle-box:{ .taiconcolor } How Model Discovery Works

!!! note "Needs a configured provider credential"
    Model discovery queries the configured provider, so it does nothing useful until a credential is configured. It is **inert in a compile-time [templates-only build](templates-only-build.md)**: no vendor model-listing call is ever made there, and its rows are hidden.

The model pickers (the **Default Model** setting and the chat panel's per-user picker) offer a **merged model list** per provider: a curated static baseline **plus** models discovered live from the configured vendor.

**What discovery calls.** Discovery is a **metadata-only GET** against the vendor's model-listing endpoint, with the same credential and in the same trust envelope as the credential check. No prompt text, no Splunk event data and no aggregates are involved; the request and response carry model metadata only.

| Provider | Discovery source |
|---|---|
| Anthropic | `GET /v1/models` (paginated; display names and context windows carried through) |
| OpenAI | `GET /v1/models`, filtered to chat-capable families, with dated snapshots collapsed onto their alias |
| Azure OpenAI | Three-step deployment discovery: `/openai/v1/models` → `/openai/deployments` → the deployment name(s) configured on the Provider Credentials sub-tab |
| AWS Bedrock | `ListFoundationModels`, filtered to Anthropic / on-demand / text / streaming / active |
| Mock | A synthetic `mock-discovered` entry (for testing with no key) |

**When it refreshes.** Three triggers, all governed by **Model discovery**:

1. **Credential save**: saving a provider credential on the Provider Credentials sub-tab refreshes that provider's list immediately.
2. **Manual**: the **Refresh model list** button on the General sub-tab.
3. **24-hour TTL**: opening the chat panel refreshes the active provider's list if the cached copy is older than 24 hours (at most once per page load, never for the Mock provider, and never if the panel is not opened).

**Where the list lives.** Discovered lists are cached in the `logserv_ai_models` KV Store collection (one row per provider: the sanitized model list, fetch time, fetching user and last error). Model ids and labels are allowlist-sanitized on write **and** on read, and the static baseline always survives the merge, so a poisoned or malformed cache entry cannot remove the known-good models.

**Failure behavior.** A failed refresh keeps the row's last good models and timestamp and only updates the error text (shown on the **Discovered models** row). The picker never shrinks below the static baseline.

**Audit trail.** Every refresh, success or failure, from any trigger, writes a **`model_discovery`** audit event (provider, trigger, ok, model count, duration, error), browsable on the Audit Log sub-tab.

**Cost estimates stay honest.** The vendor cost table used for spend tracking is keyed by exact model id. A discovered model with no known price reports **$0**; the App never guesses a price from an id prefix. The **Daily spend cap (USD)** therefore only counts models with known pricing. The Claude 5.x models (`claude-opus-5-5`, `claude-opus-5`, `claude-sonnet-5-5`, `claude-sonnet-5`, `claude-fable-5-1`, `claude-fable-5`, `claude-haiku-5-5`) are priced at Anthropic's published first-party rates, cache reads and writes included, so their turns count toward the cap. `claude-haiku-5-5` is priced at its rate for prompts up to 100K tokens; a longer prompt costs more than the estimate. Bedrock prices are set by AWS, so the App's AWS Bedrock entries are not derived from these rates.

**How to turn it off.** Clear **Model discovery** on the General sub-tab and save. From then on the App makes **no** vendor model-listing calls (all three triggers are gated), and the pickers offer the curated list only. Cached rows in `logserv_ai_models` are ignored while it is off and overwritten on the next refresh if it is turned on again.

## :material-circle-box:{ .taiconcolor } Provider Credentials Tab

!!! note "Hidden while Templates-only mode is on"
    This sub-tab is hidden while **Templates-only mode** is on and in a compile-time [templates-only build](templates-only-build.md); no LLM provider is used there. Otherwise, storing a credential here is what gives free-form questions a real LLM.

One panel per provider, each with that provider's credential fields. Credentials are stored in Splunk's encrypted password store through `/servicesNS/nobody/<app>/storage/passwords`; the page shows only whether a value is stored, its length and, for some fields, its first characters, never the cleartext.

| Panel | Fields (realm `logserv_ai_assistant_<provider>`, name) |
|---|---|
| **Anthropic** | **API Key** (`anthropic`, `api_key`) |
| **OpenAI** | **API Key** (`openai`, `api_key`) |
| **Azure OpenAI** | **API Key** (`azure_openai`, `api_key`), **Endpoint URL** (`endpoint`), **Deployment Name** (`deployment`) |
| **AWS Bedrock** | **API Key** (`bedrock`, `api_key`), **AWS Region** (`region`). Bedrock API keys only; IAM credentials are not supported. |
| **Ollama (Tier 0 — air-gapped local)** | **Base URL** (`ollama`, `url`). Not used in this release: the Ollama provider runs Mock. |

**Storing a credential:**

1. Find the provider's panel and type or paste the value into the field.
2. Click **Save** (**Update** when a value is already stored). The value goes to Splunk's encrypted password store, and the row then reads **Stored: length N**.

**Removing a credential:** click **Clear** next to the field and confirm.

Saving a credential records no audit event itself. When **Model discovery** is on, saving a field of the Anthropic, OpenAI, Azure OpenAI or AWS Bedrock panel starts a refresh of that provider's model list, which records a `model_discovery` event (trigger `credential_save`).

If **Active Provider** names a provider whose credential is not stored, the first free-form question fails with `Required credential not set: logserv_ai_assistant_<provider>:<field>`.

Each user's browser reads the provider credential from Splunk's password store when that user sends a free-form question, so a user whose role cannot read stored passwords (Splunk's `list_storage_passwords` capability, which `admin` holds) gets an error instead of an answer.

## :material-circle-box:{ .taiconcolor } Splunk MCP Tab

![Settings — Splunk MCP tab](../../images/settings-mcp.png)

Two panels:

### Splunk MCP Server

| Field | Realm | Name |
|---|---|---|
| **Bearer Token** | `logserv_ai_assistant_mcp` | `bearer_token` |

An OAuth/JWT token issued for your Splunk MCP Server, pasted by an admin. **Optional**: by default the App authenticates to the MCP Server with the user's own Splunk Web session cookie. See [Splunk MCP Setup → Authentication](mcp-setup.md#authentication).

### Audit Log Forwarder

| Field | Realm | Name |
|---|---|---|
| **HEC Token** | `logserv_ai_assistant_forwarder` | `hec_token` |

The HEC token for forwarding audit events to a separate Splunk instance or SIEM. The destination URL and the on/off switch are on the General sub-tab under **Audit & Telemetry**. The token is sent on every forwarded audit event as `Authorization: Splunk <token>`. See [Audit Log → HEC Forwarder](audit-log.md#hec-forwarder).

## :material-circle-box:{ .taiconcolor } Audit Log Tab

![Settings — Audit Log tab](../../images/settings-audit.png)

Read-only browser of every event in the `logserv_ai_assistant_audit` index. The tab searches the index as the signed-in admin, whose role must allow it ([Restricting who can read the audit index](audit-log.md#restricting-who-can-read-the-audit-index)). The search window is the global time range in the header: the viewer re-runs on every change, and there is no separate time-range control. Filters: a category multi-select (13 categories: `local_only`, `vendor_tier1`, `vendor_tier2`, `security_blocked_spl`, `rate_limited_prompt`, `user_prompt_jailbreak_flag`, `session_tool_cap_hit`, `daily_spend_cap_hit`, `audit_forwarder_failure`, `vendor_tier2_elevation`, `forwarder_disabled_acceptance`, `ai_assistant_enable_acceptance`, `model_discovery`), a user-contains text filter, and a result limit (50 / 100 / 250 / 500, default 100).

Clicking a row's **+** button shows the full event JSON. The table shows 25 rows per page; a "Showing N-M of T events" line sits above it, and "Page X of Y" with Previous / Next buttons below it when T is over 25.

**Tamper-resistance disclaimer** at the top of the panel:

> Audit events live in a Splunk index. A host-root admin can edit the bucket files. Mitigation: forward audit events to a separate Splunk instance / SIEM / S3-with-Object-Lock owned by a different admin team. Configure the HEC forwarder under Settings → General → Audit & Telemetry.

See [Audit Log](audit-log.md) for the threat model and the forwarder.

## :material-circle-box:{ .taiconcolor } Dashboard Data Tab

The **Dashboard Data** top-level tab is the admin control surface for the KV Store rollup layer behind every dashboard **and** the Environment Topology view: the hourly-aggregation master switch, the 365-day retention, the backfill, the late-arriving data check, a per-rollup status and action table, and a global clear. Its Clear and Backfill need one of the three admin role names ([Who can open the page](#who-can-open-the-page)).

It manages the dashboard data layer, not the AI Assistant, so its controls are documented with that layer: **[Dashboard Data: Backfill and Freshness → The Dashboard Data settings tab](../logserv-app/dashboard-data.md#the-dashboard-data-settings-tab)**. On a fresh install, run its backfill once: [Backfilling on first install](../logserv-app/dashboard-data.md#backfilling-on-first-install).

A read-only view of the same rollup health, freshness and 30-day-history completeness, is available to **every** user on the **[Data Doctor's Diagnostics page](../logserv-app/dashboards/platform/diagnostics.md)** (*Platform → Diagnostics*), which points back here for the backfill and clear controls.

## :material-circle-box:{ .taiconcolor } Legal Acknowledgement Modals

Two legal acknowledgements gate the General sub-tab's **Save Defaults**. Both follow Splunk's `splunk_instrumentation` `optInVersion` pattern: each has a version (`optInVersion` in the App's `default/ai_assistant_acks.conf`), the deployment records the version it last answered and the answer (in the `logserv_ai_assistant_acks` KV Store collection), and raising the version asks again. Both answers, Yes and No, are recorded, and each answer also writes an audit event with the admin's user name, the network address Splunk records for the request (`host`), the time, and the SHA-256 of the acknowledgement text.

On a fresh install, the first **Save Defaults** that turns the AI Assistant on shows both, the liability terms first ([Set Up the AI Assistant](enable.md#4-turn-on-the-ai-assistant-and-answer-both-acknowledgements)). If an answer cannot be recorded, or the save after a Yes fails, the dialog closes and the error shows on the page.

### "AI Assistant — Liability terms" Dialog (orange-bordered) { #enable-acceptance-modal-orange-bordered }

The **AI Assistant — Liability terms** dialog opens:

- on every save that turns **Enable AI Assistant** on, whatever was answered before; and
- on a save while the AI Assistant is on, when its terms are at a newer version than the one last answered on this deployment (the current version is 3).

The text has seven clauses: data egress acknowledgement, customer responsibility, AS-IS warranty disclaimer, indemnification, limitation of liability, authority warrant, and record of acknowledgement. Its **Active LLM provider** line names the provider in effect and, when the same save also changes the provider, the one a Yes saves.

- **I accept (record Yes and enable):** the save goes ahead (with the second acknowledgement first, when it is due) and the version is recorded as answered. An `ai_assistant_enable_acceptance` audit event records the answer.
- **I do not accept:** the save stops. An AI Assistant being turned on stays off. One that is already on (asked again after a version change) is turned off: only **Enable AI Assistant** changes, nothing else in that save, and it is written before the No is recorded, so if turning it off fails, nothing is recorded and the question comes back at the next save. Turning it on again asks every time.

### "Audit log integrity" Dialog (red-bordered) { #forwarder-disabled-acceptance-modal-red-bordered }

The **Audit log integrity** dialog opens:

- on every save that turns **Audit log forwarder** off; and
- on a save with the forwarder off, when its terms are at a newer version than the one last answered on this deployment (the current version is 2).

The text covers the integrity responsibility: with the forwarder off, the audit events exist only in the local index, which a host-root admin can edit.

- **I accept (record Yes and save):** the save goes ahead with forwarding off.
- **I do not accept (record No):** the save stops and the forwarder setting stays as it was, but the answer is recorded, so the next save does not ask again unless forwarding is turned from on to off.

Its `forwarder_disabled_acceptance` audit event is posted as soon as the answer is recorded, for either answer, so a Yes is logged even when the save after it fails. The event goes where the audit settings in place at that moment send it: when the same save turns forwarding off, it is also sent to the forwarder being turned off, and if that send fails, its `audit_forwarder_failure` record goes to the event's audit index.

### Why the hybrid trigger logic

Version-only gating (answer once, never asked again until the version changes) is what Splunk's own telemetry uses. The App also asks on every deliberate turn-on of the AI Assistant and every deliberate turn-off of the forwarder, because each is a change of the legal and security posture that may be made by a different admin, with different context, than the last one.

## :material-circle-box:{ .taiconcolor } Live UI Refresh on Save

When a save changes what users see (**Enable AI Assistant**, **MCP Required**, **Power Mode roles**, **Templates-only mode** and the like), the App applies the new settings to the running page without a reload: turning the AI Assistant off removes the **AI Assistant** button, and turning it on shows it. Other users' open pages pick the change up at their next page load. For the callback wiring, see [LogServ App and AI Assistant Internals](../developer/ai-assistant-internals.md).
