# SAP Router

![SAP Router](../../../../images/dashboard-sap-router.png)

## :material-circle-box:{ .taiconcolor } Why This Dashboard Matters

SAP Router is the network gateway that sits between SAP systems and external networks, forwarding RFC and HTTP traffic across trust boundaries. Because it is exposed to the network, its logs are an audit trail for cross-boundary SAP traffic: they record the connections it opens and closes, protocol errors, and invalid data it receives. This dashboard separates the SAP Router signal from other services so that spikes in router errors (connectivity breakage, misconfigured routetab, or attempted protocol abuse) are visible on their own.

## :material-circle-box:{ .taiconcolor } Requires

- **Sourcetypes:** `sap:saprouter` (LogServ folder `sap/saprouter`; it covers both the `.log` connection events and the `.trc` error traces). The Data TA assigns it at index time where the data is parsed; see [Supported Log Types](../../../getting-started/supported-log-types.md).
- **Search-head add-ons:** none beyond the [LogServ App prerequisites](../../prerequisites.md).
- **Dashboard Data row:** **SAP Router**. Backfill it once after installing the App so the panels show history: 30 days by default, up to 365 days or a custom range. See [Backfilling on first install](../../dashboard-data.md#backfilling-on-first-install). The router edges of the Environment Topology come from the **Environment Topology** rows, not from this one.

## :material-circle-box:{ .taiconcolor } Panels

All panels except Recent Connection Log read the hourly summary, which adds each hour at minute :13 of the next hour, so on wide time ranges they can leave out up to about the last 75 minutes; ranges shorter than 90 minutes are answered from the raw events automatically. See [Dashboard Data](../../dashboard-data.md).

- **Total Router Events** -- Aggregate SAP Router event count
- **Router Errors** -- Count of router error events
- **Invalid Data Events** -- Count of events where the router received malformed or unexpected protocol data -- can indicate a misconfigured client or probing
- **Unique Peer IPs** -- Distinct count of peer IPs seen in the time window
- **Connection Actions Over Time** -- Column chart of CONNECT, DISCONNECT, and error actions over time, one bar per action in each time bucket
- **Router Errors Over Time** -- Trend of router error events over time (column chart)
- **Peer IPs by Connection Volume** -- Table of peer IPs ranked by connection count; a row click opens that peer's full router event log
- **Return Code Distribution** -- Donut chart of router return codes over the time range, decoded to readable labels ("0 = OK (Success)", "-93 = Connection Refused", "-92 = Host Unknown (DNS)", ...)
- **Error Detail by Function** -- Table of router error functions (for example `NiIRead` or `NiBufIIn`) with count, unique peer count, the return codes seen, and the most recent error detail text (paginated 5 rows at a time); a row click opens that function's error events
- **Recent Connection Log** -- Table of the most recent connection events (CONNECT / DISCONNECT / INVAL DATA, up to 500) with time, action, connection ID, peer IP, source IP/port, and an error flag; a row click opens that peer/source pair's events. On `CONNECT TO` rows the Source IP column shows the connection's target (see *Where the data comes from* below)

## :material-lightning-bolt:{ .taiconcolor } What to Look For

- **Invalid Data spikes** -- A sudden increase in the Invalid Data KPI suggests either a misconfigured client speaking a wrong protocol or a port scan / probe. Check the Peer IPs by Connection Volume table for new entries.
- **Unfamiliar peers near the top of the table** -- Known SAP-to-SAP traffic should come from a predictable IP set; new IPs near the top of the Peer IPs by Connection Volume table warrant investigation, especially if they generate high connection volume or show up only in the Error Detail by Function table.
- **Return code imbalance** -- The Return Code Distribution pie should be dominated by normal-case codes. A sudden growth of the "-93 = Connection Refused" or "-92 = Host Unknown (DNS)" slices can mean that a target system is down or not accepting connections, that a host name does not resolve, or that a routetab entry is wrong.
- **Rising error trend** -- An upward slope in Router Errors Over Time can precede an outage. Cross-reference with ABAP Operations (dispatcher errors) and Cloud Connector (for hybrid flows) to see whether the root cause is local to the router or broader.
- **Concentrated errors by function** -- If one row of the Error Detail by Function table accumulates most errors, read its error detail text: the function is the routine of SAP's network layer that reported the failure (for example `NiIRead` for a failed or invalid read), which narrows the investigation to one kind of failure.

## :material-circle-box:{ .taiconcolor } Related Dashboards

- [Environment Topology](../topology.md) -- draws the router's routed connections as SAP Router edges (below).
- [Environment Health](../environment-health.md) -- its **Web/Network Error Trend** chart counts router errors.
- [Host Details](../platform/host-details.md) -- its **Data Freshness** table opens this dashboard from an `sap:saprouter` row.
- [SAP Services](sap-services.md) -- sapstartsrv and the SAP Host Agent, the other SAP service logs.

#### :material-crop-square:{ .taiconcolor } In the Environment Topology

The [Environment Topology](../topology.md) draws each router's routed connections as **SAP Router**
edges, from the router host (a "SAP ROUTER" square) to each `CONNECT TO` target, rolled up hourly.
A target named `sapms<SID>` is that SID's message server, so its address is attributed to the SID and
the edge ends on the SID's circle; targets reached by port (`3300`) or `sapgw<NN>` stay addresses until
another source attributes them. Server-side receive failures that name a target address
(`NiBufReceive S... '<IPv4>' failed`) count as the edge's failed connections; client-side failures and
failures that name a host are not counted. Loopback targets (127.0.0.0/8 — such as the niping self-test,
`127.0.0.1/3298`) are left out of the graph.

??? info "Where the data comes from"
    The single source is `sap:saprouter` (covering both the `.log` connection events and the `.trc` error traces).

    - **Summary-backed panels** read the `logserv_saprouter_rollup` KV Store collection — metric `main` carries an hourly grain over (action, peer IP, return code, error flag, error function); metric `errdetail` stores the latest error-detail text per error function. Return codes are stored raw and decoded to their human labels at read time. Populated at minute :13 of every hour by `logserv_saprouter_aggregate`.
    - **Recent Connection Log** is a live event listing dispatched against the raw events at view time, capped at the 500 most recent entries.

    On a `CONNECT TO` line the address after `host` is the connection's **target**, and the router's search-time `src_ip` (with its CIM alias `src`) takes that first address — so on those rows the Recent Connection Log's source IP column shows the target. The target also has its own fields: `saprouter_target_ip` / `saprouter_target_addr`, `saprouter_target_service` (`sapms<SID>`, `33NN`, `sapgwNN`, ...), `saprouter_target_sid` (for a `sapms<SID>` target), `saprouter_target_role` (message server, gateway, gateway (secure), dispatcher, SAP Router, niping, other service) and `saprouter_target_instance`. A server-side receive failure that names an IPv4 address (`NiBufReceive S<n>/<m> '<IPv4>' failed`) carries `saprouter_fail_target_ip`; client-side failures (`NiBufReceive C<n>/...`) and failures that name a host do not.

    Summary-backed panels switch automatically to their exact raw-equivalent search when the selected window is shorter than 90 minutes, so sub-hour investigation stays real-time. The collection keeps 365 days of hourly history (trimmed by a daily retention search). The **Cloud** picker in the title row filters every panel by `cloud_provider`; events with no `cloud_provider` value count as `aws`. Full schedule and freshness reference: [Dashboard Data](../../dashboard-data.md).
