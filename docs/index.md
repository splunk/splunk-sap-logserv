# About Splunk for SAP LogServ

!!! info "The published package is the templates-only AI Assistant build"
    The released v0.1.1 App is the **templates-only build variant**: the AI Assistant's predefined-prompt path — the prompt catalog, MCP dispatch, result tiles, drill-down chips, and audit log — is fully active, and the **free-form / LLM-driven path is disabled at compile time** (no vendor call is possible, and the Settings toggle for it is hidden). A separately-built **full-LLM variant** of the same source (Anthropic / OpenAI / Azure OpenAI / AWS Bedrock synthesis, governed by the [privacy tiers](content/ai-assistant/privacy-tiers.md) and the [OWASP LLM Top 10 controls](content/ai-assistant/owasp-llm-compliance.md)) exists for approved deployments. See [Build Variants](content/ai-assistant/templates-only-build.md).

## :material-circle-box:{ .cboxmove } Introduction

SAP offers its customers ECS (fka RISE) with SAP S/4HANA Cloud Private Edition. This is an IaaS model (on a very basic level) from SAP's vendor perspective, where SAP hosts customers' SAP S/4HANA and other SAP systems in the customer's choice of public cloud providers (AWS, Microsoft Azure, GCP, etc.), in accounts owned and managed by SAP itself. <a href="https://blog.sap-press.com/cybersecurity-for-rise-with-sap" target="_blank">SAP LogServ</a> provides logs from all SAP systems and layers (OS, database, etc.), and the logs can be integrated to be available to the customer's security information and event management (SIEM) solution.

**Splunk for SAP LogServ** provides multiple mechanisms to access the logs from LogServ, ingest them into Splunk, and map the various log types to Splunk sourcetypes — plus a React-based UI App with a full dashboard suite, a graph-based Environment Topology view, a built-in missing-data diagnostic (the **LogServ Data Doctor**), and an AI Assistant that lets analysts run cataloged investigations without leaving Splunk.

## :material-circle-box:{ .cboxmove } Two Packages

The solution is delivered as **two core packages** (plus a dedicated cloud ingest add-on for Azure or GCP deployments):

| Package | App ID | Install On | Role |
|---------|--------|------------|------|
| **Data TA** | `splunk_ta_sap_logserv` | Deployment Server, Heavy Forwarders, Indexer (or single instance) | Data collection, sourcetype routing, index-time filtering, DS automation, ships the `indexes.conf` for `sap_logserv_logs` + `logserv_ai_assistant_audit` |
| **LogServ App** | `splunk_app_sap_logserv` | Search Head only (or single instance) | Dashboards, AI Assistant, Environment Topology view, search-time extractions |

The **Data TA** ingests log data, routes it to the right sourcetype, and ships the `indexes.conf` for both the SAP data index (`sap_logserv_logs`) and the AI Assistant audit index (`logserv_ai_assistant_audit`) — Splunk auto-creates them when the Data TA loads on an indexer, no separate Index App required. The **LogServ App** provides the analytics layer the user interacts with. Both index names are configurable via search macros (`sap_logserv_idx_macro`, `sap_logserv_audit_idx_macro`).

For deployments where SAP ECS data lands in **Azure Blob Storage**, a first-party **LogServ Azure add-on** (`splunk_ta_sap_logserv_azure`) provides queue-based Blob ingest on the Heavy Forwarder tier — the Azure counterpart to the Splunk Add-on for AWS, shipped alongside the two packages above. See the [Azure Setup Guide](content/install-setup/azure-setup.md). For **Google Cloud Storage** deployments, the first-party **LogServ GCP add-on** (`splunk_ta_sap_logserv_gcp`) fills the same role — Pub/Sub-notification-driven GCS ingest, per Heavy Forwarder. See the [GCP Setup Guide](content/install-setup/gcp-setup.md).

For details on which package goes where, see [Architecture](content/getting-started/architecture.md).

## :material-circle-box:{ .cboxmove } Key Features

- **Multi-cloud ingest** — supports **AWS S3** (via the Splunk Add-on for AWS), **Microsoft Azure Blob Storage** (via the first-party **LogServ Azure add-on**, `splunk_ta_sap_logserv_azure`), and **Google Cloud Storage** (via the first-party **LogServ GCP add-on**, `splunk_ta_sap_logserv_gcp`) — the cloud add-ons install per Heavy Forwarder. Same downstream sourcetypes, dashboards, ES integration, and AI Assistant regardless of ingest channel. Events are attributed per ingest channel: the Azure and GCP add-ons stamp an indexed `cloud_provider` field on their own inputs, the Data TA's Configuration → Cloud Provider dropdown can stamp it for AWS or TA-wide, and unstamped events default to `aws` at search time. The **Multi-Cloud Overview** dashboard surfaces the per-provider split. See the [Azure Setup Guide](content/install-setup/azure-setup.md) and the [GCP Setup Guide](content/install-setup/gcp-setup.md).
- **Index-time filtering** — control which log types are indexed and drop stale data, all configured through Splunk Web with zero license cost for filtered events.
- **Deployment Server automation** — automatically stages filter configurations for distribution to Heavy Forwarders with a one-click deploy button.
- **A full React dashboard suite** — one top-level **Environment Health** landing page plus four purpose-driven navigation groups: **Applications** (ABAP runtime, work-process performance, HANA audit + trace), **Integration** (SAP Services, Router, Cloud Connector, Web Dispatcher, Web/API Performance), **Security** (Network Perimeter, Cross-Stack Authentication, Change & Configuration), and **Platform** (Data Pipeline Overview, DNS, Linux, Windows, Proxy, the multi-tab Host Details view, Multi-Cloud Overview, and the Diagnostics page). Every dashboard ships with cross-dashboard drill-downs (time range preserved), a per-dashboard auto-refresh picker, light/dark themes, and PNG/PDF export via the nav-bar **Actions** menu. Dashboards read an hourly KV-Store rollup layer for fast loads at any data volume, with sub-90-minute ranges answered from raw events automatically — see [Performance & Data Freshness](content/logserv-app/dashboards/performance.md).
- **Environment Topology** — interactive graph view of SAP systems, integration partners, and endpoints; built on `@xyflow/react` with self-derived IP→SID inventory, per-node/per-edge detail tabs, and saved layouts (KV Store). Hourly KV Store refresh via scheduled saved searches plus a manual Refresh button.
- **LogServ Data Doctor** — a built-in missing-data diagnostic: every empty panel explains why, a per-panel/per-dashboard/environment-wide diagnosis produces a downloadable, support-ready PDF report, and the **Diagnostics** page gives every user (no admin role needed) a live view of rollup health, sourcetype presence, and platform load. See [Data Doctor](content/logserv-app/dashboards/platform/diagnostics.md).
- **Splunk Enterprise Security integration** — out-of-the-box CIM tagging across the Authentication / Change / Network_Sessions / Web data models; a correlation-search content pack (SAP-specific threat patterns such as HANA privilege escalation, cross-stack auth-failure bursts, ABAP gateway anomalous peers, threat-intel matches, and behavioral anomalies) that emits notable events with RBA risk annotations; a Risk Notable that fires on accumulated risk; and an auto-feed of SAP system inventory + user identities into ES Identity Management. Dual-mode: works with or without ES installed (the searches no-op harmlessly without it). See [Enterprise Security Integration](content/enterprise-security/overview.md).
- **AI Assistant** — a Splunk-aware assistant panel. The published package activates the **predefined-prompt** path: a catalog of saved searches across the SAP Basis / Security / Operations packs, dispatched via the [Splunk MCP Server](https://splunkbase.splunk.com/app/7931) with **no LLM call** and rendered as result tiles with guidance cards and drill-down chips. The separately-built **full-LLM variant** adds a free-form prompt path with vendor-LLM synthesis, governed by privacy tiers (Tier 0 air-gapped — planned; Tier 1 default; Tier 2 admin opt-in) and a type-system-enforced invariant: **no event data from your Splunk instance is ever transmitted to any AI vendor.**
- **OWASP LLM Top 10 (2025) controls** (full-LLM variant) — every item in the top-10 has a matching control: prompt-injection sanitization, type-bounded data redaction, supply-chain SBOM, per-event SHA-256 payload/prompt hashing, per-user rate limit, USD spend cap, SPL static-analysis guard, jailbreak pattern detection, PII redaction, and a tamper-evident audit log forwarder over HEC (the audit log + forwarder are live in both variants).
- **Templates-only build variant** — the **published package**: the LLM-driven flow is disabled at compile time while the MCP path + prompt catalog stay fully active, so the solution runs end-to-end without any LLM provider. See [Build Variants](content/ai-assistant/templates-only-build.md).
- **Search-time field extractions** — a comprehensive extraction layer (EXTRACT / EVAL / FIELDALIAS) across every supported sourcetype: the SAP-specific types plus the absorbed Linux, ISC BIND, and Squid parsers.

|             |                                                                                                                                                                        |
|-------------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Version     | 0.1.1                                                                                                                                                           |
| Supported vendor products     | SAP LogServ for SAP ECS in Amazon Web Services (AWS), Microsoft Azure, and Google Cloud Platform (GCP)                                                                    |
| Splunk platform versions | 9.4.3 and later |
| CIM | 5.0.0 and later |

![Environment Topology](images/dashboard-environment-topology.png "Environment Topology Dashboard")

<br>

![Environment Health](images/dashboard-environment-health.png "Environment Health Dashboard — default landing page")

