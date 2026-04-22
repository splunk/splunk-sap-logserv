# Installing the LogServ App

This page covers installing the **LogServ App** (`splunk_app_sap_logserv`). For the Data TA installation, see [Installing the Data TA](../install-setup/install-ta.md).

### :material-circle-box:{ .taiconcolor } About the LogServ App

The LogServ App provides:

- **Seventeen Dashboard Studio dashboards** for monitoring and analyzing SAP LogServ data
- **Search-time field extractions** for all SAP-specific sourcetypes (29 sourcetype stanzas with ~176 directives)
- **Field aliases and computed fields** that normalize SAP data for correlation with other security data
- **The `sap_logserv_idx_macro`** macro for searching the LogServ index

The LogServ App contains no Python code, no REST handlers, and no data collection components. It is a lightweight app focused entirely on the search-time experience.

### :material-circle-box:{ .taiconcolor } High Level Steps

Below are the high level steps for installing the LogServ App. Follow them in order.

:material-lightning-bolt:{ .taiconcolor } Steps 3 and 4 are alternative paths — complete the one that matches your Splunk environment.

1. Identify where to install the LogServ App based on your topology
2. Download the LogServ App
3. Install the LogServ App in Splunk Cloud (if applicable)
4. Install the LogServ App in Splunk Enterprise (if applicable)
5. Verify the installation
6. Update the index macro (if using a custom index name)

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

### :material-circle-box:{ .taiconcolor } 2. Download the LogServ App

Download `splunk_app_sap_logserv-0.0.4.2.tar.gz` from the <a href="https://github.com/splunk/splunk-sap-logserv/tree/main/release_binaries" target="_blank">GitHub repository</a>.

### :material-circle-box:{ .taiconcolor } 3. Install in Splunk Cloud

Install the LogServ App to your Splunk Cloud Search Head:

!!! note
    The app installation workflow available to you in Splunk Web depends on your Splunk Cloud Platform Experience: **Victoria** or **Classic**. To find your Splunk Cloud Platform Experience, in Splunk Web, click **Support & Services > About**.

#### :material-crop-square:{ .taiconcolor } Classic Experience

- <a href="https://help.splunk.com/en/splunk-cloud-platform/administer/admin-manual/9.3.2411/manage-apps-and-add-ons-in-splunk-cloud-platform/manage-private-apps-on-your-splunk-cloud-platform-deployment#e86cbd1a_f4ec_4256_9299_f2c56c9842ad__Install_a_private_app_on_Classic_Experience" target="_blank">Installation instructions for Classic Experience</a>

#### :material-crop-square:{ .taiconcolor } Victoria Experience

- <a href="https://help.splunk.com/en/splunk-cloud-platform/administer/admin-manual/9.3.2411/manage-apps-and-add-ons-in-splunk-cloud-platform/manage-private-apps-on-your-splunk-cloud-platform-deployment#b5f810d7_e842_487d_b752_3662cfb646bc__Install_a_private_app_on_Victoria_Experience" target="_blank">Installation instructions for Victoria Experience</a>

### :material-circle-box:{ .taiconcolor } 4. Install in Splunk Enterprise

Install the LogServ App to your Splunk Enterprise Search Head:

4.<b style="color: #ff9100">a</b> From the Splunk Web home screen, click the gear icon next to Apps.

4.<b style="color: #ff9100">b</b> Click Install app from file.

4.<b style="color: #ff9100">c</b> Locate the downloaded `splunk_app_sap_logserv-0.0.4.2.tar.gz` file and click Upload.

4.<b style="color: #ff9100">d</b> If Splunk Enterprise prompts you to restart, do so.

4.<b style="color: #ff9100">e</b> Verify that the app appears in the list of apps. You can also find it on the server at `$SPLUNK_HOME/etc/apps/splunk_app_sap_logserv`.

### :material-circle-box:{ .taiconcolor } 5. Verify installation

After installation, navigate to the LogServ App in Splunk Web. You should see the navigation bar with:

- **Environment Health** (default landing page — cross-cutting operations view)
- **Applications** collection (5 dashboards: ABAP Network & Security, ABAP Operations, Work Process Performance, HANA Audit, HANA Trace)
- **Integration** collection (5 dashboards: SAP Services, SAP Router, Cloud Connector, Web Dispatcher, Web and API Performance)
- **Security** collection (3 dashboards: Network Perimeter, Cross-Stack Authentication, Change & Configuration Activity)
- **Platform** collection (6 dashboards: Data Pipeline Overview, DNS Analytics, Linux, Windows, Proxy, Host Details)

If the dashboards show no data, verify that:

5.<b style="color: #ff9100">a</b> The Data TA is installed and collecting data on your Heavy Forwarders (or single instance)

5.<b style="color: #ff9100">b</b> The `sap_logserv_idx_macro` resolves to the correct index name

5.<b style="color: #ff9100">c</b> Events exist in the index: run `` `sap_logserv_idx_macro` | stats count by sourcetype `` in the Search app

### :material-circle-box:{ .taiconcolor } 6. Update the index macro

If you used a custom index name (not `sap_logserv_logs`), update the macro:

6.<b style="color: #ff9100">a</b> In Splunk Web, go to **Settings > Advanced search > Search macros**

6.<b style="color: #ff9100">b</b> Set the app context to **Splunk App for SAP LogServ**

6.<b style="color: #ff9100">c</b> Find `sap_logserv_idx_macro` and update its definition to `index=<your_index_name>`

## :material-circle-box:{ .cboxmove } Next Steps

- Explore the [Dashboards Overview](dashboards/index.md) to learn about the available dashboards
- If you haven't yet, complete the [AWS Setup Walkthrough](../install-setup/setup-walkthroughs.md) to configure data collection
