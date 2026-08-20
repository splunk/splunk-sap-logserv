# LogServ App Prerequisites

This page covers the prerequisites for the **LogServ App** (`splunk_app_sap_logserv`) — the React-based UI App that ships dashboards + the AI Assistant panel. The Search Head also needs the CIM-mapping add-ons listed below; for the ingest tier's prerequisites, see [Data TA Prerequisites](../install-setup/prerequisites.md). The SAP data + AI Assistant audit indexes are auto-created by the Data TA on a single-instance deployment, or created on the indexer tier for distributed / indexer-cluster / Splunk Cloud deployments — see [Create the indexes](../install-setup/install-ta.md#1-create-the-indexes).

### :material-circle-box:{ .taiconcolor } Splunk Platform Requirements

- **Splunk Enterprise** 9.4.3 or later, or **Splunk Cloud Platform**
- The LogServ App ships as a single React bundle and uses `@splunk/react-ui` + `@splunk/visualizations` + `@xyflow/react`. Splunk 9.4.3 is the platform baseline this release is built and tested against.

### :material-circle-box:{ .taiconcolor } Required Splunk Add-ons (Search Head)

- <a href="https://splunkbase.splunk.com/app/1621" target="_blank">Splunk Common Information Model (Splunk_SA_CIM, Splunkbase 1621)</a> **version 5.0.0 or later** — a **declared hard dependency** in the App's `app.manifest`. The App's CIM event tagging participates in the Authentication / Change / Network Sessions / Web data models, and the Enterprise Security content builds on it. Free on Splunkbase (and bundled with Enterprise Security).
- <a href="https://splunkbase.splunk.com/app/833" target="_blank">Splunk Add-on for Unix and Linux (833)</a> and <a href="https://splunkbase.splunk.com/app/742" target="_blank">Splunk Add-on for Microsoft Windows (742)</a> — search-time parsing for the OS-level sourcetypes the dashboards consume (without 742 the Windows dashboard's EventCode/severity panels render empty). Search-Head tier only.

The Squid Proxy and ISC BIND add-ons are **not** required — their parsing is absorbed into the LogServ App.

### :material-circle-box:{ .taiconcolor } AI Assistant Prerequisites

The LogServ App includes a built-in **AI Assistant** panel that dispatches predefined prompts (saved searches) against your data via the Splunk MCP Server. To use it, install:

- <a href="https://splunkbase.splunk.com/app/7931" target="_blank">Splunk MCP Server (Splunkbase App 7931)</a> — v1.1.0 or later is the version this release is tested against (the App's version gate accepts 1.0.3 up to, but not including, 2.0.0).

Install on the same Search Head as the LogServ App. Cookie auth from the same Splunk Web session works by default; no bearer token required for HTTP-only Splunk (on Splunk Cloud Victoria, see the JWT-audience note in [Splunk MCP Setup](../ai-assistant/mcp-setup.md)).

**The AI Assistant ships disabled.** After installing the App and the MCP Server, an admin must turn it on at **Settings → AI Assistant → General → Enable AI Assistant** (an acknowledgement modal gates the first enable); only then does the `✦ AI Assistant` button appear in the nav bar.

#### Recommended companion app

- <a href="https://splunkbase.splunk.com/app/200" target="_blank">Splunk AI Assistant (Splunkbase App 200)</a>

The Splunk AI Assistant is **not a strict prerequisite** for the LogServ App's AI Assistant — the LogServ App uses only the core `splunk_run_saved_search` and `splunk_run_query` MCP tools, which work standalone against the Splunk MCP Server. However, App 200 is the typical co-install for the Splunk MCP Server (per Splunk's documented setup pattern), and installing it alongside avoids friction if a future LogServ release calls the additional MCP tools it unlocks.

!!! note "The published package needs no AI provider credentials"
    The published App package is the **templates-only build variant**: the LLM-driven path is disabled at compile time, and the predefined-prompt path (which dispatches saved searches via the Splunk MCP Server) is the AI Assistant. It does **not** call any LLM provider — **you do not need an Anthropic / OpenAI / Azure / Bedrock credential.** In the separately-built full-LLM variant used in approved deployments, the **Settings → AI Assistant → Provider Credentials** sub-tab becomes visible and one provider credential is required for the free-form chat input. See [Build Variants](../ai-assistant/templates-only-build.md).

## :material-circle-box:{ .cboxmove } Next Steps

- [Install the LogServ App](installation.md)
