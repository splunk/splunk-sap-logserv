# Install the App and Seed the Dashboards

Use this page to install the **LogServ App** (`splunk_app_sap_logserv`, shown in Splunk Web as **Splunk App for SAP LogServ**) on your search tier, check that it sees your data, and fill the dashboards with the history your index already holds. It covers the last steps of the [Deployment Roadmap](../getting-started/roadmap.md).

!!! info "Before you start"
    - Events are arriving in your SAP data index and are routed to their sourcetypes: you have completed [Verify Your Data](../getting-started/verify-data.md).
    - The search tier meets the [LogServ App Prerequisites](prerequisites.md). KV Store must be enabled; it is by default.
    - You can sign in as a user that holds a role named exactly `admin`, `sc_admin` or `sc_subadmin`. Only these roles see the App's **Settings** page, where step 8 runs.

    Upgrading an existing install? Follow [Upgrading to This Release](../getting-started/upgrading.md) instead. It lists the Dashboard Data rows each upgrade must rebuild.

### :material-circle-box:{ .taiconcolor } About the LogServ App

The LogServ App provides:

- **The dashboards and the Environment Topology view**: one **Environment Health** landing page and four groups (Applications, Integration, Security, Platform). See the [Dashboards Overview](dashboards/index.md).
- **The Data Doctor** (**Platform → Diagnostics**), which explains empty panels and checks the health of the whole install. See [Data Doctor (Diagnostics)](dashboards/platform/diagnostics.md).
- **Search-time field extractions** (EXTRACT / EVAL / FIELDALIAS) for every SAP-specific sourcetype the Data TA routes, and the **`sap_logserv_idx_macro`** macro that points the dashboards at your SAP data index.
- **Enterprise Security content**: correlation searches, asset and identity feeds and anomaly searches. See [Enterprise Security Integration](../enterprise-security/overview.md).
- **An AI Assistant panel**, which ships disabled. It is optional; see step 9.

The LogServ App contains no Python code, no REST handlers and no data inputs. The published package is the full-LLM build; to keep the AI Assistant to predefined prompts only, see [Restricting the LLM Path](../ai-assistant/templates-only-build.md).

### :material-circle-box:{ .taiconcolor } Steps

1. Choose where to install
2. Install the search-tier add-ons
3. Download the LogServ App
4. Install the LogServ App
5. Update the index macro (only if your index is not `sap_logserv_logs`)
6. Open the App and check that it sees your data
7. Run the first health check
8. Seed the dashboards: the Dashboard Data backfill
9. Optional: set up the AI Assistant

<br>

### :material-circle-box:{ .taiconcolor } 1. Where to install

Install the LogServ App on the search tier only:

- **Single Splunk instance**: on that instance, next to the Data TA. Splunk merges the two apps' configurations at runtime.
- **Splunk Enterprise with a separate search tier**: on the search head, or on every member of a search head cluster through its deployer (step 4).
- **Splunk Cloud Platform**: on the Splunk Cloud search head.

Never install the LogServ App on heavy forwarders, indexers or the Deployment Server. For where every package goes, see [Where Each Package Goes](../getting-started/package-placement.md#package-matrix).

### :material-circle-box:{ .taiconcolor } 2. Install the search-tier add-ons

Install these Splunkbase add-ons on the same search tier as the App (each search head, the cluster members through the deployer, or the Splunk Cloud search head):

| Add-on | Why the App needs it |
|---|---|
| <a href="https://splunkbase.splunk.com/app/1621" target="_blank">Splunk Common Information Model</a> (`Splunk_SA_CIM`, Splunkbase 1621), version 5.0.0 or later | The App declares it as its dependency. The App's CIM tags and its Enterprise Security content use the CIM data models. |
| <a href="https://splunkbase.splunk.com/app/742" target="_blank">Splunk Add-on for Microsoft Windows</a> (Splunkbase 742) | It extracts the Windows event fields, such as the event code and severity. No LogServ package extracts them, so without it the Windows panels stay empty. |
| <a href="https://splunkbase.splunk.com/app/833" target="_blank">Splunk Add-on for Unix and Linux</a> (Splunkbase 833) | It provides the CIM and Enterprise Security fields of `linux_secure`, which the App does not extract. The App parses its other Linux sourcetypes itself, and its dashboards read `linux_secure` from the raw event text, so they work without it. |

The Squid Proxy and ISC BIND add-ons are not needed: the App includes their parsing. The Splunk MCP Server is needed only for the AI Assistant (step 9). Details: [LogServ App Prerequisites](prerequisites.md).

### :material-circle-box:{ .taiconcolor } 3. Download the LogServ App

Download `splunk_app_sap_logserv-0.1.2.tar.gz` from the <a href="https://github.com/splunk/splunk-sap-logserv/tree/main/release_binaries" target="_blank">GitHub repository</a>.

### :material-circle-box:{ .taiconcolor } 4. Install the LogServ App

Use the procedure for your platform.

#### :material-crop-square:{ .taiconcolor } Splunk Cloud Platform

Install the LogServ App as a private app on your Splunk Cloud search head. You do not use a deployer on Splunk Cloud Platform.

!!! note
    The app installation workflow available to you in Splunk Web depends on your Splunk Cloud Platform Experience: **Victoria** or **Classic**. To find your Splunk Cloud Platform Experience, in Splunk Web, click **Support & Services > About**.

- <a href="https://help.splunk.com/en/splunk-cloud-platform/administer/admin-manual/9.3.2411/manage-apps-and-add-ons-in-splunk-cloud-platform/manage-private-apps-on-your-splunk-cloud-platform-deployment#e86cbd1a_f4ec_4256_9299_f2c56c9842ad__Install_a_private_app_on_Classic_Experience" target="_blank">Installation instructions for Classic Experience</a>
- <a href="https://help.splunk.com/en/splunk-cloud-platform/administer/admin-manual/9.3.2411/manage-apps-and-add-ons-in-splunk-cloud-platform/manage-private-apps-on-your-splunk-cloud-platform-deployment#b5f810d7_e842_487d_b752_3662cfb646bc__Install_a_private_app_on_Victoria_Experience" target="_blank">Installation instructions for Victoria Experience</a>

For the roles and capabilities a Splunk Cloud admin needs, see [Splunk Cloud Considerations](../getting-started/splunk-cloud.md).

#### :material-crop-square:{ .taiconcolor } Splunk Enterprise: single instance or standalone search head

1. From the Splunk Web home screen, click the gear icon next to **Apps**.
2. Click **Install app from file**.
3. Select the downloaded `splunk_app_sap_logserv-0.1.2.tar.gz` file and click **Upload**.
4. If Splunk Enterprise prompts you to restart, do so.
5. Check that the app appears in the list of apps. On the server it is at `$SPLUNK_HOME/etc/apps/splunk_app_sap_logserv`.

#### :material-crop-square:{ .taiconcolor } Splunk Enterprise: search head cluster

Distribute the App, and the add-ons of step 2, with the cluster's deployer. Do not install them on the members one by one.

1. On the deployer, extract the tarball into `$SPLUNK_HOME/etc/shcluster/apps/`, so that the App is at `$SPLUNK_HOME/etc/shcluster/apps/splunk_app_sap_logserv`.
2. On the deployer, push the bundle to the cluster:

    ```bash
    $SPLUNK_HOME/bin/splunk apply shcluster-bundle -target https://<any-member>:8089
    ```

3. Wait for the members to finish the restart the push starts, if it needs one.

The cluster's captain runs each scheduled search on one member, and KV Store replicates the App's collections to every member, so you run the backfill of step 8 once, from any member. See [Behavior with multiple search heads](dashboard-data.md#behavior-with-multiple-search-heads).

### :material-circle-box:{ .taiconcolor } 5. Update the index macro

Skip this step if your SAP data index is `sap_logserv_logs`.

The dashboards find your data through the search macro `sap_logserv_idx_macro`. Both the LogServ App and the Data TA ship this macro. On a search head that has both apps, such as a single instance or a Splunk Cloud stack with the Data TA, change it in **both** apps: the scheduled rollups and the Dashboard Data backfill use the App's copy, while the live dashboard panels can use the Data TA's copy. On a search head without the Data TA, change the App's copy.

Follow the single procedure in [Renaming an Index](../install-setup/install-ta.md#renaming-an-index), then check the result in step 6.

### :material-circle-box:{ .taiconcolor } 6. Open the App and check that it sees your data

1. In Splunk Web, open **Splunk App for SAP LogServ**. It opens on **Environment Health**, with a navigation rail on the left: **Environment Health**, **Topology**, **Applications**, **Integration**, **Security**, **Platform**, and below a divider **Settings** (admin roles only) and **About**. The [Dashboards Overview](dashboards/index.md) describes the rail, the header and the controls every dashboard shares.
2. In the Search app, run:

    ```
    `sap_logserv_idx_macro` | stats count by sourcetype
    ```

    It must return events from your SAP data index, split across the SAP sourcetypes.

If the search returns nothing:

- Check that events are arriving: [Verify Your Data](../getting-started/verify-data.md). The Data TA parses and routes the events where the inputs run (your heavy forwarders, a single instance, or a Splunk Cloud stack that runs the inputs itself); your cloud's ingest add-on collects them.
- Check that the macro points at your index (step 5).
- Check that your role can search the index. On Splunk Enterprise the stock `user` role allows `*`, which matches every index whose name does not start with `_`, so a user who holds that role, or a role that imports it, can already search your SAP data index. A role with a narrowed list of allowed indexes (**Settings → Roles →** *role* **→ Indexes**) needs your SAP data index added.

### :material-circle-box:{ .taiconcolor } 7. Run the first health check

Open **Platform → Diagnostics** and let its checks finish. Confirm that the summary names your SAP data index and the add-ons of step 2, then click **Download report (PDF)** and keep the report as the install's starting point. On a fresh install the **History** column reads **NEVER BUILT**, or **INCOMPLETE** once the first hourly run has written an hour or two; that is expected until step 8.

Details: [First health check after install](dashboards/platform/diagnostics.md#first-health-check-after-install).

### :material-circle-box:{ .taiconcolor } 8. Seed the dashboards: the Dashboard Data backfill

Most dashboard panels read hourly rollups that start empty. Without a backfill they fill in one hour at a time from the next hourly run, so any install whose index already holds events needs this step: events loaded with AWS S3 Direct, ingest that ran before the App was installed, or a few days of normal arrival.

1. Sign in as a user with a role named `admin`, `sc_admin` or `sc_subadmin`.
2. Open **Settings → Dashboard Data**.
3. In **Backfill window**, pick a window that covers the history your index holds: **30 days** is the default; **60**, **90**, **180** and **365 days** and a **Custom range** of whole UTC days, back to the 365-day retention, are also offered. After an AWS S3 Direct load, use a custom range that matches the dates you loaded.
4. Click **Run backfill**. Start it outside the nightly retention window (00:34-00:58, 01:30-01:58 and 02:34-02:36 in the search head's time zone), and keep the page open until every row has finished.
5. Go back to **Platform → Diagnostics** and click **Re-run checks**. A row reads **COMPLETE** once its rollup holds data reaching back at least 29 days, so it needs events of that rollup's log types at least that old in your index. A row whose log types you do not collect stays **NEVER BUILT**, and a row with less history in the index reads **INCOMPLETE**; neither means the backfill failed. If the backfill finishes with issues, **Settings → Dashboard Data** says so and marks the affected rollups in its table: run the backfill again to retry them.

Details, including the late-arriving data check: [Dashboard Data: Backfill and Freshness](dashboard-data.md#backfilling-on-first-install).

!!! note "Enterprise Security content runs by default"
    The App's 22 Enterprise Security searches (`splunk_sap_logserv_es_*`) ship enabled and run on this search head whether or not Enterprise Security is installed. If this search head has no Enterprise Security, consider turning them off: see [Disabling or tuning the ES content](../enterprise-security/overview.md#disabling-or-tuning-the-es-content). The AI Assistant's Security prompts run 13 of these searches on demand, so if you use those prompts, turn off only the schedules of those 13, as that section describes.

### :material-circle-box:{ .taiconcolor } 9. Optional: set up the AI Assistant

The AI Assistant ships disabled: no button, panel or route appears until an admin turns it on. To use it:

- Install the <a href="https://splunkbase.splunk.com/app/7931" target="_blank">Splunk MCP Server (Splunkbase App 7931)</a> **1.1.0 or later** on the same search head as the LogServ App; **1.2.1 or later** is recommended, because it fixes SVD-2026-1004. The predefined prompts run through the MCP Server's Run Saved Search tool, which first shipped in 1.1.0. The App's health check only refuses versions below 1.0.3 (the CVE-2026-20205 fix), so 1.0.3 to 1.0.5 pass that check but the predefined prompts fail. There is no upper version limit. Installation and authentication: [Splunk MCP Setup](../ai-assistant/mcp-setup.md).
- Grant the MCP Server's `mcp_tool_execute` capability to every role that will use the AI Assistant. The MCP Server (version 1.1.0) grants it only to `admin` and `sc_admin`. See [Roles and Capabilities](../ai-assistant/mcp-setup.md#roles-and-capabilities).
- As an admin, open **Settings → AI Assistant → General**, turn on **Enable AI Assistant** and click **Save Defaults**. Accept the **AI Assistant — Liability terms** dialog that opens and, while audit forwarding is off (the default), the **Audit log integrity** dialog after it; nothing is saved until you do. The liability dialog appears every time the AI Assistant is turned on, and again when its terms change. The **AI Assistant** button then appears at the right end of the header's second row.

If the panel opens a setup wizard instead of the chat, the MCP Server is missing or older than the App accepts, or your role lacks `mcp_tool_execute`: see [Splunk MCP Setup](../ai-assistant/mcp-setup.md).

The predefined prompts need no LLM provider credential. The shipped default provider is **Mock**: until an admin selects a provider and stores its credential, a typed question gets a canned mock reply and no vendor is contacted.

Full procedure: [Set Up the AI Assistant](../ai-assistant/enable.md).

## :material-circle-box:{ .cboxmove } Next Steps

- Explore the dashboards: [Dashboards Overview](dashboards/index.md).
- Keep the dashboards current and rebuild late-arriving days: [Dashboard Data: Backfill and Freshness](dashboard-data.md).
- Change what is filtered at ingest: [Configuring Filters](../install-setup/configure-filters.md).
- Turn on the AI Assistant: [Set Up the AI Assistant](../ai-assistant/enable.md).
- Something does not look right: [Troubleshooting](../getting-started/troubleshooting.md).
