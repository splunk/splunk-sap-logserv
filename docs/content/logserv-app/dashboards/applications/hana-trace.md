# HANA Trace

![HANA Trace](../../../../images/dashboard-hana-trace.png)

## :material-circle-box:{ .taiconcolor } Why This Dashboard Matters

The HANA Trace dashboard provides visibility into SAP HANA's internal diagnostic trace system. Unlike audit logs that capture user actions, trace logs capture what the database engine itself is doing: memory management, query compilation, I/O operations, and internal errors. This is the primary tool for diagnosing HANA performance issues, stability problems, and understanding the root cause of database outages.

## Panels

- **Total Trace Events** -- Aggregate count of trace log entries
- **Errors / Fatal** -- Count of error and fatal severity events
- **Unique Components** -- Number of distinct HANA components generating traces
- **Trace Volume Over Time** -- Daily trend of total trace events
- **Trace Events by Severity** -- Stacked column chart showing the severity mix (INFO, WARNING, ERROR, FATAL, plus DEBUG/UNKNOWN where present)
- **Components** -- Table of HANA components ranked by event volume, with distinct source-file count and the severities seen; click a row for that component's raw trace events (parsing artefacts -- very short names and values such as `INFO`, `of`, `service:` -- are filtered out)
- **Component by Severity** -- Stacked column chart showing the severity mix per component (same noise filter applied)
- **Source File Hotspots** -- Table identifying specific source files generating the most trace entries (same noise filter applied)
- **Activity by SID / Instance** -- Event distribution across HANA systems
- **Slowest SQL Operations** -- Table of the top 20 SQL operations ranked by max duration (msec), with average duration and event count per operation. (Reads the hourly rollup layer; the per-event time/host columns are not retained at the aggregate grain -- use the Recent Errors / Fatal Events table or the Search app for individual events.)
- **Operation Duration (Avg / Max)** -- Daily average and peak HANA SQL operation duration (msec), across the events that carry the duration field.
- **Recent Errors / Fatal Events** -- Table of the latest error and fatal trace events with component and source location

Every panel except Recent Errors / Fatal Events reads the hourly summary layer, so wide-range figures can lag by up to about an hour; ranges shorter than 90 minutes are answered from raw events automatically. See [Performance & Data Freshness](../performance.md).

## :material-circle-box:{ .taiconcolor } Where the Data Comes From

The single source is `sap:hana:tracelogs`.

- **Summary-backed panels** — volume, severity and component panels read metric `main` of the
  `logserv_hana_trace_rollup` KV Store collection; the SQL-duration panels read metrics `dur`
  (per-hour duration sums/counts/maxima — the Avg + Max charts reconstruct exact averages from
  these) and `durop` (the same, per operation — the Slowest SQL Operations table ranks by stored
  Max/Avg). Populated at minute :19 of every hour by `logserv_hana_trace_aggregate`.
- **Error Detail** is a live event listing dispatched against the raw trace events at view time,
  capped at the 500 most recent error/fatal entries.

Summary-backed panels switch automatically to their exact raw-equivalent search when the selected window is shorter than 90 minutes, so sub-hour investigation stays real-time. The collection keeps 365 days of hourly history (trimmed by a daily retention search); a fresh install seeds the last 30 days from **Settings → Dashboard Data → Run backfill**. The global **Cloud** dropdown filters the summaries through the `cloud_provider` dimension stored in every rollup row. Full schedule and freshness reference: [Performance & Data Freshness](../performance.md).


## :material-lightning-bolt:{ .taiconcolor } What to Look For

- **Error/fatal severity spikes** -- A sudden increase in error-level traces often precedes a HANA outage or performance degradation. Investigate the component and source file generating the errors.
- **Single component dominance** -- If one component suddenly generates significantly more traces than usual, it may indicate a runaway process, memory leak, or infinite loop within that subsystem.
- **New source files appearing** -- Trace entries from source files not seen before may indicate recently applied patches or code changes that are generating unexpected behavior.
- **SID/instance imbalance** -- Uneven trace volumes across instances of the same HANA system may indicate hardware issues, unbalanced workload distribution, or replication problems.
- **Persistent warning trends** -- Warnings that gradually increase over days often signal resource exhaustion (disk space, memory pools) that will eventually escalate to errors.


