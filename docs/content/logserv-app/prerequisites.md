# LogServ App Prerequisites

This page covers the prerequisites for the **LogServ App** (`splunk_app_sap_logserv`) — the React-based UI App that ships dashboards + the AI Assistant chat panel. For the Data TA's prerequisites (CIM add-ons), see [Data TA Prerequisites](../install-setup/prerequisites.md). The SAP data + AI Assistant audit indexes are auto-created by the Data TA when it installs on the indexer — see [Indexes (auto-created on install)](../install-setup/install-ta.md#1-indexes-auto-created-on-install).

### :material-circle-box:{ .taiconcolor } Splunk Platform Requirements

- **Splunk Enterprise** 9.4.3 or later, or **Splunk Cloud Platform**
- The LogServ App ships as a single React bundle and uses `@splunk/react-ui` + `@splunk/visualizations` + `@xyflow/react`. Splunk 9.4.3+ is the minimum for the React component versions used.

### :material-circle-box:{ .taiconcolor } AI Assistant Prerequisites

The LogServ App includes a built-in **AI Assistant** chat panel that dispatches predefined prompts (saved searches) against your data via the Splunk MCP Server. To use the AI Assistant — even with the LLM-driven path disabled in the current release — install:

- <a href="https://splunkbase.splunk.com/app/7931" target="_blank">Splunk MCP Server (Splunkbase App 7931)</a> v1.1.0 or later

Install on the same Search Head as the LogServ App. Cookie auth from the same Splunk Web session works by default; no bearer token required for HTTP-only Splunk. See [Splunk MCP Setup](../ai-assistant/mcp-setup.md) for full configuration.

#### Recommended companion app

- <a href="https://splunkbase.splunk.com/app/200" target="_blank">Splunk AI Assistant (Splunkbase App 200)</a>

The Splunk AI Assistant is **not a strict prerequisite** for the LogServ App's AI Assistant — the LogServ App uses only the core `splunk_run_saved_search` and `splunk_run_query` MCP tools, which work standalone against the Splunk MCP Server. However, App 200 is the typical co-install for the Splunk MCP Server and unlocks additional `saia_*`-prefixed MCP tools (e.g., SPL optimization helpers) that may be used in future LogServ releases. If you're already deploying the Splunk MCP Server, installing App 200 alongside it follows Splunk's documented setup pattern and avoids friction if a future LogServ release calls those tools.

!!! note "Current release: AI provider credentials are NOT required"
    The current release ships with the LLM-driven path **disabled at compile time pending internal review**. The predefined-prompt path (which dispatches saved searches via the Splunk MCP Server) is the only AI Assistant path active in the current release, and it does NOT call any LLM provider. **You do not need to configure an Anthropic / OpenAI / Azure / Bedrock credential to use the AI Assistant in the current release.** When the LLM-driven path is re-enabled in a future release, the Settings → Provider Credentials tab will become visible and one provider credential will be required for the free-form chat input. See [Templates-only Build](../ai-assistant/templates-only-build.md).

## :material-circle-box:{ .cboxmove } Next Steps

- [Install the LogServ App](installation.md)
