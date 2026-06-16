# Installing the Data TA

This page covers installing the **Data TA** (`splunk_ta_sap_logserv`). For the LogServ App installation, see [Installing the LogServ App](../logserv-app/installation.md).

### :material-circle-box:{ .taiconcolor } High Level Steps

Below are the high level steps for installing the Data TA. Follow them in order.

:material-lightning-bolt:{ .taiconcolor } Steps 4 and 5 are alternative paths — complete the one that matches your Splunk environment.

1. Create a default events index
2. Download the Data TA
3. Identify where to install the Data TA based on your topology
4. Install the Data TA in Splunk Cloud (if applicable)
5. Install the Data TA in Splunk Enterprise (if applicable)

<br>

### :material-circle-box:{ .taiconcolor } 1. Indexes (auto-created on install)

The Data TA ships with `default/indexes.conf` defining two indexes that Splunk auto-creates the first time the Data TA loads on an indexer:

| Index | Purpose | Default name | Macro |
|---|---|---|---|
| **SAP data index** | Receives every event the Data TA forwards (logs ingested from S3 and routed to the appropriate sourcetype) | `sap_logserv_logs` | `sap_logserv_idx_macro` |
| **AI Assistant audit index** | Receives every audit event the AI Assistant writes — canned-prompt dispatches, free-form vendor calls (when LLM path is enabled), security blocks, privacy-tier elevations, legal acknowledgements | `logserv_ai_assistant_audit` | `sap_logserv_audit_idx_macro` |

No customer-side index provisioning is required for the default install.

!!! note
    Both the Data TA and the LogServ App include a macro named **sap_logserv_idx_macro** that resolves to `index="sap_logserv_logs"`. The LogServ App also includes **sap_logserv_audit_idx_macro** for the audit index. If you use a different index name, follow the [Renaming an index](#renaming-an-index) procedure below.

#### :material-crop-square:{ .taiconcolor } Renaming an Index

Both indexes are macro-configurable, so customers who need different names (e.g., a corporate naming convention) don't have to fork the app — they update the macros (and, for the audit index, one config field).

##### To rename the SAP data index

1. **Pick a new name** (e.g., `splunk_audit_my_org_sap`).
2. **Create the index** under that new name. Either:
    - Add a custom `local/indexes.conf` to the Data TA with a stanza for your new name (`[my_new_index_name]` plus the same `homePath` / `coldPath` / `thawedPath` settings), OR
    - Create the index manually through Splunk Web's **Settings → Indexes → New Index** UI. (See <a href="https://help.splunk.com/en/splunk-cloud-platform/administer/admin-manual/9.3.2411/manage-your-indexes-and-data-in-splunk-cloud-platform/manage-splunk-cloud-platform-indexes" target="_blank">Splunk Cloud</a> or <a href="https://docs.splunk.com/Documentation/Splunk/9.4.2/Indexer/Setupmultipleindexes#Create_events_indexes" target="_blank">Splunk Enterprise</a> docs.)
3. **Update the macro definition.** Open **Settings → Advanced search → Search macros**, find `sap_logserv_idx_macro`, and edit the definition from `index="sap_logserv_logs"` to `index="my_new_index_name"`.
4. **Redirect the ingest pipeline** to the new index name. The actual `index = ...` setting that determines where ingested events land lives in the **Splunk_TA_aws** add-on's S3 input config (the SQS-based S3 inputs that own the data ingest path), NOT in this Data TA. Update each `filtr2_logserv_s3_*` input's `index` field to point at the new name. See [AWS Remote S3 Filter Setup Guide](aws-remote-s3-filter-guide.md) for where these inputs are configured.

The Data TA's default `[sap_logserv_logs]` stanza will still create that index unless you remove or override it via your custom `local/indexes.conf`. If your environment doesn't need the default, that's harmless; if it bothers you, override the stanza locally.

##### To rename the AI Assistant audit index

1. **Pick a new name** (consider keeping the underscore prefix — Splunk uses underscore-prefixed names for internal / operational indexes, and excludes them from default-index searches).
2. **Create the index** under that name (same options as above — local indexes.conf override, OR Splunk Web Settings UI).
3. **Update the macro definition.** Open **Settings → Advanced search → Search macros**, find `sap_logserv_audit_idx_macro`, and edit the definition from `index="logserv_ai_assistant_audit"` to `index="<your_new_name>"`. This controls READS — the in-app Audit Log Viewer + any user-written queries will resolve the macro to your renamed index.
4. **Update the LogServ App config.** Open **Settings → AI Assistant → General → Audit & Telemetry**, set the **Audit index name** field to your renamed index, and Save Defaults. This controls WRITES — the AuditWriter posts events to the configured index name.

The conf field controls writes; the macro controls reads. They MUST point at the same index, but Splunk doesn't auto-sync them — keep them aligned manually whenever you rename.

<br>

### :material-circle-box:{ .taiconcolor } 2. Download the Data TA

Download `splunk_ta_sap_logserv-0.0.6.0.tar.gz` from the <a href="https://github.com/splunk/splunk-sap-logserv/tree/main/release_binaries" target="_blank">GitHub repository</a>.

!!! note "v0.0.4.3 changes — Path B Linux sourcetype migration"
    The v0.0.4.3 Data TA replaces the legacy `[set_srctype_for_syslog]` transform (which routed cron + warn + sudolog + slapd into Splunk's pretrained `syslog` sourcetype) with four dedicated transforms producing four new sourcetypes: `linux:cron`, `linux:warn`, `linux:sudolog`, `linux:slapd`. This clears Splunkbase precert's pretrained-sourcetype warning and avoids field-extraction collisions with `Splunk_TA_nix`'s built-in `[syslog]` stanza. Existing data with `sourcetype=syslog` ages out per index retention; the LogServ App's dashboards OR both old + new sourcetypes during the transition.

<br>

### :material-circle-box:{ .taiconcolor } 3. Where to install

Refer to the [Architecture](../getting-started/architecture.md) page for the full install matrix. In summary:

| Your Topology | Install the Data TA On |
|---------------|----------------------|
| **Single instance** | The single Splunk instance |
| **Deployment Server + HFs + on-prem Indexer** | Deployment Server (manages filter rules + distributes to HFs); the **Indexer** (provides `default/indexes.conf` for `sap_logserv_logs` + `logserv_ai_assistant_audit`); HFs receive the TA automatically from the DS |
| **Splunk Cloud Indexer** | Splunk Cloud admin manages the indexer tier — Data TA installed there provides the bundled index defs |

!!! warning
    If you are using a **Deployment Server** to manage Heavy Forwarders, install the TA on the Deployment Server only. Do **not** install the TA directly on the Heavy Forwarders — the DS will distribute it automatically when you configure filters. See [Configuring Filters](configure-filters.md) for details.

!!! note "Why does the Data TA need to go on the Indexer?"
    Splunk only accepts events into an index that's **defined on the indexer that's receiving them**. The Data TA bundles `default/indexes.conf` (defining `sap_logserv_logs` + `logserv_ai_assistant_audit`) — that file is what tells the indexer those indexes exist. Without it, Heavy Forwarders would forward events tagged `index=sap_logserv_logs` and the indexer would reject them with "no such index" errors.

    **Honest trade-off:** the Data TA is ~9 MiB but only its `indexes.conf` actually does anything on a pure indexer (no Python is invoked there, no REST handlers fire, no transforms run on already-cooked events). The Python / REST / UCC / transforms code is dead weight on that tier. We chose this setup deliberately as a "two apps to install" simplification over a previous three-app split (Data TA + UI App + a separate Index App that was just `indexes.conf` + icons).

    **Opt-out path for customers who want a clean indexer:** define both indexes manually on the indexer — either through Splunk Web (**Settings → Indexes → New Index** for `sap_logserv_logs` and `logserv_ai_assistant_audit` with the same `homePath`/`coldPath`/`thawedPath` settings) or via your own `etc/system/local/indexes.conf` — and then **don't install the Data TA on the indexer**. Splunk Cloud customers typically take this path because their Cloud admin team provisions indexes via the Cloud UI rather than installing customer apps on the indexer tier. The Data TA still goes on the DS + HFs as usual.

<br>

### :material-circle-box:{ .taiconcolor } 4. Install in Splunk Cloud

Install the Data TA to your instance of Splunk Cloud using the instructions below:

If you are using separate forwarders in conjunction with Splunk Cloud, be sure to <a href="https://docs.splunk.com/Documentation/AddOns/released/Overview/SplunkCloudinstall#Install_an_add-on_on_a_heavy_forwarder" target="_blank">deploy the add-on to your forwarders</a> as well.

!!! note
    The app installation workflow available to you in Splunk Web depends on your Splunk Cloud Platform Experience: **Victoria** or **Classic**. To find your Splunk Cloud Platform Experience, in Splunk Web, click **Support & Services > About**.

#### :material-crop-square:{ .taiconcolor } Classic Experience

- <a href="https://help.splunk.com/en/splunk-cloud-platform/administer/admin-manual/9.3.2411/manage-apps-and-add-ons-in-splunk-cloud-platform/manage-private-apps-on-your-splunk-cloud-platform-deployment#e86cbd1a_f4ec_4256_9299_f2c56c9842ad__Install_a_private_app_on_Classic_Experience" target="_blank">Installation instructions for Classic Experience</a>

#### :material-crop-square:{ .taiconcolor } Victoria Experience

- <a href="https://help.splunk.com/en/splunk-cloud-platform/administer/admin-manual/9.3.2411/manage-apps-and-add-ons-in-splunk-cloud-platform/manage-private-apps-on-your-splunk-cloud-platform-deployment#b5f810d7_e842_487d_b752_3662cfb646bc__Install_a_private_app_on_Victoria_Experience" target="_blank">Installation instructions for Victoria Experience</a>

<br>

### :material-circle-box:{ .taiconcolor } 5. Install in Splunk Enterprise

Install the Data TA to your instance of Splunk Enterprise:

5.<b style="color: #ff9100">a</b> From the Splunk Web home screen, click the gear icon next to Apps.

5.<b style="color: #ff9100">b</b> Click Install app from file.

5.<b style="color: #ff9100">c</b> Locate the downloaded `splunk_ta_sap_logserv-0.0.6.0.tar.gz` file and click Upload.

5.<b style="color: #ff9100">d</b> If Splunk Enterprise prompts you to restart, do so.

5.<b style="color: #ff9100">e</b> Verify that the add-on appears in the list of apps and add-ons. You can also find it on the server at `$SPLUNK_HOME/etc/apps/splunk_ta_sap_logserv`.

<br>

### :material-circle-box:{ .taiconcolor } 6. Macros and Deployment Server

When the Data TA is pushed from a Deployment Server out to Heavy Forwarders, the bundled `macros.conf` travels with it — but **HFs don't run user searches**, so any macro change is operationally inert on that tier. Macros only resolve at search time on the Search Head. The Data TA carries `sap_logserv_idx_macro` mainly so DS-admin diagnostic searches on the deployment server itself can resolve the macro.

What this means in practice:

| Scenario | Where the change happens | DS involved? |
|---|---|---|
| Customer renames the data index | **SH only** — override `sap_logserv_idx_macro` in the LogServ App's `local/macros.conf` (READ), plus update the `Splunk_TA_aws` S3 input's `index` field (WRITE). See [Renaming an index](#renaming-an-index) above. | No |
| Customer renames the audit index | **SH only** — Settings → AI Assistant → General → Audit index name (WRITE), plus override `sap_logserv_audit_idx_macro` in the LogServ App's `local/macros.conf` (READ). See [Renaming an index](#renaming-an-index) above. | No |
| Want a custom diagnostic macro present on every HF | Edit `etc/deployment-apps/splunk_ta_sap_logserv/local/macros.conf` on the DS → trigger a scoped DS reload → HFs pull on next polling cycle. **Operational effect: none** — HFs don't resolve macros. The macro is present but unused on the HF tier. | Yes (cosmetic) |

What the DS *does* push usefully to HFs from this Data TA: **filter rules** (which sourcetypes to keep, which to drop, days-in-past window, filter enable/disable) — managed via the Configuration tab in Splunk Web on the DS. See [Configuring Filters](configure-filters.md).

<br>

## :material-circle-box:{ .cboxmove } Next Steps

1. Install the [LogServ App](../logserv-app/installation.md) on your Search Head
2. Install the [Splunk MCP Server](../ai-assistant/mcp-setup.md) on your Search Head if you want to use the AI Assistant
3. Complete the [AWS Setup Guide](setup-guides.md) to configure data collection
4. Configure [index-time filters](configure-filters.md) to control which log types are indexed
