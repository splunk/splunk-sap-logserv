# Applications

The **Applications** category covers dashboards that monitor the SAP application runtime layer itself — the ABAP application server and the HANA database engine. These are the workloads SAP customers run every day, and dashboards here answer questions about work processes, dispatcher health, database audit trails, and diagnostic trace output.

!!! tip "React refinements (apply to every dashboard in this category)"
    Every panel, KPI card, chart, and table row is clickable and opens its drill-down destination in a new browser tab with the source dashboard's currently-selected time range pre-applied via `?earliest=...&latest=...`. The destination's `TimeRangeProvider` parses the URL on mount and hydrates its initial range. Every dashboard's title-row toolbar carries a per-dashboard **Refresh** picker (Never / 30s / 1m / 5m / 15m / 30m / 1hr) with per-user-per-dashboard cadence persisted via Splunk KV Store, plus a **Download PNG** button (full-canvas capture via `html2canvas`).

| Dashboard | Purpose | Key Data Sources |
|-----------|---------|-----------------|
| [ABAP Network & Security](applications/abap-security.md) | ICM traffic analysis, gateway monitoring, and ABAP audit events | `sap:abap:icm`, `sap:abap:gateway`, `sap:abap:audit` |
| [ABAP Operations](applications/abap-operations.md) | ABAP runtime health, dispatcher status, work process activity, and system uptime | `sap:abap:dispatcher`, `sap:abap:enqueueserver`, `sap:abap:event`, `sap:abap:messageserver`, `sap:abap:sapstartsrv`, `sap:abap:workprocess` |
| [Work Process Performance](applications/work-process-performance.md) | SAP ABAP work process utilization, dispatcher health, and function-level activity | `sap:abap:workprocess`, `sap:abap:dispatcher` |
| [HANA Audit](applications/hana-audit.md) | SAP HANA database audit events, security monitoring, user activity, risk-tiered events, and after-hours admin activity | `sap:hana:audit` |
| [HANA Trace](applications/hana-trace.md) | SAP HANA database trace logs, component health, and error analysis | `sap:hana:tracelogs` |
