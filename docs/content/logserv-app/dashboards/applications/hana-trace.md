# HANA Trace

![HANA Trace](../../../../images/dashboard-hana-trace.png)

## :material-circle-box:{ .taiconcolor } Why This Dashboard Matters

The HANA Trace dashboard provides visibility into SAP HANA's internal diagnostic trace system. Unlike audit logs that capture user actions, trace logs capture what the database engine itself is doing: memory management, query compilation, I/O operations, and internal errors. This is the primary tool for diagnosing HANA performance issues, stability problems, and understanding the root cause of database outages.

## Panels

- **Total Trace Events** -- Aggregate count of trace log entries
- **Errors / Fatal** -- Count of error and fatal events: trace lines at level `e` or `f`, and `backup.log` entries at ERROR or FATAL (build 378)
- **Unique Components** -- Number of distinct HANA components generating traces, with the same noise filter as the Components table, so the count matches its rows
- **Trace Volume Over Time** -- Trend of total trace events over time
- **Trace Events by Severity** -- Stacked column chart showing the severity mix of trace lines and `backup.log` entries: INFO, WARNING, ERROR and FATAL, plus DEBUG where present and UNKNOWN for lines that carry no level, such as the continuation lines of a multi-line entry. Record files -- the `hdbcons` command timings, SQL trace (`*_statements.N.trc`), load traces and system availability -- carry no severity (build 378): they are left out of this chart and of Component by Severity, and still count in Total Trace Events, Trace Volume Over Time and Activity by SID / Instance (the `hdbcons` timings also feed the two duration panels). The chart's subtitle says it leaves them out
- **Components** -- Table of HANA components ranked by event volume, with distinct source-file count and the severities seen; click a row for that component's raw trace events (parsing artefacts -- very short names and values such as `INFO`, `of`, `service:` -- are filtered out). `backup.log` entries appear under their own component, for example `LOGBCKUP`
- **Component by Severity** -- Stacked column chart showing the severity mix per component (same noise filter applied)
- **Source File Hotspots** -- Table identifying specific source files generating the most trace entries (same noise filter applied)
- **Activity by SID / Instance** -- Event distribution across HANA systems
- **Slowest hdbcons Commands** -- Table of the top 20 HANA console (`hdbcons`) commands ranked by maximum duration (ms), with average duration and run count per command and SID. These are the commands the `hdbcons` trace times (for example `profiler stop`, `statreg print` or `replication info`), not SQL statements. The trace times each command in microseconds, milliseconds or seconds; all three are converted to ms (build 378 -- before, only millisecond-timed commands were counted, and real systems time many commands in microseconds). (Reads the hourly rollup layer; the per-event time/host columns are not retained at the aggregate grain -- use the Recent Errors / Fatal Events table or the Search app for individual events.)
- **hdbcons Command Duration (Avg / Max)** -- Average and peak `hdbcons` command duration (ms) over time, across every timed `hdbcons` command whatever unit the trace used. Because microsecond-timed commands count since build 378, the average usually falls after upgrading.
- **Recent Errors / Fatal Events** -- Table of the latest error and fatal events with component and source location; `backup.log` entries have a component but no source file or line

Every panel except Recent Errors / Fatal Events reads the hourly summary layer, so wide-range figures can lag by up to about an hour; ranges shorter than 90 minutes are answered from raw events automatically. See [Performance & Data Freshness](../performance.md).

## :material-circle-box:{ .taiconcolor } Where the Data Comes From

The single source is `sap:hana:tracelogs`. Each line is read by its own format (build 378):

- **Trace lines** -- `[pid]{connection}[transaction/update] date time level component file(line) : text` -- give the level, component, source file and line. Only a line that starts this way is read as one, so text further along a line can no longer be taken for a level or a component.
- **`backup.log` lines** -- `time  P<pid>  <thread>  LEVEL  COMPONENT  text` -- give their level (INFO, WARNING, ERROR, FATAL) and component, for example `LOGBCKUP`. Earlier builds read them as UNKNOWN with fragments such as `of` or `service:` as their component.
- **`hdbcons` lines** give the command and its duration, converted to ms (`hana_op`, `hana_op_duration_ms`).
- **Record files** (`hdbcons`, SQL trace, load traces, system availability) carry no severity.

The `hana_trace_file_type` field names the kind of file each event comes from -- `trace`, `alert`, `backup`, `hdbcons`, `sql_trace`, `load_trace`, `availability` or `other` -- for your own searches; no panel groups by it.

- **Summary-backed panels** — volume, severity and component panels read metric `main` of the
  `logserv_hana_trace_rollup` KV Store collection; the `hdbcons` duration panels read metrics `dur`
  (per-hour duration sums/counts/maxima in ms — the Avg + Max charts reconstruct exact averages
  from these) and `durop` (the same, per command and SID — the Slowest hdbcons Commands table
  ranks by stored Max/Avg). Populated at minute :19 of every hour by
  `logserv_hana_trace_aggregate`. Rows written before build 378 keep the old reading -- record
  files under UNKNOWN, `backup.log` lines under fragment components, microsecond-timed commands
  missing: after upgrading, **Clear** and then **Backfill** the HANA Trace row once in
  **Settings → Dashboard Data**, as [Upgrading](../../../getting-started/upgrading.md) describes.
- **Error Detail** is a live event listing dispatched against the raw trace events at view time,
  capped at the 500 most recent error/fatal entries.

Summary-backed panels switch automatically to their exact raw-equivalent search when the selected window is shorter than 90 minutes, so sub-hour investigation stays real-time. The collection keeps 365 days of hourly history (trimmed by a daily retention search); a fresh install seeds the last 30 days from **Settings → Dashboard Data → Run backfill**. The global **Cloud** dropdown filters the summaries through the `cloud_provider` dimension stored in every rollup row. Full schedule and freshness reference: [Performance & Data Freshness](../performance.md).


## :material-lightning-bolt:{ .taiconcolor } What to Look For

- **Error/fatal severity spikes** -- A sudden increase in error-level traces often precedes a HANA outage or performance degradation. Investigate the component and source file generating the errors.
- **Single component dominance** -- If one component suddenly generates significantly more traces than usual, it may indicate a runaway process, memory leak, or infinite loop within that subsystem.
- **New source files appearing** -- Trace entries from source files not seen before may indicate recently applied patches or code changes that are generating unexpected behavior.
- **SID/instance imbalance** -- Uneven trace volumes across instances of the same HANA system may indicate hardware issues, unbalanced workload distribution, or replication problems.
- **Persistent warning trends** -- Warnings that gradually increase over days often signal resource exhaustion (disk space, memory pools) that will eventually escalate to errors.


