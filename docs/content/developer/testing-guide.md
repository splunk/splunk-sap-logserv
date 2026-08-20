# Clean Deployment Test Guide

## :material-circle-box:{ .taiconcolor } Overview

This guide walks through a full clean-slate test of the SAP LogServ packages:

- **Data TA** (`splunk_ta_sap_logserv`) -- installed on the DS and pushed to HFs
- **LogServ App** (`splunk_app_sap_logserv`) -- installed on the SH only

Azure Blob or GCS ingest additionally requires the **LogServ Azure add-on** (`splunk_ta_sap_logserv_azure`) or **LogServ GCP add-on** (`splunk_ta_sap_logserv_gcp`), installed directly on each HF — never via the DS, because a DS push overwrites the add-on's own `local/` where its SAS token / service-account key lives. This guide's phases cover the AWS SQS-based channel; repeat the ingest-verification phases against the queue-driven channel when a cloud add-on is in scope.

The test validates the complete workflow: install, DS automation, filter configuration, deployment push, data ingestion, and filter verification.

## :material-circle-box:{ .taiconcolor } Prerequisites

- **DS** (Deployment Server) -- also serves as SH/Indexer combo in this test topology
- **HF-01**, **HF-02** -- Heavy Forwarders configured as deployment clients
- Both HFs have AWS TA SQS-Based S3 inputs configured (disabled until Phase 6)
- UCC-built Data TA `.tar.gz` package ready for installation
- LogServ App `.tar.gz` package ready for installation

---

## Part 1: Clean Slate Setup

### On the DS

```bash
# Switch to splunk user
sudo su - splunk

# Remove the Data TA
rm -rf /opt/splunk/etc/apps/splunk_ta_sap_logserv

# Remove the deployment-apps copy
rm -rf /opt/splunk/etc/deployment-apps/splunk_ta_sap_logserv

# Remove serverclass.conf files
rm -f /opt/splunk/etc/system/local/serverclass.conf
rm -f /opt/splunk/etc/apps/search/local/serverclass.conf

# Delete the server class via REST (ignore errors if it doesn't exist)
curl -sk -u admin:$SPLUNK_PASSWORD -X DELETE \
  "https://localhost:8089/services/deployment/server/serverclasses/SAP_LogServ_HeavyForwarders" 2>/dev/null

# Remove cached files
rm -rf /opt/splunk/var/run/splunk/dispatch/splunk_ta_sap_logserv* 2>/dev/null

# Exit splunk user
exit
```

If also testing the LogServ App:

```bash
sudo su - splunk
rm -rf /opt/splunk/etc/apps/splunk_app_sap_logserv
exit
```

Restart Splunk:

```bash
sudo systemctl restart Splunkd
```

### On Each HF (HF-01 and HF-02)

```bash
sudo su - splunk
rm -rf /opt/splunk/etc/apps/splunk_ta_sap_logserv
exit
sudo systemctl restart Splunkd
```

### Verify Clean Slate

On the DS:

```bash
sudo su - splunk
ls /opt/splunk/etc/apps/splunk_ta_sap_logserv 2>/dev/null
ls /opt/splunk/etc/deployment-apps/splunk_ta_sap_logserv 2>/dev/null
find /opt/splunk/etc -name "serverclass.conf" -path "*/local/*" 2>/dev/null | xargs cat 2>/dev/null
```

All should return nothing.

On each HF:

```bash
sudo su - splunk
ls /opt/splunk/etc/apps/splunk_ta_sap_logserv 2>/dev/null
```

Should return nothing.

---

## Part 2: Deployment Test Phases

### Phase 1: Install the Data TA on the DS

1. Log into Splunk Web on the DS
2. Go to **Apps > Manage Apps > Install app from file**
3. Upload the Data TA `.tar.gz` file and install
4. Restart Splunk when prompted

### Phase 2: Install the LogServ App on the SH

1. Log into Splunk Web on the SH (same host as DS in combo topology)
2. Go to **Apps > Manage Apps > Install app from file**
3. Upload the LogServ App `.tar.gz` file and install
4. Restart Splunk when prompted

### Phase 3: Configure Filters and Trigger DS Automation

1. Go to the Data TA > **Configuration > Filters** tab
2. Enable filtering, set include/exclude patterns and Days in Past
3. Click **Save**
4. After the page reloads, verify you see:
    - The **"Deployment Server Detected"** banner
    - The **"Server Class Setup Required"** notice
    - The **"Deploy to Forwarders"** button

### Phase 3b: Configure the Cloud Provider Tab

1. Go to **Configuration > Cloud Provider**, set the value matching this deployment's ingest channel (AWS / Microsoft Azure / Google Cloud Platform — or **Not set** on a mixed HF where per-input `_meta` attribution is used), and **Save**
2. Verify the generated `[logserv_set_cloud_provider]` block appears in `local/transforms.conf` between the `### BEGIN LOGSERV CLOUD_PROVIDER CONFIG ###` markers
3. In Part 3 below, confirm the **Multi-Cloud Overview** dashboard reflects the choice

### Phase 4: Verify DS Automation

Confirm the Data TA was copied to deployment-apps:

```bash
sudo su - splunk
ls /opt/splunk/etc/deployment-apps/splunk_ta_sap_logserv/
```

Confirm filter configs were mirrored:

```bash
cat /opt/splunk/etc/deployment-apps/splunk_ta_sap_logserv/local/transforms.conf
```

Confirm the server class was created:

```bash
find /opt/splunk/etc -name "serverclass.conf" -path "*/local/*" 2>/dev/null | xargs cat
```

You should see both stanzas:

- `[serverClass:SAP_LogServ_HeavyForwarders]`
- `[serverClass:SAP_LogServ_HeavyForwarders:app:splunk_ta_sap_logserv]` with `restartSplunkd = true` and `stateOnClient = enabled`

### Phase 5: Configure the Server Class and Deploy

1. Go to **Settings > Forwarder Management**
2. Find `SAP_LogServ_HeavyForwarders`
3. Click the three-dot menu > **Edit agent assignment**
4. Add client targeting using HF IP addresses
5. Save the agent assignment
6. Return to the Filters tab -- the "Server Class Setup Required" notice should be gone
7. Click **"Deploy to Forwarders"** and confirm

### Phase 6: Verify HFs Received the Data TA

Wait for HFs to phone home (default interval is 30-60 seconds), then verify:

```bash
# On each HF
sudo su - splunk
ls /opt/splunk/etc/apps/splunk_ta_sap_logserv/
cat /opt/splunk/etc/apps/splunk_ta_sap_logserv/local/transforms.conf
```

Confirm both HFs show as active clients in **Settings > Forwarder Management** under the server class.

### Phase 7: Enable Ingestion and Test Filtering

1. Enable the SQS-Based S3 inputs on both HFs (these are in the AWS TA, not the Data TA)
2. Wait a few minutes for data to flow
3. On the SH, search for incoming data:

```spl
`sap_logserv_idx_macro` | stats count by host, sourcetype
```

4. Verify included log types are indexed:

```spl
`sap_logserv_idx_macro` | stats count by sourcetype
```

5. Verify excluded log types are NOT present (if you set any excludes)

6. Verify time filtering -- search for events older than your Days in Past cutoff:

```spl
`sap_logserv_idx_macro` earliest=-30d latest=-10d | stats count
```

This should return 0 results if your Days in Past is less than 10.

### Phase 8: Test Filter Update Round-Trip

1. On the DS Filters tab, change a filter setting (e.g., add an exclude pattern) and Save
2. Click **"Deploy to Forwarders"** again
3. After phone-home, verify on both HFs that `local/transforms.conf` reflects the updated filter
4. Confirm the new filter is working as expected in search results

---

## Part 3: Dashboard Verification

After data is flowing, verify the LogServ App dashboards:

1. **Seed the rollup collections.** The dashboards read hourly KV-Store rollups, which are empty on a fresh install. Go to **Settings → Dashboard Data** and click **Run backfill** (idempotent, resumable, seeds 30 days of history). Without this, most panels render empty and the deployment will look broken even though ingest succeeded.
2. Navigate to the **LogServ App** in Splunk Web
3. Walk the nav menus (Home / Applications / Integration / Security / Platform / Topology) and confirm each dashboard renders — start with **Environment Health**, the default landing view. A quick spot-check sample:
    - **Data Pipeline Overview** -- shows host event counts and sourcetype distribution
    - **DNS Analytics** -- shows DNS query patterns (requires `isc:bind:query` data)
    - **HANA Audit** -- shows HANA audit events (requires `sap:hana:audit` data)
    - **Web Dispatcher** (Integration) -- shows HTTP traffic (requires `sap:webdispatcher:access` data)
    - **Host Details** -- drill down from Overview by clicking a host row
4. A panel that legitimately has no data explains itself inline — click **"Why is this empty?"** to open the Data Doctor drawer

!!! tip "Time range"
    Set the Global Time Range to **All time** or an appropriate window that covers your test data. Rolled-up panels read hourly buckets, so a freshly ingested hour is not summarised yet — use a window covering completed hours of test data, and remember windows under 90 minutes automatically fall back to the exact raw query.

---

## Cleanup Scripts

Automated cleanup scripts are available at `tools/testing_cleanup_scripts/`:

| Script | Target | Purpose |
|--------|--------|---------|
| `run_all_cleanups.sh` | Local (orchestrator) | SCPs and runs all cleanup scripts |
| `cleanup_heavy_forwarder.sh` | HF-01, HF-02 | Removes Data TA from HFs |
| `cleanup_deploy_server.sh` | DS | Removes Data TA from apps/ and deployment-apps/ |
| `cleanup_sh_idxr.sh` | SH/Indexer | Removes Data TA + LogServ App for clean reinstall |

All scripts use `systemctl` for Splunk management. Run from local Git Bash:

```bash
cd tools/testing_cleanup_scripts && bash run_all_cleanups.sh
```
