# Architecture

This page shows how Splunk for SAP LogServ moves SAP LogServ data from your cloud into Splunk, and what each package does on the way. Read it while you plan; which package goes on which Splunk instance is on [Where Each Package Goes](package-placement.md).

## :material-circle-box:{ .taiconcolor } The Packages { #two-package-model }

Splunk for SAP LogServ is four packages of its own, plus the Splunk Add-on for AWS when your SAP ECS data is in AWS:

| Package | Splunk Web label | App ID | What it does |
|---------|------------------|--------|--------------|
| **Data TA** | Splunk TA for SAP LogServ | `splunk_ta_sap_logserv` | Index-time parsing, sourcetype routing and the optional filters for the data your ingest add-on collects. It has no data inputs of its own: its two scripted inputs are maintenance jobs that write to `_internal`. It also carries the Configuration page (Filters, Cloud Provider), the Deployment Server automation, the AWS S3 Direct backfill screen, and the definitions of the two indexes, `sap_logserv_logs` (SAP data) and `logserv_ai_assistant_audit` (AI Assistant audit log). |
| **LogServ App** | Splunk App for SAP LogServ | `splunk_app_sap_logserv` | Dashboards, search-time field extractions, macros, the scheduled searches that fill the dashboards' KV Store rollups, Environment Topology, the Enterprise Security content and the AI Assistant (ships disabled). It contains no Python and no inputs. |
| **Splunk Add-on for AWS** | Splunk Add-on for AWS | `Splunk_TA_aws` (Splunkbase 1876) | Collects from AWS S3: its SQS-Based S3 inputs read the notifications of new LogServ objects and download the objects. The AWS S3 Direct screen creates Generic S3 inputs in it for backfill. |
| **LogServ Azure add-on** | Splunk TA for SAP LogServ on Azure | `splunk_ta_sap_logserv_azure` | Collects from Azure Blob Storage: its `sap_logserv_azure_queue` input reads the Storage Queue that Event Grid fills with `BlobCreated` notifications and fetches each blob with a SAS. See the [Azure Setup Guide](../install-setup/azure-setup.md). |
| **LogServ GCP add-on** | Splunk TA for SAP LogServ on GCP | `splunk_ta_sap_logserv_gcp` | Collects from Google Cloud Storage: its `sap_logserv_gcp_pubsub` input pulls a Pub/Sub subscription fed by the bucket's `OBJECT_FINALIZE` notifications and fetches each object with a service-account key. See the [GCP Setup Guide](../install-setup/gcp-setup.md). |

Each NDJSON line of a LogServ object becomes one event with sourcetype `sap_logserv_logs` (on AWS you set it on the SQS-Based S3 input, and it must be exactly `sap_logserv_logs`: the Data TA parses and routes only events that arrive with that sourcetype; the Azure and GCP inputs always use it). The Azure and GCP inputs also stamp `cloud_provider` on their events. From there the Data TA handles every cloud the same way.

The **Data TA** works where the data is parsed: on the heavy forwarders that run the ingest inputs, or on a single instance. A heavy forwarder parses each event before it forwards it, so the indexers receive finished events and the Data TA's index-time settings do nothing there. The indexers only need the two indexes; in a distributed deployment you create them on the indexer tier. A Deployment Server, if you use one, holds the Data TA to distribute it to the heavy forwarders. The `logserv_ai_assistant_audit` index is where the AI Assistant writes its audit events; without it they have nowhere to go.

The **LogServ App** works at search time on the search head (or the single instance). It finds the SAP data through the macro `sap_logserv_idx_macro` and the audit events through `sap_logserv_audit_idx_macro`, so a renamed index needs the macros changed rather than the App; see [Renaming an index](../install-setup/install-ta.md#renaming-an-index).

!!! tip "Why separate packages?"
    Index-time work and search-time work run on different Splunk tiers. Keeping them apart means the forwarders carry no dashboards, search-time extractions or AI Assistant code, and the search head carries no ingest logic. On a single instance both packages are installed on the same instance and Splunk merges their configuration.

## :material-circle-box:{ .taiconcolor } Install Matrix

Where you install each package depends on your topology: single instance, Deployment Server with heavy forwarders, Splunk Cloud with or without your own heavy forwarders, search head and indexer clusters. All of them are in one table on [Where Each Package Goes](package-placement.md#package-matrix).

## :material-circle-box:{ .taiconcolor } Data Flow

### :material-crop-square:{ .taiconcolor } AWS

SAP writes your LogServ objects to an S3 bucket in the SAP ECS account, and the bucket sends a notification for each new object to an SQS queue there. How the notifications reach Splunk depends on the scenario you deploy in your own **Secondary** AWS account (see [Choose Your Cloud and AWS Scenario](../install-setup/choose-your-cloud.md)):

```
  SAP ECS account (managed by SAP)
  +-------------------------------------------------------------+
  |  SAP LogServ S3 bucket  --(new object)-->  SAP SQS queue    |
  +-------------------------------------------------------------+
          |                       |                       |
       Connect                 Filter                   Copy
          |                       |                       |
          |              Lambda in your account   Lambda in your account
          |              reads SAP's queue and    reads SAP's queue and
          |              forwards the             copies each new object
          |              notifications that       to a bucket in your
          |              pass its filters to a    account; that bucket
          |              queue in your account    notifies a queue in
          |                       |               your account
          |                       |                       |
          v                       v                       v
  Input reads SAP's       Input reads your        Input reads your queue
  queue and downloads     queue and downloads     and downloads from your
  from SAP's bucket       from SAP's bucket       bucket
          |                       |                       |
          +-----------------------+-----------------------+
                                  |
                                  v
            Heavy Forwarder: Splunk Add-on for AWS, SQS-Based S3 input
            (signs in through the IAM role splunk-logserv-ta-role in your
            account; cross-account for Connect and Filter)
```

- **Connect** deploys only an IAM user and a cross-account IAM role in your account.
- **Filter** also deploys a Lambda, a queue and a dead-letter queue; the objects are still downloaded from SAP's bucket.
- **Copy** also deploys a Lambda, a bucket, a queue and a dead-letter queue.
- Filter and Copy need an S3 bucket of your own for the Lambda code.

**Backfill and recovery** use a fourth channel with no queue: a Generic S3 input in the Splunk Add-on for AWS that reads a bucket prefix directly. The Data TA's AWS S3 Direct screen creates these inputs; see [AWS S3 Direct: Backfill and Recovery](../install-setup/aws-s3-direct.md).

### :material-crop-square:{ .taiconcolor } Azure

```
  SAP LogServ Blob Storage (managed by SAP)
        |
        v  (BlobCreated notifications via Event Grid --> Storage Queue)
  LogServ Azure add-on: sap_logserv_azure_queue input on a Heavy Forwarder
  (add-on installed on each Heavy Forwarder that may run an input)
        |   fetches each blob with a SAS; emits sourcetype = sap_logserv_logs
        v
  Same Data TA filtering + routing --> Indexers --> Search Head
```

Run one input for each queue. See the [Azure Setup Guide](../install-setup/azure-setup.md).

### :material-crop-square:{ .taiconcolor } Google Cloud

```
  SAP LogServ GCS bucket (managed by SAP)
        |
        v  (OBJECT_FINALIZE notifications via Pub/Sub topic --> PULL subscription)
  LogServ GCP add-on: sap_logserv_gcp_pubsub input on a Heavy Forwarder
  (add-on installed on each Heavy Forwarder that may run an input)
        |   fetches each object with a service-account key; emits sourcetype = sap_logserv_logs
        v
  Same Data TA filtering + routing --> Indexers --> Search Head
```

The service account is yours: you create it in a GCP account of your own, give its email address to SAP support, and SAP grants it read access to the LogServ subscription and bucket (the GCP counterpart of the AWS cross-account IAM role). Run one input for each subscription. See the [GCP Setup Guide](../install-setup/gcp-setup.md).

### :material-crop-square:{ .taiconcolor } From the Heavy Forwarder to the Dashboards

Whatever the cloud, each event then goes through the same steps:

```
  Heavy Forwarder (or single instance): the Data TA at index time
  +--------------------------------------------------------------+
  |  0. The input reads each object; every NDJSON line becomes   |
  |     one event (sourcetype sap_logserv_logs)                  |
  |  1. Filters, only when Enable Filtering is on (nullQueue)    |
  |  2. Set host, source, clz_dir and clz_subdir                 |
  |  3. Route to the final sourcetype                            |
  |  4. Stamp splunk_solution (and cloud_provider when set)      |
  |  5. Keep only the "_raw" text as the event                   |
  |  6. Forward to the indexers                                  |
  +--------------------------------------------------------------+
        |
        v
  Indexers: sap_logserv_logs
        |
        v
  Search Head: LogServ App (search-time fields, rollups, dashboards)
```

Steps 1 to 5 are `TRANSFORMS-` classes of the `[sap_logserv_logs]` stanza, and Splunk runs them in the order of their names. The filter class, `TRANSFORMS-00-filter`, is written to the Data TA's `local/props.conf` when you save the filters, and sorts before the shipped classes `01` (host, source and folder fields), `02` to `09` (routes), `50` and `51` (stamps) and `99` (unwrap `_raw`). The filters have to run before step 5, because they match the envelope keys that the unwrap removes. An event the filters drop still passes through the later steps, so filtering saves license and storage, not forwarder CPU (see [Capacity Planning and First Start](capacity-planning.md)).

## :material-circle-box:{ .taiconcolor } Index-Time Filtering

The Data TA's filters decide at index time which LogServ events are indexed. They run on the parsing tier (the heavy forwarders, or the single instance) and send the events they drop to `nullQueue`, so those events are never indexed and do not count toward ingest-based licensing:

- **Include Filters / Exclude Filters**: folder patterns on `clz_dir/clz_subdir`, for example `linux/*` or `linux/cron`.
- **Include Sources / Exclude Sources**: patterns on the event's `source` (the log file's path), optionally limited to one folder, for example `linux/linux_secure=/var/log/zypper.log`.
- **Days in the Past**: drops events whose own `_time` (the epoch in the raw NDJSON) is older than midnight UTC N days ago. It keys on the event's timestamp, not on the storage object's path date. Default 7.

**Enable Filtering** is off by default, and none of these settings applies until it is checked. You save the filters on the Data TA's **Configuration** page:

- **With a Deployment Server** managing your heavy forwarders, save them on the Deployment Server. They reach the forwarders when you click **Deploy to Forwarders**; with Days in the Past above 0, the daily refresh pushes its new cutoff by itself.
- **Without a Deployment Server**, save them on each heavy forwarder (or the single instance); they apply there without a restart.

Filters work at index time: what is indexed before you set them stays indexed. Decide them before the inputs start; see [Decide Filtering](../install-setup/decide-filtering.md) and, for every setting, [Configuring Filters](../install-setup/configure-filters.md).

## :material-circle-box:{ .taiconcolor } Sourcetype Routing

During index-time parsing the Data TA reads each event's envelope (the NDJSON keys around `_raw`) and assigns its final sourcetype with regex rules in `transforms.conf`. It keys on one of three things, depending on the log type:

- **The `source` path**: Linux (`/var/log/messages`, `/var/log/cron`, ...), ISC BIND (`/var/lib/named/log/named/...`), Squid (`/var/log/squid/access.log`, ...), Windows (`WinEventLog:...`) and the SAP Web Dispatcher access log (`.../log/http_access_log`).
- **`clz_subdir` alone**: for example HANA audit (`hanaaudit`), the ABAP gateway, dispatcher, enqueue server, event, message server and work process logs, the SAP Host Agent and SAP Router.
- **`clz_dir` and `clz_subdir` together**, where the same folder name exists under more than one `clz_dir` (for example `audit` under both `abap/` and `scc/`): ABAP audit, ICM and sapstartsrv, HANA trace, the SAP Cloud Connector logs and `sap/sapstartsrv`.

HANA trace files delivered without folder fields are routed by their `source` path instead. The route classes run in order (`02` to `09`) and a later match replaces an earlier one: `/var/log/messages` lines in the `sap/saprouter` folder first match the Linux route, then become `sap:saprouter`.

For every log type and its sourcetype, see [Supported Log Types](supported-log-types.md).

## :material-circle-box:{ .taiconcolor } The LogServ App and the AI Assistant

The AI Assistant ships disabled. When an admin turns it on, its predefined prompts run the App's saved searches through the Splunk MCP Server with no LLM involved; for free-form prompts the LLM vendor receives the question and, for each search, a summary whose content the privacy tier sets, never the raw event rows. See [Privacy Tiers](../ai-assistant/privacy-tiers.md).

How the LogServ App, the AI Assistant and the Environment Topology view are built is described in [LogServ App and AI Assistant Internals](../developer/ai-assistant-internals.md).

## :material-circle-box:{ .cboxmove } Next Steps

- [Supported Log Types](supported-log-types.md): what SAP delivers and how each log type is parsed.
- [Where Each Package Goes](package-placement.md): the placement table for every topology.
- [Plan and Prerequisites](prerequisites.md): what to request from SAP and prepare on each tier.
