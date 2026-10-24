# Security

The **Security** category contains three cross-source synthesis dashboards designed for security posture analysis and compliance conversations. Each unifies signals that would otherwise live scattered across individual Applications or Platform dashboards, and adds a cross-source correlation panel that surfaces what no single-source dashboard can show.

| Dashboard | Purpose | Key Data Sources |
|-----------|---------|-----------------|
| [Network Perimeter](network-perimeter.md) | Unified network-boundary view: firewall drops at the host and in transit, proxy outbound traffic, DNS resolution, and cross-source suspicious-activity correlation | `linux_secure`, `squid:access`, `isc:bind:query`, `isc:bind:queryerror` (scoped by `tag=dns`) |
| [Cross-Stack Authentication](cross-stack-authentication.md) | Unified authentication failure analysis across SAP, HANA, and Windows layers | `sap:sapstartsrv`, `sap:hana:audit`, `XmlWinEventLog` |
| [Change & Configuration Activity](change-config.md) | Cross-stack audit trail: HANA user/role/privilege changes, Windows account and group modifications, Linux sudo and user-management activity, with compliance-focused privileged and after-hours views | `sap:hana:audit`, `XmlWinEventLog`, `linux:sudolog`, `linux_messages_syslog` (plus the other `linux:*` sourcetypes) |

Two compliance tables on Change & Configuration Activity, **Recent Privileged Changes** and **Recent After-Hours Changes**, deliberately have no row drill-downs; the dashboard's page explains why.

The controls these dashboards share (time range, Cloud filter, auto-refresh, panel toolbar, drill-downs, export) are described once in the [Dashboards Overview](../index.md#common-dashboard-controls).
