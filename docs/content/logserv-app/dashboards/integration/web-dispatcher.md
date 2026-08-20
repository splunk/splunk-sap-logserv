# Web Dispatcher

![Web Dispatcher](../../../../images/dashboard-web-dispatcher.png)

## :material-circle-box:{ .taiconcolor } Why This Dashboard Matters

The Web Dispatcher dashboard analyzes HTTP traffic flowing through the SAP Web Dispatcher, which acts as the reverse proxy and load balancer for SAP web applications including Fiori, WebGUI, and custom web services. As the front door for all web-based SAP access, the Web Dispatcher's traffic patterns reveal both performance issues and potential security threats. For deeper per-request timing analysis (four-stage breakdown, Avg/Max response-time trends, TLS posture), see [Web and API Performance](web-api-performance.md).

## Panels

- **Total Requests** -- Aggregate count of HTTP requests processed by the Web Dispatcher
- **Error Rate** -- Percentage of requests returning 4xx or 5xx status codes
- **Avg Response Time** -- Average response time across all requests in milliseconds
- **Traffic by Status Code** -- Multi-line chart of 2xx / 3xx / 4xx / 5xx volume over time (lines rather than stacked bars so the small 4xx/5xx series stay visible next to 2xx)
- **Response Time Trend** -- Average and peak latency per bin (two lines: Avg (ms) and Max (ms)); the Max line rising while Avg stays flat is the tail-latency signal
- **Traffic by HTTP Method** -- Breakdown of GET, POST, PUT, DELETE, etc.
- **Slowest Pages** -- Table of URIs ranked by average response time (URI, Avg Response (ms), Requests); a row click opens that URI's full latency distribution
- **Client IPs by Traffic** -- Table of client IPs ranked by request count, with unique pages and average response time; a row click opens that client's full request log
- **Request Volume Over Time** -- Daily request volume (column chart)
- **URIs by Request Count** -- Table of the most accessed URIs with average response time; a status-code dropdown in the panel header (All / 2xx / 3xx / 4xx / 5xx) rescopes the table, and a row click drills into that URI within the selected status class
- **Recent Errors (4xx/5xx)** -- Table of the latest error events with time, client IP, method, URI, status code, and response time; a row click investigates that client + URI's error path
- **Slowest Request Traces** -- Waterfall of the 20 slowest requests in the range, each broken into its dt1 receive / dt2 handler / dt3 response / dt4 send stages

## :material-circle-box:{ .taiconcolor } Where the Data Comes From

The single source is `sap:webdispatcher:access`.

- **Summary-backed panels** read the `wd_*` metrics (`wd_core`, `wd_status`, `wd_method`,
  `wd_uristat`, `wd_client`) of the `logserv_web_timing_rollup` KV Store collection, which this
  dashboard **shares with Web and API Performance**. Populated at minute :18 of every hour by
  `logserv_web_timing_aggregate`.
- **Slowest Request Traces** reads its own `logserv_webdisp_slowtrace_rollup` collection (minute
  :28): each hour stores that hour's top-20 slowest requests, and re-sorting the union of per-hour
  top-20s yields exactly the global top-20 — the table is precise, not an approximation.
- **Pure-count panels** run `tstats` directly against indexed fields.
- **Recent Errors** is a live event listing dispatched against the raw events at view time, capped
  at the 200 most recent `status >= 400` requests.

Summary-backed panels switch automatically to their exact raw-equivalent search when the selected window is shorter than 90 minutes, so sub-hour investigation stays real-time. The collection keeps 365 days of hourly history (trimmed by a daily retention search); a fresh install seeds the last 30 days from **Settings → Dashboard Data → Run backfill**. The global **Cloud** dropdown filters the summaries through the `cloud_provider` dimension stored in every rollup row. Full schedule and freshness reference: [Performance & Data Freshness](../performance.md).


## :material-lightning-bolt:{ .taiconcolor } What to Look For

- **4xx/5xx status code spikes** -- Client errors (4xx) may indicate broken links, misconfigured apps, or scanning activity. Server errors (5xx) signal backend ABAP or Java system failures.
- **Response time degradation** -- Slow response times impact user experience. Correlate with the Slowest Pages table to identify which applications are affected, then investigate backend system load.
- **Unusual HTTP methods** -- PUT, DELETE, or PATCH requests where only GET/POST are expected may indicate API abuse or vulnerability exploitation.
- **Concentrated client IP traffic** -- A single IP generating disproportionate traffic in the Client IPs by Traffic table may be a bot, scraper, or denial-of-service source.
- **TLS posture** -- Web Dispatcher records TLS version and cipher suite, but the distributions are charted on [Web and API Performance](web-api-performance.md); check there for clients still using deprecated TLS versions (1.0, 1.1).


