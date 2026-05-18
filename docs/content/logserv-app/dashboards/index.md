# Dashboards Overview

The LogServ App includes **twenty-two React-based dashboards** plus an **Environment Topology** view, organized as one top-level landing page and four purpose-driven navigation groups. The app is built on `@splunk/react-ui` + `@splunk/visualizations` + `@xyflow/react` and ships as a single React bundle. Requires Splunk 9.4.3 or later.

The top menu is:

**Environment Health** (default landing) · **Topology** · **Applications ▼** · **Integration ▼** · **Security ▼** · **Platform ▼** · **AI Assistant** · **Search**

Use this page as an index — click any dashboard below to see its full purpose, panel list, and interpretation guide on the corresponding category page.

## :material-circle-box:{ .taiconcolor } Full Inventory

### Start Here

| Dashboard | Purpose | Key Data Sources |
|-----------|---------|-----------------|
| [Environment Health](environment-health.md) | Cross-cutting operations view of errors, security failures, and performance across the entire SAP landscape. Default landing page. | All sourcetypes |

### Topology

| Dashboard | Purpose | Key Data Sources |
|-----------|---------|-----------------|
| [Environment Topology](topology.md) | Interactive graph view of SAP systems, integration partners, and endpoints. Force-directed initial layout, self-derived IP→SID inventory, named saved layouts via KV Store. KV Store refreshed hourly by scheduled saved searches; manual Refresh button in the toolbar for on-demand re-fetch. | `sap:abap:gateway`, `sap:abap:icm`, `sap:hana:tracelogs`, `sap:saprouter`, plus host inventory from `linux_messages_syslog` osquery events |

### Applications (SAP application runtime)

| Dashboard | Purpose | Key Data Sources |
|-----------|---------|-----------------|
| [ABAP Network & Security](applications/abap-security.md) | ICM traffic analysis, gateway monitoring, and ABAP audit events | `sap:abap:icm`, `sap:abap:gateway`, `sap:abap:audit` |
| [ABAP Operations](applications/abap-operations.md) | ABAP runtime health, dispatcher status, work process activity, and system uptime | `sap:abap:dispatcher`, `sap:abap:enqueueserver`, `sap:abap:event`, `sap:abap:messageserver`, `sap:abap:sapstartsrv`, `sap:abap:workprocess` |
| [Work Process Performance](applications/work-process-performance.md) | SAP ABAP work process utilization, dispatcher health, and function-level activity | `sap:abap:workprocess`, `sap:abap:dispatcher` |
| [HANA Audit](applications/hana-audit.md) | SAP HANA database audit events, security monitoring, user activity, risk-tiered events, and after-hours admin activity | `sap:hana:audit` |
| [HANA Trace](applications/hana-trace.md) | SAP HANA database trace logs, component health, and error analysis | `sap:hana:tracelogs` |

### Integration (how SAP connects to other systems)

| Dashboard | Purpose | Key Data Sources |
|-----------|---------|-----------------|
| [SAP Services](integration/sap-services.md) | sapstartsrv authentication, SSL/TLS failure analysis, and host agent health | `sap:sapstartsrv`, `sap:saphostexec` |
| [SAP Router](integration/sap-router.md) | SAP Router connection activity, error analysis, and network boundary monitoring | `sap:saprouter` |
| [Cloud Connector](integration/cloud-connector.md) | SAP Cloud Connector HTTP traffic, audit events, and access denied events | `sap:scc:audit`, `sap:scc:http_access` |
| [Web Dispatcher](integration/web-dispatcher.md) | HTTP traffic analysis, response times, status codes, and client patterns | `sap:webdispatcher:access` |
| [Web and API Performance](integration/web-api-performance.md) | Four-stage request timing, response-time percentiles, TLS posture, cross-source error correlation | `sap:webdispatcher:access`, `sap:scc:http_access` |

### Security (cross-source synthesis + compliance)

| Dashboard | Purpose | Key Data Sources |
|-----------|---------|-----------------|
| [Network Perimeter](security/network-perimeter.md) | Unified network-boundary view: firewall drops (inbound), proxy outbound traffic, DNS resolution, and cross-source suspicious-activity correlation | `linux_secure`, `squid:access`, `isc:bind:query` |
| [Cross-Stack Authentication](security/cross-stack-authentication.md) | Unified authentication failure analysis across SAP, HANA, and Windows layers | `sap:sapstartsrv`, `sap:hana:audit`, `XmlWinEventLog` |
| [Change & Configuration Activity](security/change-config.md) | Cross-stack audit trail: HANA user/role/privilege changes, Windows account and group modifications, Linux sudo and user-management activity, with compliance-focused privileged and after-hours views | `sap:hana:audit`, `XmlWinEventLog`, `linux_messages_syslog` |

### Platform (underlying infrastructure, ingest, and forensics)

| Dashboard | Purpose | Key Data Sources |
|-----------|---------|-----------------|
| [Data Pipeline Overview](platform/data-pipeline-overview.md) | Ingest pipeline view: 5 KPIs, Sourcetype Summary table, host activity, and source-to-sourcetype link graph. Two tabs (Overview + Linked Graph). Dashboard-wide host filter in title row scopes every panel + the linked graph. | All sourcetypes |
| [DNS Analytics](platform/dns-analytics.md) | DNS query analysis, top resolvers, beaconing detection, and client activity | `isc:bind:query`, `isc:bind:network`, `isc:bind:transfer` |
| [Linux System & Security](platform/linux.md) | Linux OS events, SAP application activity, and firewall monitoring (with Top Drop Source surface) | `linux_messages_syslog`, `linux:cron`, `linux:warn`, `linux:sudolog`, `linux:slapd`, `linux_secure` |
| [Windows Events](platform/windows.md) | Windows operational health — event severity trends, top event codes, service state changes, PowerShell activity | `XmlWinEventLog` |
| [Proxy Analytics](platform/proxy.md) | Squid proxy traffic, top domains by bandwidth, cache action distribution, client diversity | `squid:access` |
| [Host Details](platform/host-details.md) | Per-host drill-down with Overview, Role Activity, and Sourcetype Mapping tabs. Title-row Multiselect lets you filter to one host, multiple hosts (`host IN (...)`), or All Hosts; role-specific panels auto-hide for hosts without that data. | All sourcetypes (host-filtered) |

!!! tip "Searching LogServ data"
    All dashboards use the `sap_logserv_idx_macro` macro to query the LogServ index. You can use this same macro in your own searches: `` `sap_logserv_idx_macro` | stats count by sourcetype ``

!!! tip "Cross-dashboard navigation"
    Every dashboard includes a **Navigate to Dashboard** dropdown and **Go** button (top-left) that preserves your selected time range when switching between dashboards.

!!! tip "In-dashboard help — the More Info button"
    Every dashboard also includes a **More Info** button at the top-right of the toolbar row. Clicking it opens this online documentation in a new browser tab, jumping directly to the section for the dashboard you're looking at. For multi-tab dashboards (Data Pipeline Overview and Host Details) the button lives on every tab and always links back to the same dashboard's section in the docs.

!!! tip "Per-dashboard auto-refresh"
    Each dashboard's title row carries a **Refresh** picker (Never / 30s / 1m / 5m / 15m / 30m / 1hr) next to the time-range picker. The selection is per-user-per-dashboard — your choice on Environment Health doesn't carry over to HANA Audit. State persists across browser sessions via Splunk KV Store.

---

## :material-circle-box:{ .taiconcolor } Visual Style

All dashboards share a consistent "framed dark cards" visual language so that patterns are easy to recognize as you move between views:

- **Dark page background** (`#0d1117`) with slightly lighter navy **panel cards** (`#141b2d`) outlined in cyan (`#0877a6`) — each visualization sits inside its own framed card with consistent 12 px spacing
- **KPI typography** — large numeric headline with a small muted label; number color carries semantic meaning (white for neutral counts, red for errors/failures/denials, orange for warnings, teal for healthy/positive signals)
- **Standard colors** — a single standard red (`#dc4e41`) is used across all error/failure signals so that "red means something went wrong" is unambiguous
- **Tables** use a fixed dark header row with alternating row striping; clickable cells are highlighted cyan to indicate a drilldown affordance
- **Charts** strip non-essential ink (no axis titles, no data labels, no progress bars) so the data shape is what your eye lands on

The implementation uses styled-components on top of `@splunk/react-ui` primitives. Compared to the v0.0.4.x Dashboard Studio v2 era, search-time field extractions are unchanged — what changed is purely the rendering tier.

### :material-lightning-bolt:{ .taiconcolor } KPI Sparklines

Most KPI panels display a small inline **sparkline** directly below the headline number. The sparkline visualizes the daily trend across the dashboard's current time range, so you get both the cumulative total and the shape of how that total accumulated in a single glance. There is no separate "up/down by N" trend value — the sparkline alone carries the trend signal.

Sparklines come in a few flavors depending on what the KPI measures:

- **Count-based KPIs** (e.g., Total Events, Auth Failures) — sparkline shows daily event count
- **Distinct-count KPIs** (e.g., Active Hosts, Unique Components) — sparkline shows daily distinct count
- **Rate KPIs** (e.g., HTTP Error Rate, Web Error Rate %) — sparkline shows daily error percentage
- **Volume KPIs** (e.g., Total Volume, Total Bandwidth) — sparkline shows daily MB; headline shows formatted KB/MB/GB
- **Empty-safe wrap** — when a KPI's search returns zero events, the KPI displays `0` (rather than `###`) with a flat-zero sparkline

### :material-lightning-bolt:{ .taiconcolor } Click-Through Drilldowns

Most KPIs, table rows, and many chart points are clickable:

- **Clicking a KPI** opens a contextual destination — typically the related drill-down dashboard with the current time range preserved, or Splunk's Search app with a pre-built SPL query for cross-cutting KPIs (e.g., the Environment Health "Total Errors" KPI runs an 11-sourcetype OR search across the estate).
- **Clicking a table row** opens a filtered view — Host Details for `host` columns, the relevant specialist dashboard for `sourcetype` columns, or Splunk's Search app with the row's context spliced into a SPL filter.
- **Clicking a chart point** typically opens the underlying search for that time bucket or series.
- Every drill-down opens in a **new browser tab** with `noopener,noreferrer` security flags. Time-range query params (`?earliest=...&latest=...`) are preserved across the navigation so the destination loads at the source dashboard's window.

### :material-lightning-bolt:{ .taiconcolor } AI Assistant Drill-Down Chips

Tool-result tiles in the AI Assistant's right pane carry two drill-down chips in their actions slot, alongside the Clear button:

- **`↗ Dashboard`** — opens the related OOTB dashboard (one chip per related dashboard for prompts mapped to multiple). Sourced from the intent map's `dashboard` field.
- **`↗ Run SPL`** — opens Splunk's universal Search app with the tool's SPL pre-populated and the dispatch's exact earliest/latest pre-applied. The same chip renders alongside `[→ saved_search]` citations in the chat narrative on the left pane.

These chips connect the AI Assistant's investigation flow back into the dashboards: a top-N finding tile leads directly to the relevant dashboard, OR to a raw-search drill-down at the same time window the AI just queried.

### :material-lightning-bolt:{ .taiconcolor } Download PNG

Every dashboard's title-row toolbar includes a **Download PNG** button. The capture uses `html2canvas` to render the full dashboard DOM (including off-screen content) to a PNG file, so the saved image always covers the entire dashboard length — not just what's visible in the viewport. Useful for sharing in slide decks, embedding in incident reports, or capturing a dashboard's state at a specific moment for compliance evidence.
