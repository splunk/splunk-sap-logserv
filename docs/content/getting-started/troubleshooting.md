# Troubleshooting

This page lists common symptoms and the section that explains each one. If you are not sure the data arrives at all, start with [Verify Your Data](verify-data.md); if a dashboard panel is empty, start with the LogServ App's [Data Doctor](../logserv-app/dashboards/platform/diagnostics.md).

### :material-circle-box:{ .taiconcolor } Data Arrival and Parsing

| Symptom | Likely cause | Where to look |
|---|---|---|
| No events in `sap_logserv_logs` | The input cannot read: credentials, SAP's policies or grants, the network path, or a wrong queue or subscription name | [Verify Your Data → Per-Forwarder Checks](verify-data.md#5-per-forwarder-checks); your AWS guide's last step ([Connect](../install-setup/aws-remote-s3-connect-guide.md#8-confirm-logserv-logs-are-being-ingested), [Filter](../install-setup/aws-remote-s3-filter-guide.md#10-confirm-logserv-logs-are-being-ingested), [Copy](../install-setup/aws-remote-s3-copy-guide.md#10-confirm-logserv-logs-are-being-ingested)); [Azure troubleshooting](../install-setup/azure-setup.md#troubleshooting); [GCP troubleshooting](../install-setup/gcp-setup.md#troubleshooting) |
| Events keep the sourcetype `sap_logserv_logs`, have no folder fields and no `splunk_solution` | The Data TA was not on the instance that parsed them, or the input started before the Data TA reached it. Those events stay as they were indexed | [Verify Your Data, check 1](verify-data.md#1-events-arrive-and-the-data-ta-parsed-them); [Version Check](capacity-planning.md#version-check); [Distribute the Data TA](../install-setup/distribute-data-ta.md) |
| Events arrive under another sourcetype, with no folder fields and no `splunk_solution` | The AWS SQS-Based S3 input's **Source Type** is not `sap_logserv_logs`, so the Data TA's rules do not run on its events. Events already indexed stay as they are | Your AWS guide's SQS-Based S3 input step: [Connect](../install-setup/aws-remote-s3-connect-guide.md#7-configure-sqs-based-s3-input-aws-add-on), [Filter](../install-setup/aws-remote-s3-filter-guide.md#8-configure-sqs-based-s3-input-aws-add-on), [Copy](../install-setup/aws-remote-s3-copy-guide.md#8-configure-sqs-based-s3-input-aws-add-on); [Verify Your Data, check 1](verify-data.md#1-events-arrive-and-the-data-ta-parsed-them) |
| A folder the Data TA routes by folder alone (for example `hana/hanaaudit`) stays under `sap_logserv_logs` | The routes did not run as shipped on the forwarder that parsed it: check its Data TA build, and look for a `local/` override of the routes | [Verify Your Data, check 4](verify-data.md#4-routing-by-folder); [Version Check](capacity-planning.md#version-check) |
| Most Azure data stays under `sap_logserv_logs` | The Unix command output SAP delivers without folder fields stays there by design | [Data Delivered Without Folder Fields](supported-log-types.md#data-delivered-without-folder-fields); [Configuring Filters → Events Without Folder Fields](../install-setup/configure-filters.md#events-without-folder-fields) |
| Events arrive hours or days late after the first start, and the forwarder is busy | SAP's queue backlog is draining | [First Start: The Queue Backlog](capacity-planning.md#first-start-the-queue-backlog); [Measure Your Own Heavy Forwarder](capacity-planning.md#measure-your-own-heavy-forwarder) |
| An Azure or GCP event is indexed twice | More than one input reads the same queue or subscription | Multiple landscapes / fleets: [Azure](../install-setup/azure-setup.md#multiple-landscapes-fleets), [GCP](../install-setup/gcp-setup.md#multiple-landscapes-fleets) |
| A search that uses `sap_logserv_idx_macro` fails on the search head (the macro cannot be found) | Neither the Data TA nor the LogServ App is on that search head yet | [Verify Your Data](verify-data.md) has the same checks with the index name |

<br>

### :material-circle-box:{ .taiconcolor } Cloud Attribution

| Symptom | Likely cause | Where to look |
|---|---|---|
| `cloud_provider` is missing in your own searches or in `tstats` | An AWS SQS-Based S3 input without `_meta = cloud_provider::aws`, or the stamp was set up after the events were indexed. The LogServ App's dashboards count such events as `aws`; other searches do not | [Choose Cloud Attribution](../install-setup/cloud-attribution.md); [Verify Your Data, check 2](verify-data.md#2-sourcetypes-and-cloud) |
| `mvcount(cloud_provider)` is 2 | The Data TA's **Cloud Provider** dropdown is set while the input stamps its own value: an Azure or GCP input with the dropdown on any value, or an AWS S3 Direct backfill with the dropdown on AWS. A dropdown value different from the input's is seen in the lab; the same-value case follows from how Splunk writes `_meta` and has not been reproduced | [Choose Cloud Attribution → What Gets Stamped](../install-setup/cloud-attribution.md#what-gets-stamped); [Check the Result](../install-setup/cloud-attribution.md#check-the-result) |

<br>

### :material-circle-box:{ .taiconcolor } Azure and GCP Inputs

| Symptom | Likely cause | Where to look |
|---|---|---|
| Azure input log: `queue read failed (... 403 ...)` | The SAS lacks queue process (`p`), `ss` lacks `q`, `srt` lacks `o`, or the SAS has expired | [Azure troubleshooting](../install-setup/azure-setup.md#troubleshooting); [What the SAP-provided SAS must cover](../install-setup/azure-setup.md#what-the-sap-provided-sas-must-cover) |
| The input worked for weeks, then its log shows 403 or forbidden errors | The Azure SAS has passed its expiry (`se=`), or the GCP service-account key was disabled or deleted | Rotate credentials: [Azure](../install-setup/azure-setup.md#rotate-credentials), [GCP](../install-setup/gcp-setup.md#rotate-credentials); [Azure troubleshooting](../install-setup/azure-setup.md#troubleshooting); [GCP troubleshooting](../install-setup/gcp-setup.md#troubleshooting) |
| Saving an Azure or GCP input fails with 403 "This operation is forbidden" | Your role lacks `admin_all_objects`, which creating, editing and deleting an input need | [Splunk Cloud Considerations → Capability-gated REST endpoints](splunk-cloud.md#capability-gated-rest-endpoints); configure the input: [Azure](../install-setup/azure-setup.md#configure-the-input), [GCP](../install-setup/gcp-setup.md#configure-the-input) |
| The input logs `done: messages=0` at every firing, but objects exist | SAP's notification is not reaching the queue or subscription, or its name is wrong | [Azure troubleshooting](../install-setup/azure-setup.md#troubleshooting); [GCP troubleshooting](../install-setup/gcp-setup.md#troubleshooting) |

<br>

### :material-circle-box:{ .taiconcolor } AWS

| Symptom | Likely cause | Where to look |
|---|---|---|
| The Filter scenario's Lambda logs `Could not retrieve S3 object, discarding message`, `Failed to forward message to target SQS, discarding` or `Unexpected error processing message` | The Lambda deleted SAP's notification without forwarding it, so that object was not ingested | [AWS Remote S3 Filter, step 10](../install-setup/aws-remote-s3-filter-guide.md#10-confirm-logserv-logs-are-being-ingested); after fixing the cause, load the missing days with [AWS S3 Direct](../install-setup/aws-s3-direct.md) |
| The AWS S3 Direct screen shows "Apply this as an administrator" instead of a **Create backfill** button | Your account lacks `admin_all_objects` (or the screen could not confirm your capabilities), a read of the Splunk Add-on for AWS configuration that a create needs failed, or a Deployment Server manages the Splunk Add-on for AWS on this instance. The screen names the reason | [AWS S3 Direct → Troubleshooting](../install-setup/aws-s3-direct.md#troubleshooting); [The AWS S3 Direct screen](../install-setup/aws-s3-direct.md#2a-the-aws-s3-direct-screen); [Splunk Cloud Considerations](splunk-cloud.md#capability-gated-rest-endpoints) |
| An AWS S3 Direct backfill gets `AccessDenied`, finds nothing, or skips days | `s3:ListBucket` missing (for SAP's bucket, also in SAP's bucket policy), days already covered or filtered out, and the other causes in its table | [AWS S3 Direct → Troubleshooting](../install-setup/aws-s3-direct.md#troubleshooting) |
| Backfilled events can be searched at first, then disappear | The index's retention is shorter than the age of the days you loaded: Splunk freezes a bucket once its newest event is older than the retention | Raise the retention of `sap_logserv_logs` ([Create the Indexes](../install-setup/install-ta.md#1-create-the-indexes)), then load those days again; [AWS S3 Direct → Troubleshooting](../install-setup/aws-s3-direct.md#troubleshooting) |
| A step of the migration from AWS Remote S3 Connect to Filter fails | See the migration guide | [Connect to Filter migration → Troubleshooting](https://splunk.github.io/splunk-sap-logserv/content/install-setup/aws-remote-s3-connect-to-filter-migration-guide/#troubleshooting) |

<br>

### :material-circle-box:{ .taiconcolor } Filters and the Deployment Server

| Symptom | Where to look |
|---|---|
| Filters do not take effect on a single instance | [Filters Not Taking Effect (Single Instance)](../install-setup/configure-filters.md#filters-not-taking-effect-single-instance) |
| Filters, or the Data TA itself, do not reach the heavy forwarders | [Filters Not Reaching Heavy Forwarders](../install-setup/configure-filters.md#filters-not-reaching-heavy-forwarders); [Distribute the Data TA](../install-setup/distribute-data-ta.md) |
| The Data TA does not detect the Deployment Server | [Deployment Server Not Detected](../install-setup/configure-filters.md#deployment-server-not-detected) |
| Saving the Filters tab is refused | [Validation Error on Save](../install-setup/configure-filters.md#validation-error-on-save) |
| The daily refresh logs an invalid setting | [Daily Refresh Reports an Invalid Setting](../install-setup/configure-filters.md#daily-refresh-reports-an-invalid-setting) |
| Days in the Past seems to keep or drop one day too many | [Time Filter Seems Off by a Day](../install-setup/configure-filters.md#time-filter-seems-off-by-a-day) |

<br>

### :material-circle-box:{ .taiconcolor } LogServ App and Dashboards

| Symptom | Likely cause | Where to look |
|---|---|---|
| The dashboards show only the hours since the LogServ App was installed | The dashboard rollups have not been backfilled yet | [Backfilling on first install](../logserv-app/dashboard-data.md#backfilling-on-first-install) |
| Some days are missing from the dashboards after a backlog or a backfill of events | Events that arrive after their hour was summarised are missing from the rollups until those days are rebuilt | [Late-arriving data](../logserv-app/dashboard-data.md#late-arriving-data) |
| A panel is empty | Many possible causes; the Data Doctor names the one that applies | [Data Doctor](../logserv-app/dashboards/platform/diagnostics.md) |
| The Data Doctor cannot tell whether the forwarders' filters drop the data | The search head cannot see the Data TA's filter settings | [Supplying the ingest-filter configuration](../logserv-app/dashboards/platform/diagnostics.md#supplying-the-ingest-filter-configuration) |
| Windows panels that need event fields such as the event code or severity are empty | The Splunk Add-on for Microsoft Windows is missing on the search head. After you install it, the *Windows* Dashboard Data row needs **Clear** then **Backfill**; the other rows that read Windows fields need a **Backfill** only | [LogServ App Prerequisites](../logserv-app/prerequisites.md); [Windows Events → Requires](../logserv-app/dashboards/platform/windows.md#requires) |
| "Admin access required" in the LogServ App's Settings, or 403 errors on Save, Clear or Backfill | The LogServ App treats only roles named exactly `admin`, `sc_admin` or `sc_subadmin` as admins | [LogServ App Prerequisites](../logserv-app/prerequisites.md); [Splunk Cloud Considerations](splunk-cloud.md) |
| No **AI Assistant** button in the top bar | The AI Assistant ships turned off | [Set Up the AI Assistant](../ai-assistant/enable.md) |

<br>

## :material-circle-box:{ .cboxmove } Next Steps

- [Deployment Roadmap](roadmap.md): the setup steps in order.
- [Verify Your Data](verify-data.md): the checks to run after any change to the inputs or the Data TA.
- [Configuring Filters](../install-setup/configure-filters.md): change the filters later.
