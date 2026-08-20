# SAP LogServ on GCP — Setup Guide

This page covers ingesting LogServ data from **Google Cloud Storage (GCS)** using the standalone **Splunk TA for SAP LogServ on GCP** add-on (`splunk_ta_sap_logserv_gcp`) and its **`sap_logserv_gcp_pubsub`** modular input — the GCP twin of `Splunk_TA_aws`'s **SQS-Based S3** input and of the LogServ Azure add-on's Storage-Queue input. A GCS bucket notification publishes an `OBJECT_FINALIZE` message to a **Pub/Sub** topic; this input pulls a **Pub/Sub subscription** on that topic, fetches each named object with a Google **service-account key**, gunzips it, and emits its NDJSON. This is the model SAP's own LogServ-on-GCP collector uses (Pub/Sub object-creation notifications). You install this small, first-party add-on **on each Heavy Forwarder** — the same deployment model as the Splunk Add-on for AWS and the LogServ Azure add-on — and the LogServ **Data TA** on the same HF provides the downstream sourcetype routing, filtering, and stamping. The downstream pipeline (sourcetype routing, filtering, dashboards, ES integration) is identical to the AWS S3 and Azure Blob paths.

!!! info "SAP provides the GCP infrastructure — you provide the service account that reads it"
    In a RISE / SAP ECS deployment the **GCS bucket, bucket notification, Pub/Sub topic, and Pub/Sub subscription are all provisioned and managed by SAP in the SAP-managed GCP project.** You do not build any of that. What you **do** provide is the *identity* the Splunk input runs as: a **service account you create in a GCP account of your own** (a secondary account, separate from the SAP-managed RISE project — any project your organization controls). You hand the service account's **email address** to your **SAP support contact**, SAP grants it read access to the LogServ bucket + Pub/Sub subscription, and you mint its **JSON key** for the Splunk input — see [The onboarding sequence](#the-onboarding-sequence). On the Splunk side your tasks are to **install the `splunk_ta_sap_logserv_gcp` add-on on each Heavy Forwarder** and create a **Splunk input** on it — one per GCP landscape (most deployments have a single landscape, hence one input; you can define several on the same HF if you ingest from more than one — see [Multiple landscapes / fleets](#multiple-landscapes-fleets)), using the values from [Parameters for the input](#parameters-for-the-input).

## :material-circle-box:{ .taiconcolor } Architecture overview

![GCP Pub/Sub-driven ingest architecture](../../images/gcp-pubsub-architecture.png)

```
SAP LogServ RISE-ECS  (SAP-managed GCP project)
  └─> writes NDJSON.gz objects to Google Cloud Storage under the logserv/ prefix
        └─> GCS bucket notification (OBJECT_FINALIZE)
              └─> Pub/Sub topic ──> Pub/Sub PULL subscription (one message per new object)
                    |
                    |    [Customer GCP account]  service account created by YOU;
                    |    SAP grants it read access to the LogServ bucket + subscription;
                    |    its JSON key authenticates the Splunk input below
                    |
                    └─> [GCP TA: sap_logserv_gcp_pubsub]  (runs on the Heavy Forwarder)
                          ├─ pulls the subscription, fetches each object with the
                          │  service-account credential, gunzips, splits NDJSON
                          └─> emits via EventWriter, sourcetype=sap_logserv_logs
                                └─> [LogServ Data TA pipeline]  (same Heavy Forwarder):
                                      transforms.conf routes by clz_dir/clz_subdir,
                                      Configuration -> Filters nullQueue, _time drop,
                                      splunk_solution / cloud_provider stamping
                                        └─> forwarded to the Indexer
                                              └─> dashboards + ES integration
```

Everything from the LogServ object writer down through the **Pub/Sub subscription lives in the SAP-managed GCP project and is managed by SAP.** The one piece homed on **your** side of GCP is the **service account**: it lives in a customer-managed GCP account, SAP grants it cross-project read access to the LogServ subscription + bucket, and its JSON key is what the Splunk input authenticates with — the GCP analogue of the AWS path's customer-account **cross-account IAM role**. The **GCP TA's `sap_logserv_gcp_pubsub` input** runs on **your Heavy Forwarder**, pulls the subscription SAP exposes to you, and hands its events to the **LogServ Data TA** (also on that HF) for routing/filtering/stamping. This is exactly how `Splunk_TA_aws` and the LogServ Azure add-on cooperate with the Data TA on their respective paths.

**Why EventWriter, not HEC:** the input runs on the Heavy Forwarder and emits through the HF's native index-time pipeline, so every existing LogServ Data TA feature — `clz_dir`/`clz_subdir` sourcetype routing, the Configuration → Filters `nullQueue` filtering, the `days_in_past` / `_time` drop, and the `splunk_solution` / `cloud_provider` stamping — applies to GCP events **unchanged**, exactly as it does to AWS S3 and Azure Blob events. The input is **stdlib-only** (Pub/Sub + GCS REST over `urllib`, with a pure-Python OAuth2 service-account token exchange — no Google SDK), so it adds no AArch64 / native-binary burden and is Splunk Cloud-clean.

!!! note "Why not the Splunk Add-on for Google Cloud Platform?"
    The general-purpose [Splunk Add-on for Google Cloud Platform (Splunkbase 3088)](https://splunkbase.splunk.com/app/3088) ships a "Cloud Pub/Sub Based Bucket" input with the same notification-driven shape, but as of add-on 3088 v5.0.3 (validated 2026-07-05) it does **not decompress gzipped objects** — and SAP LogServ objects are gzipped NDJSON (`*.json.gz`), so its ingest fails on real LogServ data. It also requires an extra `roles/pubsub.viewer` grant beyond the roles SAP documents. The LogServ GCP add-on exists to close those gaps: native gunzip, the exact SAP-documented service-account roles, and `cloud_provider=gcp` stamping out of the box.

## :material-circle-box:{ .taiconcolor } Prerequisites

**Provided by SAP** (in the SAP-managed GCP project — you obtain the *values*, you do not build the resources):

- A **GCS bucket** holding the LogServ objects (under the `logserv/` prefix — same path convention as AWS S3 and Azure Blob: `<bucket>/logserv/<clz_dir>/<clz_subdir>/<YYYY>/<MM>/<DD>/<file>.json.gz`).
- A **bucket notification** publishing `OBJECT_FINALIZE` events to a **Pub/Sub topic**, and a **PULL subscription** on that topic dedicated to your Splunk consumer (recommended: ack deadline 300 s+ and a dead-letter policy).
- The **cross-project IAM grants** on those resources for the service account you provide (see below).

Obtain the GCP project ID and the subscription name from your **SAP support contact** — see [Parameters for the input](#parameters-for-the-input).

**Provided by you in GCP (the service account — see [The onboarding sequence](#the-onboarding-sequence)):**

- A **GCP account of your own** — a *secondary* account, separate from the SAP-managed RISE project; any project your organization controls. No infrastructure is deployed in it — it is only the administrative home of the identity.
- A **service account** created in that project. You hand its **email address** to your SAP support contact, and SAP grants it **`roles/pubsub.subscriber` on the LogServ subscription** and **`roles/storage.objectViewer` on the LogServ bucket** (see [What SAP must grant your service account](#what-sap-must-grant-your-service-account)).
- A **JSON key** for that service account, minted by your GCP admin (check the org-policy warning in [The onboarding sequence](#the-onboarding-sequence) *before* install day).
- The **Cloud Pub/Sub API** and **Cloud Storage API** enabled in the service account's home project (Google attributes API quota to the credential's *home* project, not to the project holding the resources).

**On your Splunk side (each Heavy Forwarder that will ingest GCP data):**

- **LogServ Data TA `0.1.1`+** installed on the Heavy Forwarder (it provides the index-time routing/filtering/stamping; see [Installing the Data TA](install-ta.md)). The Data TA is normally distributed by the Deployment Server.
- **Splunk TA for SAP LogServ on GCP (`splunk_ta_sap_logserv_gcp`) `0.1.1`+** installed on the **same Heavy Forwarder** (see [Install the GCP add-on](#install-the-gcp-add-on)). It registers the `sap_logserv_gcp_pubsub` input kind. The input is inert until you create an input instance.
- Network egress from the Heavy Forwarder to `oauth2.googleapis.com`, `pubsub.googleapis.com`, and `storage.googleapis.com` (port 443 / HTTPS).

!!! warning "Compact JSON format required"
    Each object is gzipped NDJSON (one event per line). The index-time routing transforms assume **compact JSON** (no whitespace after `:`). The SAP LogServ collector emits compact JSON natively, so no action is required on your side. (For reference: pretty-printed JSON would bypass the transforms and land as `sourcetype=sap_logserv_logs`, breaking dashboards.)

## :material-circle-box:{ .taiconcolor } Parameters for the input

SAP has already provisioned the bucket, notification, topic, and subscription in the SAP-managed GCP project — the only GCP resource **you** create is the service account ([The onboarding sequence](#the-onboarding-sequence)). **Contact your SAP support contact** to obtain the two SAP-side values, then plug them — plus your own service-account key — into the Splunk input ([Configure the input](#configure-the-input)):

| Parameter | Input field | Provided by | Description |
|---|---|---|---|
| GCP project ID | `project_id` | SAP | The GCP project that hosts the LogServ Pub/Sub subscription (SAP's LogServ project — e.g. the `LOGSERV_PROJECT_ID` value SAP's own forwarder documentation references). 6–30 chars: lowercase letters, digits, hyphens; starts with a letter, ends with a letter or digit. |
| Subscription name | `subscription_name` | SAP | The Pub/Sub **PULL** subscription receiving the bucket's `OBJECT_FINALIZE` notifications. Must be dedicated to your Splunk consumer (competing consumers split messages). |
| Service-account key | `service_account_key` | **You** | The full Google service-account **JSON key file** contents, minted from the service account you created in your own GCP account (after SAP confirms the grants). Treat it as a secret. |

The bucket name and `logserv/` prefix are carried inside each notification message — they are not separate input fields. The three Google endpoints your Heavy Forwarder must reach are fixed (`oauth2.googleapis.com`, `pubsub.googleapis.com`, `storage.googleapis.com`).

### The onboarding sequence

The service account is **customer-homed**: it lives in a GCP account you control (the *secondary* account in the architecture diagram), and SAP binds cross-project grants on the SAP-managed LogServ resources to it. Nothing is deployed in your project — it is only the administrative home of the identity. The sequence:

1. **Create the service account** in a GCP project your organization controls: **IAM & Admin → Service Accounts → Create service account**. A descriptive name such as `splunk-logserv-ingest` helps everyone's audit trail. The account needs **no roles in your own project**.
2. **Hand the service account's email address** (`<name>@<your-project-id>.iam.gserviceaccount.com`) **to your SAP support contact** and request LogServ consumer access for it.
3. **SAP grants the account** `roles/pubsub.subscriber` on the LogServ subscription and `roles/storage.objectViewer` on the LogServ bucket (cross-project IAM bindings on the SAP-managed resources — see [What SAP must grant your service account](#what-sap-must-grant-your-service-account)), and returns the **project ID** and **subscription name** values for the input.
4. **Enable the Cloud Pub/Sub API and the Cloud Storage API** in the service account's home project (**APIs & Services → Enable APIs and services**). Google attributes API quota to the credential's *home* project, so a missing enablement fails the first connection with `403 SERVICE_DISABLED` naming **your** project (see [Troubleshooting](#troubleshooting)).
5. **Mint the JSON key**: **IAM & Admin → Service Accounts → *(the account)* → Keys → Add key → Create new key → JSON**, and stage the downloaded file for the input configuration. *(Read the org-policy warning below first.)*
6. **Configure the input** on each Heavy Forwarder ([Configure the input](#configure-the-input)) once SAP confirms the grants are in place.

!!! warning "Organization policy can block key creation entirely"
    Many enterprises enforce the `iam.disableServiceAccountKeyCreation` organization policy as a security guardrail. If it applies to the service account's home project, minting a JSON key fails **regardless of IAM roles** — your admin needs `roles/iam.serviceAccountKeyAdmin` on the account *and* a policy exemption for it. Check this **before** install day; it is the most common last-minute blocker.

!!! note "Onboarded earlier with an SAP-issued key?"
    Deployments onboarded before this flow — where SAP issued a key for a service account homed in the SAP-managed LogServ project — continue to work unchanged. New onboarding uses the customer-homed sequence above.

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

Install `splunk_ta_sap_logserv_gcp-0.1.1.tar.gz` **directly on each Heavy Forwarder** that will ingest GCP data — exactly the tier where `Splunk_TA_aws` (AWS) and the LogServ Azure add-on (Azure) are installed for their paths.

- Splunk Web → **Manage Apps → Install app from file** → upload the tarball, **or**
- `/opt/splunk/bin/splunk install app /path/splunk_ta_sap_logserv_gcp-0.1.1.tar.gz`, **or**
- configuration management (Ansible / Puppet / Chef) drops the app into `etc/apps/`, then `chown -R splunk:splunk` and restart.

!!! danger "Do NOT distribute the GCP add-on via the Deployment Server"
    Install it **directly on each Heavy Forwarder — never as a deployment-app.** The input's service-account key is stored, encrypted, in the add-on's own `local/passwords.conf`; a Deployment Server push **replaces the app's `local/` directory**, which would wipe the per-HF credential. (This is the same reason `Splunk_TA_aws` and the LogServ Azure add-on are configured per-HF rather than DS-distributed.) The **Data TA** stays DS-managed as before — only the cloud-ingest add-ons are per-HF.

After installing + restarting, the `sap_logserv_gcp_pubsub` input kind is registered and the add-on's **Inputs** page is available under **Apps → Splunk TA for SAP LogServ on GCP**.

## :material-circle-box:{ .taiconcolor } Configure the input

On **each** Heavy Forwarder, create one input instance for your GCP landscape. The service-account key is encrypted into the **add-on's own** `local/passwords.conf` and is **not** Deployment-Server-managed — it survives restarts and Data-TA pushes.

### Via Splunk Web (per Heavy Forwarder)

Splunk Web → **Apps → Splunk TA for SAP LogServ on GCP → Inputs → Create New Input**, and fill in the fields below with the project ID + subscription name from SAP — and paste the **entire JSON key file of your own service account** into the key field. (For a second landscape on the same HF, use the Inputs table's **Clone** action and give it a new name — the key is not carried on clone, so re-paste it. On **Edit**, the key field shows `******`; saving without changing it preserves the existing key.)

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
| `service_account_key` | — | The **complete JSON key file** of the service account you created in your own GCP account ([The onboarding sequence](#the-onboarding-sequence)), pasted **verbatim** — including the `-----BEGIN PRIVATE KEY-----` / `-----END PRIVATE KEY-----` lines inside the `private_key` value. Encrypted credential: the value lives in the add-on's `local/passwords.conf`; `inputs.conf` carries only the masked `******` placeholder. |
| `index` | `sap_logserv_logs` | Target index. Does **not** affect parsing — the Data TA's index-time pipeline keys on the sourcetype, not the index. You may point it at a custom index, but the dashboards query through the `sap_logserv_idx_macro` macro, so update that macro to match (see caveat below). |
| `event_sourcetype` (UI label **Sourcetype**) | `sap_logserv_logs` | **Fixed at `sap_logserv_logs`.** The add-on hard-codes this sourcetype (it is not read from the stanza), and the field is shown read-only when editing the input. Leave it at the default. |
| `interval` | `60` | Seconds between firings (10–3600). Each firing drains the subscription within a per-firing time budget (currently 90% of `interval`, capped at 240 s) and the `max_objects_per_fire` cap. |
| `batch_size` | `10` | Pub/Sub messages requested per pull call (`maxMessages`, 1–1000). |
| `max_objects_per_fire` | `500` | Cap on objects ingested per firing (backlog safety valve). |
| `poison_threshold` | `5` | A message redelivered more than this many times (Pub/Sub `deliveryAttempt`) is acked and dropped. See [Reliability behavior](#reliability-behavior). |
| `include_filters` / `exclude_filters` | *(empty)* | Optional comma-separated substrings applied to the GCS object path as a cheap pre-filter (beyond the built-in `logserv` match). The canonical allow/deny policy lives in the Data TA's Filters tab. |
| `verify_ssl` | `1` | TLS verification for the Google API endpoints. Leave enabled for production. |

!!! note "Sourcetype is fixed; the Index is yours to change"
    The **Sourcetype** is effectively fixed at **`sap_logserv_logs`** — the add-on always emits it (the value is hard-coded in the input, not read from the stanza), and the field is shown read-only (disabled) when editing an existing input. This is deliberate: the Data TA's index-time routing, Filters `nullQueue`, `_time` drop, and `splunk_solution` / `cloud_provider` stamping all key on `sourcetype = sap_logserv_logs` (`props.conf` stanzas match on sourcetype, **not** index), so it must never vary.

    The **`index`**, by contrast, may be changed safely — parsing is unaffected (events are routed, filtered, and stamped identically no matter which index they land in). You may point it at a custom index (for example a per-customer index such as `sap_logserv_logs_con01`). The only follow-up is dashboard visibility: the dashboards and rollups search through the `sap_logserv_idx_macro` macro (default `index="sap_logserv_logs"`), so override that macro in the App's `local/macros.conf` to match your index, or the dashboards won't find the data.

### `cloud_provider` attribution

The input stamps every event it emits with the indexed field `cloud_provider=gcp` (via `_meta = cloud_provider::gcp` on the generated stanza), so search-time queries and the **Multi-Cloud Overview** dashboard can distinguish GCP-sourced from AWS- and Azure-sourced data.

!!! warning "On a Heavy Forwarder that ingests from MORE THAN ONE cloud"
    The Data TA's **Configuration → Cloud Provider** dropdown stamps `cloud_provider` TA-wide at index time. If it is set to `aws` (or any provider) on a forwarder that also runs this GCP input, that index-time stamp co-fires with the input's per-event `_meta=gcp`, leaving `cloud_provider` **multivalued** on the GCP events. For correct per-channel attribution on a mixed forwarder, set the **Cloud Provider dropdown to "Not set"** and attribute per input: this GCP input and the LogServ Azure add-on's input already self-attribute via `_meta`; add `_meta = cloud_provider::aws` to the `Splunk_TA_aws` SQS-S3 input. On a single-cloud forwarder, the dropdown alone is simplest. See [Configuring Filters → Cloud Provider Attribution](configure-filters.md#cloud-provider-attribution).

### Multiple landscapes / fleets

- **Multiple GCP landscapes on one HF:** create one input instance per landscape (different `project_id` / `subscription_name`), using the Inputs table's **Clone** action. The per-instance credential is keyed by the input name; re-paste the key on each (clone never carries secrets).
- **A fleet of Heavy Forwarders:** repeat the install + input creation on each HF. For zero-touch fleets, config management can drop the add-on into `etc/apps/` and seed the key via the REST call above (it encrypts under each HF's own `splunk.secret`). **Do not** add the add-on to the Deployment Server's `deployment-apps/`.

!!! note "Scaling one subscription across inputs — Pub/Sub is natively competing-consumer"
    Separate input *instances* are normally for **different** subscriptions. You *can* also point several identical inputs at the **same** subscription to raise throughput — competing consumers are Pub/Sub's native delivery model: the subscription's ack deadline hands each message to one consumer at a time, so N inputs (across one HF or several) pull and ingest N batches of objects in parallel with no duplicate-message handout. Understand the trade-off first:

    - A **single** input is **effectively duplicate-free across the subscription's redelivery window** — its per-input dedup checkpoint (keyed `bucket/object#generation`; entries are retained for about 7 days, up to 50,000 objects) skips an already-ingested object if a message reappears.
    - **Same-subscription inputs don't share that checkpoint**, so they fall back to **at-least-once** (the same guarantee as the AWS SQS-S3 input). If a message's fetch + ingest exceeds the subscription's **ack deadline** (SAP-managed; 300 s recommended), the message redelivers and another input may re-ingest it → **duplicate events**. The guard: keep per-message processing comfortably under the ack deadline (defaults do — each message is one object). `deliveryAttempt` is Pub/Sub's server-side, shared counter, so the `poison_threshold` decision stays coordinated across the consumers, and a subscription-level **dead-letter policy** (SAP-managed) handles poison messages natively.

    For typical LogServ volumes a **single input already keeps up** (it drains up to `max_objects_per_fire` objects per firing). Prefer raising `batch_size` / `max_objects_per_fire` or lowering `interval` on one input before adding consumers.

## :material-circle-box:{ .taiconcolor } Reliability behavior

- **At-least-once + dedup.** A subscription message carrying a LogServ object is acknowledged **only after** that object ingests successfully (unparseable / non-`OBJECT_FINALIZE` notifications and paths your filters reject are acknowledged without ingest and counted as `noise=` in the done log line; poison messages likewise — see below); each object is deduplicated by `bucket/object#generation` in a checkpoint sidecar, so a redelivered message re-ingests nothing.
- **Transient failures leave the message.** A 5xx / network error on an object fetch leaves the message unacknowledged (it redelivers after the ack deadline); already-ingested objects in that message are no-ops on retry.
- **Object-read denied (HTTP 403) leaves the message** and logs loudly — this is the missing-`storage.objectViewer` signal (get the bucket-read grant from SAP; the message reprocesses).
- **Pull denied (HTTP 403) aborts the firing** — the service account lacks `roles/pubsub.subscriber` (or the project/subscription values are wrong); nothing is consumed until the credential is fixed.
- **Deleted objects (HTTP 404) are acked and skipped** — an object that vanished between notification and fetch can't loop.
- **Poison messages** (redelivered more than `poison_threshold` times, per Pub/Sub's `deliveryAttempt` counter) are acked and dropped so one permanently-bad object can't loop forever. `deliveryAttempt` is populated only when the subscription has a **dead-letter policy** — with one attached, Pub/Sub also dead-letters natively (the primary mechanism; the TA's threshold is a local backstop).

## :material-circle-box:{ .taiconcolor } Historical backfill

Notification-driven ingest is **forward-only by nature** — the bucket notification fires only on *new* `OBJECT_FINALIZE` events, so once SAP's notification is live the input ingests everything written from that point on, but does **not** replay objects that already existed. There is no queue-native historical backfill yet; a one-time bulk load of pre-existing objects is a roadmap item. If you need to seed history, contact your Splunk team. The index-time `days_in_past` / `_time` filter applies to any backfilled events the same way it does to live ingest.

## :material-circle-box:{ .taiconcolor } Validation

Confirm the input is registered and firing (run on the Heavy Forwarder):

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

### Troubleshooting

| Symptom (in the input log) | Cause | Fix |
|---|---|---|
| `service-account key not found in passwords.conf; skipping` | No credential for this input name on this host | Re-enter the key on this HF (Inputs tab → Edit, or the REST call above). The key lives in the add-on's own `local/passwords.conf`; it is **not** affected by Deployment-Server pushes. |
| `service-account key unusable (...)` | The pasted key is not a valid service-account JSON key (truncated paste, wrong file, or only the bare private key was pasted instead of the whole JSON file) | Re-paste the **entire** JSON key file verbatim — the full `{...}` document, with the `-----BEGIN/END PRIVATE KEY-----` lines left intact inside the `private_key` value. |
| `token minting failed (...)` | The key is revoked/expired, the HF can't reach `oauth2.googleapis.com`, or the system clock is skewed (JWTs are time-signed) | Verify egress to `oauth2.googleapis.com:443` and NTP sync; check in **your** GCP console whether the key is still active (**IAM & Admin → Service Accounts → Keys**) and mint a new one if needed. |
| `subscription pull failed (... 403 ...)` | SAP's `roles/pubsub.subscriber` grant for your service account is missing or not yet applied, or `project_id`/`subscription_name` are wrong | Confirm the values with your SAP support contact and that the grant for your service account's **email** is in place on **this** subscription ([The onboarding sequence](#the-onboarding-sequence)). |
| `subscription pull failed (HTTP 403: … SERVICE_DISABLED …)` naming the service account's **home** project ("…API has not been used in project…") | The account is homed in **your** GCP account — a different project than the LogServ resources — and the Pub/Sub or Cloud Storage API isn't enabled there (Google attributes API quota to the credential's home project) | Enable the **Cloud Pub/Sub API** and **Cloud Storage API** in the account's home project and retry (step 4 of [The onboarding sequence](#the-onboarding-sequence)). |
| `object read forbidden (HTTP 403)` | The service account lacks `roles/storage.objectViewer` on the bucket | Ask SAP to add the bucket-read grant for your service account's email; the message is left for retry and reprocesses once fixed. |
| `done: messages=0` every firing, but objects exist | The bucket notification (SAP-managed) isn't publishing, or the subscription name is wrong | Confirm with your SAP support contact that the `OBJECT_FINALIZE` notification and subscription are active; verify egress to `pubsub.googleapis.com`. |
| Input kind `sap_logserv_gcp_pubsub` not listed / Inputs page missing | The GCP add-on isn't installed (or Splunkd wasn't restarted) on this HF | Install `splunk_ta_sap_logserv_gcp` on the HF and restart (see [Install the GCP add-on](#install-the-gcp-add-on)). |

## :material-circle-box:{ .cboxmove } Next steps

- Confirm the [LogServ App is installed](../logserv-app/installation.md) on your Search Head
- Review the [supported log types](../getting-started/supported-log-types.md) reference
- For Splunk Cloud Victoria considerations, see [Splunk Cloud Victoria Notes](splunk-cloud-victoria-notes.md)
