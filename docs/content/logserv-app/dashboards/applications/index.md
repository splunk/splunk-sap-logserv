# Applications

The **Applications** category covers dashboards that monitor the SAP application runtime layer itself — the ABAP application server and the HANA database engine. These are the workloads SAP customers run every day, and dashboards here answer questions about work processes, dispatcher health, database audit trails, and diagnostic trace output.

| Dashboard | Purpose | Key Data Sources |
|-----------|---------|-----------------|
| [ABAP Network & Security](abap-security.md) | ICM traffic analysis, gateway monitoring, and ABAP audit events | `sap:abap:icm`, `sap:abap:gateway`, `sap:abap:audit` |
| [ABAP Operations](abap-operations.md) | ABAP runtime health, dispatcher status, work process activity, and system uptime | `sap:abap:dispatcher` †, `sap:abap:enqueueserver`, `sap:abap:event` †, `sap:abap:messageserver`, `sap:abap:sapstartsrv`, `sap:abap:workprocess` † |
| [Work Process Performance](work-process-performance.md) | SAP ABAP work process utilization, dispatcher health, function-level activity, and Async RFC queue depth | `sap:abap:workprocess` †, `sap:abap:dispatcher` †, `sap:abap:icm` (Async RFC panels) |
| [HANA Audit](hana-audit.md) | SAP HANA database audit events, security monitoring, user activity, risk-tiered events, and after-hours admin activity | `sap:hana:audit` |
| [HANA Trace](hana-trace.md) | SAP HANA database trace logs, component health, and error analysis | `sap:hana:tracelogs` |

† SAP stopped delivering `sap:abap:workprocess`, `sap:abap:dispatcher` and `sap:abap:event` through LogServ in April 2026, so the panels built on them show historical data only, unless you have arranged continued collection with SAP. See [Supported Log Types](../../../getting-started/supported-log-types.md).

The controls these dashboards share (time range, Cloud filter, auto-refresh, panel toolbar, drill-downs, export) are described once in the [Dashboards Overview](../index.md#common-dashboard-controls).
