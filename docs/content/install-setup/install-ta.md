# Installing the Splunk TA for SAP LogServ

### :material-circle-box:{ .taiconcolor } Create a default index for the Splunk TA for SAP LogServ

The Splunk TA for SAP LogServ needs a default event index defined to store the log events it collects. The suggested default index name is **_sap_logserv_logs_** but you can use any index of your choice. 

- <a href="https://help.splunk.com/en/splunk-cloud-platform/administer/admin-manual/9.3.2411/manage-your-indexes-and-data-in-splunk-cloud-platform/manage-splunk-cloud-platform-indexes" target="_blank">Create an event index in Splunk Cloud</a>
- <a href="https://docs.splunk.com/Documentation/Splunk/9.4.2/Indexer/Setupmultipleindexes#Create_events_indexes" target="_blank">Create an event index in Splunk Enterprise</a>

!!! note 
    The Splunk LogServ TA comes with a macro named **_sap_logserv_idx_macro_** that you can change after installation to map to the index name you used in this step.


### :material-circle-box:{ .taiconcolor } Download the TA

Download and install the Splunk TA for SAP LogServ from the <a href="https://github.com/splunk/splunk-sap-logserv/tree/main/release_binaries" target="_blank">GitHub repository</a>

### :material-circle-box:{ .taiconcolor } Install in Splunk Cloud

Install the Splunk TA for SAP LogServ to your instance of Splunk Cloud using the instructions below:

!!! note 
    The app installation workflow available to you in Splunk Web depends on your Splunk Cloud Platform Experience: **Victoria** or **Classic**. To find your Splunk Cloud Platform Experience, in Splunk Web, click **Support & Services > About**. 

#### :material-greater-than:{ .taiconcolor } Classic Experience

- <a href="https://help.splunk.com/en/splunk-cloud-platform/administer/admin-manual/9.3.2411/manage-apps-and-add-ons-in-splunk-cloud-platform/manage-private-apps-on-your-splunk-cloud-platform-deployment#e86cbd1a_f4ec_4256_9299_f2c56c9842ad__Install_a_private_app_on_Classic_Experience" target="_blank">Installation instructions for Classic Experience</a>

#### :material-greater-than:{ .taiconcolor } Victoria Experience

- <a href="https://help.splunk.com/en/splunk-cloud-platform/administer/admin-manual/9.3.2411/manage-apps-and-add-ons-in-splunk-cloud-platform/manage-private-apps-on-your-splunk-cloud-platform-deployment#b5f810d7_e842_487d_b752_3662cfb646bc__Install_a_private_app_on_Victoria_Experience" target="_blank">Installation instructions for Classic Experience</a>


### :material-circle-box:{ .taiconcolor } Install in Splunk Enterprise

Install the Splunk TA for SAP LogServ to your instance of Splunk Enterprise using the instructions below:

1. From the Splunk Web home screen, click the gear icon next to Apps.
2. Click Install app from file.
3. Locate the downloaded file and click Upload.
4. If Splunk Enterprise prompts you to restart, do so.
5. Verify that the add-on appears in the list of apps and add-ons. You can also find it on the server at $SPLUNK_HOME/etc/apps/splunk_ta_sap_logserv. 

If you are using separate forwarders in conjunction with your single-instance deployment, be sure to <a href="http://docs.splunk.com/Documentation/AddOns/released/Overview/Distributedinstall#Universal_or_light_forwarders" target="_blank">deploy the add-on to your forwarders</a> as well. 


## :material-circle-box:{ .cboxmove } Next Steps


Additional instructions for next steps are provided in the [Setup walkthroughs](../install-setup/setup-walkthroughs.md)