# Plan and Prerequisites

Use this page before you install anything: it lists what to request from SAP, what each Splunk tier needs, and the access, volume and retention decisions to make first. Which package goes on which instance is on [Where Each Package Goes](package-placement.md); the order of the whole deployment is on the [Deployment Roadmap](roadmap.md).

### :material-circle-box:{ .taiconcolor } Splunk Platform Requirements { #splunk-platform-requirements }

- **Splunk Enterprise 9.4.3 or later, or Splunk Cloud Platform.** 9.4.3 is the minimum supported version: it is the platform this release is tested on. Nothing in the packages enforces it at install, and the LogServ App does not depend on Splunk's own UI components (it bundles its own React and `@splunk` UI libraries).
- **Splunk Cloud Platform:** checked on Victoria Experience stacks running Splunk Cloud Platform 10.x, most recently 10.5.2605.10 (2026-10-21). No test on the Classic Experience is recorded.
- **Heavy forwarders**, not universal forwarders, for the ingest tier: the Data TA does its work while the data is parsed, and the ingest add-ons run as inputs on a full Splunk Enterprise instance.

### :material-circle-box:{ .taiconcolor } The Packages

A deployment of Splunk for SAP LogServ uses three kinds of package:

- the **Data TA** (`splunk_ta_sap_logserv`): index-time parsing, sourcetype routing and filtering of the data your ingest add-on collects; it has no data inputs of its own;
- the **LogServ App** (`splunk_app_sap_logserv`): dashboards and search-time content on the search head;
- one **ingest add-on** for your cloud: the Splunk Add-on for AWS, the **LogServ Azure add-on** (`splunk_ta_sap_logserv_azure`) or the **LogServ GCP add-on** (`splunk_ta_sap_logserv_gcp`).

[Architecture](architecture.md) explains what each does.

### :material-circle-box:{ .taiconcolor } Request from SAP and Prepare Your Cloud Account { #request-from-sap }

SAP LogServ is an optional SAP ECS service: confirm with SAP that it is enabled for your SAP ECS landscape before you request anything below.

Start these first: they wait on SAP support and on your own cloud administrators, and nothing can be ingested until they are done. Each cloud's setup guide has the details.

#### :material-crop-square:{ .taiconcolor } SAP ECS on AWS { #sap-ecs-running-in-amazon-web-services-aws }

Choose your AWS scenario first ([Choose Your Cloud and AWS Scenario](../install-setup/choose-your-cloud.md)). **Connect** is the default. **Filter** is for when the forwarder load or the first-start backlog has to be cut. **Copy** keeps your own copy of new objects from the time it starts (plus what is still waiting in SAP's queue); it cannot load older history, and it stores the objects decompressed. History is loaded with [AWS S3 Direct](../install-setup/aws-s3-direct.md) in every scenario.

From SAP LogServ support:

1. The ARNs of the S3 bucket that holds your LogServ data in the SAP ECS account and of the SQS queue that receives its notifications, and their AWS Region.
2. After you deploy the scenario's CloudFormation template in your Secondary account: the two access policies, one on SAP's queue and one on SAP's bucket, that give your role `splunk-logserv-ta-role` access. The example policies are in the repository's <a href="https://github.com/splunk/splunk-sap-logserv/tree/main/aws_assets/sap_ecs_account_policies" target="_blank">aws_assets/sap_ecs_account_policies/</a> folder.
3. If you will load history with AWS S3 Direct (in any scenario: data from before your inputs started is only in SAP's bucket): `s3:ListBucket` on the bucket ARN in SAP's bucket policy. The example policy includes it, but SQS-based ingest never needs it, so confirm that SAP kept it.

In your own AWS account:

- A **Secondary AWS account**, separate from the SAP ECS account, in which you can deploy CloudFormation stacks and create IAM users and roles. Deploy the stack in the Region of SAP's bucket and queue.
- **Filter and Copy:** an S3 bucket for the Lambda code, with a name of your own (bucket names are global), in the stack's Region.
- **The IAM user's access key** that the setup guides create: plan how you will rotate it (Rotate the Access Key in the [Connect](../install-setup/aws-remote-s3-connect-guide.md#rotate-the-access-key), [Filter](../install-setup/aws-remote-s3-filter-guide.md#rotate-the-access-key) or [Copy](../install-setup/aws-remote-s3-copy-guide.md#rotate-the-access-key) guide).

#### :material-crop-square:{ .taiconcolor } SAP ECS on Azure { #sap-ecs-running-in-microsoft-azure }

SAP provisions the storage account, the container, the Storage Queue and the Event Grid subscription in the SAP ECS Azure account; you create nothing in Azure. From SAP support:

1. The storage account name and the Storage Queue name.
2. An account SAS with `ss=bq`, `srt=o` and `sp=rp` (blob read and queue process), plus `a` if you will configure a dead-letter queue. See [What the SAP-provided SAS must cover](../install-setup/azure-setup.md#what-the-sap-provided-sas-must-cover).
3. The SAS expiry date (its `se=` value) and how SAP renews it. When the SAS expires, the input stops reading until you enter a new one. Put the date in your calendar; see [Rotate credentials](../install-setup/azure-setup.md#rotate-credentials).

See [Parameters to obtain from SAP](../install-setup/azure-setup.md#parameters-to-obtain-from-sap).

#### :material-crop-square:{ .taiconcolor } SAP ECS on Google Cloud { #sap-ecs-running-in-google-cloud-platform-gcp }

SAP provisions the bucket, its notification, the Pub/Sub topic and the subscription in the SAP-managed project. The one resource you create is the service account:

1. In a GCP project of your own, separate from the SAP-managed project, create a service account. It needs no roles in your project.
2. Enable the Cloud Pub/Sub API and the Cloud Storage API in that project.
3. Check before install day whether the organization policy `iam.disableServiceAccountKeyCreation` applies to the project: it blocks the JSON key the input needs.
4. Give the service account's email address to SAP support. SAP grants it `roles/pubsub.subscriber` on the LogServ subscription and `roles/storage.objectViewer` on the bucket, and returns the project ID and the subscription name for the input. Ask also for the subscription's acknowledgement deadline.
5. Plan how you will rotate the service account's key: it is yours, and nothing renews it for you. See [Rotate credentials](../install-setup/gcp-setup.md#rotate-credentials).

See [The onboarding sequence](../install-setup/gcp-setup.md#the-onboarding-sequence), [What SAP must grant your service account](../install-setup/gcp-setup.md#what-sap-must-grant-your-service-account) and [Parameters for the input](../install-setup/gcp-setup.md#parameters-for-the-input).

#### :material-crop-square:{ .taiconcolor } Every Cloud: the Queue Backlog

Ask SAP how long its queue keeps a message and how old its oldest message is. A new input starts with every notification still waiting, which can be days or weeks of data, and on Azure even months. Decide before the input starts whether SAP purges the older messages or you filter them. On AWS, purged days can be loaded later with AWS S3 Direct; on Azure and Google Cloud, nothing in this solution can load a purged day. See [First Start: The Queue Backlog](capacity-planning.md#first-start-the-queue-backlog).

### :material-circle-box:{ .taiconcolor } Deployment Server

A Deployment Server is optional. Use one to manage the Data TA on several heavy forwarders; without one, you install and configure the Data TA on each heavy forwarder.

- It is a Splunk Enterprise instance you run. A Splunk Cloud stack is never a Deployment Server; your Splunk Cloud subscription includes a license for one you run yourself (request it from Splunk Support).
- The heavy forwarders must be its deployment clients (`deploymentclient.conf`) before you distribute the Data TA.
- **Deploy to Forwarders** needs the `edit_deployment_server` capability, which Splunk's `admin` role has.
- Add only the heavy forwarders that collect LogServ data to the `SAP_LogServ_HeavyForwarders` server class, never `*`: `*` would push the Data TA, with a restart, to every deployment client, search heads included.
- Keep the ingest add-ons out of its server classes; see [Heavy Forwarders](#heavy-forwarders).

See [Distribute the Data TA to Heavy Forwarders](../install-setup/distribute-data-ta.md).

### :material-circle-box:{ .taiconcolor } Heavy Forwarders { #heavy-forwarders }

- **Forwarding:** each heavy forwarder forwards to your indexers. For Splunk Cloud, install on it the universal forwarder credentials app that your Splunk Cloud stack provides.
- **The Data TA:** from your Deployment Server, or installed directly when no Deployment Server manages it.
- **The ingest add-on for your cloud, installed directly on each heavy forwarder that may run an input, never through a Deployment Server.** Its credentials and inputs live in its own `local/`, which a push would replace. A heavy forwarder is strongly recommended over a search head; a search head is not blocked (see [Running the TAs on a search head](../install-setup/install-ta.md#running-the-tas-on-a-search-head)).
    - **AWS:** the <a href="https://splunkbase.splunk.com/app/1876" target="_blank">Splunk Add-on for AWS (Splunkbase 1876)</a>. No minimum version is enforced; 8.2.2 or later is recommended (Splunk advisory SVD-2026-1005, third-party package fixes). These pages were checked with 8.3.1, and the AWS S3 Direct screen warns about versions below 8.1.0. Install it now and configure it with your AWS setup guide (<a href="https://splunk.github.io/splunk-add-on-for-amazon-web-services/Installationandconfiguration/" target="_blank">add-on documentation</a>). Its SQS-Based S3 inputs may share one queue across inputs and forwarders; see [Add Heavy Forwarders on the Same Queue](capacity-planning.md#add-heavy-forwarders-on-the-same-queue).
    - **Azure:** the LogServ Azure add-on; see [Install the Azure add-on](../install-setup/azure-setup.md#install-the-azure-add-on). Run one input for each queue: each input keeps its own record of what it has read, so a second input on the same queue can index a redelivered message twice.
    - **Google Cloud:** the LogServ GCP add-on; see the [GCP Setup Guide](../install-setup/gcp-setup.md). Run one input for each subscription, for the same reason.
- **Network egress** (HTTPS, port 443):
    - AWS: the AWS STS endpoint, and the SQS and S3 endpoints of the Region that holds SAP's queue and bucket.
    - Azure: `<account>.queue.core.windows.net`, and the blob endpoint each notification names, normally `<account>.blob.core.windows.net`.
    - Google Cloud: `oauth2.googleapis.com`, `pubsub.googleapis.com` and `storage.googleapis.com`.
- **Outbound proxy:**
    - The Splunk Add-on for AWS has its own setting, on its **Configuration > Proxy** tab (checked in version 8.3.1).
    - The LogServ Azure and GCP add-ons have no proxy setting. They use Python's standard HTTP client, which takes its proxy from `HTTPS_PROXY` in splunkd's environment. This comes from reading their code and has not been tested in the lab.
    - Whenever splunkd runs with `HTTP_PROXY` or `HTTPS_PROXY` set, also set `NO_PROXY=127.0.0.1,localhost` (plus the host name in `mgmtHostPort`, if it is not a loopback address). Otherwise calls to splunkd's own management port, with their session key, go to the proxy.
- **The `admin_all_objects` capability**, on any platform, for creating, editing or deleting an Azure or GCP input, which includes entering a new SAS or key: the add-ons save the input through Splunk's REST interface as the signed-in user, and Splunk allows that write only with this capability. The **Create backfill** button of the AWS S3 Direct screen needs it too; without it the screen only generates the configuration for an administrator to apply. Find a role that holds it on each instance where you will do this.
- **Capacity:** the Data TA's work per event decides how many heavy forwarders your volume needs; see [Capacity Planning and First Start](capacity-planning.md).

### :material-circle-box:{ .taiconcolor } Indexers

Create `sap_logserv_logs` and `logserv_ai_assistant_audit` on the indexer tier before any data arrives:

- **Single instance:** the Data TA creates both when it first loads.
- **Standalone indexer:** **Settings > Indexes**, or a small `indexes.conf`.
- **Indexer cluster:** an index-only app with both stanzas and `repFactor = auto`, in the manager node's `manager-apps/`, pushed as the configuration bundle. Without `repFactor = auto` the indexes are not replicated.
- **Splunk Cloud:** **Settings > Indexes**, or the Admin Config Service (ACS).

Separate indexers do not need the Data TA itself. The settings to use are on [Create the Indexes and Install the Data TA](../install-setup/install-ta.md#1-create-the-indexes). Both index names can be changed: the LogServ App finds them through the macros `sap_logserv_idx_macro` and `sap_logserv_audit_idx_macro`; see [Renaming an index](../install-setup/install-ta.md#renaming-an-index).

### :material-circle-box:{ .taiconcolor } Search Head: the LogServ App and Its Add-ons { #required-splunk-add-ons }

On the search tier (the search head, the Splunk Cloud search head, or every member of a search head cluster), install:

- the **LogServ App**;
- **Splunk_SA_CIM** (Splunkbase 1621) 5.0.0 or later, the App's declared dependency;
- the **Splunk Add-on for Microsoft Windows** (742), which the Windows dashboard needs;
- the **Splunk Add-on for Unix and Linux** (833), for the CIM fields of `linux_secure`;
- only for the AI Assistant: the **Splunk MCP Server** (7931) and, optionally, the **Splunk AI Assistant** (7245).

These add-ons go on the search tier only, not on the Deployment Server, the heavy forwarders or the indexers. Do not install the standalone Squid Proxy or ISC BIND add-ons: the LogServ App has their parsing built in. KV Store must be enabled on the search head. See [LogServ App Prerequisites](../logserv-app/prerequisites.md).

### :material-circle-box:{ .taiconcolor } Capacity, Volume and Retention

- **Daily volume and license.** Every event the filters keep is indexed into `sap_logserv_logs` and counts toward your Splunk license; events the filters drop do not. Measure the log-type mix and the forwarder load with [Measure Your Own Heavy Forwarder](capacity-planning.md#measure-your-own-heavy-forwarder).
- **Azure Unix command output.** On Azure, SAP also delivers Unix command output (`ps`, `top`, `netstat` and others) in a folder named `undefined/undefined`: on the reference system about 0.7 million events and 125 MB of text a day, which the Data TA indexes unparsed. Decide whether to drop it before the input starts; see [Data Delivered Without Folder Fields](supported-log-types.md#data-delivered-without-folder-fields) and [Decide Filtering](../install-setup/decide-filtering.md).
- **Retention.** The Data TA sets no retention or size limit for `sap_logserv_logs`, so Splunk's defaults apply until you set your own; it gives `logserv_ai_assistant_audit` 90 days (`frozenTimePeriodInSecs = 7776000`). Where you create the indexes yourself, set both. Make the retention of `sap_logserv_logs` cover the oldest data you will load: events older than an index's retention are removed soon after they are indexed.

### :material-circle-box:{ .taiconcolor } Roles and Access { #roles-and-access }

Check these before users open the dashboards:

- **Every role that uses the dashboards can search `sap_logserv_logs`.** On Splunk Enterprise the default `user` role allows `*`, which matches every index whose name does not start with `_`, so it and the roles that import it (such as `power`) can already search the index. Add the index to any role with a narrowed list (**Settings > Roles >** *role* **> Indexes**). On Splunk Cloud, check each role's **Indexes** tab the same way.
- **The audit index** is granted only as [Restricting who can read the audit index](../ai-assistant/audit-log.md#restricting-who-can-read-the-audit-index) describes.
- **App admins.** The LogServ App treats only roles named exactly `admin`, `sc_admin` or `sc_subadmin` as admins. Only they can open its Settings page and clear or backfill the dashboard data. Give the people who run the App one of these roles; see [LogServ App Prerequisites](../logserv-app/prerequisites.md).

### :material-circle-box:{ .taiconcolor } Splunk Cloud

- **Roles.** `sc_admin` is the customer's administrator role. Splunk uses the `admin` role and the system roles to run the stack. `sc_subadmin` is not a standard role; some stacks create a delegated-admin role with that name.
- **Installs** are private-app installs on your stack (on the Victoria Experience: **Install app from file**, or ACS), which run Splunk's app vetting.
- **Indexes:** create both yourself, as above, with the retention you want.
- **No Deployment Server:** the Data TA's **Deploy to Forwarders** button never appears on a Splunk Cloud stack. Use a Deployment Server of your own, or install the Data TA directly on each heavy forwarder.
- **`admin_all_objects`:** the gates above apply on Splunk Cloud too, and whether your admin role holds the capability depends on your stack; check it under **Settings > Roles**. See [Capability-gated REST endpoints](splunk-cloud.md#capability-gated-rest-endpoints).

See [Splunk Cloud Considerations](splunk-cloud.md).

## :material-circle-box:{ .cboxmove } Next Steps

- [Splunk Cloud Considerations](splunk-cloud.md), if you use Splunk Cloud.
- [Capacity Planning and First Start](capacity-planning.md): how many heavy forwarders, and the first-start backlog.
- [Create the Indexes and Install the Data TA](../install-setup/install-ta.md).
