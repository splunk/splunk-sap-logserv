# Windows Events

![Windows Events](../../../../images/dashboard-windows.png)

## :material-circle-box:{ .taiconcolor } Why This Dashboard Matters

The Windows Events dashboard monitors Windows hosts in the SAP landscape, which commonly run SAP application servers, database instances, and management consoles. Windows Event Logs capture service health, PowerShell execution, and system errors that indicate Windows-specific operational issues. This dashboard focuses on operational health and service state -- the authentication-failure story is owned by the [Cross-Stack Authentication](../security/cross-stack-authentication.md) dashboard so that all three layers (SAP / HANA / Windows) can be investigated together.

!!! warning "Requires the Splunk Add-on for Microsoft Windows on the Search Head"
    Several panels here depend on the **Splunk Add-on for Microsoft Windows** (<a href="https://splunkbase.splunk.com/app/742" target="_blank">Splunkbase 742</a>) being installed on the **Search Head** tier. The LogServ App ships **no `XmlWinEventLog` field extraction of its own** — `EventCode` and `severity` are search-time fields provided by add-on 742 (its `xmlwindows_severities.csv` lookup maps the event `<Level>` to severity: `1`→critical, `2`→high, `3`→medium, `0`/`4`/`5`→informational).

    **Without add-on 742 on the search tier**, Windows events still index fine and the **Total Events**, **Event Volume by Log**, **Active Hosts**, and **PowerShell Activity** panels populate (they read envelope fields), but the **Event Codes** table collapses to a single row labelled `(none)` and the **Severity Distribution**, **Critical / Error**, and **Service Events** panels stay empty.

    **Tier matters:** `EventCode`/`severity` are *search-time* extractions, so add-on 742 must be on the **Search Head** — installing it on a Heavy Forwarder or indexer does nothing for these panels. On Splunk Cloud, install it on the Cloud SH via self-service app management (it is replicated to the indexer search peers through the knowledge bundle). After installing it, re-run the **Windows** and **Environment Health** rollups (**Settings → Dashboard Data → Run backfill**) so the cached panels pick up the now-extracted fields. See the [Quick Install Reference](../../../getting-started/quick-install-reference.md#package-matrix) package matrix.

## Panels

- **Total Events** -- Aggregate Windows event count
- **Critical / Error** -- Count of Windows Critical (Level 1) and Error (Level 2) events. In CIM severity vocabulary these are `severity="critical"` and `severity="high"` — there is no `error` severity value
- **Active Hosts** -- Count of distinct Windows hosts reporting data
- **Event Volume by Log** -- Daily trend by Windows log source (Application, Security, System, PowerShell)
- **Severity Distribution Over Time** -- Stacked column chart of severity levels
- **Event Codes** -- Featured full-width table of the most frequent EventCodes with 7 enriched columns: Event Code, Description (signature), Source log, Severity, Events, Hosts (distinct count), Last Seen. Row drilldown opens the search app filtered by that event code.
- **Service Events** -- Table of Windows service start/stop activity with latest state
- **PowerShell Activity** -- Daily column chart of PowerShell operational event volume

## :material-circle-box:{ .taiconcolor } Where the Data Comes From

The single source is `XmlWinEventLog`. Every panel is summary-backed: panels read the
`logserv_windows_rollup` KV Store collection — metric `main` carries an hourly grain over
(event code, severity, source/channel, host) plus per-bucket latest values for the descriptive
columns, and metric `svc` carries the service-event facts. Populated at minute :20 of every hour by
`logserv_windows_aggregate`.

Summary-backed panels switch automatically to their exact raw-equivalent search when the selected window is shorter than 90 minutes, so sub-hour investigation stays real-time. The collection keeps 365 days of hourly history (trimmed by a daily retention search); a fresh install seeds the last 30 days from **Settings → Dashboard Data → Run backfill**. The global **Cloud** dropdown filters the summaries through the `cloud_provider` dimension stored in every rollup row. Full schedule and freshness reference: [Performance & Data Freshness](../performance.md).


## :material-lightning-bolt:{ .taiconcolor } What to Look For

- **High-frequency Event Codes** -- The Event Codes table is the primary starting point. EventCode 7031 / 7034 (service terminated unexpectedly), 1000 (application crash), and 41 (unexpected shutdown) are high-priority. Click through to see every occurrence of a specific code.
- **Service crashes** -- EventCode 7031 (service terminated unexpectedly) in either the Event Codes table or the Service Events panel indicates a critical service failure. For SAP services (sapstartsrv, SAPService), this requires immediate attention.
- **PowerShell activity spikes** -- Sudden increases in PowerShell execution may indicate lateral movement by an attacker using PowerShell-based attack tools. Correlate with the [Cross-Stack Authentication](../security/cross-stack-authentication.md) dashboard to see whether any Windows logons were concurrent.
- **Critical/error severity trends** -- A rising trend in critical and error events over multiple days indicates accumulating system health issues that need proactive investigation.
- **Event Code hosts expanding** -- The Hosts column on the Event Codes table makes it obvious when a normally-host-isolated error starts appearing on multiple hosts -- a sign the underlying cause is environmental (failed update, domain policy change) rather than local.


