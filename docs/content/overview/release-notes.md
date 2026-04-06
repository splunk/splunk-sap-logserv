# Release Notes


## Version 0.0.4.2-beta (latest)

### :material-circle-box:{ .taiconcolor } Compatibility

|                                  |                              |
|----------------------------------|------------------------------|
| Splunk platform versions         | 9.4.3 and later              |
| CIM                              | 5.1.1 and later              |
| Supported OS for data collection | Platform independent         |
| Vendor products                  | SAP LogServ for SAP ECS in Amazon Web Services (AWS) |

### :material-circle-box:{ .taiconcolor } New features

1. **3 new SAP service sourcetypes** — `sap:sapstartsrv` (SAP Start Service / Host Control Agent with auth and SSL/TLS negotiation fields), `sap:saphostexec` (SAP Host Agent execution logs), and `sap:saprouter` (SAP Router connection and trace logs). These cover the `sap/sapstartsrv`, `sap/saphostexec`, and `sap/saprouter` log types in the LogServ S3 bucket.
2. **28 total sourcetype routing transforms** with `@logserv_filter` annotations for index-time filter support.
3. **~176 total search-time directives** (EXTRACT, EVAL, FIELDALIAS) across all SAP-specific sourcetypes in the LogServ App.
4. **9 new dashboards** in the LogServ App, bringing the total to 14. New dashboards provide dedicated views for:
      - **ABAP Network & Security** — ICM status codes, peer connections, gateway remote hosts and errors
      - **ABAP Operations** — System uptime, dispatcher severity, work process categories, enqueue lock activity
      - **SAP Services** — SAP Router connections and errors, sapstartsrv authentication and SSL/TLS events, host agent health
      - **Cloud Connector** — HTTP request analytics, status codes, response time trends, audit log
      - **HANA Trace** — Trace severity distribution, component analysis, source file hotspots
      - **Linux System & Security** — SAP application activity, firewall drop analysis, kernel event monitoring
      - **Windows Events** — Event severity trends, security actions, service health, PowerShell activity
      - **Proxy Analytics** — Top domains, client analysis, bandwidth trends, content type distribution
      - **Environment Health** — Cross-cutting operations view with 6 KPIs, 6 category-specific error trend charts (ABAP, HANA, Security, Web/Network, Cloud Connector, OS/Infra), critical events table, host error matrix, and performance panels. Every panel drills down to the relevant detailed dashboard.
5. **KPI single values** added to DNS Analytics (Total Queries, Unique Clients, Beaconing Domains), HANA Audit (Total Events, Failed Operations, Active Users), and Web Dispatcher (Total Requests, Error Rate, Avg Response Time).
6. **Enhanced DNS Analytics** — New panels for Top Queried Domains, Top Clients by Domain Diversity (DGA detection), and Query Type Distribution.
7. **Enhanced HANA Audit** — New panels for Top Users by Activity, Activity by Hour of Day (after-hours detection), and Client IP Analysis.
8. **Enhanced Web Dispatcher** — New panels for Request Volume Over Time, Top URIs by Request Count, and Recent Errors (4xx/5xx).
9. **Host Inventory panel** on the Host Details dashboard — Displays host hardware specs (CPU, cores, RAM), EC2 instance type, operating system, region, and availability zone, sourced from osquery data in syslog.
10. **Organized navigation** — Dashboard nav bar reorganized into "SAP Analytics" (7 dashboards) and "Infrastructure" (5 dashboards, including Host Details) collections, with Overview and Environment Health as top-level entries.
11. **Cross-dashboard navigation** — All 14 dashboards include a Navigate to Dashboard dropdown with Go button that preserves the selected time range when switching between dashboards.

### :material-circle-box:{ .taiconcolor } Fixed issues

1. DNS Analytics beaconing panels now use correct `message_type="Query"` case (was `"QUERY"`).
2. Web Dispatcher data source had hardcoded Unix timestamps; replaced with `$global_time.earliest$`/`$global_time.latest$` tokens.

### :material-circle-box:{ .taiconcolor } Known issues

1. The dashboards in the LogServ App use Dashboard Studio v2 format and require Splunk 9.4.3 or later.
2. The Host Inventory panel on the Host Details dashboard requires osquery data in `linux_messages_syslog`; Windows hosts without osquery will show no inventory data.

### :material-circle-box:{ .taiconcolor } Third-party software attributions


## Version 0.0.4.1-beta

### :material-circle-box:{ .taiconcolor } Compatibility

|                                  |                              |
|----------------------------------|------------------------------|
| Splunk platform versions         | 9.4.3 and later              |
| CIM                              | 5.1.1 and later              |
| Supported OS for data collection | Platform independent         |
| Vendor products                  | SAP LogServ for SAP ECS in Amazon Web Services (AWS) |

### :material-circle-box:{ .taiconcolor } New features

1. **12 new SAP application sourcetypes** — 9 SAP ABAP types (`sap:abap:audit`, `sap:abap:dispatcher`, `sap:abap:enqueueserver`, `sap:abap:event`, `sap:abap:gateway`, `sap:abap:icm`, `sap:abap:messageserver`, `sap:abap:sapstartsrv`, `sap:abap:workprocess`), 1 HANA trace type (`sap:hana:tracelogs`), and 2 SAP Cloud Connector types (`sap:scc:audit`, `sap:scc:http_access`).
2. **Compound lookahead routing** — New routing pattern for log types where the same `clz_subdir` value appears under multiple `clz_dir` paths (e.g., `audit` exists under both `abap/` and `scc/`). Uses regex lookahead to match both fields simultaneously.
3. **Search-time SID/instance extraction** — ABAP and HANA sourcetypes extract `sap_sid` and `sap_instance` from the `source` metadata field using `EXTRACT ... in source` directives in the LogServ App.
4. **~128 total search-time directives** across all SAP-specific sourcetypes.

### :material-circle-box:{ .taiconcolor } Fixed issues

### :material-circle-box:{ .taiconcolor } Known issues

1. The dashboards in the LogServ App use Dashboard Studio v2 format and require Splunk 9.4.3 or later.

### :material-circle-box:{ .taiconcolor } Third-party software attributions


## Version 0.0.3-beta

### :material-circle-box:{ .taiconcolor } Compatibility

|                                  |                              |
|----------------------------------|------------------------------|
| Splunk platform versions         | 9.4.3 and later              |
| CIM                              | 5.1.1 and later              |
| Supported OS for data collection | Platform independent         |
| Vendor products                  | SAP LogServ for SAP ECS in Amazon Web Services (AWS) |

### :material-circle-box:{ .taiconcolor } New features

1. **Two-package architecture** — The solution is now split into two packages: the **Data TA** (`splunk_ta_sap_logserv`) for data collection and index-time processing, and the **LogServ App** (`splunk_app_sap_logserv`) for dashboards and search-time field extractions. See [Architecture](../getting-started/architecture.md) for details.
2. **Built-in index-time filtering** — Configure include/exclude patterns and time-based filters directly through the Splunk Web UI. Filtered events never consume Splunk license. See [Configuring Filters](../install-setup/configure-filters.md).
3. **AWS Lambda-based filtering** — New deployment option that filters S3 event notifications in AWS before they reach Splunk, reducing S3 GET request costs and SQS message volume. Available via the [AWS Remote S3 Filter Setup Walkthrough](../install-setup/aws-remote-s3-filter-walkthrough.md) or the [Connect to Filter Migration](../install-setup/aws-remote-s3-connect-to-filter-migration-walkthrough.md). Can be used alongside or independently of the native TA filtering.
4. **Deployment Server automation** — When installed on a Deployment Server, the TA automatically stages filter configurations for distribution to Heavy Forwarders and provides a one-click "Deploy to Forwarders" button.
5. **Upgrade notifications** — A system message banner alerts administrators when a TA upgrade adds support for new log types that are not covered by existing include filter patterns.
6. **Daily time filter refresh** — A built-in scripted input automatically refreshes the time-based filter cutoff once per day to maintain accuracy of the rolling time window.
7. **SAP HANA Audit field extractions** — 14 EXTRACT, 11 EVAL, and 16 FIELDALIAS directives for the `sap:hana:audit` sourcetype.
8. **SAP Web Dispatcher field extractions** — 18 EXTRACT, 3 EVAL, and 6 FIELDALIAS directives for the `sap:webdispatcher:access` sourcetype.

### :material-circle-box:{ .taiconcolor } Fixed issues

1. Dashboards moved from Data TA to dedicated LogServ App package for proper distributed deployment support.

### :material-circle-box:{ .taiconcolor } Known issues

1. The dashboards in the LogServ App use Dashboard Studio v2 format and require Splunk 9.4.3 or later.

### :material-circle-box:{ .taiconcolor } Third-party software attributions


## Version 0.0.2-beta

### :material-circle-box:{ .taiconcolor } Compatibility

|                                  |                              |
|----------------------------------|------------------------------|
| Splunk platform versions         | 9.4.x, 10.0.x                |
| CIM                              | 5.1.1 and later              |
| Supported OS for data collection | Platform independent         |
| Vendor products                  | SAP LogServ for SAP ECS in Amazon Web Services (AWS) |

### :material-circle-box:{ .taiconcolor } New features

### :material-circle-box:{ .taiconcolor } Fixed issues

1. Drilldown on overview dashboard to host details dashboard had the wrong application name and displayed an error when clicking on the host name.
2. Renamed the 'logserv_web_dispatcher_access.xml' dashboard to 'logserv_web_dispatcher.xml'.
3. Renamed the 'sap_rise_host_details.xml' dashboard to 'logserv_host_details.xml'.
4. Updated the '~/ui/nav/default.xml' with updated dashboard names.

### :material-circle-box:{ .taiconcolor } Known issues

1. The dashboards included in this TA are Dashboard Studio dashboards that may not work with Splunk versions prior to 9.4.

### :material-circle-box:{ .taiconcolor } Third-party software attributions


## Version 0.0.1-beta

### :material-circle-box:{ .taiconcolor } Compatibility


|                                  |                              |
|----------------------------------|------------------------------|
| Splunk platform versions         | 9.4.x, 10.0.x                |
| CIM                              | 5.1.1 and later              |
| Supported OS for data collection | Platform independent         |
| Vendor products                  | SAP LogServ for SAP ECS in Amazon Web Services (AWS) |

### :material-circle-box:{ .taiconcolor } New features

### :material-circle-box:{ .taiconcolor } Fixed issues

### :material-circle-box:{ .taiconcolor } Known issues

1. Drilldown on overview dashboard to host details dashboard has the wrong application name and displays an error when clicking on the host name.

2. The dashboards included in this TA are Dashboard Studio dashboards that may not work with Splunk versions prior to 9.4.

### :material-circle-box:{ .taiconcolor } Third-party software attributions
