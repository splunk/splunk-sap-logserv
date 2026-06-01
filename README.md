# Splunk for SAP LogServ

A Splunk solution for SAP ECS log data — ingest, sourcetype routing, dashboards, and a Splunk-aware investigative assistant.

## What it is

Splunk for SAP LogServ ingests SAP log data from S3 (Linux, Windows, HANA, ABAP, SAP Cloud Connector, DNS, proxy, and SAP service-tier sources), normalizes it via sourcetype routing on the Heavy Forwarder tier, and surfaces it through 22 dashboards plus an AI Assistant chat panel for guided investigations against your data.

## Packages

The solution ships as **two separately installable Splunk packages** (pre-built tarballs in [`release_binaries/`](release_binaries/)):

| Package | App ID | Purpose |
|---------|--------|---------|
| **Data TA** | `splunk_ta_sap_logserv` | Data collection from S3, sourcetype routing, index-time filtering, Deployment-Server automation. Bundles `default/indexes.conf` defining `sap_logserv_logs` and `_ai_assistant_audit` so Splunk auto-creates both indexes on indexer install. |
| **LogServ App** | `splunk_app_sap_logserv` | 22 dashboards, AI Assistant chat panel, Environment Topology view, search-time field extractions. |

## Key features

- **48 predefined prompts** in three packs (SAP Basis / Security / Operations) plus a "Dashboard Focused" tab that auto-filters to prompts relevant to the dashboard you're viewing
- **AI Assistant chat panel** that dispatches saved searches via the Splunk MCP Server, renders results as tool-tiles in the right pane, and threads `↗ Dashboard` + `↗ Run SPL` drill-down chips back into the specialist dashboards or Splunk's universal Search app
- **22 dashboards** across Environment Health, Applications (ABAP / HANA), Integration (SAP Services / Router / Cloud Connector / Web Dispatcher), Security (Network Perimeter / Cross-Stack Authentication / Change & Configuration Activity), and Platform (Data Pipeline / DNS / Linux / Windows / Proxy / Host Details) categories
- **Environment Topology view** — graph visualization of inter-system traffic patterns with per-user saved layouts (Splunk KV Store-backed)
- **Index-time filtering** — control which log types are indexed via a Splunk Web UI on the Deployment Server (zero-license-cost drops for filtered events)
- **Deployment-Server automation** — stages filter configs to Heavy Forwarders with a one-click deploy button
- **Audit log** — every AI Assistant action recorded in the dedicated `_ai_assistant_audit` index, with an in-app browser and an optional HEC forwarder for tamper-evidence

## Documentation

Full documentation is published at:

> **<https://splunk.github.io/splunk-sap-logserv/>**

Recommended starting points:

- [Quick Install Reference](https://splunk.github.io/splunk-sap-logserv/content/getting-started/quick-install-reference/) — single-page matrix mapping every Splunkbase add-on + LogServ package to its install tier
- [Architecture](https://splunk.github.io/splunk-sap-logserv/content/getting-started/architecture/) — package split, install topologies, why-two-packages rationale
- [Installing the Data TA](https://splunk.github.io/splunk-sap-logserv/content/install-setup/install-ta/) — step-by-step including the indexer-tier rationale, Macros and Deployment Server behavior, and rename-an-index procedure
- [Installing the LogServ App](https://splunk.github.io/splunk-sap-logserv/content/logserv-app/installation/)
- [Configuring Filters](https://splunk.github.io/splunk-sap-logserv/content/install-setup/configure-filters/) — index-time filter rules + DS deploy guide
- [AI Assistant Overview](https://splunk.github.io/splunk-sap-logserv/content/ai-assistant/overview/)
- [Release Notes](https://splunk.github.io/splunk-sap-logserv/content/overview/release-notes/)

## Requirements

- **Splunk Enterprise 9.4.3 or later**, or **Splunk Cloud Platform**
- Splunkbase CIM add-ons (Search Head only): [Unix and Linux (833)](https://splunkbase.splunk.com/app/833), [Microsoft Windows (742)](https://splunkbase.splunk.com/app/742). The Squid Proxy and ISC BIND add-ons that were previously required are no longer needed — their parsing was absorbed natively into the LogServ App in v0.0.5.0 build 184.
- [Splunk Add-on for AWS (1876)](https://splunkbase.splunk.com/app/1876) — if SAP ECS data lives in AWS S3
- [Splunk MCP Server (7931)](https://splunkbase.splunk.com/app/7931) v1.1.0+ — required on the Search Head for the AI Assistant chat panel

See the [Quick Install Reference](https://splunk.github.io/splunk-sap-logserv/content/getting-started/quick-install-reference/) for which package goes on which tier in distributed topologies.

## About this release

This **v0.0.5.0** release ships the AI Assistant with the **predefined-prompt path only**. The free-form / LLM-driven flow is not present in this build — no external LLM provider is invoked, no event data is transmitted outside this Splunk deployment, and no AI-generated narrative is produced. The chat panel uses the Splunk MCP Server to dispatch saved searches; results render as tool-result tiles with drill-down chips into the specialist dashboards.

What this means in practice for an admin:

- The `✦ AI Assistant` button in the top nav opens the chat panel, but the chat input is read-only
- "Browse predefined prompts" is the entry point — pick one of the 48 cataloged prompts to dispatch a saved search via MCP
- The Provider Credentials Settings tab and the Power Mode toggle are hidden (they relate to the LLM-driven path that's not in this build)
- Every prompt dispatch + every administrative action is recorded in `_ai_assistant_audit`

## Building from source

The Data TA uses Splunk's UCC framework. The LogServ App is a React bundle built with Node 23 + yarn 1.22 + webpack. Build scripts:

- [`sap_logserv_package/build_logserv_ta.sh`](sap_logserv_package/build_logserv_ta.sh) — Data TA UCC build
- [`sap_logserv_package/build_logserv_app.sh`](sap_logserv_package/build_logserv_app.sh) — LogServ App webpack build

For routine installs, the pre-built tarballs in [`release_binaries/`](release_binaries/) are sufficient — no source rebuild required.

To preview the docs locally: `mkdocs serve` (requires `mkdocs`, `mkdocs-material`, `mkdocs-print-site-plugin`, `mkdocstrings[python]`, `mkdocs-autorefs`). Serves at `http://localhost:8000/splunk-sap-logserv/`.

## License

See [LICENSE](LICENSE) at the repository root.

## Project status

Pre-1.0 development release. Production deployments are supported on Splunk 9.4.3+. APIs and dashboard layouts may change between minor versions; see [Release Notes](https://splunk.github.io/splunk-sap-logserv/content/overview/release-notes/) for the change history.
