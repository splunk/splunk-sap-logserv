# Installing the Data TA

This page covers installing the **Data TA** (`splunk_ta_sap_logserv`). For the LogServ App installation, see [Installing the LogServ App](../logserv-app/installation.md).

### :material-circle-box:{ .taiconcolor } High Level Steps

Below are the high level steps for installing the Data TA. Follow them in order.

:material-lightning-bolt:{ .taiconcolor } Steps 4 and 5 are alternative paths — complete the one that matches your Splunk environment.

1. Create a default events index
2. Download the Data TA
3. Identify where to install the Data TA based on your topology
4. Install the Data TA in Splunk Cloud (if applicable)
5. Install the Data TA in Splunk Enterprise (if applicable)

<br>

### :material-circle-box:{ .taiconcolor } 1. Create a default index

The Data TA needs a default events index to store the log events it collects. The suggested default index name is **sap_logserv_logs** but you can use any events index of your choice.

- <a href="https://help.splunk.com/en/splunk-cloud-platform/administer/admin-manual/9.3.2411/manage-your-indexes-and-data-in-splunk-cloud-platform/manage-splunk-cloud-platform-indexes" target="_blank">Create an events index in Splunk Cloud</a>
- <a href="https://docs.splunk.com/Documentation/Splunk/9.4.2/Indexer/Setupmultipleindexes#Create_events_indexes" target="_blank">Create an events index in Splunk Enterprise</a>

!!! note
    Both the Data TA and the LogServ App include a macro named **sap_logserv_idx_macro** that resolves to `index=sap_logserv_logs`. If you use a different index name, update the macro definition after installation on each Splunk instance where it is installed.

<br>

### :material-circle-box:{ .taiconcolor } 2. Download the Data TA

Download `splunk_ta_sap_logserv-0.0.4.2.tar.gz` from the <a href="https://github.com/splunk/splunk-sap-logserv/tree/main/release_binaries" target="_blank">GitHub repository</a>.

<br>

### :material-circle-box:{ .taiconcolor } 3. Where to install

Refer to the [Architecture](../getting-started/architecture.md) page for the full install matrix. In summary:

| Your Topology | Install the Data TA On |
|---------------|----------------------|
| **Single instance** | The single Splunk instance |
| **Deployment Server + HFs** | The Deployment Server only (it distributes to HFs automatically) |

!!! warning
    If you are using a **Deployment Server** to manage Heavy Forwarders, install the TA on the Deployment Server only. Do **not** install the TA directly on the Heavy Forwarders — the DS will distribute it automatically when you configure filters. See [Configuring Filters](configure-filters.md) for details.

<br>

### :material-circle-box:{ .taiconcolor } 4. Install in Splunk Cloud

Install the Data TA to your instance of Splunk Cloud using the instructions below:

If you are using separate forwarders in conjunction with Splunk Cloud, be sure to <a href="https://docs.splunk.com/Documentation/AddOns/released/Overview/SplunkCloudinstall#Install_an_add-on_on_a_heavy_forwarder" target="_blank">deploy the add-on to your forwarders</a> as well.

!!! note
    The app installation workflow available to you in Splunk Web depends on your Splunk Cloud Platform Experience: **Victoria** or **Classic**. To find your Splunk Cloud Platform Experience, in Splunk Web, click **Support & Services > About**.

#### :material-crop-square:{ .taiconcolor } Classic Experience

- <a href="https://help.splunk.com/en/splunk-cloud-platform/administer/admin-manual/9.3.2411/manage-apps-and-add-ons-in-splunk-cloud-platform/manage-private-apps-on-your-splunk-cloud-platform-deployment#e86cbd1a_f4ec_4256_9299_f2c56c9842ad__Install_a_private_app_on_Classic_Experience" target="_blank">Installation instructions for Classic Experience</a>

#### :material-crop-square:{ .taiconcolor } Victoria Experience

- <a href="https://help.splunk.com/en/splunk-cloud-platform/administer/admin-manual/9.3.2411/manage-apps-and-add-ons-in-splunk-cloud-platform/manage-private-apps-on-your-splunk-cloud-platform-deployment#b5f810d7_e842_487d_b752_3662cfb646bc__Install_a_private_app_on_Victoria_Experience" target="_blank">Installation instructions for Victoria Experience</a>

<br>

### :material-circle-box:{ .taiconcolor } 5. Install in Splunk Enterprise

Install the Data TA to your instance of Splunk Enterprise:

5.<b style="color: #ff9100">a</b> From the Splunk Web home screen, click the gear icon next to Apps.

5.<b style="color: #ff9100">b</b> Click Install app from file.

5.<b style="color: #ff9100">c</b> Locate the downloaded `splunk_ta_sap_logserv-0.0.4.2.tar.gz` file and click Upload.

5.<b style="color: #ff9100">d</b> If Splunk Enterprise prompts you to restart, do so.

5.<b style="color: #ff9100">e</b> Verify that the add-on appears in the list of apps and add-ons. You can also find it on the server at `$SPLUNK_HOME/etc/apps/splunk_ta_sap_logserv`.

<br>

## :material-circle-box:{ .cboxmove } Next Steps

1. Install the [LogServ App](../logserv-app/installation.md) on your Search Head
2. Complete the [AWS Setup Walkthrough](setup-walkthroughs.md) to configure data collection
3. Configure [index-time filters](configure-filters.md) to control which log types are indexed
