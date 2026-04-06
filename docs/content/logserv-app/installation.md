# Installing the LogServ App

This page covers installing the **LogServ App** (`splunk_app_sap_logserv`). For the Data TA installation, see [Installing the Data TA](../install-setup/install-ta.md).

### :material-circle-box:{ .taiconcolor } About the LogServ App

The LogServ App provides:

- **Fourteen Dashboard Studio dashboards** for monitoring and analyzing SAP LogServ data
- **Search-time field extractions** for all SAP-specific sourcetypes (29 sourcetype stanzas with ~176 directives)
- **Field aliases and computed fields** that normalize SAP data for correlation with other security data
- **The `sap_logserv_idx_macro`** macro for searching the LogServ index

The LogServ App contains no Python code, no REST handlers, and no data collection components. It is a lightweight app focused entirely on the search-time experience.

### :material-circle-box:{ .taiconcolor } Where to install

| Your Topology | Install the LogServ App On |
|---------------|--------------------------|
| **Single instance** | The single Splunk instance (alongside the Data TA) |
| **Distributed with on-prem SH** | The Search Head only |
| **Distributed with Splunk Cloud** | The Splunk Cloud Search Head only |

!!! warning "Important"
    - The LogServ App is **never** installed on Heavy Forwarders or the Deployment Server.
    - For single-instance deployments, install both the Data TA and the LogServ App on the same instance. Splunk merges their configurations at runtime.

### :material-circle-box:{ .taiconcolor } Download the LogServ App

Download `splunk_app_sap_logserv-0.0.4.2.tar.gz` from the <a href="https://github.com/splunk/splunk-sap-logserv/tree/main/release_binaries" target="_blank">GitHub repository</a>.

### :material-circle-box:{ .taiconcolor } Install in Splunk Cloud

Install the LogServ App to your Splunk Cloud Search Head:

!!! note
    The app installation workflow available to you in Splunk Web depends on your Splunk Cloud Platform Experience: **Victoria** or **Classic**. To find your Splunk Cloud Platform Experience, in Splunk Web, click **Support & Services > About**.

#### :material-crop-square:{ .taiconcolor } Classic Experience

- <a href="https://help.splunk.com/en/splunk-cloud-platform/administer/admin-manual/9.3.2411/manage-apps-and-add-ons-in-splunk-cloud-platform/manage-private-apps-on-your-splunk-cloud-platform-deployment#e86cbd1a_f4ec_4256_9299_f2c56c9842ad__Install_a_private_app_on_Classic_Experience" target="_blank">Installation instructions for Classic Experience</a>

#### :material-crop-square:{ .taiconcolor } Victoria Experience

- <a href="https://help.splunk.com/en/splunk-cloud-platform/administer/admin-manual/9.3.2411/manage-apps-and-add-ons-in-splunk-cloud-platform/manage-private-apps-on-your-splunk-cloud-platform-deployment#b5f810d7_e842_487d_b752_3662cfb646bc__Install_a_private_app_on_Victoria_Experience" target="_blank">Installation instructions for Victoria Experience</a>

### :material-circle-box:{ .taiconcolor } Install in Splunk Enterprise

Install the LogServ App to your Splunk Enterprise Search Head:

1. From the Splunk Web home screen, click the gear icon next to Apps.
2. Click Install app from file.
3. Locate the downloaded `splunk_app_sap_logserv-0.0.4.2.tar.gz` file and click Upload.
4. If Splunk Enterprise prompts you to restart, do so.
5. Verify that the app appears in the list of apps. You can also find it on the server at `$SPLUNK_HOME/etc/apps/splunk_app_sap_logserv`.

### :material-circle-box:{ .taiconcolor } Verify installation

After installation, navigate to the LogServ App in Splunk Web. You should see the navigation bar with:

- **Environment Health** (default landing page — cross-cutting operations view)
- **Data Pipeline Overview**
- **SAP Analytics** collection (7 dashboards: ABAP Security, ABAP Operations, HANA Audit, HANA Trace, SAP Services, Cloud Connector, Web Dispatcher)
- **Infrastructure** collection (5 dashboards: DNS Analytics, Linux, Windows, Proxy, Host Details)

If the dashboards show no data, verify that:

1. The Data TA is installed and collecting data on your Heavy Forwarders (or single instance)
2. The `sap_logserv_idx_macro` resolves to the correct index name
3. Events exist in the index: run `` `sap_logserv_idx_macro` | stats count by sourcetype `` in the Search app

### :material-circle-box:{ .taiconcolor } Update the index macro

If you used a custom index name (not `sap_logserv_logs`), update the macro:

1. In Splunk Web, go to **Settings > Advanced search > Search macros**
2. Set the app context to **Splunk App for SAP LogServ**
3. Find `sap_logserv_idx_macro` and update its definition to `index=<your_index_name>`

## :material-circle-box:{ .cboxmove } Next Steps

- Explore the [Dashboards Overview](dashboards-overview.md) to learn about the available dashboards
- If you haven't yet, complete the [AWS Setup Walkthrough](../install-setup/setup-walkthroughs.md) to configure data collection
