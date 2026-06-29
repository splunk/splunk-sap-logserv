Splunk TA for SAP LogServ on Azure
==================================

Ingests SAP LogServ data from Microsoft Azure Blob Storage via Event Grid
blob-created notifications on an Azure Storage Queue. This add-on carries the
`azure_queue_input` modular input -- the Azure counterpart to the Splunk
Add-on for AWS "SQS-based S3" input.

Install tier
------------
Heavy Forwarders only (the data-collection tier). Do NOT install on the
Deployment Server, Indexers, or Search Heads.

Configure the input via Splunk Web on each HF:
  Apps -> Splunk TA for SAP LogServ on Azure -> Configuration -> Inputs ->
  Create New Input -> Azure Storage Queue.

Obtain the storage account name, the queue name, and the SAS (blob-read +
queue-process) from your SAP support contact -- in a RISE / SAP ECS deployment
SAP provisions and manages the Azure storage account, container, queue, and
Event Grid subscription. You create nothing in Azure.

Requires
--------
The LogServ Data TA (splunk_ta_sap_logserv) must be installed on the same Heavy
Forwarder. It provides the index-time sourcetype routing (clz_dir/clz_subdir),
the Configuration -> Filters nullQueue filtering, and the
splunk_solution/cloud_provider stamping that apply to events this input emits
with sourcetype = sap_logserv_logs (the default; overridable per input via the
Sourcetype field).

Every event from this input is tagged with the indexed cloud_provider=azure
field (per-input attribution).

Documentation
-------------
See the "SAP LogServ on Azure -- Setup Guide" in the LogServ documentation.
