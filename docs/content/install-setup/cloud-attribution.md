# Choose Cloud Attribution

This page decides how each LogServ event records the cloud it came from, in the indexed field `cloud_provider`. Decide before the first **Save** on the Deployment Server's Configuration page and before any input first runs: the value is written at index time, and every event keeps the value it was indexed with, the first-start backlog included.

**In short:** leave the Data TA's **Cloud Provider** dropdown at **Not set** (the default) on every fleet, and add `_meta = cloud_provider::aws` to each AWS SQS-Based S3 input. The Azure and GCP inputs, and the AWS S3 Direct backfills, stamp their events themselves.

<br>

### :material-circle-box:{ .taiconcolor } What Gets Stamped { #what-gets-stamped }

The Data TA's **Configuration** page has two tabs: **Filters** ([Configuring Filters](configure-filters.md)) and **Cloud Provider**. The Data TA stamps two indexed fields at index time on the `sap_logserv_logs` sourcetype every LogServ event arrives with, with the same `WRITE_META` mechanism it uses for `clz_dir` and `clz_subdir`:

| Indexed field | Value | How it's set | Configurable |
|---|---|---|---|
| `splunk_solution` | `splunk_for_sap_logserv` | Always stamped on every event | No: ships active, no UI control |
| `cloud_provider` | `aws` / `azure` / `gcp` / *(none)* | By the input's own `_meta` line, and by the Cloud Provider dropdown when it is set | Yes: per input, and **Configuration → Cloud Provider** |

Both fields are written on the instance that parses the data (the heavy forwarder, or the single instance), so they are available as indexed fields for `tstats`, accelerated searches and raw-event filtering.

**`splunk_solution` (always on).** Every event indexed through the Data TA carries `splunk_solution = splunk_for_sap_logserv`. There is nothing to configure. It identifies events that flowed through the Splunk for SAP LogServ pipeline, which helps when the same index or Splunk instance also receives data from other solutions.

!!! note "`splunk_solution` is distinct from `vendor_product`"
    The LogServ App also defines a per-sourcetype `vendor_product` search-time field (for example `SAP HANA`, `SAP NetWeaver ABAP`, `SAP Web Dispatcher`, `ISC:Bind`) that dashboards and CIM mapping rely on. That field describes *which product* produced a given event. `splunk_solution` is a separate, coarser stamp identifying the *solution* that ingested it. The two coexist and do not collide.

**`cloud_provider` comes from two places:**

- **The input's `_meta` line.** The LogServ Azure add-on's `sap_logserv_azure_queue` input always carries `_meta = cloud_provider::azure` (the add-on writes it into its input stanza), and the LogServ GCP add-on's `sap_logserv_gcp_pubsub` input always carries `_meta = cloud_provider::gcp`. Every input the [AWS S3 Direct](aws-s3-direct.md) screen creates is stamped `_meta = cloud_provider::aws` straight after it is created. The Splunk Add-on for AWS's SQS-Based S3 inputs carry no `_meta` unless you add it; the add-on's form has no field for it.
- **The Cloud Provider dropdown** on the Data TA's Configuration page:

| Selection | Effect |
|---|---|
| **Not set** (default) | The Data TA adds no `cloud_provider` value of its own. |
| **AWS** | Every event the Data TA processes on that instance is stamped `cloud_provider = aws`. |
| **Microsoft Azure** | Every event the Data TA processes on that instance is stamped `cloud_provider = azure`. Not needed with the LogServ Azure add-on, whose input already stamps this value. |
| **Google Cloud Platform** | Every event the Data TA processes on that instance is stamped `cloud_provider = gcp`. Not needed with the LogServ GCP add-on, whose input already stamps this value. |

The dropdown does not replace an input's `_meta`; it adds a second value beside it. An Azure event under dropdown = **AWS** carries both `azure` and `aws` (seen in the lab), so `mvcount(cloud_provider)` is 2 and the event can be counted under both clouds. A repeated value is expected to stay as well, according to Splunk's description of `_meta`, so an Azure event under dropdown = **Microsoft Azure** can carry `azure` twice; this same-value case has not been reproduced in the lab. That is why the dropdown stays at **Not set** wherever an input stamps its own events.

<br>

### :material-circle-box:{ .taiconcolor } Recommended: Not Set Plus Per-Input `_meta` { #recommended-not-set-plus-per-input-meta }

Use this on every fleet, AWS-only fleets included:

1. **Leave the Cloud Provider dropdown at Not set** on every instance that runs the Data TA. With a Deployment Server, that is the value it pushes.
2. **Azure and GCP:** nothing to do. Their inputs stamp their own events.
3. **AWS SQS-Based S3 inputs:** add `_meta = cloud_provider::aws` to each input's stanza before the input first runs, as described in [Add the `_meta` line to an AWS input](#add-the-meta-line-to-an-aws-input).
4. **AWS S3 Direct backfills:** nothing to do. The screen stamps each input it creates.

Adding a second cloud later changes nothing: each input keeps labelling its own events.

#### :material-crop-square:{ .taiconcolor } Add the `_meta` Line to an AWS Input { #add-the-meta-line-to-an-aws-input }

On each heavy forwarder (or the single instance) that runs an SQS-Based S3 input for LogServ:

1. Create the SQS-Based S3 input in the Splunk Add-on for AWS, as your [AWS setup guide](choose-your-cloud.md) describes.
2. Right away, set the input to disabled on the add-on's **Inputs** page, so that it reads as little as possible before the line is in place.
3. Open `$SPLUNK_HOME/etc/apps/Splunk_TA_aws/local/inputs.conf`, find the input's stanza, `[aws_sqs_based_s3://<input name>]`, and add the line:

    ```ini
    _meta = cloud_provider::aws
    ```

4. Restart Splunkd.
5. Enable the input again on the add-on's **Inputs** page.

The line is per instance: the Deployment Server does not manage the Splunk Add-on for AWS, so it neither pushes nor removes it. Events the input read before the line was in place keep no `cloud_provider`; inside the LogServ App's dashboards they count as `aws` anyway ([Events without a stamp](#events-without-a-stamp)).

!!! note "What has been tested"
    In the lab, adding this line to existing SQS-Based S3 stanzas and restarting Splunkd worked: the events read afterwards carried a single `aws`. The full create, disable, edit, restart, enable sequence has not been run end to end on Splunk Add-on for AWS 8.3.1, and whether a later edit of the input in the add-on's form keeps a hand-added `_meta` line is not known. Check the stanza after any edit of the input, and check the result with the search in [Check the Result](#check-the-result).

<br>

### :material-circle-box:{ .taiconcolor } Alternative for AWS-Only Fleets: the Dropdown Set to AWS { #alternative-the-dropdown-set-to-aws }

On a fleet that ingests only from AWS and **never** uses the AWS S3 Direct screen, you can instead set the dropdown to **AWS** and leave the SQS-Based S3 inputs without `_meta`. The Data TA then stamps `aws` on every event it processes.

!!! warning "Not with AWS S3 Direct, and not with a second cloud"
    - **AWS S3 Direct** stamps every backfill input `_meta = cloud_provider::aws`, without checking the dropdown, so with the dropdown on **AWS** a backfilled event gets `aws` from both, and can carry it twice (`mvcount(cloud_provider)` = 2), as described in [What Gets Stamped](#what-gets-stamped); this same-value case has not been reproduced in the lab.
    - **Before you add another cloud or load history with AWS S3 Direct,** switch to the recommended setup: set the dropdown to **Not set** and add the `_meta` line to every SQS-Based S3 input. Events indexed earlier under the dropdown keep their single `aws`.
    - Never set the dropdown to **Microsoft Azure** or **Google Cloud Platform** where the LogServ Azure or GCP add-on runs.

<br>

### :material-circle-box:{ .taiconcolor } With a Deployment Server { #with-a-deployment-server }

The dropdown's value is written into the Data TA's `local/transforms.conf`, which the Deployment Server pushes to every forwarder in the `SAP_LogServ_HeavyForwarders` server class, so one value applies to all of them. To change it, **Save** the Cloud Provider tab on the Deployment Server, then click **Deploy to Forwarders**, as on the Filters tab ([Distribute the Data TA](distribute-data-ta.md)). The per-input `_meta` lines are per heavy forwarder and are not touched by the push.

On a single instance, or a heavy forwarder without a Deployment Server, the Save takes effect on that instance at once.

!!! warning "More than one cloud"
    The Cloud Provider dropdown is a Data-TA-wide setting: it stamps the same value on every event that instance's Data TA processes. If a **single** heavy forwarder ingests from more than one cloud (any mix of AWS S3, Azure Blob Storage and Google Cloud Storage), the dropdown cannot tell the channels apart, and because the `sap_logserv_azure_queue` and `sap_logserv_gcp_pubsub` inputs already carry their own `_meta` values, a dropdown value would tag their events with both values. Leave the dropdown at **Not set** and attribute per input: set `_meta = cloud_provider::aws` on the Splunk Add-on for AWS SQS-Based S3 inputs; the Azure and GCP inputs already attribute their own events. With the dropdown at **Not set** the Data TA adds no `cloud_provider` value of its own, so each input's `_meta` value is the only one written.

    This applies when each cloud has its own forwarders too. With a Deployment Server, every forwarder in the `SAP_LogServ_HeavyForwarders` server class receives the same dropdown value, so **AWS** would also be stamped on the events of a forwarder that reads only Azure or GCP. See [Capacity Planning → More Than One Cloud](../getting-started/capacity-planning.md#more-than-one-cloud) for when to give each cloud its own forwarders.

<br>

### :material-circle-box:{ .taiconcolor } Splunk Cloud Without a Heavy Forwarder { #splunk-cloud-without-a-heavy-forwarder }

When the inputs run on the Splunk Cloud search head, you cannot edit `Splunk_TA_aws/local/inputs.conf`. The per-input route there is a REST write to the input's stanza through `configs/conf-inputs`, the same call the AWS S3 Direct screen makes for its own inputs. It needs a role with the `admin_all_objects` capability, which splunkd requires for `configs/conf-*` writes, and REST access to your stack's search head API on port 8089. Splunk Cloud opens that port only to the subnets on your stack's `search-api` IP allow list, which is closed by default; add your address with the Admin Config Service (ACS), for example `acs ip-allowlist create search-api --subnets "<your address>/32"`. Then:

```bash
curl -u <admin_user> \
  "https://<your-stack>.splunkcloud.com:8089/servicesNS/nobody/Splunk_TA_aws/configs/conf-inputs/aws_sqs_based_s3%3A%2F%2F<input_name>" \
  -d "_meta=cloud_provider::aws"
```

Then disable the input and enable it again on the add-on's **Inputs** page, so it starts again from the stanza as written. The same `configs/conf-inputs` write stamps the AWS S3 Direct screen's Generic S3 inputs, and that has been checked on a heavy forwarder with Splunk Add-on for AWS 8.3.1; this route for an SQS-Based S3 input, and on Splunk Cloud, has not been tested. Without it, and with the dropdown at **Not set**, the SQS-Based S3 events carry no `cloud_provider`: the LogServ App's dashboards still count them as `aws`, but your own searches do not ([Events without a stamp](#events-without-a-stamp)). See [Splunk Cloud Considerations](../getting-started/splunk-cloud.md) for the capability.

<br>

### :material-circle-box:{ .taiconcolor } Events Without a Stamp { #events-without-a-stamp }

The LogServ App ships a search-time macro, `sap_logserv_cloud_provider_default_macro`, defined as:

```spl
eval cloud_provider=coalesce(cloud_provider, "aws")
```

The App's dashboards count events that have no `cloud_provider` as `aws`: their rollups apply the same `coalesce`, and the global Cloud filter treats a missing value as AWS. This covers events indexed before the field existed, and AWS events from inputs without `_meta`, in dashboards such as [Multi-Cloud Overview](../logserv-app/dashboards/platform/multi-cloud-overview.md).

It is not a global default. Outside the App's dashboards (your own searches, Enterprise Security content, a `cloud_provider=aws` filter) an unstamped event has no `cloud_provider` value at all, and `tstats ... by cloud_provider` leaves such events out unless you give it a `fillnull_value` (before the `count`). Stamping at index time, as recommended above, makes the field usable everywhere.

<br>

### :material-circle-box:{ .taiconcolor } Check the Result { #check-the-result }

After the first events arrive, check that every event carries exactly one provider, using the index name (the App's macros may not exist yet on your search head):

```spl
| tstats fillnull_value="(none)" count where index=sap_logserv_logs earliest=-24h by cloud_provider, sourcetype
```

```spl
index=sap_logserv_logs earliest=-30d _index_earliest=-15m
| eval cloud_provider_values=mvcount(cloud_provider)
| fillnull value=0 cloud_provider_values
| stats count by cloud_provider_values
```

`(none)` in the first search means an input without `_meta` (and the dropdown at **Not set**). The second counts the events indexed in the last 15 minutes, whatever their event time, so it also works while an input drains a backlog ([Verify Your Data, check 3](../getting-started/verify-data.md#3-one-cloud-value-per-event)): `0` is an event without a stamp, and any `2` means the dropdown is set while inputs carry their own `_meta`: set the dropdown to **Not set** and deploy. Events already indexed keep their values.

<br>

## :material-circle-box:{ .cboxmove } Next Steps

1. [Decide Filtering](decide-filtering.md): the other index-time choice to make before the first Save.
2. [Distribute the Data TA to Heavy Forwarders](distribute-data-ta.md), if a Deployment Server manages them.
