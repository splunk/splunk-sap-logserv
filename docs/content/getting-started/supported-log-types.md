# Supported Log Types

### :material-circle-box:{ .taiconcolor } Overview

SAP ECS environment logs are not a singular data source but a collection of OS-specific, SAP environment, database, and other application logs.

Due to the nature of this solution, the SAP LogServ packages are not standalone integrations. To take full advantage of their capabilities (like CIM mapping), you need to install additional TAs as specified in the [Prerequisites](../install-setup/prerequisites.md).

For a streamlined data ingestion process, all selected logs are ingested under one sourcetype: `sap_logserv_logs`. They are then assigned to a final sourcetype during parsing/indexing on the Heavy Forwarder (or Indexer in single-instance mode), based on the `source` field.

All events are in NDJSON format with metadata (like _time, host, source, etc.) and the _raw field containing the event contents.
To limit index size, only the _raw field is ingested from each event -- metadata fields are either mapped to Splunk's native metadata fields or dropped.
However `clz_dir` and `clz_subdir` fields are preserved to maintain backtracking capabilities. These fields correspond to the directory tree of the original data in object storage.

The Data TA also stamps two attribution fields at index time on every event: `splunk_solution` (always `splunk_for_sap_logserv`, identifying events that flowed through this solution) and `cloud_provider` (`aws` or `azure`, identifying the cloud the data was ingested from). The `cloud_provider` value is controlled by the Data TA's **Configuration → Cloud Provider** tab; see [Configuring Filters → Cloud Provider Attribution](../install-setup/configure-filters.md#cloud-provider-attribution) for details.

!!! note "Ingest channel: AWS S3 or Azure Blob Storage"
    The sourcetype mappings below apply identically to both ingest channels — **AWS S3** (via the Splunk Add-on for AWS) and **Azure Blob Storage** (via the Splunk Add-on for Microsoft Cloud Services). The Data TA's index-time routing transforms key on the `source` field's `clz_dir/clz_subdir` segments, which the SAP LogServ collector writes the same way regardless of object-storage destination. See [Azure Setup Guide](../install-setup/azure-setup.md) for Azure-specific configuration; AWS S3 is covered under [Prerequisites](../install-setup/prerequisites.md). Events from either channel carry an indexed `cloud_provider` field (`aws` or `azure`) for cross-cloud reporting.

### :material-circle-box:{ .taiconcolor } LogServ Object Storage Path Structure

The log files in the SAP LogServ object storage location (AWS S3 bucket OR Azure Blob Storage container) follow this path pattern:

```
logserv/<clz_dir>/<clz_subdir>/<YYYY>/<MM>/<DD>/<filename>.json.gz
```

For example:

```
logserv/linux/messages/2025/09/15/messages-abc123.json.gz
logserv/hana/hanaaudit/2025/10/01/hana-xyz789.json.gz
logserv/dns/binddns/2025/11/20/dns-def456.json.gz
```

The `clz_dir/clz_subdir` values are used by the index-time filter to match include/exclude patterns. See [Configuring Filters](../install-setup/configure-filters.md) for details.

## :material-circle-box:{ .taiconcolor } Sourcetype Mapping

### SAP HANA Audit (LogServ App)

The LogServ App provides search-time field extractions for SAP HANA audit events, including 14 EXTRACT, 11 EVAL, and 16 FIELDALIAS directives.

| Source field value | Sourcetype assigned | Filter path |
|-------------------|-------------------|-------------|
| hana audit log | `sap:hana:audit` | `hana/hanaaudit` |

### SAP Web Dispatcher (LogServ App)

The LogServ App provides search-time field extractions for SAP Web Dispatcher access logs, including 18 EXTRACT, 3 EVAL, and 6 FIELDALIAS directives.

| Source field value | Sourcetype assigned | Filter path |
|-------------------|-------------------|-------------|
| web dispatcher access log | `sap:webdispatcher:access` | `webdispatcher/accesslog` |

### SAP ABAP Application Logs (LogServ App)

The LogServ App provides search-time field extractions for 9 SAP ABAP application log types. Each sourcetype includes `sap_sid` and `sap_instance` extraction from the `source` metadata field, plus type-specific field extractions.

| Source field value | Sourcetype assigned | Filter path |
|-------------------|-------------------|-------------|
| ABAP security audit log | `sap:abap:audit` | `abap/audit` |
| ABAP dispatcher log | `sap:abap:dispatcher` | `abap/dispatcher` |
| ABAP enqueue server log | `sap:abap:enqueueserver` | `abap/enqueueserver` |
| ABAP event log | `sap:abap:event` | `abap/event` |
| ABAP gateway log | `sap:abap:gateway` | `abap/gateway` |
| ABAP ICM (Internet Communication Manager) log | `sap:abap:icm` | `abap/icm` |
| ABAP message server log | `sap:abap:messageserver` | `abap/messageserver` |
| ABAP sapstartsrv log | `sap:abap:sapstartsrv` | `abap/sapstartsrv` |
| ABAP work process log | `sap:abap:workprocess` | `abap/workprocess` |

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

### <a href="https://splunkbase.splunk.com/app/833" target="_blank">Splunk Add-on for Unix and Linux</a>

| Source field value | Sourcetype assigned | Filter path |
|----------------------------|-------------------------|-------------|
| /lastlog | lastlog | `linux/linux_secure` |
| /var/log/cron | linux:cron | `linux/cron` |
| /var/log/firewall | linux_secure | `linux/linux_secure` |
| /var/log/kernel | linux_secure | `linux/linux_secure` |
| /var/log/localmessages | linux_messages_syslog | `linux/localmessages` |
| /var/log/messages | linux_messages_syslog | `linux/messages` |
| /var/log/pacemaker(.log) | linux:slapd | `linux/slapd` |
| /var/log/slapd.log | linux:slapd | `linux/slapd` |
| /var/log/sssd(.log) | linux_secure | `linux/linux_secure` |
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

Parsing absorbed natively into the LogServ App in v0.0.5.0 build 184 (from the archived <a href="https://splunkbase.splunk.com/app/2965" target="_blank">Splunk Add-on for Squid Proxy v2.1.0</a> — no longer required as a separate install).

| Source field value | Sourcetype assigned | Filter path |
|-----------------------------|-------------------------|-------------|
| /var/log/squid/access.log | squid:access | `proxy/squid` |
| /var/log/squid/cache.log | squid:access | `proxy/squid` |
| /var/log/squid/store.log | squid:access | `proxy/squid` |


### ISC BIND (`isc:bind:*`)

Parsing absorbed natively into the LogServ App in v0.0.5.0 build 184 (from the archived <a href="https://splunkbase.splunk.com/app/2876" target="_blank">Splunk Add-on for ISC BIND v2.0.0</a> — no longer required as a separate install).

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
    The **Filter path** column shows the `clz_dir/clz_subdir` value used in the index-time filter include/exclude patterns. A `--` means the log type does not currently have a filter-eligible transform. See [Configuring Filters](../install-setup/configure-filters.md) for details.
