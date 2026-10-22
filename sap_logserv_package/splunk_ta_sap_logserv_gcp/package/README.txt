Splunk TA for SAP LogServ on GCP
================================

Ingests SAP LogServ data from Google Cloud Storage via Pub/Sub notifications:
SAP writes gzip-compressed NDJSON objects to a GCS bucket whose OBJECT_FINALIZE
notifications land on a Pub/Sub pull subscription. This add-on carries the
`sap_logserv_gcp_pubsub` modular input -- the GCP counterpart to the Splunk
Add-on for AWS "SQS-based S3" input. It drains the subscription, fetches each
new object, decompresses it and emits its lines on the instance that runs it.

Install tier
------------
Heavy Forwarders (the data-collection tier) - strongly recommended. Do not
install it on the Deployment Server or on Indexers. Installing it on a Search
Head is strongly recommended against (it puts ingest load on the tier your
users search on), but it is not blocked: there it works as it does on a heavy
forwarder, with the Data TA beside it. A search head cluster does not
replicate inputs, so an input runs only on the member where it was created.
An input the deployer pushes to every member runs on every member: the
members then share the subscription, and each message goes to one member,
but the checkpoint is per member, so a redelivered message can be indexed
twice.

Configure the input via Splunk Web on each instance that runs it (normally
each HF):
  Apps -> Splunk TA for SAP LogServ on GCP -> Inputs ->
  Create New Input -> GCP Pub/Sub subscription.

In a RISE / SAP ECS deployment SAP provisions and manages the GCS bucket, its
notification, the Pub/Sub topic and the subscription in the SAP-managed GCP
project; obtain the GCP project ID and the subscription name from your SAP
support contact. The one GCP resource you create is a service account in your
own GCP project: SAP grants it roles/pubsub.subscriber on the subscription and
roles/storage.objectViewer on the bucket, and the input takes its JSON key.

Requires
--------
The LogServ Data TA (splunk_ta_sap_logserv) must be installed on the same
instance (normally the same Heavy Forwarder). It provides the index-time
sourcetype routing (clz_dir/clz_subdir), the Configuration -> Filters
nullQueue filtering, and the splunk_solution/cloud_provider stamping that
apply to events this input emits with sourcetype = sap_logserv_logs (the
default; overridable per input via the Sourcetype field).

Every event from this input is tagged with the indexed cloud_provider=gcp
field (per-input attribution).

Documentation
-------------
See the "SAP LogServ on GCP -- Setup Guide" in the LogServ documentation.
