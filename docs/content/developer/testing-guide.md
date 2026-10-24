# Clean Deployment Test (Lab)

This is a lab procedure for developers and testers: it installs the Data TA and the LogServ App on a clean test deployment and checks every step from the Deployment Server automation to the dashboards. Run it on test instances only, never on a production Deployment Server, heavy forwarder or search head.

## :material-circle-box:{ .taiconcolor } What the Test Covers

The test installs two packages:

- **Data TA** (`splunk_ta_sap_logserv`) -- installed on the Deployment Server (DS) and pushed to the heavy forwarders (HFs)
- **LogServ App** (`splunk_app_sap_logserv`) -- installed on the search head only

It checks the install, the DS automation, the filter configuration, the push to the forwarders, data ingest, filtering and the dashboards. The phases below use the AWS SQS-Based S3 channel. [Other Ingest Channels](#other-ingest-channels) lists what to check when the LogServ Azure add-on, the LogServ GCP add-on or the AWS S3 Direct screen is in scope.

## :material-circle-box:{ .taiconcolor } Prerequisites

- A **Deployment Server**. In a small lab it can also be the search head and indexer.
- **HF-01** and **HF-02**: heavy forwarders that are already deployment clients of the DS. The Data TA detects a DS by its `deployment_server` role, which Splunk shows only while at least one server class exists. On a DS that has no server class yet, the Data TA detects the DS only through a connected deployment client, so connect the HFs before Phase 3.
- On both HFs, the Splunk Add-on for AWS with SQS-Based S3 inputs configured and **disabled** until [Phase 7](#phase-7-enable-ingestion-and-test-filtering).
- The two indexes, `sap_logserv_logs` and `logserv_ai_assistant_audit`, on the indexer. When the indexer is the DS, the Data TA's `default/indexes.conf` creates them there.
- A Data TA `.tar.gz` and a LogServ App `.tar.gz`: the release tarballs, or builds made as described in [Building the Packages from Source](build-from-source.md).

---

## :material-circle-box:{ .taiconcolor } Part 1: Clean Slate Setup

### :material-circle-box:{ .taiconcolor } On the DS

Remove only the LogServ packages and the LogServ server class. Do not delete `serverclass.conf` files: they hold every other server class on the DS.

1. Remove the Data TA and its deployment-apps copy:

    ```bash
    sudo su - splunk
    rm -rf /opt/splunk/etc/apps/splunk_ta_sap_logserv
    rm -rf /opt/splunk/etc/deployment-apps/splunk_ta_sap_logserv
    exit
    ```

2. In Splunk Web on the DS, open **Settings > Forwarder Management** (named **Agent Management** in newer Splunk Enterprise versions) and delete the `SAP_LogServ_HeavyForwarders` server class if it exists. This lets the test watch the Data TA create the class again.

3. If the test also covers the LogServ App, and the App is installed on this instance, remove it:

    ```bash
    sudo su - splunk
    rm -rf /opt/splunk/etc/apps/splunk_app_sap_logserv
    exit
    ```

    Removing the App's directory does not remove its KV Store data: the dashboard rollups, the topology data and the AI Assistant settings stay in the KV Store and appear again when the App is reinstalled. If the test needs empty rollups, click **Clear all data** on the App's **Settings > Dashboard Data** tab before you remove the App.

4. Restart Splunk (on a systemd-managed install: `sudo systemctl restart Splunkd`).

### :material-circle-box:{ .taiconcolor } On Each HF (HF-01 and HF-02)

```bash
sudo su - splunk
rm -rf /opt/splunk/etc/apps/splunk_ta_sap_logserv
exit
sudo systemctl restart Splunkd
```

### :material-circle-box:{ .taiconcolor } Verify the Clean Slate

On the DS:

```bash
sudo su - splunk
ls /opt/splunk/etc/apps/splunk_ta_sap_logserv 2>/dev/null
ls /opt/splunk/etc/deployment-apps/splunk_ta_sap_logserv 2>/dev/null
find /opt/splunk/etc -name "serverclass.conf" -path "*/local/*" 2>/dev/null | xargs grep -n "SAP_LogServ_HeavyForwarders" 2>/dev/null
```

All three should return nothing.

On each HF:

```bash
sudo su - splunk
ls /opt/splunk/etc/apps/splunk_ta_sap_logserv 2>/dev/null
```

This should return nothing.

---

## :material-circle-box:{ .taiconcolor } Part 2: Deployment Test Phases

### :material-circle-box:{ .taiconcolor } Phase 1: Install the Data TA on the DS

1. Sign in to Splunk Web on the DS.
2. Go to **Apps > Manage Apps > Install app from file**.
3. Upload the Data TA `.tar.gz` file and install it.
4. Restart Splunk when prompted.

### :material-circle-box:{ .taiconcolor } Phase 2: Install the LogServ App on the Search Head

1. Sign in to Splunk Web on the search head (the DS itself in a combined lab topology).
2. Go to **Apps > Manage Apps > Install app from file**.
3. Upload the LogServ App `.tar.gz` file and install it.
4. Restart Splunk when prompted.

### :material-circle-box:{ .taiconcolor } Phase 3: Configure Filters and Trigger the DS Automation

1. On the DS, open the Data TA (**Splunk TA for SAP LogServ**) > **Configuration > Filters**.
2. Turn on **Enable Filtering** and set rules that exercise every field. For example:
    - **Include Filters**: `linux/*` (a list that is not pass-all, so the include gate is on)
    - **Exclude Filters**: `linux/cron`
    - **Include Sources**: `/usr/sap/*/HDB*/*/trace/*.trc` (keeps HANA trace files although their folder is not included, and HANA trace events that arrive without folder fields)
    - **Exclude Sources**: one file path you see in the test data under an included folder
    - **Days in the Past**: `7`

    Choose **Days in the Past** so the test data has events on both sides of the cutoff. The filter drops every event whose embedded `_time` epoch is older than midnight UTC N days ago, and data copied from an archive bucket keeps its original dates: if all of it is older than the cutoff, every event is dropped and Phase 7 finds no data. In that case set `0` (no time filter), skip step 6 of Phase 7, and test the time filter separately with data newer than the cutoff.

3. Click **Save**.
4. After the page reloads, check that you see:
    - the **Deployment Server Detected** banner
    - the **Server Class Setup Required** notice
    - the **Deploy to Forwarders** button

The Filters tab refuses Include Sources while Include Filters is pass-all (empty, or holding `*/*` or `*`), because the rule would have no effect. See [Configuring Filters](../install-setup/configure-filters.md) for the rule syntax.

### :material-circle-box:{ .taiconcolor } Phase 3b: Set the Cloud Attribution

1. Leave **Configuration > Cloud Provider** at **Not set** (the default).
2. On each HF, add `_meta = cloud_provider::aws` to every `aws_sqs_based_s3://` input stanza that reads LogServ data, in `Splunk_TA_aws/local/inputs.conf`, and restart the HF. See [Choose Cloud Attribution](../install-setup/cloud-attribution.md).
3. In `local/transforms.conf` of the Data TA on the DS, check that there is no `[logserv_set_cloud_provider]` stanza: with **Not set** the Data TA writes none.

To test the dropdown itself, set it to **AWS** on an AWS-only test fleet, Save, and check that `local/transforms.conf` now holds the `[logserv_set_cloud_provider]` stanza between `### BEGIN LOGSERV CLOUD_PROVIDER CONFIG - DO NOT EDIT MANUALLY ###` and `### END LOGSERV CLOUD_PROVIDER CONFIG ###`. Set it back to **Not set** and Save before Phase 5, or remove the `_meta` lines from the HF inputs instead: the dropdown adds its value beside an input's own `_meta` without checking it, so using both writes the stamp twice. The dropdown's value reaches the HFs only with a push: if you have already deployed, Save **Not set** and click **Deploy to Forwarders** again.

### :material-circle-box:{ .taiconcolor } Phase 4: Verify the DS Automation

Confirm the Data TA was copied to deployment-apps:

```bash
sudo su - splunk
ls /opt/splunk/etc/deployment-apps/splunk_ta_sap_logserv/
```

Confirm the filter configuration was mirrored:

```bash
cat /opt/splunk/etc/deployment-apps/splunk_ta_sap_logserv/local/transforms.conf
cat /opt/splunk/etc/deployment-apps/splunk_ta_sap_logserv/local/props.conf
```

Confirm the server class was created:

```bash
find /opt/splunk/etc -name "serverclass.conf" -path "*/local/*" 2>/dev/null | xargs grep -n -A3 "SAP_LogServ_HeavyForwarders"
```

You should see both stanzas:

- `[serverClass:SAP_LogServ_HeavyForwarders]`
- `[serverClass:SAP_LogServ_HeavyForwarders:app:splunk_ta_sap_logserv]` with `restartSplunkd = true` and `stateOnClient = enabled`

The full copy to deployment-apps happens only when no copy exists yet, or when the `[launcher] version` in `default/app.conf` differs between `etc/apps/` and `etc/deployment-apps/`. A later build with the same version number is not copied; see [Data TA Internals](data-ta-internals.md#deployment-apps-sync).

### :material-circle-box:{ .taiconcolor } Phase 5: Configure the Server Class and Deploy

1. Go to **Settings > Forwarder Management** (named **Agent Management** in newer Splunk Enterprise versions).
2. Find `SAP_LogServ_HeavyForwarders`.
3. Click the three-dot menu > **Edit agent assignment**.
4. Add client targeting that matches the two HFs (for example their IP addresses).
5. Save the agent assignment. In the lab, saving it also enabled the server class; if the class still shows as disabled, enable it.
6. Return to the Filters tab and refresh the page: the **Server Class Setup Required** notice should be gone.
7. Click **Deploy to Forwarders** and confirm.

**Deploy to Forwarders** reloads the whole Deployment Server (`/services/deployment/server/config/_reload`), not only this server class, so any other server class with pending changes is pushed as well.

### :material-circle-box:{ .taiconcolor } Phase 6: Verify the HFs Received the Data TA

Each HF downloads the change at its next phone-home (`phoneHomeIntervalInSecs`, 60 seconds by default) and then restarts, because the app is mapped with `restartSplunkd = true`. Allow 5 minutes or more, then check:

```bash
# On each HF
sudo su - splunk
ls /opt/splunk/etc/apps/splunk_ta_sap_logserv/
cat /opt/splunk/etc/apps/splunk_ta_sap_logserv/local/transforms.conf
```

Confirm both HFs show as clients of the server class in **Settings > Forwarder Management**.

### :material-circle-box:{ .taiconcolor } Phase 7: Enable Ingestion and Test Filtering

1. Enable the SQS-Based S3 inputs on both HFs (they belong to the Splunk Add-on for AWS, not the Data TA).
2. Wait a few minutes for data to flow.
3. On the search head, search for incoming data:

    ```spl
    `sap_logserv_idx_macro` | stats count by host, sourcetype
    ```

4. Check that the included log types are indexed, and that the files kept by Include Sources arrive:

    ```spl
    `sap_logserv_idx_macro` | stats count by sourcetype, source
    ```

5. Check that the excluded folder (`linux/cron` in the example) and the file named in Exclude Sources do not arrive, while the other files of the same folder still do.
6. Check the time filter. Search for events older than your **Days in the Past** cutoff that were ingested while the filter was on:

    ```spl
    `sap_logserv_idx_macro` earliest=-30d latest=-10d | stats count
    ```

    With **Days in the Past** below 10 this returns 0, apart from events indexed before the filter was deployed. The filter compares the `_time` epoch inside each event with midnight UTC N days ago, not the S3 object date.

7. Check the cloud attribution. Every event should carry exactly one value:

    ```spl
    `sap_logserv_idx_macro` | eval n=mvcount(cloud_provider) | stats count by cloud_provider, n
    ```

### :material-circle-box:{ .taiconcolor } Phase 8: Test a Filter Update Round Trip

1. On the DS Filters tab, change a filter setting (for example add an Exclude Filters pattern) and Save.
2. Click **Deploy to Forwarders** again.
3. After the next phone-home and restart, check on both HFs that `local/transforms.conf` holds the updated filter.
4. Check that the new filter works in the search results.
5. Widen the include list before Part 3. With the example filter, Include Filters keeps only `linux/*`, so DNS, HANA audit and Web Dispatcher events are dropped and their dashboards stay empty. Add `dns/*, hana/*, webdispatcher/*` to **Include Filters** (or turn **Enable Filtering** off), Save, click **Deploy to Forwarders**, and wait for the next phone-home and for new data to flow. Events dropped earlier are not read again, so these dashboards fill only from files that arrive after the push. Do not set Include Filters back to `*/*` while Include Sources holds a pattern: the Filters tab refuses that combination.

---

## :material-circle-box:{ .taiconcolor } Part 3: Dashboard Verification

After data is flowing, check the LogServ App dashboards:

1. **Fill the rollups.** The dashboards read hourly KV Store rollups. The hourly searches fill them from the time the App is installed; earlier test data appears only after a backfill. Go to **Settings > Dashboard Data** and click **Run backfill**. It covers the last 30 days by default; longer presets up to 365 days and a custom UTC date range are available. Without it, the rolled-up panels fill one hour at a time from the next hourly aggregation.
2. Open the **LogServ App** in Splunk Web.
3. Walk the menus (Applications, Integration, Security, Platform, Topology) and confirm each dashboard renders, starting with **Environment Health**, the default landing view. A quick sample:
    - **Data Pipeline Overview** (Platform) -- host event counts and sourcetype distribution
    - **DNS Analytics** (Platform) -- DNS query patterns (needs `isc:bind:query` data)
    - **HANA Audit** (Applications) -- HANA audit events (needs `sap:hana:audit` data)
    - **Web Dispatcher** (Integration) -- HTTP traffic (needs `sap:webdispatcher:access` data)
    - **Host Details** (Platform) -- click a host row on Data Pipeline Overview; Host Details opens in a new tab
4. A panel that has no data for a reason explains itself: click **Why is this empty?** to open the Data Doctor drawer.

!!! tip "Time range"
    Pick a range that covers your test data: one of the presets (Last 24h, Last 7d, Last 30d, Last 90d) or a custom range. Rolled-up panels read hourly buckets, so the current hour is not summarised yet; use a window that covers completed hours of test data. Windows under 90 minutes run the exact raw query instead of the rollup.

---

## :material-circle-box:{ .taiconcolor } Other Ingest Channels

Run Parts 1-3 with these changes when the channel is in scope.

**LogServ Azure add-on or LogServ GCP add-on.** Install the add-on directly on each HF that will run an input, never through the DS: a DS push would replace the add-on's own `local/`, where its encrypted SAS token or service-account key lives. Create one input per queue or subscription, on one HF only; every input keeps its own dedup record, so a second input on the same queue or subscription can index a redelivered message twice. Use a role with `admin_all_objects` to create, edit or delete an input: the add-ons' input handler is expected to refuse other roles, though this has not been tested on these two add-ons (see [The Input Handler](data-ta-internals.md#the-input-handler)). Leave the Data TA's Cloud Provider at **Not set**: the add-on stamps `cloud_provider` itself. Check in Phase 7 that the events carry `cloud_provider=azure` (or `gcp`) with one value. See the [Azure Setup Guide](../install-setup/azure-setup.md) and the [GCP Setup Guide](../install-setup/gcp-setup.md).

**AWS S3 Direct.** On an HF that has both the Data TA and the Splunk Add-on for AWS, open **AWS S3 Direct** in the Data TA's menu, create a backfill for one dashboard row and a short date range, and check that the events arrive with `cloud_provider=aws` (one value). The screen's **Create** button needs `admin_all_objects`; without it the screen offers the generated configuration for an administrator to apply. See [AWS S3 Direct](../install-setup/aws-s3-direct.md).
