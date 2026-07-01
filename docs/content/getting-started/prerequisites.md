# Prerequisites Overview

Splunk for SAP LogServ ships as **two separately installable packages** with distinct prerequisites. Use this page to plan what you need before starting installation.

### :material-circle-box:{ .taiconcolor } The Two Packages

| Package | App ID | Role | Where it installs |
|---|---|---|---|
| **LogServ Data TA** | `splunk_ta_sap_logserv` | Data collection from S3, index-time filtering, deployment server automation, ships the `indexes.conf` for the two indexes the solution writes to | Single instance, OR Deployment Server + each Heavy Forwarder + Indexer |
| **LogServ UI App** | `splunk_app_sap_logserv` | Dashboards, AI Assistant chat panel, search-time field extractions | Single instance, OR the Search Head only |

For single-instance deployments, both packages install on the same instance. For distributed topologies, each package goes to its own tier — never SCP a Data TA file to the Search Head, and never SCP a UI App file to a Heavy Forwarder. The Data TA carries `indexes.conf` defining both `sap_logserv_logs` (SAP data) and `logserv_ai_assistant_audit` (AI Assistant audit log); Splunk auto-creates them on indexer install, no separate Index App required.

Both indexes are **macro-configurable** — `sap_logserv_idx_macro` (SAP data, default `index="sap_logserv_logs"`) and `sap_logserv_audit_idx_macro` (audit log, default `index="logserv_ai_assistant_audit"`). Customers who rename either index update the matching macro definition under **Settings → Advanced search → Search macros**. See [Renaming an index](../install-setup/install-ta.md#renaming-an-index) for the full procedure (READ + WRITE paths).

### :material-circle-box:{ .taiconcolor } Common Prerequisites (both packages)

- **Splunk Enterprise** 9.4.3 or later, or **Splunk Cloud Platform**

Splunk 9.4.3 is the minimum because the LogServ App's React stack (`@splunk/react-ui`, `@splunk/visualizations`, `@xyflow/react`) requires the React component versions shipped with that release.

### :material-circle-box:{ .taiconcolor } Package-Specific Prerequisites

Each package has its own additional prerequisites — install Splunkbase add-ons appropriate to that tier.

- **[Data TA Prerequisites](../install-setup/prerequisites.md)** — CIM-aligned add-ons for the sourcetypes the Data TA produces (Unix/Linux, Windows, Squid, ISC BIND), plus the cloud-storage ingest layer matching where your SAP ECS data lives: the [Splunk Add-on for AWS (Splunkbase 1876)](https://splunkbase.splunk.com/app/1876) for **AWS S3** ingest, or the first-party **Splunk TA for SAP LogServ on Azure** (`splunk_ta_sap_logserv_azure`) for **Azure Blob Storage** ingest — installed per Heavy Forwarder, it consumes Azure Event Grid → Storage Queue notifications (see the [Azure Setup Guide](../install-setup/azure-setup.md)). The Data TA also auto-creates the two indexes (`sap_logserv_logs` + `logserv_ai_assistant_audit`) from its bundled `default/indexes.conf` on first startup — no separate prereq.
- **[LogServ App Prerequisites](../logserv-app/prerequisites.md)** — the [Splunk MCP Server (Splunkbase App 7931)](https://splunkbase.splunk.com/app/7931) for the AI Assistant's predefined-prompt dispatch path, plus the optional [Splunk AI Assistant (App 200)](https://splunkbase.splunk.com/app/200) recommended companion.

!!! tip "Multi-cloud ingest"
    AWS S3 and Azure Blob Storage are first-class ingest channels. **AWS S3** ingest uses the [Splunk Add-on for AWS](https://splunkbase.splunk.com/app/1876) on the Heavy Forwarder tier; **Azure Blob Storage** ingest uses the first-party **Splunk TA for SAP LogServ on Azure** add-on (`splunk_ta_sap_logserv_azure`), installed per Heavy Forwarder (Event Grid → Storage Queue). The same LogServ Data TA + LogServ App handle both: events from either channel land under `sap_logserv_logs` and route to the same downstream sourcetypes. See the [Azure Setup Guide](../install-setup/azure-setup.md) for Azure-specific configuration.

### :material-circle-box:{ .taiconcolor } Decision Tree

| Your situation | What you need |
|---|---|
| Single Splunk instance running the full LogServ solution | Both prerequisite sets — Data TA + App, plus the Splunk Add-on for AWS (1876) for AWS S3 ingest, or the LogServ Azure add-on (`splunk_ta_sap_logserv_azure`) for Azure Blob ingest |
| Distributed Splunk with on-prem Search Head | Data TA prereqs on DS + each HF + the indexer; App prereqs on the SH; the AWS S3 add-on (AWS ingest) or the LogServ Azure add-on (Azure ingest) on each HF |
| Distributed Splunk with Splunk Cloud Search Head | Data TA prereqs on DS + each HF; App prereqs on the Splunk Cloud SH; the AWS S3 add-on (AWS ingest) or the LogServ Azure add-on (Azure ingest) on each HF; Splunk Cloud admin handles the indexer tier (Data TA installed there provides the index defs) |
| Splunk Cloud Search Head only (no on-prem ingest tier) | App prereqs only — your Splunk Cloud admin handles the data tier (including the AWS S3 add-on for AWS ingest or the LogServ Azure add-on for Azure ingest) and the indexer tier separately |

## :material-circle-box:{ .cboxmove } Next Steps

- [Quick Install Reference](quick-install-reference.md) — single-page matrix mapping every Splunkbase add-on + LogServ component to the tier(s) where each gets installed
- [Data TA Prerequisites](../install-setup/prerequisites.md) — for the data collection tier
- [LogServ App Prerequisites](../logserv-app/prerequisites.md) — for the dashboards + AI Assistant tier
- On a single-instance deployment the Data TA auto-creates the SAP data + AI Assistant audit indexes on first install; on distributed / indexer-cluster / Splunk Cloud deployments you create them on the indexer tier. No separate Index App is required. See [Create the indexes](../install-setup/install-ta.md#1-create-the-indexes).
- [Architecture](architecture.md) — full topology overview
