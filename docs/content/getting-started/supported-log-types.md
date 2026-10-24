# Supported Log Types

### :material-circle-box:{ .taiconcolor } Overview

SAP ECS environment logs are not a singular data source but a collection of OS-specific, SAP environment, database, and other application logs.

Due to the nature of this solution, the SAP LogServ packages are not standalone integrations. To take full advantage of their capabilities (like CIM mapping), install the search-tier add-ons listed in [LogServ App Prerequisites](../logserv-app/prerequisites.md).

For a streamlined data ingestion process, all selected logs are ingested under one sourcetype: `sap_logserv_logs`. The Data TA then assigns each event its final sourcetype during index-time parsing on the heavy forwarder (or the single instance). SAP application logs (HANA audit and trace, ABAP, Cloud Connector, SAP host services) are routed by their `clz_dir` / `clz_subdir` folder fields. Linux, ISC BIND (DNS), Squid (proxy), Windows and SAP Web Dispatcher access logs are routed by their `source` path, and so are HANA trace files delivered without folder fields. When both kinds of route match, the later one wins: `/var/log/messages` lines in the `sap/saprouter` folder become `sap:saprouter`.

All events are in NDJSON format with metadata (like _time, host, source, etc.) and the _raw field containing the event contents.
To limit index size, only the _raw field is ingested from each event -- metadata fields are either mapped to Splunk's native metadata fields or dropped.
However `clz_dir` and `clz_subdir` fields are preserved to maintain backtracking capabilities. These fields correspond to the directory tree of the original data in object storage.

The Data TA also stamps `splunk_solution` (always `splunk_for_sap_logserv`, identifying events that flowed through this solution) at index time on every routed event. Events can also carry an indexed `cloud_provider` field (`aws`, `azure`, or `gcp`, identifying the cloud the data was ingested from). The Azure and GCP ingest add-ons set it on every input. For AWS, add `_meta = cloud_provider::aws` to each SQS-Based S3 input (the inputs the AWS S3 Direct screen creates get it automatically). The Data TA's **Configuration → Cloud Provider** dropdown ships as **Not set**; see [Choose Cloud Attribution](../install-setup/cloud-attribution.md) for when to change it.

!!! note "Ingest channel: AWS S3, Azure Blob Storage, or Google Cloud Storage"
    The sourcetype mappings below apply identically to all three ingest channels — **AWS S3** (via the Splunk Add-on for AWS), **Azure Blob Storage** (via the LogServ Azure add-on), and **Google Cloud Storage** (via the LogServ GCP add-on). The Data TA's index-time routing transforms key on the `clz_dir` / `clz_subdir` fields carried inside each NDJSON event (and, for the Linux, DNS, proxy, Windows and Web Dispatcher access types and for HANA trace files delivered without folder fields, on the event's `source` path), which the SAP LogServ collector writes the same way regardless of object-storage destination. AWS S3 setup is covered in [Choose Your Cloud and AWS Scenario](../install-setup/choose-your-cloud.md) and its AWS guides; see the [Azure Setup Guide](../install-setup/azure-setup.md) and the [GCP Setup Guide](../install-setup/gcp-setup.md) for the other clouds. Azure- and GCP-ingested events carry an indexed `cloud_provider` field automatically (stamped per input by their add-on); AWS-ingested events carry it once `_meta = cloud_provider::aws` is on each AWS S3 input — see [Choose Cloud Attribution](../install-setup/cloud-attribution.md).

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

The `clz_dir/clz_subdir` values are used by the index-time filter to match include/exclude patterns. The filter's **Include Sources** and **Exclude Sources** fields match the event's `source` value instead — the log file's path, such as `/var/log/zypper.log` — which is how log files that share a folder are told apart. See [Configuring Filters](../install-setup/configure-filters.md) for details. Some Azure data sits in a folder named `undefined/undefined` and its events carry no folder fields; see [Data Delivered Without Folder Fields](#data-delivered-without-folder-fields).

## :material-circle-box:{ .taiconcolor } Primary Supported Log Types

These log types have **dedicated parsing logic** — index-time routing to a specific final sourcetype, plus search-time field extractions — to provide the most accurate parsing. The tables below show the sourcetype mapping for each.

### SAP HANA Audit (LogServ App)

The LogServ App provides rich search-time field extractions for SAP HANA audit events — the full audit-record field set (service, host, SID, user, action, status, SQL statement, and the derived risk/criticality fields) plus CIM field aliases.

| Source field value | Sourcetype assigned | Filter path |
|-------------------|-------------------|-------------|
| hana audit log | `sap:hana:audit` | `hana/hanaaudit` |

### SAP Web Dispatcher (LogServ App)

The LogServ App provides search-time field extractions for SAP Web Dispatcher access logs — client/method/status/URI, four-stage timing, TLS posture, and derived response-time / error fields, plus CIM field aliases. Like the ABAP sourcetypes, it also extracts `sap_sid` and `sap_instance` from the `source` metadata field (`/usr/sap/<SID>/<instance>/...`): a path with no `/usr/sap/<SID>/` directory (three upper-case letters or digits) gets no `sap_sid`, and one with no instance directory (upper-case letters followed by digits, such as `W00`) right below `/usr/sap/<dir>/` gets no `sap_instance`.

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

The ICM log (`dev_icm`) gives the request type, session ID, SAP client (`sap_client`), user and terminal of each session-list entry, the direction, addresses and protocol of each connection, and the class of the ICM's own messages (`icm_severity`: ERROR or WARNING). It records no HTTP status code. The Data TA gives this sourcetype to the `abap/icm` folder only. Data TA builds up to 1791935359 (2026-10-13) gave it to every LogServ folder named `icm`, so a Web Dispatcher's own ICM log (`webdispatcher/icm`) indexed by them is `sap:abap:icm`, with the Web Dispatcher's `sap_sid` and `sap_instance`; from build 1792189743 (2026-10-16) it keeps `sap_logserv_logs`, like the Web Dispatcher's other secondary folders.

!!! warning "† Discontinued from LogServ scope — effective April 2026"
    SAP discontinued three of the ABAP log types above from LogServ delivery **effective April 2026**:

    - **ABAP work process log** — `sap:abap:workprocess`
    - **ABAP dispatcher log** — `sap:abap:dispatcher`
    - **ABAP event log** (external events) — `sap:abap:event`

    LogServ no longer delivers new events for these sourcetypes. The LogServ App retains their parsing logic and dashboards, and any data already ingested remains fully searchable — but no new events will arrive through LogServ going forward.

    SAP also discontinued the ABAP **transport** log (`abap/transport`, `/usr/sap/trans/log`) in the same April 2026 change; LogServ never routed it to a dedicated sourcetype, so it does not appear in the tables on this page.

    **If you require continued collection of these logs, please contact SAP directly** to discuss the options available for your environment.

### SAP HANA Trace Logs (LogServ App) { #sap-hana-trace-logs-logserv-app }

The LogServ App provides search-time field extractions for HANA trace logs, including SID/instance extraction from the source path.

| Source field value | Sourcetype assigned | Filter path |
|-------------------|-------------------|-------------|
| HANA trace log | `sap:hana:tracelogs` | `hana/tracelogs` |
| HANA trace log delivered without folder fields: a `.trc` file or `backup.log` in `/usr/sap/<SID>/HDB<nn>/<host>/trace/` or its `DB_<tenant>/` subfolder | `sap:hana:tracelogs` | none — Include Sources or Exclude Sources `/usr/sap/*/HDB??/*/trace/*` |

Real Azure deliveries can send the HANA trace directory without `clz_dir` and `clz_subdir` (see [Data Delivered Without Folder Fields](#data-delivered-without-folder-fields)); on the reference system all of the real HANA trace data arrived that way. The Data TA routes these events by their `source` path instead, and only when the event has no folder fields; an event that has them is routed by its folder as before. Other files in the trace directory, such as `backint.log` or compressed `.trc.gz` files, and files in deeper subfolders keep the base `sap_logserv_logs` sourcetype, and so do HANA trace events indexed by an earlier Data TA build. Routing does not add folder fields, so a folder pattern such as `hana/tracelogs` never matches these files: in Include Filters it does not keep them (an allow-list drops them), and in Exclude Filters it does not drop them. Use the `source` pattern in the table.

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
    - On GCP the router's records can also arrive as `/var/log/messages` lines in the `sap/saprouter` folder. These lines get `sap:saprouter` too. On the reference system at least 70% of them, in the one hour measured, were the router's own connection and trace records, and the rest the router container's wrapper output and other text; every line had the same tagged syslog form, and the newest lines carry the router container's tag. They are router data, so do not drop them with an entry such as `sap/saprouter=/var/log/messages`.

### Linux OS logs

The LogServ App parses `linux:cron`, `linux:warn`, `linux:sudolog`, `linux:slapd`, `lastlog`, `who` and `linux_messages_syslog` itself; the first four are LogServ-App-owned names, deliberately distinct from the pretrained names of the <a href="https://splunkbase.splunk.com/app/833" target="_blank">Splunk Add-on for Unix and Linux</a>. The App ships no extraction for `linux_secure`: its firewall and kernel panels parse those events inline, and their CIM fields come from the Splunk Add-on for Unix and Linux on the search tier.

| Source field value | Sourcetype assigned | Filter path |
|----------------------------|-------------------------|-------------|
| /lastlog | lastlog | `linux/linux_secure` |
| /var/log/cron | linux:cron | `linux/cron` |
| /var/log/firewall | linux_secure | `linux/linux_secure` |
| /var/log/kernel | linux_secure | `linux/linux_secure` |
| /var/log/localmessages | linux_messages_syslog | `linux/localmessages` |
| /var/log/messages | linux_messages_syslog | `linux/messages`, `linux/proxy` |
| /var/log/pacemaker/pacemaker.log | linux:slapd | `linux/pacemaker`, `linux/slapd` |
| /var/log/slapd.log | linux:slapd | `linux/slapd` |
| /var/log/sssd/sssd* | linux_secure | `linux/linux_secure` |
| /var/log/sudolog | linux:sudolog | `linux/sudolog` |
| /var/log/warn | linux:warn | `linux/warn` |
| /who | who | `linux/linux_secure` |

On `/var/log/pacemaker/pacemaker.log` lines the App extracts `resource_agent` and `cluster_resource` from resource-agent lines and `pacemaker_daemon` and `pacemaker_function` from daemon lines. `slapd.log` lines name no user.


### <a href="https://splunkbase.splunk.com/app/742" target="_blank">Splunk Add-on for Microsoft Windows</a>

| Source field value | Sourcetype assigned | Filter path |
|----------------------------|---------------------|-------------|
| WinEventLog:Application | XmlWinEventLog | `windows/WinEventLog:Application` |
| WinEventLog:(*.)Operational | XmlWinEventLog | `windows/WinEventLog:Powershell` |
| WinEventLog:Security | XmlWinEventLog | `windows/WinEventLog:Security` |
| WinEventLog:System | XmlWinEventLog | `windows/WinEventLog:System` |

The LogServ App ships no `XmlWinEventLog` extraction: fields such as `EventCode`, `severity` and `signature` come from the Splunk Add-on for Microsoft Windows (742) on the search head.

### Squid Proxy (`squid:access`, `squid:cache`, `squid:store`) { #squid-proxy-squidaccess }

Parsing of Squid's native format is absorbed into the LogServ App (from the archived Splunk Add-on for Squid Proxy v2.1.0 — no longer required as a separate install), and the App parses the `logformat=splunk_recommended_squid` key=value format SAP LogServ proxy logs use with its own transforms. Each file has its own sourcetype: `access.log` holds the requests, `cache.log` the daemon's own messages and `store.log` the object-store journal. Data indexed by an earlier Data TA carries all three as `squid:access`, so the dashboards count only `access.log` lines as requests.

| Source field value | Sourcetype assigned | Filter path |
|-----------------------------|-------------------------|-------------|
| /var/log/squid/access.log | squid:access | `proxy/squid`, `linux/proxy` |
| /var/log/squid/cache.log | squid:cache | `proxy/squid`, `linux/proxy` |
| /var/log/squid/store.log | squid:store | `proxy/squid`, `linux/proxy` |

Real LogServ deliveries do not all use one folder layout. The AWS bucket files Squid under `proxy/squid`; Azure delivers it under `linux/proxy`; GCP delivers `pacemaker.log` under `linux/pacemaker` and a proxy VM's `/var/log/messages` under `linux/proxy`. The Filter path columns list every path seen, and the Data TA declares all of them, so a filter rule meant to cover a log type on every cloud names each of its paths — `proxy/squid, linux/proxy` for Squid. To exclude Squid, keep in mind that `linux/proxy` also carries a proxy VM's `/var/log/messages`: Exclude Filters `proxy/squid` with Exclude Sources `linux/proxy=/var/log/squid/*` drops the Squid files of both layouts and keeps those lines.


### ISC BIND (`isc:bind:*`) { #isc-bind-iscbind }

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

!!! tip "Source Field Value Column"
    In the Linux, Windows, Squid and ISC BIND tables the **Source field value** column shows the `source` values that the filter's **Include Sources** and **Exclude Sources** fields match; the SAP tables describe the log instead. Some rows are shorthand rather than literal values: `/var/log/sssd/sssd*` stands for every sssd file, rotated copies such as `/var/log/sssd/sssd.log-20260913` included, and `WinEventLog:(*.)Operational` for the Operational channels. Real deliveries on the reference system carry `lastlog` and `who` without the leading `/` that the table shows (the routing accepts both forms). A source pattern must match the whole value and is case-sensitive, so list the values your own deliveries carry before writing one — see [Source Pattern Syntax](../install-setup/configure-filters.md#source-pattern-syntax).

## :material-circle-box:{ .taiconcolor } Secondary Supported Log Types { #secondary-supported-log-types }

The log types below are within LogServ's scope and **are ingested and fully searchable once SAP has activated them for your landscape** (Network and WAF/F5 logs are activated only on request, and WAF/F5 applies only if your RISE package includes WAF or F5), but they do not have the dedicated index-time routing and search-time field extractions that the Primary types above have. They remain under the base `sap_logserv_logs` sourcetype in raw form; detailed, per-type parsing may be added in a future release.

These data sources are drawn from Section 2 ("Data sources") of the SAP LogServ service description and are the sources not covered by a Primary parser above. Each entry ends with how to keep it out of the index with the Data TA's filters (**Configuration → Filters**, Enable Filtering checked; see [Configuring Filters](../install-setup/configure-filters.md#filter-recipes) for complete recipes).

- **Network / Flow logs** — VPC/VNET network-traffic flow logs (source/destination IPs, ports, protocols, and traffic statistics). *Category-level in the source document; no dedicated `clz_dir/clz_subdir`; activated on request.* **Filter:** the folder is not known, so only an Include Filters allow-list drops it; once you know its folder or `source` values, name them in Exclude Filters or Exclude Sources.
- **WAF / F5 logs** — Web Application Firewall / F5 traffic and firewall system events (successful and failed connection attempts). *Category-level; no dedicated `clz_dir/clz_subdir`; activated on request.* **Filter:** as for Network / Flow — an Include Filters allow-list, or an exclude once the folder or `source` is known.
- **SAP ABAP — transport + HTTP access** — the ABAP transport log (`abap/transport` — discontinued by SAP from LogServ scope effective April 2026) and the ABAP HTTP access log (`abap/httpaccess`, newly added to LogServ scope). **Filter:** Exclude Filters `abap/transport, abap/httpaccess`; an allow-list must name the Primary ABAP folders one by one, since `abap/*` keeps both.
- **SAP Web Dispatcher — process / sapstartsrv / dev_icm traces** — `webdispatcher/process`, `webdispatcher/sapstartsrv`, `webdispatcher/devicm`; only `webdispatcher/accesslog` has a Primary parser. The Web Dispatcher's ICM log (`webdispatcher/icm`) is raw as well; Data TA builds up to 1791935359 (2026-10-13) typed it `sap:abap:icm` (see the ICM paragraph above). **Filter:** Exclude Filters `webdispatcher/process, webdispatcher/icm, webdispatcher/sapstartsrv, webdispatcher/devicm`, or `webdispatcher/accesslog` (not `webdispatcher/*`) in an allow-list.
- **Additional Linux system logs** — `/var/log/zypper.log`, `/var/log/YaST2` (`linux/linux_secure`), and `/var/log/cluster/corosync.log` (`linux/pacemaker`). **Filter:** these share their folders with Primary log types — `linux/linux_secure` also holds the firewall, kernel, sssd, `lastlog` and `who` logs, and `linux/pacemaker` the Pacemaker cluster log — so a folder pattern cannot drop them without dropping those too. Drop them by `source` with Exclude Sources: `/var/log/zypper.log*, /var/log/YaST2/*` for zypper and YaST2 (real deliveries carry `/var/log/zypper.log`, `/var/log/YaST2/mkinitrd.log` and `/var/log/YaST2/config_diff_<date>.log`), and `/var/log/cluster/corosync.log*` for corosync. `corosync.log` has not been observed in real data on the reference system; the path is the one the service description names, so confirm the `source` value your deliveries carry before relying on the pattern. See [Recipe 3](../install-setup/configure-filters.md#recipe-3).
- **Database — SAP ASE (Sybase)** — ASE error log, Backup Server log, and Job scheduler error log (`sybase/install`). **Filter:** Exclude Filters `sybase/*`.
- **Database — Microsoft SQL Server** — MSSQL database audit logs (`MSSQLDBAudit`). **Filter:** no folder is known, so only an Include Filters allow-list drops them; once you know their folder or `source` values, exclude those.
- **SAP NetWeaver Java** — deploy, JSMON, JStart, server, ICM, security, and general trace/log files (`java/*`). **Filter:** Exclude Filters `java/*`.
- **SAP BusinessObjects (BOBJ — BI / BODS / IPS)** — BI/IPS, BODS and Jobserver, Webapp, Tomcat, and SAC Agent logs (`bobj_bi/*`, `bobj_bods/*`, `bobj_sacagent/*`). **Filter:** Exclude Filters `bobj_bi/*, bobj_bods/*, bobj_sacagent/*`.
- **DP Agent (Data Provisioning Agent)** — framework alert and trace logs (`dpagent/alert`, `dpagent/trace`). **Filter:** Exclude Filters `dpagent/*`.

!!! note "Check the folders and files your own deliveries use"
    The folder names above come from the service description; none of these Secondary folders has appeared in the reference system's real deliveries, while the zypper and YaST2 files have. Before relying on a rule, list what your deliveries carry under the base sourcetype:

    ```spl
    | tstats count where `sap_logserv_idx_macro` sourcetype=sap_logserv_logs by clz_dir, clz_subdir, source
    ```

    Some events carry no folder fields at all and do not appear in that list — see [Data Delivered Without Folder Fields](#data-delivered-without-folder-fields) below. An Include Filters allow-list drops them unless **Include Sources** keeps them.

!!! note "Out of scope"
    Per the LogServ service description, **DB2 and MaxDB database logs are not in LogServ scope**, and are therefore not listed above.

### Data Delivered Without Folder Fields { #data-delivered-without-folder-fields }

SAP files some Azure data in a storage folder named `undefined/undefined` (`<prefix>/undefined/undefined/<YYYY>/<MM>/<DD>/`), and its events carry no `clz_dir` or `clz_subdir`. In about four weeks of real Azure deliveries on the reference system it was about 19.9 million events of two kinds, each from a single host:

- **Unix command output** — about 19.4 million events, with `source` values `ps`, `netstat`, `iostat`, `cpu`, `nfsiostat`, `top`, `openPorts`, `interfaces`, `df`, `bandwidth`, `vmstat` and `Unix:ListeningPorts`; `ps` alone is about 80%. Together that is about 0.7 million events and roughly 125 MB of text a day. This output is not among the data sources the LogServ service description lists. They stay under the base `sap_logserv_logs` sourcetype and are not parsed: each event holds one table row, a header line on its own, or a table whose line breaks are written as the two characters `\n`.
- **HANA trace files** — about 566,000 events, the `.trc` files and `backup.log` of `/usr/sap/<SID>/HDB<nn>/<host>/trace/`. The Data TA routes them to `sap:hana:tracelogs` by their `source` path (see [SAP HANA Trace Logs](#sap-hana-trace-logs-logserv-app)).

Folder patterns cannot reach either kind: an Include Filters allow-list drops them all, `hana/tracelogs` in Include Filters does not keep the trace files, and no Exclude Filters entry drops them. Use **Include Sources** and **Exclude Sources**, which match the `source` value.

!!! warning "Drop the Unix command output unless you need it"
    If you do not use this output, drop it with Exclude Sources `ps, top, netstat, iostat, vmstat, df, cpu, interfaces, bandwidth, openPorts, nfsiostat, Unix:ListeningPorts`. If you keep it, review who can search it: a `ps` row can carry the arguments a process was started with — up to 34% of the real `ps` rows checked on the reference system did — and process arguments can contain passwords, keys or tokens. See [Configuring Filters → Events Without Folder Fields](../install-setup/configure-filters.md#events-without-folder-fields).
