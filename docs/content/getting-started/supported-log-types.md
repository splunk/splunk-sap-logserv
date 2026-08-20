# Supported Log Types

### :material-circle-box:{ .taiconcolor } Overview

SAP ECS environment logs are not a singular data source but a collection of OS-specific, SAP environment, database, and other application logs.

Due to the nature of this solution, the SAP LogServ packages are not standalone integrations. To take full advantage of their capabilities (like CIM mapping), you need to install additional TAs as specified in the [Prerequisites](../install-setup/prerequisites.md).

For a streamlined data ingestion process, all selected logs are ingested under one sourcetype: `sap_logserv_logs`. They are then assigned to a final sourcetype during parsing/indexing on the Heavy Forwarder (or Indexer in single-instance mode), based on the `source` field.

All events are in NDJSON format with metadata (like _time, host, source, etc.) and the _raw field containing the event contents.
To limit index size, only the _raw field is ingested from each event -- metadata fields are either mapped to Splunk's native metadata fields or dropped.
However `clz_dir` and `clz_subdir` fields are preserved to maintain backtracking capabilities. These fields correspond to the directory tree of the original data in object storage.

The Data TA also stamps `splunk_solution` (always `splunk_for_sap_logserv`, identifying events that flowed through this solution) at index time on every routed event. It can additionally stamp `cloud_provider` (`aws`, `azure`, or `gcp`, identifying the cloud the data was ingested from) — the Azure and GCP ingest add-ons set it automatically per input, while for AWS (or TA-wide) it is enabled via the Data TA's **Configuration → Cloud Provider** dropdown, which ships as **Not set**; see [Configuring Filters → Cloud Provider Attribution](../install-setup/configure-filters.md#cloud-provider-attribution) for details.

!!! note "Ingest channel: AWS S3, Azure Blob Storage, or Google Cloud Storage"
    The sourcetype mappings below apply identically to all three ingest channels — **AWS S3** (via the Splunk Add-on for AWS), **Azure Blob Storage** (via the Splunk TA for SAP LogServ on Azure add-on), and **Google Cloud Storage** (via the Splunk TA for SAP LogServ on GCP add-on). The Data TA's index-time routing transforms key on the `clz_dir` / `clz_subdir` fields carried inside each NDJSON event (and, for the OS/DNS/proxy types, on the event's `source` path), which the SAP LogServ collector writes the same way regardless of object-storage destination. See the [Azure Setup Guide](../install-setup/azure-setup.md) and the [GCP Setup Guide](../install-setup/gcp-setup.md) for cloud-specific configuration; AWS S3 is covered under [Prerequisites](../install-setup/prerequisites.md). Azure- and GCP-ingested events carry an indexed `cloud_provider` field automatically (stamped per input by their add-on); AWS-ingested events carry it once you set the Cloud Provider dropdown (or add `_meta = cloud_provider::aws` to the AWS S3 inputs on a mixed forwarder) — see [Cloud Provider Attribution](../install-setup/configure-filters.md#cloud-provider-attribution).

### :material-circle-box:{ .taiconcolor } LogServ Object Storage Path Structure

The log files in the SAP LogServ object storage location (AWS S3 bucket, Azure Blob Storage container, or GCS bucket) follow this path pattern (the leading container/prefix segment is environment-specific — `logserv/` here; some landscapes use e.g. `clzlogserv/`):

```
<prefix>/<clz_dir>/<clz_subdir>/<YYYY>/<MM>/<DD>/<filename>.json.gz
```

For example:

```
logserv/linux/messages/2025/09/15/messages-abc123.json.gz
logserv/hana/hanaaudit/2025/10/01/hana-xyz789.json.gz
logserv/dns/binddns/2025/11/20/dns-def456.json.gz
```

The `clz_dir/clz_subdir` values are used by the index-time filter to match include/exclude patterns. See [Configuring Filters](../install-setup/configure-filters.md) for details.

## :material-circle-box:{ .taiconcolor } Primary Supported Log Types

These log types have **dedicated parsing logic** — index-time routing to a specific final sourcetype, plus search-time field extractions — to provide the most accurate parsing. The tables below show the sourcetype mapping for each.

### SAP HANA Audit (LogServ App)

The LogServ App provides rich search-time field extractions for SAP HANA audit events — the full audit-record field set (service, host, SID, user, action, status, SQL statement, and the derived risk/criticality fields) plus CIM field aliases.

| Source field value | Sourcetype assigned | Filter path |
|-------------------|-------------------|-------------|
| hana audit log | `sap:hana:audit` | `hana/hanaaudit` |

### SAP Web Dispatcher (LogServ App)

The LogServ App provides search-time field extractions for SAP Web Dispatcher access logs — client/method/status/URI, four-stage timing, TLS posture, and derived response-time / error fields, plus CIM field aliases.

| Source field value | Sourcetype assigned | Filter path |
|-------------------|-------------------|-------------|
| web dispatcher access log | `sap:webdispatcher:access` | `webdispatcher/accesslog` |

### SAP ABAP Application Logs (LogServ App)

The LogServ App provides search-time field extractions for 9 SAP ABAP application log types. Each sourcetype includes `sap_sid` and `sap_instance` extraction from the `source` metadata field, plus type-specific field extractions.

| Source field value | Sourcetype assigned | Filter path |
|-------------------|-------------------|-------------|
| ABAP security audit log | `sap:abap:audit` | `abap/audit` |
| ABAP dispatcher log † | `sap:abap:dispatcher` | `abap/dispatcher` |
| ABAP enqueue server log | `sap:abap:enqueueserver` | `abap/enqueueserver` |
| ABAP event log † | `sap:abap:event` | `abap/event` |
| ABAP gateway log | `sap:abap:gateway` | `abap/gateway` |
| ABAP ICM (Internet Communication Manager) log | `sap:abap:icm` | `abap/icm` |
| ABAP message server log | `sap:abap:messageserver` | `abap/messageserver` |
| ABAP sapstartsrv log | `sap:abap:sapstartsrv` | `abap/sapstartsrv` |
| ABAP work process log † | `sap:abap:workprocess` | `abap/workprocess` |

!!! warning "† Discontinued from LogServ scope — effective April 2026"
    SAP discontinued three of the ABAP log types above from LogServ delivery **effective April 2026**:

    - **ABAP work process log** — `sap:abap:workprocess`
    - **ABAP dispatcher log** — `sap:abap:dispatcher`
    - **ABAP event log** (external events) — `sap:abap:event`

    LogServ no longer delivers new events for these sourcetypes. The LogServ App retains their parsing logic and dashboards, and any data already ingested remains fully searchable — but no new events will arrive through LogServ going forward.

    SAP also discontinued the ABAP **transport** log (`abap/transport`, `/usr/sap/trans/log`) in the same April 2026 change; LogServ never routed it to a dedicated sourcetype, so it does not appear in the tables on this page.

    **If you require continued collection of these logs, please contact SAP directly** to discuss the options available for your environment.

### SAP HANA Trace Logs (LogServ App)

The LogServ App provides search-time field extractions for HANA trace logs, including SID/instance extraction from the source path.

| Source field value | Sourcetype assigned | Filter path |
|-------------------|-------------------|-------------|
| HANA trace log | `sap:hana:tracelogs` | `hana/tracelogs` |

### SAP Cloud Connector (LogServ App)

The LogServ App provides search-time field extractions for SAP Cloud Connector audit and HTTP access logs.

| Source field value | Sourcetype assigned | Filter path |
|-------------------|-------------------|-------------|
| SCC audit log (CSV format) | `sap:scc:audit` | `scc/audit` |
| SCC HTTP access log | `sap:scc:http_access` | `scc/tracelogs` |

### SAP Service Logs (LogServ App)

The LogServ App provides search-time field extractions for SAP host-level service logs. These are infrastructure services that run at the host control level (`/usr/sap/hostctrl/`) rather than within a specific SAP instance.

| Source field value | Sourcetype assigned | Filter path |
|-------------------|-------------------|-------------|
| SAP Start Service log (auth, SSL/TLS) | `sap:sapstartsrv` | `sap/sapstartsrv` |
| SAP Host Agent execution log | `sap:saphostexec` | `sap/saphostexec` |
| SAP Router connection and trace log | `sap:saprouter` | `sap/saprouter` |

!!! tip "SAP Service Log Details"
    - **`sap:sapstartsrv`** includes fields for OS authentication failures, SSL/TLS negotiation errors (protocol version, cipher suite, peer addresses), and webmethod invocation failures.
    - **`sap:saprouter`** covers both `.log` files (CONNECT/DISCONNECT/INVAL DATA events with connection IDs and host addresses) and `.trc` files (NiBuf/NiI error traces with peer/local addresses and return codes) as a single sourcetype.

### Linux OS logs

The `lastlog`, `who`, `linux_secure`, and `linux_messages_syslog` sourcetypes are parsed by the <a href="https://splunkbase.splunk.com/app/833" target="_blank">Splunk Add-on for Unix and Linux</a> on the search tier; the `linux:cron` / `linux:warn` / `linux:sudolog` / `linux:slapd` sourcetypes are LogServ-App-owned names (deliberately distinct from that add-on's pretrained names) parsed by the LogServ App itself.

| Source field value | Sourcetype assigned | Filter path |
|----------------------------|-------------------------|-------------|
| /lastlog | lastlog | `linux/linux_secure` |
| /var/log/cron | linux:cron | `linux/cron` |
| /var/log/firewall | linux_secure | `linux/linux_secure` |
| /var/log/kernel | linux_secure | `linux/linux_secure` |
| /var/log/localmessages | linux_messages_syslog | `linux/localmessages` |
| /var/log/messages | linux_messages_syslog | `linux/messages` |
| /var/log/pacemaker/pacemaker.log | linux:slapd | `linux/slapd` |
| /var/log/slapd.log | linux:slapd | `linux/slapd` |
| /var/log/sssd/sssd* | linux_secure | `linux/linux_secure` |
| /var/log/sudolog | linux:sudolog | `linux/sudolog` |
| /var/log/warn | linux:warn | `linux/warn` |
| /who | who | `linux/linux_secure` |


### <a href="https://splunkbase.splunk.com/app/742" target="_blank">Splunk Add-on for Microsoft Windows</a>

| Source field value | Sourcetype assigned | Filter path |
|----------------------------|---------------------|-------------|
| WinEventLog:Application | XmlWinEventLog | `windows/WinEventLog:Application` |
| WinEventLog:(*.)Operational | XmlWinEventLog | `windows/WinEventLog:Powershell` |
| WinEventLog:Security | XmlWinEventLog | `windows/WinEventLog:Security` |
| WinEventLog:System | XmlWinEventLog | `windows/WinEventLog:System` |

### Squid Proxy (`squid:access`)

Parsing is absorbed natively into the LogServ App (from the archived Splunk Add-on for Squid Proxy v2.1.0 — no longer required as a separate install).

| Source field value | Sourcetype assigned | Filter path |
|-----------------------------|-------------------------|-------------|
| /var/log/squid/access.log | squid:access | `proxy/squid` |
| /var/log/squid/cache.log | squid:access | `proxy/squid` |
| /var/log/squid/store.log | squid:access | `proxy/squid` |


### ISC BIND (`isc:bind:*`)

Parsing is absorbed natively into the LogServ App (from the archived Splunk Add-on for ISC BIND v2.0.0 — no longer required as a separate install).

| Source field value | Sourcetype assigned | Filter path |
|----------------------------------------------|-------------------------|-------------|
| /var/lib/named/log/named/default.log | isc:bind:query | `dns/binddns` |
| /var/lib/named/log/named/general.log | isc:bind:network | `dns/binddns` |
| /var/lib/named/log/named/lame-servers.log | isc:bind:lameserver | `dns/binddns` |
| /var/lib/named/log/named/network.log | isc:bind:network | `dns/binddns` |
| /var/lib/named/log/named/notify.log | isc:bind:transfer | `dns/binddns` |
| /var/lib/named/log/named/queries.log | isc:bind:query | `dns/binddns` |
| /var/lib/named/log/named/resolver.log | isc:bind:network | `dns/binddns` |
| /var/lib/named/log/named/update.log | isc:bind:transfer | `dns/binddns` |
| /var/lib/named/log/named/xfer-out.log | isc:bind:transfer | `dns/binddns` |


!!! tip "Filter Path Column"
    The **Filter path** column shows the `clz_dir/clz_subdir` value used in the index-time filter include/exclude patterns. See [Configuring Filters](../install-setup/configure-filters.md) for details.

## :material-circle-box:{ .taiconcolor } Secondary Supported Log Types

The log types below are within LogServ's scope and **are ingested and fully searchable once SAP has activated them for your landscape** (Network and WAF/F5 logs are activated only on request, and WAF/F5 applies only if your RISE package includes WAF or F5), but they do not have the dedicated index-time routing and search-time field extractions that the Primary types above have. They remain under the base `sap_logserv_logs` sourcetype in raw form; detailed, per-type parsing may be added in a future release.

These data sources are drawn from Section 2 ("Data sources") of the SAP LogServ service description and are the sources not covered by a Primary parser above.

- **Network / Flow logs** — VPC/VNET network-traffic flow logs (source/destination IPs, ports, protocols, and traffic statistics). *Category-level in the source document; no dedicated `clz_dir/clz_subdir`; activated on request.*
- **WAF / F5 logs** — Web Application Firewall / F5 traffic and firewall system events (successful and failed connection attempts). *Category-level; no dedicated `clz_dir/clz_subdir`; activated on request.*
- **SAP ABAP — transport + HTTP access** — the ABAP transport log (`abap/transport` — discontinued by SAP from LogServ scope effective April 2026) and the ABAP HTTP access log (`abap/httpaccess`, newly added to LogServ scope).
- **SAP Web Dispatcher — process / ICM / sapstartsrv / dev_icm traces** — `webdispatcher/process`, `webdispatcher/icm`, `webdispatcher/sapstartsrv`, `webdispatcher/devicm`; only `webdispatcher/accesslog` has a Primary parser.
- **Additional Linux system logs** — `/var/log/zypper.log`, `/var/log/YaST2` (`linux/linux_secure`), and `/var/log/cluster/corosync.log` (`linux/pacemaker`).
- **Database — SAP ASE (Sybase)** — ASE error log, Backup Server log, and Job scheduler error log (`sybase/install`).
- **Database — Microsoft SQL Server** — MSSQL database audit logs (`MSSQLDBAudit`).
- **SAP NetWeaver Java** — deploy, JSMON, JStart, server, ICM, security, and general trace/log files (`java/*`).
- **SAP BusinessObjects (BOBJ — BI / BODS / IPS)** — BI/IPS, BODS and Jobserver, Webapp, Tomcat, and SAC Agent logs (`bobj_bi/*`, `bobj_bods/*`, `bobj_sacagent/*`).
- **DP Agent (Data Provisioning Agent)** — framework alert and trace logs (`dpagent/alert`, `dpagent/trace`).

!!! note "Out of scope"
    Per the LogServ service description, **DB2 and MaxDB database logs are not in LogServ scope**, and are therefore not listed above.
