# Dashboards Overview

The LogServ App includes **twenty Dashboard Studio dashboards** organized as one top-level landing page and four purpose-driven navigation groups. All dashboards use **Dashboard Studio v2** format with dark theme and require Splunk 9.4.3 or later.

The top menu is:

**Environment Health** (default landing) · **Applications ▼** · **Integration ▼** · **Security ▼** · **Platform ▼** · **Search**

Use this page as an index — click any dashboard below to see its full purpose, panel list, and interpretation guide on the corresponding category page.

## :material-circle-box:{ .taiconcolor } Full Inventory

### Start Here

| Dashboard | Purpose | Key Data Sources |
|-----------|---------|-----------------|
| [Environment Health](environment-health.md) | Cross-cutting operations view of errors, security failures, and performance across the entire SAP landscape. Default landing page. | All sourcetypes |

### Applications (SAP application runtime)

| Dashboard | Purpose | Key Data Sources |
|-----------|---------|-----------------|
| [ABAP Network & Security](applications.md#abap-network-security) | ICM traffic analysis, gateway monitoring, and ABAP audit events | `sap:abap:icm`, `sap:abap:gateway`, `sap:abap:audit` |
| [ABAP Operations](applications.md#abap-operations) | ABAP runtime health, dispatcher status, work process activity, and system uptime | `sap:abap:dispatcher`, `sap:abap:enqueueserver`, `sap:abap:event`, `sap:abap:messageserver`, `sap:abap:sapstartsrv`, `sap:abap:workprocess` |
| [Work Process Performance](applications.md#work-process-performance) | SAP ABAP work process utilization, dispatcher health, and function-level activity | `sap:abap:workprocess`, `sap:abap:dispatcher` |
| [HANA Audit](applications.md#hana-audit) | SAP HANA database audit events, security monitoring, user activity, risk-tiered events, and after-hours admin activity | `sap:hana:audit` |
| [HANA Trace](applications.md#hana-trace) | SAP HANA database trace logs, component health, and error analysis | `sap:hana:tracelogs` |

### Integration (how SAP connects to other systems)

| Dashboard | Purpose | Key Data Sources |
|-----------|---------|-----------------|
| [SAP Services](integration.md#sap-services) | sapstartsrv authentication, SSL/TLS failure analysis, and host agent health | `sap:sapstartsrv`, `sap:saphostexec` |
| [SAP Router](integration.md#sap-router) | SAP Router connection activity, error analysis, and network boundary monitoring | `sap:saprouter` |
| [Cloud Connector](integration.md#cloud-connector) | SAP Cloud Connector HTTP traffic, audit events, and access denied events | `sap:scc:audit`, `sap:scc:http_access` |
| [Web Dispatcher](integration.md#web-dispatcher) | HTTP traffic analysis, response times, status codes, and client patterns | `sap:webdispatcher:access` |
| [Web and API Performance](integration.md#web-and-api-performance) | Four-stage request timing, response-time percentiles, TLS posture, cross-source error correlation | `sap:webdispatcher:access`, `sap:scc:http_access` |

### Security (cross-source synthesis + compliance)

| Dashboard | Purpose | Key Data Sources |
|-----------|---------|-----------------|
| [Network Perimeter](security.md#network-perimeter) | Unified network-boundary view: firewall drops (inbound), proxy outbound traffic, DNS resolution, and cross-source suspicious-activity correlation | `linux_secure`, `squid:access`, `isc:bind:query` |
| [Cross-Stack Authentication](security.md#cross-stack-authentication) | Unified authentication failure analysis across SAP, HANA, and Windows layers | `sap:sapstartsrv`, `sap:hana:audit`, `XmlWinEventLog` |
| [Change & Configuration Activity](security.md#change-configuration-activity) | Cross-stack audit trail: HANA user/role/privilege changes, Windows account and group modifications, Linux sudo and user-management activity, with compliance-focused privileged and after-hours views | `sap:hana:audit`, `XmlWinEventLog`, `linux_messages_syslog` |

### Platform (underlying infrastructure, ingest, and forensics)

| Dashboard | Purpose | Key Data Sources |
|-----------|---------|-----------------|
| [Data Pipeline Overview](platform.md#data-pipeline-overview) | Ingest pipeline view: 5 KPIs, Sourcetype Summary table, host activity, and source-to-sourcetype link graph (in second tab) | All sourcetypes |
| [DNS Analytics](platform.md#dns-analytics) | DNS query analysis, top resolvers, beaconing detection, and client activity | `isc:bind:query`, `isc:bind:network`, `isc:bind:transfer` |
| [Linux System & Security](platform.md#linux-system-security) | Linux OS events, SAP application activity, and firewall monitoring (with Top Drop Source surface) | `linux_messages_syslog`, `syslog`, `linux_secure` |
| [Windows Events](platform.md#windows-events) | Windows operational health — event severity trends, top event codes, service state changes, PowerShell activity | `XmlWinEventLog` |
| [Proxy Analytics](platform.md#proxy-analytics) | Squid proxy traffic, top domains by bandwidth, cache action distribution, client diversity | `squid:access` |
| [Host Details](platform.md#host-details) | Per-host drill-down with Overview, Role Activity, and Sourcetype Mapping tabs; role-specific panels auto-hide for hosts without that data | All sourcetypes (filtered by host) |

!!! tip "Searching LogServ data"
    All dashboards use the `sap_logserv_idx_macro` macro to query the LogServ index. You can use this same macro in your own searches: `` `sap_logserv_idx_macro` | stats count by sourcetype ``

!!! tip "Cross-dashboard navigation"
    Every dashboard includes a **Navigate to Dashboard** dropdown and **Go** button (top-left) that preserves your selected time range when switching between dashboards.

!!! tip "In-dashboard help — the "More Info" button"
    Every dashboard also includes a **More Info** button at the top-right of the toolbar row. Clicking it opens this online documentation in a new browser tab, jumping directly to the section for the dashboard you're looking at. For multi-tab dashboards (Data Pipeline Overview and Host Details) the button lives on every tab and always links back to the same dashboard's section in the docs.

---

## :material-circle-box:{ .taiconcolor } Visual Style

All dashboards share a consistent "framed dark cards" visual language so that patterns are easy to recognize as you move between views:

- **Dark page background** with slightly lighter navy **panel cards** outlined in cyan -- each visualization sits inside its own framed card with consistent spacing
- **KPI typography** -- large numeric headline with a small muted label; number color carries semantic meaning (white for neutral counts, red for errors/failures/denials, orange for warnings, teal for healthy/positive signals)
- **Standard colors** -- a single standard red (`#dc4e41`) is used across all error/failure signals so that "red means something went wrong" is unambiguous
- **Tables** use a fixed dark header row with alternating row striping; clickable cells are highlighted cyan to indicate a drilldown affordance
- **Charts** strip non-essential ink (no axis titles, no data labels, no progress bars) so the data shape is what your eye lands on

### :material-lightning-bolt:{ .taiconcolor } KPI Sparklines

Most KPI panels display a small inline **sparkline** directly below the headline number. The sparkline visualizes the daily trend across the dashboard's current time range, so you get both the cumulative total and the shape of how that total accumulated in a single glance. There is no separate "up/down by N" trend value -- the sparkline alone carries the trend signal.

Sparklines come in a few flavors depending on what the KPI measures:

- **Count-based KPIs** (e.g., Total Events, Auth Failures) -- sparkline shows daily event count
- **Distinct-count KPIs** (e.g., Active Hosts, Unique Components) -- sparkline shows daily distinct count
- **Rate KPIs** (e.g., HTTP Error Rate, Web Error Rate %) -- sparkline shows daily error percentage
- **Volume KPIs** (e.g., Total Volume, Total Bandwidth) -- sparkline shows daily MB; headline shows formatted KB/MB/GB
- **Empty-safe wrap** -- when a KPI's search returns zero events, the KPI displays `0` (rather than `###`) with a flat-zero sparkline

Two KPIs intentionally skip sparklines: the navigation button (not a KPI) and **Top Drop Source** on the Linux dashboard (displays a string like `10.186.64.6 (8,522)` rather than a numeric count).

### :material-lightning-bolt:{ .taiconcolor } Click-Through Drilldowns

Most KPIs, table rows, and many chart points are clickable:

- **Clicking a KPI** opens the Splunk search app with the matching events, sorted newest first
- **Clicking a table row** opens a filtered view for that specific value (e.g., sourcetype, host, user, source IP)
- **Clicking a chart point** typically opens the underlying search for that time bucket or series

Where a table has clickable cells, the cyan color on that cell is the visual cue.
