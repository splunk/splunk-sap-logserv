# Integration

The **Integration** category covers dashboards that monitor how SAP connects to other systems — host-level services (sapstartsrv, saphostexec), the SAP Router, the Cloud Connector (SAP BTP tunnel), and HTTP traffic through the Web Dispatcher. Use these dashboards to diagnose connectivity issues, auth failures at the integration boundary, and performance problems in the request path.

| Dashboard | Purpose | Key Data Sources |
|-----------|---------|-----------------|
| [SAP Services](sap-services.md) | sapstartsrv authentication, SSL/TLS failure analysis, and host agent health | `sap:sapstartsrv`, `sap:saphostexec` |
| [SAP Router](sap-router.md) | SAP Router connection activity, error analysis, and network boundary monitoring | `sap:saprouter` |
| [Cloud Connector](cloud-connector.md) | SAP Cloud Connector HTTP traffic, audit events, and access denied events | `sap:scc:audit`, `sap:scc:http_access` |
| [Web Dispatcher](web-dispatcher.md) | HTTP traffic analysis, response times, status codes, and client patterns | `sap:webdispatcher:access` |
| [Web and API Performance](web-api-performance.md) | Four-stage request timing, response-time Avg/Max trends, TLS posture, cross-source error correlation | `sap:webdispatcher:access`, `sap:scc:http_access` |

The controls these dashboards share (time range, Cloud filter, auto-refresh, panel toolbar, drill-downs, export) are described once in the [Dashboards Overview](../index.md#common-dashboard-controls).
