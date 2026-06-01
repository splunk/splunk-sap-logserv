# Platform

The **Platform** category covers the infrastructure underneath SAP — data pipeline health (Splunk ingest), network services (DNS, Proxy), host operating systems (Linux, Windows), and a per-host forensic drill-down. These dashboards answer questions about the underlying systems and the data-collection pipeline itself rather than the SAP workloads on top. The graph-based [Environment Topology](topology.md) view is its own top-level entry in the app nav, not a Platform-group dashboard.

!!! tip "v0.0.5.0 React refinements (apply to every dashboard in this category)"
    Every panel, KPI card, chart, and table row is clickable and opens its drill-down destination in a new browser tab with the source dashboard's currently-selected time range pre-applied via `?earliest=...&latest=...`. The destination's `TimeRangeProvider` parses the URL on mount and hydrates its initial range. Every dashboard's title-row toolbar carries a per-dashboard **Refresh** picker (Never / 30s / 1m / 5m / 15m / 30m / 1hr) with per-user-per-dashboard cadence persisted via Splunk KV Store, plus a **Download PNG** button (full-canvas capture via `html2canvas`).

| Dashboard | Purpose | Key Data Sources |
|-----------|---------|-----------------|
| [Data Pipeline Overview](platform/data-pipeline-overview.md) | Ingest pipeline view: 5 KPIs, Sourcetype Summary table, host activity, and source-to-sourcetype link graph (in second tab). Two tabs (Overview + Linked Graph). Dashboard-wide host filter in title row scopes every panel + the linked graph. | All sourcetypes |
| [Multi-Cloud Overview](platform/multi-cloud-overview.md) | Per-cloud-provider ingest split: AWS vs Azure event counts, sourcetype distribution per provider, recent activity. Built on the indexed `cloud_provider` field with the `sap_logserv_cloud_provider_default_macro` for legacy AWS defaulting. See [Azure Setup Guide](../../install-setup/azure-setup.md) for Azure-side configuration. | All sourcetypes (filtered by `cloud_provider`) |
| [DNS Analytics](platform/dns-analytics.md) | DNS query analysis, top resolvers, beaconing detection, and client activity | `isc:bind:query`, `isc:bind:network`, `isc:bind:transfer` |
| [Linux System & Security](platform/linux.md) | Linux OS events, SAP application activity, and firewall monitoring (with Top Drop Source surface) | `linux_messages_syslog`, `linux:cron`, `linux:warn`, `linux:sudolog`, `linux:slapd`, `linux_secure` |
| [Windows Events](platform/windows.md) | Windows operational health — event severity trends, top event codes, service state changes, PowerShell activity | `XmlWinEventLog` |
| [Proxy Analytics](platform/proxy.md) | Squid proxy traffic, top domains by bandwidth, cache action distribution, client diversity | `squid:access` |
| [Host Details](platform/host-details.md) | Per-host drill-down with Overview, Role Activity, and Sourcetype Mapping tabs. Title-row Multiselect filter to one host, multiple hosts (`host IN (...)`), or All Hosts; role-specific panels auto-hide for hosts without that data. | All sourcetypes (host-filtered) |
