# Web and API Performance

![Web and API Performance](../../../../images/dashboard-web-api-performance.png)

## :material-circle-box:{ .taiconcolor } Why This Dashboard Matters

The Web Dispatcher dashboard answers "what's the traffic doing?" -- volume, status codes, top URIs. Web and API Performance answers the next question: "*why* does it feel slow or unreliable?" It exposes the per-request timing stages that the `sap:webdispatcher:access` sourcetype records (`dt1` receive / `dt2` handler / `dt3` response / `dt4` send), combines response-time averages and maxima across Web Dispatcher and Cloud Connector HTTP traffic, and correlates the HTTP error rate with the Cloud Connector auth failure rate so that you can see whether a spike in user-visible failures is actually a backend-auth problem. It also surfaces TLS posture (version and cipher suite distributions) -- data already extracted from Web Dispatcher but previously unused -- so that cipher-suite drift or legacy TLS traffic becomes visible.

## Panels

- **Total Requests** -- Aggregate HTTP request count across Web Dispatcher and Cloud Connector
- **HTTP Error Rate** -- Percentage of requests returning 4xx or 5xx status (combined across both sources); click to open the matching events
- **Avg Response Time** -- Average `response_time_ms` across both sources, in milliseconds
- **Auth Failures** -- Count of requests rejected for authentication reasons: Web Dispatcher `status IN (401, 403)` OR Cloud Connector `(status IN (401, 403)) OR is_authenticated="false"`; click to drill down
- **Unique URLs** -- Distinct count of URIs seen across both sources
- **Four-Stage Request Timing Breakdown (avg ms per stage)** -- Stacked column chart showing the average milliseconds a request spends in each of the Web Dispatcher's four internal stages per day: `dt1` receive, `dt2` handler, `dt3` response, `dt4` send. The stack composition tells you where time is being spent; the total stack height is the average end-to-end response time.
- **Response Time (Avg / Max) Over Time** -- Daily average and peak `response_time_ms` (column chart, two series: Avg (ms) and Max (ms)). The Max line climbing while Avg stays flat is the classic tail-latency signal. (Replaces the prior p50 / p95 / p99 percentile chart: averages and maxima roll up byte-exact across the hourly data layer, whereas percentiles cannot — see [Dashboard Performance & Data Freshness](../performance.md).)
- **Slow URIs by Avg Response Time** -- Table of the slowest URIs ranked by average response time, with source (WebDisp or CC), event count, avg ms, max ms, and error count. Row drilldown opens the events for that URI.
- **HTTP Error Rate vs Cloud Connector Auth Failure Rate** -- Full-width chart overlaying two series in the error palette: the overall HTTP error rate (4xx/5xx across both sources) and the Cloud Connector auth failure rate (401/403/anonymous, scoped to CC's own denominator). Use this to answer "are the user-visible errors actually auth failures at the backend?"
- **TLS Version Distribution** -- Column chart of request volume per negotiated TLS version
- **TLS Cipher Suite Distribution** -- Table of negotiated cipher suites ranked by count (Cipher Suite, Count)
- **Slow Clients by Max Response Time** -- Full-width table of the client IPs experiencing the highest peak latency, with event count, avg ms, max ms, and distinct URI count. Row drilldown opens the events for that client IP.
- **Recent 500-Level Errors** -- Full-width table of the most recent 5xx events (up to 200) with time, source, host, client IP, method, URI, status, and response time. Row drilldown opens that client + URI's 5xx events in Splunk Search.

## :material-circle-box:{ .taiconcolor } Where the Data Comes From

Sources are `sap:webdispatcher:access` and `sap:scc:http_access`, summarised together.

- **Summary-backed panels** read the `logserv_web_timing_rollup` KV Store collection (shared with
  the Web Dispatcher dashboard): metric `core` carries per-hour request/error/auth-failure counts
  plus response-time sums, metric `timing` the four-stage `dt1–dt4` timing sums, `url` the
  per-URI facts (including the slow-URI Avg/Max ranking via `slowuri`), `client` the per-client
  facts, and `tls` / `cipher` the TLS posture. Averages are reconstructed exactly from stored sums
  and counts — which is also why the latency charts show **Avg + Max** rather than percentiles
  (percentiles cannot be merged across hourly buckets without approximation). Populated at minute
  :18 of every hour by `logserv_web_timing_aggregate`.
- **The recent 5xx table** is a live event listing dispatched against the raw events at view time,
  capped at the 200 most recent matches.

Summary-backed panels switch automatically to their exact raw-equivalent search when the selected window is shorter than 90 minutes, so sub-hour investigation stays real-time. The collection keeps 365 days of hourly history (trimmed by a daily retention search); a fresh install seeds the last 30 days from **Settings → Dashboard Data → Run backfill**. The global **Cloud** dropdown filters the summaries through the `cloud_provider` dimension stored in every rollup row. Full schedule and freshness reference: [Performance & Data Freshness](../performance.md).


## :material-lightning-bolt:{ .taiconcolor } What to Look For

- **Stage imbalance in the timing breakdown** -- In a healthy backend, `dt2` (handler) dominates the stack because that's where the ABAP/JVM work happens. If `dt3` (response) or `dt4` (send) suddenly grow relative to `dt2`, the bottleneck is likely on the response-formation or network-egress side rather than backend processing.
- **Tail latency growth (Max)** -- the Max line drifting up while Avg stays flat means a small number of requests are getting dramatically slower -- often database contention or garbage-collection pauses. Correlate with Slow URIs to identify which paths are affected.
- **Error-rate and auth-failure-rate correlation** -- When the two lines in the correlation chart track together, your HTTP error spikes are driven by backend auth rejection. When they diverge (HTTP errors up, auth failures flat), the cause is elsewhere (backend unavailable, 500s, timeouts).
- **Legacy TLS traffic** -- Any non-trivial TLS 1.0 or 1.1 volume in the TLS Version Distribution is a compliance concern. Correlate the TLS Cipher Suite Distribution table to see whether legacy ciphers are still being negotiated.
- **Slow clients vs slow URIs** -- The two "Slow" tables answer different questions. A single slow client with diverse URIs suggests network-path problem between that client and your infrastructure; a single slow URI across many clients points at a backend issue with that specific endpoint.
- **Concentrated 500 errors** -- Recurring entries in the Recent 500-Level Errors table from a single host, URI, or client IP narrow the investigation scope immediately.


