# Installing the LogServ App

This page covers installing the **LogServ App** (`splunk_app_sap_logserv`). For the Data TA installation, see [Installing the Data TA](../install-setup/install-ta.md).

!!! warning "The published package is the templates-only build variant"
    The published LogServ App tarball is the **templates-only build variant**: the AI Assistant's free-form / LLM-driven path is disabled at compile time. The predefined-prompt path + Splunk MCP Server integration + tool tiles + drill-down chips + audit log + the full dashboard set + the Environment Topology view are all fully active. The free-form chat input, the model picker, the Power Mode toggle, and the Provider Credentials Settings sub-tab are hidden. A **full-LLM variant** of the identical build exists for approved deployments but is not the published artifact. See [Build Variants](../ai-assistant/templates-only-build.md) for the mechanism.

!!! warning "Upgrading an existing install"
    Installing this tarball **over a full-LLM v0.1.1 deployment disables free-form chat** — the compile-time flag forces templates-only mode at every point the setting is read, so a stored `templates_only_mode = 0` (KV Store or `local/` conf) cannot re-enable it. All other `local/` configuration and KV-Store data survive the upgrade. Coming from a pre-rollup build, run **Settings → Dashboard Data → Run backfill** afterwards — see [Upgrading to this release](../getting-started/upgrading.md).

### :material-circle-box:{ .taiconcolor } About the LogServ App

The LogServ App provides:

- **A full set of React-based dashboards** plus the **Environment Topology** view, organized as one top-level **Environment Health** landing page + four purpose-driven groups (Applications, Integration, Security, Platform). Built on `@splunk/react-ui` + `@splunk/visualizations` + `@xyflow/react`. See [Dashboards Overview](dashboards/index.md).
- **Built-in AI Assistant panel** — predefined prompts + Splunk MCP integration + audit log (the published package is the templates-only variant; the LLM-driven path is compile-time disabled). See [AI Assistant Overview](../ai-assistant/overview.md).
- **Search-time field extractions** (EXTRACT / EVAL / FIELDALIAS) for every SAP-specific sourcetype the Data TA routes.
- **The `sap_logserv_idx_macro` macro** for searching the LogServ index.
- **Actions menu** on every dashboard — Download PNG, Download PDF (full-canvas captures), Diagnose dashboard (PDF), and Environment report (PDF).
- **Per-dashboard auto-refresh picker** (Never / 30s / 1m / 5m / 15m / 30m / 1hr) with per-user-per-dashboard cadence persisted via Splunk KV Store.

The LogServ App contains no Python code, no REST handlers, and no data collection components. It is a React-based app focused entirely on the search-time experience and AI Assistant chat surface.

### :material-circle-box:{ .taiconcolor } High Level Steps

Below are the high level steps for installing the LogServ App. Follow them in order.

:material-lightning-bolt:{ .taiconcolor } Steps 4 and 5 are alternative paths — complete the one that matches your Splunk environment.

1. Identify where to install the LogServ App based on your topology
2. Install the Splunk MCP Server prerequisite (for AI Assistant)
3. Download the LogServ App
4. Install the LogServ App in Splunk Cloud (if applicable)
5. Install the LogServ App in Splunk Enterprise (if applicable)
6. Verify the installation
7. Update the index macro (if using a custom index name)

<br>

### :material-circle-box:{ .taiconcolor } 1. Where to install

| Your Topology | Install the LogServ App On |
|---------------|--------------------------|
| **Single instance** | The single Splunk instance (alongside the Data TA) |
| **Distributed with on-prem SH** | The Search Head only |
| **Distributed with Splunk Cloud** | The Splunk Cloud Search Head only |

!!! warning "Important"
    - The LogServ App is **never** installed on Heavy Forwarders or the Deployment Server.
    - For single-instance deployments, install both the Data TA and the LogServ App on the same instance. Splunk merges their configurations at runtime.

### :material-circle-box:{ .taiconcolor } 2. Install the Splunk MCP Server prerequisite

The AI Assistant requires the [Splunk MCP Server (Splunkbase App 7931)](https://splunkbase.splunk.com/app/7931) — v1.1.0 or later (the tested-against version; the App's version gate accepts 1.0.3 up to, but not including, 2.0.0) — installed on the **same Search Head** as the LogServ App. Install it via Splunk Web (**Apps → Install app from file**) or via CLI:

```bash
/opt/splunk/bin/splunk install app /path/to/<splunk-mcp-server-download>.tar.gz
```

After install, restart Splunkd. Cookie auth from the same Splunk Web session works by default; no bearer token configuration required for HTTP-only Splunk. See [Splunk MCP Setup](../ai-assistant/mcp-setup.md) for full configuration including the optional bearer token for OAuth-strict environments.

!!! note "No AI provider credentials needed"
    The AI Assistant's predefined-prompt path requires the Splunk MCP Server to dispatch saved searches — install it. Do **not** configure any AI provider credential (Anthropic / OpenAI / Azure / Bedrock): the published package is the templates-only variant, the credentials are unused, and the Settings → AI Assistant → Provider Credentials sub-tab is hidden.

### :material-circle-box:{ .taiconcolor } 3. Download the LogServ App

Download `splunk_app_sap_logserv-0.1.1.tar.gz` from the <a href="https://github.com/splunk/splunk-sap-logserv/tree/main/release_binaries" target="_blank">GitHub repository</a>.

The published tarball is the **templates-only build variant** (LLM-driven path disabled at compile time pending review). There is no separate "regular" tarball published in the current release.

### :material-circle-box:{ .taiconcolor } 4. Install in Splunk Cloud

Install the LogServ App to your Splunk Cloud Search Head:

!!! note
    The app installation workflow available to you in Splunk Web depends on your Splunk Cloud Platform Experience: **Victoria** or **Classic**. To find your Splunk Cloud Platform Experience, in Splunk Web, click **Support & Services > About**.

#### :material-crop-square:{ .taiconcolor } Classic Experience

- <a href="https://help.splunk.com/en/splunk-cloud-platform/administer/admin-manual/9.3.2411/manage-apps-and-add-ons-in-splunk-cloud-platform/manage-private-apps-on-your-splunk-cloud-platform-deployment#e86cbd1a_f4ec_4256_9299_f2c56c9842ad__Install_a_private_app_on_Classic_Experience" target="_blank">Installation instructions for Classic Experience</a>

#### :material-crop-square:{ .taiconcolor } Victoria Experience

- <a href="https://help.splunk.com/en/splunk-cloud-platform/administer/admin-manual/9.3.2411/manage-apps-and-add-ons-in-splunk-cloud-platform/manage-private-apps-on-your-splunk-cloud-platform-deployment#b5f810d7_e842_487d_b752_3662cfb646bc__Install_a_private_app_on_Victoria_Experience" target="_blank">Installation instructions for Victoria Experience</a>

### :material-circle-box:{ .taiconcolor } 5. Install in Splunk Enterprise

Install the LogServ App to your Splunk Enterprise Search Head:

5.<b class="taiconcolor">a</b> From the Splunk Web home screen, click the gear icon next to Apps.

5.<b class="taiconcolor">b</b> Click Install app from file.

5.<b class="taiconcolor">c</b> Locate the downloaded `splunk_app_sap_logserv-0.1.1.tar.gz` file and click Upload.

5.<b class="taiconcolor">d</b> If Splunk Enterprise prompts you to restart, do so.

5.<b class="taiconcolor">e</b> Verify that the app appears in the list of apps. You can also find it on the server at `$SPLUNK_HOME/etc/apps/splunk_app_sap_logserv`.

### :material-circle-box:{ .taiconcolor } 6. Verify installation

After installation, navigate to the LogServ App in Splunk Web. You should see the navigation bar with:

- **Environment Health** (default landing page — cross-cutting operations view)
- **Topology** (graph-based Environment Topology view)
- **Applications** dropdown (ABAP Network & Security, ABAP Operations, Work Process Performance, HANA Audit, HANA Trace)
- **Integration** dropdown (SAP Services, SAP Router, Cloud Connector, Web Dispatcher, Web and API Performance)
- **Security** dropdown (Network Perimeter, Cross-Stack Authentication, Change & Configuration Activity)
- **Platform** dropdown (Data Pipeline Overview, DNS Analytics, Linux, Windows, Proxy, Host Details, Multi-Cloud Overview, Diagnostics)
- The theme toggle, global **Refresh** button, **About**, and **Settings** at the right end of the nav bar

The **`✦ AI Assistant`** button does **not** appear yet on a fresh install — the feature ships disabled. An admin enables it at **Settings → AI Assistant → General → Enable AI Assistant** (an acknowledgement modal gates the first enable); the button then appears in the top-right of the nav bar within a few seconds.

If the dashboards show no data, verify that:

6.<b class="taiconcolor">a</b> The Data TA is installed and collecting data on your Heavy Forwarders (or single instance)

6.<b class="taiconcolor">b</b> The `sap_logserv_idx_macro` resolves to the correct index name

6.<b class="taiconcolor">c</b> Events exist in the index: run `` `sap_logserv_idx_macro` | stats count by sourcetype `` in the Search app

6.<b class="taiconcolor">d</b> If the AI Assistant button shows a setup wizard instead of an empty chat panel, the [Splunk MCP Server](../ai-assistant/mcp-setup.md) prerequisite isn't healthy — re-check the install in Step 2.

### :material-circle-box:{ .taiconcolor } 7. Update the index macro

If you used a custom index name (not `sap_logserv_logs`), update the macro:

7.<b class="taiconcolor">a</b> In Splunk Web, go to **Settings > Advanced search > Search macros**

7.<b class="taiconcolor">b</b> Set the app context to **Splunk App for SAP LogServ**

7.<b class="taiconcolor">c</b> Find `sap_logserv_idx_macro` and update its definition to `index=<your_index_name>`

!!! tip "High-volume installs: seed dashboard history"
    The dashboards read from an hourly KV-Store rollup layer for performance. On a large environment, run the one-time backfill so dashboards show history immediately: open **Settings → Dashboard Data** and click **Run backfill**. Without it, rolled-up panels fill in one hour at a time from the next hourly aggregation. See [Dashboard Performance & Data Freshness](dashboards/performance.md).

!!! tip "First post-install check: open Platform → Diagnostics"
    Before looking at any dashboard, open **Platform → Diagnostics** and click **Download
    report (PDF)**. The page runs the whole environment health check — index visibility, every
    sourcetype's presence, all rollup collections, companion apps — and the report is the one
    artifact to attach if anything needs a support conversation. Paired with the Settings →
    Dashboard Data backfill above, these two screens answer "is this install healthy?" in one
    pass. See [Data Doctor (Diagnostics)](dashboards/platform/diagnostics.md).

## :material-circle-box:{ .cboxmove } Next Steps

- Explore the [Dashboards Overview](dashboards/index.md) to learn about the available dashboards
- Read [AI Assistant Overview](../ai-assistant/overview.md) to understand the chat panel + predefined-prompt path
- If you haven't yet, complete the [AWS Setup Guide](../install-setup/setup-guides.md) to configure data collection
