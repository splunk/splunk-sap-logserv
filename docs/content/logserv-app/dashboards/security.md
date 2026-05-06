# Security

The **Security** category contains three cross-source synthesis dashboards designed for security posture analysis and compliance conversations. Each unifies signals that would otherwise live scattered across individual Applications or Platform dashboards, and adds a cross-source correlation panel that surfaces what no single-source dashboard can show.

!!! tip "v0.0.5.0 React refinements (apply to every dashboard in this category)"
    Every panel, KPI card, chart, and table row is clickable and opens its drill-down destination in a new browser tab with the source dashboard's currently-selected time range pre-applied via `?earliest=...&latest=...`. The destination's `TimeRangeProvider` parses the URL on mount and hydrates its initial range. Every dashboard's title-row toolbar carries a per-dashboard **Refresh** picker (Never / 30s / 1m / 5m / 15m / 30m / 1hr) with per-user-per-dashboard cadence persisted via Splunk KV Store, plus a **Download PNG** button (full-canvas capture via `html2canvas`).

    Two compliance-focused exceptions: the **After-Hours Privileged Changes** and **Recent Privileged Changes** tables on the Change & Configuration Activity dashboard intentionally have **no row drill-downs** — clicking through to raw events from a compliance audit-trail report would pollute the trail with the reviewer's own search activity in subsequent compliance reports. Per-source operational tables on the same dashboard DO get drill-downs.

| Dashboard | Purpose | Key Data Sources |
|-----------|---------|-----------------|
| [Network Perimeter](security/network-perimeter.md) | Unified network-boundary view: firewall drops (inbound), proxy outbound traffic, DNS resolution, and cross-source suspicious-activity correlation | `linux_secure`, `squid:access`, `isc:bind:query` |
| [Cross-Stack Authentication](security/cross-stack-authentication.md) | Unified authentication failure analysis across SAP, HANA, and Windows layers | `sap:sapstartsrv`, `sap:hana:audit`, `XmlWinEventLog` |
| [Change & Configuration Activity](security/change-config.md) | Cross-stack audit trail: HANA user/role/privilege changes, Windows account and group modifications, Linux sudo and user-management activity, with compliance-focused privileged and after-hours views | `sap:hana:audit`, `XmlWinEventLog`, `linux_messages_syslog` |
