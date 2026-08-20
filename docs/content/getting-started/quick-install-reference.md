# Quick Install Reference

A single matrix mapping every Splunkbase add-on, prerequisite, and LogServ component to the tier(s) where each gets installed. Use this as a pre-install checklist; for full install steps see the per-package pages linked from each row.

### :material-circle-box:{ .taiconcolor } Package Matrix

!!! note "Single-instance Splunk"
    For a single-instance Splunk deployment (one host playing every role), install every required app on that one host. The matrix below is for distributed topologies — column headings refer to specific tiers. **SH** = Search Head, **IDX** = Indexer, **HFs** = Heavy Forwarders, **DS** = Deployment Server.

| App | Splunkbase | Required? | SH | IDX | HFs | DS |
|---|---|---|:---:|:---:|:---:|:---:|
| **LogServ Data TA** (`splunk_ta_sap_logserv`) | this repo | required | — (single instance: yes) | ✓ (indexes.conf) | ✓ (via DS) | ✓ (filter UI) |
| **LogServ App** (`splunk_app_sap_logserv`) | this repo | required | ✓ | — | — | — |
| **Splunk Common Information Model** (`Splunk_SA_CIM`) | <a href="https://splunkbase.splunk.com/app/1621" target="_blank">1621</a> ≥ 5.0.0 | required (declared App dependency) | ✓ | — | — | — |
| **Splunk Add-on for Unix and Linux** | <a href="https://splunkbase.splunk.com/app/833" target="_blank">833</a> | required (field extraction) | ✓ | — | — | — |
| **Splunk Add-on for Microsoft Windows** | <a href="https://splunkbase.splunk.com/app/742" target="_blank">742</a> | required (field extraction) | ✓ | — | — | — |
| **Splunk Add-on for AWS** | <a href="https://splunkbase.splunk.com/app/1876" target="_blank">1876</a> | required if SAP ECS in AWS | — | — | ✓ (S3 inputs) | — |
| **LogServ Azure add-on** (`splunk_ta_sap_logserv_azure`) | this repo | required if SAP ECS in Azure | — | — | ✓ (Blob input, per-HF) | — |
| **LogServ GCP add-on** (`splunk_ta_sap_logserv_gcp`) | this repo | required if SAP ECS in GCP | — | — | ✓ (Pub/Sub input, per-HF) | — |
| **Splunk MCP Server** | <a href="https://splunkbase.splunk.com/app/7931" target="_blank">7931</a> v1.0.3+ (< 2.0.0; tested against 1.1.0) | required for AI Assistant | ✓ | — | — | — |
| **Splunk AI Assistant** | <a href="https://splunkbase.splunk.com/app/200" target="_blank">200</a> | recommended companion to 7931 | ✓ | — | — | — |

### :material-circle-box:{ .taiconcolor } Notes

- **Indexer rationale.** The Data TA goes on the indexer because it bundles `indexes.conf`. See [Why does the Data TA need to go on the Indexer?](../install-setup/install-ta.md#3-where-to-install) for the trade-off + opt-out path.
- **OS field-extraction add-ons go on the SH only.** The Unix/Linux (833) and Windows (742) TAs carry only search-time content (props/transforms/eventtypes/tags/lookups for the parsing the LogServ App's dashboards consume); none of them need to run on the indexer or HFs for our pipeline. They are **required for the OS-level dashboards to fully populate** — the LogServ App ships no `XmlWinEventLog` extraction of its own, so without add-on 742 on the search tier the **Windows** dashboard's Event Codes, Severity Distribution, Critical/Error, and Service Events panels render empty even though the events index fine (see [Windows dashboard](../logserv-app/dashboards/platform/windows.md)). They are also what makes the OS sourcetypes CIM-compliant for Enterprise Security. **Tier:** install on the **Search Head** (Splunk Cloud: the Cloud SH via self-service app management) — not the HF or indexer; on Splunk Cloud the search-time extraction runs on the SH and is replicated to the indexer search peers via the knowledge bundle. If your installation **also** uses one of these TAs' scripted inputs for some other purpose (e.g., the `cpu.sh` / `vmstat.sh` modular inputs in Splunk_TA_nix), follow that TA's own installation guidance for the indexer/HF side — that usage is independent of this app.
- **No standalone Squid Proxy or ISC BIND add-ons needed.** Their parsing is absorbed into the LogServ App (from the archived Splunk Add-on for Squid Proxy v2.1.0 and Splunk Add-on for ISC BIND v2.0.0 — see the release notes). If you have either standalone TA installed alongside the LogServ App, the App's home view shows a one-time dismissible banner recommending uninstall via `Settings → Manage Apps` (otherwise both TAs' parsing applies in parallel — duplicate field extraction).
- **AWS Add-on (1876).** Only needed when SAP ECS data lives in AWS S3. The TA owns the SQS-based S3 inputs that pull data from the dest bucket; the LogServ Data TA then sourcetype-routes events as they're parsed on HFs. The actual `index = sap_logserv_logs` setting that sends events to the right place lives in this TA's S3 input config — not in the LogServ Data TA.
- **Azure Blob Storage ingest — LogServ Azure add-on, per HF.** When SAP ECS data lives in Azure Blob Storage, ingest is handled by the first-party **Splunk TA for SAP LogServ on Azure** add-on (`splunk_ta_sap_logserv_azure`) and its **`sap_logserv_azure_queue`** modular input (the Azure twin of the AWS SQS-S3 input): an Azure Event Grid subscription drops `BlobCreated` notifications onto a Storage Queue, and the input consumes the queue and fetches each blob over a SAS. It emits `sourcetype = sap_logserv_logs` so the LogServ Data TA's routing applies identically to the AWS path, and stamps `_meta = cloud_provider::azure`. Install the Azure add-on **directly on each Heavy Forwarder (not via the Deployment Server)** — its SAS lives in the add-on's own `local/`. Customers ingesting from multiple clouds install the matching add-on per channel, all on the HF tier. See the [Azure Setup Guide](../install-setup/azure-setup.md) for the full setup (Event Grid + Storage Queue + per-HF install).
- **Google Cloud Storage ingest — LogServ GCP add-on, per HF.** When SAP ECS data lives in Google Cloud Storage, ingest is handled by the first-party **Splunk TA for SAP LogServ on GCP** add-on (`splunk_ta_sap_logserv_gcp`) and its **`sap_logserv_gcp_pubsub`** modular input (the GCP twin of the AWS SQS-S3 input): the GCS bucket publishes `OBJECT_FINALIZE` notifications to a Pub/Sub topic, and the input pulls the subscription and fetches each object with a service-account key. It emits `sourcetype = sap_logserv_logs` so the LogServ Data TA's routing applies identically, and stamps `_meta = cloud_provider::gcp`. Install the GCP add-on **directly on each Heavy Forwarder (not via the Deployment Server)** — its service-account key lives in the add-on's own `local/`. (The general-purpose Splunk Add-on for GCP, Splunkbase 3088, is **not** used: it cannot decompress the gzipped LogServ objects.) See the [GCP Setup Guide](../install-setup/gcp-setup.md) for the full setup (Pub/Sub subscription + per-HF install).
- **MCP Server (7931).** Required for the AI Assistant's predefined-prompt path even when the LLM-driven path is disabled. Without it, the AI Assistant chat panel can't dispatch saved searches.
- **Splunk AI Assistant (200).** The LogServ App uses only the core `splunk_run_saved_search` and `splunk_run_query` MCP tools (which work standalone against 7931), but App 200 follows Splunk's documented co-install pattern and unlocks `saia_*`-prefixed MCP tools that may be used in future LogServ releases.

### :material-circle-box:{ .taiconcolor } Per-Topology Checklists

#### :material-crop-square:{ .taiconcolor } Single Splunk instance

Install all required + recommended apps on the same instance. Splunk auto-creates both indexes (`sap_logserv_logs` + `logserv_ai_assistant_audit`) when the Data TA loads on first start.

#### :material-crop-square:{ .taiconcolor } Distributed (DS + HFs + on-prem SH+IDX)

| Tier | Install |
|---|---|
| **Search Head** | LogServ App, MCP Server (7931), Splunk AI Assistant (200), CIM add-ons (Unix/Linux, Windows) |
| **Indexer** | LogServ Data TA (provides indexes.conf for both indexes). The CIM add-ons are **not** needed here — they carry only search-time content. |
| **Deployment Server** | LogServ Data TA (manages filter UI + pushes Data TA to HFs) |
| **Heavy Forwarders** | Receive LogServ Data TA via the DS automatically. For **AWS S3** ingest, install the AWS add-on (1876); for **Azure Blob Storage** ingest, install the LogServ Azure add-on (`splunk_ta_sap_logserv_azure`) directly on each HF — **not** via the DS (see the [Azure Setup Guide](../install-setup/azure-setup.md)); for **Google Cloud Storage** ingest, install the LogServ GCP add-on (`splunk_ta_sap_logserv_gcp`) directly on each HF (see the [GCP Setup Guide](../install-setup/gcp-setup.md)). The CIM add-ons are **not** needed here. |

#### :material-crop-square:{ .taiconcolor } Distributed (DS + HFs + Splunk Cloud SH)

| Tier | Install |
|---|---|
| **Splunk Cloud Search Head** | LogServ App, MCP Server (7931), Splunk AI Assistant (200), CIM add-ons (Unix/Linux, Windows) |
| **Splunk Cloud Indexer tier** | Splunk Cloud admin handles. Either (a) install the LogServ Data TA there to use the bundled index defs, OR (b) the Cloud admin manually creates `sap_logserv_logs` and `logserv_ai_assistant_audit` via the Splunk Cloud UI — see [Why does the Data TA need to go on the Indexer?](../install-setup/install-ta.md#3-where-to-install). |
| **Deployment Server** | LogServ Data TA |
| **Heavy Forwarders** | Receive LogServ Data TA via the DS. For **AWS S3** ingest, install the AWS add-on (1876); for **Azure Blob Storage** ingest, install the LogServ Azure add-on (`splunk_ta_sap_logserv_azure`) directly on each HF — **not** via the DS; for **Google Cloud Storage** ingest, install the LogServ GCP add-on (`splunk_ta_sap_logserv_gcp`) directly on each HF. |

## :material-circle-box:{ .cboxmove } Next Steps

- [Architecture](architecture.md) — full topology diagram + the why behind the package split
- [Data TA Prerequisites](../install-setup/prerequisites.md) — Splunkbase TA prereq detail (which CIM add-on covers which sourcetype)
- [LogServ App Prerequisites](../logserv-app/prerequisites.md) — MCP Server + AI Assistant prereq detail
- [Installing the Data TA](../install-setup/install-ta.md) — full install procedure including the indexer-tier rationale
- [Installing the LogServ App](../logserv-app/installation.md)
