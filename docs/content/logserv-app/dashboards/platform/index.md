# Platform

The **Platform** category covers the infrastructure underneath SAP — data pipeline health (Splunk ingest), network services (DNS, Proxy), host operating systems (Linux, Windows), a per-host forensic drill-down, the per-cloud ingest split, and the Data Doctor's Diagnostics page. These dashboards answer questions about the underlying systems and the data-collection pipeline itself rather than the SAP workloads on top. The graph-based [Environment Topology](../topology.md) view is its own top-level entry in the app nav, not a Platform-group dashboard.

The table follows the order of the App's Platform flyout.

| Dashboard | Purpose | Key Data Sources |
|-----------|---------|-----------------|
| [Data Pipeline Overview](data-pipeline-overview.md) | Ingest pipeline view: 4 KPIs, Sourcetype Summary table, host activity, and source-to-sourcetype link graph (in second tab). Two tabs (Overview + Sourcetype Mapping). Dashboard-wide host filter in title row scopes every panel + the linked graph. | All sourcetypes |
| [DNS Analytics](dns-analytics.md) | DNS query analysis, top resolvers, beaconing detection, and client activity | `isc:bind:query`, `isc:bind:queryerror` (scoped by `tag=dns`) |
| [Linux System & Security](linux.md) | Linux OS events, SAP application activity, and firewall monitoring (with Top Drop Source surface) | `linux_messages_syslog`, `linux:cron`, `linux:warn`, `linux:sudolog`, `linux:slapd`, `linux_secure` |
| [Windows Events](windows.md) | Windows operational health — event severity trends, top event codes, service state changes, PowerShell activity | `XmlWinEventLog` |
| [Proxy Analytics](proxy.md) | Squid proxy traffic, top domains by bandwidth, cache action distribution, client diversity | `squid:access` |
| [Host Details](host-details.md) | Per-host drill-down with Overview, Role Activity, and Sourcetype Mapping tabs. Title-row Multiselect filter to one host, multiple hosts (`host IN (...)`), or All Hosts; role-specific panels auto-hide for hosts without that data. | All sourcetypes (host-filtered) |
| [Multi-Cloud Overview](multi-cloud-overview.md) | Per-cloud-provider ingest split: AWS / Azure / GCP event counts, sourcetype distribution per provider, recent activity. Built on the indexed `cloud_provider` field with the `sap_logserv_cloud_provider_default_macro` for legacy AWS defaulting. See the [Azure Setup Guide](../../../install-setup/azure-setup.md) and [GCP Setup Guide](../../../install-setup/gcp-setup.md) for cloud-side configuration. | All sourcetypes (filtered by `cloud_provider`) |
| [Diagnostics (Data Doctor)](diagnostics.md) | Environment-wide data-health view: rollup freshness and history, sourcetype presence, platform snapshot, and downloadable diagnostic reports for support. | Platform metadata + KV rollups |

Multi-Cloud Overview and Diagnostics carry no Cloud filter, and Diagnostics has no auto-refresh picker: it re-runs its checks on demand. The controls the other dashboards share (time range, Cloud filter, auto-refresh, panel toolbar, drill-downs, export) are described once in the [Dashboards Overview](../index.md#common-dashboard-controls).
