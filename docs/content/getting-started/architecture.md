# Architecture

## :material-circle-box:{ .taiconcolor } Two-Package Model

Starting with version 0.0.3, the SAP LogServ solution for Splunk is delivered as **two separately installable packages**:

| Package | App ID | Purpose |
|---------|--------|---------|
| **Data TA** | `splunk_ta_sap_logserv` | Data collection, index-time filtering, deployment server automation, configuration UI |
| **LogServ App** | `splunk_app_sap_logserv` | Dashboards, analytics views, search-time field extractions, macros |

The **Data TA** handles everything that happens at index time: ingesting data from S3, routing events to the correct sourcetype, and applying index-time filters. It includes Python scripts, REST handlers, and a configuration UI built with Splunk's UCC framework.

The **LogServ App** handles everything that happens at search time: field extractions, field aliases, computed fields, and the dashboards you use to visualize and analyze the data. It contains no Python code and no data collection components.

!!! tip "Why two packages?"
    Splitting the solution into two packages follows Splunk best practices for distributed deployments. The Data TA runs on Heavy Forwarders where data is parsed and filtered, while the LogServ App runs on the Search Head where users interact with dashboards. This separation ensures each Splunk tier only has the components it needs.

## :material-circle-box:{ .taiconcolor } Install Matrix

Where you install each package depends on your Splunk topology:

| Topology | Data TA | LogServ App |
|----------|---------|-------------|
| **Single instance** | Same instance | Same instance |
| **DS + HFs + on-prem SH** | Deployment Server + each HF | Search Head only |
| **DS + HFs + Splunk Cloud** | Deployment Server + each HF | Splunk Cloud SH only |

!!! warning "Important"
    - The Data TA is **never** installed directly on Heavy Forwarders when using a Deployment Server -- the DS distributes it automatically.
    - The LogServ App is **never** installed on Heavy Forwarders or the Deployment Server.
    - For single-instance deployments, both packages are installed on the same instance and Splunk merges their configurations at runtime.

## :material-circle-box:{ .taiconcolor } Data Flow

The diagram below shows how SAP LogServ data flows from the SAP ECS environment into Splunk:

```
  SAP ECS Environment
        |
        v
  SAP LogServ S3 Bucket (SAP-managed)
        |
        v  (S3 event notifications via SQS)
  Customer's AWS Account
  +-----------------------------------------------+
  |  Destination S3 Bucket  -->  SQS Queue        |
  |         (S3 events trigger SQS messages)      |
  +-----------------------------------------------+
        |
        v  (Splunk AWS Add-on reads from SQS)
  Splunk Heavy Forwarders
  +-----------------------------------------------+
  |  1. Ingest NDJSON from S3 via SQS             |
  |  2. Route to sourcetype (TRANSFORMS)          |
  |  3. Apply index-time filters (nullQueue)      |
  |  4. Forward to indexer                        |
  +-----------------------------------------------+
        |
        v
  Splunk Indexer
  +-----------------------------------------------+
  |  Stores events in sap_logserv_logs index      |
  +-----------------------------------------------+
        |
        v
  Splunk Search Head
  +-----------------------------------------------+
  |  LogServ App: dashboards + field extractions  |
  +-----------------------------------------------+
```

## :material-circle-box:{ .taiconcolor } Index-Time Filtering

The Data TA provides built-in index-time filtering that lets you control which log types are indexed. Filtering happens on the Heavy Forwarders using TRANSFORMS-based queue routing:

- **Include patterns** -- Only ingest log types that match the pattern (e.g., `linux/*` to include only Linux logs)
- **Exclude patterns** -- Drop specific log types (e.g., `linux/cron` to exclude cron logs)
- **Days in past** -- Drop data older than a specified number of days based on the S3 object path date

Filtered events are routed to `nullQueue` and never consume Splunk license. Filter settings are configured on the Deployment Server and pushed to Heavy Forwarders automatically.

See [Configuring Filters](../install-setup/configure-filters.md) for detailed setup instructions.

## :material-circle-box:{ .taiconcolor } Sourcetype Routing

All SAP LogServ data arrives in a single generic format. The Data TA examines each event's metadata during index-time parsing and routes it to the appropriate Splunk sourcetype. Routing is defined in `transforms.conf` using regex-based sourcetype assignment.

Two routing strategies are used:

- **Source-path matching** -- For log types with unique `source` field values (e.g., `/var/log/messages` for Linux syslog, `/var/log/squid/access.log` for Squid proxy)
- **Classification field matching** -- For SAP application logs that share similar source paths, routing matches the `clz_dir` and `clz_subdir` fields in the NDJSON envelope. When the same `clz_subdir` value appears under multiple `clz_dir` paths (e.g., `audit` exists under both `abap/` and `scc/`), compound lookahead regexes match both fields simultaneously to avoid collisions.

For the complete list of supported log types and their sourcetype mappings, see [Supported Log Types](supported-log-types.md).
