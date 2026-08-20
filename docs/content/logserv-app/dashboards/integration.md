# Integration

The **Integration** category covers dashboards that monitor how SAP connects to other systems — host-level services (sapstartsrv, saphostexec), the SAP Router, the Cloud Connector (SAP BTP tunnel), and HTTP traffic through the Web Dispatcher. Use these dashboards to diagnose connectivity issues, auth failures at the integration boundary, and performance problems in the request path.

!!! tip "React refinements (apply to every dashboard in this category)"
    Table rows are the main drill-down surface — most tables open Host Details, a specialist dashboard, or Splunk Search with the row's context, in a new browser tab with the source dashboard's currently-selected time range pre-applied via `?earliest=...&latest=...` (the destination hydrates its time picker from the URL on mount). Environment Health additionally makes its KPI cards and chart panels clickable; elsewhere a pointer cursor and hover highlight mark the clickable surfaces. Every dashboard's title-row toolbar carries a **Cloud Provider** dropdown (All / aws / azure / gcp) that scopes every panel on the page, a per-dashboard **Refresh** picker (Never / 30s / 1m / 5m / 15m / 30m / 1hr) with per-user-per-dashboard cadence persisted via Splunk KV Store, and a **?** help icon linking to this documentation. Dashboard export (**Download PNG** / **Download PDF**, full-canvas captures via `html2canvas`) lives in the navigation bar's **Actions** menu.

| Dashboard | Purpose | Key Data Sources |
|-----------|---------|-----------------|
| [SAP Services](integration/sap-services.md) | sapstartsrv authentication, SSL/TLS failure analysis, and host agent health | `sap:sapstartsrv`, `sap:saphostexec` |
| [SAP Router](integration/sap-router.md) | SAP Router connection activity, error analysis, and network boundary monitoring | `sap:saprouter` |
| [Cloud Connector](integration/cloud-connector.md) | SAP Cloud Connector HTTP traffic, audit events, and access denied events | `sap:scc:audit`, `sap:scc:http_access` |
| [Web Dispatcher](integration/web-dispatcher.md) | HTTP traffic analysis, response times, status codes, and client patterns | `sap:webdispatcher:access` |
| [Web and API Performance](integration/web-api-performance.md) | Four-stage request timing, response-time Avg/Max trends, TLS posture, cross-source error correlation | `sap:webdispatcher:access`, `sap:scc:http_access` |
