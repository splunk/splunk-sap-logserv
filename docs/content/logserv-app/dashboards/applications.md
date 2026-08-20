# Applications

The **Applications** category covers dashboards that monitor the SAP application runtime layer itself — the ABAP application server and the HANA database engine. These are the workloads SAP customers run every day, and dashboards here answer questions about work processes, dispatcher health, database audit trails, and diagnostic trace output.

!!! tip "React refinements (apply to every dashboard in this category)"
    Table rows are the main drill-down surface — most tables open Host Details, a specialist dashboard, or Splunk Search with the row's context, in a new browser tab with the source dashboard's currently-selected time range pre-applied via `?earliest=...&latest=...` (the destination hydrates its time picker from the URL on mount). Environment Health additionally makes its KPI cards and chart panels clickable; elsewhere a pointer cursor and hover highlight mark the clickable surfaces. Every dashboard's title-row toolbar carries a **Cloud Provider** dropdown (All / aws / azure / gcp) that scopes every panel on the page, a per-dashboard **Refresh** picker (Never / 30s / 1m / 5m / 15m / 30m / 1hr) with per-user-per-dashboard cadence persisted via Splunk KV Store, and a **?** help icon linking to this documentation. Dashboard export (**Download PNG** / **Download PDF**, full-canvas captures via `html2canvas`) lives in the navigation bar's **Actions** menu.

| Dashboard | Purpose | Key Data Sources |
|-----------|---------|-----------------|
| [ABAP Network & Security](applications/abap-security.md) | ICM traffic analysis, gateway monitoring, and ABAP audit events | `sap:abap:icm`, `sap:abap:gateway`, `sap:abap:audit` |
| [ABAP Operations](applications/abap-operations.md) | ABAP runtime health, dispatcher status, work process activity, and system uptime | `sap:abap:dispatcher`, `sap:abap:enqueueserver`, `sap:abap:event`, `sap:abap:messageserver`, `sap:abap:sapstartsrv`, `sap:abap:workprocess` |
| [Work Process Performance](applications/work-process-performance.md) | SAP ABAP work process utilization, dispatcher health, and function-level activity | `sap:abap:workprocess`, `sap:abap:dispatcher` |
| [HANA Audit](applications/hana-audit.md) | SAP HANA database audit events, security monitoring, user activity, risk-tiered events, and after-hours admin activity | `sap:hana:audit` |
| [HANA Trace](applications/hana-trace.md) | SAP HANA database trace logs, component health, and error analysis | `sap:hana:tracelogs` |
