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
4. **15 new dashboards** in the LogServ App, bringing the total to **20**. Dashboards are organized into 4 purpose-driven navigation groups plus a top-level Environment Health landing page (reorganized from the previous 3-group structure so that the top menu is balanced and each group answers a specific class of question):
      - **Top-level** — Environment Health (default landing)
      - **Applications (5 dashboards)** — the SAP app runtime itself: ABAP Network & Security, ABAP Operations, **Work Process Performance** (new), HANA Audit, HANA Trace
      - **Integration (5 dashboards)** — how SAP talks to other systems: SAP Services, **SAP Router** (new), Cloud Connector, Web Dispatcher, **Web and API Performance** (new)
      - **Security (3 dashboards)** — cross-source synthesis for security posture and compliance: **Network Perimeter** (new), **Cross-Stack Authentication** (new), **Change & Configuration Activity** (new)
      - **Platform (6 dashboards)** — infrastructure, ingest, and forensics: Data Pipeline Overview, DNS Analytics, Linux System & Security, Windows Events, Proxy Analytics, Host Details
5. **6 new dashboards from Phase 2** (added after the original 14):
      - **Cross-Stack Authentication** — unified authentication failure analysis across SAP, HANA, and Windows layers, with per-layer KPIs, source-IP aggregation, and per-layer recent-failure tables
      - **SAP Router** — SAP Router connection activity, error analysis, and network boundary monitoring (separated out of SAP Services to give router its own investigation surface)
      - **Work Process Performance** — SAP ABAP work process utilization with all 13 SAP-standard dev_w* trace category codes, dispatcher health, and function-level activity
      - **Web and API Performance** — Web Dispatcher four-stage request timing (`dt1`-`dt4`), response-time percentiles, TLS version and cipher-suite distributions, and a cross-source panel overlaying HTTP error rate against Cloud Connector auth failure rate
      - **Network Perimeter** — unified network-boundary view synthesizing firewall drops, proxy outbound traffic, and DNS resolution into one dashboard; includes firewall-drops-by-protocol, top outbound domains with byte volumes, and a cross-source Suspicious Activity Indicator table ranking internal hosts by combined beaconing-DNS + denied-proxy signal score
      - **Change & Configuration Activity** — compliance-focused audit trail unifying HANA user/role/privilege/DDL changes, Windows account and group modifications (15 canonical security EventCodes), and Linux sudo + useradd/usermod/userdel/passwd activity; includes source-prefixed operator identities, a category taxonomy, and two compliance-focused "Recent" tables (Privileged Changes + After-Hours Changes)
6. **Environment Health dashboard** — Cross-cutting operations view with 6 KPIs, 6 category-specific error trend charts (ABAP, HANA, Security, Web/Network, Cloud Connector, OS/Infra), critical events table, host error matrix, and performance panels. Every panel drills down to the relevant detailed dashboard. Now set as the default landing page.
7. **Tabbed Data Pipeline Overview** — Two tabs: "Overview" (5 KPIs + 14-column Sourcetype Summary table + Host Latest Activity) and "Linked Graph" (full-width source-to-sourcetype link graph). The Sourcetype Summary table includes Status (Fresh/Stale/Very Stale), Trend sparkline, % of Total, Avg/Day, Volume, App Errors, Hosts, Sources, Events (1h), First Seen, Last Seen, and Lag columns.
8. **HANA Audit security panels** — Three new panels surface the rich `sap:hana:audit` field set: Risk-Tiered Event Timeline (stacked column by `risk_level`), After-Hours / Weekend Admin Activity (table filtered to admin users outside business hours), and High-Risk Events (table of `is_critical=true` events with SQL Statement column).
9. **KPI sparklines** — ~70 KPIs across 19 dashboards (all except Host Details) display an inline daily-trend sparkline below the headline number, using a single-source `timechart + eventstats` pattern. Five flavors: count-based, distinct-count, rate, formatted-volume, and per-day re-detection. One acknowledged exception: the Linux "Top Drop Source" KPI is a string value (`<IP> (<count>)`) with no sparkline.
10. **Click-through drilldowns** — Most KPIs, table rows, and chart points open a filtered Splunk search. Clickable table cells carry a cyan accent so the drilldown affordance is visible.
11. **KPI single values** added to DNS Analytics (Total Queries, Unique Clients, Beaconing Domains), HANA Audit (Total Events, Failed Operations, Active Users), and Web Dispatcher (Total Requests, Error Rate, Avg Response Time). Access Denied Events KPI added to Cloud Connector; Top Drop Source KPI added to Linux.
12. **Enhanced DNS Analytics** — Top Queried Domains, Top Clients by Domain Diversity (DGA detection), Query Type Distribution, and Top DNS Resolvers table.
13. **Enhanced HANA Audit** — Top Users by Activity, Activity by Hour of Day (after-hours detection), and Client IP Analysis.
14. **Enhanced Web Dispatcher** — Request Volume Over Time, Top URIs by Request Count, and Recent Errors (4xx/5xx).
15. **Host Inventory panel** on the Host Details dashboard — Displays host hardware specs (CPU, cores, RAM), EC2 instance type, operating system, region, and availability zone, sourced from osquery data in syslog.
16. **Cross-dashboard navigation** — Every dashboard includes a Navigate to Dashboard dropdown with Go button that preserves the selected time range when switching between dashboards.

### :material-circle-box:{ .taiconcolor } Enhancements (per-dashboard restructures)

1. **SAP Services** — Removed the 4 router-related panels (now on the SAP Router dashboard); featured SSL Authentication Failure Sources full-width; replaced Event Volume by Service line chart with a stacked column chart showing Normal vs Errors per service.
2. **Windows Events** — Removed Security Event Actions chart and Top Users table (now on Cross-Stack Authentication); featured Top Event Codes full-width with 7 enriched columns (Event Code, Description, Source log, Severity, Events, Hosts, Last Seen).
3. **Proxy Analytics** — Replaced single-slice donuts (Content Types → Cache Action Distribution column; HTTP Methods → Top Clients by Domain Diversity bar). Added new bottom row: Top URL Domains by Bytes Out + Bandwidth Over Time by Domain.
4. **DNS Analytics** — Replaced the uninterpretable Volume & Packet Size scatter plot with a Top DNS Resolvers table; restructured row 2 to 4 panels including Query Type Distribution donut moved up to pair with the trend chart.
5. **ABAP Operations** — Work Process Categories donut widened to 836 px with bottom legend showing all 13 friendly category names (uses the shared `wp_category_name` props.conf EVAL).
6. **Cloud Connector** — Renamed "Error Rate" → "HTTP Error Rate" to clarify scope; added Access Denied Events KPI (4th KPI in row).
7. **Linux System & Security** — Added Top Drop Source KPI surfacing the highest single-source firewall drop count in `<IP> (<count>)` format (4th KPI in row).

### :material-circle-box:{ .taiconcolor } Fixed issues

1. DNS Analytics beaconing panels now use correct `message_type="Query"` case (was `"QUERY"`).
2. Web Dispatcher data source had hardcoded Unix timestamps; replaced with `$global_time.earliest$`/`$global_time.latest$` tokens.
3. **Work Process Categories labels** — The Work Process Categories panel on the ABAP Operations dashboard now displays meaningful names for all 13 standard SAP dev_w* trace component codes (A = ABAP Processor, B = Database Interface, C = Communication, D = Dispatcher, M = Memory Management, N = Network (NI), O = Enqueue / Lock, Q = RFC Queue, R = Roll Area, S = SQL / Statistics, T = Task Handler, X = RFC / CPIC, Y = Dynpro / Screen). Previously only A/B/C/M were mapped and the rest appeared as single-letter codes. The same `wp_category_name` mapping is now also used on the Work Process Performance dashboard.
4. **KPI panel alignment** — KPI single-value widgets on all three-KPI dashboards are evenly spaced with the rightmost KPI outline aligned to the right edge of panels below.
5. **Right-edge symmetry** — All rows on width=1920 dashboards now cap at R=1910; width=1600 dashboards cap at R=1590. Symmetric 10 px padding on both sides.
6. **HANA Trace component noise filter** — Top Components, Component by Severity, and Source File Hotspots panels now filter out parsing artifacts ("INFO", "of", "service:") that previously diluted real component data.
7. **Ingest Errors KPI on Data Pipeline Overview** — Refined to exclude ExecProcessor noise (which wraps all scheduled-script output as ERROR-level regardless of the script's actual log level). Filters to real Python ERRORs only.
8. **SSL Authentication Failure Sources panel (SAP Services)** — Replaced the previous Sapstartsrv SSL/TLS Events panel which showed empty columns due to mismatched field extractions. Now aggregates by source IP using fields that actually exist in the data (auth_user, remote_ip, remote_port) and provides row drilldown to the full event set per IP.
9. **Empty-safe KPI pattern** — All count-based and dc-based KPIs now display `0` instead of `###` when the underlying search returns no events (uses a synthetic-row appendpipe wrap).

### :material-circle-box:{ .taiconcolor } Restyled (visual conventions)

1. **Dashboard "card" style** — All 20 dashboards use a unified visual treatment: `#0d1117` page background, `#141b2d` panel fill, `#0877a6` panel outline, rounded corners, 5 px inset between rect frame and inner viz.
2. **KPI typography standardized** — `majorFontSize: 36`, explicit `labelColor: #7b8ea8`, `labelFontSize: 13`, semantic `majorColor` (`#dc4e41` red for errors, white for neutral counts, orange for warnings, teal for positive signals). The Linux Top Drop Source KPI uses `majorFontSize: 28` as an acknowledged exception for its long-text string display.
3. **Standard red consolidated** — All red color variants (`#e86c5d`, `#af575a`, `#ff3b30`, `#ff2d55`) normalized to single hex `#dc4e41`.
4. **Tables** — Hardcoded header background (`#1e2a3d`), zebra-stripe alternating rows (`#0d1520` / `transparent`), fixed header. Cyan accent on clickable cells indicates drilldown affordance.
5. **12 px panel gaps** — Exact horizontal and vertical spacing between every panel border across all dashboards.
6. **Dashboard descriptions** — Every dashboard now displays a 1-line description below its title.
7. **"Go >" navigation button** — Standardized: 120×25 px at top-left of every dashboard with 10 px padding above and below; majorFontSize 16.

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
