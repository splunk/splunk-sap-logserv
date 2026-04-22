# Integration

The **Integration** category covers dashboards that monitor how SAP connects to other systems — host-level services (sapstartsrv, saphostexec), the SAP Router, the Cloud Connector (SAP BTP tunnel), and HTTP traffic through the Web Dispatcher. Use these dashboards to diagnose connectivity issues, auth failures at the integration boundary, and performance problems in the request path.

| Dashboard | Purpose | Key Data Sources |
|-----------|---------|-----------------|
| [SAP Services](#sap-services) | sapstartsrv authentication, SSL/TLS failure analysis, and host agent health | `sap:sapstartsrv`, `sap:saphostexec` |
| [SAP Router](#sap-router) | SAP Router connection activity, error analysis, and network boundary monitoring | `sap:saprouter` |
| [Cloud Connector](#cloud-connector) | SAP Cloud Connector HTTP traffic, audit events, and access denied events | `sap:scc:audit`, `sap:scc:http_access` |
| [Web Dispatcher](#web-dispatcher) | HTTP traffic analysis, response times, status codes, and client patterns | `sap:webdispatcher:access` |
| [Web and API Performance](#web-and-api-performance) | Four-stage request timing, response-time percentiles, TLS posture, cross-source error correlation | `sap:webdispatcher:access`, `sap:scc:http_access` |

---

## SAP Services

### :material-circle-box:{ .taiconcolor } Why This Dashboard Matters

The SAP Services dashboard monitors two host-level services that are critical to SAP system availability: **sapstartsrv** (system startup and management) and the **SAP Host Agent** (host monitoring and management). These services operate at the infrastructure layer, below the application, and their failures can prevent SAP systems from starting or being managed remotely. The authentication story is front-and-center here -- sapstartsrv is a common brute-force target, so the dashboard features an SSL-authentication failure panel as the main investigation surface. (SAP Router activity lives on its own [SAP Router](#sap-router) dashboard.)

### Panels

- **Total Events** -- Aggregate event count across sapstartsrv and saphostexec
- **Auth Failures** -- Count of sapstartsrv authentication failures
- **SSL/TLS Events** -- Count of events involving SSL/TLS negotiation
- **Event Volume by Service (Normal vs Errors)** -- Full-width stacked column chart with four semantic series: sapstartsrv (normal), sapstartsrv (errors), saphostexec (normal), saphostexec (errors). Errors are defined per service: sapstartsrv = failed authentication events; saphostexec = severity ERROR/WARNING.
- **SSL Authentication Failure Sources** -- Full-width featured table aggregating SSL/TLS auth failures by source IP, with failure count, distinct user count, user list, first/last seen, and activity span (hours). Top 50 sources, row drilldown to the full event set for that IP.
- **Sapstartsrv Authentication Events** -- Table of authentication attempts showing user, IP, method, and result
- **Host Agent Severity** -- Pie chart of SAP Host Agent log severity distribution

### :material-lightning-bolt:{ .taiconcolor } What to Look For

- **Auth failure sources** -- The SSL Authentication Failure Sources table is the primary investigation surface. A single source IP with many distinct usernames is credential stuffing; many sources with a few usernames each is distributed brute-force; long activity spans indicate a persistent (not opportunistic) attacker.
- **Authentication failures from new IPs** -- Any new source IP appearing in the SSL Authentication Failure Sources table should be cross-referenced with your expected SAP admin network. Production sapstartsrv should rarely see failed authentications from unfamiliar ranges.
- **Error stack rising in the volume chart** -- If the error series (red) in the Event Volume chart grows relative to normal (blue/teal) series, something is actively going wrong. Correlate the spike timing with the host agent severity pie to determine which service is affected.
- **Host Agent ERROR severity** -- If the Host Agent severity distribution shifts toward ERROR, the host monitoring infrastructure may be degrading, which impacts central management capabilities.

![SAP Services](../../../images/dashboard-sap-services.png)

---

## SAP Router

### :material-circle-box:{ .taiconcolor } Why This Dashboard Matters

SAP Router is the network gateway that sits between SAP systems and external networks, forwarding RFC and HTTP traffic across trust boundaries. Because it is exposed to the network, its logs are a primary audit trail for cross-boundary SAP traffic: every connection attempt, protocol error, and invalid-data event gets recorded. This dashboard separates the SAP Router signal from other services so that spikes in router errors (connectivity breakage, misconfigured routetab, or attempted protocol abuse) are visible on their own.

### Panels

- **Total Router Events** -- Aggregate SAP Router event count
- **Router Errors** -- Count of router error events (click to drill down)
- **Invalid Data Events** -- Count of events where the router received malformed or unexpected protocol data -- often indicates a misconfigured client or probing
- **Unique Peer IPs** -- Distinct count of peer IPs seen in the time window
- **Connection Actions Over Time** -- Stacked column chart of CONNECT, DISCONNECT, and error actions daily
- **Router Errors Over Time** -- Daily trend of router error events (area chart)
- **Top Peer IPs by Connection Volume** -- Horizontal bar chart of the most active peer IPs (top 15)
- **Return Code Distribution** -- Pie chart showing the distribution of router return codes (NiBuf, NiI, NiL, etc.) over the time range
- **Error Detail by Function** -- Table of the top 5 router error functions with return code, count, and sample peer detail; row drilldown
- **Recent Connection Log** -- Table of the 25 most recent CONNECT / DISCONNECT entries with peer IP, action, and return code; row drilldown

### :material-lightning-bolt:{ .taiconcolor } What to Look For

- **Invalid Data spikes** -- A sudden increase in the Invalid Data KPI suggests either a misconfigured client speaking a wrong protocol or a port scan / probe. Check the Top Peer IPs by Connection Volume for new entries.
- **Unfamiliar peers in the top-IPs bar** -- Known SAP-to-SAP traffic should come from a predictable IP set; new IPs in the top bar warrant investigation, especially if they generate high connection volume or show up only in the Error Detail by Function table.
- **Return code imbalance** -- The Return Code Distribution pie should be dominated by normal-case codes. A sudden growth of `NIECONN_REFUSED` or `NIEHOST_UNKNOWN` slices usually means a downstream SAP system is down or a routetab entry is wrong.
- **Rising error trend** -- An upward slope in Router Errors Over Time can precede an outage. Cross-reference with ABAP Operations (dispatcher errors) and Cloud Connector (for hybrid flows) to see whether the root cause is local to the router or broader.
- **Concentrated errors by function** -- If one row of the Error Detail by Function table accumulates most errors, that function is the specific RFC/HTTP path where the problem lives -- a much narrower investigation scope than "the router is broken".

![SAP Router](../../../images/dashboard-sap-router.png)

---

## Cloud Connector

### :material-circle-box:{ .taiconcolor } Why This Dashboard Matters

The Cloud Connector dashboard monitors SAP Cloud Connector (SCC), which provides secure tunneled connectivity between on-premise SAP systems and SAP BTP (Business Technology Platform) cloud services. As the bridge between on-premise and cloud, the Cloud Connector's health directly impacts hybrid integration scenarios, Fiori apps, and cloud-based analytics that depend on on-premise data access.

### Panels

- **Total Requests** -- Count of HTTP requests processed by the Cloud Connector
- **HTTP Error Rate** -- Percentage of HTTP requests returning 4xx or 5xx status codes (scoped name clarifies that this is HTTP-only, not audit-log errors)
- **Audit Events** -- Count of Cloud Connector audit log entries
- **Access Denied Events** -- Count of `sap:scc:audit` entries with `scc_audit_type="ACCESS_DENIED"` (click to drill down to the matching events)
- **Request Volume Over Time** -- Daily HTTP request trend
- **Status Code Distribution** -- Stacked column chart of 2xx, 3xx, 4xx, and 5xx responses
- **Top URIs by Request Count** -- Table of the most requested URIs with average response time and total bytes
- **Average Response Time** -- Line chart trending response time over time
- **HTTP Methods** -- Pie chart breakdown of request methods
- **Top Clients** -- Table of the most active client IPs with request counts and unique URI counts
- **Cloud Connector Audit Log** -- Table of recent audit events with type and account details

### :material-lightning-bolt:{ .taiconcolor } What to Look For

- **HTTP Error Rate increases** -- A rising error rate indicates connectivity issues between on-premise systems and the cloud. Check the Status Code Distribution for whether errors are client-side (4xx) or server-side (5xx).
- **Access Denied events** -- A non-zero Access Denied KPI means the BTP side actively rejected a request -- either a misconfigured subaccount binding, an expired certificate, or an unauthorized access attempt. Click the KPI to see which accounts/URIs are being denied.
- **Response time degradation** -- Gradually increasing response times suggest bandwidth constraints, backend system slowdowns, or Cloud Connector resource exhaustion. Sudden spikes may indicate outages.
- **Unusual URIs** -- Requests to unexpected URI paths in the Top URIs table may indicate scanning or misconfigured cloud applications attempting to access unauthorized resources.
- **Audit events indicating config changes** -- Cloud Connector audit entries for configuration modifications should correlate with approved change windows. Unexpected changes may indicate unauthorized access.
- **New client IPs** -- The Cloud Connector should only receive traffic from expected BTP subaccounts. New client IPs may indicate unauthorized access attempts or misconfigured routing.

![Cloud Connector](../../../images/dashboard-cloud-connector.png)

---

## Web Dispatcher

### :material-circle-box:{ .taiconcolor } Why This Dashboard Matters

The Web Dispatcher dashboard analyzes HTTP traffic flowing through the SAP Web Dispatcher, which acts as the reverse proxy and load balancer for SAP web applications including Fiori, WebGUI, and custom web services. As the front door for all web-based SAP access, the Web Dispatcher's traffic patterns reveal both performance issues and potential security threats. For deeper per-request timing analysis (four-stage breakdown, percentiles, TLS posture), see [Web and API Performance](#web-and-api-performance).

### Panels

- **Total Requests** -- Aggregate count of HTTP requests processed by the Web Dispatcher
- **Error Rate** -- Percentage of requests returning 4xx or 5xx status codes
- **Avg Response Time** -- Average response time across all requests in milliseconds
- **Traffic by Status Code** -- Stacked column chart showing 2xx, 3xx, 4xx, and 5xx response distributions
- **Response Time Trend** -- Response time patterns over time
- **Traffic by HTTP Method** -- Breakdown of GET, POST, PUT, DELETE, etc.
- **Top 5 Slowest Pages** -- Bar chart of the slowest responding URLs
- **Top Client IPs by Traffic** -- Bubble chart showing the most active client IP addresses
- **Request Volume Over Time** -- Daily request trend line
- **Top URIs by Request Count** -- Table of the most accessed URIs with average response time and unique client counts
- **Recent Errors (4xx/5xx)** -- Table of the latest error events with client IP, method, URI, and status code

### :material-lightning-bolt:{ .taiconcolor } What to Look For

- **4xx/5xx status code spikes** -- Client errors (4xx) may indicate broken links, misconfigured apps, or scanning activity. Server errors (5xx) signal backend ABAP or Java system failures.
- **Response time degradation** -- Slow response times impact user experience. Correlate with the Top 5 Slowest Pages to identify which applications are affected, then investigate backend system load.
- **Unusual HTTP methods** -- PUT, DELETE, or PATCH requests where only GET/POST are expected may indicate API abuse or vulnerability exploitation.
- **Concentrated client IP traffic** -- A single IP generating disproportionate traffic in the bubble chart may be a bot, scraper, or denial-of-service source.
- **TLS version distribution** -- If your data includes TLS fields, watch for clients using deprecated TLS versions (1.0, 1.1) that may need to be blocked for compliance.

![Web Dispatcher](../../../images/dashboard-web-dispatcher.png)

---

## Web and API Performance

### :material-circle-box:{ .taiconcolor } Why This Dashboard Matters

The Web Dispatcher dashboard answers "what's the traffic doing?" -- volume, status codes, top URIs. Web and API Performance answers the next question: "*why* does it feel slow or unreliable?" It exposes the per-request timing stages that the `sap:webdispatcher:access` sourcetype records (`dt1` receive / `dt2` handler / `dt3` response / `dt4` send), combines response-time percentiles across Web Dispatcher and Cloud Connector HTTP traffic, and correlates the HTTP error rate with the Cloud Connector auth failure rate so that you can see whether a spike in user-visible failures is actually a backend-auth problem. It also surfaces TLS posture (version and cipher suite distributions) -- data already extracted from Web Dispatcher but previously unused -- so that cipher-suite drift or legacy TLS traffic becomes visible.

### Panels

- **Total Requests** -- Aggregate HTTP request count across Web Dispatcher and Cloud Connector
- **HTTP Error Rate** -- Percentage of requests returning 4xx or 5xx status (combined across both sources); click to open the matching events
- **Avg Response Time** -- Average `response_time_ms` across both sources, in milliseconds
- **Auth Failures** -- Count of requests rejected for authentication reasons: Web Dispatcher `status IN (401, 403)` OR Cloud Connector `(status IN (401, 403)) OR is_authenticated="false"`; click to drill down
- **Unique URLs** -- Distinct count of URIs seen across both sources
- **Four-Stage Request Timing Breakdown** -- Full-width stacked column chart showing the average milliseconds a request spends in each of the Web Dispatcher's four internal stages per day: `dt1` receive (blue), `dt2` handler (light cyan), `dt3` response (orange), `dt4` send (red). The stack composition tells you where time is being spent; the total stack height is the average end-to-end response time.
- **Response Time Percentiles Over Time** -- Daily p50 / p95 / p99 of `response_time_ms` (line chart, three series). p99 climbing while p50 stays flat is the classic tail-latency signal.
- **Top Slow URIs by Avg Response Time** -- Table of the 20 slowest URIs ranked by average response time, with source (WebDisp or CC), event count, avg ms, p95 ms, and error count. Row drilldown opens the events for that URI.
- **HTTP Error Rate vs Cloud Connector Auth Failure Rate** -- Full-width line chart overlaying two series: the overall HTTP error rate (4xx/5xx across both sources, red) and the Cloud Connector auth failure rate (401/403/anonymous, scoped to CC's own denominator, orange). Use this to answer "are the user-visible errors actually auth failures at the backend?"
- **TLS Version Distribution** -- Column chart with color-coded series: TLS 1.0 red, 1.1 orange, 1.2 yellow, 1.3 teal -- reinforcing that older versions are the security concern
- **TLS Cipher Suite Distribution (Top 10)** -- Horizontal bar chart of the 10 most-used cipher suites, with cyan accent
- **Top Slow Clients by p95 Response Time** -- Full-width table of the 20 client IPs experiencing the highest p95 latency, with event count, avg ms, p95 ms, and distinct URI count. Row drilldown opens the events for that client IP.
- **Recent 500-Level Errors** -- Full-width table of the 25 most recent 5xx events with time, source, host, client IP, method, URI, status, and response time. Row drilldown opens the full raw event.

### :material-lightning-bolt:{ .taiconcolor } What to Look For

- **Stage imbalance in the timing breakdown** -- In a healthy backend, `dt2` (handler) dominates the stack because that's where the ABAP/JVM work happens. If `dt3` (response) or `dt4` (send) suddenly grow relative to `dt2`, the bottleneck is likely on the response-formation or network-egress side rather than backend processing.
- **Tail latency growth (p99)** -- p99 drifting up while p50 stays flat means a small number of requests are getting dramatically slower -- often database contention or garbage-collection pauses. Correlate with Top Slow URIs to identify which paths are affected.
- **Error-rate and auth-failure-rate correlation** -- When the two lines in the correlation chart track together, your HTTP error spikes are driven by backend auth rejection. When they diverge (HTTP errors up, auth failures flat), the cause is elsewhere (backend unavailable, 500s, timeouts).
- **Legacy TLS traffic** -- Any non-trivial slice of TLS 1.0 or 1.1 in the TLS Version Distribution is a compliance concern. Correlate the TLS Cipher Suite Distribution to see whether legacy ciphers are still being negotiated.
- **Slow clients vs slow URIs** -- The two "Top Slow" tables answer different questions. A single slow client with diverse URIs suggests network-path problem between that client and your infrastructure; a single slow URI across many clients points at a backend issue with that specific endpoint.
- **Concentrated 500 errors** -- Recurring entries in the Recent 500-Level Errors table from a single host, URI, or client IP narrow the investigation scope immediately.

![Web and API Performance](../../../images/dashboard-web-api-performance.png)
