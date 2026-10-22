# ABAP Network & Security

![ABAP Network & Security](../../../../images/dashboard-abap-security.png)

## :material-circle-box:{ .taiconcolor } Why This Dashboard Matters

The ABAP Network & Security dashboard monitors the network-facing components of SAP ABAP systems. The Internet Communication Manager (ICM) handles all HTTP/HTTPS traffic into and out of ABAP, while the Gateway controls RFC connections between SAP systems. Together, these are the primary attack surface for ABAP-based landscapes and the first place where performance degradation manifests during connectivity issues.

## Panels

All panels except the raw-event tables read the hourly summary layer, so figures for wide time ranges can lag by up to about an hour; ranges shorter than 90 minutes are answered from the raw events automatically. See [Performance & Data Freshness](../performance.md).

- **Total Events** -- Aggregate event count across ICM, Gateway, and Audit sourcetypes
- **ICM Errors** -- Count of `dev_icm` trace messages the ICM logged as `*** ERROR =>`
- **Gateway Errors** -- Count of Gateway events with error details
- **Event Volume by Sourcetype** -- Trend over time of each sourcetype
- **ICM Warnings & Errors Over Time** -- Stacked column chart of the `dev_icm` trace messages logged as WARNING or ERROR
- **ICM Peer Connections** -- Table of the addresses at the other end of ICM connections — connections the ICM opened and connections clients opened to it — ranked by connection count, with the protocols seen
- **ICM Request Types** -- Donut chart of the ICM session-list entries by request type (asynchronous RFC, HTTP, internal)
- **ICM Session Entries by SAP System and Client** -- Donut chart of the ICM session-list entries by SAP system and client (`sap_sid` / `sap_client`; `000` is the system client). A client number belongs to its system, so the same client in two systems is two slices
- **Gateway Remote Hosts** -- Table of gateway peers by remote host and function, with event count, the services seen, and the most recent error detail for that host/function pair
- **Gateway Errors Over Time** -- Timeline of gateway error events
- **Activity by SID / Instance** -- Column chart showing event distribution across SAP systems

## :material-circle-box:{ .taiconcolor } Where the Data Comes From

Every panel on this dashboard is summary-backed — there are no live raw scans. Panels read the
`logserv_abapnet_rollup` KV Store collection (metrics `vol`, `icmsev`, `icmclient`, `icmreq`,
`icmpeer`, `icmerr`, `gwhost`, `gwlatest`), populated at minute :14 of every hour by
`logserv_abapnet_aggregate` from two sourcetypes:

| Source | What it contributes |
|---|---|
| `sap:abap:gateway` | RFC-side facts — remote hosts, functions, services, and the latest gateway error detail per host/function |
| `sap:abap:icm` | ICM facts from the `dev_icm` trace — event volume, the ICM's warning and error messages, session-list entries by request type and by SAP system and client, and connection peers and protocols |

Summary-backed panels switch automatically to their exact raw-equivalent search when the selected window is shorter than 90 minutes, so sub-hour investigation stays real-time. The collection keeps 365 days of hourly history (trimmed by a daily retention search); a fresh install seeds the last 30 days from **Settings → Dashboard Data → Run backfill**. The global **Cloud** dropdown filters the summaries through the `cloud_provider` dimension stored in every rollup row. Full schedule and freshness reference: [Performance & Data Freshness](../performance.md).

!!! note "What the ICM trace records"
    The ICM trace (`dev_icm`) records sessions, connections and the ICM's own warning and error messages; it records no HTTP status code for individual requests. In a session-list line such as `ASYNC_RFC T229_U23835_M0, 200, BATCH_ALM, , time=10:35:59, ...` the three digits after the session ID are the SAP client, extracted as `sap_client`, followed by the user (`icm_user`) and the terminal (`icm_terminal`). Builds before 378 read the client as an HTTP status: a session in client 400 to 599 counted as an ICM error, and the status panels showed SAP clients as 2xx–5xx classes. Rebuild this dashboard's summary once after upgrading — see [Upgrading](../../../getting-started/upgrading.md).


## :material-lightning-bolt:{ .taiconcolor } What to Look For

- **ICM errors and warnings** -- A burst of ICM ERROR messages (for example failed TLS handshakes or connections) or of warnings such as connections a client closed prematurely points to front-end, network or certificate problems. Open the raw `dev_icm` lines for the message text.
- **Unexpected SAP clients** -- Sessions in a client you do not expect for that system — one that is not in use, or business-user activity in the system client `000` — warrant a closer look. System users such as `SAPSYS` in client `000` are normal.
- **Unfamiliar peer IPs** -- New IP addresses appearing in the ICM Peer Connections table warrant investigation, especially if they account for many connections or use unusual protocols.
- **Gateway connections from unknown hosts** -- The Gateway Remote Hosts table should show expected RFC partners. Unknown remote hosts or unusual service names may indicate unauthorized access attempts.
- **Error rate trends** -- A gradually increasing error rate across days can signal infrastructure degradation (disk space, memory pressure, certificate expiry) before it becomes an outage.


