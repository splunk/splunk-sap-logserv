# Verify Your Data

Run these checks once your first input has read data (step 11 of the [Deployment Roadmap](roadmap.md#11-verify-your-data), in its *4. Verify Your Data* group), before you install the LogServ App. They show whether events arrive, whether the Data TA parsed them, which sourcetypes they got and which cloud they are attributed to.

!!! note "Use the index name, not the macro"
    The searches below name the index, `index=sap_logserv_logs`. The `sap_logserv_idx_macro` macro is defined only where the Data TA or the LogServ App is installed. A distributed or Splunk Cloud search head usually has neither at this point, so a search that uses the macro fails there. If you renamed the data index, put your index name in place of `sap_logserv_logs`.

### :material-circle-box:{ .taiconcolor } Where to Run the Searches

Run them in **Search & Reporting** on a search head that searches your indexers: the Splunk Cloud search head, your on-premises search head, or the single instance. All of them only read.

They look at the last 24 hours of event time. Events from SAP's queue backlog keep the time they were logged, so while an input is still working through a backlog, widen `earliest=` (for example to `-14d`).

<br>

### :material-circle-box:{ .taiconcolor } 1. Events Arrive and the Data TA Parsed Them

```spl
| tstats fillnull_value="(none)" count where index=sap_logserv_logs earliest=-24h by splunk_solution
```

The Data TA stamps `splunk_solution=splunk_for_sap_logserv` on every event it parses. Expect a single row with that value.

- **No rows:** nothing has arrived in that time. Check the input on its forwarder ([check 5](#5-per-forwarder-checks)).
- **A `(none)` row:** the Data TA's rules did not run on those events. Two causes:
    - **The Data TA was not on the instance that parsed them.** The events keep the base sourcetype `sap_logserv_logs`, carry no folder fields and keep the whole delivery line as their event text, and they stay that way. Run the [Version Check](capacity-planning.md#version-check) on each heavy forwarder, and [distribute the Data TA](../install-setup/distribute-data-ta.md) to any forwarder that lacks it, before more data arrives.
    - **On AWS, the SQS-Based S3 input was created with a Source Type other than `sap_logserv_logs`.** The Data TA's rules run only on that sourcetype, so the events keep the input's sourcetype, which [check 2](#2-sourcetypes-and-cloud) shows. Correct the input's **Source Type** (step 7 of the [Connect guide](../install-setup/aws-remote-s3-connect-guide.md#7-configure-sqs-based-s3-input-aws-add-on), step 8 of the [Filter](../install-setup/aws-remote-s3-filter-guide.md#8-configure-sqs-based-s3-input-aws-add-on) and [Copy](../install-setup/aws-remote-s3-copy-guide.md#8-configure-sqs-based-s3-input-aws-add-on) guides); events already indexed stay as they are. The Azure and GCP inputs always send `sap_logserv_logs`.

<br>

### :material-circle-box:{ .taiconcolor } 2. Sourcetypes and Cloud

```spl
| tstats fillnull_value="(none)" count where index=sap_logserv_logs earliest=-24h by sourcetype, cloud_provider
| sort - count
```

`fillnull_value` must come before `count`. Without it, `tstats` leaves out every event that carries no `cloud_provider` at all.

- **`sourcetype`:** compare the list with [Supported Log Types](supported-log-types.md). You see only the types SAP delivers for your landscape. `sap_logserv_logs` holds what the Data TA does not route; [check 4](#4-routing-by-folder) tells whether that is expected.
- **`cloud_provider`:** each row should name your cloud: `aws`, `azure` or `gcp`. Rows for more than one provider are expected only if you ingest from more than one cloud.
- **`(none)` in `cloud_provider`:** those events carry no stamp. The Azure and GCP inputs always stamp theirs, so on AWS this means the SQS-Based S3 input has no `_meta = cloud_provider::aws` line, or read these events before the line went in; see [Choose Cloud Attribution](../install-setup/cloud-attribution.md). The LogServ App's dashboards count unstamped events as `aws`, but your own searches and `tstats` do not, and the stamp cannot be added to events already indexed.

<br>

### :material-circle-box:{ .taiconcolor } 3. One Cloud Value per Event

```spl
index=sap_logserv_logs earliest=-30d _index_earliest=-15m
| eval cloud_provider_values=mvcount(cloud_provider)
| fillnull value=0 cloud_provider_values
| stats count by cloud_provider_values
```

`_index_earliest=-15m` selects the events indexed in the last 15 minutes, whatever their event time, so the check also works while an input drains a backlog. `earliest=-30d` only limits how far back the search looks; widen it if your backlog is older.

Expect `1`, and `0` only for AWS events without a stamp. A `2` means the events carry two stamps: the Data TA's **Cloud Provider** dropdown is set while the input stamps its own value. See [Troubleshooting](troubleshooting.md).

This check is proven only for two different values (in the lab, an Azure input with the dropdown on **AWS** gave `2`). Whether the same value written twice also shows as `2` (the dropdown on **Microsoft Azure** for an Azure input, or on **AWS** for an AWS S3 Direct backfill) has not been tested. A `1` here therefore does not rule it out. Also check that the dropdown is at **Not set** wherever the Azure or GCP add-on runs or AWS S3 Direct is used ([What Gets Stamped](../install-setup/cloud-attribution.md#what-gets-stamped)).

<br>

### :material-circle-box:{ .taiconcolor } 4. Routing, by Folder

```spl
| tstats fillnull_value="(none)" count where index=sap_logserv_logs sourcetype=sap_logserv_logs earliest=-24h by clz_dir, clz_subdir
| sort - count
```

These events stayed under the base sourcetype. Judge them by their folders, not by how many there are: on Azure, the Unix command output that SAP delivers without folder fields can outnumber all other data, and it stays here by design unless you dropped it ([Decide Filtering](../install-setup/decide-filtering.md)).

Expected here:

- **`(none)` / `(none)`:** events without folder fields, such as the Azure data under `undefined/undefined` ([Data Delivered Without Folder Fields](supported-log-types.md#data-delivered-without-folder-fields)), and any events that [check 1](#1-events-arrive-and-the-data-ta-parsed-them) found without the Data TA.
- **The Secondary log types**, which have no routing of their own ([Secondary Supported Log Types](supported-log-types.md#secondary-supported-log-types)).
- **Files in folders that the Data TA routes by file path** (`linux/*`, `dns/binddns`, `proxy/squid`, `windows/*`, `webdispatcher/accesslog`) that are not among the routed files. Add `source` to the `by` clause and compare the file paths with Supported Log Types.

Not expected: the folders the Data TA routes by folder alone. A row for any of them means those events were not routed by the Data TA that parsed them; check that each heavy forwarder runs the current build and has no `local/` override of the routes ([Version Check](capacity-planning.md#version-check)):

`hana/hanaaudit`, `hana/tracelogs`, `abap/audit`, `abap/dispatcher`, `abap/enqueueserver`, `abap/event`, `abap/gateway`, `abap/icm`, `abap/messageserver`, `abap/sapstartsrv`, `abap/workprocess`, `scc/audit`, `scc/tracelogs`, `sap/sapstartsrv`, `sap/saphostexec`, `sap/saprouter`.

<br>

### :material-circle-box:{ .taiconcolor } 5. Per-Forwarder Checks

- **The Data TA on each heavy forwarder.** Run the [Version Check](capacity-planning.md#version-check) on each one: the routing rules run there, not on the Deployment Server.
- **Heavy forwarders that send to Splunk Cloud.** From the Splunk Cloud search head, this search must return events for each forwarder; if it returns none, that forwarder is not sending to Splunk Cloud:

    ```spl
    | tstats count where index=_internal host=<HF> earliest=-15m
    ```

- **The input's own log.** Forwarders send their `_internal` data by default, so you can read it from the search head:
    - Azure: `index=_internal source=*splunk_ta_sap_logserv_azure_queue.log* "done:"` shows a line `Input '<name>' done: messages=N blobs=N events=N ...` per firing ([Azure Setup Guide → Validation](../install-setup/azure-setup.md#validation)).
    - GCP: `index=_internal source=*splunk_ta_sap_logserv_gcp_pubsub.log* "done:"` shows a line `Input '<name>' done: messages=N objects=N events=N ...` per firing ([GCP Setup Guide → Validation](../install-setup/gcp-setup.md#validation)).
    - AWS: `index=_internal source=*aws* level IN (ERROR, WARNING) earliest=-1h` lists the errors and warnings of the Splunk Add-on for AWS.

<br>

## :material-circle-box:{ .cboxmove } Next Steps

- If a check fails, find the symptom on [Troubleshooting](troubleshooting.md).
- On AWS, [load history](roadmap.md#12-load-history) with AWS S3 Direct if you need older days.
- [Install the LogServ App](../logserv-app/installation.md) and its [prerequisites](../logserv-app/prerequisites.md) on the search head, then run its **Diagnostics** page ([Data Doctor](../logserv-app/dashboards/platform/diagnostics.md)).
