# Dashboards Overview

## :material-circle-box:{ .taiconcolor } Available Dashboards

The LogServ App includes fourteen Dashboard Studio dashboards organized into three navigation groups. All dashboards use **Dashboard Studio v2** format with dark theme and require Splunk 9.4.3 or later.

### SAP Analytics

| Dashboard | Purpose | Key Data Sources |
|-----------|---------|-----------------|
| [ABAP Network & Security](#abap-network-security) | ICM traffic analysis, gateway monitoring, and ABAP audit events | `sap:abap:icm`, `sap:abap:gateway`, `sap:abap:audit` |
| [ABAP Operations](#abap-operations) | ABAP runtime health, dispatcher status, work process activity, and system uptime | `sap:abap:dispatcher`, `sap:abap:enqueueserver`, `sap:abap:event`, `sap:abap:messageserver`, `sap:abap:sapstartsrv`, `sap:abap:workprocess` |
| [HANA Audit](#hana-audit) | SAP HANA database audit events, security monitoring, and user activity | `sap:hana:audit` |
| [HANA Trace](#hana-trace) | SAP HANA database trace logs, component health, and error analysis | `sap:hana:tracelogs` |
| [SAP Services](#sap-services) | SAP Router connections, sapstartsrv authentication, and host agent health | `sap:sapstartsrv`, `sap:saphostexec`, `sap:saprouter` |
| [Cloud Connector](#cloud-connector) | SAP Cloud Connector HTTP traffic and audit events | `sap:scc:audit`, `sap:scc:http_access` |
| [Web Dispatcher](#web-dispatcher) | HTTP traffic analysis, response times, status codes, and client patterns | `sap:webdispatcher:access` |

### Infrastructure

| Dashboard | Purpose | Key Data Sources |
|-----------|---------|-----------------|
| [DNS Analytics](#dns-analytics) | DNS query analysis, beaconing detection, and client activity | `isc:bind:query`, `isc:bind:network`, `isc:bind:transfer` |
| [Linux System & Security](#linux-system-security) | Linux OS events, SAP application activity, and firewall monitoring | `linux_messages_syslog`, `syslog`, `linux_secure` |
| [Windows Events](#windows-events) | Windows Event Log analysis, security actions, and service health | `XmlWinEventLog` |
| [Proxy Analytics](#proxy-analytics) | Squid proxy traffic, domain analysis, and bandwidth monitoring | `squid:access` |
| [Host Details](#host-details) | Per-host drill-down showing event volume and sourcetype breakdown | All sourcetypes (filtered by host) |

### Pipeline & Health

| Dashboard | Purpose | Key Data Sources |
|-----------|---------|-----------------|
| [Data Pipeline Overview](#data-pipeline-overview) | High-level view of all ingested data, host activity, and sourcetype distribution | All sourcetypes |
| [Environment Health](#environment-health) | Cross-cutting operations view of errors, security failures, and performance across the entire SAP landscape | All sourcetypes |

!!! tip "Searching LogServ data"
    All dashboards use the `sap_logserv_idx_macro` macro to query the LogServ index. You can use this same macro in your own searches: `` `sap_logserv_idx_macro` | stats count by sourcetype ``

!!! tip "Cross-dashboard navigation"
    Every dashboard includes a **Navigate to Dashboard** dropdown and **Go** button that preserves your selected time range when switching between dashboards.

---

## Data Pipeline Overview

### :material-circle-box:{ .taiconcolor } Why This Dashboard Matters

The Data Pipeline Overview is your single pane of glass for the entire SAP LogServ ingestion pipeline. It answers the most fundamental question: is data flowing from all expected hosts and sourcetypes? In a distributed SAP landscape with multiple SIDs, instances, and log types, a gap in data collection can go unnoticed for days without centralized visibility.

### Panels

- **Host Event Count** -- Time-series chart showing daily event volume per host (log scale)
- **Active Hosts** -- Count of distinct hosts reporting data
- **Sourcetype Distribution** -- Link graph mapping hosts to their sourcetypes
- **Host Latest Activity** -- Table showing each host's last event time, event count, and sourcetypes (click a row to drill down to Host Details)

### :material-lightning-bolt:{ .taiconcolor } What to Look For

- **Hosts going silent** -- A host that was previously reporting data but suddenly stops may indicate an agent failure, network issue, or system outage. Check the Host Latest Activity table for stale timestamps.
- **Sourcetype volume drops** -- A sudden decrease in events for a specific sourcetype often signals an ingestion pipeline issue (SQS queue backup, S3 input failure, or filter misconfiguration).
- **Unexpected volume spikes** -- A sharp increase in event volume from a single host could indicate a log storm (runaway process, debug logging left enabled) or a security event generating excessive audit entries.
- **Missing sourcetype mappings** -- If a host shows data but is missing an expected sourcetype in the link graph, the routing transforms may need attention.

![Data Pipeline Overview](../../images/dashboard-overview.png)

---

## ABAP Network & Security

### :material-circle-box:{ .taiconcolor } Why This Dashboard Matters

The ABAP Network & Security dashboard monitors the network-facing components of SAP ABAP systems. The Internet Communication Manager (ICM) handles all HTTP/HTTPS traffic into and out of ABAP, while the Gateway controls RFC connections between SAP systems. Together, these are the primary attack surface for ABAP-based landscapes and the first place where performance degradation manifests during connectivity issues.

### Panels

- **Total Events** -- Aggregate event count across ICM, Gateway, and Audit sourcetypes
- **ICM Errors** -- Count of ICM events flagged as errors
- **Gateway Errors** -- Count of Gateway events with error details
- **Event Volume by Sourcetype** -- Daily trend of each sourcetype
- **ICM Status Codes Over Time** -- Stacked column chart of 2xx, 3xx, 4xx, and 5xx responses
- **ICM Peer Connections** -- Table of top peer IPs by request count with protocol details
- **ICM Request Types** -- Pie chart breakdown of ICM request types
- **Gateway Remote Hosts** -- Table of gateway connections by remote host, function, and service
- **Gateway Errors Over Time** -- Timeline of gateway error events
- **Activity by SID / Instance** -- Column chart showing event distribution across SAP systems

### :material-lightning-bolt:{ .taiconcolor } What to Look For

- **ICM 4xx/5xx spikes** -- A sudden increase in client errors (4xx) may indicate application misconfigurations or scanning activity. Server errors (5xx) suggest backend failures or resource exhaustion.
- **Unfamiliar peer IPs** -- New IP addresses appearing in the ICM Peer Connections table warrant investigation, especially if they generate high request volumes or connect using unusual protocols.
- **Gateway connections from unknown hosts** -- The Gateway Remote Hosts table should show expected RFC partners. Unknown remote hosts or unusual service names may indicate unauthorized access attempts.
- **Error rate trends** -- A gradually increasing error rate across days can signal infrastructure degradation (disk space, memory pressure, certificate expiry) before it becomes an outage.

![ABAP Network & Security](../../images/dashboard-abap-security.png)

---

## ABAP Operations

### :material-circle-box:{ .taiconcolor } Why This Dashboard Matters

The ABAP Operations dashboard provides runtime health monitoring for the SAP ABAP application layer. It covers the dispatcher (request routing), work processes (transaction execution), enqueue server (lock management), and system uptime. These components are the engine of every SAP ABAP system, and their health directly impacts user experience and business process execution.

### Panels

- **Total Events** -- Aggregate event count across all ABAP operations sourcetypes
- **Active SIDs** -- Count of distinct SAP System IDs reporting data
- **Dispatcher Errors** -- Count of ERROR/FATAL severity dispatcher events
- **Event Volume by Sourcetype** -- Daily trend across all six sourcetypes
- **System Uptime (Latest)** -- Table showing the most recent uptime in days and hours per SID/instance
- **Dispatcher Severity Over Time** -- Stacked column chart of dispatcher log severity levels
- **Top Work Process Functions** -- Table of the most frequently called work process functions
- **Work Process Categories** -- Pie chart breakdown of work process activity by category
- **Enqueue Lock Activity** -- Timeline of lock management operations
- **Activity by SID / Instance / Type** -- Event distribution across SAP systems and sourcetypes

### :material-lightning-bolt:{ .taiconcolor } What to Look For

- **Uptime resets** -- A system showing low uptime (hours instead of days) indicates a recent restart. Unexpected restarts may signal crashes, memory issues, or unplanned maintenance.
- **Dispatcher ERROR/FATAL increases** -- Rising error severity in the dispatcher indicates work process exhaustion, connection failures, or configuration problems that will soon impact users.
- **Work process category shifts** -- A sudden change in the distribution of work process categories (e.g., dialog processes being consumed by batch jobs) suggests resource contention.
- **Enqueue lock spikes** -- A sharp increase in lock operations can indicate application deadlocks, long-running transactions holding locks, or database performance issues causing lock wait times to increase.
- **SID/instance imbalance** -- If one system or instance is generating significantly more events than its peers, investigate whether it's handling disproportionate load or experiencing issues.

![ABAP Operations](../../images/dashboard-abap-operations.png)

---

## HANA Audit

### :material-circle-box:{ .taiconcolor } Why This Dashboard Matters

The HANA Audit dashboard is essential for database security compliance and threat detection. SAP HANA stores the most sensitive business data in the SAP landscape, and its audit trail captures every authentication attempt, privilege change, and administrative action. This dashboard transforms raw audit events into actionable security intelligence, supporting both real-time threat detection and compliance reporting.

### Panels

- **Total Audit Events** -- Aggregate count of HANA audit log entries
- **Failed Operations** -- Count of audit events with non-successful status
- **Active Users** -- Count of distinct users generating audit activity
- **User Admin Activity Timeline** -- Tracks user administration actions (password resets, activations, deactivations) over time
- **Security Events Timeline** -- Shows failed operations, object modifications, and permission grants
- **Audit Category Breakdown** -- Pie chart of audit event categories
- **Daily Security Health Score** -- Stacked chart combining daily event volume, active users, failures, and success rate
- **Password Management Activities** -- Table of password-related audit events with user and IP details
- **Failed Operations by Host** -- Pie chart identifying which hosts generate the most failures
- **Top Users by Activity** -- Table ranking users by audit event count with failure counts
- **Activity by Hour of Day** -- Column chart showing successes vs. failures by hour for after-hours detection
- **Client IP Analysis** -- Table of connecting IPs with user counts, failures, and last-seen time

### :material-lightning-bolt:{ .taiconcolor } What to Look For

- **Failed operations from unusual IPs** -- Authentication failures from IP addresses not in your expected range may indicate brute-force attacks or credential stuffing attempts.
- **After-hours administrative activity** -- User administration and privilege changes occurring outside business hours warrant scrutiny, particularly password resets and user activations.
- **Privilege escalation patterns** -- Watch for sequences where a user's privileges are modified followed by unusual data access patterns. The Security Events Timeline surfaces GRANT and REVOKE operations.
- **Declining security health score** -- A downward trend in the daily success rate or an increase in failures signals growing security issues that need investigation.
- **Password management anomalies** -- Bulk password resets or resets for service accounts should be correlated with change management records.

![HANA Audit](../../images/dashboard-hana-audit.png)

---

## HANA Trace

### :material-circle-box:{ .taiconcolor } Why This Dashboard Matters

The HANA Trace dashboard provides visibility into SAP HANA's internal diagnostic trace system. Unlike audit logs that capture user actions, trace logs capture what the database engine itself is doing: memory management, query compilation, I/O operations, and internal errors. This is the primary tool for diagnosing HANA performance issues, stability problems, and understanding the root cause of database outages.

### Panels

- **Total Trace Events** -- Aggregate count of trace log entries
- **Errors / Fatal** -- Count of error and fatal severity events
- **Unique Components** -- Number of distinct HANA components generating traces
- **Trace Volume Over Time** -- Daily trend of total trace events
- **Trace Events by Severity** -- Stacked column chart showing info, warning, error, and fatal distributions
- **Top Components** -- Table of the most active HANA components with source file counts
- **Component by Severity (Top 10)** -- Stacked column chart showing which components produce the most errors
- **Source File Hotspots** -- Table identifying specific source files generating the most trace entries
- **Activity by SID / Instance** -- Event distribution across HANA systems
- **Recent Errors / Fatal Events** -- Table of the latest error and fatal trace events with component and source location

### :material-lightning-bolt:{ .taiconcolor } What to Look For

- **Error/fatal severity spikes** -- A sudden increase in error-level traces often precedes a HANA outage or performance degradation. Investigate the component and source file generating the errors.
- **Single component dominance** -- If one component suddenly generates significantly more traces than usual, it may indicate a runaway process, memory leak, or infinite loop within that subsystem.
- **New source files appearing** -- Trace entries from source files not seen before may indicate recently applied patches or code changes that are generating unexpected behavior.
- **SID/instance imbalance** -- Uneven trace volumes across instances of the same HANA system may indicate hardware issues, unbalanced workload distribution, or replication problems.
- **Persistent warning trends** -- Warnings that gradually increase over days often signal resource exhaustion (disk space, memory pools) that will eventually escalate to errors.

![HANA Trace](../../images/dashboard-hana-trace.png)

---

## SAP Services

### :material-circle-box:{ .taiconcolor } Why This Dashboard Matters

The SAP Services dashboard monitors three host-level services that are critical to SAP system availability: SAP Router (network gateway for RFC/HTTP traffic), sapstartsrv (system startup and management), and SAP Host Agent (host monitoring and management). These services operate at the infrastructure layer, below the application, and their failures can prevent SAP systems from starting, connecting, or being managed remotely.

### Panels

- **Total Events** -- Aggregate event count across all three service types
- **Auth Failures** -- Count of sapstartsrv authentication failures
- **Router Errors** -- Count of SAP Router error events
- **Event Volume by Service** -- Daily trend across the three sourcetypes
- **SAP Router Connections** -- Table of recent router connection events with source/peer details
- **Router Actions Over Time** -- Stacked column chart of CONNECT, DISCONNECT, and error actions
- **Router Error Details** -- Table of recent router errors with function, return code, and peer details
- **Sapstartsrv Authentication Events** -- Table of authentication attempts showing user, IP, method, and result
- **Sapstartsrv SSL/TLS Events** -- Table of SSL/TLS negotiation events with version and error details
- **Host Agent Severity** -- Pie chart of SAP Host Agent log severity distribution

### :material-lightning-bolt:{ .taiconcolor } What to Look For

- **Authentication failures from new IPs** -- Repeated auth failures from unfamiliar IP addresses in the sapstartsrv panel may indicate brute-force login attempts against SAP management interfaces.
- **SSL/TLS errors increasing** -- Rising SSL errors often signal upcoming certificate expiration, TLS version mismatches after security patches, or man-in-the-middle attempts.
- **Router error spikes** -- Increasing SAP Router errors indicate network connectivity issues between SAP systems. Check the Router Error Details for specific return codes and affected peers.
- **Connection patterns from unexpected sources** -- The Router Connections table should show expected SAP-to-SAP traffic patterns. Connections from unexpected IPs or unusual ports warrant investigation.
- **Host Agent ERROR severity** -- If the Host Agent severity distribution shifts toward ERROR, the host monitoring infrastructure may be degrading, which impacts central management capabilities.

![SAP Services](../../images/dashboard-sap-services.png)

---

## Cloud Connector

### :material-circle-box:{ .taiconcolor } Why This Dashboard Matters

The Cloud Connector dashboard monitors SAP Cloud Connector (SCC), which provides secure tunneled connectivity between on-premise SAP systems and SAP BTP (Business Technology Platform) cloud services. As the bridge between on-premise and cloud, the Cloud Connector's health directly impacts hybrid integration scenarios, Fiori apps, and cloud-based analytics that depend on on-premise data access.

### Panels

- **Total Requests** -- Count of HTTP requests processed by the Cloud Connector
- **Error Rate** -- Percentage of requests resulting in errors
- **Audit Events** -- Count of Cloud Connector audit log entries
- **Request Volume Over Time** -- Daily HTTP request trend
- **Status Code Distribution** -- Stacked column chart of 2xx, 3xx, 4xx, and 5xx responses
- **Top URIs by Request Count** -- Table of the most requested URIs with average response time and total bytes
- **Average Response Time** -- Line chart trending response time over time
- **Top Clients** -- Table of the most active client IPs with request counts and unique URI counts
- **HTTP Methods** -- Pie chart breakdown of request methods
- **Cloud Connector Audit Log** -- Table of recent audit events with type and account details

### :material-lightning-bolt:{ .taiconcolor } What to Look For

- **Error rate increases** -- A rising error rate indicates connectivity issues between on-premise systems and the cloud. Check the Status Code Distribution for whether errors are client-side (4xx) or server-side (5xx).
- **Response time degradation** -- Gradually increasing response times suggest bandwidth constraints, backend system slowdowns, or Cloud Connector resource exhaustion. Sudden spikes may indicate outages.
- **Unusual URIs** -- Requests to unexpected URI paths in the Top URIs table may indicate scanning or misconfigured cloud applications attempting to access unauthorized resources.
- **Audit events indicating config changes** -- Cloud Connector audit entries for configuration modifications should correlate with approved change windows. Unexpected changes may indicate unauthorized access.
- **New client IPs** -- The Cloud Connector should only receive traffic from expected BTP subaccounts. New client IPs may indicate unauthorized access attempts or misconfigured routing.

![Cloud Connector](../../images/dashboard-cloud-connector.png)

---

## Web Dispatcher

### :material-circle-box:{ .taiconcolor } Why This Dashboard Matters

The Web Dispatcher dashboard analyzes HTTP traffic flowing through the SAP Web Dispatcher, which acts as the reverse proxy and load balancer for SAP web applications including Fiori, WebGUI, and custom web services. As the front door for all web-based SAP access, the Web Dispatcher's traffic patterns reveal both performance issues and potential security threats.

### Panels

- **Total Requests** -- Aggregate count of HTTP requests processed by the Web Dispatcher
- **Error Rate** -- Percentage of requests returning 4xx or 5xx status codes
- **Avg Response Time** -- Average response time across all requests in milliseconds
- **Traffic by Status Code** -- Stacked column chart showing 2xx, 3xx, 4xx, and 5xx response distributions
- **Response Time Trend** -- Response time patterns over time
- **Traffic by HTTP Method** -- Breakdown of GET, POST, PUT, DELETE, etc.
- **Top 5 Slowest Pages** -- Bar chart of the slowest responding URLs
- **Top Client IPs by Traffic** -- Bubble chart showing the most active client IP addresses
- **Request Volume Over Time** -- Daily request trend line
- **Top URIs by Request Count** -- Table of the most accessed URIs with average response time and unique client counts
- **Recent Errors (4xx/5xx)** -- Table of the latest error events with client IP, method, URI, and status code

### :material-lightning-bolt:{ .taiconcolor } What to Look For

- **4xx/5xx status code spikes** -- Client errors (4xx) may indicate broken links, misconfigured apps, or scanning activity. Server errors (5xx) signal backend ABAP or Java system failures.
- **Response time degradation** -- Slow response times impact user experience. Correlate with the Top 5 Slowest Pages to identify which applications are affected, then investigate backend system load.
- **Unusual HTTP methods** -- PUT, DELETE, or PATCH requests where only GET/POST are expected may indicate API abuse or vulnerability exploitation.
- **Concentrated client IP traffic** -- A single IP generating disproportionate traffic in the bubble chart may be a bot, scraper, or denial-of-service source.
- **TLS version distribution** -- If your data includes TLS fields, watch for clients using deprecated TLS versions (1.0, 1.1) that may need to be blocked for compliance.

![Web Dispatcher](../../images/dashboard-web-dispatcher.png)

---

## DNS Analytics

### :material-circle-box:{ .taiconcolor } Why This Dashboard Matters

The DNS Analytics dashboard transforms DNS query data into a security detection tool. DNS is used by virtually all network communications and is often exploited by attackers for command-and-control (C2) beaconing, data exfiltration via DNS tunneling, and reconnaissance. Because DNS traffic is rarely inspected by traditional security tools, this dashboard fills a critical visibility gap in SAP infrastructure security.

### Panels

- **Total Queries** -- Aggregate count of DNS queries in the selected time range
- **Unique Clients** -- Count of distinct client IPs generating DNS queries
- **Beaconing Domains** -- Count of domains exhibiting periodic query patterns consistent with C2 beaconing
- **Top 10 DNS Clients** -- Time-series of the most active DNS clients
- **Volume & Packet Size** -- Scatter plot correlating query volume with packet sizes to identify anomalies
- **Requests by Record Type** -- Breakdown of DNS query types (A, AAAA, PTR, MX, etc.)
- **Beaconing Activity** -- Bubble chart highlighting domains with regular, periodic query patterns that may indicate C2 beaconing
- **Hosts to Beaconing Domains** -- Maps which hosts are communicating with suspected beaconing domains
- **Top Queried Domains** -- Table of the most looked-up domains with unique client counts
- **Top Clients by Domain Diversity** -- Table ranking clients by number of unique domains queried, with queries-per-domain ratio for DGA detection
- **Query Type Distribution** -- Donut chart showing the breakdown of DNS record types (A, AAAA, PTR, TXT, etc.)

### :material-lightning-bolt:{ .taiconcolor } What to Look For

- **Beaconing patterns** -- The Beaconing Activity panel uses statistical analysis (low variance in query intervals) to detect domains being contacted at regular intervals, which is a hallmark of malware C2 communication. Domains with low variance and high count are the highest priority.
- **DNS tunneling indicators** -- Unusually large packet sizes in the Volume & Packet Size scatter plot may indicate DNS tunneling, where data is exfiltrated through encoded DNS queries.
- **Unusual record types** -- TXT record queries at high volume are a common DNS tunneling technique. MX queries from non-mail servers may indicate reconnaissance.
- **New high-volume clients** -- A host that suddenly becomes one of the top DNS clients may be compromised and performing domain generation algorithm (DGA) lookups or reconnaissance scanning.
- **Multiple hosts reaching beaconing domains** -- The Hosts to Beaconing Domains panel shows lateral spread. If multiple internal hosts contact the same suspected C2 domain, it suggests widespread compromise.
- **High domain diversity** -- Clients querying many unique domains with a low queries-per-domain ratio in the Top Clients by Domain Diversity table may indicate Domain Generation Algorithm (DGA) activity or automated reconnaissance.

![DNS Analytics](../../images/dashboard-dns-analytics.png)

---

## Linux System & Security

### :material-circle-box:{ .taiconcolor } Why This Dashboard Matters

The Linux dashboard provides OS-level visibility for the hosts running SAP applications. Most SAP ABAP and HANA systems run on Linux, making OS-level monitoring essential for understanding the infrastructure beneath the application layer. This dashboard combines SAP-aware context (SID, instance, application identification from syslog) with kernel-level security monitoring (firewall drops and kernel events).

### Panels

- **Total Events** -- Aggregate event count across all Linux sourcetypes
- **Firewall Drops** -- Count of kernel firewall drop events
- **Active Hosts** -- Count of distinct Linux hosts reporting data
- **Event Volume by Sourcetype** -- Daily trend across linux_messages_syslog, syslog, and linux_secure
- **SAP Application Activity** -- Column chart showing event distribution by SAP application and SID
- **SAP Instance Distribution** -- Table of SAP instances with event counts by SID, instance number, and CID
- **Firewall Drops Over Time** -- Timeline of kernel firewall drop events
- **Top Blocked Sources** -- Table of source IPs being blocked by the firewall with target counts and protocols
- **Kernel Event Types** -- Pie chart breakdown of kernel event categories (IN_DROP, segfault, etc.)
- **Top Blocked Destination Ports** -- Table of destination ports targeted by blocked traffic

### :material-lightning-bolt:{ .taiconcolor } What to Look For

- **Firewall drop spikes** -- A sudden increase in blocked connections may indicate port scanning, network reconnaissance, or a brute-force attack against SAP services.
- **New blocked source IPs** -- Unfamiliar source IPs appearing in the Top Blocked Sources table should be investigated, especially if they target SAP service ports (3200-3299 for dialog, 8000-8099 for HTTP, 30015 for HANA).
- **SAP application distribution changes** -- If the SAP Application Activity chart shows a previously active SID or application going silent, it may indicate a process crash or configuration issue.
- **Kernel segfaults** -- Segmentation faults appearing in the Kernel Event Types panel indicate application crashes, which may affect SAP system stability.
- **Port targeting patterns** -- The Top Blocked Destination Ports table reveals which services attackers are targeting. Ports associated with SAP services warrant immediate attention.

![Linux System & Security](../../images/dashboard-linux.png)

---

## Windows Events

### :material-circle-box:{ .taiconcolor } Why This Dashboard Matters

The Windows Events dashboard monitors Windows hosts in the SAP landscape, which commonly run SAP application servers, database instances, and management consoles. Windows Event Logs capture authentication activity, service health, PowerShell execution, and system errors. This dashboard surfaces the security-relevant events that indicate compromise, policy violations, or service degradation on Windows-based SAP infrastructure.

### Panels

- **Total Events** -- Aggregate Windows event count
- **Critical / Error** -- Count of critical and error severity events
- **Active Hosts** -- Count of distinct Windows hosts reporting data
- **Event Volume by Log** -- Daily trend by Windows log source (Application, Security, System, PowerShell)
- **Severity Distribution Over Time** -- Stacked column chart of severity levels
- **Top Event Codes** -- Table of the most frequent EventCodes with signature descriptions
- **Security Event Actions** -- Stacked column chart of security actions (success, failure, lockout, logoff)
- **Top Users** -- Table of the most active users with event codes and action types
- **Service Events** -- Table of Windows service start/stop activity with latest state
- **PowerShell Activity** -- Line chart trending PowerShell event volume

### :material-lightning-bolt:{ .taiconcolor } What to Look For

- **Account lockouts** -- Lockout events in the Security Event Actions panel indicate either brute-force password attacks or users with expired/cached credentials. Investigate the source IP and user.
- **Security failure spikes** -- A sudden increase in authentication failures, especially for service accounts (SAPService, sapadm), may indicate credential compromise or misconfiguration after a password change.
- **Service crashes** -- EventCode 7031 (service terminated unexpectedly) in the Service Events panel indicates a critical service failure. For SAP services (sapstartsrv, SAPService), this requires immediate attention.
- **PowerShell activity spikes** -- Sudden increases in PowerShell execution may indicate lateral movement by an attacker using PowerShell-based attack tools. Correlate with the user generating the activity.
- **Critical/error severity trends** -- A rising trend in critical and error events over multiple days indicates accumulating system health issues that need proactive investigation.

![Windows Events](../../images/dashboard-windows.png)

---

## Proxy Analytics

### :material-circle-box:{ .taiconcolor } Why This Dashboard Matters

The Proxy Analytics dashboard monitors outbound internet access through the Squid proxy server. In SAP environments, proxy logs reveal which systems and users are accessing external resources, enabling detection of data exfiltration attempts, policy violations (unauthorized internet access), and compromised systems communicating with malicious infrastructure. Proxy logs complement DNS analytics by showing the actual HTTP connections that follow DNS resolution.

### Panels

- **Total Requests** -- Aggregate proxy request count
- **Total Bandwidth** -- Sum of bytes transferred through the proxy
- **Denied Requests** -- Count of requests blocked by proxy policy
- **Request Volume Over Time** -- Daily request trend
- **Status Code Distribution** -- Stacked column chart of response categories (2xx-5xx)
- **Top Domains** -- Table of the most accessed domains with request counts, bandwidth, and unique client counts
- **Top Clients** -- Table of the most active client IPs with request counts, bandwidth, and domain diversity
- **HTTP Methods** -- Pie chart breakdown of request methods
- **Content Types** -- Pie chart of content type distribution
- **Bandwidth Over Time** -- Line chart trending total bytes transferred

### :material-lightning-bolt:{ .taiconcolor } What to Look For

- **Denied request spikes** -- A sudden increase in denied requests may indicate a compromised system attempting to reach blocked destinations, or a policy change affecting legitimate traffic.
- **High-bandwidth domains** -- Domains consuming disproportionate bandwidth in the Top Domains table may indicate large data transfers or streaming that violates policy. Investigate unusual domains.
- **Unusual content types** -- Unexpected content types (application/octet-stream, application/x-gzip) in the Content Types panel may indicate file downloads or data exfiltration through the proxy.
- **New high-volume clients** -- A system that suddenly appears as a top proxy client may be compromised and performing outbound scanning, beaconing, or data exfiltration.
- **POST-heavy traffic** -- An unusual proportion of POST requests (vs. GET) in the HTTP Methods panel may indicate data being uploaded to external services.

![Proxy Analytics](../../images/dashboard-proxy.png)

---

## Environment Health

### :material-circle-box:{ .taiconcolor } Why This Dashboard Matters

The Environment Health dashboard is a single-pane-of-glass operations view that aggregates the most critical signals from across the entire SAP landscape. Instead of switching between individual dashboards to piece together overall health, administrators can use this dashboard to immediately identify active errors, security failures, and performance degradation. Every panel links to the relevant detailed dashboard for investigation, making this the recommended starting point for daily operations monitoring and incident triage.

### Panels

- **Total Errors** -- Aggregate count of errors across all monitored sourcetypes. Click to open a detailed search showing errors by category, sourcetype, affected hosts, and last-seen time.
- **HANA Failed Ops** -- Count of non-successful HANA audit operations (login failures, permission denials, DDL errors). Click to drill down to HANA Audit dashboard.
- **Auth Failures** -- Combined count of sapstartsrv authentication failures and HANA audit connection failures. Click to drill down to SAP Services dashboard.
- **Firewall Drops** -- Count of Linux firewall (iptables) drop events across all monitored hosts. Click to drill down to Linux dashboard.
- **Web Error Rate %** -- Percentage of Web Dispatcher requests returning 4xx/5xx status codes. Click to drill down to Web Dispatcher dashboard.
- **Beaconing Domains** -- Count of DNS domains exhibiting periodic query patterns that may indicate malware or C2 communication. Click to drill down to DNS Analytics dashboard.
- **ABAP Error Trend** -- Stacked column chart of daily ABAP errors by sub-source (Dispatcher, ICM, Gateway). Click to drill down to ABAP Security dashboard.
- **HANA Error Trend** -- Stacked column chart of daily HANA errors (Audit Failures, Trace Errors). Click to drill down to HANA Audit dashboard.
- **Security Error Trend** -- Stacked column chart of daily security errors (Auth Failures, Firewall Drops). Click to drill down to SAP Services dashboard.
- **Web/Network Error Trend** -- Stacked column chart of daily web/network errors (WebDisp 4xx/5xx, Router Errors, Proxy Denied). Click to drill down to Web Dispatcher dashboard.
- **Cloud Connector Error Trend** -- Stacked column chart of daily Cloud Connector HTTP errors (4xx Client, 5xx Server). Click to drill down to Cloud Connector dashboard.
- **OS/Infra Error Trend** -- Stacked column chart of daily Windows events by severity (High, Medium). Click to drill down to Windows dashboard.
- **Recent Critical Events** -- Table of the 20 most recent critical events (HANA audit failures, ABAP dispatcher FATAL, HANA trace fatal, auth failures, Windows high severity). Click any row to drill down to Host Details for that host.
- **Top Affected Hosts** -- Table of hosts ranked by total error count with breakdowns by category (ABAP, HANA, Services, Firewall, Other). Click any host to drill down to Host Details.
- **Web Dispatcher Response Time** -- Line chart of daily average response time trend for web dispatcher requests. Click to drill down to Web Dispatcher dashboard.
- **ICM Status Codes** -- Stacked column chart of HTTP status code categories (2xx/3xx/4xx/5xx) over time. Click to drill down to ABAP Security dashboard.
- **Data Pipeline -- Events/Day** -- Average daily event volume and daily trend line for monitoring pipeline health and detecting ingestion gaps. Click to drill down to Overview dashboard.

### :material-lightning-bolt:{ .taiconcolor } What to Look For

- **Rising error trend** -- An upward slope in any error category chart indicates a worsening condition. Correlate the timing with recent changes, deployments, or infrastructure events. Each chart drills directly to the relevant dashboard for investigation.
- **Auth failure spikes** -- Sudden increases in the Auth Failures KPI or Security Error Trend may indicate brute-force login attempts, expired credentials, or misconfigured service accounts. Cross-reference with the HANA Audit and SAP Services dashboards.
- **HANA audit failures** -- Non-zero HANA Failed Ops always warrant investigation. Failed operations may indicate unauthorized access attempts, privilege escalation, or application misconfigurations.
- **Cloud Connector errors** -- A spike in the Cloud Connector Error Trend (especially 5xx Server errors) may indicate backend system unavailability, network issues between the SCC and SAP BTP, or certificate expiration.
- **Pipeline volume drops** -- A sudden drop in the Events/Day trend may indicate an SQS queue backup, S3 input failure, HF outage, or filter misconfiguration. Check the Data Pipeline Overview for per-host visibility.
- **Response time degradation** -- An increasing trend in Web Dispatcher response time often precedes user-facing performance complaints. Investigate ICM status codes for correlated 5xx errors.
- **Host concentration** -- If the Top Affected Hosts table shows errors concentrated on one or two hosts, those systems may have a localized issue (disk full, service crash, misconfiguration) rather than an environment-wide problem.

![Environment Health](../../images/dashboard-environment-health.png)

---

## Host Details

### :material-circle-box:{ .taiconcolor } Why This Dashboard Matters

The Host Details dashboard is a forensic drill-down tool for investigating individual hosts. Accessed by clicking a host row in the Data Pipeline Overview or by selecting a host from the dropdown, it shows the complete event timeline and sourcetype breakdown for a single system. This view is essential for root cause analysis, incident response, and validating that all expected data sources are present for a given host.

### Panels

- **Host Event Timeline** -- Column chart of daily event volume for the selected host
- **Host Inventory** -- Table showing the host's hardware specs (CPU, cores, RAM), EC2 instance type, operating system, region, and availability zone. Sourced from osquery data in syslog (Linux hosts only).
- **Sourcetype Distribution** -- Sankey diagram showing how the host's events are distributed across sourcetypes

### :material-lightning-bolt:{ .taiconcolor } What to Look For

- **Sourcetype gaps** -- If a host is missing a sourcetype that similar hosts have (e.g., a HANA host without `sap:hana:audit`), it may indicate a misconfigured audit policy or broken log forwarding.
- **Volume anomalies** -- Compare the selected host's event volume to its peers. Significantly higher or lower volume may indicate a workload issue, logging configuration problem, or security event.
- **Sudden volume changes** -- A host that normally generates a steady volume of events but suddenly spikes or drops warrants investigation. Spikes may indicate security events; drops may indicate system or agent failures.
- **Single-sourcetype dominance** -- If one sourcetype accounts for the vast majority of a host's events, the balance may indicate a noisy process (check ICM or workprocess logs for runaway activity).

This dashboard accepts `host_name` and `global_time` parameters from the URL, so the time range and host selection carry over from the Overview dashboard.

![Host Details](../../images/dashboard-host-details.png)
