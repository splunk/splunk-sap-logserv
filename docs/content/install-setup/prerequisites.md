# Data TA Prerequisites

This page covers the prerequisites for the **LogServ Data TA** (`splunk_ta_sap_logserv`) — the data-collection + index-time-filtering side. For the LogServ App's prerequisites (the AI Assistant's MCP Server dependency), see [LogServ App Prerequisites](../logserv-app/prerequisites.md).

### :material-circle-box:{ .taiconcolor } Splunk Platform Requirements

- **Splunk Enterprise** 9.4.3 or later, or **Splunk Cloud Platform**

### :material-circle-box:{ .taiconcolor } Required Splunk Add-ons

The SAP LogServ packages depend on several additional Splunk Technical Add-ons for sourcetype definitions and CIM mapping. Install these from Splunkbase before proceeding:

- <a href="https://splunkbase.splunk.com/app/833" target="_blank">Splunk Add-on for Unix and Linux</a>
- <a href="https://splunkbase.splunk.com/app/742" target="_blank">Splunk Add-on for Microsoft Windows</a>
- <a href="https://splunkbase.splunk.com/app/2965" target="_blank">Splunk Add-on for Squid Proxy</a>
- <a href="https://splunkbase.splunk.com/app/2876" target="_blank">Splunk Add-on for ISC BIND</a>

### :material-circle-box:{ .taiconcolor } SAP ECS running in Amazon Web Services (AWS)

If you have SAP ECS running in Amazon Web Services (AWS) you need to install this additional Splunk Technical Add-on as well.

- <a href="https://splunkbase.splunk.com/app/1876" target="_blank">Splunk Add-on for Amazon Web Services (AWS) Download</a>
- <a href="https://splunk.github.io/splunk-add-on-for-amazon-web-services/Installationandconfiguration/" target="_blank">Splunk Add-on for Amazon Web Services (AWS) Documentation</a>

Additional configuration instructions for the Splunk Add-on for Amazon Web Services (AWS) are provided in the [Setup walkthroughs](../install-setup/setup-walkthroughs.md) after the prerequisite steps have been completed so just install for now.

## :material-circle-box:{ .cboxmove } Next Steps

Next steps:

1. [Install the Data TA](../install-setup/install-ta.md)
2. [Install the LogServ App](../logserv-app/installation.md)
