# Cloud Connector

![Cloud Connector](../../../../images/dashboard-cloud-connector.png)

## :material-circle-box:{ .taiconcolor } Why This Dashboard Matters

The Cloud Connector dashboard monitors SAP Cloud Connector (SCC), which provides secure tunneled connectivity between on-premise SAP systems and SAP BTP (Business Technology Platform) cloud services. As the bridge between on-premise and cloud, the Cloud Connector's health directly impacts hybrid integration scenarios, Fiori apps, and cloud-based analytics that depend on on-premise data access.

## Panels

- **Total Requests** -- Count of HTTP requests processed by the Cloud Connector
- **HTTP Error Rate** -- Percentage of HTTP requests returning 4xx or 5xx status codes (scoped name clarifies that this is HTTP-only, not audit-log errors)
- **Audit Events** -- Count of Cloud Connector audit log entries
- **Access Denied Events** -- Count of `sap:scc:audit` entries with `scc_audit_type="ACCESS_DENIED"`
- **Request Volume Over Time** -- Daily HTTP request trend
- **Status Code Distribution** -- Stacked column chart of 2xx, 3xx, 4xx, and 5xx responses
- **URIs by Request Count** -- Table of the most requested URIs with average response time and total bytes
- **Average Response Time** -- Daily mean response time (ms), charted over time
- **HTTP Methods** -- Pie chart breakdown of request methods
- **Clients** -- Table of the most active client IPs with request counts, total bytes, and unique URI counts
- **Cloud Connector Audit Log** -- Table of recent audit events with type and account details

## :material-circle-box:{ .taiconcolor } Where the Data Comes From

- **Summary-backed panels** read the `logserv_cloudconn_rollup` KV Store collection — metrics
  `http`, `status`, `method` and `client` summarise `sap:scc:http_access` (request volume, status
  classes including the HTTP error rate, methods, top clients, response-time sums for the Avg
  charts), and metric `audit` summarises `sap:scc:audit` (including ACCESS_DENIED counts).
  Populated at minute :23 of every hour by `logserv_cloudconn_aggregate`.
- **Pure-count panels** run `tstats` directly against indexed fields.
- **The Audit Log table** is a live event listing dispatched against the raw `sap:scc:audit` events
  at view time, capped at the 200 most recent entries.

Summary-backed panels switch automatically to their exact raw-equivalent search when the selected window is shorter than 90 minutes, so sub-hour investigation stays real-time. The collection keeps 365 days of hourly history (trimmed by a daily retention search); a fresh install seeds the last 30 days from **Settings → Dashboard Data → Run backfill**. The global **Cloud** dropdown filters the summaries through the `cloud_provider` dimension stored in every rollup row. Full schedule and freshness reference: [Performance & Data Freshness](../performance.md).


## :material-lightning-bolt:{ .taiconcolor } What to Look For

- **HTTP Error Rate increases** -- A rising error rate indicates connectivity issues between on-premise systems and the cloud. Check the Status Code Distribution for whether errors are client-side (4xx) or server-side (5xx).
- **Access Denied events** -- A non-zero Access Denied KPI means the BTP side actively rejected a request -- either a misconfigured subaccount binding, an expired certificate, or an unauthorized access attempt. Use the Cloud Connector Audit Log table (click a row) to see which audit types and accounts are involved.
- **Response time degradation** -- Gradually increasing response times suggest bandwidth constraints, backend system slowdowns, or Cloud Connector resource exhaustion. Sudden spikes may indicate outages.
- **Unusual URIs** -- Requests to unexpected URI paths in the URIs by Request Count table may indicate scanning or misconfigured cloud applications attempting to access unauthorized resources.
- **Audit events indicating config changes** -- Cloud Connector audit entries for configuration modifications should correlate with approved change windows. Unexpected changes may indicate unauthorized access.
- **New client IPs** -- The Cloud Connector should only receive traffic from expected BTP subaccounts. New client IPs may indicate unauthorized access attempts or misconfigured routing.


