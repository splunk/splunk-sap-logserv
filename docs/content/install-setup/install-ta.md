# Installing the Data TA

This page covers installing the **Data TA** (`splunk_ta_sap_logserv`). For the LogServ App installation, see [Installing the LogServ App](../logserv-app/installation.md).

### :material-circle-box:{ .taiconcolor } Create a default index

The Data TA needs a default events index to store the log events it collects. The suggested default index name is **sap_logserv_logs** but you can use any events index of your choice.

- <a href="https://help.splunk.com/en/splunk-cloud-platform/administer/admin-manual/9.3.2411/manage-your-indexes-and-data-in-splunk-cloud-platform/manage-splunk-cloud-platform-indexes" target="_blank">Create an events index in Splunk Cloud</a>
- <a href="https://docs.splunk.com/Documentation/Splunk/9.4.2/Indexer/Setupmultipleindexes#Create_events_indexes" target="_blank">Create an events index in Splunk Enterprise</a>

!!! note
    Both the Data TA and the LogServ App include a macro named **sap_logserv_idx_macro** that resolves to `index=sap_logserv_logs`. If you use a different index name, update the macro definition after installation on each Splunk instance where it is installed.

<br>

### :material-circle-box:{ .taiconcolor } Download the Data TA

Download `splunk_ta_sap_logserv-0.0.4.2.tar.gz` from the <a href="https://github.com/splunk/splunk-sap-logserv/tree/main/release_binaries" target="_blank">GitHub repository</a>.

<br>

### :material-circle-box:{ .taiconcolor } Where to install

Refer to the [Architecture](../getting-started/architecture.md) page for the full install matrix. In summary:

| Your Topology | Install the Data TA On |
|---------------|----------------------|
| **Single instance** | The single Splunk instance |
| **Deployment Server + HFs** | The Deployment Server only (it distributes to HFs automatically) |

!!! warning
    If you are using a **Deployment Server** to manage Heavy Forwarders, install the TA on the Deployment Server only. Do **not** install the TA directly on the Heavy Forwarders — the DS will distribute it automatically when you configure filters. See [Configuring Filters](configure-filters.md) for details.

<br>

### :material-circle-box:{ .taiconcolor } Install in Splunk Cloud

Install the Data TA to your instance of Splunk Cloud using the instructions below:

If you are using separate forwarders in conjunction with Splunk Cloud, be sure to <a href="https://docs.splunk.com/Documentation/AddOns/released/Overview/SplunkCloudinstall#Install_an_add-on_on_a_heavy_forwarder" target="_blank">deploy the add-on to your forwarders</a> as well.

!!! note
    The app installation workflow available to you in Splunk Web depends on your Splunk Cloud Platform Experience: **Victoria** or **Classic**. To find your Splunk Cloud Platform Experience, in Splunk Web, click **Support & Services > About**.

#### :material-crop-square:{ .taiconcolor } Classic Experience

- <a href="https://help.splunk.com/en/splunk-cloud-platform/administer/admin-manual/9.3.2411/manage-apps-and-add-ons-in-splunk-cloud-platform/manage-private-apps-on-your-splunk-cloud-platform-deployment#e86cbd1a_f4ec_4256_9299_f2c56c9842ad__Install_a_private_app_on_Classic_Experience" target="_blank">Installation instructions for Classic Experience</a>

#### :material-crop-square:{ .taiconcolor } Victoria Experience

- <a href="https://help.splunk.com/en/splunk-cloud-platform/administer/admin-manual/9.3.2411/manage-apps-and-add-ons-in-splunk-cloud-platform/manage-private-apps-on-your-splunk-cloud-platform-deployment#b5f810d7_e842_487d_b752_3662cfb646bc__Install_a_private_app_on_Victoria_Experience" target="_blank">Installation instructions for Victoria Experience</a>

<br>

### :material-circle-box:{ .taiconcolor } Install in Splunk Enterprise

Install the Data TA to your instance of Splunk Enterprise:

1. From the Splunk Web home screen, click the gear icon next to Apps.
2. Click Install app from file.
3. Locate the downloaded `splunk_ta_sap_logserv-0.0.4.2.tar.gz` file and click Upload.
4. If Splunk Enterprise prompts you to restart, do so.
5. Verify that the add-on appears in the list of apps and add-ons. You can also find it on the server at `$SPLUNK_HOME/etc/apps/splunk_ta_sap_logserv`.

<br>

## :material-circle-box:{ .cboxmove } Next Steps

1. Install the [LogServ App](../logserv-app/installation.md) on your Search Head
2. Complete the [AWS Setup Walkthrough](setup-walkthroughs.md) to configure data collection
3. Configure [index-time filters](configure-filters.md) to control which log types are indexed
