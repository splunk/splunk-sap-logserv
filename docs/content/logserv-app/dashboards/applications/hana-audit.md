# HANA Audit

![HANA Audit](../../../../images/dashboard-hana-audit.png)

## :material-circle-box:{ .taiconcolor } Why This Dashboard Matters

The HANA Audit dashboard is essential for database security compliance and threat detection. SAP HANA stores the most sensitive business data in the SAP landscape, and its audit trail captures every authentication attempt, privilege change, and administrative action. This dashboard transforms raw audit events into actionable security intelligence, supporting both real-time threat detection and compliance reporting.

## Panels

Most panels read the hourly summary layer, so wide-range figures can lag by up to about an hour; the High-Risk Events and After-Hours tables always read raw events, and any range shorter than 90 minutes is answered from raw events automatically. See [Performance & Data Freshness](../performance.md).

- **Total Audit Events** -- Aggregate count of HANA audit log entries
- **Failed Operations** -- Count of audit events with non-successful status
- **Active Users** -- Count of distinct users generating audit activity
- **User Administration Activity Timeline** -- Tracks user administration actions (password resets, activations, deactivations) over time
- **Daily Security Health Score** -- Full-width table with one row per day: total events, active users, failures, and success rate (%), newest day first
- **Audit Category Breakdown** -- Table of audit event categories (`action_category`) with event counts
- **Security Events Timeline** -- Shows failed operations, object modifications, and permission grants
- **Password Management Activities** -- Table of password-related audit events with user and IP details
- **Failed Operations by Host** -- Table showing which hosts generate the most failed operations; click a row to open Host Details for that host
- **Users by Activity** -- Table ranking executing users by event count, with the number of distinct action types and failure count; click a row to open Cross-Stack Authentication
- **Activity by Hour of Day** -- Column chart showing successes vs. failures by hour for after-hours detection
- **Client IP Analysis** -- Table of connecting IPs with user counts, failures, and last-seen time
- **Risk-Tiered Event Timeline** -- Stacked column chart of daily events grouped by `risk_level` (HIGH / MEDIUM / LOW), so severe events never get hidden inside overall volume
- **After-Hours / Weekend Admin Activity** -- Table of admin activity (`is_admin_user=true`) falling outside business hours (weekday 08:00-18:59) or on a weekend, surfacing privileged activity outside normal windows; the Period column labels each row Weekend, After Hours, or Weekend / After Hours. Click a row to drill down by user
- **High-Risk Events** -- Full-width table filtered to `is_critical=true`, showing up to the 500 most recent critical audit events with time, user, action, category, risk, status, host, client IP, and SQL statement; click a row to drill down by user

## :material-circle-box:{ .taiconcolor } Where the Data Comes From

The single source is `sap:hana:audit`.

- **Summary-backed panels** — the KPIs, category/action/user/client breakdowns and the
  compliance timelines read the `logserv_hana_category_rollup` KV Store collection: metric `main`
  carries an hourly grain over (executing user, client IP, status, host, action type), and metrics
  `useradmin`, `security` and `password` pre-compute the three classified activity timelines.
  Populated at minute :11 of every hour by `logserv_hana_aggregate`.
- **Live panels** — the High-Risk Events and After-Hours / Weekend Admin Activity tables are
  per-event listings dispatched against the raw audit events at view time (capped at the 500 most
  recent matches each) — deliberately raw, so a compliance reviewer sees the actual event rows.

Summary-backed panels switch automatically to their exact raw-equivalent search when the selected window is shorter than 90 minutes, so sub-hour investigation stays real-time. The collection keeps 365 days of hourly history (trimmed by a daily retention search); a fresh install seeds the last 30 days from **Settings → Dashboard Data → Run backfill**. The global **Cloud** dropdown filters the summaries through the `cloud_provider` dimension stored in every rollup row. Full schedule and freshness reference: [Performance & Data Freshness](../performance.md).


## :material-lightning-bolt:{ .taiconcolor } What to Look For

- **Failed operations from unusual IPs** -- Authentication failures from IP addresses not in your expected range may indicate brute-force attacks or credential stuffing attempts.
- **Critical events in the High-Risk Events table** -- Any non-empty row here warrants investigation. The SQL Statement column makes it straightforward to see whether a critical event was a privilege grant, a schema change, or a failed auth.
- **After-hours privileged activity** -- The After-Hours / Weekend Admin Activity table surfaces admin operations outside business hours; correlate with change management records to separate planned maintenance from suspicious activity.
- **Risk-tier shifts over time** -- A rising HIGH stack in the Risk-Tiered Event Timeline often precedes an incident. A sudden spike in MEDIUM may point to scripted workloads that need review.
- **Privilege escalation patterns** -- Watch for sequences where a user's privileges are modified followed by unusual data access patterns. The Security Events Timeline surfaces GRANT and REVOKE operations.
- **Declining security health score** -- A downward trend in the daily success rate or an increase in failures signals growing security issues that need investigation.
- **Password management anomalies** -- Bulk password resets or resets for service accounts should be correlated with change management records.


