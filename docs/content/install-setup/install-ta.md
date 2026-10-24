# Create the Indexes and Install the Data TA

This page creates the two indexes the solution writes to and installs the **Data TA** (`splunk_ta_sap_logserv`, shown in Splunk Web as **Splunk TA for SAP LogServ**). Use it after you have planned your topology ([Where Each Package Goes](../getting-started/package-placement.md), [Plan and Prerequisites](../getting-started/prerequisites.md)) and before you connect your cloud. For the LogServ App, see [Installing the LogServ App](../logserv-app/installation.md).

### :material-circle-box:{ .taiconcolor } High Level Steps

Follow the steps in order:

1. Decide where the Data TA goes.
2. Create the two indexes on the indexer tier, with the retention you want, before any data arrives.
3. Download the packages.
4. Install the Data TA (Splunk Enterprise or Splunk Cloud).
5. Before you distribute it: choose cloud attribution and decide filtering.
6. Distribute the Data TA to the heavy forwarders.
7. Check the build on each heavy forwarder.

Less common tasks (renaming an index, running the add-ons on a search head, macros on the Deployment Server) are under [Advanced](#advanced) at the bottom of this page.

<br>

### :material-circle-box:{ .taiconcolor } 1. Where to Install { #3-where-to-install }

The Data TA goes where LogServ data is parsed: on the heavy forwarders that run the ingest inputs, or on the single instance. A Deployment Server holds it in order to distribute it. The indexes are created on the indexer tier (step 2). Which instance gets which package, for every topology, is on [Where Each Package Goes](../getting-started/package-placement.md#package-matrix) (the matrix, and [By Topology](../getting-started/package-placement.md#per-topology-checklists)). For the Data TA, that means one of these:

- **Single instance:** that instance.
- **Heavy forwarders managed by a Deployment Server:** the Deployment Server only; it pushes the Data TA to the heavy forwarders ([Distribute the Data TA](distribute-data-ta.md)). This holds with Splunk Cloud too.
- **Heavy forwarders without a Deployment Server:** each heavy forwarder that runs a LogServ input, installed directly.
- **Splunk Cloud with no heavy forwarder:** the Splunk Cloud search head, because the inputs run there. This is not blocked, but we strongly recommend a heavy forwarder; see [Running the TAs on a search head](#running-the-tas-on-a-search-head).

Indexers and search heads that run no LogServ inputs do not need it: create the two indexes on the indexer tier instead (step 2; installing the Data TA on an indexer is allowed but adds nothing beyond its index definitions), and the LogServ App carries the search-time content.

:material-lightning-bolt:{ .taiconcolor } The Data TA parses every LogServ event on the heavy forwarders (or the single instance), so its cost per event decides how many heavy forwarders your volume needs; see [Capacity Planning and First Start](../getting-started/capacity-planning.md).

!!! warning "With a Deployment Server, install the Data TA on the Deployment Server only"
    When a Deployment Server manages your heavy forwarders, do **not** also install the Data TA directly on those forwarders. A push from the Deployment Server replaces the forwarder's copy of the app, its `local/` folder included, so local settings on the forwarder are lost. The Data TA does not reach the forwarders by itself either: the forwarders must be deployment clients, you save the Configuration page on the Deployment Server, assign the forwarders to the `SAP_LogServ_HeavyForwarders` server class and click **Deploy to Forwarders**. [Distribute the Data TA to Heavy Forwarders](distribute-data-ta.md) gives the steps.

!!! note "Why not the Inputs Data Manager (IDM)?"
    On the Splunk Cloud Classic Experience, inputs run on an Inputs Data Manager (IDM). The Data TA's `app.manifest` declares the workloads `_search_heads` and `_indexers` only; it does not declare `_forwarders`. Whether Splunk Cloud installs such an app on an IDM is not documented, and this path has not been tested. Use a heavy forwarder you manage yourself. With no heavy forwarder on the Victoria Experience, the inputs run on the search head, and the Data TA goes there too. (The LogServ Azure and GCP add-ons declare `_forwarders`, and also `_search_heads`, so a search head is an allowed target for them too, although a heavy forwarder is strongly recommended; installing them on a Splunk Cloud search head has not been tested.)

<br>

### :material-circle-box:{ .taiconcolor } 2. Create the Indexes { #1-create-the-indexes }

The solution uses two indexes:

| Index | Purpose | Default name | Macro |
|---|---|---|---|
| **SAP data index** | Receives every LogServ event (logs ingested from AWS S3, Azure Blob Storage or Google Cloud Storage and routed to their sourcetypes) | `sap_logserv_logs` | `sap_logserv_idx_macro` |
| **AI Assistant audit index** | Receives every audit event the AI Assistant writes: predefined-prompt dispatches, free-form vendor calls (when the LLM path is enabled), security blocks, privacy-tier elevations, legal acknowledgements | `logserv_ai_assistant_audit` | `sap_logserv_audit_idx_macro` |

Create both on the indexer tier **before any data arrives**. An event sent to an index that does not exist on the indexers is dropped (unless your indexers set `lastChanceIndex`), and an index created later does not get those events back.

**Retention.** The Data TA sets no retention for `sap_logserv_logs`, so the platform default applies unless you set one. It sets 90 days for the audit index (`frozenTimePeriodInSecs = 7776000`). Set the retention of `sap_logserv_logs` to cover the oldest data you will load, including any history you load later with [AWS S3 Direct](aws-s3-direct.md).

How you create them depends on your topology:

- **Single instance** — nothing to do. The Data TA ships `default/indexes.conf` with both indexes, and that one instance is the indexer, so installing the Data TA creates them. To give `sap_logserv_logs` a retention other than the default, add `frozenTimePeriodInSecs = <seconds>` under `[sap_logserv_logs]` in the Data TA's `local/indexes.conf` and restart Splunkd.
- **Standalone indexer, indexer cluster or Splunk Cloud** — create them yourself, as described in [Creating the indexes on a separate indexer tier](#creating-the-indexes-on-a-separate-indexer-tier) below.

!!! note "Why the indexer needs the index definitions"
    Events are stored on the indexer tier, so both indexes must be defined there. The Data TA does its parsing on the heavy forwarders (or the single instance), and a heavy forwarder parses each event before it forwards it, so on an indexer the only part of the Data TA that would do anything is its `indexes.conf`. That is why the indexes are created on the indexer tier by the tier's own method rather than by installing the Data TA there. If you do install the Data TA on a standalone indexer, its `default/indexes.conf` creates the indexes there, and its two scheduled scripts (the filter upgrade check every 10 minutes and the daily filter refresh) still run on it, doing nothing useful. On the Deployment Server and the heavy forwarders, which store no LogServ events, the index definitions do no harm.

#### :material-crop-square:{ .taiconcolor } Creating the Indexes on a Separate Indexer Tier

Use the same settings the Data TA's `default/indexes.conf` uses, so paths and retention match:

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

Add `frozenTimePeriodInSecs` to `[sap_logserv_logs]` to set its retention. Then pick the method that matches how your indexer tier is managed.

**Standalone indexer (Splunk Enterprise).** Either:

- **Splunk Web:** **Settings → Indexes → New Index**. Create `sap_logserv_logs`, then `logserv_ai_assistant_audit`, leaving the default paths. Then set their retention with `frozenTimePeriodInSecs` in `indexes.conf` (Splunk Web writes each new index to the `local/indexes.conf` of the app chosen in the form's **App** field): `7776000` seconds (about 90 days) for the audit index, to match the bundled default, and the value you want for `sap_logserv_logs`. Restart Splunkd. Or
- **Config file:** add the stanzas above to `$SPLUNK_HOME/etc/system/local/indexes.conf` (or to a small index-definition app of your own) on the indexer and restart Splunkd.

**Indexer cluster.** Put the stanzas in an index-only app under the cluster manager, `$SPLUNK_HOME/etc/manager-apps/<your_index_app>/local/indexes.conf`, and add `repFactor = auto` to **both** stanzas. Without `repFactor = auto` an index is not replicated across the peers. Then push the configuration bundle from the manager node: `splunk apply cluster-bundle` on its command line, or the bundle actions on its **Settings → Indexer Clustering** page in Splunk Web. Every peer receives the index definitions. The peers need nothing else from the Data TA. Putting the whole Data TA in the bundle is allowed but unnecessary; if you do, remove its `inputs.conf` first, as Splunk recommends for add-ons on indexer clusters.

**Splunk Cloud.** Create both indexes yourself, with the retention you want, before any data arrives: in the Splunk Cloud console (**Settings → Indexes → New Index**, where the retention is the *Searchable retention*) or with the **Admin Config Service (ACS)**. When you install the Data TA on a Victoria Experience stack as a private app, Splunk also installs its indexing-related `default/` files, `indexes.conf` among them, on the Cloud indexers (its `local/` files do not go there), but Splunk does not document that this creates the indexes, so do not rely on it.

#### :material-crop-square:{ .taiconcolor } Check Who Can Search the Indexes

Each role that uses the LogServ App's dashboards must be able to search `sap_logserv_logs`. On Splunk Enterprise the default `user` role allows `*`, which matches every index whose name does not start with `_`, so roles that keep `*` (or import such a role) already can. Check your roles in **Settings → Roles → *role* → Indexes**, on Splunk Cloud too, and add the index to any role with a narrowed list. Give access to the audit index only as [Audit Log → Restricting who can read the audit index](../ai-assistant/audit-log.md#restricting-who-can-read-the-audit-index) describes.

Both index names can be changed; see [Renaming an index](#renaming-an-index).

<br>

### :material-circle-box:{ .taiconcolor } 3. Download the Packages

All four packages of this release, their AppInspect reports and a README with the release details are in the <a href="https://github.com/splunk/splunk-sap-logserv/tree/main/release_binaries" target="_blank">release_binaries folder of the GitHub repository</a>:

| File | Package | Version | Build | md5 |
|---|---|---|---|---|
| `splunk_ta_sap_logserv-0.1.2.tar.gz` | Data TA (Splunk TA for SAP LogServ) | 0.1.2 | 1792598960 | `41a04986683c5d33014d8ab2fdb832f6` |
| `splunk_app_sap_logserv-0.1.2.tar.gz` | LogServ App (Splunk App for SAP LogServ) | 0.1.2 | 394 | `1d82a2ac049391b2d7b2fb347d112649` |
| `splunk_ta_sap_logserv_azure-0.1.2.tar.gz` | LogServ Azure add-on (Splunk TA for SAP LogServ on Azure) | 0.1.2 | 1792558069 | `5a5b0cfcd5f77dfa1e22dcc3545c8306` |
| `splunk_ta_sap_logserv_gcp-0.1.2.tar.gz` | LogServ GCP add-on (Splunk TA for SAP LogServ on GCP) | 0.1.2 | 1792558072 | `42713371e1ba1042b1149065cc1c59a9` |

This page installs the Data TA. The LogServ App goes on the search tier ([Installing the LogServ App](../logserv-app/installation.md)); the Azure and GCP add-ons are installed later, per heavy forwarder, in the [Azure](azure-setup.md) and [GCP](gcp-setup.md) setup guides. The Splunk Add-on for AWS comes from Splunkbase (app 1876) and is not part of this release.

To check a download, compare its md5 with the table: `md5sum <file>` on Linux, `md5 <file>` on macOS, `certutil -hashfile <file> MD5` on Windows.

<br>

### :material-circle-box:{ .taiconcolor } 4. Install the Data TA

Install it on each instance that step 1 names: the Deployment Server, each heavy forwarder without a Deployment Server, the single instance, or the Splunk Cloud search head that runs the inputs.

#### :material-crop-square:{ .taiconcolor } Splunk Enterprise

Your Deployment Server, heavy forwarders and single instance run Splunk Enterprise, also when your search tier is Splunk Cloud.

4.<b class="taiconcolor">a</b> From the Splunk Web home screen, click the gear icon next to Apps.

4.<b class="taiconcolor">b</b> Click Install app from file.

4.<b class="taiconcolor">c</b> Locate the downloaded `splunk_ta_sap_logserv-0.1.2.tar.gz` file and click Upload.

4.<b class="taiconcolor">d</b> If Splunk Enterprise prompts you to restart, do so.

4.<b class="taiconcolor">e</b> Verify that the add-on appears in the list of apps and add-ons. You can also find it on the server at `$SPLUNK_HOME/etc/apps/splunk_ta_sap_logserv`.

On a Deployment Server this installs the Data TA in `etc/apps/` only. It is copied into `etc/deployment-apps/` for the forwarders when you first save its Configuration page there ([Distribute the Data TA](distribute-data-ta.md)).

!!! note "If splunkd runs with a proxy variable, exempt its own management port"
    The add-on's configuration pages (and the Azure and GCP add-ons' inputs) talk to the local splunkd management port, by default `127.0.0.1:8089`, through Splunk's Python HTTP client, which honours the `HTTP_PROXY` / `HTTPS_PROXY` environment variables. If the environment splunkd runs in sets either of them, for example in `splunk-launch.conf` or the systemd unit, also set `NO_PROXY=127.0.0.1,localhost` (plus the host name in `mgmtHostPort`, if it is not a loopback address). Otherwise those calls, with their session key, are sent to the proxy instead of to splunkd.

#### :material-crop-square:{ .taiconcolor } Splunk Cloud

Install the Data TA on your Splunk Cloud stack only when the inputs run on the Cloud search head (Splunk Cloud with no heavy forwarder). With your own heavy forwarders, install it there with the Splunk Enterprise steps above instead; the Splunk Cloud stack does not need it (installing it there is allowed).

The app installation workflow depends on your Splunk Cloud Platform Experience, **Victoria** or **Classic**. To find yours, in Splunk Web click **Support & Services > About**.

- <a href="https://help.splunk.com/en/splunk-cloud-platform/administer/admin-manual/9.3.2411/manage-apps-and-add-ons-in-splunk-cloud-platform/manage-private-apps-on-your-splunk-cloud-platform-deployment#b5f810d7_e842_487d_b752_3662cfb646bc__Install_a_private_app_on_Victoria_Experience" target="_blank">Installation instructions for Victoria Experience</a>
- <a href="https://help.splunk.com/en/splunk-cloud-platform/administer/admin-manual/9.3.2411/manage-apps-and-add-ons-in-splunk-cloud-platform/manage-private-apps-on-your-splunk-cloud-platform-deployment#e86cbd1a_f4ec_4256_9299_f2c56c9842ad__Install_a_private_app_on_Classic_Experience" target="_blank">Installation instructions for Classic Experience</a>

Create the indexes yourself either way (step 2). For what differs when the inputs run on a search head, see [Running the TAs on a search head](#running-the-tas-on-a-search-head) and [Splunk Cloud Considerations](../getting-started/splunk-cloud.md).

<br>

### :material-circle-box:{ .taiconcolor } 5. Before You Distribute: Two Index-Time Decisions

The Data TA attributes each event to its cloud and applies your filters at index time, so whatever is indexed before you decide stays as it was indexed. Decide both before the first Save on the Deployment Server, and before any input starts:

1. [Choose Cloud Attribution](cloud-attribution.md): the Cloud Provider value (normally **Not set**) and the per-input `_meta` line for AWS.
2. [Decide Filtering](decide-filtering.md): whether to turn filtering on, and with which values.

<br>

### :material-circle-box:{ .taiconcolor } 6. Distribute to the Heavy Forwarders

- **With a Deployment Server:** follow [Distribute the Data TA to Heavy Forwarders](distribute-data-ta.md). The forwarders receive the Data TA only after those steps.
- **Without a Deployment Server:** the Data TA is already on each heavy forwarder (step 4). Enter the same Configuration values and click **Save** on each one; see [Without a Deployment Server](distribute-data-ta.md#without-a-deployment-server).
- **Single instance, or the Splunk Cloud search head that runs the inputs:** nothing to distribute. Enter your Configuration values there and click **Save**.

<br>

### :material-circle-box:{ .taiconcolor } 7. Check the Build on Each Heavy Forwarder

Before you create any input, check on each heavy forwarder (or the single instance) that it runs this Data TA build: see [Version Check](../getting-started/capacity-planning.md#version-check). The routing runs where the data is parsed, so a forwarder that has not received the Data TA yet indexes every event under the base `sap_logserv_logs` sourcetype, permanently.

<br>

## :material-circle-box:{ .taiconcolor } Advanced

### :material-circle-box:{ .taiconcolor } Renaming an Index

Both indexes are macro-configurable, so you can use other names (for example, to follow a corporate naming convention) without changing the apps: you create the index, update the macros, and point the writers at the new name.

!!! note
    Both the Data TA and the LogServ App include a macro named **sap_logserv_idx_macro** that resolves to `index="sap_logserv_logs"`. The LogServ App also includes **sap_logserv_audit_idx_macro** for the audit index.

#### :material-crop-square:{ .taiconcolor } To Rename the SAP Data Index

A rename touches three places: the indexer tier, every ingest input (normally on the heavy forwarders), and the search head. The Deployment Server is not involved. On a single instance all three are the same instance.

1. **Pick a new name** (for example `myorg_sap_logs`).
2. **Create the index on the indexer tier** under that name, with the methods in [Creating the indexes on a separate indexer tier](#creating-the-indexes-on-a-separate-indexer-tier) (on a single instance: **Settings → Indexes → New Index**, or a stanza in the Data TA's `local/indexes.conf`). On Splunk Cloud, use **Settings → Indexes** or ACS: a `local/indexes.conf` does not reach the Cloud indexers. See the Splunk docs for <a href="https://help.splunk.com/en/splunk-cloud-platform/administer/admin-manual/9.3.2411/manage-your-indexes-and-data-in-splunk-cloud-platform/manage-splunk-cloud-platform-indexes" target="_blank">Splunk Cloud</a> or <a href="https://docs.splunk.com/Documentation/Splunk/9.4.2/Indexer/Setupmultipleindexes#Create_events_indexes" target="_blank">Splunk Enterprise</a>.
3. **Update the macro in every app on the search head that ships it.** Open **Settings → Advanced search → Search macros**, set **App** to **All**, and filter on `sap_logserv_idx_macro`. Edit the row whose app is `splunk_app_sap_logserv` and change the definition from `index="sap_logserv_logs"` to `index="myorg_sap_logs"`. Where the Data TA is also installed on this search head (a single instance, or a search head that runs the inputs), edit the row whose app is `splunk_ta_sap_logserv` too. Each edit is saved in that app's `local/macros.conf`. Both are needed: the scheduled rollups and the **Settings → Dashboard Data** backfill run in the LogServ App and use its copy, while the live dashboard panels run in each user's default app, where Splunk ranks the Data TA's copy above the App's (other apps are ranked in reverse alphabetical order). Check the result:

    ```spl
    | rest /servicesNS/-/-/configs/conf-macros splunk_server=local
    | search title=sap_logserv_idx_macro
    | table eai:acl.app definition
    ```

    Then run `` `sap_logserv_idx_macro` | stats count `` in the Search app once data arrives in the new index.

4. **Point every ingest input at the new index.** The destination index is set by each input's `index` field, in the ingest add-on for your cloud, not in this Data TA: for **AWS**, each SQS-Based S3 input in the Splunk Add-on for AWS (see the [AWS Remote S3 Connect Setup Guide](aws-remote-s3-connect-guide.md)), and the Index field of every later backfill on the [AWS S3 Direct](aws-s3-direct.md) screen; for **Azure**, each `sap_logserv_azure_queue` input's `index` field ([Azure Setup Guide](azure-setup.md)); for **GCP**, each `sap_logserv_gcp_pubsub` input's `index` field ([GCP Setup Guide](gcp-setup.md)). These inputs normally run on the heavy forwarders. The AWS S3 Direct screen offers only the indexes defined on the instance it runs on, so to pick the new name there, define the index on that forwarder too, for example with **Settings → Indexes** on it. (On a forwarder the Deployment Server manages, do not put it in the Data TA's `local/`: the next push replaces that folder.)

The Data TA still ships its own `[sap_logserv_logs]` stanza in `default/indexes.conf`, and a `local/indexes.conf` cannot remove it: Splunk merges the two files setting by setting, so `local/` can only override values. An unused, empty `sap_logserv_logs` index does no harm. If you do not want it, disable it once every ingest input points at the new index: on each instance where the Data TA defines it and events are stored (a single instance, or an indexer you installed the Data TA on), add the following to the Data TA's `local/indexes.conf` (or use **Settings → Indexes → Disable**), then restart Splunkd. Do not edit or delete the Data TA's `default/indexes.conf`; an upgrade replaces it and brings the stanza back.

```ini
[sap_logserv_logs]
disabled = true
```

!!! note "The AI Assistant and a renamed data index"
    After `sap_logserv_idx_macro` is changed, the AI Assistant refuses free-form queries that start with the macro: its query guard compares the macro with the shipped definition `index="sap_logserv_logs"` ([The SPL Guard](../ai-assistant/free-form-prompts.md#spl-guard)).

#### :material-crop-square:{ .taiconcolor } To Rename the AI Assistant Audit Index

1. **Pick a new name.** Do **not** start it with an underscore: `_`-prefixed index names are reserved for Splunk's internal indexes, AppInspect rejects them for custom apps, and Splunk Cloud will not accept them (the shipped index was itself renamed off an underscore prefix for these reasons).
2. **Create the index** on the indexer tier under that name, with the same methods as above.
3. **Update the macro definition.** Open **Settings → Advanced search → Search macros**, find `sap_logserv_audit_idx_macro` (only the LogServ App ships it), and change the definition from `index="logserv_ai_assistant_audit"` to `index="<your_new_name>"`. This controls READS: the in-app Audit Log viewer and any user-written queries resolve the macro to your renamed index.
4. **Update the LogServ App config.** Open **Settings → AI Assistant → General → Audit & Telemetry**, set the **Audit index name** field to your renamed index, and Save Defaults. This controls WRITES: the App posts audit events to the configured index name.

The config field controls writes; the macro controls reads. They MUST point at the same index, but Splunk does not keep them in step for you: keep them aligned whenever you rename.

<br>

### :material-circle-box:{ .taiconcolor } Running the TAs on a search head

We strongly recommend against installing the Data TA, the LogServ Azure add-on or the LogServ GCP add-on on a search head, Splunk Cloud included: ingest belongs on the heavy forwarders, and inputs on a search head put that load on the tier your users search on. Nothing blocks it, though. On a search head that runs the inputs itself (with the Splunk Add-on for AWS, or with the Azure or GCP add-on), the Data TA parses and filters there as it does on a heavy forwarder, and the [AWS S3 Direct screen](aws-s3-direct.md) works there too; on Splunk Cloud, and on an instance with no enabled AWS input, it shows a warning that recommends a heavy forwarder. Two things work differently there:

- **Search head clusters.** A search head cluster does not replicate inputs, so an input created on a member (on the Azure or GCP add-on's Inputs page, or on the AWS S3 Direct screen) runs only on that member. An input the deployer pushes to every member runs on every member: a Generic S3 input then reads every object on each member, so each object is indexed once per member; the Azure and GCP add-ons share their queue or subscription between the members, and a message goes to one member, but each member keeps its own dedup record, so a redelivered message can be indexed twice. The filter rules and the Cloud Provider stamp that the Data TA's Configuration page generates are written only on the member where you save them. The saved Filters settings normally reach the other members (not when the save falls back to writing the settings file, as it does for an account without `admin_all_objects`), and another member rebuilds its rules from them at its own daily filter refresh, but only while Enable Filtering is checked and Days in the Past is greater than 0: turning filtering off, and rules saved with Days in the Past at 0, never reach the other members. Save the Filters and Cloud Provider tabs on every member that runs inputs.
- **Deployment clients.** On a search head that is a deployment client for other apps but holds the Data TA directly, the daily filter refresh runs as it does on a single instance. It is skipped only where the Deployment Server delivers the Data TA, or where the instance's record of what its Deployment Server sent (`$SPLUNK_HOME/var/run/serverclass.xml`) is missing, unreadable or lists no app. The same rule applies to a heavy forwarder that holds the Data TA directly; see [Heavy Forwarder without a Deployment Server](configure-filters.md#heavy-forwarder-without-a-deployment-server).

<br>

### :material-circle-box:{ .taiconcolor } Macros and the Deployment Server { #6-macros-and-deployment-server }

When the Deployment Server pushes the Data TA to the heavy forwarders, its `macros.conf` travels with it, but heavy forwarders run no user searches, so a macro there has no effect. Macros matter on the search tier. Where the Data TA is also installed on a search head (a single instance, or a search head that runs the inputs), its copy of `sap_logserv_idx_macro` is the one the live dashboard panels use, ranked above the LogServ App's copy; see step 3 of [To Rename the SAP Data Index](#to-rename-the-sap-data-index).

What this means in practice:

| Scenario | Where the change happens | Deployment Server involved? |
|---|---|---|
| You rename the data index | **Indexer tier:** create the new index. **Ingest inputs** (normally on the heavy forwarders): set `index` to the new name on every SQS-Based S3 input, `sap_logserv_azure_queue` input and `sap_logserv_gcp_pubsub` input, and on later AWS S3 Direct backfills (WRITE). **Search head:** override `sap_logserv_idx_macro` in each app that ships it there (READ). See [Renaming an index](#renaming-an-index). | No: none of these is pushed by the Deployment Server, and the Data TA routes by sourcetype, not by index |
| You rename the audit index | **Indexer tier:** create the new index. **Search head:** Settings → AI Assistant → General → Audit index name (WRITE), plus `sap_logserv_audit_idx_macro` in the LogServ App (READ). See [Renaming an index](#renaming-an-index). | No |
| You want a custom diagnostic macro on every heavy forwarder | Add it to `etc/deployment-apps/splunk_ta_sap_logserv/local/macros.conf` on the Deployment Server, then **Deploy to Forwarders**; the forwarders pull it at their next phone-home. **Operational effect: none**, because forwarders do not resolve macros. Keep a copy in `etc/apps/splunk_ta_sap_logserv/local/macros.conf` as well: when the Data TA's version changes, the next Configuration save, or the next daily filter refresh, replaces the whole `deployment-apps` copy, hand edits included, with a copy of `etc/apps/splunk_ta_sap_logserv/`. | Yes (cosmetic) |

What the Deployment Server does push usefully from this Data TA: the **filter rules** and the **Cloud Provider** stamp, managed on the Data TA's Configuration page on the Deployment Server. See [Configuring Filters](configure-filters.md) and [Choose Cloud Attribution](cloud-attribution.md).

<br>

## :material-circle-box:{ .cboxmove } Next Steps

1. [Choose Cloud Attribution](cloud-attribution.md), then [Decide Filtering](decide-filtering.md): both before the first Save on the Deployment Server.
2. [Distribute the Data TA to Heavy Forwarders](distribute-data-ta.md), if a Deployment Server manages them.
3. [Choose Your Cloud and AWS Scenario](choose-your-cloud.md) to connect your cloud.
