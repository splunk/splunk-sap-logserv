# SAP LogServ on GCP — Setup Guide

This page covers ingesting LogServ data from **Google Cloud Storage (GCS)** using the standalone **LogServ GCP add-on** (`splunk_ta_sap_logserv_gcp`, shown in Splunk Web as **Splunk TA for SAP LogServ on GCP**) and its **`sap_logserv_gcp_pubsub`** modular input — the GCP twin of `Splunk_TA_aws`'s **SQS-Based S3** input and of the LogServ Azure add-on's Storage-Queue input. A GCS bucket notification publishes an `OBJECT_FINALIZE` message to a **Pub/Sub** topic; this input pulls a **Pub/Sub subscription** on that topic, fetches each named object with a Google **service-account key**, gunzips it, and emits its NDJSON. This is the model SAP's own LogServ-on-GCP collector uses (Pub/Sub object-creation notifications). You install this small, first-party add-on **on the heavy forwarder that runs the input** — the same deployment model as the Splunk Add-on for AWS and the LogServ Azure add-on — and the LogServ **Data TA** on the same instance provides the downstream sourcetype routing, filtering, and stamping. The downstream pipeline (sourcetype routing, filtering, dashboards, ES integration) is identical to the AWS S3 and Azure Blob paths.

!!! info "SAP provides the GCP infrastructure — you provide the service account that reads it"
    In a RISE / SAP ECS deployment the **GCS bucket, bucket notification, Pub/Sub topic, and Pub/Sub subscription are all provisioned and managed by SAP in the SAP-managed GCP project.** You do not build any of that. What you **do** provide is the *identity* the Splunk input runs as: a **service account you create in a GCP project of your own** (any project your organization controls, separate from the SAP-managed RISE project). You hand the service account's **email address** to your **SAP support contact**, SAP grants it read access to the LogServ bucket + Pub/Sub subscription, and you mint its **JSON key** for the Splunk input — see [The onboarding sequence](#the-onboarding-sequence). On the Splunk side your tasks are to **install the `splunk_ta_sap_logserv_gcp` add-on on the heavy forwarder that will run the input** and create **one Splunk input per Pub/Sub subscription** on it — one per GCP landscape (most deployments have a single landscape, hence one input; you can define several on the same HF if you ingest from more than one — see [Multiple landscapes / fleets](#multiple-landscapes-fleets)), using the values from [Parameters for the input](#parameters-for-the-input).

## :material-circle-box:{ .taiconcolor } High Level Steps

Follow these steps in order. Each step links to its section below.

1. **Create the service account and get SAP's grants**: create it in your own GCP project, give its email to SAP, and get back the project ID and subscription name. Enable the two Google APIs and mint the JSON key (check your organization's key policy first). See [The onboarding sequence](#the-onboarding-sequence).
2. **Decide about the subscription backlog** with SAP before the input exists. A purged day cannot be loaded later. See [First Start: The Queue Backlog](../getting-started/capacity-planning.md#first-start-the-queue-backlog) and [Historical backfill](#historical-backfill).
3. **Check the Data TA and the indexes.** The Data TA must be on the instance that will run the input, and the indexes must exist, before the input reads anything: events indexed without the Data TA keep the base sourcetype for good. See [Prerequisites](#prerequisites).
4. **Download and install the add-on** on that instance, directly (never through the Deployment Server). See [Install the GCP add-on](#install-the-gcp-add-on).
5. **Before the input starts, check the Data TA's two index-time settings.** Leave **Cloud Provider** at **Not set**: the input stamps `cloud_provider=gcp` itself (see [`cloud_provider` attribution](#cloud_provider-attribution) and [Choose Cloud Attribution](cloud-attribution.md)). Decide filtering (see [Decide Filtering](decide-filtering.md)). Whatever the subscription holds when the input starts is indexed with the settings in place at that moment.
6. **Create one input for the subscription**, with a role that holds `admin_all_objects`. See [Configure the input](#configure-the-input).
7. **Check that data arrives.** See [Validation](#validation).
8. **Plan the key rotation** your security policy requires. See [Rotate credentials](#rotate-credentials).

## :material-circle-box:{ .taiconcolor } Architecture overview

![GCP Pub/Sub-driven ingest architecture](../../images/gcp-pubsub-architecture.png)

```
SAP LogServ RISE-ECS  (SAP-managed GCP project)
  |
  +-> writes NDJSON.gz objects to Google Cloud Storage under the logserv/ prefix
        |
        +-> GCS bucket notification (OBJECT_FINALIZE)
              |
              +-> Pub/Sub topic --> Pub/Sub PULL subscription (one message per new object)
                    |
                    |    [Customer GCP account]  service account created by YOU;
                    |    SAP grants it read access to the LogServ bucket + subscription;
                    |    its JSON key authenticates the Splunk input below
                    |
                    +-> [GCP add-on: sap_logserv_gcp_pubsub]  (runs on the Heavy Forwarder)
                          |   pulls the subscription, fetches each object with the
                          |   service-account credential, gunzips, splits NDJSON
                          |
                          +-> emits via EventWriter, sourcetype=sap_logserv_logs, cloud_provider=gcp
                                |
                                +-> [LogServ Data TA pipeline]  (same Heavy Forwarder):
                                      sourcetype routing by clz_dir/clz_subdir or source path,
                                      Configuration -> Filters nullQueue, _time drop,
                                      splunk_solution stamping
                                      |
                                      +-> forwarded to the Indexer
                                            |
                                            +-> dashboards + ES integration
```

Everything from the LogServ object writer down through the **Pub/Sub subscription lives in the SAP-managed GCP project and is managed by SAP.** The one piece homed on **your** side of GCP is the **service account**: it lives in a GCP project you manage (the *Customer GCP account* box in the diagram), SAP grants it cross-project read access to the LogServ subscription + bucket, and its JSON key is what the Splunk input authenticates with — the GCP analogue of the AWS path's customer-account **cross-account IAM role**. The **GCP add-on's `sap_logserv_gcp_pubsub` input** runs on **your heavy forwarder**, pulls the subscription SAP exposes to you, and hands its events to the **LogServ Data TA** (also on that HF) for routing/filtering/stamping. This is exactly how `Splunk_TA_aws` and the LogServ Azure add-on cooperate with the Data TA on their respective paths.

**Why EventWriter, not HEC:** the input runs on the heavy forwarder and emits through the HF's native index-time pipeline, so every existing LogServ Data TA feature — sourcetype routing (by the `clz_dir` / `clz_subdir` folder fields or by the `source` path, depending on the log type; see [Supported Log Types](../getting-started/supported-log-types.md)), the Configuration → Filters `nullQueue` filtering, the `days_in_past` / `_time` drop, and the `splunk_solution` stamping — applies to GCP events **unchanged**, exactly as it does to AWS S3 and Azure Blob events. The `cloud_provider` value comes from the add-on itself (see [`cloud_provider` attribution](#cloud_provider-attribution)). The input is **stdlib-only** (Pub/Sub + GCS REST over `urllib`, with a pure-Python OAuth2 service-account token exchange — no Google SDK), so it adds no AArch64 / native-binary burden and is Splunk Cloud-clean.

## :material-circle-box:{ .taiconcolor } Prerequisites

**Provided by SAP** (in the SAP-managed GCP project — you obtain the *values*, you do not build the resources):

- A **GCS bucket** holding the LogServ objects (under the `logserv/` prefix — same path convention as AWS S3 and Azure Blob: `<bucket>/logserv/<clz_dir>/<clz_subdir>/<YYYY>/<MM>/<DD>/<file>.json.gz`).
- A **bucket notification** publishing `OBJECT_FINALIZE` events to a **Pub/Sub topic**, and a **PULL subscription** on that topic dedicated to your Splunk consumer (recommended: ack deadline 300 s+ and a dead-letter policy).
- The **cross-project IAM grants** on those resources for the service account you provide (see below).

Obtain the GCP project ID and the subscription name from your **SAP support contact** — see [Parameters for the input](#parameters-for-the-input).

**Provided by you in GCP (the service account — see [The onboarding sequence](#the-onboarding-sequence)):**

- A **GCP project of your own**: any project your organization controls, separate from the SAP-managed RISE project (the *Customer GCP account* in the diagram, and the GCP counterpart of the *Secondary account* in the AWS guides). No infrastructure is deployed in it — it is only the administrative home of the identity.
- A **service account** created in that project. You hand its **email address** to your SAP support contact, and SAP grants it **`roles/pubsub.subscriber` on the LogServ subscription** and **`roles/storage.objectViewer` on the LogServ bucket** (see [What SAP must grant your service account](#what-sap-must-grant-your-service-account)).
- A **JSON key** for that service account, minted by your GCP admin (check the org-policy warning in [The onboarding sequence](#the-onboarding-sequence) *before* install day).
- The **Cloud Pub/Sub API** and **Cloud Storage API** enabled in the service account's home project (Google attributes API quota to the credential's *home* project, not to the project holding the resources).

**On your Splunk side (the instance that runs the input — a heavy forwarder is strongly recommended):**

- **LogServ Data TA `0.1.1`+** installed on that instance (it provides the index-time routing/filtering/stamping; see [Installing the Data TA](install-ta.md)). On heavy forwarders the Data TA is normally distributed by the Deployment Server (see [Distribute the Data TA to Heavy Forwarders](distribute-data-ta.md)). Its build decides the parsing cost on the forwarder: use build 1792189743 or later, and see [Version Check](../getting-started/capacity-planning.md#version-check) to read the build on a forwarder.
- **The indexes** (`sap_logserv_logs`, and the AI Assistant audit index) on your indexer tier, before any data arrives. See [Create the indexes](install-ta.md#1-create-the-indexes).
- **LogServ GCP add-on (`splunk_ta_sap_logserv_gcp`) `0.1.1`+** installed on the **same instance** (see [Install the GCP add-on](#install-the-gcp-add-on)). It registers the `sap_logserv_gcp_pubsub` input kind. The input is inert until you create an input instance.
- **A Splunk role that holds the `admin_all_objects` capability** on that instance, to create, edit or delete the input (see [Configure the input](#configure-the-input)).
- Network egress from that instance to `oauth2.googleapis.com`, `pubsub.googleapis.com`, and `storage.googleapis.com` (port 443 / HTTPS). The add-on has no proxy setting of its own; if the instance reaches the internet through a proxy, see *Outbound proxy* under [Heavy Forwarders](../getting-started/prerequisites.md#heavy-forwarders).

!!! warning "Compact JSON format required"
    Each object is gzipped NDJSON (one event per line). The index-time routing transforms assume **compact JSON** (no whitespace after `:`). The SAP LogServ collector emits compact JSON natively, so no action is required on your side. (For reference: pretty-printed JSON would bypass the transforms and land as `sourcetype=sap_logserv_logs`, breaking dashboards.)

## :material-circle-box:{ .taiconcolor } Parameters for the input

SAP has already provisioned the bucket, notification, topic, and subscription in the SAP-managed GCP project — the only GCP resource **you** create is the service account ([The onboarding sequence](#the-onboarding-sequence)). **Contact your SAP support contact** to obtain the two SAP-side values, then plug them — plus your own service-account key — into the Splunk input ([Configure the input](#configure-the-input)):

| Parameter | Input field | Provided by | Description |
|---|---|---|---|
| GCP project ID | `project_id` | SAP | The GCP project that hosts the LogServ Pub/Sub subscription (SAP's LogServ project — e.g. the `LOGSERV_PROJECT_ID` value SAP's own forwarder documentation references). 6–30 chars: lowercase letters, digits, hyphens; starts with a letter, ends with a letter or digit. |
| Subscription name | `subscription_name` | SAP | The Pub/Sub **PULL** subscription receiving the bucket's `OBJECT_FINALIZE` notifications. Must be dedicated to your Splunk consumer (competing consumers split messages). |
| Service-account key | `service_account_key` | **You** | The full Google service-account **JSON key file** contents, minted from the service account you created in your own GCP project (after SAP confirms the grants). Treat it as a secret. |

The bucket name and `logserv/` prefix are carried inside each notification message — they are not separate input fields. The three Google endpoints your heavy forwarder must reach are fixed (`oauth2.googleapis.com`, `pubsub.googleapis.com`, `storage.googleapis.com`).

Ask SAP also for the subscription's **ack deadline** (300 s or more is recommended); the input's `batch_size` must fit inside it (see *Scaling one subscription across inputs* below).

### The onboarding sequence

The service account is **customer-homed**: it lives in a GCP project you control (the *Customer GCP account* in the architecture diagram), and SAP binds cross-project grants on the SAP-managed LogServ resources to it. Nothing is deployed in your project — it is only the administrative home of the identity. The sequence:

1. **Create the service account** in a GCP project your organization controls: **IAM & Admin → Service Accounts → Create service account**. A descriptive name such as `splunk-logserv-ingest` helps everyone's audit trail. The account needs **no roles in your own project**.
2. **Hand the service account's email address** (`<name>@<your-project-id>.iam.gserviceaccount.com`) **to your SAP support contact** and request LogServ consumer access for it.
3. **SAP grants the account** `roles/pubsub.subscriber` on the LogServ subscription and `roles/storage.objectViewer` on the LogServ bucket (cross-project IAM bindings on the SAP-managed resources — see [What SAP must grant your service account](#what-sap-must-grant-your-service-account)), and returns the **project ID** and **subscription name** values for the input.
4. **Enable the Cloud Pub/Sub API and the Cloud Storage API** in the service account's home project (**APIs & Services → Enable APIs and services**). Google attributes API quota to the credential's *home* project, so a missing enablement fails the first connection with `403 SERVICE_DISABLED` naming **your** project (see [Troubleshooting](#troubleshooting)).
5. **Mint the JSON key**: **IAM & Admin → Service Accounts → *(the account)* → Keys → Add key → Create new key → JSON**, and stage the downloaded file for the input configuration. *(Read the org-policy warning below first.)*
6. **Configure the input** on the heavy forwarder that will run it ([Configure the input](#configure-the-input)) once SAP confirms the grants are in place.

!!! warning "Organization policy can block key creation entirely"
    Many enterprises enforce the `iam.disableServiceAccountKeyCreation` organization policy as a security guardrail. If it applies to the service account's home project, minting a JSON key fails **regardless of IAM roles** — your admin needs `roles/iam.serviceAccountKeyAdmin` on the account *and* a policy exemption for it. Check this **before** install day; it is the most common last-minute blocker.

### What SAP must grant your service account

The input pulls/acks subscription messages **and** fetches objects with the single service account you provide, so SAP must bind **both** grants to its email. Confirm with your SAP support contact that your account holds:

| IAM role | Scope | For |
|---|---|---|
| `roles/pubsub.subscriber` | the LogServ subscription | pull + acknowledge notification messages |
| `roles/storage.objectViewer` | the LogServ bucket | fetch the referenced objects |

These two roles are the **complete** runtime set — the input makes exactly four Google API calls (OAuth token mint, `subscriptions:pull`, `subscriptions:acknowledge`, and the object download), all covered by the grants above. They are the same two roles SAP documents for its own `sap-ecs-gcp-log-forwarder` consumer. Unlike the general-purpose Splunk Add-on for GCP, this input needs **no** extra `roles/pubsub.viewer` grant (that add-on calls `GetSubscription`; this input never does) — don't ask SAP to over-grant.

!!! warning "If the grant is subscription-only"
    If your service account lacks `roles/storage.objectViewer` on the bucket, object fetches fail with HTTP 403 and the input logs it explicitly: *"object read forbidden … the service account likely lacks storage.objectViewer on the bucket; leaving message for retry."* The decisive question for your SAP support contact is **"has my service account been granted read on the bucket's objects, or only the subscription?"** If it is subscription-only, ask SAP to add the bucket-read grant (a second credential is not supported — the input uses one account for both).

## :material-circle-box:{ .taiconcolor } Install the GCP add-on

Download `splunk_ta_sap_logserv_gcp-0.1.2.tar.gz` from the `release_binaries` folder of the [Splunk for SAP LogServ GitHub repository](https://github.com/splunk/splunk-sap-logserv/tree/main/release_binaries). Its AppInspect report sits beside it, and the folder's `README.md` lists each tarball's md5. The build and md5 of each package are also listed under [Download the Packages](install-ta.md#3-download-the-packages).

Install it **directly on the instance that runs the input**. A heavy forwarder is strongly recommended — it is the tier where `Splunk_TA_aws` (AWS) and the LogServ Azure add-on (Azure) run for their paths. A search head is not blocked (see [Running the TAs on a search head](install-ta.md#running-the-tas-on-a-search-head)). You can install the add-on on every heavy forwarder that may run an input, for example to keep a standby ready; the input for a given subscription still runs on one of them (see [Configure the input](#configure-the-input)).

- Splunk Web → **Manage Apps → Install app from file** → upload the tarball, **or**
- `/opt/splunk/bin/splunk install app /path/splunk_ta_sap_logserv_gcp-0.1.2.tar.gz`, **or**
- configuration management (Ansible / Puppet / Chef) drops the app into `etc/apps/`, then `chown -R splunk:splunk` and restart.

!!! danger "Do NOT distribute the GCP add-on via the Deployment Server"
    Install it **directly on each instance that runs an input — never as a deployment-app.** The input's service-account key is stored, encrypted, in the add-on's own `local/passwords.conf`; a Deployment Server push **replaces the app's `local/` directory**, which would wipe the per-HF credential. (This is the same reason `Splunk_TA_aws` and the LogServ Azure add-on are configured per-HF rather than DS-distributed.) The **Data TA** stays DS-managed as before — only the cloud-ingest add-ons are per-HF.

After installing + restarting, the `sap_logserv_gcp_pubsub` input kind is registered and the add-on's **Inputs** page is available under **Apps → Splunk TA for SAP LogServ on GCP**.

Upgrading from an earlier build? See [Upgrading to This Release](../getting-started/upgrading.md#ingest-add-ons).

### Single instance

On a single Splunk Enterprise instance (no separate forwarder or indexer), install the Data TA and the GCP add-on on that instance and create the input there, as described below. The Data TA's bundled `indexes.conf` creates both indexes on that instance; set the retention of `sap_logserv_logs` if you want one other than the default (see [Create the indexes](install-ta.md#1-create-the-indexes)). There is no Deployment Server step: the Data TA's settings are saved on the instance itself. The LogServ App goes on the same instance.

### Splunk Cloud

With Splunk Cloud, run the input on a heavy forwarder you manage:

1. **Create both indexes in your Splunk Cloud stack first** (**Settings → Indexes**, or the Admin Config Service), with the retention you want, before any data arrives. See [Create the indexes](install-ta.md#1-create-the-indexes).
2. **Set the heavy forwarder up to forward to your stack**, with your stack's universal forwarder credentials app installed on it.
3. **Put the Data TA on the heavy forwarder** (through your Deployment Server, or directly if you have none), and **install the GCP add-on on it directly**, as above.
4. **Create the input on the heavy forwarder** ([Configure the input](#configure-the-input)).

The LogServ App goes on the Splunk Cloud search head. The Data TA is not needed on the Cloud stack in this layout.

**Without a heavy forwarder.** The add-on's `app.manifest` declares the search-head workload, so a search head is an allowed target for it; installing it on a Splunk Cloud search head has not been tested. In this layout, install the Data TA and the GCP add-on on the search head as private apps, and create the input there. The Data TA must sit beside the add-on, because it parses the events where the input runs. We strongly recommend against this layout, because the input puts ingest load on the tier your users search on. Creating the input needs a role that holds `admin_all_objects` there too. See [Running the TAs on a search head](install-ta.md#running-the-tas-on-a-search-head) and [Splunk Cloud Considerations](../getting-started/splunk-cloud.md).

## :material-circle-box:{ .taiconcolor } Configure the input

Create **one input for each Pub/Sub subscription**, on **one** instance (normally one heavy forwarder). You can install the add-on on every HF, for example to keep a standby ready, but run the input for a given subscription on one HF only. Every other input on the same subscription, on the same HF or another one, keeps its own dedup record, so a redelivered message can be indexed twice (see *Scaling one subscription across inputs* below). The service-account key is encrypted into the **add-on's own** `local/passwords.conf` and is **not** Deployment-Server-managed — it survives restarts and Data-TA pushes.

!!! note "Creating or editing an input needs `admin_all_objects`"
    On Splunk Enterprise and Splunk Cloud alike, creating, editing (including replacing the service-account key) and deleting an input runs as the signed-in user and needs a role that holds the `admin_all_objects` capability. Without it, Save fails with HTTP 403, *"This operation is forbidden"*. The REST call below has the same requirement.

!!! note "A new input starts with what is already in the subscription"
    The subscription may already hold notifications from before your input exists: up to 7 days of them by default, and up to 31 days if SAP keeps messages longer. A new input works through all of them on top of the live feed. Before you create it, see [First Start: The Queue Backlog](../getting-started/capacity-planning.md#first-start-the-queue-backlog), which includes asking SAP to purge the older messages. The add-on cannot load purged days later (see [Historical backfill](#historical-backfill)).

### Via Splunk Web (per Heavy Forwarder)

Splunk Web → **Apps → Splunk TA for SAP LogServ on GCP → Inputs → Create New Input**, and fill in the fields below with the project ID + subscription name from SAP — and paste the **entire JSON key file of your own service account** into the key field. (For a second landscape on the same HF, use the Inputs table's **Clone** action and give it a new name — the key is not carried on clone, so re-paste it. On **Edit**, the key field shows `******`; saving without changing it preserves the existing key.)

![GCP Inputs](../../images/gcp-ta-inputs-tab.png)

!!! warning ":material-lightning-bolt:{ .taiconcolor } Paste the *whole file* — not just the private key"
    The key field takes the **complete downloaded `.json` file, verbatim** — everything from the
    opening `{` to the closing `}` (`"type": "service_account"`, `"project_id"`, `"private_key"`,
    `"client_email"`, and the rest). Open the file in a text editor, **Select All, copy, paste**.

    - **Keep the `-----BEGIN PRIVATE KEY-----` and `-----END PRIVATE KEY-----` lines.** They are part
      of the `private_key` *value inside the JSON* — do not remove them, and do not un-escape the
      `\n` sequences around them.
    - **Do not extract the private key out of the JSON.** The add-on parses the pasted text *as JSON*
      (it reads `client_email`, `private_key`, and `token_uri` from it); a bare key — with or
      without the BEGIN/END lines — is not valid JSON and is rejected at the first poll with
      `service-account key unusable`.

### Via REST (scriptable, per Heavy Forwarder)

```bash
# Stage the service-account JSON key file, then create the input:
curl -sk -u admin:<pwd> -X POST \
  https://localhost:8089/servicesNS/nobody/splunk_ta_sap_logserv_gcp/splunk_ta_sap_logserv_gcp_sap_logserv_gcp_pubsub \
  --data-urlencode name=logserv_gcp \
  --data-urlencode project_id=<sap-logserv-project-id> \
  --data-urlencode subscription_name=<subscription-name> \
  --data-urlencode index=sap_logserv_logs \
  --data-urlencode event_sourcetype=sap_logserv_logs \
  --data-urlencode interval=60 \
  --data-urlencode service_account_key@/tmp/logserv-sa-key.json
rm -f /tmp/logserv-sa-key.json
```

The resulting stanza in the add-on's `local/inputs.conf` looks like:

```ini
[sap_logserv_gcp_pubsub://logserv_gcp]
project_id = <sap-logserv-project-id>
subscription_name = <subscription-name>
service_account_key = ******
index = sap_logserv_logs
event_sourcetype = sap_logserv_logs
interval = 60
disabled = 0
```

(Only the masked placeholder `service_account_key = ******` is written to `inputs.conf` — the real key is stored encrypted in the add-on's own `local/passwords.conf`.)

| Field | Default | Notes |
|---|---|---|
| `project_id` | — | The SAP LogServ GCP project ID from SAP (6–30 chars: lowercase letters, digits, hyphens; must start with a letter and end with a letter or digit). |
| `subscription_name` | — | The Pub/Sub PULL subscription name from SAP (receives the `OBJECT_FINALIZE` notifications). |
| `service_account_key` | — | The **complete JSON key file** of the service account you created in your own GCP project ([The onboarding sequence](#the-onboarding-sequence)), pasted **verbatim** — including the `-----BEGIN PRIVATE KEY-----` / `-----END PRIVATE KEY-----` lines inside the `private_key` value. Encrypted credential: the value lives in the add-on's `local/passwords.conf`; `inputs.conf` carries only the masked `******` placeholder. |
| `index` | `sap_logserv_logs` | Target index. Does **not** affect parsing — the Data TA's index-time pipeline keys on the sourcetype, not the index. You may point it at a custom index, but the dashboards query through the `sap_logserv_idx_macro` macro, so update that macro to match (see caveat below). |
| `event_sourcetype` (UI label **Sourcetype**) | `sap_logserv_logs` | **Fixed at `sap_logserv_logs`.** The add-on hard-codes this sourcetype (it is not read from the stanza), and the field is shown read-only when editing the input. Leave it at the default. |
| `interval` | `60` | Seconds between firings (10–3600). Each firing drains the subscription within a per-firing time budget (currently 90% of `interval`, capped at 240 s) and the `max_objects_per_fire` cap. |
| `batch_size` | `10` | Pub/Sub messages requested per pull call (`maxMessages`, 1–1000). The input acknowledges a batch only after processing all of it, so a whole batch must finish within the subscription's ack deadline. |
| `max_objects_per_fire` | `500` | Cap on objects ingested per firing (backlog safety valve). |
| `poison_threshold` | `5` | A message redelivered more than this many times (Pub/Sub `deliveryAttempt`) is acked and dropped. See [Reliability behavior](#reliability-behavior). |
| `include_filters` / `exclude_filters` | *(empty)* | Optional comma-separated substrings applied to the GCS object path as a cheap pre-filter (beyond the built-in `logserv` match). The canonical allow/deny policy lives in the Data TA's Filters tab. |
| `verify_ssl` | `1` | TLS verification for the Google API endpoints. Leave enabled for production. |

!!! note "Sourcetype is fixed; the Index is yours to change"
    The **Sourcetype** is effectively fixed at **`sap_logserv_logs`** — the add-on always emits it (the value is hard-coded in the input, not read from the stanza), and the field is shown read-only (disabled) when editing an existing input. When you create an input the field can still be typed into, but whatever you enter is ignored and the add-on still emits `sap_logserv_logs`. This is deliberate: the Data TA's index-time routing, Filters `nullQueue`, `_time` drop, and `splunk_solution` / `cloud_provider` stamping all key on `sourcetype = sap_logserv_logs` (`props.conf` stanzas match on sourcetype, **not** index), so it must never vary.

    The **`index`**, by contrast, may be changed safely — parsing is unaffected (events are routed, filtered, and stamped identically no matter which index they land in). You may point it at a custom index (for example a per-customer index such as `sap_logserv_logs_con01`). The only follow-up is dashboard visibility: the dashboards and rollups search through the `sap_logserv_idx_macro` macro (default `index="sap_logserv_logs"`), so override that macro in the App's `local/macros.conf` to match your index, or the dashboards won't find the data.

### `cloud_provider` attribution

The input stamps every event it emits with the indexed field `cloud_provider=gcp` (the add-on's `default/inputs.conf` sets `_meta = cloud_provider::gcp` for every input of this kind), so search-time queries and the **Multi-Cloud Overview** dashboard can distinguish GCP-sourced from AWS- and Azure-sourced data.

!!! warning "When you ingest from more than one cloud"
    The Data TA's **Configuration → Cloud Provider** dropdown stamps `cloud_provider` TA-wide at index time. If it is set to `aws` (or any provider) on a forwarder that also runs this GCP input, that index-time stamp co-fires with the input's per-event `_meta=gcp`, leaving `cloud_provider` **multivalued** on the GCP events. For correct per-channel attribution on a mixed forwarder, set the **Cloud Provider dropdown to "Not set"** and attribute per input: this GCP input and the LogServ Azure add-on's input already self-attribute via `_meta`; add `_meta = cloud_provider::aws` to the `Splunk_TA_aws` SQS-S3 input. This applies even when each cloud runs on separate forwarders: a Deployment Server pushes the dropdown's value to every forwarder in the `SAP_LogServ_HeavyForwarders` server class. Leave the dropdown at **Not set** on forwarders that run this add-on: its input already stamps `cloud_provider`, and the dropdown would add the value a second time. A forwarder can run the GCP add-on beside the AWS or Azure add-on; see [Capacity Planning and First Start → More Than One Cloud](../getting-started/capacity-planning.md#more-than-one-cloud) for when to separate them. See [Choose Cloud Attribution](cloud-attribution.md).

### Multiple landscapes / fleets

- **Multiple GCP landscapes on one HF:** create one input instance per landscape (different `project_id` / `subscription_name`), using the Inputs table's **Clone** action. The per-instance credential is keyed by the input name; re-paste the key on each (clone never carries secrets).
- **A fleet of heavy forwarders:** install the add-on on each HF that may run an input (still never through the DS). Create the input for a given subscription on one HF. Add it on more HFs only for throughput or to catch up a backlog, accepting at-least-once delivery (see the note below); to fail over, enable the standby HF's input after you disable the first one. For zero-touch fleets, config management can drop the add-on into `etc/apps/` and seed the key via the REST call above (it encrypts under each HF's own `splunk.secret`). **Do not** add the add-on to the Deployment Server's `deployment-apps/`.

!!! note "Scaling one subscription across inputs — Pub/Sub is natively competing-consumer"
    Separate input *instances* are normally for **different** subscriptions. You *can* also point several identical inputs at the **same** subscription to raise throughput — competing consumers are Pub/Sub's native delivery model: N inputs (across one HF or several) pull and ingest N batches of objects in parallel. Pub/Sub tries not to give a message that is still outstanding to another consumer, but it may rarely redeliver any message, even after it was acknowledged, so several consumers can produce occasional duplicates even within the ack deadline ([Google's subscription overview](https://docs.cloud.google.com/pubsub/docs/subscription-overview)). Understand the trade-off first:

    - A **single** input is **effectively duplicate-free across the subscription's redelivery window** — its per-input dedup checkpoint (keyed `bucket/object#generation`; entries are retained for about 7 days, up to 50,000 objects) skips an already-ingested object if a message reappears.
    - **Same-subscription inputs don't share that checkpoint**, so they fall back to **at-least-once** (the same guarantee as the AWS SQS-S3 input). If a message is not acknowledged within the subscription's **ack deadline** (SAP-managed; 300 s recommended), the message redelivers and another input may re-ingest it → **duplicate events**. The guard: the input acknowledges once per pull batch, after processing every message in it, so a whole batch (`batch_size` objects, default 10) must finish within the ack deadline. Ask SAP what the deadline is (Pub/Sub's default is 10 s), and lower `batch_size` if it is short. `deliveryAttempt` is Pub/Sub's server-side, shared counter, so the `poison_threshold` decision stays coordinated across the consumers, and a subscription-level **dead-letter policy** (SAP-managed) handles poison messages natively.

    For typical LogServ volumes a **single input already keeps up** (it drains up to `max_objects_per_fire` objects per firing). Prefer raising `max_objects_per_fire` or lowering `interval` on one input before adding consumers; raise `batch_size` only while a whole batch still finishes within the subscription's ack deadline.

## :material-circle-box:{ .taiconcolor } Reliability behavior

- **At-least-once + dedup.** A subscription message carrying a LogServ object is acknowledged **only after** that object ingests successfully (unparseable / non-`OBJECT_FINALIZE` notifications and paths your filters reject are acknowledged without ingest and counted as `noise=` in the done log line; poison messages likewise — see below); each object is deduplicated by `bucket/object#generation` in a checkpoint sidecar, so a redelivered message re-ingests nothing.
- **Transient failures leave the message.** A 5xx / network error on an object fetch leaves the message unacknowledged (it redelivers after the ack deadline); already-ingested objects in that message are no-ops on retry.
- **Object-read denied (HTTP 403) leaves the message** and logs loudly — this is the missing-`storage.objectViewer` signal (get the bucket-read grant from SAP; the message reprocesses).
- **Pull denied (HTTP 403) aborts the firing** — the service account lacks `roles/pubsub.subscriber` (or the project/subscription values are wrong); nothing is consumed until the credential is fixed.
- **Deleted objects (HTTP 404) are acked and skipped** — an object that vanished between notification and fetch can't loop.
- **Poison messages** (redelivered more than `poison_threshold` times, per Pub/Sub's `deliveryAttempt` counter) are acked and dropped so one permanently-bad object can't loop forever. `deliveryAttempt` is populated only when the subscription has a **dead-letter policy** — with one attached, Pub/Sub also dead-letters natively (the primary mechanism; the TA's threshold is a local backstop).

## :material-circle-box:{ .taiconcolor } Historical backfill

Notification-driven ingest is **forward-only by nature** — the bucket notification fires only on *new* `OBJECT_FINALIZE` events, so once SAP's notification is live the input ingests everything written from that point on (plus the messages still in the subscription when you create the input), but does **not** replay objects that already existed. This solution has no historical load for GCP; to load older objects, agree a method with your Splunk team.

The add-on reads only the objects that subscription messages name and never lists the bucket. A day whose messages were purged, or expired before the input read them, stays in SAP's bucket, but nothing in Splunk for SAP LogServ will load it. If you will need such days, agree with your Splunk team how to load them before you ask SAP to purge anything (see [First Start: The Queue Backlog](../getting-started/capacity-planning.md#first-start-the-queue-backlog)). Moving SAP's subscription forward in time (a seek) acknowledges the older messages; they can be replayed later only if SAP's subscription keeps acknowledged messages or its topic keeps messages, so ask SAP before a seek.

When filtering is on, the Data TA's [Days in the Past](configure-filters.md#days-in-the-past) filter applies to everything the input reads, the subscription backlog included: events older than its cutoff are dropped before indexing.

## :material-circle-box:{ .taiconcolor } Rotate credentials

A service-account key keeps working until it is disabled or deleted in your GCP project, or until it expires if your organization's policy gives keys an expiry time (the `constraints/iam.serviceAccountKeyExpiryHours` organization policy; without it, a key never expires). When the key stops working, token minting fails (`token minting failed (...); aborting firing` in the input log), and the input ingests nothing. The messages wait in the subscription only as long as its message retention allows (7 days by default); days whose messages are removed before you replace the key cannot be loaded later (see [Historical backfill](#historical-backfill)). Rotate the key on the schedule your security policy sets.

To rotate the key:

1. In your GCP project, add a new JSON key to the service account: **IAM & Admin → Service Accounts → *(the account)* → Keys → Add key → Create new key → JSON**. A service account can hold up to 10 keys, so the old key keeps working meanwhile. The [organization-policy warning](#the-onboarding-sequence) applies to new keys too.
2. On the instance that runs the input, open **Apps → Splunk TA for SAP LogServ on GCP → Inputs** and choose **Edit** on the input. The **Service-account key (JSON)** field shows `******`.
3. Replace `******` with the whole new JSON key file (see *Paste the whole file* above) and click **Update**. Saving needs a role that holds `admin_all_objects`. (If you leave `******` in the field, the stored key is kept.)
4. The input reads the key at every firing, so the next firing uses the new one. Check the input log for a `done:` line and no `token minting failed` (see [Validation](#validation)).
5. Repeat on every other instance that has an input using this key, such as a standby heavy forwarder. Each instance keeps its own encrypted copy in the add-on's `local/passwords.conf`; the Deployment Server does not carry it.
6. Then disable or delete the old key in your GCP project (**Keys** tab of the service account).

SAP's grants are bound to the service account's email, not to a key, so a new key needs nothing from SAP.

## :material-circle-box:{ .taiconcolor } Validation

Confirm the input is registered and firing (run on the heavy forwarder):

```bash
curl -sk -u admin:<pwd> \
  "https://localhost:8089/servicesNS/nobody/splunk_ta_sap_logserv_gcp/splunk_ta_sap_logserv_gcp_sap_logserv_gcp_pubsub?output_mode=json"
```

Watch the input log on the HF:

```bash
sudo tail -f /opt/splunk/var/log/splunk/splunk_ta_sap_logserv_gcp_pubsub.log
# look for:  Input 'logserv_gcp' done: messages=N objects=N events=N dups=N acked=N ...
```

Search the indexer (events route to per-source sourcetypes just like AWS and Azure):

```spl
index=sap_logserv_logs cloud_provider=gcp _index_earliest=-1h | stats count by sourcetype
```

For the full set of checks (sourcetypes, one `cloud_provider` value per event, routing), see [Verify Your Data](../getting-started/verify-data.md).

### Troubleshooting

| Symptom (in the input log unless noted) | Cause | Fix |
|---|---|---|
| Splunk Web shows *"This operation is forbidden"* (HTTP 403) when you save, edit or delete an input | The signed-in role lacks the `admin_all_objects` capability | Use a role that holds `admin_all_objects` on this instance (see [Configure the input](#configure-the-input)). |
| `service-account key not found in passwords.conf; skipping` | No credential for this input name on this host | Re-enter the key on this HF (Inputs tab → Edit, or the REST call above). The key lives in the add-on's own `local/passwords.conf`; it is **not** affected by Deployment-Server pushes. |
| `service-account key unusable (...)` | The pasted key is not a valid service-account JSON key (truncated paste, wrong file, or only the bare private key was pasted instead of the whole JSON file) | Re-paste the **entire** JSON key file verbatim — the full `{...}` document, with the `-----BEGIN/END PRIVATE KEY-----` lines left intact inside the `private_key` value. |
| `token minting failed (...)` | The key is disabled, deleted or expired, the HF can't reach `oauth2.googleapis.com`, or the system clock is skewed (JWTs are time-signed) | Verify egress to `oauth2.googleapis.com:443` and NTP sync; check in **your** GCP console whether the key is still active (**IAM & Admin → Service Accounts → Keys**), and if it is not, mint a new one and [replace it](#rotate-credentials). |
| `subscription pull failed (... 403 ...)` | SAP's `roles/pubsub.subscriber` grant for your service account is missing or not yet applied, or `project_id`/`subscription_name` are wrong | Confirm the values with your SAP support contact and that the grant for your service account's **email** is in place on **this** subscription ([The onboarding sequence](#the-onboarding-sequence)). |
| `subscription pull failed (HTTP 403: … SERVICE_DISABLED …)` naming the service account's **home** project ("…API has not been used in project…") | The service account is homed in **your** GCP project, a different project from the LogServ resources, and the Pub/Sub or Cloud Storage API isn't enabled there (Google attributes API quota to the credential's home project) | Enable the **Cloud Pub/Sub API** and **Cloud Storage API** in the account's home project and retry (step 4 of [The onboarding sequence](#the-onboarding-sequence)). |
| `object read forbidden (HTTP 403)` | The service account lacks `roles/storage.objectViewer` on the bucket | Ask SAP to add the bucket-read grant for your service account's email; the message is left for retry and reprocesses once fixed. |
| `done: messages=0` every firing, but objects exist | The bucket notification (SAP-managed) isn't publishing, or the subscription name is wrong | Confirm with your SAP support contact that the `OBJECT_FINALIZE` notification and subscription are active; verify egress to `pubsub.googleapis.com`. |
| Input kind `sap_logserv_gcp_pubsub` not listed / Inputs page missing | The GCP add-on isn't installed (or Splunkd wasn't restarted) on this HF | Install `splunk_ta_sap_logserv_gcp` on the HF and restart (see [Install the GCP add-on](#install-the-gcp-add-on)). |

For problems that are not specific to the GCP input, see [Troubleshooting](../getting-started/troubleshooting.md).

## :material-circle-box:{ .cboxmove } Next steps

- [Verify Your Data](../getting-started/verify-data.md): check that events arrive with the expected sourcetypes and one `cloud_provider` value
- Check the [LogServ App prerequisites](../logserv-app/prerequisites.md), then [install the LogServ App](../logserv-app/installation.md) on your Search Head
- Review the [supported log types](../getting-started/supported-log-types.md) reference
- For Splunk Cloud considerations, see [Splunk Cloud Considerations](../getting-started/splunk-cloud.md)
