# Data Pipeline Overview

## :material-circle-box:{ .taiconcolor } Why This Dashboard Matters

The Data Pipeline Overview is your single pane of glass for the entire SAP LogServ ingestion pipeline. It answers the most fundamental question: is data flowing from all expected hosts and sourcetypes? In a distributed SAP landscape with multiple SIDs, instances, and log types, a gap in data collection can go unnoticed for days without centralized visibility. This dashboard has two tabs: **Overview** for the operational KPI/table view, and **Sourcetype Mapping** for the full-width source-to-sourcetype link graph.

The title row carries a **dashboard-wide host filter**: a Multiselect (with filter input + Select All Matches) plus a Top-N picker. Selecting one or more hosts scopes **every panel on both tabs** — the KPIs and their sparklines, the Events Over Time by Host chart, both tables, and the Sourcetype Mapping link graph; Top N kicks in only when zero specific hosts are selected. The adjacent **Cloud Provider** dropdown (All / aws / azure / gcp) also scopes every panel, and the two filters compose.

!!! tip "Multi-cloud ingest split"
    The Data Pipeline Overview aggregates across ALL ingest channels — AWS S3, Azure Blob Storage, and Google Cloud Storage — without distinguishing them: events from any channel land under `sap_logserv_logs` and route to the same downstream sourcetypes. For a per-cloud-provider breakdown (AWS / Azure / GCP event counts, sourcetype distribution per provider, recent activity), see the [Multi-Cloud Overview](multi-cloud-overview.md) dashboard in the same Platform group. See the [Azure Setup Guide](../../../install-setup/azure-setup.md) and [GCP Setup Guide](../../../install-setup/gcp-setup.md) for cloud-side configuration.

## :material-circle-box:{ .taiconcolor } Overview Tab

![Data Pipeline Overview -- Overview Tab](../../../../images/dashboard-overview.png)

- **Total Events** -- Aggregate event count across all LogServ sourcetypes
- **Active Hosts** -- Count of distinct hosts reporting data
- **Active Sourcetypes** -- Count of distinct sourcetypes seen in the time range
- **Events / Day (Avg)** -- Mean daily event count over the selected range (days with zero events count in the denominator)
- **Events Over Time by Host** -- Multi-line chart of per-host event volume; the bucket size adapts to the selected range and is printed in the panel subtitle alongside the host-selection summary
- **Sourcetype Summary** -- Table of every sourcetype in range with event count, distinct host count, and last-seen time. Click a row to open the Search app pre-filtered to that sourcetype.
- **Host Latest Activity** -- Table showing each host's last event time, event count, and sourcetypes (click a row to drill down to Host Details)

## :material-circle-box:{ .taiconcolor } Sourcetype Mapping Tab

![Data Pipeline Overview -- Sourcetype Mapping Tab](../../../../images/dashboard-overview-2.png)

- **Source to Sourcetype Mapping** -- Full-width link graph visualizing the flow of data from source paths to sourcetypes, with column widening tuned so 3 columns fit inside the frame without horizontal scroll. Source paths are **normalized** before display — per-day dates, UUIDs, and other long numeric runs are replaced with placeholders so one logical source collapses to a single node instead of one node per file; raw searches against `source` will therefore show fuller strings than the graph

## :material-circle-box:{ .taiconcolor } Where the Data Comes From

This dashboard watches the whole index, so most of it runs on indexed metadata rather than
summaries:

- **`tstats` panels** — the KPIs, the events-over-time chart, the sourcetype summary and the
  host-activity table run `tstats` directly against indexed fields (host, sourcetype, source,
  `_time`) — exact at any volume with no summary dependency, and they respect the host filter in
  the title row.
- **Summary-backed panels** — the events-per-day series reads the `logserv_pipeline_rollup` KV
  Store collection (metrics `vol`, `byhost`; populated at minute :26 of every hour by
  `logserv_pipeline_aggregate` over the entire index).
- **The Sourcetype Mapping (Linked Graph) tab** reads the `logserv_stmap_rollup` collection
  (minute :03): one row per (sourcetype, source, host) per hour, with the `source` value
  **normalised at aggregation time** — embedded UUIDs, ISO dates and long digit runs are
  collapsed to placeholders so per-day and per-tenant file-name variants map to one logical source
  and the graph stays readable.

Summary-backed panels switch automatically to their exact raw-equivalent search when the selected window is shorter than 90 minutes, so sub-hour investigation stays real-time. The collection keeps 365 days of hourly history (trimmed by a daily retention search); a fresh install seeds the last 30 days from **Settings → Dashboard Data → Run backfill**. The global **Cloud** dropdown filters the summaries through the `cloud_provider` dimension stored in every rollup row. Full schedule and freshness reference: [Performance & Data Freshness](../performance.md).


## :material-lightning-bolt:{ .taiconcolor } What to Look For

- **Hosts going silent** -- A host that was previously reporting data but suddenly stops may indicate an agent failure, network issue, or system outage. Check the Host Latest Activity table for stale timestamps, and sort the Sourcetype Summary by **Last Seen** to find sourcetypes that have stopped arriving.
- **Sourcetype volume drops** -- A sudden decrease in events for a specific sourcetype often signals an ingestion pipeline issue. Compare the Sourcetype Summary **Events** column against a known-good window to spot volume drops; for per-panel root-cause analysis use the [Data Doctor](diagnostics.md).
- **Unexpected volume spikes** -- A sharp increase in event volume from a single host could indicate a log storm (runaway process, debug logging left enabled) or a security event generating excessive audit entries.
- **Missing sourcetype mappings** -- If a host shows data but is missing an expected sourcetype in the link graph (second tab), the routing transforms may need attention.

