**On the DS (SH-Indexer-DS-Combo):**

1. Remove the TA from the apps directory:
   ```bash
   rm -rf /opt/splunk/etc/apps/splunk_ta_sap_logserv
   ```

2. Remove the deployment-apps copy:
   ```bash
   rm -rf /opt/splunk/etc/deployment-apps/splunk_ta_sap_logserv
   ```

3. Clean up serverclass.conf — remove the `SAP_LogServ_HeavyForwarders` stanzas but **keep the placeholder** (so the DS role stays active):


**NOTE !!! - Test the new option here where we just remove the two serverclass.conf files on the deployment server.**

NEW OPTION START:

```bash
rm /opt/splunk/etc/system/local/serverclass.conf

rm /opt/splunk/etc/apps/search/local/serverclass.conf
```

**NEW OPTION END:**

----

**OLD OPTION START:**

```bash
cat > /opt/splunk/etc/system/local/serverclass.conf << 'EOF'
[global]
disabled = false

[serverClass:placeholder]
disabled = true
EOF
```
**OLD OPTION END:**

Next remove cached references to the `SAP_LogServ_HeavyForwarders` server class via the REST API (stored in a different location).

```bash
curl -sk -u admin:<ADMIN_PASSWORD> -X DELETE "https://localhost:8089/services/deployment/server/serverclasses/SAP_LogServ_HeavyForwarders"
```

Now refresh the deployment server configuration.

```bash
curl -sk -u admin:<ADMIN_PASSWORD> -X POST "https://localhost:8089/services/deployment/server/config/_reload"
```


4. Remove the web.conf hotpatch:
   ```bash
   rm -f /opt/splunk/etc/apps/splunk_ta_sap_logserv/local/web.conf 2>/dev/null
   ```

5. Clear any cached bump files:
   ```bash
   rm -rf /opt/splunk/var/run/splunk/dispatch/splunk_ta_sap_logserv* 2>/dev/null
   ```

6. Restart Splunk:
   ```bash
   sudo /opt/splunk/bin/splunk restart
   ```

**On each HF (HF-01 and HF-02):**

1. Remove the TA:
   ```bash
   rm -rf /opt/splunk/etc/apps/splunk_ta_sap_logserv
   ```

2. Restart Splunk:
   ```bash
   sudo /opt/splunk/bin/splunk restart
   ```

**Verify clean slate:**

On the DS:
```bash
ls /opt/splunk/etc/apps/splunk_ta_sap_logserv 2>/dev/null
ls /opt/splunk/etc/deployment-apps/splunk_ta_sap_logserv 2>/dev/null
grep -c "SAP_LogServ" /opt/splunk/etc/system/local/serverclass.conf
```

All three should return nothing/0. Then you can proceed with a fresh install from the UCC-built `.tar.gz` and follow the Phase 1–7 steps from earlier.