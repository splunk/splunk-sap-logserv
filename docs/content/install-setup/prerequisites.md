# Data TA Prerequisites

This page covers the prerequisites for the **LogServ Data TA** (`splunk_ta_sap_logserv`) — the data-collection + index-time-filtering side. For the LogServ App's prerequisites (the AI Assistant's MCP Server dependency), see [LogServ App Prerequisites](../logserv-app/prerequisites.md).

### :material-circle-box:{ .taiconcolor } Splunk Platform Requirements

- **Splunk Enterprise** 9.4.3 or later, or **Splunk Cloud Platform**

### :material-circle-box:{ .taiconcolor } Required Splunk Add-ons

The LogServ App depends on two CIM Splunk Technical Add-ons for Linux + Windows sourcetype definitions and CIM mapping. Install on the **Search Head only** (they carry only search-time content for our pipeline — see [Quick Install Reference](../getting-started/quick-install-reference.md) for the per-tier matrix):

- <a href="https://splunkbase.splunk.com/app/833" target="_blank">Splunk Add-on for Unix and Linux</a>
- <a href="https://splunkbase.splunk.com/app/742" target="_blank">Splunk Add-on for Microsoft Windows</a>

!!! note "No standalone Squid Proxy or ISC BIND add-ons needed"
    Previous versions of this app listed the `Splunk Add-on for Squid Proxy` (Splunkbase 2965, now archived) and `Splunk Add-on for ISC BIND` (Splunkbase 2876, now archived) as additional prerequisites. Both add-ons' parsing has been **absorbed natively** into the LogServ App as of v0.0.5.0 build 184. Do not install the standalone add-ons. If either is detected at runtime, the LogServ App's home view shows a one-time dismissible banner recommending uninstall via `Settings → Manage Apps` to avoid duplicate field extraction.

### :material-circle-box:{ .taiconcolor } SAP ECS running in Amazon Web Services (AWS)

If you have SAP ECS running in Amazon Web Services (AWS) you need to install this additional Splunk Technical Add-on as well. Install it on the **Heavy Forwarders only** — **not** on the Search Head or Indexer. The HFs run the SQS-based S3 inputs that pull data from the dest bucket (and own the `index = sap_logserv_logs` setting on those inputs); the AWS Add-on carries no search-time content the App's dashboards need, so it has no role on the SH or indexer tier. This matches the per-tier [Quick Install Reference](../getting-started/quick-install-reference.md) matrix (AWS Add-on → **HFs** column only) and mirrors the per-HF install of the Azure add-on below.

- <a href="https://splunkbase.splunk.com/app/1876" target="_blank">Splunk Add-on for Amazon Web Services (AWS) Download</a>
- <a href="https://splunk.github.io/splunk-add-on-for-amazon-web-services/Installationandconfiguration/" target="_blank">Splunk Add-on for Amazon Web Services (AWS) Documentation</a>

Additional configuration instructions for the Splunk Add-on for Amazon Web Services (AWS) are provided in the [Setup guides](../install-setup/setup-guides.md) after the prerequisite steps have been completed so just install for now.

### :material-circle-box:{ .taiconcolor } SAP ECS running in Microsoft Azure

If your SAP ECS data lands in Microsoft Azure Blob Storage, install the first-party **Splunk TA for SAP LogServ on Azure** add-on (`splunk_ta_sap_logserv_azure`) on each Heavy Forwarder — the Azure counterpart to the Splunk Add-on for AWS, and shipped alongside the LogServ App + Data TA in this release. Its **`sap_logserv_azure_queue`** modular input consumes Azure Event Grid → Storage Queue notifications, fetches each blob over a SAS, and emits its NDJSON into the same index-time pipeline as the AWS path. In a RISE / SAP ECS deployment, SAP provisions and manages the storage account, Storage Queue, Event Grid subscription, and SAS in the SAP ECS Azure account — you create nothing in Azure; you only install the add-on and configure one input with the values SAP gives you.

Installation + configuration instructions — installing the add-on per Heavy Forwarder (directly, not via the Deployment Server), the parameter values to obtain from your SAP support contact, and the input fields — are in the [Azure Setup Guide](azure-queue-setup.md). The downstream pipeline (sourcetype routing, dashboards, ES integration) is identical between AWS and Azure deployments.

## :material-circle-box:{ .cboxmove } Next Steps

Next steps:

1. [Install the Data TA](../install-setup/install-ta.md)
2. [Install the LogServ App](../logserv-app/installation.md)
