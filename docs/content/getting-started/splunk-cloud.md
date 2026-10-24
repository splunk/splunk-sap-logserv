# Splunk Cloud Considerations

Read this page before you install Splunk for SAP LogServ where the search tier, or the whole deployment, is Splunk Cloud Platform. It covers where each package goes, how to install a private app, which Splunk Cloud roles can configure the packages, and the capability checks that can refuse a write.

Splunk assigns each Splunk Cloud Platform stack one of two Experiences, **Victoria** or **Classic**; an Experience is not a version. To find yours, in Splunk Web click **Support & Services → About**. These notes were checked on one Splunk Cloud Platform 10.x stack, most recently on 10.5.2605.10 (2026-10-21). That stack is taken to be on the Victoria Experience, but its Experience was not read from **Support & Services → About**. No test on a stack known to be on the Classic Experience is recorded.

## :material-circle-box:{ .taiconcolor } Splunk Enterprise: what still applies

If you run Splunk Enterprise and your admins use Splunk's stock `admin` role, which holds `admin_all_objects`, nothing on this page needs a workaround. These items still apply on Splunk Enterprise:

- **The audit capability.** A user's AI Assistant activity is audited only when their role holds `edit_tcp` or `edit_log_alert_event` (the `/receivers/simple` row [below](#capability-gated-rest-endpoints)). Splunk Enterprise's default `admin` role holds both, `power` holds `edit_log_alert_event`, and `user` holds neither.
- **`admin_all_objects` for Azure and GCP inputs and AWS S3 Direct backfills:** creating, editing or deleting a LogServ Azure or GCP input (replacing its SAS or service-account key included), and **Create backfill** on the AWS S3 Direct screen, which without it offers only the **Apply this as an administrator** view: it generates the configuration but creates nothing. A hardened admin role that lacks the capability is refused these too.
- **The [filesystem fallback for Data TA Configuration saves](#data-ta-configuration-saves-fall-back-to-the-filesystem)**, which serves any role in the write list that lacks `admin_all_objects`, a hardened admin role included.
- **The `edit_deployment_server` check on Deploy to Forwarders**, on your own Deployment Server ([below](#deploy-to-forwarders-does-not-apply-on-splunk-cloud)).
- **The admin-tier write lists** on the LogServ App's KV Store collections. They apply on every platform ([Application Settings](../ai-assistant/settings.md)).

## :material-circle-box:{ .taiconcolor } Where the packages go with Splunk Cloud

The full matrix is [Where Each Package Goes](package-placement.md#package-matrix). With Splunk Cloud:

| Where | What to install |
|---|---|
| **Splunk Cloud search head** | The LogServ App and its search-tier add-ons ([LogServ App Prerequisites](../logserv-app/prerequisites.md)). |
| **Splunk Cloud indexes** | Create `sap_logserv_logs` and `logserv_ai_assistant_audit` yourself, with the retention you want, before any data arrives: **Settings → Indexes → New Index**, or the Admin Config Service (ACS). See [Create the indexes](../install-setup/install-ta.md#1-create-the-indexes). |
| **Your heavy forwarders** (Splunk Enterprise instances you run) | The Data TA and the ingest add-on for your cloud: the Splunk Add-on for AWS, the LogServ Azure add-on or the LogServ GCP add-on. They send to the stack with its universal forwarder credentials app. If a Deployment Server manages the forwarders, install the Data TA on the Deployment Server only and push it from there ([Distribute the Data TA to Heavy Forwarders](../install-setup/distribute-data-ta.md)); without one, install it directly on each forwarder. Install the Azure and GCP add-ons directly on the forwarders that run their inputs, never through the Deployment Server. |

Notes:

- **Retention counts from each event's time.** Splunk freezes a bucket when its newest event is older than the index's retention, so history you load later with AWS S3 Direct is removed soon after indexing if the index keeps less than its age. Set **Searchable retention (days)** to cover the oldest day you will load.
- **The Data TA on the Cloud stack** is allowed, and needed only where the inputs run on the search head.
- **Splunk Cloud with no heavy forwarder** is supported: it is not blocked, but a heavy forwarder is strongly recommended. On the stack these notes were checked on, installing the Data TA and the LogServ App on the search head and opening the AWS S3 Direct screen there have been checked; creating and running inputs there has not been tested. On the Classic Experience, inputs run on an Inputs Data Manager (IDM) rather than the search head; that path has not been tested ([Where Each Package Goes](package-placement.md)). On Victoria the LogServ App, the Data TA and the ingest add-on all go on the Cloud search head, and the inputs run there, so the search tier your users search on also carries the ingest load, including the [first-start backlog](capacity-planning.md#first-start-the-queue-backlog). The LogServ Azure and GCP add-ons declare search-head support, but running them on a Splunk Cloud search head has not been tested. See [Running the TAs on a search head](../install-setup/install-ta.md#running-the-tas-on-a-search-head).

## :material-circle-box:{ .taiconcolor } Installing the packages on Splunk Cloud

The Splunk Add-on for AWS and the search-tier add-ons are on Splunkbase. The LogServ App, the Data TA and the LogServ Azure and GCP add-ons are private apps: download their tarballs from the repository's [`release_binaries/`](https://github.com/splunk/splunk-sap-logserv/tree/main/release_binaries) and upload them.

- **Victoria Experience:** in Splunk Web, **Apps → Manage Apps → Install app from file**, or install with ACS. Splunk vets each upload before it installs it. Splunk's steps: <a href="https://help.splunk.com/en/splunk-cloud-platform/administer/admin-manual/9.3.2411/manage-apps-and-add-ons-in-splunk-cloud-platform/manage-private-apps-on-your-splunk-cloud-platform-deployment#b5f810d7_e842_487d_b752_3662cfb646bc__Install_a_private_app_on_Victoria_Experience" target="_blank">Install a private app on Victoria Experience</a>.
- **Classic Experience:** follow <a href="https://help.splunk.com/en/splunk-cloud-platform/administer/admin-manual/9.3.2411/manage-apps-and-add-ons-in-splunk-cloud-platform/manage-private-apps-on-your-splunk-cloud-platform-deployment#e86cbd1a_f4ec_4256_9299_f2c56c9842ad__Install_a_private_app_on_Classic_Experience" target="_blank">Install a private app on Classic Experience</a>.

Each LogServ package passes AppInspect's Cloud checks (`--mode precert --included-tags cloud`) with no errors and no failures; the reports are beside the tarballs in `release_binaries/`. To update, upload the newer tarball the same way: a newer build with the same version number (0.1.2) installs over the installed one (checked on Splunk Cloud Platform 10.5.2605.10).

You cannot edit files under an app's `local/` on Splunk Cloud. Use these Splunk Web screens instead of the `local/` edits other pages describe:

| Setting | Where in Splunk Web |
|---|---|
| Indexes and their retention | **Settings → Indexes** |
| Which indexes a role can search | **Settings → Roles →** *role* **→ Indexes** |
| Filters and the Cloud Provider value (where the Data TA runs on the search head) | **Apps → Splunk TA for SAP LogServ → Configuration** |
| History loads from AWS | **Apps → Splunk TA for SAP LogServ → AWS S3 Direct** ([AWS S3 Direct](../install-setup/aws-s3-direct.md#2a-the-aws-s3-direct-screen)) |
| The data index macro after a rename | **Settings → Advanced search → Search macros**, `sap_logserv_idx_macro`, in each LogServ app that has it ([Renaming an Index](../install-setup/install-ta.md#renaming-an-index)) |
| Disabling or re-scheduling the LogServ App's scheduled searches | **Settings → Searches, reports, and alerts** |
| AI Assistant and Dashboard Data settings | the LogServ App's **Settings** pages ([Application Settings](../ai-assistant/settings.md)) |

One setting has no Splunk Web field: the `_meta = cloud_provider::aws` line on a Splunk Add-on for AWS SQS-Based S3 input that runs on the Cloud search head (the add-on's SQS-Based S3 form has no field for it; checked on version 8.3.1). Without file access, set it with a REST write that needs `admin_all_objects`; see [Splunk Cloud Without a Heavy Forwarder](../install-setup/cloud-attribution.md#splunk-cloud-without-a-heavy-forwarder).

## :material-circle-box:{ .taiconcolor } Splunk Cloud roles

| Role | Who has it | What it means for LogServ |
|---|---|---|
| `sc_admin` | The customer's administrator role on Splunk Cloud Platform. Splunk gives it the capabilities to install apps, manage indexes, and manage users and passwords. | The role you normally install and configure LogServ with. |
| `admin` and the system-user roles | Splunk, which uses them to monitor and maintain the stack. | Do not change or delete them. |
| `sc_subadmin` (only where your stack has one) | Not a Splunk-supplied role. Some stacks create a delegated-admin role with this name. | LogServ grants it write access by name and the App treats it as an admin. Its capabilities, `admin_all_objects` included, are whatever your stack gave it. |
| `power`, `user` | Standard roles. | Search and view dashboards; cannot install or configure apps. |

**Check your role.** In **Settings → Users**, look at the roles on your account. If you hold `sc_admin`, you are the stack administrator. If you hold a delegated-admin role (such as `sc_subadmin`), open it under **Settings → Roles →** *role* **→ Capabilities** and check for `admin_all_objects`, `edit_storage_passwords`, and `edit_tcp` or `edit_log_alert_event`. The [table below](#capability-gated-rest-endpoints) says what each one controls.

!!! warning "Only three role names count as admin"
    The LogServ App treats a user as an admin only when they hold a role named exactly `admin`, `sc_admin` or `sc_subadmin`, and the packages' write lists in `metadata/default.meta` name only those three roles. A user whose delegated-admin role has any other name gets no **Settings** entry in the App's menu, and opening the page shows **403 — Admin access required**, so that user cannot change the AI Assistant settings or run **Dashboard Data** Clear and Backfill. Give such users one of the three roles itself; whether a role that only imports one of them is enough has not been tested. See [Who Can Open the Page](../ai-assistant/settings.md#who-can-open-the-page).

The AI Assistant also needs the Splunk MCP Server's `mcp_tool_execute` capability, which the MCP Server grants by default only to `admin` and `sc_admin`. Add it to a delegated-admin role such as `sc_subadmin` and to every analyst role that will use the AI Assistant ([Roles and Capabilities](../ai-assistant/mcp-setup.md#roles-and-capabilities)).

## :material-circle-box:{ .taiconcolor } Capability-gated REST endpoints

Splunk's REST framework enforces some capability requirements server-side, independent of any per-object access control list. These gates decide what an admin role without `admin_all_objects` (a delegated admin on Splunk Cloud, or a hardened admin on Splunk Enterprise) can do with the LogServ packages; the `/receivers/simple` gate also decides whether each AI Assistant user is audited:

| REST endpoint | Gate | LogServ usage |
|---|---|---|
| `/storage/passwords` | `edit_storage_passwords` | HEC audit-forwarder tokens, MCP bearer tokens, and LLM provider credentials where the free-form path is used |
| `/storage/collections/data/<collection>` | None — collection-level metadata ACL only | AI Assistant settings + acks, topology layouts, dashboard refresh preferences |
| `/configs/conf-<name>/...` | **`admin_all_objects`** (splunkd refuses the write with `requires capability: admin_all_objects` even when the app's metadata gives the role write access) | The Data TA's **Configuration** tabs, which fall back to a direct file write on a 403 ([below](#data-ta-configuration-saves-fall-back-to-the-filesystem)). The LogServ App keeps its AI Assistant settings in KV Store instead, to avoid this gate. |
| `/data/inputs/<service>` | **`admin_all_objects`** | Creating, editing or deleting a LogServ **Azure** or **GCP** input on the add-on's **Inputs** page, replacing its SAS or service-account key included. The input handler writes the input to `data/inputs/<kind>` as the signed-in user, and splunkd refuses that write to a role without the capability, so the save fails with HTTP 403 ("This operation is forbidden"), on any platform. The `passSystemAuth = true` line each add-on carries on its `[admin_external:*]` stanza has no effect: Splunk defines that setting only for `[script:*]` handlers. Create these inputs on a heavy forwarder (recommended), with a role that holds the capability. |
| The Splunk Add-on for AWS input endpoint (`/servicesNS/nobody/Splunk_TA_aws/splunk_ta_aws_aws_s3`), and the Data TA's `s3_direct_meta` handler, which writes `configs/conf-inputs` and disables and enables the new input through `data/inputs/aws_s3` | **`admin_all_objects`**: the screen checks for it before it offers **Create backfill**, and the handler's `configs/conf-inputs` write is behind the `/configs/conf-*` gate above | The Data TA's **AWS S3 Direct** screen. Its writes run as the signed-in user, with no system-context bypass, by design. Without the capability the screen shows **Apply this as an administrator** with the generated configuration and creates nothing. On Splunk Cloud, sign in with an account that holds the capability and create the backfill on the screen; do not apply the generated configuration by hand. See [AWS S3 Direct](../install-setup/aws-s3-direct.md#2a-the-aws-s3-direct-screen). |
| `/receivers/simple` | **`edit_tcp`** or **`edit_log_alert_event`** (on Splunk Enterprise the default `admin` role holds both, `power` holds `edit_log_alert_event` and `user` neither; on Splunk Cloud, check your roles as described [above](#splunk-cloud-roles)) | AI Assistant audit events: the browser writes each one as the signed-in user, so a user without either capability is not audited and sees an **Audit events are not being written** warning in the AI Assistant panel. `edit_log_alert_event` is the narrower one to grant; either lets the role write events to any index, and `edit_tcp` also lets it change TCP data inputs — see [Who Can Write Audit Events](../ai-assistant/audit-log.md#who-can-write-audit-events) |

The takeaway: **write access in an app's metadata does not get past these gates; a role without the capability gets 403.** The LogServ packages avoid the gates where they can (the App keeps its settings in KV Store) or work around them (the Data TA's Configuration saves fall back to a direct file write). Three actions they neither avoid nor bypass, on Splunk Cloud and Splunk Enterprise alike:

- creating, editing or deleting a LogServ Azure or GCP input: `admin_all_objects`;
- **Create backfill** on the AWS S3 Direct screen: `admin_all_objects`;
- writing AI Assistant audit events on `/receivers/simple`: `edit_tcp` or `edit_log_alert_event`, checked for each user, so whether a user's activity is audited depends on that user's role.

## :material-circle-box:{ .taiconcolor } What the LogServ packages do for admin roles

These are in the shipped packages and need no configuration.

### :material-circle-box:{ .taiconcolor } `sc_subadmin` in `metadata/default.meta` write ACL

Every LogServ package (the App, the Data TA, and the Azure and GCP add-ons) ships this global rule in `metadata/default.meta`: `access = read : [ * ], write : [ admin, sc_admin, sc_subadmin ]`. It gives the three roles write access to every knowledge object in the app (saved searches, macros, lookups, eventtypes, tags, etc.) at the metadata layer. The packages do not create `sc_subadmin`; they name it for stacks that have a delegated-admin role of that name. The App's KV Store collections use the same three-role write list, apart from six that every user writes: four per-user preference collections and two Data Doctor collections. The App keeps the AI Assistant's settings and legal acknowledgements in KV Store, which needs no `admin_all_objects`, and opens its **Application Settings** page only to the three role names; both are described in [Application Settings](../ai-assistant/settings.md).

If you rebuild the Data TA from source, the build step that keeps `sc_subadmin` in this list is described in [Data TA Internals](../developer/data-ta-internals.md).

### :material-circle-box:{ .taiconcolor } Data TA Configuration saves fall back to the filesystem

The Data TA's **Configuration → Filters** and **Cloud Provider** tabs write their settings through splunktaucclib's REST persist. If that write returns 403 ("This operation is forbidden" — the `admin_all_objects` gate on `/configs/conf-*`), the handler falls back to writing `local/splunk_ta_sap_logserv_settings.conf` directly on the filesystem, so **Save succeeds for a role in the write list without `admin_all_objects`**: a delegated admin role on Splunk Cloud, or a hardened admin role on Splunk Enterprise. Note `passSystemAuth` is **not** honoured for UCC `[admin_external:*]` settings handlers — the filesystem fallback is what actually carries these saves. The LogServ Azure and GCP add-ons have no such fallback (the `/data/inputs/<service>` row [above](#capability-gated-rest-endpoints)).

## :material-circle-box:{ .taiconcolor } Deploy to Forwarders does not apply on Splunk Cloud

The Data TA's **Deploy to Forwarders** button (Configuration → Filters and Cloud Provider) appears only on a Deployment Server, and a Splunk Cloud stack is never one. So the button does not appear on Splunk Cloud, for any role, and Splunk Cloud needs no capability for it. A Deployment Server for your heavy forwarders is a Splunk Enterprise instance you run yourself; your Splunk Cloud subscription includes a Deployment Server license, which you request from Splunk Support. See [Distribute the Data TA to Heavy Forwarders](../install-setup/distribute-data-ta.md).

On that Deployment Server, the button and the check that decides whether to show it need the `edit_deployment_server` capability, not `admin_all_objects`. Splunk Enterprise's `admin` role holds it; a custom Deployment Server operator role needs it added, or the button does not appear.

## :material-circle-box:{ .taiconcolor } Splunk Cloud Support tickets you may need to file

| Symptom | Ticket request |
|---|---|
| AI Assistant SETUP REQUIRED banner; MCP requests return `Invalid token audience: <X>` | Ask Splunk Cloud Support to set the stack's MCP audience to `mcp` ([Splunk MCP Setup](../ai-assistant/mcp-setup.md#splunk-cloud-jwt-aud-audience-claim-must-be-mcp)) |
| Your admin role cannot install private apps, or private-app vetting rejects one | Standard Splunk Cloud private-app submission flow; out of scope for this guide |
| Your delegated admin role needs `admin_all_objects`: the AWS S3 Direct screen shows **Apply this as an administrator**, or an Azure or GCP input save returns 403 | Sign in with an account that holds `admin_all_objects`, or ask your stack's administrator or Splunk Cloud Support whether your role can be given it |

## :material-circle-box:{ .cboxmove } Next Steps

- [Capacity Planning and First Start](capacity-planning.md): size the instances that parse LogServ data, and plan for the backlog a new input finds in its queue.
- [Create the Indexes and Install the Data TA](../install-setup/install-ta.md).
