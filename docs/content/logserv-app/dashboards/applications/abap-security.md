# ABAP Network & Security

![ABAP Network & Security](../../../../images/dashboard-abap-security.png)

## :material-circle-box:{ .taiconcolor } Why This Dashboard Matters

The ABAP Network & Security dashboard monitors the network-facing components of SAP ABAP systems. The Internet Communication Manager (ICM) handles all HTTP/HTTPS traffic into and out of ABAP, while the Gateway controls RFC connections between SAP systems. Together, these are the primary attack surface for ABAP-based landscapes and the first place where performance degradation manifests during connectivity issues.

## Panels

All panels except the raw-event tables read the hourly summary layer, so figures for wide time ranges can lag by up to about an hour; ranges shorter than 90 minutes are answered from the raw events automatically. See [Performance & Data Freshness](../performance.md).

- **Total Events** -- Aggregate event count across ICM, Gateway, and Audit sourcetypes
- **ICM Errors** -- Count of ICM events flagged as errors
- **Gateway Errors** -- Count of Gateway events with error details
- **Event Volume by Sourcetype** -- Daily trend of each sourcetype
- **ICM Status Codes Over Time** -- Stacked column chart of responses bucketed 2xx / 3xx / 4xx / 5xx, plus an *Other* bucket for status codes outside those ranges
- **ICM Peer Connections** -- Table of top peer IPs by request count with protocol details
- **ICM Request Types** -- Donut chart breakdown of ICM request types
- **ICM Status Code Distribution** -- Donut chart of the overall 2xx / 3xx / 4xx / 5xx mix for the selected range
- **Gateway Remote Hosts** -- Table of gateway peers by remote host and function, with event count, the services seen, and the most recent error detail for that host/function pair
- **Gateway Errors Over Time** -- Timeline of gateway error events
- **Activity by SID / Instance** -- Column chart showing event distribution across SAP systems

## :material-circle-box:{ .taiconcolor } Where the Data Comes From

Every panel on this dashboard is summary-backed — there are no live raw scans. Panels read the
`logserv_abapnet_rollup` KV Store collection (metrics `vol`, `icmstat`, `icmreq`, `icmpeer`,
`icmerr`, `gwhost`, `gwlatest`), populated at minute :14 of every hour by
`logserv_abapnet_aggregate` from two sourcetypes:

| Source | What it contributes |
|---|---|
| `sap:abap:gateway` | RFC-side facts — remote hosts, functions, services, and the latest gateway error detail per host/function |
| `sap:abap:icm` | HTTP-side facts — request volume, status classes, request types, peers/transactions/protocols, and ICM errors |

Summary-backed panels switch automatically to their exact raw-equivalent search when the selected window is shorter than 90 minutes, so sub-hour investigation stays real-time. The collection keeps 365 days of hourly history (trimmed by a daily retention search); a fresh install seeds the last 30 days from **Settings → Dashboard Data → Run backfill**. The global **Cloud** dropdown filters the summaries through the `cloud_provider` dimension stored in every rollup row. Full schedule and freshness reference: [Performance & Data Freshness](../performance.md).


## :material-lightning-bolt:{ .taiconcolor } What to Look For

- **ICM 4xx/5xx spikes** -- A sudden increase in client errors (4xx) may indicate application misconfigurations or scanning activity. Server errors (5xx) suggest backend failures or resource exhaustion.
- **Unfamiliar peer IPs** -- New IP addresses appearing in the ICM Peer Connections table warrant investigation, especially if they generate high request volumes or connect using unusual protocols.
- **Gateway connections from unknown hosts** -- The Gateway Remote Hosts table should show expected RFC partners. Unknown remote hosts or unusual service names may indicate unauthorized access attempts.
- **Error rate trends** -- A gradually increasing error rate across days can signal infrastructure degradation (disk space, memory pressure, certificate expiry) before it becomes an outage.


