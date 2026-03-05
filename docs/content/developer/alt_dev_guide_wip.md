# SAP LogServ TA — Clean Deployment Server Test Guide

## Prerequisites

- Three EC2 instances: DS (SH-Indexer-DS combo), HF-01, HF-02
- Both HFs configured as deployment clients pointing to the DS
- Both HFs have AWS TA SQS-Based S3 inputs configured (disabled)
- UCC-built `.tar.gz` package ready for installation

---

## Part 1: Clean Slate Setup

### On the DS (SH-Indexer-DS-Combo)

1. Switch to splunk user:

```bash
sudo -u splunk bash

```

2. Remove the TA from the apps directory:

```bash
rm -rf /opt/splunk/etc/apps/splunk_ta_sap_logserv

```

3. Remove the deployment-apps copy:

```bash
rm -rf /opt/splunk/etc/deployment-apps/splunk_ta_sap_logserv

```

4. Remove any serverclass.conf files referencing the TA:

```bash
rm /opt/splunk/etc/system/local/serverclass.conf
rm /opt/splunk/etc/apps/search/local/serverclass.conf

```

5. Delete the server class via REST (ignore errors if it doesn't exist):
   
```bash
curl -sk -u admin:<password> -X DELETE "https://localhost:8089/services/deployment/server/serverclasses/SAP_LogServ_HeavyForwarders" 2>/dev/null

```

6. Remove any web.conf hotpatch:
   
```bash
rm -f /opt/splunk/etc/apps/splunk_ta_sap_logserv/local/web.conf 2>/dev/null

```

7. Clear cached files:
   
```bash
rm -rf /opt/splunk/var/run/splunk/dispatch/splunk_ta_sap_logserv* 2>/dev/null

```

8. Restart Splunk:
   
```bash
sudo /opt/splunk/bin/splunk restart
```

### On Each HF (HF-01 and HF-02)

1. Remove the TA:

```bash
rm -rf /opt/splunk/etc/apps/splunk_ta_sap_logserv

```

2. Restart Splunk:

```bash
sudo /opt/splunk/bin/splunk restart

```
   
```bash
sudo systemctl restart Splunkd

```

### Verify Clean Slate

On the DS:
```bash
ls /opt/splunk/etc/apps/splunk_ta_sap_logserv 2>/dev/null
ls /opt/splunk/etc/deployment-apps/splunk_ta_sap_logserv 2>/dev/null
find /opt/splunk/etc -name "serverclass.conf" -path "*/local/*" 2>/dev/null | xargs cat 2>/dev/null
```

All should return nothing.

On each HF:
```bash
ls /opt/splunk/etc/apps/splunk_ta_sap_logserv 2>/dev/null
```

Should return nothing.

---

## Part 2: Deployment Test Phases

### Phase 1: Install the TA on the Deployment Server

1. Log into Splunk Web on the DS
2. Go to **Apps → Manage Apps → Install app from file**
3. Upload the LogServ TA `.tar.gz` file and install
4. Restart Splunk when prompted

### Phase 2: Configure Filters and Trigger Deployment Automation

5. Go to the LogServ TA → **Configuration → Filters** tab
6. Enable Filtering, set your include/exclude patterns and Days in Past
7. Click **Save**
8. After the page reloads, verify you see:
   - The **"⚠ Deployment Server Detected"** banner
   - The **"⚙ Server Class Setup Required"** notice
   - The **"Deploy to Forwarders"** button

### Phase 3: Verify Automation Ran Correctly

9. Confirm the TA was copied to deployment-apps:

```bash
ls /opt/splunk/etc/deployment-apps/splunk_ta_sap_logserv/

```

10. Confirm filter configs were mirrored:

```bash
cat /opt/splunk/etc/deployment-apps/splunk_ta_sap_logserv/local/transforms.conf
cat /opt/splunk/etc/deployment-apps/splunk_ta_sap_logserv/local/props.conf

```

11. Confirm the server class and app mapping were created:
    
```bash
find /opt/splunk/etc -name "serverclass.conf" -path "*/local/*" 2>/dev/null | xargs cat

```
You should see both stanzas:
- `[serverClass:SAP_LogServ_HeavyForwarders]`
- `[serverClass:SAP_LogServ_HeavyForwarders:app:splunk_ta_sap_logserv]` with `restartSplunkd = true` and `stateOnClient = enabled`

### Phase 4: Configure the Server Class

12. Go to **Settings → Forwarder Management**
13. Find `SAP_LogServ_HeavyForwarders`
14. Click the three-dot menu → **Edit agent assignment**
15. Add client targeting using HF IP addresses (e.g., `172.31.6.18, 172.31.4.185`)
16. Save the agent assignment
17. Return to the Filters tab — the "Server Class Setup Required" / "Client Targeting Needed" notice should be gone

### Phase 5: Deploy to Forwarders

18. Click **"Deploy to Forwarders"** in the Filters tab and confirm
19. Wait for HFs to phone home (check interval with `grep phoneHomeIntervalInSecs /opt/splunk/etc/system/default/deploymentclient.conf` on an HF — default is typically 30-60 seconds)
20. Verify the TA arrived on both HFs:
    
```bash
ls /opt/splunk/etc/apps/splunk_ta_sap_logserv/
cat /opt/splunk/etc/apps/splunk_ta_sap_logserv/local/transforms.conf
cat /opt/splunk/etc/apps/splunk_ta_sap_logserv/local/props.conf

```

21. Confirm both HFs show as active clients in **Settings → Forwarder Management** under the server class (status may show "Pending" briefly until the HFs restart, then "Ok")

### Phase 6: Enable Ingestion and Test Filtering

22. Enable the SQS-Based S3 inputs on both HFs
23. Wait a few minutes for data to flow
24. On the DS/Search Head, search for incoming data:

```
index=* sourcetype=sap:logserv:* | stats count by host, sourcetype

```

25. Verify included log types are being indexed:

```
index=* sourcetype=sap:logserv:* | stats count by clz_dir, clz_subdir

```

26. Verify excluded log types are NOT present (if you set any excludes)

27. Verify time filtering — search for events older than your Days in Past cutoff:

```
index=* sourcetype=sap:logserv:* earliest=-30d latest=-10d

```
This should return no results if your Days in Past is less than 10.

### Phase 7: Test Filter Update Round-Trip

28. On the DS Filters tab, change a filter setting (e.g., add an exclude pattern) and Save

29. Click **"Deploy to Forwarders"** again

30. After phone-home, verify on both HFs that `local/transforms.conf` reflects the updated filter

31. Confirm the new filter is working as expected in search results
