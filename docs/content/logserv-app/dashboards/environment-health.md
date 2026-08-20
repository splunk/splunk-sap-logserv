# Environment Health

![Environment Health](../../../images/dashboard-environment-health.png)

### :material-circle-box:{ .taiconcolor } Why This Dashboard Matters

The Environment Health dashboard is a single-pane-of-glass operations view that aggregates the most critical signals from across the entire SAP landscape. Instead of switching between individual dashboards to piece together overall health, administrators can use this dashboard to immediately identify active errors, security failures, and performance degradation. Every panel links to the relevant detailed dashboard for investigation, making this the recommended starting point for daily operations monitoring and incident triage.

**Environment Health is the default landing page** when you open the LogServ App — it sits to the left of the four category dropdowns in the top menu.

### Panels

- **Total Errors** -- Aggregate count of errors across all monitored sourcetypes. Click to open a detailed search showing errors by category, sourcetype, affected hosts, and last-seen time.
- **HANA Failed Ops** -- Count of non-successful HANA audit operations (login failures, permission denials, DDL errors). Click to drill down to HANA Audit dashboard.
- **Auth Failures** -- Combined count of sapstartsrv authentication failures and HANA audit connection failures. Click to drill down to SAP Services dashboard.
- **Firewall Drops** -- Count of Linux firewall (iptables) drop events across all monitored hosts. Click to drill down to Linux dashboard.
- **Web Error Rate** -- Percentage of Web Dispatcher requests returning 4xx/5xx status codes. Click to drill down to Web Dispatcher dashboard.
- **Beaconing Domains** -- Count of DNS domains exhibiting periodic query patterns that may indicate malware or C2 communication. Click to drill down to DNS Analytics dashboard.
- **ABAP Error Trend** -- Stacked column chart of daily ABAP errors by sub-source (Dispatcher, ICM, Gateway). Click to drill down to ABAP Security dashboard.
- **HANA Error Trend** -- Stacked column chart of daily HANA errors (Audit Failures, Trace Errors). Click to drill down to HANA Audit dashboard.
- **Security Error Trend** -- Stacked column chart of daily security errors (Auth Failures, Firewall Drops). Click to drill down to SAP Services dashboard.
- **Web/Network Error Trend** -- Stacked column chart of daily web/network errors (WebDisp 4xx/5xx, Router Errors, Proxy Denied). Click to drill down to Web Dispatcher dashboard.
- **Cloud Connector Error Trend** -- Stacked column chart of daily Cloud Connector HTTP errors (4xx Client, 5xx Server). Click to drill down to Cloud Connector dashboard.
- **OS/Infra Error Trend** -- Stacked column chart of daily Windows events by severity (High, Medium). Click to drill down to Windows dashboard.
- **Recent Critical Events** -- Table of the most recent critical signals (up to 200): HANA audit non-successful operations, ABAP dispatcher ERROR/FATAL, HANA trace fatal, sapstartsrv auth failures, and Windows critical-severity events, most-recent first. Click any row to drill down to Host Details for that host.
- **Affected Hosts** -- Table of hosts ranked by total error count with breakdowns by category (ABAP, HANA, Services, Firewall, Other). Click any host to drill down to Host Details.
- **Web Dispatcher Response Time** -- Column chart of daily average response time (ms) for web dispatcher requests. Click to drill down to Web Dispatcher dashboard.
- **ICM Status Codes** -- Stacked column chart of HTTP status code categories (2xx/3xx/4xx/5xx) over time. Click to drill down to ABAP Security dashboard.
- **Data Pipeline -- Events/Day (Avg)** -- Average daily event volume and daily trend line for monitoring pipeline health and detecting ingestion gaps. Click to drill down to the Data Pipeline Overview dashboard.
- **Daily Event Volume Trend** -- Full-width chart of total events per day across all sourcetypes. Click to drill down to the Data Pipeline Overview dashboard.

### :material-lightning-bolt:{ .taiconcolor } Drill-Down Behavior

Every KPI card, chart panel, and table row on this dashboard is clickable and opens its drill-down destination in a new browser tab with the source dashboard's currently-selected time range pre-applied (`?earliest=...&latest=...`). The destination's `TimeRangeProvider` parses the URL and hydrates its initial time-range from those params on mount, so a click from "Last 7 days" lands you in the destination at the same window. Two destination patterns:

- **Cross-dashboard drill-downs** — most KPIs and charts navigate to the relevant React dashboard (`/applications/hana-audit`, `/integration/cloud-connector`, etc.).
- **Splunk Search drill-downs** — the **Total Errors** KPI runs a cross-cutting OR query spanning every error-bearing sourcetype it counts — a query no single dashboard owns; it opens Splunk's universal Search app with the SPL pre-filled. Same time-range carry-through.

The dashboard's title-row toolbar carries a **Refresh** picker so you can have the page tick continuously (Never / 30s / 1m / 5m / 15m / 30m / 1hr) for use as an operations wallboard.

### :material-circle-box:{ .taiconcolor } Where the Data Comes From

The dashboard reads three kinds of source, chosen per panel for the cheapest path that stays exact:

- **Summary-backed panels** — the error/severity KPIs, all six error-trend charts, the web
  error-rate and response-time panels, the ICM status panel, the Auth Failures KPI and the Affected
  Hosts matrix read the `logserv_severity_rollup` KV Store collection (metrics `toterr`, `trend`,
  `tophost`, `web`, `icmstat`, `authfail` — each pre-computes one panel group's exact
  classification per hour). Populated at minute :10 of every hour by `logserv_severity_aggregate`,
  which classifies events from thirteen sourcetypes across the estate (HANA audit + tracelogs, the
  ABAP family, Web Dispatcher, SAP Cloud Connector, SAProuter, sapstartsrv, Windows event logs,
  Linux secure and Squid proxy).
- **The Beaconing Domains KPI** reads the daily `logserv_beaconing_rollup` (populated at 00:30 by a
  per-day gap-variance detection over DNS query events — daily cadence because the detection
  needs at least a day of inter-arrival history).
- **Pure-count pipeline panels** run `tstats` directly against indexed fields — no summary
  needed, fast at any volume.
- **Recent Critical Events** is a live event listing: it dispatches its SPL against the raw events
  at view time, capped at the 200 most recent matches.

Summary-backed panels switch automatically to their exact raw-equivalent search when the selected window is shorter than 90 minutes, so sub-hour investigation stays real-time. The collection keeps 365 days of hourly history (trimmed by a daily retention search); a fresh install seeds the last 30 days from **Settings → Dashboard Data → Run backfill**. The global **Cloud** dropdown filters the summaries through the `cloud_provider` dimension stored in every rollup row. Full schedule and freshness reference: [Performance & Data Freshness](performance.md).


### :material-lightning-bolt:{ .taiconcolor } What to Look For

- **Rising error trend** -- An upward slope in any error category chart indicates a worsening condition. Correlate the timing with recent changes, deployments, or infrastructure events. Each chart drills directly to the relevant dashboard for investigation.
- **Auth failure spikes** -- Sudden increases in the Auth Failures KPI or Security Error Trend may indicate brute-force login attempts, expired credentials, or misconfigured service accounts. Cross-reference with the HANA Audit and SAP Services dashboards.
- **HANA audit failures** -- Non-zero HANA Failed Ops always warrant investigation. Failed operations may indicate unauthorized access attempts, privilege escalation, or application misconfigurations.
- **Cloud Connector errors** -- A spike in the Cloud Connector Error Trend (especially 5xx Server errors) may indicate backend system unavailability, network issues between the SCC and SAP BTP, or certificate expiration.
- **Pipeline volume drops** -- A sudden drop in the Events/Day trend may indicate an SQS queue backup, S3 input failure, HF outage, or filter misconfiguration. Check the Data Pipeline Overview for per-host visibility.
- **Response time degradation** -- An increasing trend in Web Dispatcher response time often precedes user-facing performance complaints. Investigate ICM status codes for correlated 5xx errors.
- **Host concentration** -- If the Affected Hosts table shows errors concentrated on one or two hosts, those systems may have a localized issue (disk full, service crash, misconfiguration) rather than an environment-wide problem.


