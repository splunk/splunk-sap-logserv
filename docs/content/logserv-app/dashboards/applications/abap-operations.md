# ABAP Operations

![ABAP Operations](../../../../images/dashboard-abap-operations.png)

## :material-circle-box:{ .taiconcolor } Why This Dashboard Matters

The ABAP Operations dashboard provides runtime health monitoring for the SAP ABAP application layer. It covers the dispatcher (request routing), work processes (transaction execution), enqueue server (lock management), and system uptime. These components are the engine of every SAP ABAP system, and their health directly impacts user experience and business process execution.

## Panels

!!! warning "Three source log types were discontinued by SAP in April 2026"
    `sap:abap:workprocess`, `sap:abap:dispatcher`, and `sap:abap:event` are no longer delivered by LogServ (see [Supported Log Types](../../../getting-started/supported-log-types.md)). Panels built on them show historical data only unless you have arranged continued collection with SAP.

All panels except the raw-event tables read the hourly summary layer, so figures for wide time ranges can lag by up to about an hour; ranges shorter than 90 minutes are answered from the raw events automatically. See [Performance & Data Freshness](../performance.md).

- **Total Events** -- Aggregate event count across all ABAP operations sourcetypes
- **Active SIDs** -- Count of distinct SAP System IDs reporting data
- **Dispatcher Errors** -- Count of ERROR/FATAL severity dispatcher events
- **Event Volume by Sourcetype** -- Daily trend across all six sourcetypes
- **System Uptime (Latest)** -- Table showing the most recent uptime in days and hours per SID/instance
- **Dispatcher Severity Over Time** -- Stacked column chart of dispatcher log severity levels
- **Work Process Functions** -- Table of `wp_function` + sub-function combinations ranked by event volume (events with no sub-function are not listed)
- **Work Process Categories** -- Donut chart showing activity distribution across the SAP work process category codes (e.g., `B = Database Interface`, `A = ABAP Processor`, `S = SQL / Statistics`, `M = Memory Management`, `X = RFC / CPIC`). The donut uses the `wp_category_name` field populated by the app's `props.conf` EVAL so every mapped category code gets a friendly name; unmapped codes render as `<code> = Other`.
- **Enqueue Lock Activity** -- Timeline of lock management operations
- **Activity by SID / Sourcetype** -- Table of SID × sourcetype combinations ranked by event volume; click a row to open the raw events in Search

## :material-circle-box:{ .taiconcolor } Where the Data Comes From

Every panel is summary-backed. Panels read the `logserv_wp_perf_rollup` KV Store collection
(metrics `wp`, `dp`, `abap`, `abap_wpfn`, `uptime`), which this dashboard **shares with Work
Process Performance** — one hourly aggregation serves both. It is populated at minute :09 of
every hour by `logserv_wp_perf_aggregate` from the six ABAP runtime sourcetypes
(`sap:abap:dispatcher`, `sap:abap:enqueueserver`, `sap:abap:event`, `sap:abap:messageserver`,
`sap:abap:sapstartsrv`, `sap:abap:workprocess`). The `uptime` metric stores a per-hour latest
value, so the uptime panels show the most recent reading inside your selected window.

Summary-backed panels switch automatically to their exact raw-equivalent search when the selected window is shorter than 90 minutes, so sub-hour investigation stays real-time. The collection keeps 365 days of hourly history (trimmed by a daily retention search); a fresh install seeds the last 30 days from **Settings → Dashboard Data → Run backfill**. The global **Cloud** dropdown filters the summaries through the `cloud_provider` dimension stored in every rollup row. Full schedule and freshness reference: [Performance & Data Freshness](../performance.md).


## :material-lightning-bolt:{ .taiconcolor } What to Look For

- **Uptime resets** -- A system showing low uptime (hours instead of days) indicates a recent restart. Unexpected restarts may signal crashes, memory issues, or unplanned maintenance.
- **Dispatcher ERROR/FATAL increases** -- Rising error severity in the dispatcher indicates work process exhaustion, connection failures, or configuration problems that will soon impact users.
- **Work process category shifts** -- A sudden change in the distribution of work process categories (e.g., dialog processes being consumed by batch jobs) suggests resource contention.
- **Enqueue lock spikes** -- A sharp increase in lock operations can indicate application deadlocks, long-running transactions holding locks, or database performance issues causing lock wait times to increase.
- **SID/instance imbalance** -- If one system or instance is generating significantly more events than its peers, investigate whether it's handling disproportionate load or experiencing issues.


