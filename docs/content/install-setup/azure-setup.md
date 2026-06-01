# SAP LogServ on Azure — Setup Guide

This page covers setting up the **Splunk for SAP LogServ** solution to ingest LogServ data from **Microsoft Azure Blob Storage**. The downstream pipeline (sourcetype routing, dashboards, ES integration) is identical between AWS and Azure deployments — only the ingest mechanism differs.

!!! note "v0.0.5 release: LLM functionality intentionally disabled pending review"
    The v0.0.5 release ships with the AI Assistant's LLM-driven path **disabled at compile time pending internal review**. The setup procedure on this page applies in full regardless. See [Templates-only Build Flag](../ai-assistant/templates-only-build.md) for details on the LLM disablement.

## :material-circle-box:{ .taiconcolor } Architecture overview

```
SAP LogServ on-prem
  └─> writes NDJSON.gz files to Azure Blob Storage container under logserv/ prefix
        └─> [Splunk Add-on for Microsoft Cloud Services]
              └─> mscs_storage_blob input (polling, prefix-filtered, gzip-aware)
                    └─> sourcetype=sap_logserv_logs
                          └─> LogServ Data TA's transforms.conf routes by clz_dir/clz_subdir
                                └─> per-sourcetype processing
                                      └─> dashboards + ES integration
```

**Architecturally symmetric with AWS.** On AWS, the LogServ Data TA pairs with `Splunk_TA_aws` for S3 ingestion. On Azure, the LogServ Data TA pairs with **Splunk Add-on for Microsoft Cloud Services** for Blob ingestion. Customer-facing setup pattern is identical.

## :material-circle-box:{ .taiconcolor } Prerequisites

### Splunk Add-on for Microsoft Cloud Services

Install on the **Heavy Forwarder tier** (NOT on the Search Head). The add-on does the polling + downloading + event emission; the Search Head only needs the indexed data, not the ingest plumbing.

Minimum version **5.0+** (for KV Store checkpoint + horizontal scaling).

- Splunkbase: <a href="https://splunkbase.splunk.com/app/3110" target="_blank">Splunk Add-on for Microsoft Cloud Services</a>
- Documentation: <a href="https://splunk.github.io/splunk-add-on-for-microsoft-cloud-services/" target="_blank">Official add-on docs</a>

**Recommended deployment pattern** (mirrors how `Splunk_TA_aws` is deployed today on AWS):

| Tier | Add-on placement |
|---|---|
| **Deployment Server** | Place add-on in `/opt/splunk/etc/deployment-apps/Splunk_TA_microsoft-cloudservices/`. Add a stanza for the add-on under your HF server class (e.g., `SAP_LogServ_HeavyForwarders`) in `serverclass.conf` with `restartSplunkd=true` + `stateOnClient=enabled`. |
| **Heavy Forwarders** | Receive the add-on from the DS automatically. Configure inputs locally in `/opt/splunk/etc/apps/Splunk_TA_microsoft-cloudservices/local/` (SAS credentials stay on the HF — do NOT push via DS). |
| **Search Head** | Does NOT have it. |
| **Indexer** | Does NOT have it (forwarded events land here from HFs). |

### Azure resources you'll need

- An **Azure Storage Account** that contains (or will contain) the LogServ Blob container
- A **credential** for the Splunk add-on (see the four [authentication recipes](#authentication-recipes) below)
- Network egress from the Heavy Forwarder to `<account>.blob.core.windows.net` (port 443/HTTPS)

### LogServ container path conventions

The LogServ collector on the SAP side writes blobs to a path matching:

```
<container>/logserv/<clz_dir>/<clz_subdir>/<YYYY>/<MM>/<DD>/<filename>.json.gz
```

Where `<clz_dir>` is one of `abap`, `hana`, `scc`, `sap`, `linux`, `windows`, `proxy`, `dns`, `webdispatcher` and `<clz_subdir>` is the specific log type (e.g., `audit`, `dispatcher`, `tracelogs`, `accesslog`).

This is identical to the AWS S3 path convention.

!!! warning "Compact JSON format required"
    Each blob contains gzipped NDJSON (newline-delimited JSON), one event per line. The LogServ Data TA's index-time routing transforms (which re-route events from the bootstrap `sap_logserv_logs` sourcetype to per-source sourcetypes like `sap:abap:audit`) assume **compact JSON** — no whitespace between `":"` and field values. The SAP LogServ collector emits compact JSON natively. If you build a custom pipeline or rewrite blobs in transit (e.g., for test data), use `json.dumps(obj, separators=(',', ':'))` in Python or equivalent in your language. Pretty-printed JSON (with spaces after colons) will cause events to bypass the transforms and land with `sourcetype=sap_logserv_logs`, breaking dashboards.

## :material-circle-box:{ .taiconcolor } Authentication recipes

The Splunk Add-on for Microsoft Cloud Services supports several credential types. Pick the recipe that fits your security policy:

### Recipe A — SAP-issued SAS token (simplest)

If SAP provides you a Shared Access Signature (SAS) token with read access to the LogServ container, use it directly.

**Required SAS scope:** `sp` (permissions) includes `r` (read) AND `ss` (services) includes `b` (blob). A typical LogServ SAS is account-scoped and covers both Blob and Queue services.

**Setup:**

1. Splunk Web → **Apps** → **Splunk Add-on for Microsoft Cloud Services** → **Configuration** → **Azure Storage Accounts** → **Add**
2. Fill in:
    - **Name:** any identifier (e.g., `logserv_primary`)
    - **Account name:** the storage account name (e.g., `myorglogservprod`)
    - **Account secret type:** Shared access signature
    - **Account secret:** paste the SAS token
    - **Account class type:** Azure public cloud (or Azure government cloud)

**When this fails:** If you see 403 errors on blob downloads in the add-on's logs, the SAS likely lacks blob-read permission. Move to Recipe B.

### Recipe B — Customer-generated Blob SAS (fallback)

If the SAP-issued SAS is queue-only OR your security policy requires per-application credential scoping, generate your own SAS.

**Generate the SAS** (Azure Portal → your Storage Account → **Shared access signature** OR Azure CLI):

```bash
EXPIRY=$(date -u -d '+90 days' +%Y-%m-%dT%H:%MZ)
az storage container generate-sas \
  --account-name <your-storage-account> \
  --name <logserv-container> \
  --permissions rl \
  --expiry $EXPIRY \
  --auth-mode key
```

This produces a container-scoped SAS with read + list permissions, valid for 90 days.

**Configure in Splunk** the same way as Recipe A.

**Rotation:** generate a new SAS before expiry; update the credential in the Splunk add-on.

### Recipe C — Service principal (Entra ID app registration)

For organizations that prefer Azure AD identity-based auth over shared secrets.

1. Azure Portal → **Microsoft Entra ID** → **App registrations** → **New registration** → name it `splunk-logserv-reader`
2. Note the **Application (client) ID** and **Directory (tenant) ID**
3. Under **Certificates & secrets** → create a client secret; save the value
4. Azure Portal → your Storage Account → **Access Control (IAM)** → **Add role assignment**
5. Role: **Storage Blob Data Reader**, Assigned to: the app registration created above
6. Splunk Web → Splunk Add-on for Microsoft Cloud Services → **Configuration** → **Azure App Account** → add the tenant ID, client ID, client secret

**Rotation:** rotate the client secret in Azure AD per your normal rotation policy; update the Splunk add-on's secret.

### Recipe D — Managed identity (Azure VM-hosted HF only)

If your Heavy Forwarder runs on an Azure Virtual Machine, use a system-assigned or user-assigned managed identity — zero credentials stored anywhere.

1. Azure Portal → your HF's Virtual Machine → **Identity** → enable **System assigned** managed identity
2. Azure Portal → your Storage Account → **Access Control (IAM)** → assign **Storage Blob Data Reader** to the VM's managed identity
3. Splunk Web → Splunk Add-on for Microsoft Cloud Services → **Configuration** → choose managed identity authentication

**Use this when:** your HF is on Azure and your security policy prefers zero stored credentials.

## :material-circle-box:{ .taiconcolor } Configuring the storage blob input

Once the storage account credential is configured, create a `mscs_storage_blob` input:

1. Splunk Web → Splunk Add-on for Microsoft Cloud Services → **Inputs** → **Create New Input** → **Storage Blob**
2. Fill in:
    - **Name:** any identifier (e.g., `logserv_azure_input`)
    - **Azure Storage Account:** the credential you configured above
    - **Container Name:** your LogServ container
    - **Prefix:** `logserv/`
    - **Blob Mode:** Random
    - **Blob Compression:** Gzip
    - **Sourcetype:** `sap_logserv_logs`
    - **Index:** `sap_logserv_logs`
    - **Collection Interval:** `300` (5 minutes — see [polling guidance](#polling-cadence) below)

Alternatively, configure via conf files (`local/inputs.conf`):

```ini
[mscs_storage_blob://logserv_azure_input]
account = <credential-stanza-name>
container_name = <your-logserv-container>
prefix = logserv/
blob_mode = random
blob_compression = gzip
collection_interval = 300
worker_threads_num = 4
get_blob_batch_size = 1048576
sourcetype = sap_logserv_logs
index = sap_logserv_logs
dont_reupload_blob_same_size = 1
_meta = cloud_provider::azure
disabled = 0
```

### Why `_meta = cloud_provider::azure`?

This adds an indexed field `cloud_provider=azure` to every event from this input. Search-time queries can then distinguish AWS-sourced vs Azure-sourced data (`cloud_provider=aws` vs `cloud_provider=azure`). Useful for multi-cloud deployments + cross-cloud event correlation in dashboards.

For AWS-sourced events, the parallel setting goes on the `Splunk_TA_aws` SQS-based S3 input. If you want this attribution, set `_meta = cloud_provider::aws` on the AWS input as well.

!!! tip "Alternative: the Data TA Cloud Provider dropdown"
    The LogServ Data TA also exposes a TA-managed way to stamp `cloud_provider` — the **Configuration → Cloud Provider** dropdown (AWS / Microsoft Azure / Not set). Instead of editing `_meta` on each input, set the dropdown once and the Data TA stamps every event it processes. For a Heavy Forwarder that ingests from a **single** cloud, the dropdown is the simpler mechanism and is recommended. Use the per-input `_meta` approach shown above only when a single Heavy Forwarder ingests from BOTH AWS and Azure (the TA-wide dropdown can't distinguish the two channels). See [Configuring Filters → Cloud Provider Attribution](configure-filters.md#cloud-provider-attribution).

### Sourcetype routing happens downstream

The Splunk add-on emits events with `sourcetype = sap_logserv_logs`. **Do not change this.** The LogServ Data TA's `transforms.conf` rules then re-route based on the JSON envelope's `clz_dir` and `clz_subdir` fields:

- `clz_dir=abap, clz_subdir=audit` → `sap:abap:audit`
- `clz_dir=hana, clz_subdir=hanaaudit` → `sap:hana:audit`
- `clz_dir=linux, clz_subdir=messages` → `linux_messages_syslog`
- ...and 24 more

This is the same mechanism that handles AWS-sourced events. Your existing dashboards, search-time field extractions, and ES correlation searches all work unchanged.

## :material-circle-box:{ .taiconcolor } Polling cadence

The Splunk add-on's Blob input is **polling-based**, not event-driven. It periodically lists the container, identifies new blobs via KV-Store-based checkpoint, and downloads them.

### Recommended `collection_interval` by workload

| Workload | Recommended | Rationale |
|---|---|---|
| Latency-sensitive (compliance / SOC) | 60-180 s | Trades small list-op cost for fastest event availability |
| **Default** | **300 s (5 min)** | Matches LogServ's hourly batch cadence well |
| Cost-sensitive | 600-1800 s | Negligible cost difference for LogServ-scale workloads |
| Backfill (initial setup) | 60 s | Drain history quickly; raise to default after backfill done |

Azure Blob LIST operations cost ~$0.0044 per 10,000. Even aggressive polling (60s) for a year costs about $0.23. Cost rarely matters; pick based on latency need.

### Backfill characteristics

On first poll, the input sees all blobs in the container (KV Store checkpoint is empty), enumerates them, and ingests in parallel.

- Backfill duration for a typical 30-day mid-size SAP env: **1-3 hours**
- During backfill, the add-on processes blobs in batches of `worker_threads_num` × `get_blob_batch_size`
- Optional **skip history** approach: pre-populate the KV Store checkpoint to mark all historical blobs as already-processed; the input then starts fresh from "now"

## :material-circle-box:{ .taiconcolor } Time-based filtering

The LogServ Data TA's `days_in_past` filter (set via the Configuration UI) operates at index time on Azure-sourced events — same mechanism as AWS-sourced events.

**Difference from AWS:**

| | AWS | Azure |
|---|---|---|
| Upstream path filter (`days_in_past`) | ✓ S3 sync step rejects old paths | ✗ Blob input prefix is path-based, not date-based |
| Index-time `_time` filter | ✓ | ✓ (unchanged) |
| Net result | Old data never crosses the wire | Old data crosses the wire, gets dropped at index time |

For upstream-bandwidth efficiency on Azure (parallel to what the AWS sync filter provides), use **Azure Blob Storage lifecycle policy**:

1. Azure Portal → your Storage Account → **Lifecycle management** → **Add a rule**
2. Action: **Delete blob** if **Last modified** more than `<your-retention-days>` days ago
3. Filter set: the `logserv/` prefix

This auto-deletes old blobs at the source. Combined with our index-time `_time` filter, you get the same posture as AWS — managed in Azure-native config rather than the LogServ Configuration UI.

## :material-circle-box:{ .taiconcolor } Validation

After configuring the input, verify events flow correctly:

### Confirm the input is registered

Splunk Web → **Settings** → **Data Inputs** → **Microsoft Cloud Services - Storage Blob** → your input should be listed and enabled.

Or via REST:

```bash
curl -sk -u admin:<pwd> \
  'https://localhost:8089/servicesNS/-/Splunk_TA_microsoft-cloudservices/data/inputs/mscs_storage_blob?output_mode=json' \
  | python -m json.tool
```

### Search for ingested events

Wait for one polling cycle, then search:

```spl
index=sap_logserv_logs sourcetype=sap_logserv_logs _index_earliest=-10m | head 5
```

Or by `cloud_provider`:

```spl
index=sap_logserv_logs cloud_provider=azure _index_earliest=-1h | stats count by sourcetype
```

You should see events distributed across the routed sourcetypes (`sap:abap:audit`, `sap:hana:audit`, `linux_messages_syslog`, etc.).

### Check the add-on's logs

If events aren't appearing, inspect:

```bash
sudo tail /opt/splunk/var/log/splunk/splunk_ta_microsoft-cloudservices_storage_blob_<input-name>_B64_*.log
```

Look for:

- `ScanStats(total_scanned=N, filter_matched=N, checkpointer_matched=N, ...)` — confirms blobs are being seen and filtered
- `Total number of blobs processed: N` — confirms downloads succeeded
- HTTP error codes (`401`, `403`) — auth issues; see [Troubleshooting](#troubleshooting)

## :material-circle-box:{ .taiconcolor } Troubleshooting

### "No events appearing"

1. Check the input's `_index_earliest=-1h` search returns recent events. **Search by `_index_earliest`, not `earliest`** — LogServ envelope events have `_time` from when the log was originally written, which may be hours/days ago.
2. Check the add-on's storage_blob log file for `total_scanned > 0` (confirms LIST works) and `Total number of blobs processed > 0` (confirms downloads succeed).
3. If `total_scanned > 0` but `checkpointer_matched = 0` AND `Total number of blobs processed = 0`, the KV Store thinks the blobs are already processed. Verify via:

    ```bash
    curl -sk -u admin:<pwd> \
      'https://localhost:8089/servicesNS/nobody/Splunk_TA_microsoft-cloudservices/storage/collections/data/MSCS_STORAGE_BLOB_checkpoint_collection_<container>___<account>___<sourcetype>?output_mode=json'
    ```

### "Auth errors (401/403)"

Confirm the SAS scope (Recipe A/B) includes `r` (read) AND `b` (blob) AT MINIMUM. Decode the SAS query string and verify:

```bash
echo "$SAS_TOKEN" | tr '&' '\n' | grep -E '^(sp|sr|ss|se)='
```

`sp=` should include `r`; `ss=` should include `b` (or be empty for container-scoped SAS where the path implies blob service).

### "Backfill taking too long"

During initial backfill, tune for throughput:

- Bump `worker_threads_num` to 8-16
- Drop `collection_interval` to 60 s
- After backfill drains, raise interval to 300 s and lower workers to 4

### "Old blobs causing bandwidth waste"

Set the Azure Blob lifecycle policy described in [Time-based filtering](#time-based-filtering) above. Customer-side Azure config, no LogServ-side change.

## :material-circle-box:{ .taiconcolor } Cross-cloud deployments

If you ingest LogServ from both AWS AND Azure:

- Each cloud's ingest pipeline runs independently
- Events from both clouds use `sourcetype = sap_logserv_logs` initially, then route to the same per-source sourcetypes
- Use `cloud_provider = aws | azure` to distinguish in dashboards and queries
- All existing LogServ Data TA features (filter UI, search-time extractions, dashboards) work transparently across both

## :material-circle-box:{ .cboxmove } Next steps

- Confirm the [LogServ App is installed](install-ta.md) on your Search Head
- Review the [supported log types](../getting-started/supported-log-types.md) reference
- For Azure-Splunk Cloud Victoria specific considerations, see [Splunk Cloud Victoria Notes](splunk-cloud-victoria-notes.md)
- For multi-cloud or cross-cloud event correlation, browse the [dashboards](../logserv-app/dashboards/index.md)
