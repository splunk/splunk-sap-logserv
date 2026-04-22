# Applications

The **Applications** category covers dashboards that monitor the SAP application runtime layer itself — the ABAP application server and the HANA database engine. These are the workloads SAP customers run every day, and dashboards here answer questions about work processes, dispatcher health, database audit trails, and diagnostic trace output.

| Dashboard | Purpose | Key Data Sources |
|-----------|---------|-----------------|
| [ABAP Network & Security](#abap-network-security) | ICM traffic analysis, gateway monitoring, and ABAP audit events | `sap:abap:icm`, `sap:abap:gateway`, `sap:abap:audit` |
| [ABAP Operations](#abap-operations) | ABAP runtime health, dispatcher status, work process activity, and system uptime | `sap:abap:dispatcher`, `sap:abap:enqueueserver`, `sap:abap:event`, `sap:abap:messageserver`, `sap:abap:sapstartsrv`, `sap:abap:workprocess` |
| [Work Process Performance](#work-process-performance) | SAP ABAP work process utilization, dispatcher health, and function-level activity | `sap:abap:workprocess`, `sap:abap:dispatcher` |
| [HANA Audit](#hana-audit) | SAP HANA database audit events, security monitoring, user activity, risk-tiered events, and after-hours admin activity | `sap:hana:audit` |
| [HANA Trace](#hana-trace) | SAP HANA database trace logs, component health, and error analysis | `sap:hana:tracelogs` |

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

![ABAP Network & Security](../../../images/dashboard-abap-security.png)

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
- **Work Process Categories** -- Donut chart with bottom legend showing activity distribution across all 13 SAP work process categories (e.g., `B = Database Interface`, `A = ABAP Processor`, `S = SQL / Statistics`, `M = Memory Management`, `X = RFC / CPIC`). The donut uses the `wp_category_name` field populated by the app's `props.conf` EVAL so every category code gets a friendly name.
- **Enqueue Lock Activity** -- Timeline of lock management operations
- **Activity by SID / Instance / Type** -- Event distribution across SAP systems and sourcetypes

### :material-lightning-bolt:{ .taiconcolor } What to Look For

- **Uptime resets** -- A system showing low uptime (hours instead of days) indicates a recent restart. Unexpected restarts may signal crashes, memory issues, or unplanned maintenance.
- **Dispatcher ERROR/FATAL increases** -- Rising error severity in the dispatcher indicates work process exhaustion, connection failures, or configuration problems that will soon impact users.
- **Work process category shifts** -- A sudden change in the distribution of work process categories (e.g., dialog processes being consumed by batch jobs) suggests resource contention.
- **Enqueue lock spikes** -- A sharp increase in lock operations can indicate application deadlocks, long-running transactions holding locks, or database performance issues causing lock wait times to increase.
- **SID/instance imbalance** -- If one system or instance is generating significantly more events than its peers, investigate whether it's handling disproportionate load or experiencing issues.

![ABAP Operations](../../../images/dashboard-abap-operations.png)

---

## Work Process Performance

### :material-circle-box:{ .taiconcolor } Why This Dashboard Matters

Work Process Performance focuses specifically on the ABAP work process layer: the finite pool of processes that execute every dialog request, background job, and RFC call. When work processes are exhausted, users see "no free work process" errors; when a specific category is saturated, symptoms manifest differently (e.g., database interface saturation causes SQL timeouts; memory category issues cause roll-area swaps). This dashboard breaks activity down by the 13 SAP-standard dev_w* trace component categories so you can target remediation to the right subsystem.

### Panels

- **Total WP Events** -- Aggregate event count from `sap:abap:workprocess` and `sap:abap:dispatcher`
- **Active SIDs** -- Count of distinct SAP System IDs reporting work process data
- **Dispatcher Errors** -- Count of dispatcher severity ERROR/FATAL events
- **Active WP Functions** -- Count of distinct work process function codes observed
- **Work Process Category Trend** -- Stacked column chart showing daily activity by category, with all 13 friendly-named codes (uses the shared `wp_category_name` field)
- **Category Distribution** -- Donut chart showing the overall category mix across the time range (same 13-code legend)
- **Top Work Process Functions** -- Horizontal bar of the most-seen function codes (top 15)
- **Dispatcher Severity Over Time** -- Stacked column of dispatcher severity levels over time
- **Activity by SID / Instance** -- Table ranking each SAP system/instance by event count, with drilldown to filter
- **Recent Dispatcher Errors** -- Table of the 25 most recent dispatcher ERROR/FATAL events with host and severity, with drilldown to the full event

### :material-lightning-bolt:{ .taiconcolor } What to Look For

- **Category saturation** -- If a single category (e.g., `B = Database Interface` or `M = Memory Management`) dominates the Category Distribution donut when it historically didn't, that subsystem may be a bottleneck. Check the associated detail dashboards (HANA Audit/Trace for database; Linux/ABAP Operations for memory).
- **Trend shifts between categories** -- A gradual increase in `N = Network (NI)` or `C = Communication` events can indicate network degradation between the ABAP server and HANA/other SAP systems.
- **Dispatcher error bursts** -- Spikes in the Dispatcher Severity Over Time chart are often the first user-visible symptom of work process exhaustion. Correlate with Category Distribution to identify which category filled up first.
- **Instance imbalance** -- If one instance's WP activity is an order of magnitude higher than its peers in the Activity by SID/Instance table, investigate whether that instance is handling disproportionate load or experiencing a local issue.
- **Function-code hotspots** -- The Top Work Process Functions bar surfaces which ABAP functions are running most often; an unexpected code at the top can indicate a runaway background job or custom transaction generating excessive traces.

![Work Process Performance](../../../images/dashboard-work-process-performance.png)

---

## HANA Audit

### :material-circle-box:{ .taiconcolor } Why This Dashboard Matters

The HANA Audit dashboard is essential for database security compliance and threat detection. SAP HANA stores the most sensitive business data in the SAP landscape, and its audit trail captures every authentication attempt, privilege change, and administrative action. This dashboard transforms raw audit events into actionable security intelligence, supporting both real-time threat detection and compliance reporting.

### Panels

- **Total Audit Events** -- Aggregate count of HANA audit log entries
- **Failed Operations** -- Count of audit events with non-successful status
- **Active Users** -- Count of distinct users generating audit activity
- **User Administration Activity Timeline** -- Tracks user administration actions (password resets, activations, deactivations) over time
- **Daily Security Health Score** -- Stacked chart combining daily event volume, active users, failures, and success rate
- **Audit Category Breakdown** -- Pie chart of audit event categories
- **Security Events Timeline** -- Shows failed operations, object modifications, and permission grants
- **Password Management Activities** -- Table of password-related audit events with user and IP details
- **Failed Operations by Host** -- Pie chart identifying which hosts generate the most failures
- **Top Users by Activity** -- Table ranking users by audit event count with failure counts
- **Activity by Hour of Day** -- Column chart showing successes vs. failures by hour for after-hours detection
- **Client IP Analysis** -- Table of connecting IPs with user counts, failures, and last-seen time
- **Risk-Tiered Event Timeline** -- Stacked column chart of daily events grouped by `risk_level` (critical / high / medium / low), so severe events never get hidden inside overall volume
- **After-Hours / Weekend Admin Activity** -- Table filtered to `is_admin_user=true AND (is_business_hours=false OR weekend)`, surfacing privileged activity outside normal windows; click a row to drill down by user
- **High-Risk Events** -- Full-width table filtered to `is_critical=true` showing the recent top-50 critical audit events with user, client IP, status, action, object, and SQL statement; click a row to drill down by user

### :material-lightning-bolt:{ .taiconcolor } What to Look For

- **Failed operations from unusual IPs** -- Authentication failures from IP addresses not in your expected range may indicate brute-force attacks or credential stuffing attempts.
- **Critical events in the High-Risk Events table** -- Any non-empty row here warrants investigation. The SQL Statement column makes it straightforward to see whether a critical event was a privilege grant, a schema change, or a failed auth.
- **After-hours privileged activity** -- The After-Hours / Weekend Admin Activity table surfaces admin operations outside business hours; correlate with change management records to separate planned maintenance from suspicious activity.
- **Risk-tier shifts over time** -- A rising "critical" or "high" stack in the Risk-Tiered Event Timeline often precedes an incident. A sudden spike in "medium" may point to scripted workloads that need review.
- **Privilege escalation patterns** -- Watch for sequences where a user's privileges are modified followed by unusual data access patterns. The Security Events Timeline surfaces GRANT and REVOKE operations.
- **Declining security health score** -- A downward trend in the daily success rate or an increase in failures signals growing security issues that need investigation.
- **Password management anomalies** -- Bulk password resets or resets for service accounts should be correlated with change management records.

![HANA Audit](../../../images/dashboard-hana-audit.png)

---

## HANA Trace

### :material-circle-box:{ .taiconcolor } Why This Dashboard Matters

The HANA Trace dashboard provides visibility into SAP HANA's internal diagnostic trace system. Unlike audit logs that capture user actions, trace logs capture what the database engine itself is doing: memory management, query compilation, I/O operations, and internal errors. This is the primary tool for diagnosing HANA performance issues, stability problems, and understanding the root cause of database outages.

### Panels

- **Total Trace Events** -- Aggregate count of trace log entries (click to drill down)
- **Errors / Fatal** -- Count of error and fatal severity events (click to drill down)
- **Unique Components** -- Number of distinct HANA components generating traces (click to drill down)
- **Trace Volume Over Time** -- Daily trend of total trace events
- **Trace Events by Severity** -- Stacked column chart showing info, warning, error, and fatal distributions
- **Top Components** -- Table of the most active HANA components with source file counts (excludes parsing-artifact values such as `INFO`, `of`, `service:` so that real components dominate)
- **Component by Severity (Top 10)** -- Stacked column chart showing which components produce the most errors (same noise filter applied)
- **Source File Hotspots** -- Table identifying specific source files generating the most trace entries (same noise filter applied)
- **Activity by SID / Instance** -- Event distribution across HANA systems
- **Recent Errors / Fatal Events** -- Table of the latest error and fatal trace events with component and source location

### :material-lightning-bolt:{ .taiconcolor } What to Look For

- **Error/fatal severity spikes** -- A sudden increase in error-level traces often precedes a HANA outage or performance degradation. Investigate the component and source file generating the errors.
- **Single component dominance** -- If one component suddenly generates significantly more traces than usual, it may indicate a runaway process, memory leak, or infinite loop within that subsystem.
- **New source files appearing** -- Trace entries from source files not seen before may indicate recently applied patches or code changes that are generating unexpected behavior.
- **SID/instance imbalance** -- Uneven trace volumes across instances of the same HANA system may indicate hardware issues, unbalanced workload distribution, or replication problems.
- **Persistent warning trends** -- Warnings that gradually increase over days often signal resource exhaustion (disk space, memory pools) that will eventually escalate to errors.

![HANA Trace](../../../images/dashboard-hana-trace.png)
