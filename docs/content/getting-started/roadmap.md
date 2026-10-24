# Start Here: Deployment Roadmap

This page gives the order in which to set up Splunk for SAP LogServ for the first time, from the request to SAP to working dashboards. Work through the steps in order: each one names the page with the details and ends with a check that tells you the step is done.

!!! warning "Decide before the data flows"
    The Data TA works at index time. Sourcetype routing, the filters and the `cloud_provider` stamp are applied when an event is indexed, and the event keeps what it was indexed with. Make the decisions of steps 6 to 8 before you save the Data TA's Configuration page (step 9), so that a Deployment Server's first push carries them, and in every case before any input starts (step 10). Whatever SAP's queue holds when the input starts is indexed with the settings in place at that moment.

### :material-circle-box:{ .taiconcolor } The Steps at a Glance

The steps are grouped as in the **Get Started** menu, with three exceptions: step 8 uses a page from *1. Plan* (Capacity Planning and First Start), step 12 is on the **Configure and Operate** tab (AWS S3 Direct), and step 15 is on the **AI Assistant** and **Enterprise Security Integration** tabs.

**1. Plan**

1. [Request from SAP and prepare your cloud](#1-request-from-sap-and-prepare-your-cloud)
2. [Pick your topology](#2-pick-your-topology)
3. [Prepare the forwarding tier](#3-prepare-the-forwarding-tier)

**2. Install the Data TA**

4. [Create the indexes and set their retention](#4-create-the-indexes-and-set-their-retention)
5. [Install the Data TA](#5-install-the-data-ta)
6. [Choose cloud attribution](#6-choose-cloud-attribution)
7. [Decide filtering](#7-decide-filtering)
8. [Decide on the first-start queue backlog](#8-decide-on-the-first-start-queue-backlog)
9. [Distribute the Data TA](#9-distribute-the-data-ta) (gate: the Data TA is on every heavy forwarder)

**3. Connect Your Cloud**

10. [Connect your cloud](#10-connect-your-cloud)

**4. Verify Your Data**

11. [Verify your data](#11-verify-your-data)

**Configure and Operate** (AWS S3 Direct)

12. [Load history](#12-load-history)

**5. Install the LogServ App**

13. [Install the LogServ App and its search-head add-ons](#13-install-the-logserv-app-and-its-search-head-add-ons)
14. [Run Diagnostics, then backfill the dashboards](#14-run-diagnostics-then-backfill-the-dashboards)

**Optional**

15. [The AI Assistant and the Enterprise Security content](#15-optional-the-ai-assistant-and-the-enterprise-security-content)

<br>

### :material-circle-box:{ .taiconcolor } 1. Request from SAP and Prepare Your Cloud

Start here: SAP does this work on its side, and most later steps need its results. [Plan and Prerequisites](prerequisites.md#request-from-sap) lists what to ask for, per cloud. SAP's turnaround can be the longest wait of the whole setup, so send every request to SAP on day one and carry on with steps 2 to 9 while you wait.

- **AWS.** Pick your scenario on [Choose Your Cloud and AWS Scenario](../install-setup/choose-your-cloud.md). AWS Remote S3 Connect is the default; choose AWS Remote S3 Filter now if your forwarders' load or the first-start backlog (step 8) must be cut, because the scenario decides which template you deploy. Then do the AWS side of your scenario's guide now, in your own AWS account (the guides' *Secondary account*): get the ARNs of the S3 bucket and the SQS queue in your SAP ECS account and their AWS Region, deploy the CloudFormation template, and send SAP LogServ support the request to apply the queue and bucket policies for the role the template creates. In the [Connect guide](../install-setup/aws-remote-s3-connect-guide.md#high-level-steps) these are steps 1 to 3; in the [Filter](../install-setup/aws-remote-s3-filter-guide.md#high-level-steps) and [Copy](../install-setup/aws-remote-s3-copy-guide.md#high-level-steps) guides, steps 1 to 4, which also create the bucket for the Lambda code. If you will load history with AWS S3 Direct (step 12), which reads SAP's bucket, ask in the same request for `s3:ListBucket` for that role in SAP's bucket policy. Nothing reads SAP's queue yet: the input comes in step 10, and the Filter and Copy templates create no Lambda trigger.
- **Azure.** Get the storage account name, the queue name and an account SAS with `ss=bq`, `srt=o` and `sp=rp` (plus `a` if you configure a dead-letter queue). Ask when the SAS expires (its `se=` value) and how SAP renews it: the input stops reading when the SAS expires. See [Parameters to obtain from SAP](../install-setup/azure-setup.md#parameters-to-obtain-from-sap) and [What the SAP-provided SAS must cover](../install-setup/azure-setup.md#what-the-sap-provided-sas-must-cover).
- **GCP.** Create a service account in a GCP project of your own and give its email address to SAP. SAP grants it access to the LogServ subscription and bucket, and gives you the project ID and the subscription name. Check your organization's policy on service-account keys before install day, and decide how you will rotate the key. See [The onboarding sequence](../install-setup/gcp-setup.md#the-onboarding-sequence), [What SAP must grant your service account](../install-setup/gcp-setup.md#what-sap-must-grant-your-service-account) and [Parameters for the input](../install-setup/gcp-setup.md#parameters-for-the-input).
- **Every cloud.** Ask SAP how long its queue keeps a message and how old the oldest waiting message is. You need both in step 8 ([First Start: The Queue Backlog](capacity-planning.md#first-start-the-queue-backlog)).

**Done when:** you hold the values your cloud's guide asks for (AWS: the two ARNs, the Region, a deployed CloudFormation stack, and SAP's confirmation that both policies are applied; Azure: the account, the queue, the SAS and its expiry; GCP: the project ID, the subscription and SAP's confirmation of its grants), and you know how long SAP's queue keeps messages. Steps 2 to 9 can run while you wait for SAP; step 10 cannot start until this step is done.

<br>

### :material-circle-box:{ .taiconcolor } 2. Pick Your Topology

Pick the row that matches your Splunk deployment. The steps below refer to these names. The exact placement of every package is on [Where Each Package Goes](package-placement.md#package-matrix).

| Topology | What it means for the steps below |
|---|---|
| **Single instance** | One Splunk Enterprise instance indexes, searches and runs the inputs, and every package goes on it. There is no distribution: in step 9 you save the Data TA's Configuration page on the instance itself. |
| **DS + HFs + on-premises search head** | Heavy forwarders run the inputs and parse the data, your Deployment Server pushes the Data TA to them, the indexers hold the indexes, and the LogServ App goes on the search head. Every step applies. |
| **DS + HFs + Splunk Cloud** | As above, but the heavy forwarders send to Splunk Cloud, you create the indexes in Splunk Cloud, and the LogServ App goes on the Splunk Cloud search head. The Deployment Server is your own, on premises: Splunk Cloud does not host one. |
| **HFs without a DS (Splunk Cloud or on-premises search head)** | You install the Data TA directly on each heavy forwarder and save its Configuration page on each one, with the same values: nothing copies them between forwarders. The indexes go on your indexer tier or the Splunk Cloud stack. |
| **Splunk Cloud only** | Supported: not blocked, but a heavy forwarder is strongly recommended. The Data TA, the cloud add-on and the LogServ App go on the Splunk Cloud search head, and the inputs run there, so ingest competes with your users' searches. The LogServ Azure and GCP add-ons declare the search-head workload, but their installation on a Splunk Cloud search head has not been tested yet. |

Clustered tiers: an indexer cluster gets the two indexes from an index-only app on its manager node (step 4); a search head cluster gets the LogServ App and its add-ons from its deployer.

Read [Plan and Prerequisites](prerequisites.md) for every topology, [Splunk Cloud Considerations](splunk-cloud.md) if you use Splunk Cloud, and [Capacity Planning and First Start](capacity-planning.md) to size the heavy forwarders.

**Done when:** you know which instance gets which package, and how many heavy forwarders you need.

<br>

### :material-circle-box:{ .taiconcolor } 3. Prepare the Forwarding Tier

These items apply to each heavy forwarder, or on a single instance to that instance. With Splunk Cloud only, the add-on and role items apply to the Splunk Cloud search head.

- **Deployment client** (topologies with a DS). Point each heavy forwarder at your Deployment Server and check that it phones home.
- **Splunk Cloud** (heavy forwarders that send to Splunk Cloud). Install your stack's universal forwarder credentials app on each heavy forwarder.
- **Network.** Allow HTTPS (port 443) from each heavy forwarder to your cloud. AWS: the AWS STS endpoint (the Splunk Add-on for AWS assumes the role `splunk-logserv-ta-role` through it), and the SQS and S3 endpoints of the Region that holds SAP's queue and bucket. Azure: `<account>.blob.core.windows.net` and `<account>.queue.core.windows.net`. GCP: `oauth2.googleapis.com`, `pubsub.googleapis.com` and `storage.googleapis.com`. If the forwarders reach the internet through a proxy, see [Plan and Prerequisites → Heavy Forwarders](prerequisites.md#heavy-forwarders).
- **AWS only: the Splunk Add-on for AWS** (Splunkbase 1876) on each heavy forwarder that will run an input. Version 8.2.2 or later is recommended (SVD-2026-1005). Install it directly on the heavy forwarder, not through a Deployment Server: the add-on keeps its accounts and inputs in its `local/` folder, which a Deployment Server push replaces, and for an add-on the Deployment Server manages, the AWS S3 Direct screen offers only its **Apply this as an administrator** view, which generates the configuration but creates nothing.
- **Who does the setup.** Creating, editing or deleting an Azure or GCP input, and the **Create backfill** button on the AWS S3 Direct screen, need a role with the `admin_all_objects` capability on the instance where you do it, on Splunk Enterprise and Splunk Cloud alike. The LogServ App treats only roles named exactly `admin`, `sc_admin` or `sc_subadmin` as admins. See [Roles and Access](prerequisites.md#roles-and-access), and on Splunk Cloud the role notes on [Splunk Cloud Considerations](splunk-cloud.md).

**Done when:** each heavy forwarder is listed in Forwarder Management (Agent Management in Splunk 10.0 and later) on your Deployment Server; with Splunk Cloud, each heavy forwarder's `_internal` events can be searched from the Splunk Cloud search head; on AWS, **Apps → Manage Apps** on each heavy forwarder shows the Splunk Add-on for AWS; and you know which account will create the inputs.

<br>

### :material-circle-box:{ .taiconcolor } 4. Create the Indexes and Set Their Retention

The solution uses two indexes: `sap_logserv_logs` for the data and `logserv_ai_assistant_audit` for the AI Assistant's audit trail. Keep these names unless you have a reason to change them; renaming takes the procedure on [Create the Indexes and Install the Data TA](../install-setup/install-ta.md).

- **Single instance.** The Data TA creates both indexes when you install it in step 5. Set their retention afterwards.
- **Standalone indexer.** Create both under **Settings → Indexes**, or with a small `indexes.conf`.
- **Indexer cluster.** Put both stanzas in an index-only app under the manager node's `manager-apps/`, with `repFactor = auto` on each, and push it as the configuration bundle. Without `repFactor = auto` the indexes are not replicated.
- **Splunk Cloud.** Create both yourself under **Settings → Indexes**, or with the Admin Config Service (ACS), before any data arrives.

**Retention.** The Data TA sets none for `sap_logserv_logs`, so Splunk's default applies unless you set one; it keeps the audit index for 90 days. Choose the retention you need when you create the indexes. Events older than an index's retention can be removed soon after they are indexed, which matters when you load history in step 12.

**Who can search the data.** Every role that will use the dashboards must be able to search `sap_logserv_logs`. Roles that may search all non-internal indexes (`*`, as Splunk's built-in roles do) already can. Add the index only to roles with a narrowed list (**Settings → Roles →** *role* **→ Indexes**, on Splunk Cloud too). Grant the audit index only as [Restricting who can read the audit index](../ai-assistant/audit-log.md#restricting-who-can-read-the-audit-index) describes.

See [Create the Indexes and Install the Data TA](../install-setup/install-ta.md#1-create-the-indexes).

**Done when:** **Settings → Indexes** on each indexer, or on Splunk Cloud, lists both indexes with the retention you chose (on a single instance, after step 5).

<br>

### :material-circle-box:{ .taiconcolor } 5. Install the Data TA

- **Topologies with a DS.** Install it on the Deployment Server only. Do not install it on the heavy forwarders by hand: the Deployment Server's push replaces each forwarder's copy, `local/` included (step 9).
- **HFs without a DS.** Install it on each heavy forwarder.
- **Single instance.** Install it on the instance.
- **Splunk Cloud only.** Install it on the Splunk Cloud search head as a private app. On Splunk Cloud it is needed only where the inputs run on the search head.
- **Indexers and search heads that run no inputs** do not need it.

See [Create the Indexes and Install the Data TA](../install-setup/install-ta.md). Leave its Configuration page unsaved until step 9.

**Done when:** **Apps → Manage Apps** shows *Splunk TA for SAP LogServ* at version 0.1.2, and its **Configuration** page opens with the **Filters** and **Cloud Provider** tabs.

<br>

### :material-circle-box:{ .taiconcolor } 6. Choose Cloud Attribution

Each event can carry an indexed `cloud_provider` field that says which cloud it came from. The recommended setup is the same for every fleet: leave the Data TA's **Cloud Provider** dropdown at **Not set** (its default). The Azure and GCP inputs stamp their own events, and AWS S3 Direct stamps the inputs it creates. On AWS you add `_meta = cloud_provider::aws` to each SQS-Based S3 input as soon as you create it in step 10, following [Add the `_meta` line to an AWS input](../install-setup/cloud-attribution.md#add-the-meta-line-to-an-aws-input): create the input, disable it at once, add the line, restart, enable it again. On Splunk Cloud with no heavy forwarder, where you cannot edit the file, see [Splunk Cloud Without a Heavy Forwarder](../install-setup/cloud-attribution.md#splunk-cloud-without-a-heavy-forwarder). Setting the dropdown as well adds a second stamp next to an input's own. See [Choose Cloud Attribution](../install-setup/cloud-attribution.md).

**Done when:** you have written down the dropdown value, and on AWS you have planned the `_meta` line for each input.

<br>

### :material-circle-box:{ .taiconcolor } 7. Decide Filtering

Filtering is off by default. Decide whether to turn it on and with which values:

- **Folders and sources** to include or exclude.
- **Days in the Past** (default 7; 0 turns it off). It applies only while filtering is on. It also leaves out of an AWS S3 Direct backfill the days older than its cutoff, so if you will load history (step 12), set it to cover that history.
- **The daily refresh.** With filtering on and Days in the Past above 0, a daily job moves the cutoff; on a Deployment Server it also reloads the server class, and each heavy forwarder restarts about once a day to apply it.
- **Azure: the Unix command output.** SAP delivers some Azure data in a folder named `undefined/undefined`: Unix command output, about 0.7 million events and 125 MB a day on the reference system, which stays under the base `sap_logserv_logs` sourcetype. Unless you need it, drop it with Exclude Sources `ps, top, netstat, iostat, vmstat, df, cpu, interfaces, bandwidth, openPorts, nfsiostat, Unix:ListeningPorts`. Folder patterns cannot reach it ([Data Delivered Without Folder Fields](supported-log-types.md#data-delivered-without-folder-fields)). If you keep it, restrict who can search it: a `ps` row can carry the arguments a process was started with, passwords and tokens included.

See [Decide Filtering](../install-setup/decide-filtering.md).

**Done when:** you have written down Enable Filtering, the include and exclude values and Days in the Past.

<br>

### :material-circle-box:{ .taiconcolor } 8. Decide on the First-Start Queue Backlog

SAP's queue keeps a notification for each new object until a consumer takes it or it expires, so a new input can start with days or weeks of notifications waiting, on Azure even months. The input works through them on top of the live feed. Decide now, before the first Save in step 9, how to handle them:

- **Let it drain.** Estimate how long the catch-up takes and size the heavy forwarders for it.
- **Ask SAP to purge the older messages**, shortly before you start the input in step 10 (in the AWS Filter and Copy scenarios, before you create the Lambda's trigger). On AWS you can load those days later with AWS S3 Direct (step 12). On Azure and GCP nothing in this solution can load them later.
- **AWS Remote S3 Filter:** its Lambda passes on only objects with events newer than its `DaysInThePast` setting, a parameter of the template you deployed in step 1. To change it, update the stack before you create the Lambda's trigger.
- **Keep old events out of the index** with Days in the Past (step 7). The forwarders still download and parse them, so the catch-up takes as long.

If your choice changes the filter values of step 7, enter the changed values in step 9. See [First Start: The Queue Backlog](capacity-planning.md#first-start-the-queue-backlog).

**Done when:** you have chosen how to handle the backlog (if a purge, SAP has agreed to do it shortly before your input starts; otherwise you have accepted the catch-up time), and your filter values reflect that choice.

<br>

### :material-circle-box:{ .taiconcolor } 9. Distribute the Data TA

- **Topologies with a DS.** On the Deployment Server, open the Data TA's **Configuration** page, enter the values from steps 6 to 8 and **Save**, whether filtering is on or off. The Save stages the Data TA for the heavy forwarders and creates the `SAP_LogServ_HeavyForwarders` server class, disabled. In Forwarder Management, edit that server class's agent assignment and name your heavy forwarders by host name or IP address. Never use `*`: it sends the Data TA, with a restart, to every deployment client, search heads included. Then click **Deploy to Forwarders**. Each heavy forwarder picks the Data TA up at its next phone-home and restarts; allow 5 minutes or more.
- **HFs without a DS, single instance, Splunk Cloud only.** Save the Configuration page with the values from steps 6 to 8 on each instance that holds the Data TA ([Without a Deployment Server](../install-setup/distribute-data-ta.md#without-a-deployment-server)).

See [Distribute the Data TA to Heavy Forwarders](../install-setup/distribute-data-ta.md).

!!! warning "Gate: the Data TA must be on every heavy forwarder before any input is created"
    An event that arrives before the Data TA keeps the base sourcetype `sap_logserv_logs`, its folder fields are never set and its routing never happens, permanently.

**Done when:** the [Version Check](capacity-planning.md#version-check) on each heavy forwarder shows the Data TA at version 0.1.2 with its build, and, with a Deployment Server, Forwarder Management shows each heavy forwarder as Ok under `SAP_LogServ_HeavyForwarders`.

<br>

### :material-circle-box:{ .taiconcolor } 10. Connect Your Cloud

Follow your cloud's guide, on each heavy forwarder that runs an input (single instance: the instance; Splunk Cloud only: the Splunk Cloud search head): [Choose Your Cloud and AWS Scenario](../install-setup/choose-your-cloud.md) leads to the AWS Remote S3 Connect, Filter or Copy guide, the [Azure Setup Guide](../install-setup/azure-setup.md) or the [GCP Setup Guide](../install-setup/gcp-setup.md). If you chose a purge in step 8, have SAP do it shortly before you create the input (Filter and Copy: before you create the Lambda's trigger).

- **AWS.** You did the AWS side in step 1, so pick up your guide at its access-key step: step 4 of the [Connect guide](../install-setup/aws-remote-s3-connect-guide.md#4-create-access-key-for-iam-user), step 5 of the [Filter](../install-setup/aws-remote-s3-filter-guide.md#5-create-access-key-for-iam-user) and [Copy](../install-setup/aws-remote-s3-copy-guide.md#5-create-access-key-for-iam-user) guides. Add `_meta = cloud_provider::aws` to each SQS-Based S3 input as soon as you create it, following [Add the `_meta` line to an AWS input](../install-setup/cloud-attribution.md#add-the-meta-line-to-an-aws-input) (create, disable at once, add the line, restart, enable); on Splunk Cloud with no heavy forwarder, see [Splunk Cloud Without a Heavy Forwarder](../install-setup/cloud-attribution.md#splunk-cloud-without-a-heavy-forwarder). In the Filter scenario, create the Lambda's trigger only once SAP has confirmed both policies: the Lambda discards a notification whose object it cannot read.
- **Azure and GCP.** Run one input per queue or subscription, on one heavy forwarder. Each input keeps its own record of what it has read, so a second input on the same queue or subscription can index a message twice ([Azure](../install-setup/azure-setup.md#multiple-landscapes-fleets), [GCP](../install-setup/gcp-setup.md#multiple-landscapes-fleets)).
- **Credential renewals.** Put the renewal dates in your calendar: the Azure SAS expiry, the GCP service-account key and the AWS access key. Replacing a SAS or key in an Azure or GCP input needs `admin_all_objects` too. See *Rotate credentials* in the [Azure](../install-setup/azure-setup.md#rotate-credentials) and [GCP](../install-setup/gcp-setup.md#rotate-credentials) guides, and *Rotate the Access Key* in your AWS guide ([Connect](../install-setup/aws-remote-s3-connect-guide.md#rotate-the-access-key), [Filter](../install-setup/aws-remote-s3-filter-guide.md#rotate-the-access-key), [Copy](../install-setup/aws-remote-s3-copy-guide.md#rotate-the-access-key)).

**Done when:** the input reads without errors (Azure and GCP: its log line `done: messages=N ... events=N` shows events; AWS: the Splunk Add-on for AWS logs no errors in `_internal`), and the first events appear in `index=sap_logserv_logs`.

<br>

### :material-circle-box:{ .taiconcolor } 11. Verify Your Data

Run the searches on [Verify Your Data](verify-data.md). Use the index name, not the `sap_logserv_idx_macro` macro: a search head that has neither the Data TA nor the LogServ App does not know the macro yet.

**Done when:** every event carries `splunk_solution=splunk_for_sap_logserv`, the sourcetypes match what SAP delivers to you ([Supported Log Types](supported-log-types.md)), each event indexed since its input got its `_meta` line has one `cloud_provider` value (a few AWS events read in the minutes between creating an input and adding the line carry none, which is expected), and no folder that the Data TA routes by folder alone stays under `sap_logserv_logs`.

<br>

### :material-circle-box:{ .taiconcolor } 12. Load History

The inputs read only what SAP's queue holds. To load older days:

- **AWS.** Use the Data TA's **AWS S3 Direct** screen on the heavy forwarder (or Splunk Cloud search head) that has the Splunk Add-on for AWS. Its **Create backfill** button needs `admin_all_objects`; without it, the screen shows the configuration for an administrator to apply. The role needs `s3:ListBucket` on the bucket, and for SAP's bucket SAP's bucket policy must also allow it (step 1). With filtering on, Days in the Past must cover the days you load, and the index's retention must cover them too. See [AWS S3 Direct: Backfill and Recovery](../install-setup/aws-s3-direct.md).
- **Azure and GCP.** The product has no history load. Contact your Splunk team.

**Done when:** on AWS, the two check searches the AWS S3 Direct screen gives under each backfill show its scan finished and the events of its days in the index.

<br>

### :material-circle-box:{ .taiconcolor } 13. Install the LogServ App and Its Search-Head Add-ons

On the search head (search head cluster: through its deployer; Splunk Cloud: the Splunk Cloud search head; single instance: the instance), install the Splunk Common Information Model add-on (`Splunk_SA_CIM`, Splunkbase 1621) 5.0.0 or later, the Splunk Add-on for Microsoft Windows (742) and the Splunk Add-on for Unix and Linux (833), then the LogServ App. Without the Windows add-on, the panels that need Windows event fields stay empty. If you renamed the data index, [update the index macro](../logserv-app/installation.md#5-update-the-index-macro). See [LogServ App Prerequisites](../logserv-app/prerequisites.md) and [Install the App and Seed the Dashboards](../logserv-app/installation.md).

**Done when:** the LogServ App opens, and the Summary of its **Diagnostics** page lists `Splunk_SA_CIM`, `Splunk_TA_windows` and `Splunk_TA_nix` as present and names your data index under *Index (from the app macro)*.

<br>

### :material-circle-box:{ .taiconcolor } 14. Run Diagnostics, Then Backfill the Dashboards

The dashboards read hourly rollups, so until you backfill them they show only the hours since the LogServ App was installed.

1. Open the LogServ App's **Diagnostics** page ([Data Doctor](../logserv-app/dashboards/platform/diagnostics.md)) and check which sourcetypes it finds.
2. As an admin (a role named `admin`, `sc_admin` or `sc_subadmin`), open **Settings → Dashboard Data**. Under **Backfill window**, pick a window that covers the history in your index, including what you loaded in step 12, up to 365 days back: 30 days by default, 60, 90, 180 or 365 days, or a custom range of UTC days.
3. Click **Run backfill**, and keep the page open until every row has finished: the Environment Topology (graph) row is written only after the page has collected its results.

Start a long backfill so that it does not run during the nightly retention window (00:34 to 02:36 in the search head's time zone): rows written into a collection while its retention runs can be lost until you run the backfill again.

See [Backfilling on first install](../logserv-app/dashboard-data.md#backfilling-on-first-install).

**Done when:** the Dashboard Data tab reports *Backfill complete*, and the dashboards show your history.

<br>

### :material-circle-box:{ .taiconcolor } 15. Optional: the AI Assistant and the Enterprise Security Content

- **AI Assistant.** It ships turned off. To use it, install the Splunk MCP Server on the search head, grant its `mcp_tool_execute` capability to the roles that will use the AI Assistant (the MCP Server grants it only to `admin` and `sc_admin`, so analysts and `sc_subadmin` need it added: [step 2 of Set Up the AI Assistant](../ai-assistant/enable.md#2-grant-mcp_tool_execute-to-the-roles-that-will-use-the-ai-assistant)), decide who is audited (a user's role needs `edit_log_alert_event` or `edit_tcp`), then have an admin turn it on and answer both acknowledgements. See [Set Up the AI Assistant](../ai-assistant/enable.md).
- **Enterprise Security content.** It ships enabled. With ES on its own search head (as on Splunk Cloud), install the LogServ App there as well ([Enterprise Security Integration: Prerequisites](../enterprise-security/overview.md#prerequisites)). On a search head without Enterprise Security, turn it off. The AI Assistant's Security prompts run 13 of these searches, and a disabled search makes its prompt fail, so if you use those prompts, stop only the schedule of those 13 and disable the rest ([Disabling or tuning the ES content](../enterprise-security/overview.md#disabling-or-tuning-the-es-content)).

**Done when:** the **AI Assistant** button appears in the LogServ App's top bar (if you turned it on), and the ES searches run on a schedule only where Enterprise Security does.

<br>

## :material-circle-box:{ .cboxmove } Next Steps

- [Configuring Filters](../install-setup/configure-filters.md): change the filters later.
- [Application Settings](../ai-assistant/settings.md): the LogServ App's settings.
- [Troubleshooting](troubleshooting.md): find the section for a symptom.
- [Upgrading to This Release](upgrading.md): when a new build comes out.
- [Removing the Solution](upgrading.md#removing-the-solution): to uninstall.
