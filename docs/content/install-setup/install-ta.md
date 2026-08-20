# Installing the Data TA

This page covers installing the **Data TA** (`splunk_ta_sap_logserv`). For the LogServ App installation, see [Installing the LogServ App](../logserv-app/installation.md).

### :material-circle-box:{ .taiconcolor } High Level Steps

Below are the high level steps for installing the Data TA. Follow them in order.

:material-lightning-bolt:{ .taiconcolor } Steps 4 and 5 are alternative paths — complete the one that matches your Splunk environment.

1. Create the two indexes (or let the Data TA create them where it runs on the indexer)
2. Download the Data TA
3. Identify where to install the Data TA based on your topology
4. Install the Data TA in Splunk Cloud (if applicable)
5. Install the Data TA in Splunk Enterprise (if applicable)
6. Understand how the macros behave when pushed by a Deployment Server

<br>

### :material-circle-box:{ .taiconcolor } 1. Create the indexes

The solution uses two indexes:

| Index | Purpose | Default name | Macro |
|---|---|---|---|
| **SAP data index** | Receives every event the Data TA forwards (logs ingested from S3/Azure/GCS and routed to the appropriate sourcetype) | `sap_logserv_logs` | `sap_logserv_idx_macro` |
| **AI Assistant audit index** | Receives every audit event the AI Assistant writes — canned-prompt dispatches, free-form vendor calls (when LLM path is enabled), security blocks, privacy-tier elevations, legal acknowledgements | `logserv_ai_assistant_audit` | `sap_logserv_audit_idx_macro` |

**How these indexes get created depends on your topology:**

- **Single instance** (Data TA + LogServ App on one box) — **nothing to do.** The Data TA ships `default/indexes.conf` defining both indexes, and Splunk auto-creates them the first time the Data TA loads, because that one instance *is* the indexer.
- **Distributed with on-prem indexer(s)** — **install the Data TA on the indexer tier too** (the indexer is a declared target workload in the TA's `app.manifest`); its bundled `default/indexes.conf` provisions both indexes there. For an indexer **cluster**, deliver it via the Cluster Manager's peer-apps mechanism. If your indexer tier cannot take the app, create the indexes manually instead — see [Creating the indexes on a separate indexer tier](#creating-the-indexes-on-a-separate-indexer-tier) below.
- **Splunk Cloud** — the indexer tier is Splunk-managed: install the Data TA to the Cloud stack (self-service app management / ACS), or create the indexes via the Splunk Cloud console — see below.

!!! note "Where the index definitions live"
    An `indexes.conf` stanza only takes effect on an instance that both **has the config** and **has an indexing role** (stores buckets on disk). The Data TA's copies on the Deployment Server and Heavy Forwarders therefore ignore its `indexes.conf` (the DS distributes apps; HFs parse + forward) — it is the copy on the **indexer tier** that provisions the indexes. Manual index creation is the equivalent alternative wherever installing the app on the indexers isn't practical.

!!! note
    Both the Data TA and the LogServ App include a macro named **sap_logserv_idx_macro** that resolves to `index="sap_logserv_logs"`. The LogServ App also includes **sap_logserv_audit_idx_macro** for the audit index. If you use a different index name, follow the [Renaming an index](#renaming-an-index) procedure below.

#### :material-crop-square:{ .taiconcolor } Renaming an Index

Both indexes are macro-configurable, so customers who need different names (e.g., a corporate naming convention) don't have to fork the app — they update the macros (and, for the audit index, one config field).

##### To rename the SAP data index

1. **Pick a new name** (e.g., `myorg_sap_logs`).
2. **Create the index** under that new name. Either:
    - Add a custom `local/indexes.conf` to the Data TA with a stanza for your new name (`[my_new_index_name]` plus the same `homePath` / `coldPath` / `thawedPath` settings), OR
    - Create the index manually through Splunk Web's **Settings → Indexes → New Index** UI. (See <a href="https://help.splunk.com/en/splunk-cloud-platform/administer/admin-manual/9.3.2411/manage-your-indexes-and-data-in-splunk-cloud-platform/manage-splunk-cloud-platform-indexes" target="_blank">Splunk Cloud</a> or <a href="https://docs.splunk.com/Documentation/Splunk/9.4.2/Indexer/Setupmultipleindexes#Create_events_indexes" target="_blank">Splunk Enterprise</a> docs.)
3. **Update the macro definition.** Open **Settings → Advanced search → Search macros**, find `sap_logserv_idx_macro`, and edit the definition from `index="sap_logserv_logs"` to `index="my_new_index_name"`.
4. **Redirect the ingest pipeline** to the new index name. The `index = ...` setting that determines where ingested events land lives in the **ingest add-on for your cloud**, NOT in this Data TA: for **AWS**, the SQS-based S3 input(s) in the Splunk Add-on for AWS (see the [AWS Remote S3 Filter Setup Guide](aws-remote-s3-filter-guide.md)); for **Azure**, each `sap_logserv_azure_queue` input's `index` field ([Azure Setup Guide](azure-setup.md)); for **GCP**, each `sap_logserv_gcp_pubsub` input's `index` field ([GCP Setup Guide](gcp-setup.md)). Update the `index` field on every LogServ ingest input to the new name.

The Data TA's default `[sap_logserv_logs]` stanza will still create that index unless you remove or override it via your custom `local/indexes.conf`. If your environment doesn't need the default, that's harmless; if it bothers you, override the stanza locally.

##### To rename the AI Assistant audit index

1. **Pick a new name.** Do **not** start it with an underscore — `_`-prefixed index names are reserved for Splunk's internal indexes, AppInspect rejects them for custom apps, and Splunk Cloud will not accept them (the shipped index was itself renamed off an underscore prefix for exactly these reasons).
2. **Create the index** under that name (same options as above — local indexes.conf override, OR Splunk Web Settings UI).
3. **Update the macro definition.** Open **Settings → Advanced search → Search macros**, find `sap_logserv_audit_idx_macro`, and edit the definition from `index="logserv_ai_assistant_audit"` to `index="<your_new_name>"`. This controls READS — the in-app Audit Log Viewer + any user-written queries will resolve the macro to your renamed index.
4. **Update the LogServ App config.** Open **Settings → AI Assistant → General → Audit & Telemetry**, set the **Audit index name** field to your renamed index, and Save Defaults. This controls WRITES — the AuditWriter posts events to the configured index name.

The conf field controls writes; the macro controls reads. They MUST point at the same index, but Splunk doesn't auto-sync them — keep them aligned manually whenever you rename.

<br>

### :material-circle-box:{ .taiconcolor } 2. Download the Data TA

Download `splunk_ta_sap_logserv-0.1.1.tar.gz` from the <a href="https://github.com/splunk/splunk-sap-logserv/tree/main/release_binaries" target="_blank">GitHub repository</a>.

!!! note "v0.0.4.3 changes — Path B Linux sourcetype migration"
    The v0.0.4.3 Data TA replaces the legacy `[set_srctype_for_syslog]` transform (which routed cron + warn + sudolog + slapd into Splunk's pretrained `syslog` sourcetype) with four dedicated transforms producing four new sourcetypes: `linux:cron`, `linux:warn`, `linux:sudolog`, `linux:slapd`. This clears Splunkbase precert's pretrained-sourcetype warning and avoids field-extraction collisions with `Splunk_TA_nix`'s built-in `[syslog]` stanza. Existing data with `sourcetype=syslog` ages out per index retention; the LogServ App's dashboards OR both old + new sourcetypes during the transition.

<br>

### :material-circle-box:{ .taiconcolor } 3. Where to install

Refer to the [Architecture](../getting-started/architecture.md) page for the full install matrix. In summary:

| Your Topology | Install the Data TA On | Create the indexes On |
|---|---|---|
| **Single instance** | The single Splunk instance | Auto-created by the Data TA — nothing to do |
| **Deployment Server + HFs + on-prem indexer(s)** | The Deployment Server (manages filter rules + distributes to HFs) **and the indexer(s)** (provides `indexes.conf`). Not on a dedicated search head. | Auto-created by the Data TA on the indexer tier — or manually, see [Creating the indexes on a separate indexer tier](#creating-the-indexes-on-a-separate-indexer-tier) |
| **Splunk Cloud** | Your HF / Inputs Data Manager (IDM) ingest tier, per Splunk's add-on-on-Cloud guidance. The Cloud indexer tier is Splunk-managed. | Via the Splunk Cloud console / ACS — see below |

!!! warning
    If you are using a **Deployment Server** to manage Heavy Forwarders, install the TA on the Deployment Server only. Do **not** install the TA directly on the Heavy Forwarders — the DS will distribute it automatically when you configure filters. See [Configuring Filters](configure-filters.md) for details. On a dedicated **search head** the Data TA is not needed (the LogServ App carries the search-time content); the **indexer tier** is the exception — install the Data TA there so its `indexes.conf` provisions the indexes.

### :material-circle-box:{ .taiconcolor } Creating the indexes on a separate indexer tier

When your indexer is a separate tier from where the Data TA runs (any distributed deployment), create the two indexes on the indexer tier yourself. Use the **same settings the Data TA's `default/indexes.conf` uses** so paths and retention match:

```ini
[sap_logserv_logs]
homePath   = $SPLUNK_DB/sap_logserv_logs/db
coldPath   = $SPLUNK_DB/sap_logserv_logs/colddb
thawedPath = $SPLUNK_DB/sap_logserv_logs/thaweddb

[logserv_ai_assistant_audit]
homePath               = $SPLUNK_DB/logserv_ai_assistant_audit/db
coldPath               = $SPLUNK_DB/logserv_ai_assistant_audit/colddb
thawedPath             = $SPLUNK_DB/logserv_ai_assistant_audit/thaweddb
frozenTimePeriodInSecs = 7776000
```

Pick the method that matches how your indexer tier is managed:

#### :material-crop-square:{ .taiconcolor } Standalone indexer (Splunk Enterprise)

Either:

- **Splunk Web:** **Settings → Indexes → New Index** — create `sap_logserv_logs`, then `logserv_ai_assistant_audit`. Leave the default paths; set the audit index's retention (Frozen time period) to `7776000` seconds (~90 days) if you want to match the bundled default. Or
- **Config file:** add the stanzas above to `$SPLUNK_HOME/etc/system/local/indexes.conf` (or a small index-definition app of your own) on the indexer and restart Splunkd.

#### :material-crop-square:{ .taiconcolor } Indexer cluster

Add the stanzas above to an `indexes.conf` inside a configuration bundle app under the cluster manager's `$SPLUNK_HOME/etc/manager-apps/<your_index_app>/local/` (or `master-apps/` on older versions), then push the bundle (**Settings → Indexer Clustering → Edit → Distribute Configuration Bundle**, or `splunk apply cluster-bundle`). All peer nodes receive the index definitions. Do **not** install the Data TA in the cluster bundle — only the `indexes.conf`.

#### :material-crop-square:{ .taiconcolor } Splunk Cloud

The Cloud indexer tier is Splunk-managed — you cannot install apps on it. Create both indexes through the **Splunk Cloud console** (**Settings → Indexes → New Index**) or with the **Admin Config Service (ACS)** CLI/API. Set the audit index's retention to match if desired. The Data TA still goes on your HF / IDM ingest tier as usual.

!!! note "Why the Data TA can't do this for you on a separate indexer"
    An `indexes.conf` only takes effect on an instance that both **has the config** and **indexes data**. In a distributed deployment the Data TA runs on the Deployment Server + Heavy Forwarders, which don't store data — so its bundled `indexes.conf` is inert there and never reaches the indexer. Index definitions are therefore an **indexer-tier concern**, managed through that tier's own mechanism (config file, cluster bundle, or Cloud console) — independent of the data-collection Data TA. (On a true single-instance the Data TA *is* the indexing box, which is the one case where its bundled `indexes.conf` auto-creates the indexes for you.)

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

5.<b class="taiconcolor">a</b> From the Splunk Web home screen, click the gear icon next to Apps.

5.<b class="taiconcolor">b</b> Click Install app from file.

5.<b class="taiconcolor">c</b> Locate the downloaded `splunk_ta_sap_logserv-0.1.1.tar.gz` file and click Upload.

5.<b class="taiconcolor">d</b> If Splunk Enterprise prompts you to restart, do so.

5.<b class="taiconcolor">e</b> Verify that the add-on appears in the list of apps and add-ons. You can also find it on the server at `$SPLUNK_HOME/etc/apps/splunk_ta_sap_logserv`.

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
3. Complete the [Setup Guides](setup-guides.md) to configure data collection (**AWS S3**, **Azure Blob Storage**, or **Google Cloud Storage**, depending on where your SAP ECS data lands — Azure and GCP each require their first-party add-on, `splunk_ta_sap_logserv_azure` / `splunk_ta_sap_logserv_gcp`, on each Heavy Forwarder)
4. Configure [index-time filters](configure-filters.md) to control which log types are indexed
