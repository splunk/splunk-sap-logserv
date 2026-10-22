Splunk TA for SAP LogServ on Azure
==================================

Ingests SAP LogServ data from Microsoft Azure Blob Storage via Event Grid
blob-created notifications on an Azure Storage Queue. This add-on carries the
`sap_logserv_azure_queue` modular input -- the Azure counterpart to the Splunk
Add-on for AWS "SQS-based S3" input.

Install tier
------------
Heavy Forwarders (the data-collection tier) - strongly recommended. Do not
install it on the Deployment Server or on Indexers. Installing it on a Search
Head is strongly recommended against (it puts ingest load on the tier your
users search on), but it is not blocked: there it works as it does on a heavy
forwarder, with the Data TA beside it. A search head cluster does not
replicate inputs, so an input runs only on the member where it was created.
An input the deployer pushes to every member runs on every member: the
members then share the queue, and each message goes to one member, but the
dedup record is per member, so a redelivered message can be indexed twice.

Configure the input via Splunk Web on each instance that runs it (normally
each HF):
  Apps -> Splunk TA for SAP LogServ on Azure -> Inputs ->
  Create New Input -> Azure Storage Queue.

Obtain the storage account name, the queue name, and the SAS (blob-read +
queue-process) from your SAP support contact -- in a RISE / SAP ECS deployment
SAP provisions and manages the Azure storage account, container, queue, and
Event Grid subscription. You create nothing in Azure.

Requires
--------
The LogServ Data TA (splunk_ta_sap_logserv) must be installed on the same
instance (normally the same Heavy Forwarder). It provides the index-time
sourcetype routing (clz_dir/clz_subdir), the Configuration -> Filters
nullQueue filtering, and the splunk_solution/cloud_provider stamping that
apply to events this input emits with sourcetype = sap_logserv_logs (the
default; overridable per input via the Sourcetype field).

Every event from this input is tagged with the indexed cloud_provider=azure
field (per-input attribution).

Documentation
-------------
See the "SAP LogServ on Azure -- Setup Guide" in the LogServ documentation.
