# Dashboards Overview

The LogServ App includes React-based dashboards organized as one top-level landing page and four purpose-driven navigation groups, plus an **Environment Topology** view and a **Diagnostics (Data Doctor)** page. The app is built on `@splunk/react-ui` + `@splunk/visualizations` + `@xyflow/react` and ships as a single React bundle. Requires Splunk 9.4.3 or later.

The top menu is:

**Environment Health** (default landing) · **Topology** · **Applications ▼** · **Integration ▼** · **Security ▼** · **Platform ▼** · **About**

The right-hand cluster holds the theme toggle (light/dark) · **Settings** (admin-tier roles only) · **Actions ▾** · **AI Assistant** (when enabled) · the time-range picker · **Refresh**.

Use this page as an index — click any dashboard below to see its full purpose, panel list, and interpretation guide on the corresponding category page.

## :material-circle-box:{ .taiconcolor } Full Inventory

### Start Here

| Dashboard | Purpose | Key Data Sources |
|-----------|---------|-----------------|
| [Environment Health](environment-health.md) | Cross-cutting operations view of errors, security failures, and performance across the entire SAP landscape. Default landing page. | All sourcetypes |

### Topology

| Dashboard | Purpose | Key Data Sources |
|-----------|---------|-----------------|
| [Environment Topology](topology.md) | Interactive graph view of SAP systems, integration partners, and endpoints. Force-directed initial layout, self-derived IP→SID inventory, named saved layouts via KV Store. KV Store refreshed hourly by scheduled saved searches (the IP-node name-enrichment layer refreshes once daily); manual Refresh button in the toolbar for on-demand re-fetch. | `sap:abap:gateway`, `sap:abap:icm`, `sap:hana:audit`, `sap:hana:tracelogs`, `sap:webdispatcher:access` (graph + inventory); IP-node name enrichment additionally reads `XmlWinEventLog`, `sap:sapstartsrv`, `linux_secure`, `linux_messages_syslog` |

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
| [Web and API Performance](integration/web-api-performance.md) | Four-stage request timing, response-time Avg/Max trends, TLS posture, cross-source error correlation | `sap:webdispatcher:access`, `sap:scc:http_access` |

### Security (cross-source synthesis + compliance)

| Dashboard | Purpose | Key Data Sources |
|-----------|---------|-----------------|
| [Network Perimeter](security/network-perimeter.md) | Unified network-boundary view: firewall drops (inbound), proxy outbound traffic, DNS resolution, and cross-source suspicious-activity correlation | `linux_secure`, `squid:access`, `isc:bind:query` |
| [Cross-Stack Authentication](security/cross-stack-authentication.md) | Unified authentication failure analysis across SAP, HANA, and Windows layers | `sap:sapstartsrv`, `sap:hana:audit`, `XmlWinEventLog` |
| [Change & Configuration Activity](security/change-config.md) | Cross-stack audit trail: HANA user/role/privilege changes, Windows account and group modifications, Linux sudo and user-management activity, with compliance-focused privileged and after-hours views | `sap:hana:audit`, `XmlWinEventLog`, `linux:sudolog`, `linux_messages_syslog` (plus the other `linux:*` sourcetypes) |

### Platform (underlying infrastructure, ingest, and forensics)

| Dashboard | Purpose | Key Data Sources |
|-----------|---------|-----------------|
| [Data Pipeline Overview](platform/data-pipeline-overview.md) | Ingest pipeline view: 4 KPIs, Sourcetype Summary table, host activity, and source-to-sourcetype link graph. Two tabs (Overview + Sourcetype Mapping). Dashboard-wide host filter in title row scopes every panel + the linked graph. | All sourcetypes |
| [Multi-Cloud Overview](platform/multi-cloud-overview.md) | Per-cloud-provider ingest split: AWS / Azure / GCP event counts, sourcetype distribution per provider, recent activity. Built on the indexed `cloud_provider` field with the `sap_logserv_cloud_provider_default_macro` for legacy AWS defaulting. See the [Azure Setup Guide](../../install-setup/azure-setup.md) and [GCP Setup Guide](../../install-setup/gcp-setup.md). | All sourcetypes (filtered by `cloud_provider`) |
| [DNS Analytics](platform/dns-analytics.md) | DNS query analysis, top resolvers, beaconing detection, and client activity | `isc:bind:query`, `isc:bind:queryerror` (scoped by `tag=dns`) |
| [Linux System & Security](platform/linux.md) | Linux OS events, SAP application activity, and firewall monitoring (with Top Drop Source surface) | `linux_messages_syslog`, `linux:cron`, `linux:warn`, `linux:sudolog`, `linux:slapd`, `linux_secure` |
| [Windows Events](platform/windows.md) | Windows operational health — event severity trends, top event codes, service state changes, PowerShell activity | `XmlWinEventLog` |
| [Proxy Analytics](platform/proxy.md) | Squid proxy traffic, top domains by bandwidth, cache action distribution, client diversity | `squid:access` |
| [Host Details](platform/host-details.md) | Per-host drill-down with Overview, Role Activity, and Sourcetype Mapping tabs. Title-row Multiselect lets you filter to one host, multiple hosts (`host IN (...)`), or All Hosts; role-specific panels auto-hide for hosts without that data. | All sourcetypes (host-filtered) |
| [Diagnostics (Data Doctor)](platform/diagnostics.md) | Environment-wide data-health view: rollup freshness and history, sourcetype presence, platform snapshot, and downloadable diagnostic reports for support. | Platform metadata + KV rollups |

!!! tip "Searching LogServ data"
    All dashboards use the `sap_logserv_idx_macro` macro to query the LogServ index. You can use this same macro in your own searches: `` `sap_logserv_idx_macro` | stats count by sourcetype ``

!!! tip "Cross-dashboard navigation"
    Use the top navigation bar (Environment Health · Topology · Applications ▾ · Integration ▾ · Security ▾ · Platform ▾) to move between dashboards — the selected time range is held app-wide, so it follows you. Table-row drill-downs likewise carry the time range to their destination via URL parameters.

!!! tip "In-dashboard help — the ? icon"
    Every dashboard's title row ends with a blue rotating **?** help icon. Clicking it opens this online documentation in a new browser tab, jumping directly to the section for the dashboard you're looking at. For multi-tab dashboards (Data Pipeline Overview and Host Details) the icon is present on every tab and always links back to the same dashboard's section in the docs.

!!! tip "Per-dashboard auto-refresh"
    Each dashboard's title row carries a **Refresh** picker (Never / 30s / 1m / 5m / 15m / 30m / 1hr) next to the time-range picker. The selection is per-user-per-dashboard — your choice on Environment Health doesn't carry over to HANA Audit. State persists across browser sessions via Splunk KV Store. (The Diagnostics page has no auto-refresh picker — it re-runs its checks on demand.)

!!! tip "Refresh the current view on demand"
    The app's top **navigation bar** carries a **Refresh** button — a circular-arrow icon to the right of the time-range picker, alongside the theme toggle, Settings, and AI Assistant controls. Clicking it re-runs **every panel on the dashboard you're currently viewing** for the selected time range — a one-click "get me the latest." It is distinct from the per-dashboard auto-refresh picker above (which re-runs on a timer) and from each panel's own **Refresh** toolbar action (which re-runs a single panel). Because it lives in the global nav bar, it's available on every dashboard and on the Environment Topology view.

!!! tip "Filter by cloud provider"
    Every dashboard except Multi-Cloud Overview, Environment Topology, Diagnostics, and Settings carries a **Cloud Provider** dropdown (`All / aws / azure / gcp`) in its title row, to the left of the Refresh picker. Choosing a provider filters **every panel** on the dashboard to that cloud; the choice is **global and remembered per user**, so it carries across dashboard navigation and page reloads. Leave it on **All** to see the whole estate. (Events with no cloud attribution are counted as `aws`, matching the Multi-Cloud Overview convention.)

!!! tip "Which build am I running? — the About dialog"
    The navigation bar's **About** item (to the right of *Platform*) opens a dialog showing the app icon, the product name, and the **version**, **build number** and **build date** (UTC) of the app you are running. Use it to confirm an upgrade landed, or to quote the exact build when reporting an issue. The values are read from the app's own `app.conf` at build time (the date is stamped as the bundle is compiled), so they always match the installed bundle.

!!! tip "Performance & data freshness"
    The dashboards are tuned to stay fast at high event volume — most panels read from an hourly KV-Store rollup layer rather than scanning raw events on every open. After a fresh install on a large environment, an admin runs a one-time backfill. See [Dashboard Performance & Data Freshness](performance.md) for how each panel sources its data, what "hourly fresh" means, and the backfill step.

---

## :material-circle-box:{ .taiconcolor } Visual Style

All dashboards share a consistent framed-card visual language, built on Cisco's Magnetic design tokens, so that patterns are easy to recognize as you move between views. The app ships **light and dark modes** — toggled via the nav bar's sun/moon button, persisted per user — and every color is a mode-resolved design token rather than a fixed hex:

- **Page background** with slightly lighter **panel cards** outlined by a muted border token — each visualization sits inside its own framed card with consistent spacing
- **KPI typography** — large numeric headline with a small muted label; number color carries semantic meaning (white for neutral counts, red for errors/failures/denials, orange for warnings, teal for healthy/positive signals)
- **Standard colors** — a single semantic red token is used across all error/failure signals so that "red means something went wrong" is unambiguous in both modes
- **Tables** use a fixed header row with alternating row striping; clickable cells are highlighted in the accent color to indicate a drilldown affordance
- **Charts** strip non-essential ink (no axis titles, no data labels, no progress bars) so the data shape is what your eye lands on

The implementation uses styled-components on top of `@splunk/react-ui` primitives. Compared to the v0.0.4.x Dashboard Studio v2 era, search-time field extractions are unchanged — what changed is purely the rendering tier.

### :material-lightning-bolt:{ .taiconcolor } KPI Sparklines

Most KPI panels display a small inline **sparkline** directly below the headline number. The sparkline visualizes the daily trend across the dashboard's current time range, so you get both the cumulative total and the shape of how that total accumulated in a single glance. There is no separate "up/down by N" trend value — the sparkline alone carries the trend signal.

Sparklines come in a few flavors depending on what the KPI measures:

- **Count-based KPIs** (e.g., Total Events, Auth Failures) — sparkline shows daily event count
- **Distinct-count KPIs** (e.g., Active Hosts, Unique Components) — sparkline shows daily distinct count
- **Rate KPIs** (e.g., HTTP Error Rate, Web Error Rate %) — sparkline shows daily error percentage
- **Volume KPIs** (e.g., Total Volume, Total Bandwidth) — sparkline shows daily MB; headline shows formatted KB/MB/GB
- **No-data rendering** — while a KPI's search runs, the card shows a small spinner; a search that returns no rows renders an em-dash (—) plus a short inline explanation of why (see [Data Doctor](platform/diagnostics.md)). KPIs with an empty-safe SPL wrap render `0` instead, with a flat-zero sparkline

### :material-lightning-bolt:{ .taiconcolor } Click-Through Drilldowns

Table rows are the main drill-down surface; Environment Health additionally makes its KPI cards and chart panels clickable, and other dashboards wire panel-level drill-downs selectively:

- **Clicking a KPI** opens a contextual destination — typically the related drill-down dashboard with the current time range preserved, or Splunk's Search app with a pre-built SPL query for cross-cutting KPIs (e.g., the Environment Health "Total Errors" KPI runs a cross-cutting OR search spanning every error-bearing sourcetype across the estate).
- **Clicking a table row** opens a filtered view — Host Details for `host` columns, the relevant specialist dashboard for `sourcetype` columns, or Splunk's Search app with the row's context spliced into a SPL filter.
- **Clicking a chart panel** — on dashboards that wire a panel-level drill-down, clicking anywhere in the panel (outside its toolbar) opens the related dashboard or search. Individual chart points are not separately clickable.
- Every drill-down opens in a **new browser tab** with `noopener,noreferrer` security flags. Time-range query params (`?earliest=...&latest=...`) are preserved across the navigation so the destination loads at the source dashboard's window.

### :material-lightning-bolt:{ .taiconcolor } AI Assistant Drill-Down Chips

Tool-result tiles in the AI Assistant's right pane carry two drill-down chips in their actions slot, alongside the Clear button:

- **`↗ <Dashboard name>`** — opens the related OOTB dashboard (one chip per related dashboard for prompts mapped to multiple, each labelled with the destination's name). Sourced from the intent map's `dashboard` field.
- **`↗ Run SPL`** — opens Splunk's universal Search app with the tool's SPL pre-populated and the dispatch's exact earliest/latest pre-applied. The same chip renders alongside `[→ saved_search]` citations in the left-hand conversation pane — on the guidance card a predefined prompt produces, and (in the [full-LLM build variant](../../ai-assistant/templates-only-build.md)) in the assistant's narrative.

These chips connect the AI Assistant's investigation flow back into the dashboards: a top-N finding tile leads directly to the relevant dashboard, OR to a raw-search drill-down at the same time window the AI just queried.

### :material-lightning-bolt:{ .taiconcolor } Dashboard Export (Actions Menu)

The navigation bar's **Actions** menu includes **Download PNG** and **Download PDF**. Both captures use `html2canvas` to render the full dashboard DOM (including off-screen content), so the saved output always covers the entire dashboard length — not just what's visible in the viewport. Useful for sharing in slide decks, embedding in incident reports, or capturing a dashboard's state at a specific moment for compliance evidence. The same menu carries the two [Data Doctor](platform/diagnostics.md) reports — **Diagnose dashboard (PDF)** and **Environment report (PDF)**.
