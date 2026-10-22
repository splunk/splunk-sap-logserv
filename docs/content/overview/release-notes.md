# Release Notes


## Version 0.1.2 (latest)

### :material-circle-box:{ .taiconcolor } Compatibility

|                                  |                              |
|----------------------------------|------------------------------|
| Splunk platform versions         | 9.4.3 and later              |
| CIM                              | 5.0.0 and later (per `app.manifest`) |
| Supported OS for data collection | Platform independent         |
| Vendor products                  | SAP LogServ for SAP ECS in Amazon Web Services (AWS), Microsoft Azure, and Google Cloud Platform (GCP) |
| Published App artifact           | The **full-LLM build variant** — the free-form LLM path is present but inert until an LLM provider credential is configured; predefined prompts + MCP dispatch work with no credential (see [Build Variants](../ai-assistant/templates-only-build.md)) |
| AI Assistant prerequisite        | [Splunk MCP Server (Splunkbase App 7931)](https://splunkbase.splunk.com/app/7931) v1.0.3 or later — no upper bound since App build 393 (2.0.0 the newest verified); v1.1.0+ recommended — on the search head where the LogServ App is installed |
| AWS ingest                       | The [Splunk Add-on for AWS](https://splunkbase.splunk.com/app/1876) (SQS-Based S3 inputs) on the Heavy Forwarders; the Data TA's AWS S3 Direct screen accepts 8.1.0 and later, with no upper bound |
| Azure ingest                     | A dedicated first-party add-on — **Splunk TA for SAP LogServ on Azure** (`splunk_ta_sap_logserv_azure`), installed per Heavy Forwarder |
| GCP ingest                       | A dedicated first-party add-on — **Splunk TA for SAP LogServ on GCP** (`splunk_ta_sap_logserv_gcp`), installed per Heavy Forwarder |

!!! note "v0.1.2 continues the v0.1.1 line"
    v0.1.2 is the active **LLM-capable** line and carries everything listed under Version 0.1.1 below — the dashboard-performance data layer (tstats + KV-Store rollups, the backfill panel, staggered schedules), the Azure and GCP ingest add-ons, the LogServ Data Doctor, the Environment Topology work, and the full LLM-driven AI Assistant. The published App artifact is the **full-LLM build variant**, so the free-form path is present and becomes active once an [LLM provider credential](../ai-assistant/settings.md) is configured; the compile-time templates-only variant of the same source remains available for deployments where that restriction must not be reversible (see [Build Variants](../ai-assistant/templates-only-build.md)). Entries for this release are added as work lands.

### :material-circle-box:{ .taiconcolor } The Audit Log's user filter shows each name once (build 394)

- **With *User contains* set, Settings → AI Assistant → Audit Log showed each name twice in the User column** (for example `adminadmin`). The filter makes Splunk extract `user` from the event to apply it, and the viewer's `spath` then added the same value again. The viewer now reads `user` from the event's JSON after `spath`, as it already did for `category`, so the column shows the name once with or without the filter.

**After upgrading:** nothing to rebuild, and no acknowledgement is asked again.

### :material-circle-box:{ .taiconcolor } A newer Splunk MCP Server is no longer refused (build 393)

- **The AI Assistant runs against any Splunk MCP Server from v1.0.3 up.** It used to refuse a version at or above an upper bound it had not been tested against (v3.0.0 since build 335), replacing the chat with an *Uncertified version* card. That bound is gone; the v1.0.3 floor (CVE-2026-20205) stays. A version reported in two parts, such as 3.0, now reads as 3.0.0; it used to be refused as too old. The newest version verified is 2.0.0 (the handshake, `tools/list` and `tools/call`); if a later version changed the protocol the AI Assistant depends on, that would show as failing tool calls in the chat rather than as a refusal to start.

**After upgrading:** nothing to rebuild, and no acknowledgement is asked again.

### :material-circle-box:{ .taiconcolor } Audit events go where the settings in place when they were posted send them, and the dialog names both providers (build 392)

- **An audit event posted on its own goes where the audit settings in place at that moment send it.** That covers the Settings page's acknowledgement events, which are posted just before the save. Until now the forwarder setting was read only after the event's local write, so that save could decide, while the event was being written, whether the event was also sent to the off-host forwarder. Now a Yes that turns forwarding off is also sent to the forwarder being turned off (an attempt with the forwarder settings the page has applied), and if that send fails, its failure record goes to the event's audit index, even when the same save renames the index.
- **On a re-ask whose save also changes the LLM provider, the enablement dialog names both:** the provider in effect, which a No keeps, and the one the save changes it to, which a Yes saves.
- **The build-time tests are stricter.** The legal-text test reads the code with its comments removed and pins each acknowledgement event's fields, the call that posts it, and the awaited record of each answer in its own store. The audit-writer test checks where an event goes when the settings change while it is being written.

**After upgrading:** nothing to rebuild, and no acknowledgement is asked again: the legal texts and their versions are unchanged.

### :material-circle-box:{ .taiconcolor } The audit-forwarding Yes is logged even when the save after it fails (build 391)

- **The audit-forwarding acknowledgement's audit event is posted as soon as the answer is recorded**, for a Yes as for a No. A Yes's event used to wait for the save, so a Yes followed by a failed save could leave the Yes recorded with no audit event, and the retry did not always ask again.
- **On a re-ask, the enablement dialog names the provider in effect**, the one a No keeps; it named the provider selected on the page. When the AI Assistant is being turned on, it still names the page's provider.
- The build-time legal-text test pins both, and pins the Settings page's busy state more tightly: set before the turn-off write, released when that write fails, held until the No is recorded. Its provider checks skip `//` comment lines. Also: a code-style fix and comment fixes.

**After upgrading:** nothing to rebuild, and no acknowledgement is asked again: the legal texts and their versions are unchanged.

### :material-circle-box:{ .taiconcolor } The Settings page waits for a No to be recorded, and the audit-forwarding dialog shows its errors (build 390)

- **A No that turns the AI Assistant off keeps the Settings page busy until the No is recorded** (the Save button reads *Saving…*); the page could be used again a moment too early.
- **The audit-forwarding dialog closes when its answer cannot be recorded, or when the save after a Yes fails**, so the error shows on the page; it appeared behind the dialog.
- **A No's audit event records the provider in effect**, for both acknowledgements; it recorded the provider selected on the page, which a No does not save.
- The build-time legal-text test pins all three. Also: comment fixes.

**After upgrading:** nothing to rebuild, and no acknowledgement is asked again: the legal texts and their versions are unchanged.

### :material-circle-box:{ .taiconcolor } The enablement dialog closes once the AI Assistant is off (build 389)

- **No turn-on wording during a No.** When a No turns the AI Assistant off, the dialog now closes as soon as that is done, before the No is recorded; until now it showed the turn-on wording and buttons for that moment.
- **An answer that cannot be recorded closes the dialog**, so the error shows on the page; it used to appear behind the dialog.
- The build-time legal-text test pins both. Also: comment fixes.

**After upgrading:** nothing to rebuild, and no acknowledgement is asked again: the legal texts and their versions are unchanged.

### :material-circle-box:{ .taiconcolor } Declining the AI Assistant terms turns the AI Assistant off (build 388)

- **A No now does what the terms say.** The enablement acknowledgement ends by saying that if Customer does not accept, the AI Assistant feature will remain disabled. That held when an admin was turning the AI Assistant on. When it was already on and the terms' version rose, a No only cancelled that save: the AI Assistant stayed on, and the next save went through without asking. Now a No in that case turns the AI Assistant off. Only the *Enable AI Assistant* setting changes - nothing else in that save is applied - and it is written before the No is recorded, so if the write fails, the question is asked again at the next save. The dialog says so before the click, and its No button reads *I do not accept (record No and turn off)*.
- **The enablement acknowledgement is at version 3.** Its closing sentence now says the AI Assistant feature will then remain disabled or, if it is already enabled, be disabled. A deployment that runs with the AI Assistant enabled is asked once to accept it, at the next **Save Defaults**; coming from build 386 or earlier, that is the only time (build 387, which raised it to version 2, was not released).
- The build-time legal-text test pins the version-3 text and the code that carries it out: the turn-off before the No is recorded, the early returns that stop a failed turn-off from being recorded and a declined save from going on, and the dialog's wording on the re-ask.
- Also: the Settings page's message when an answer cannot be recorded no longer repeats itself, and the acknowledgement code's comments no longer describe the configuration-file write used before build 240.

**After upgrading:** nothing to rebuild. With the AI Assistant enabled, expect the enablement acknowledgement once, at the next **Save Defaults**; answering No turns the AI Assistant off.

### :material-circle-box:{ .taiconcolor } The acknowledgements say where an answer is recorded (build 387)

- **The AI Assistant enablement acknowledgement is at version 2.** Clause 7 of its text said the administrator's answer is recorded "via the standard Splunk telemetry endpoint". The answer is recorded as an event in the AI Assistant audit log, with the administrator's account name, network address and a timestamp, and, since build 240, stored with the acknowledged version in the KV Store; the clause now says so. Because the wording changed, its version rose from 1 to 2: on a deployment where the AI Assistant is enabled, the next admin who saves the AI Assistant's General settings (**Save Defaults**) is asked once to accept the corrected text. Turning the AI Assistant on asks every time, as before.
- **The note under both acknowledgements** (outside their legal text) and the Settings page's message when an answer cannot be recorded named the same telemetry endpoint. The note now names the audit log and the KV Store, and the message names the KV Store, the write that failed.
- The build-time legal-text test pins the enablement text at version 2 and fails if either acknowledgement, or the Settings page, mentions the telemetry endpoint again.

**After upgrading:** nothing to rebuild. With the AI Assistant enabled, expect the enablement acknowledgement once, at the next **Save Defaults**; with audit forwarding off, also the audit-log integrity acknowledgement, unless build 386's version 2 was already answered.

### :material-circle-box:{ .taiconcolor } The audit-log integrity acknowledgement names the audit index correctly (build 386)

- **The forwarder-disabled acknowledgement is at version 2.** Its text named the audit index `ai_assistant_audit`, the index's name before it was renamed `logserv_ai_assistant_audit`; it now reads *the AI Assistant audit index (logserv_ai_assistant_audit, or the index set in Settings)*, so it stays correct where an admin named another index. Because the wording changed, its version rose from 1 to 2: on a deployment that runs with audit forwarding off, the next admin who saves the AI Assistant's General settings (**Save Defaults**) is asked once to acknowledge the corrected text. With forwarding on nothing changes, and the AI Assistant enablement acknowledgement is unchanged.
- **A build-time test pins each acknowledgement text to its version.** The SHA-256 of each text (the value its audit event records as `disclaimerHash`) must match the latest entry of that text's revision history in the test, whose version must equal the `optInVersion` in `ai_assistant_acks.conf`, so a changed wording fails the build until it is recorded there as a new revision.
- **Documentation.** The add-ons' urllib3 1.26.20 and the seven advisories scanners report against it are analysed in [Third-Party Software Licenses](third-party-licenses.md#known-advisories-urllib3-12620): none affects the add-ons as shipped. The [AI Assistant Settings](../ai-assistant/settings.md) page of this documentation now says an acknowledgement is recorded once per deployment.
- Comment fixes (the old index name in four source comments, *Count / hr* in two `collections.conf` comments, one audit-writer comment) and more build-time tests of the Data Doctor report's author marker (it is added once, and an empty or unknown author reads *an unknown user*).

**After upgrading:** nothing to rebuild. With audit forwarding off, expect the acknowledgement once, at the next **Save Defaults** in the AI Assistant's General settings.

### :material-circle-box:{ .taiconcolor } The audit warning names both capabilities Splunk accepts, and a re-downloaded Data Doctor report marks its author everywhere (build 385)

- **The AI Assistant's audit warning names both capabilities.** Splunk accepts the browser's audit writes (`receivers/simple`) from a user who holds `edit_tcp` **or** `edit_log_alert_event`, and Splunk's default `power` role holds `edit_log_alert_event`, so power users have been audited all along; only users whose sole role is `user` are refused. The warning (HTTP 403, or HTTP 401 after a reload) now names `edit_log_alert_event`, the narrower one to grant, and `edit_tcp`, and says Splunk's default user role has neither; it no longer says power users lack them. See [Audit Log](../ai-assistant/audit-log.md#who-can-write-audit-events).
- **A re-downloaded Data Doctor report marks its author everywhere.** Build 384 marked the name on the cover page only; the environment-fingerprint section's *Generated by*, the machine-readable appendix and the JSON copy now show *`<name>` (name not verified)* too.
- **The ingest-cutoff sentence gives the date first.** The Data Doctor now says a range *ends before the ingest cutoff of `<date>` (recorded as supplied by `<name>` (name not verified))*, so the date no longer reads as the time the cutoff was supplied.
- **The Dashboard Data upgrade note names every panel a Backfill without the Clear inflates.** Activity by SID / Instance on Work Process Performance counts the upgraded hours twice as well, and its WP Categories column counts each renamed component twice.
- Comment and description fixes in `ai_assistant_acks.conf`, `collections.conf`, `default.meta` and `savedsearches.conf` (the topology detail search's description names the node's *Count / hr* chart).

**After upgrading:** nothing to rebuild.

### :material-circle-box:{ .taiconcolor } Dashboard data writable by admins only, writer searches run as the requesting user, and two Data Doctor fixes (build 384)

The App's KV Store collections that hold dashboard data - the 24 rollups, the five Environment Topology collections and the Data Doctor's platform snapshot - were writable by every role, so any signed-in user could alter or delete what the dashboards show through Splunk's REST API. They are now writable by the **admin**, **sc_admin** and **sc_subadmin** roles only; every role can still read them. Their scheduled searches run as Splunk's system user and the Settings → Dashboard Data backfill as the signed-in admin, so neither changes. Six collections stay writable by every role because ordinary users write them by design: the four per-user preferences (topology layouts, the default layout, the active layout mode, the dashboard refresh interval) and the Data Doctor's saved reports and supplied ingest configuration.

- **Saved searches that write run as the requesting user.** The 91 saved searches that write with `outputlookup` (the aggregate, backfill and retention searches of the rollups and topology collections, the Data Doctor's platform-snapshot and report-retention searches, and the two ES feeds) now set `dispatchAs = user`. A user who starts one through Splunk's REST API (`saved/searches/<name>/dispatch`) runs it with their own permissions, so a non-admin can no longer run a retention or a backfill that overwrites dashboard data. Their schedules run as before.
- **A stored refresh interval must be one the picker offers.** The refresh-interval collection is writable by every role, so another user could store a one-second interval in your row and make every panel re-run each second; a stored value other than Never, 30s, 1m, 5m, 15m, 30m or 1hr is now ignored.
- **The Data Doctor says a supplier name is not verified.** The name on a saved report and on a supplied ingest configuration is the one the browser sent, so the Data Doctor now shows it as *(name not verified)*: the saved reports' column reads *By (not verified)*, and a re-downloaded saved report marks the name on its cover page (its environment-fingerprint section, appendix and JSON copy still show the name as stored). The page's note on saved reports no longer says every App collection is writable by every user. The platform snapshot's provenance line now reads *recorded by the hourly platform snapshot, a collection only Splunk administrators can write*.

**After upgrading:** nothing to rebuild. A `metadata/local.meta` stanza for one of these collections keeps its own ACL; remove it to take the new one. A scheduled search of your own that writes into one of these collections and is owned by a non-admin user stops writing.

### :material-circle-box:{ .taiconcolor } AI Assistant settings writable by admins only, a warning when audit events are not written, and SAP's names for the trace components (build 383)

After upgrading, rebuild one row in **Settings → Dashboard Data**, **Work Process Performance / ABAP Operations**, because the trace-component names it stores have changed: **Clear** then **Backfill** it, or use the narrower repair at the end of this entry, which keeps the row's older history. The page shows an upgrade note that names the row; see *After upgrading* below and [Upgrading](../getting-started/upgrading.md).

**AI Assistant security**

- **Only admins can change the AI Assistant's settings.** Its settings, its legal acknowledgements and its discovered-model cache live in three KV Store collections (`logserv_ai_assistant_settings`, `logserv_ai_assistant_acks`, `logserv_ai_models`) that every role could write. A signed-in user without admin rights could therefore change, through Splunk's REST API, where an admin's browser sends the audit forwarder's HEC token (the forwarder URL) and the MCP bearer token (the MCP server URL), or the privacy tier. The three collections are now writable by the **admin**, **sc_admin** and **sc_subadmin** roles only; every role can still read them. The writes other users' pages used to make there (a one-time move of conf-file values at page load, the model list's refresh) were best-effort; they are now refused, quietly, and an admin's page makes them.

**AI Assistant audit log**

- **A warning when audit events are not written.** The browser writes the AI Assistant's audit events to `logserv_ai_assistant_audit` through Splunk's `receivers/simple` endpoint, as the signed-in user, and that needs the `edit_tcp` or the `edit_log_alert_event` capability, which Splunk Enterprise's default `admin` and `power` roles hold and `user` does not (this entry first said `admin` only). A refused write used to be dropped with a line in the browser console, so the activity of users without either capability went unaudited without a sign. While writes fail, the chat panel now shows an amber warning - on HTTP 403 it names `edit_tcp`; on HTTP 401, which usually means the Splunk Web session has ended, it asks for a reload first - and the session's audit list notes from when its events may be missing from the index. Which capability to grant, and what each allows, is in [Audit Log](../ai-assistant/audit-log.md#who-can-write-audit-events).
- **The batch still buffered when a tab closes is sent.** It went out as a browser beacon, which cannot carry Splunk Web's CSRF header and was refused for every user; it is now a keep-alive request with the header, carrying the newest events that fit in 60 KB. Like every audit write, it still needs `edit_tcp` or `edit_log_alert_event`.
- **The audit index default is `logserv_ai_assistant_audit`** in the App's configuration fallbacks and the Audit Log viewer, which still named the retired `ai_assistant_audit`. The legal text of the forwarder acknowledgement still names it (corrected in build 386, as version 2); changing that text would ask an admin to accept it again (it is accepted once per deployment, not per admin).

**SAP's names for the work process trace components**

- The letter that starts each work process trace (`dev_w*`) line names SAP's trace component, and ten of the App's names change. Seven were wrong: **C** is the database-specific layer (`C = Database (DBSL)`, not Communication), **X** extended memory (not RFC / CPIC), **M** the task handler (not memory management), **S** spool (not SQL / statistics), **T** the debug system (not the task handler), **D** the Diag processor (not the dispatcher), and **N** security - SNC, SSF, logon tickets (not the network interface); **R** reads `R = Rolling` and **O** is below. **E** (enqueue), **G** (language support), **H** (ICF / HTTP), **I** (IPC), **J** (VM container), **L** (background), **P** (paging) and **W** (WebGUI / ITS) get names, **O** and **V**, which SAP's public lists do not name, are named from their lines (program buffer / PXA, coverage analyzer), and **Q**, which is not a trace component, reads `Q = Other`. The names come from SAP Help's "Trace Components" list and SAP Note 112. They appear in `wp_category_name` and in the Work Process Performance, ABAP Operations and Host Details panels; searches, alerts or dashboards of your own that filter on the old `wp_category_name` values need the new ones.

**Environment Topology**

- **The partner donuts and the hourly chart say what they count.** A system's "Partners calling this system" and "Partners this system calls" donuts name their unit from that side's edge types - calls, connections (RFC and SAP Router edges count connections), or calls + connections, with "total" under a mixed donut's centre - and the node's hourly chart reads **Count / hr**, as the Live Activity chart does.

**AI Assistant**

- **The sourcetype reference names fields that exist.** The `logserv_sourcetype_metadata_lookup` the AI Assistant can read listed, for 30 of its 35 sourcetypes, fields the sourcetype does not have (`sap_inst`, `severity` and `msg` on the ABAP sourcetypes, for example), and 17 of its example searches returned nothing. Every row now names fields that the App, the Data TA or - for the Windows and Linux rows - Splunk's Windows and *nix add-ons produce, and an example search that runs; the four Windows rows use the real sourcetype, `XmlWinEventLog`, and name their channel in `source`.

**After upgrading** (from build 379): in **Settings → Dashboard Data**, note the **History** of **Work Process Performance / ABAP Operations**, click **Clear**, then its own **Backfill** over a window that covers that history (the 365-day preset reaches as far as the rollup keeps it). Without the Clear, rows stored under the old names stay beside the new ones, and the Work Process Performance totals, function, category and Activity by SID / Instance panels and the ABAP Operations category pie count those hours twice (the WP Categories column counts each renamed component twice). Keep the backfill clear of 00:34–00:58, 01:30–01:58 and 02:34–02:36 search-head time. Coming from build 378 or earlier, run the build-379 backfills below too.

**A narrower repair that keeps older history.** The **Clear** removes everything the row holds - the dispatcher, ICM and ABAP Operations panels' history too, although their stored values did not change - and a Backfill brings back only what your index still holds raw events for. To keep the older history, after the upgrade delete only the trace-component rows (`metric` `wp`) from *W* onward, where *W* is the first UTC day whose raw events your index still holds in full (as in the build-378 entry's narrower repair, epoch seconds of that UTC midnight), with one REST call on the search head's management port and an admin account, clear of the nightly retention window (the same call with `-X GET` in place of `-X DELETE` returns the rows it would delete - at most 50,000 by default, so it shows what the query matches, not how many; check that first, since a DELETE without its query empties the whole collection):

```
curl -k -u admin -G -X DELETE   "https://<search-head>:8089/servicesNS/nobody/splunk_app_sap_logserv/storage/collections/data/logserv_wp_perf_rollup"   --data-urlencode 'query={"metric":"wp","bucket_ts":{"$gte":<W>}}'
```

Then **Backfill** the row with its own **Backfill** over a custom range from *W* to today. The Backfill rewrites the row's other rows in that range under the keys they already have, so nothing is counted twice; trace-component rows older than *W* keep their old names. If you cannot reach the management port (on Splunk Cloud it must first be opened for you), use the **Clear** instead.

### :material-circle-box:{ .taiconcolor } Host Details shows the work processes' trace components, and the topology inventory takes each host's most recent SID (build 379)

This build changes no key a rollup stores. After upgrading, click **Backfill**, without Clear, on two rows in **Settings → Dashboard Data**; see *After upgrading* at the end of this entry and [Upgrading](../getting-started/upgrading.md).

**Host Details**

- **ABAP Work Process Trace Components** replaces *ABAP Work Process Mix*. The old panel grouped the work process trace (`dev_w*`) by a work process type the logs do not record, so it never showed. The new one counts the lines by their trace component: the letter each line starts with, named the way `wp_category_name` names it (for example `B = Database Interface`; a letter without a name shows as `<letter> = Other`).

**Environment Topology**

- **A host or address seen under two SAP systems takes its most recent one.** The host-to-SID inventory recorded an endpoint only in an hour whose log lines all named one SID, and a row once written stayed, so an endpoint whose lines named two systems kept the SID of its last single-system hour, possibly a stale one, and one that had never had such an hour had no row. It now records each endpoint under the SID of its newest hour of activity; when that hour names two, the one with more events; an exact tie writes nothing and keeps the previous row. Endpoints left unattributed before can now fold into a system's node, and an address that serves two systems at once is drawn under the one that logs more.
- The totals that add up different edge types say so: **Total calls + connections**, **Inbound calls + connections** and **Outbound calls + connections** (RFC and SAP Router edges count connections, not calls), and the Live Activity table's column reads **Count**.

**Smaller changes**

- The AI Assistant's data-model hint names the fields the ABAP sourcetypes extract (`sap_instance`, the dispatcher's `dp_severity`, `dp_function` and `dp_reason`, the work process's `wp_function`, the enqueue server's `enq_function`) instead of `sap_inst`, `severity`, `message` and `error_code`, which none of them extracts; `sap:saphostexec` and `sap:sapstartsrv` get a line of their own.
- The upgrade hint on **Settings → Dashboard Data** no longer speaks of a 30-day backfill window: a Clear discards graph history older than the window you backfill, so pick one that covers it.
- The documentation explains how to keep the AI Assistant's audit index to its reviewers: Splunk's default `user` role can search every index whose name does not start with `_`, the audit index among them ([Audit Log](../ai-assistant/audit-log.md#restricting-who-can-read-the-audit-index)).

**After upgrading** (from build 378): in **Settings → Dashboard Data**, click the row's own **Backfill**, without Clear, on **Host Role Activity (Host Details)**, so the trace component panel shows history (the 365-day preset fills all of it), and on **Environment Topology (graph)**, whose inventory always reads the last 30 days whatever window you choose. Use each row's own button: **Run backfill** skips rows it considers complete. Coming from build 377 or earlier, the build-378 Clear + Backfill below covers both rows when you run it on this build. Keep the backfills clear of 00:34–00:58, 01:30–01:58 and 02:34–02:36 search-head time.

### :material-circle-box:{ .taiconcolor } SAP Router and RFC connections in the topology, the HANA audit host, HANA trace lines read by their format, and the SAP client in the ICM trace — rebuild eleven rollups once (build 378)

This build changes values that several rollups store, most of them in the keys the rows are stored under. Rows written before the upgrade keep the old values, so after upgrading eleven rows in **Settings → Dashboard Data** need one **Clear** and **Backfill**; see *After upgrading* at the end of this entry and [Upgrading](../getting-started/upgrading.md).

**Environment Topology**

- **SAP Router is a new integration type.** Each router's `CONNECT TO` lines become an edge from the router host — drawn as its own square, tagged *SAP ROUTER*, and never folded into an SAP system even when the same VM runs one — to the address it routed to, with the number of routed connections. A target named `<ip>/sapms<SID>` is that system's message server, so its address is attributed to the SID and the edge ends on the system's circle; targets reached by port or `sapgw<NN>` stay addresses until another source attributes them. The router's failed server-side connections that name a target IPv4 address (`NiBufReceive S… '<IPv4>' failed`) count as the edge's failed connections; client-side failures and failures that name a host are not counted. Loopback targets (127.0.0.0/8, such as a router's port-3298 niping self-test) are left out. The edges have their own legend colour and filter checkbox, and the Edge Details pane shows routed and failed connections, the top target services (Operations, counted in routed connections) and the target role mix (Performance). New search-time fields on `sap:saprouter`: `saprouter_target_addr`, `saprouter_target_ip`, `saprouter_target_service`, `saprouter_target_sid`, `saprouter_target_role` (message server, gateway, gateway (secure), dispatcher, SAP Router, niping, other service), `saprouter_target_instance` and `saprouter_fail_target_ip`; ports 3298 (niping) and 3299 (SAP Router) carry no instance number. See [SAP Router](../logserv-app/dashboards/integration/sap-router.md).
- **RFC edges count connections, in the direction they were made.** The SAP gateway trace (`dev_rd`) records connections and their failures, not individual RFC calls. An RFC edge now counts the connections it saw: closed connections to remote gateways (outbound), closed client sessions (inbound) and broken connections, each broken connection once (before, each of its up to three trace lines counted as a call; two broken connections to the same remote gateway count as two). Errors are the broken connections, so an edge never shows more errors than connections, and the Edge Details pane says *connections* and *broken connections* where it said calls and errors. A connection made to a system's gateway is now drawn from the caller to the system; until now every RFC edge pointed away from it. Clients and peers on a loopback address (127.0.0.0/8) are left out, so systems that each log a local client on 127.0.0.1 are not joined through one shared address node. Remote gateway hosts are named by the last hop of an SAP Router route and their short host name. The Operations tab of an RFC edge lists the remote gateway services and client programs, and the Performance tab the mix of connection records — both were empty for RFC edges before. The *By app server* table names the address of the gateway that recorded each connection; connection records name no local address and are grouped as *(not recorded)*. New fields on `sap:abap:gateway`: `gw_remgw_target`, `gw_remgw_service`, `gw_remgw_id`, `gw_client_ip`, `gw_client_hostname`, `gw_client_tp`, `gw_client_id`, `rfc_peer_port` and `rfc_local_port`.
- **Saved layouts keep new types switched on.** A layout records the integration types that were ticked, so a type added after it was saved used to load unticked. Layouts saved earlier now load with SAP Router enabled; layouts saved from now on also record which types existed, so a type you switch off stays off.
- The health ring and the Edge Details error rate never exceed 100 %, and an edge whose only records in the window are failures counts as fully failed. HANA Tenant duration figures say that each hdbcons command's duration is converted to milliseconds from the unit its trace line records.
- **HANA audit edges end on the HANA host** that wrote each record (see *HANA* below), and node errors no longer list ICM sessions as HTTP errors (see *ICM* below).
- **Web Dispatcher events count toward their system.** Web Dispatcher requests now also count toward their host's node and toward the Hosts and Errors tabs of the system their log path names (a system's Errors tab may now list Web Dispatcher HTTP 4xx / 5xx kinds; the tab shows the top 20). A Web Dispatcher's own logs no longer attribute a host or an address to a system in the topology inventory: neither its access log nor its ICM trace (`dev_icm`), which LogServ files under `webdispatcher/icm` and the Data TA types `sap:abap:icm`, like an ABAP system's ICM trace, so it carries the Web Dispatcher's SID. A Web Dispatcher with its own SID on a host shared with another system therefore does not take that host, or the address its ICM listens on, over, and a host that runs only a Web Dispatcher stays a host square until another source names its system.
- **The Environment Topology (graph) backfill now adds up node counts across all of its searches.** Settings › Dashboard Data rebuilds every rollup by running each of its component searches as its own job, so that no search is cut short at high event volumes. Two of the Environment Topology graph's collections, however, combine those searches' results: a node seen by several log sources (an IP address that is both a gateway address and an ICM address, or a Web Dispatcher client that also connects to the gateway) is one node whose event count is the sum of all of them, and an IP address or host is attributed to an SAP system only when every source names the same system. Until now each search wrote its own partial count to the same node row, so backfilled node counts were too low, and an address that two sources attribute to two different systems could be mapped to one of them. The backfill now collects those searches' results in a scratch KV Store collection, `logserv_backfill_stage`, and writes each month's node rows, and the inventory, only once every search for that month has finished and every result it collected reads back in full, so the rows match what the hourly aggregation writes. Keep the Settings page open until the Environment Topology (graph) row has finished. A month left unfinished, or one whose collected results do not all read back (as can happen while KV Store is still starting after a restart), is discarded rather than written in part: the row reads **failed — re-run**, and the next backfill rebuilds that month. Rows written by the hourly aggregation were always correct; history that an earlier backfill rebuilt for this row is repaired by the **Clear** and **Backfill** this upgrade asks for. See [Dashboard Performance & Data Freshness](../logserv-app/dashboards/performance.md).

**HANA**

- **HANA audit events name the HANA host; the client gets its own field.** Each HANA audit record names two machines: the HANA host that wrote it and the client that ran the action. Until this build the App put the client's host name into `host`, so every panel and search that grouped HANA audit events by host listed client workstations and application servers, and the Host Details drilldown could open a host with no events of its own. `host` on `sap:hana:audit` is now the HANA host, the value the index stores for the event (as every `tstats` search already saw it), and the client's host name is the new field `src_host`, beside `src_ip` (the client IP) and `dest_host`. On [HANA Audit](../logserv-app/dashboards/applications/hana-audit.md), *Failed Operations by Host* is now **Failed Operations by HANA Host**, and the High-Risk Events and After-Hours / Weekend Admin Activity tables show a **HANA Host** and a **Client Host** column; on [Change & Configuration Activity](../logserv-app/dashboards/security/change-config.md), the HANA change table's single *Host* column, which showed the client, becomes **HANA Host** and **Client Host**. Your own saved searches that group `sap:hana:audit` events `by host` now group by HANA host; use `src_host` where you meant the client. HANA audit records with no client (for example a GRANT PRIVILEGE or DDL statement; about 2 % of the records on the reference data) now parse fully, so they gain their action, category, severity and SID.
- **HANA trace lines are read by their own format.** Standard trace lines take their level, component, source file and line only from the start of the line, so text further along can no longer pass for a level or a component. `backup.log` lines now carry their own level and component (for example INFO and `LOGBCKUP`) instead of UNKNOWN and fragments such as `of` or `service:`, so a failed backup logged at ERROR now appears in **Errors / Fatal** and in the error table. Record files — `hdbcons` command timings, SQL trace, load traces and system availability — carry no severity: [HANA Trace](../logserv-app/dashboards/applications/hana-trace.md)'s *Trace Events by Severity* and *Component by Severity* leave them out, as the first chart's subtitle now says; Total Trace Events, Trace Volume Over Time and Activity by SID / Instance still count them. `hdbcons` commands timed in microseconds or seconds are converted to milliseconds (`hana_op_duration_ms`; the unit the line recorded is `hana_op_duration_unit`); before, only millisecond-timed commands had a duration, so **Slowest hdbcons Commands** and **hdbcons Command Duration (Avg / Max)** missed every microsecond-timed command, and their averages fall after the upgrade. A slow `hdbcons` command still counts as a warning on its HANA Tenant edge. New fields: `hana_trace_file_type` (the kind of file each event comes from), `hana_backup_level`, `hana_op`, `hana_op_duration` and `hana_op_duration_unit`.

**ICM and Web Dispatcher**

- **ICM: the SAP client is no longer read as an HTTP status.** In the ICM trace (`dev_icm`), a session-list line such as `ASYNC_RFC T229_U23835_M0, 200, BATCH_ALM, , time=10:35:59, ...` names the request type, the session, the SAP client, the user and the terminal. Earlier builds read the client as an HTTP status (`icm_status_code`, aliased to the CIM `status` and `action`): a session in client 400 to 599 counted as an ICM error on ABAP Network & Security and Environment Health, and the ICM status panels showed SAP clients as 2xx–5xx classes. `dev_icm` records no HTTP status. Now the client is `sap_client`, the session's user `icm_user` and its terminal `icm_terminal`; `icm_status_code` is gone and ICM events carry no `status` or `action`. An ICM error is a message the ICM logged as `*** ERROR =>` (`icm_severity` ERROR, `icm_is_error="true"`); warnings are `icm_severity` WARNING. On ICM connection lines, `src` and `dest` follow the connection's direction (`icm_conn_role`): the side that opened the connection is `src`. Your own searches that read `icm_status_code`, or `status` / `action` on `sap:abap:icm`, need updating.
- [ABAP Network & Security](../logserv-app/dashboards/applications/abap-security.md) shows **ICM Warnings & Errors Over Time** and **ICM Session Entries by SAP System and Client** in place of the two status panels. A client number belongs to its system, so the pie shows SID and client together (for example `XCP / 200`). Its **ICM Peer Connections** table counts connections in both directions; the Transactions column, always empty, is gone. [Environment Health](../logserv-app/dashboards/environment-health.md) shows **ICM Warnings & Errors** in place of ICM Status Codes.
- **Web Dispatcher events carry their SAP system ID and instance.** `sap:webdispatcher:access` events now get `sap_sid` and `sap_instance` from the log's path (`/usr/sap/<SID>/<instance>/log/http_access_log`), as the ABAP sourcetypes do: a Web Dispatcher installed under its own SID gives that SID (for example `WDP` / `W00`), and one embedded in an ABAP instance gives the ABAP system's SID. A path with no `/usr/sap/<SID>/` directory (three upper-case letters or digits) gives no `sap_sid`, and one with no instance directory (such as `W00`) right below `/usr/sap/<dir>/` gives no `sap_instance`. See [Web Dispatcher](../logserv-app/dashboards/integration/web-dispatcher.md).

**Enterprise Security**

- The risk object `host` of the five HANA correlation searches is now the HANA host, not the client machine, so their risk moves from client hosts to the HANA hosts. The failed-CONNECT spike and after-hours admin searches list the client hosts in a new `src_hosts` field.
- **The topology edge anomaly search returns its anomalies.** It compared each edge's hourly volume with a baseline grouped by fields the edge rows never had, so it never returned a row. It now baselines each stored edge (`by id, type`) and names the edge by its `source` and `target`, read from the edge's stored filter clauses, so the notable title, its suppression fields and the risk object identify the edge.
- `sap:abap:icm` leaves the Web data model (the `sap_abap_icm_request` eventtype is removed); its events had carried the SAP client as `status`. If the Web data model is accelerated, ICM events summarized before the upgrade stay in its summaries until they age out of the summary range or the acceleration is rebuilt. See [Correlation Searches](../enterprise-security/correlation-searches.md).

**AI Assistant**

- The assistant's data model for free-form questions knows the fields this build adds. On HANA audit events, `host` is the HANA host that wrote the record and the client's host name is `src_host`. HANA trace events carry `hana_trace_file_type`, the hdbcons command `hana_op` and the unit it was logged in (`hana_op_duration_unit`; `hana_op_duration_ms` is always in milliseconds), and the record files carry no severity. SAP Router `CONNECT TO` lines carry their target (`saprouter_target_ip`, `saprouter_target_sid`, `saprouter_target_service`, `saprouter_target_role`), and the gateway's connection records carry `gw_remgw_target`, `gw_client_hostname` and `gw_client_ip`. The ICM trace has its own entry (`sap_client`, `icm_user`, `icm_severity`, `icm_conn_role` and the ICM addresses and program; no HTTP status), and Web Dispatcher events name `sap_sid` and `sap_instance`. Environment Topology edges include the `saprouter` type, and RFC edges count connections, not calls, with one row per edge, hour and application server IP (`local_ip`). The assistant's SAP Router field list no longer names two fields that do not exist, and the saved-search tool's example now names a search from the catalog. The catalog prompts on ICM peers, volume and request types describe what they count (connections, log lines, session-list entries); their searches are unchanged, and the sourcetype metadata the assistant follows names the ICM fields and no longer suggests `status>=400` for ICM.
- In Tier 2 the new address fields — `src_host`, the SAP Router target addresses, `gw_remgw_target` and `gw_client_ip` — are redacted by default. The client host names `audit_hostname` (HANA audit, aliased as `src_host`) and `gw_client_hostname` (the RFC client) are now treated as addresses, because a workstation's name can identify the person who uses it, so Tier 2 redacts them by default rather than only with the hostname opt-in; `db_hostname`, the database server, still follows the opt-in, and so does the `hostnames` column of the topology IP-enrichment lookup, which also holds client workstation names. Every new field has a class in the table the build checks. The Settings backfill's scratch collection, `logserv_backfill_stage`, is not readable by the assistant's queries.
- Free-form queries: Splunk's search parser now also confirms the lookup of every `lookup` and `inputlookup` that is not inside a subsearch. The App reads the lookup name again from the parser's reply and refuses the query (`parser_mismatch`, with `command` = `lookup` or `inputlookup`) when it is not one of the App's lookups, or when the reply cannot be read that way. Every catalog search passes this check. Splunk's parser reports a subsearch as text inside the command that holds it, so the commands and lookups inside a subsearch are checked by the App's own reading of the query; the security documentation now says so.

**Data TA (not changed by this build)**

- The Data TA's AWS S3 Direct screen does not yet list the `sap/saprouter` folder under the two Environment Topology rows. When you backfill SAP Router history from S3 for the topology, also select the **SAP Router** row, whose folders include it.

After upgrading:

- **Rebuild eleven rows once, after the upgrade.** For each row below, open **Settings → Dashboard Data**, note its **History**, click **Clear**, then **Backfill** it with a window that covers that whole history — the 365-day preset or a custom range, not the default 30 days — using the row's own **Backfill**: HANA Audit, HANA Trace, Environment Health, ABAP Network & Security, Host Role Activity (Host Details), Environment Topology (graph), Environment Topology (detail tabs), Multi-Cloud Overview, Data Pipeline Overview, Host Details and Sourcetype Mapping (Host Details / Data Pipeline). A **Backfill** without the **Clear** counts the upgraded hours twice: Environment Health sums its error counts across hosts, the RFC edges would be drawn twice (once reversed), the HANA audit edges and the four all-sourcetype rows would keep the client host names as hosts, and so would every later Backfill over earlier days, **Backfill N days** for late-arriving data included. On ABAP Network & Security alone a Backfill without the Clear keeps the old ICM error counts instead of counting hours twice; where `| inputlookup logserv_abapnet_rollup where metric="icmerr" | stats count` returns 0, your ICM error counts were never affected and a **Backfill** alone fills the two new ICM panels and keeps older history.
- Then click **Backfill**, without **Clear**, on **Change & Configuration Activity** and **Cross-Stack Authentication**: they gain the HANA audit records that have no client fields, under keys that do not change.
- Do the rebuild after the upgrade (a Clear before it is undone by the old build's last hourly runs) and clear of the nightly retention window, 00:34–00:58, 01:30–01:58 and 02:34–02:36 search-head time. Keep the Settings page open until the Environment Topology (graph) row has finished. SAP Router edges have no history until the Environment Topology rows are backfilled.
- The **Clear** removes everything a row holds, including history older than the raw events still in your index, which no Backfill can bring back. Installs that must keep that older history can use the narrower repair below instead.
- A `search` override in `local/savedsearches.conf` for a rollup aggregation or backfill search keeps the old search after the upgrade: compare it with the shipped one, or remove it.
- If the Web data model is accelerated, rebuild it if ICM events must leave its summaries before they age out.

**A narrower repair that keeps older history.** The **Clear** removes everything a row holds, including history older than the raw events your index still holds, which no Backfill can bring back. To keep that older history, delete only the rows inside the window you will backfill, and leave the older rows as they are.

*Pick the window.* Its first day, *W*, is the first UTC day whose raw events your index still holds in full (`` | tstats min(_time) as first where `sap_logserv_idx_macro` `` shows the oldest event), and no earlier than 365 days ago, the furthest a Backfill reaches. Rows older than *W* keep their old values, and no raw event is left that a later Backfill could count beside them.

*Delete the rows from W onward.* After the upgrade, and clear of the nightly retention window, delete from each collection in the table the rows whose `bucket_ts` is at or after *W* (UTC midnight, in epoch seconds): one REST call per collection on the search head's management port, with an admin account. If you cannot reach the management port (on Splunk Cloud it must first be opened for you), use the **Clear** instead.

```
curl -k -u admin -G -X DELETE   "https://<search-head>:8089/servicesNS/nobody/splunk_app_sap_logserv/storage/collections/data/logserv_hana_category_rollup"   --data-urlencode 'query={"bucket_ts":{"$gte":1767225600}}'
```

| Row | Collections |
|---|---|
| HANA Audit | `logserv_hana_category_rollup` |
| HANA Trace | `logserv_hana_trace_rollup` |
| Environment Health | `logserv_severity_rollup` |
| ABAP Network & Security | `logserv_abapnet_rollup` |
| Host Role Activity (Host Details) | `logserv_hostrole_rollup` |
| Environment Topology (graph) | `logserv_topology_nodes` and `logserv_topology_edges`; and all of `logserv_topology_inventory` (the call without `query`), which has no time field and holds only the current mapping of addresses and hosts to systems: the Backfill rebuilds it from the last 30 days, as after a Clear |
| Environment Topology (detail tabs) | `logserv_topology_detail_rollup` |
| Multi-Cloud Overview | `logserv_mc_rollup` |
| Data Pipeline Overview | `logserv_pipeline_rollup` |
| Host Details | `logserv_hostdetails_rollup` |
| Sourcetype Mapping (Host Details / Data Pipeline) | `logserv_stmap_rollup` |

*Then backfill.* Do every delete before any Backfill. Then **Backfill** each of the eleven rows with its own **Backfill**, over a custom range from *W* to today, and **Backfill** Change & Configuration Activity and Cross-Stack Authentication without Clear. Keep the Settings page open until the Environment Topology (graph) row has finished.

### :material-circle-box:{ .taiconcolor } Free-form AI queries run from an allow-list, the Tier 2 gaps close, time charts name their bucket, and loopback HANA clients stay off the topology (build 377)

**AI Assistant**

- **Free-form queries now run only from an allow-list, and Splunk's own parser checks each one.** Until now the AI Assistant refused a list of known risky commands in the queries the model writes (`splunk_run_query`) and passed every other command. A query now also has to pass an allow-list: only 47 read-only analytic commands (`search`, `where`, `eval`, `stats`, `tstats`, `timechart`, `lookup`, `inputlookup`, `append`, `join`, `appendpipe` and the rest — the model's primer lists them exactly), only the LogServ index (the query and every subsearch arm start with `` `sap_logserv_idx_macro` ``, an App lookup, `tstats … WHERE` the macro or `makeresults`; no `index` term; no `OR` or `NOT` next to the macro), only the App's own lookups, and subsearches only where they cannot widen the search. Custom commands and lookups of other installed apps, `fit` / `apply`, `datamodel`, `foreach`, `map`, `mvexpand`, `fieldformat`, `rangemap`, `return` and `format` are refused, and so is `union`: Splunk's search parser rewrites a union before it runs (into `append`, or `multisearch` when every part streams), so the App cannot check it — to combine two searches the model writes `append`, and the refusal of a `union` says so. The App then has Splunk's search parser read the query (parse only; nothing runs) and refuses it when the parser reads it differently — another command, an index macro at the start of the query that the user's context redefines, another index — or when the parser cannot be asked: free-form queries fail closed. Single quotes may only enclose field names; a search term with an apostrophe goes in double quotes (`"don't"`). A refusal names the command or lookup, so the model can rewrite the query, and the `security_blocked_spl` audit event gains new `operator` values and a `command` field, shown in the Audit Log viewer and the session audit panel. The App's catalog searches and their next-step searches all pass unchanged. See [Free-form Prompts](../ai-assistant/free-form-prompts.md) and [Audit Log](../ai-assistant/audit-log.md).
- **The Tier 2 gaps listed under build 376 are closed.** With PII redaction on: the `Time range:` line is sent only when the query takes `_time` from `_time` or the App's rollup epochs (`bucket_ts`, `day_ts`), not when it computes it from other fields; a stray apostrophe can no longer hide commands from the App's reading of the query; `rex` groups written `(?'name'…)` are read, `fieldformat` no longer counts as a plain copy, a lookup output keyed on an identifier is redacted like the identifier (the curated category, source and date of the App's threat-intel lookups stay readable; their notes are redacted), and the first command inside `appendpipe` is always read as a command; the words of a `rex` pattern, an `spath` path or an `eval` string count when the App decides whether a number is an identifier's, and a distinct count of a computed field is no longer treated as a plain count. Every field the App defines now has its own class, checked by the build, and the name patterns also cover every `*_ip`, `*_addr` and `*_address`, a bare `ip`, `user_name`, `peer`, `dst` and names with spaces — so `peer_ip`, `icm_peer_ip`, `local_ip`, `object`, `identity`, `sql_statement`, `command` and the lastlog `FROM` are now redacted (two catalog searches, the ICM top peer IPs and the RFC partner failures, now send their peer IPs as tags). `top 10 uri` is read like `top limit=10 uri`, and many stacked wildcard renames no longer freeze the browser tab. What remains is listed in [Privacy Tiers](../ai-assistant/privacy-tiers.md#known-gaps-in-build-376); where no event value may reach the vendor, use Tier 1.
- **A closer reading of free-form queries.** Three more forms are refused, because Splunk can read them differently from the App: a backslash outside double quotes (`escaped_outside_quotes`); the data macro written against other text, such as `` `sap_logserv_idx_macro`* `` or ``where`sap_logserv_idx_macro` `` (`macro_position`); and a quoted option value before a lookup name, or a quote glued to the name (`lookup_not_allowed`). With PII redaction on, Tier 2 now also reads `makemv` like `rex`, so the pieces it cuts from an event are redacted; withholds the time range when `bin` or `bucket` writes another field `AS _time`; reads stacked `appendpipe` groups in linear time, so a long query no longer freezes the tab; redacts the rollup columns `operator`, `scope`, `error_detail` and `spl_filter_clauses`, which were sent in clear; treats `rhost`, `ruser`, `logname`, `euid`, `PWD`, `COMMAND`, `IpAddress`, `TargetUserSid`, `WorkstationName`, *Host Name* and *Account Name* as identifiers; and withholds the numeric statistics of the `IpAddress` column in the Windows account-lockouts next-step search.
- **Redaction tags can no longer be reversed.** A `<redacted-…>` tag is now a keyed hash (HMAC-SHA-256) under a random key the browser makes for each chat session and keeps in memory only. A value keeps one tag within a chat session, so the model can still count and compare, but tags of different sessions cannot be linked and nobody without the key can recover a value by hashing candidates — IPv4 addresses, short user names or SAP's standard users. The raw-event samples of a Data Doctor report are redacted the same way, with one key per report. The tags look as before.
- **Claude 5.x models are priced, so their spend counts toward the daily cap.** The cost estimate in each `vendor_tier1` audit event now covers `claude-opus-5-5`, `claude-opus-5`, `claude-sonnet-5-5`, `claude-sonnet-5`, `claude-fable-5-1`, `claude-fable-5` and `claude-haiku-5-5` at Anthropic's published first-party rates, cache reads and writes included; until now these turns read $0.0000 and did not count toward `daily_spend_cap_usd` (default 50 USD). An admin whose users run Claude 5.x heavily may now see the cap reached; raise it in Settings if needed. The `claude-sonnet-5` price was out of date and is corrected. `claude-haiku-5-5` is estimated at its rate for prompts up to 100K tokens. Bedrock prices are unchanged; a model with no listed price still reports $0.
- **HANA trace severity descriptions.** The descriptions of the *HANA trace event severity trend* and *HANA trace ERROR events with context* prompts now say what each severity means: standard trace lines carry INFO, WARNING or ERROR, and UNKNOWN counts the lines that have no trace level — continuation lines, `backup.log` entries, hdbcons command timings and the SQL trace, load and availability files — so a failed backup in `backup.log` is counted under UNKNOWN rather than ERROR. The searches themselves are unchanged.

**Dashboards**

- **Environment Health's Events/Day (Avg) is a per-day average again.** Since build 345 the card averaged the chart's time buckets instead of days: at **Last 30 days** it showed the average of 6-hour buckets, about a quarter of the true daily figure (a twenty-fourth at Last 7 days). It now counts whole days, as the Data Pipeline Overview card always has; days follow your Splunk time-zone preference, and the current partial day counts as a day. After the upgrade the figure rises accordingly; nothing needs to be rebuilt. The note under *Chart buckets follow the time range, and crowded charts stop repeating colours (builds 345, 350–354)* says the per-day-average KPI stays daily by design; for Environment Health that was not true until this build.
- **Time charts no longer call themselves daily.** Forty chart descriptions on 18 dashboards said "daily" or "per day" while the charts draw 15-minute to 1-day buckets depending on the selected range. They now describe what is counted, two titles change (**Event Volume Trend** on Environment Health and **Event Volume by Cloud Provider** on Multi-Cloud Overview), and the Environment Health trend's series and axis are named **Events**. Every time chart prints the bucket it actually draws in its subtitle, for example *Proxy request count — span 6h*. Summary-backed charts never draw buckets finer than an hour, so at **Last 24 hours** they say *span 1h* where charts counted from the index say *span 15m*. The new [Chart Time Buckets](../logserv-app/dashboards/index.md#chart-time-buckets) section lists the bucket for each range.
- **Four DNS Analytics and Web Dispatcher charts draw hourly bars from the hourly summaries.** At **Last 24 hours**, and on custom ranges from 90 minutes to 6 hours, DNS Analytics' *Clients - Request Volume* and *Requests by Record Type* and Web Dispatcher's *Traffic by Status Code* and *Response Time Trend* put each hour's total into one 15-minute (or 1-minute) bucket and left the others empty: Web Dispatcher drew spikes about four times the real rate with zeros between them, and its average response time fell to 0 in three of every four buckets. They now draw one point per hour, like every other summary-backed chart. Ranges under 90 minutes still read raw events at 1-minute resolution. DNS Analytics' two charts and the list of its client-IP filter now also follow the **Cloud** dropdown; they had shown every cloud whatever was selected.
- **Sparkline hover times follow your Splunk time zone.** Hovering a KPI sparkline showed the day's start in the browser's time zone, while the sparkline's days follow your Splunk time-zone preference, so a Central-time Splunk user on a browser set to another zone saw the wrong date and hour. The hover now shows the time in your Splunk zone. The **Beaconing Domains** sparklines on Environment Health, DNS Analytics and Network Perimeter count UTC days, because beaconing is detected per UTC day: each point now carries its UTC date and the hover shows it labelled *(UTC day)*. Before, a user west of UTC saw each day under the previous date, and Environment Health drew up to three points a day when all clouds were selected. A day's beaconing count is written once that UTC day has ended, so a UTC day that has not ended yet, drawn at 0 at the end of the DNS Analytics and Network Perimeter lines, is labelled *(UTC day, not yet computed)* instead of reading as a measured zero.
- **HANA Trace counts the components its tables show.** *Unique Components* (the KPI, its sparkline and its raw-event version under 90 minutes) now applies the same filter as the *Components* table, so the KPI equals the table's row count; it had also counted fragments of continuation lines such as `of`, `service:` and `INFO`. As in the tables, components of three characters or fewer stay hidden. *Slowest SQL Operations* is now **Slowest hdbcons Commands**, with the columns **Command** and **Runs**, and *Operation Duration (Avg / Max)* is **hdbcons Command Duration (Avg / Max)**: the rows are the HANA console (`hdbcons`) commands the trace times, such as `profiler stop` or `statreg print`, not SQL statements.

**Environment Topology**

- HANA audit connections from any loopback address (127.0.0.0/8) are now left out of the topology graph and its detail tabs. Before, only 127.0.0.1 was left out, so a client logged as another 127.x.x.x address appeared as a partner node. On the HANA audit data checked for this release every loopback client was 127.0.0.1, so the graph's counts do not change.
- The hostname and user lines on IP-labelled partner squares now ignore every loopback address (127.0.0.0/8) in all four kinds of evidence they draw on: HANA audit connections, Windows logons, the SAP start service and ssh logins. Before, only 127.0.0.1 was ignored. A loopback address names no remote machine, so such a line never identified one. Only the HANA audit evidence was checked for other loopback addresses. In the other three, a name line taken from an address such as 127.0.1.1 is no longer refreshed: like any name line whose address has gone quiet, it keeps its last values, shown with their date, until the one-year retention of the name data removes it.
- HANA tenant edges and the HANA database roll-up in the node panel now label their duration figures as hdbcons command durations instead of SQL durations: they time the HANA console (hdbcons) commands recorded in the tenant's trace files, the same timings the HANA Trace dashboard's hdbcons panels show. The roll-up's event count is now labelled Tenant trace events. The numbers themselves are unchanged.
- The node and edge rollups no longer declare three fields that no search ever filled: the two ICM task measures on edges and a node health percentage. ICM task load is on the Work Process Performance dashboard, and node health is the three-colour call ring around each node, as before. Nodes look the same: the health-based colouring of the node outline never had a value to show.

**Data Doctor**

- **HANA trace files delivered without folder fields.** SAP delivers some HANA trace files with no folder fields (`clz_dir` / `clz_subdir`), and the Data TA can route them to `sap:hana:tracelogs` by their file path. Folder filters do not reach these files, and the Data Doctor's ingest-filter verdict now takes that into account. Trace events that keep arriving despite an Exclude Filters rule on `hana/tracelogs` are no longer reported as an out-of-date filter configuration, and such a rule is no longer reported as excluding all HANA trace data. On a HANA Trace panel, an Include Filters list that keeps the `hana/tracelogs` folder but drops these files is now named, together with the Include Sources entry that keeps them (`/usr/sap/*/HDB??/*/trace/*`). The pasted configuration does not show whether SAP delivers such files to you, so this finding is listed after the panel's main verdict, for example *Never received* or *Summary not built*, and never replaces it; panels that also read other log types do not report it. A verdict these files change reads *Partly excluded?* and is never more certain than *possible*, because the pasted configuration does not show whether your forwarders route the files this way either. On a HANA Trace panel its evidence explains how each filter treats them. Verdicts that do not involve `sap:hana:tracelogs` are unchanged.

After upgrading:

- Build 377 changes no rollup key, so nothing needs a **Clear** or a rebuild in **Settings → Dashboard Data**. The Environment Topology searches change only which loopback clients they leave out, and their rollups stop declaring three fields no search ever filled; every other change applies when a page is viewed or the AI Assistant runs a query.
- If `local/savedsearches.conf` overrides the `search` of an Environment Topology aggregation, backfill or IP-enrichment search (`logserv_topology_aggregate_nodes`, `logserv_topology_aggregate_edges`, `logserv_topology_detail_aggregate`, `logserv_topology_enrichment_aggregate` or their backfill twins), the override keeps the old filter, which leaves out only 127.0.0.1; remove it to take the shipped search.
- If your users run Claude 5.x models, check the daily spend cap (`daily_spend_cap_usd`, **Settings → AI Assistant → General**): their turns now count toward it.

SAP Router `CONNECT TO` edges, RFC edge counting, the HANA audit host and the rewrite of the HANA trace parsing follow in a later build. [Upgrading](../getting-started/upgrading.md) repeats the steps above.

### :material-circle-box:{ .taiconcolor } The ES feeds keep their inventory, the AI Assistant runs only its own catalog and sends no raw text in Tier 2 column names, and the topology edges are trimmed on their own (build 376)

- **Enterprise Security asset and identity feeds.** `splunk_sap_logserv_es_asset_feed` and `splunk_sap_logserv_es_identity_feed` each read all of their sources in one search instead of a `| union` of subsearches, which Splunk can stop early. A run that finds no rows no longer deletes its CSV: it writes with `override_if_empty=false`, and the last inventory stays in place. The rows are sorted without a limit (`sort 0`); before, an inventory of more than 10,000 rows was cut to 10,000. A run whose search window starts later than midnight six days ago (`-6d@d`) writes nothing, so an ad-hoc run over a short window cannot replace the 7-day inventory with a partial one; the REST dispatch shown in [Asset & Identity Feed](../enterprise-security/asset-identity-feed.md) passes `-7d@d` and still writes. The threat-intel examples in [Threat Intelligence Integration](../enterprise-security/threat-intel.md) now write with `override_if_empty=false` as well.
- **The AI Assistant runs only the saved searches in its catalog.** `splunk_run_saved_search` used to pass any name the model gave it to the Splunk MCP Server, so the model could have run a rollup aggregation, retention, backfill or ES feed — none has been seen in the reference system's MCP log. The App now dispatches only the saved searches of its prompt library, checked where every saved-search call is sent; it builds the MCP arguments itself — the vetted name, the App and the time range — rather than forwarding what the model passes, and refuses a tool it does not define. Each saved-search call, predefined prompts included, now names this App as `app` (`splunk_app_sap_logserv`), so the Splunk MCP Server runs this App's search and not a same-named one in another app; the argument was checked against Splunk MCP Server 1.1.0's `run_saved_search` schema, and 1.1.0 or later is recommended. Free-form queries are checked against a longer list. The SPL guard is a denylist of known risky commands — every command it does not name passes — and until now refused `collect`, `outputlookup`, `outputcsv`, `delete`, `sendalert`, `sendemail`, `script`, `run` and `tscollect` after a `|`. It now catches each listed command at the start of the query and after a `[` too, and adds `collect`'s aliases `stash`, `summaryindex` and `sumindex`; `mcollect` and `meventcollect`; `outputtext`, `dump` and `createrss`; `runshellscript`; `rest` (`storage/passwords` returns stored credentials decrypted); `outputtelemetry` and the third-party `curl`, `wget` and `sendresults`; the Machine Learning Toolkit's `ai` (it sends the rows to an LLM) and `deletemodel`; and `map` and `savedsearch`'s aliases `macro` and `savedsplunk`. It refuses `savedsearch` and `savedsplunk` as words anywhere, the external lookup `dnslookup` (each row is a DNS query to an outside name server), a `fit` command followed anywhere later in the query by the word `into` (`fit ... into` saves a model), an SPL inline comment, an unmatched backtick, a double quote that is never closed, a backslash-escaped double quote outside a quoted string, and any macro other than the App's own, since a comment, ambiguous quoting or another macro could hide a command. A command written with double or single quotes in it (`| "delete"`, `| de'lete'`) is refused too, and so is a forbidden word, `dnslookup` or `into` that quotes split (`| "saved"search X`, `| lookup "dns"lookup`, `| fit X "in"to m`): where Splunk's reading of quotes is uncertain, the guard assumes the worst and refuses. Otherwise double-quoted text no longer counts as SPL structure: a quoted value that contains a pipe and a command, such as `eval x="| collect index=main"`, was refused before and now passes. Custom commands and external lookups that other installed apps add are not covered unless the guard names them. A refused name or query is recorded as a `security_blocked_spl` audit event. This protects the App's own assistant; other MCP clients holding a token are governed by the Splunk MCP Server's own controls and Splunk permissions. See [Security Architecture](../ai-assistant/security-architecture.md).
- **Splunk's error text no longer reaches the AI vendor.** When a tool call failed, the AI Assistant used to send the vendor up to 200 characters of the Splunk or MCP Server error message, in every tier. A Splunk error repeats the search that failed, and a subsearch can put event data into that search, so the message could carry event text. A failed call now reaches the model only as its HTTP status and one of ten fixed error classes, with a fixed hint the App writes, for example `Tool error (HTTP 400, class=parse_error): Splunk could not parse the query; check the SPL syntax. The error text is shown to the user only.` The full error stays in the result panel on the user's screen. Refusals the App makes itself, before anything is sent, still give the model their reason, as `Tool call refused by the App before it ran: <reason>` (until now `Tool error: <reason>`); only instructions of your own that quote the old wording need updating. See [Privacy Tiers](../ai-assistant/privacy-tiers.md#failed-tool-calls-every-tier).
- **Tier 2 column names and time ranges no longer carry raw event text, and with PII redaction on a value is sent in clear only when the App can trace it to a field that is not an identifier.** The Tier 2 summary used to send every column name, and the minimum and maximum of `_time`, exactly as the search returned them. Both can be data: `timechart`, `chart`, `xyseries` and `transpose` turn the values of a field — user or host names — into column names, `eval {f}=…` can turn any event text into a column name, `timechart count by user | stats sum(*)` makes `sum(jsmith)`, and `eval` can set `_time` to any text. Now a column name is sent only when Splunk generates it (`count`, `percent`, `NULL`, `OTHER`, a bare function name such as `avg`, …) or when every word in it — each run of letters, digits and `_`, matched whole and in the same letter case — appears in the text the model or the App wrote for that call: the model's own query (`splunk_run_query`), or the SPL of the App's catalog search that ran. Text the model or the App wrote tells the vendor nothing new. Such a name must also be at most 40 characters and shaped like a field name or a single `fn(field)` call, or be a display alias the text quotes after `AS` (`rename sourcetype AS "Source Type"`; words separated by single spaces). Any other name is shown as `col_N`, with PII redaction on or off, and the summary says how many names were withheld. So `stats count as failures by host` and `table _time host process message` keep their names, while split-by values the query did not type — `timechart count by host`, `chart count over host by user`, `xyseries host user action` — and `sum(jsmith)` are shown as `col_N`, even as a result's only column. Values now fail closed. With PII redaction on, a text column's values are sent in clear only when the App can trace the column through constructs it reads in full — the field by its own name, a statistics function over one field (nested included), `field AS alias`, a `rename` without wildcards, `lookup … OUTPUT x [AS y]`, `eval y=x` with one bare or single-quoted field, or a count — to fields that mark no identifier. Every other column sends every value as a `<redacted-…>` tag: any other `eval` expression (`.` concatenation, any function, a literal), `rex`, `spath`, `strcat`, a wildcard `rename` or `AS`, a dynamic `eval {f}=…` target, the cells of a pivot (`timechart values(src_ip) by user`), `transpose`, `untable` and `fieldsummary`, a column a subsearch defines, and every column after a command the App does not read in full; a text over 20,000 characters, more than 256 commands or subsearches nested more than 8 deep leave every column untraced. Until build 375 a value was redacted only when its column's own name matched a pattern, so `values(user)`, `rename user AS u` or `eval w=user."@".domain` sent user names in clear. A pure count (`count`, `dc(user)`, `dc(host) AS affected_hosts`) keeps its numbers, and a numeric column sends `values withheld` only when it is not a count and its name or a field it reads marks an identifier, or it mixes many fields. The cost: with redaction on, the computed text columns of some of the App's own catalog searches now arrive as tags — the error `Category`, the cross-stack `stack`, the Cloud Connector `uri_prefix`, the SAProuter `peer`, the HANA trace `message_preview`, the data-freshness `last_seen` and the threat-intel `queries` — while their counts are unchanged. The redaction patterns now match after `.`, `:` and `-` as well as `_` (`Authentication.user`, `All_Traffic.src_ip`, `event.user`) and treat the CIM `src`, `dest` and `dvc` (plurals, `_host`, `fw_src`, `dvc_ip`) as identifiers, since the App's own field aliases put client IP addresses and host names there — so `dest` in the proxy top-denied-URLs search is now redacted. They also cover plurals (`users`, `new_users`, `emails`, `src_ips`, `client_ips`, `dest_ips`), `remote_addr`-style addresses, camelCase Windows names (`TargetUserName`, `SubjectUserName`, `…Email`) and, with the hostname opt-in, `hosts` and `hostnames`. With redaction on, a text column with an id-named source (`user_id`, `employee_id`, …) is redacted too, and a numeric one sends `values withheld` instead of its minimum and maximum. `peer_ip`, `icm_peer_ip`, a bare `ip` and `peer` are still not matched. The Tier 2 primer now tells the model what `col_N`, `<redacted-…>`, `values withheld`, `not in row form` and `Time range: not shown` mean, never to guess what a placeholder or a tag stands for, and to re-query with `stats … by <field>` when it needs readable values. The time range is sent only when every `_time` value is a timestamp, written by the App as ISO-8601 UTC and marked `(UTC)`; otherwise it reads `not shown`. At most 30 columns are summarized. A single-valued numeric column whose name is withheld, or that is not a count and marks an identifier or mixes many fields, sends `values withheld` whatever the redaction setting. A search that returns no rows now reads `Returned 0 rows` in both tiers: Tier 1's count is now the number of result rows, not the number of items in the content list of the MCP reply, so with the Splunk MCP Server it no longer reads `Returned 1 rows` whatever the search returned. A reply in which the App finds no rows is sent in Tier 2 only as `Returned a result that is not in row form`, never summarized as a column. A side effect: a column whose name neither Splunk, the catalog search nor the model's query wrote — a field the search returns without naming it, or a column of an `inputlookup` the search does not list — appears to the AI as `col_N`; the AI can relate it to its query by position (the primer tells it never to guess which value a `col_N` column stands for), and the tiles are unchanged. These pages used to say that no event data reaches the vendor in any tier; Tier 2's top-N values are field values from the events by design, and [Privacy Tiers](../ai-assistant/privacy-tiers.md#tier-2-cloud-llm-aggregated-metadata-admin-opt-in) now says exactly what each tier sends. Tier 1 still sends two numbers per call, a count and a timing; the pages now say how many bits a model that writes its own queries can learn from them.
- **Known gaps in the Tier 2 change.** The App's reading of the model's query is not yet complete. A few constructs (a `_time` the query sets, a stray apostrophe, `rex` groups written `(?'name'…)`, `fieldformat`, echo lookups, `appendpipe`) and some of the App's own identifier fields can still carry a value to the vendor in Tier 2, and a positional `top 10 …` loses its readable values (write `top limit=10 …`). Each case is listed in [Privacy Tiers](../ai-assistant/privacy-tiers.md#known-gaps-in-build-376); they are to be closed in a later build. Where no event value may reach the vendor, use Tier 1.
- **Environment Topology edges retention.** The graph's edges are now trimmed by their own search, `logserv_topology_edges_retention`, at 02:36 search-head time; `logserv_topology_retention` keeps 00:34 and trims the nodes only. The edges trim used to run inside a subsearch of the nodes trim, and Splunk limits how long a subsearch may run, so on an estate with many edge rows the trim could have been stopped before it finished. Every retention search now reads and writes one collection in a search of its own, and the nightly retention window ends at 02:36 (00:34–00:58, 01:30–01:58 and 02:34–02:36).

After upgrading:

- The two ES CSVs are written into the App's `lookups/` directory at run time and are not in the package. If your upgrade method does not keep that directory, the feeds re-create them on their next run; dispatch both feeds once after upgrading so ES is not left without them meanwhile.
- If `local/savedsearches.conf` overrides the `search` of `logserv_topology_retention`, remove that override; it keeps the old two-collection search.
- Keep long backfills clear of the nightly retention window, which now ends at 02:36.

Nothing needs to be rebuilt. [Upgrading](../getting-started/upgrading.md) repeats these steps.

### :material-circle-box:{ .taiconcolor } A restart just before the nightly retention can no longer empty a rollup (build 375)

Each rollup's retention search reads its collection once a night, keeps the last 365 days and writes the result back over the whole collection (00:34–00:58, 01:30–01:58 and 02:34 in the search head's local time). By default Splunk's `outputlookup` empties a collection when the result is empty, and right after a Splunkd restart the KV Store can still be starting up and return no rows, so a restart shortly before a retention ran could empty that rollup. Every retention search now writes with `override_if_empty=false`, and an empty result leaves the collection as it is. Only three had it before — the Data Doctor's saved-reports and platform-snapshot retentions and the topology IP-enrichment retention; the other 26, which trim the dashboard rollups and the Environment Topology graph and detail collections, did not.

One thing changes: a collection whose rows are all older than 365 days — a rollup whose aggregation has been switched off for more than a year, for example — keeps them until new rows arrive, and the next nightly run then trims them. Meanwhile its **History** in **Settings → Dashboard Data** shows more than 365 days; **Clear** there still empties a collection at any time.

Nothing needs to be rebuilt after upgrading; [Upgrading](../getting-started/upgrading.md) says how to spot a rollup an earlier build emptied this way. A `search` override for a `logserv_*_retention` stanza in `local/savedsearches.conf` takes precedence over the shipped search and keeps the old behaviour: remove it, or add `override_if_empty=false` to each `outputlookup` it runs.

### :material-circle-box:{ .taiconcolor } Firewall drops at the host and in transit (build 374)

The kernel firewall log records two kinds of drop. **IN_DROP** is a packet addressed to the host itself (the INPUT chain). **FWD_DROP** is a packet the host was routing on to another system (the FORWARD chain); only hosts that forward traffic, such as VPN or IPsec gateways, log it. The **Firewall Drops** KPIs counted only IN_DROP, while the Blocked tables (**Blocked Sources** on Linux, **Blocked Source IPs** on Network Perimeter, and **Blocked Destination Ports** on both) already counted both, so a source could show more drops in a table than the KPI showed in total. On the reference instance FWD_DROP made up 92% of the real firewall drops.

- **Linux** and **Network Perimeter** show **Firewall Drops at Host** and **Firewall Drops in Transit** side by side, and their Blocked tables split each row into *At Host* and *In Transit / Other*. Network Perimeter reads its in-transit count from the Linux dashboard's summary data, so it shows 0, or undercounts, for any period the Linux rollup has not summarised: its aggregation turned off, or those days not backfilled.
- **Settings → Dashboard Data** labels that rollup's row *Linux System & Security / Network Perimeter*, naming both dashboards that read it, as it does the other shared rows; the Data TA's AWS S3 Direct screen shows the same label (see the Data TA entry of 2026-10-01 below).
- Linux's **Firewall Drops Over Time** charts the two chains. It used to chart every `linux_secure` line, firewall or not.
- **Environment Health** still counts only drops at the host as errors; its KPI, Security Error Trend series and Affected Hosts column now say so.
- The AI Assistant's two firewall prompts say which drops they count, and its system prompt names the real kernel tags, `IN_DROP` and `FWD_DROP`.

No summary data changes, so nothing needs to be rebuilt after upgrading.

### :material-circle-box:{ .taiconcolor } The late-arriving data check runs every day (build 373)

The **Late-arriving data** check also runs every day at 05:40 (search-head time) as the saved search `logserv_late_arrival_check`, and records a triggered alert (*Activity → Triggered Alerts*) when it finds a day whose events are not all in the rollups — so a late delivery is reported even if nobody opens **Settings → Dashboard Data**. Add an alert action to be told by email. It never judges an hour older than the Multi-Cloud Overview rollup's oldest, so a new install raises no alert before its first backfill, and it reads the rollup without a subsearch, so Splunk's subsearch limits cannot invent late days on a large estate.

### :material-circle-box:{ .taiconcolor } Late-arriving events reach the dashboards (build 372)

SAP LogServ data reaches Splunk through S3, Azure Blob and GCS queues, and some of it arrives after its hour has been aggregated. Each hourly aggregation used to read its hour once, a few minutes after the hour ended, so an event indexed later was never counted on any rolled-up panel at a range of 90 minutes or more. On the reference instance, 1.4% of the real Azure events arrived after the earliest aggregations had read their hour, and a weekly `linux_secure` delivery arrived up to a week late, which left the **Linux System & Security** firewall counts 18% short over 12 days. Every hour-bucketed rollup now re-reads the hour before as well (`-2h@h`..`@h`): events up to about an hour late are counted, and an hour whose aggregation was skipped is rebuilt by the next run. Each hourly aggregation reads two hours, so it takes about twice as long. Anything later is listed by **Settings → Dashboard Data** under **Late-arriving data** — the days on which the index holds events the rollups do not, over the last 30 days — and **Backfill N days** rebuilds exactly those days. See [Dashboard Performance → Late-arriving data](../logserv-app/dashboards/performance.md#late-arriving-data).

### :material-circle-box:{ .taiconcolor } Time charts fill their panels (build 371)

A row of panels is as tall as its tallest panel, usually a table. A time chart beside one kept its fixed 280 px and left an empty band below it — for example **Average Response Time** on Cloud Connector, **Firewall Drops Over Time** on Linux, and **Bandwidth Over Time by Domain (Top 5)** and **Response Time (Avg / Max)** on Proxy. Every time chart now grows to the full height of its panel, on every dashboard. A chart is never shorter than before, and a panel that had no empty band looks the same.

### :material-circle-box:{ .taiconcolor } Dashboard Data measures history a few rollups at a time, and says when it could not (build 370)

The **History** column of **Settings → Dashboard Data** comes from one small search per rollup collection. The panel used to send all 27 at once, and every one Splunk did not answer with a result — because its search slots were taken, as they often are just after a backfill — showed the same `—` as a rollup that had not been measured, which read as missing data. The checks now run three at a time; one that Splunk turns away or does not answer is tried again after 2, 4 and 8 seconds; and a check that still measures nothing reads **check failed — re-check**, with the reason on hover. A banner offers to re-check all of them, and such a row no longer counts as needing a backfill. A check whose search ran but failed — a missing lookup definition, for example — used to read `empty`; it reads **check failed** too.

### :material-circle-box:{ .taiconcolor } Two Dashboard Data rows name the dashboard that shares them (build 369)

**ABAP Operations** has no rollup of its own: it reads the one **Work Process Performance** reads. **Web Dispatcher** reads the **Web & API Performance** rollup as well as its own Slowest Traces row. **Settings → Dashboard Data** now labels those two rows *Work Process Performance / ABAP Operations* and *Web & API Performance / Web Dispatcher*, so every dashboard can be found in the list; the Data TA's AWS S3 Direct screen shows the same labels (see the Data TA entry of 2026-09-28 below). The rollups themselves are unchanged.

### :material-circle-box:{ .taiconcolor } Downloaded images show the help icon upright (build 368)

**Actions → Download PNG** and **Download PDF** copy the page's styles as they are at that instant, so the help icon's square at the right of a dashboard's title row came out at whatever angle it had - tilted whenever the download was clicked while it was turning (4 seconds in every 12). The page's animations now rest at their start while the copy is taken and carry on where they were afterwards: the square is upright and spinners are still in every download.

### :material-circle-box:{ .taiconcolor } Pacemaker lines name their own product (build 367)

On the Pacemaker cluster log that the `linux:slapd` sourcetype also carries, `vendor_product` and `app` said `OpenLDAP` and `slapd`. They now say `Pacemaker` and `pacemaker`; `slapd.log` lines keep `OpenLDAP` and `slapd` (on the reference system 1,932,656 Pacemaker lines and 1,462,405 `slapd.log` lines). No dashboard or saved search of the App reads the two fields; searches of your own that filter on them see the change.

### :material-circle-box:{ .taiconcolor } The Data Doctor knows both folder layouts (build 366)

Real LogServ deliveries file some logs under different paths per cloud (see the Data TA entry of 2026-09-25 below). The Data Doctor's filter diagnosis now maps Squid to `proxy/squid` and `linux/proxy`, the Pacemaker cluster log to `linux/slapd` and `linux/pacemaker`, and `/var/log/messages` also to `linux/proxy`, so a rule that names only one layout is reported as dropping part of the log type, not all of it.

### :material-circle-box:{ .taiconcolor } Password statements in any letter case, readable statements, and the right Start Service and cluster fields (build 365)

More differences between real SAP LogServ data and the demo data, measured on the same feeds:

- **HANA Audit's Password Management** recognised password statements in lower case only, so upper-case `CREATE USER … PASSWORD ***` (480 real events) and `ALTER USER … DISABLE PASSWORD LIFETIME` (432) counted as **Other**. They are now **Password Change** and **Disable Lifetime**. The HANA Audit rollup keeps the old classes until it is rebuilt; the rebuild [Upgrading](../getting-started/upgrading.md) asks for after build 364 covers it.
- **Statements read as in the database.** A statement that quotes identifiers kept real ingest's JSON escapes (`grant \"HEC_HANA_MONITORING\" to NAGIOS`); the **SQL Statement** column and the `command` field now show `grant "HEC_HANA_MONITORING" to NAGIOS`.
- **Start Service source location.** `source_location` now reads file names that contain a dot (`[nixxi.cpp 464]`, `[CIMPlugin.cpp 999]`), which it had missed on most real GCP events, and no longer takes the thread marker `[Thr 12]` for a location.
- **Pacemaker cluster log.** Where the cluster runs, the `linux:slapd` sourcetype also carries `/var/log/pacemaker/pacemaker.log`. Its `os_user` field held a cluster resource or a scheduler function, never a user — and `slapd.log` lines name no user at all — so the field is gone. Pacemaker lines now carry `resource_agent` and `cluster_resource` (`SAPHanaController(rsc_SAPHanaController_A44_HDB02)`) or `pacemaker_daemon` and `pacemaker_function` (`pacemaker-schedulerd[…] (determine_op_status)`).
- **Squid's other two files.** The App knows the Data TA's new `squid:cache` and `squid:store` sourcetypes (see the Data TA entry below): neither gets automatic key=value fields, as before, and the Data Doctor maps both to the `proxy/squid` filter path.
- The upgrading note on **Settings → Dashboard Data** names the rebuilds that build 364 needs.

### :material-circle-box:{ .taiconcolor } Real SAP LogServ data parses the way the dashboards expect (build 364)

Earlier builds were validated on the generated demo data, which stores log text decoded. Real LogServ ingest keeps the JSON escapes of the source record in the event (`\"`, `\n`, `\t`, `\\`), and some real logs use formats the demo data never produced. Measured on the reference system's real Azure, GCP and AWS feeds:

- **Proxy Analytics extracted nothing from real data.** SAP LogServ proxy logs use Squid's `logformat=splunk_recommended_squid` key=value form, which earlier builds did not parse: none of 7,003 real proxy events in 30 days yielded a domain, client, status or byte count, so Proxy Analytics, the Network Perimeter proxy panels and the threat-intel proxy search saw request counts only. The App now parses that form as well as Squid's native format. The proxy panels also count access-log lines only: Squid's `store.log` and `cache.log` lines share the sourcetype but are not requests (43% of the real feed's proxy events, 69% of the demo data's).
- **HANA Audit found a status only for connect-type actions.** The action status and target principal are now read by their position in the record, for every action (before: 5.6% of the real feed, which is mostly `ALTER FUNCTION`). User and privilege statements are recognised in any letter case and when quoted, and `audit_datetime` parses the `Z` time zone real records carry (it was empty on every real event).
- **Six more fields.** The sudo **command** keeps the whole command, with sudo's line wrapping joined and the escapes removed; **lastlog** reads user names containing `-` and console logins (4,046 of 115,627 real lines had been missed). Four more were proven on a JSON-escaped copy of the demo data, as real data for them is not on the reference system: the Cloud Connector **HTTP version**, the ABAP gateway **error detail**, the Start Service and Host Agent **error message**, and the HANA Trace slowest-operation name now end where the line does in both forms.

Rollups keep the values they stored before: [Upgrading](../getting-started/upgrading.md) names the rows to rebuild once.

### :material-circle-box:{ .taiconcolor } The upgrading note names all three rebuilds, the AI Assistant panel opens below the header, and a narrow window keeps the full width (builds 361–363)

- The upgrading note on **Settings → Dashboard Data** now names **Beaconing detection** beside Change & Configuration Activity and Linux System & Security; it had left out the Beaconing rebuild that build 356 requires (build 361).
- The AI Assistant panel now opens directly below the two-row header and moves up with it as the page scrolls. It had kept a fixed offset sized for Splunk Web's app bar, which the App hides, so the open panel covered the right end of the header's second row — including the **AI Assistant** button that closes it (build 361).
- The header's **Actions** button is the same height as **Refresh** and **AI Assistant** beside it; it had been 3 px taller since the header became two rows (build 362).
- In a narrow window the App no longer shrinks to a strip. Below about 880 px Splunk Web's own top bar wraps its menus onto a second line, and the App was laid out in the space left beside that line — 118 px wide at a 720 px window; it now starts below the line at full width (build 363).

### :material-circle-box:{ .taiconcolor } Smaller fixes (builds 358–359)

- The rollup retention searches' descriptions give the right time, stated in the search head's local time; 23 of 29 had named the wrong one after the schedules were re-staggered (build 358).
- KPI sparkline tooltips stay inside their card at both ends of the line (build 358).
- In dark mode the browser draws its own dark scrollbars and form controls (build 359).

### :material-circle-box:{ .taiconcolor } Three rollups count correctly — rebuild each once after upgrading (builds 356–358)

These fixes change what is stored, so rows written by earlier builds stay wrong until the rollup is rebuilt with **Clear** and then **Backfill** in **Settings → Dashboard Data**. [Upgrading](../getting-started/upgrading.md) says which builds need which rebuild. From build 361 the upgrading note on that page names all three; before, it named only the last two, although the Beaconing rebuild applies as well.

- **Beaconing detection (build 356).** Each day was keyed on midnight in the time zone of the search that wrote it — the scheduled job used the search head's, a Settings backfill the signed-in admin's. Where the two differed, a day could be stored twice, and the **Beaconing Domains** KPI summed both: 1,777 against 1,103 over 30 days on the reference system. Days are now UTC calendar days.
- **Change & Configuration Activity (build 357).** The after-hours flag was stored in the rollup, classified in the writer's time zone, which inflated **Total Change Events** and **After-Hours Changes** by about 24% over 30 days on the reference system. After-hours is now worked out when you view the dashboard, in your own time zone.
- **Linux System & Security (build 358).** **Kernel Event Types** counted fragments of ordinary words — the first capital of a sentence-case message ("Write cache…" became `W`) — and tags cut short at a digit (`EXT4` became `EXT`). Only genuine all-caps tags of two or more characters count now.

### :material-circle-box:{ .taiconcolor } Dashboard Data backfills a chosen window, and waits as long as a job runs (builds 353–360)

**Settings → Dashboard Data** could backfill only the last 30 days, although every rollup keeps 365. It now offers **30, 60, 90, 180 or 365 days**, or a custom **UTC** date range. A window longer than 31 days runs in monthly chunks; a start more than 365 days back is refused, because the rollups' retention would delete what it wrote; and a window over 90 days shows a cost warning first. The two flat Environment Topology collections are always refreshed from the last 30 days, whatever the window.

The panel no longer gives up on a job that is still running: a row is marked failed only when Splunk reports the search failed or gone. When the panel itself stops waiting — **Cancel**, 15 minutes without contact, or 24 hours — the row reads **still running on server**, with the search IDs on hover. "Failed" and "truncated" marks survive the refresh after a run, and a finished row shows **refreshing…** until its new depth appears. The window hint now points at the matching **Scan from / Scan until** dates on the Data TA's AWS S3 Direct screen (build 360).

Keep long backfills clear of the rollup retention windows — 00:34–00:58, 01:30–01:58 and 02:34 in the search head's local time — or re-run the affected rows afterwards: a retention search rewrites its whole collection and erases rows a concurrent backfill has just added. For scale, a 365-day backfill of every row took 195 minutes on the reference system.

### :material-circle-box:{ .taiconcolor } Chart buckets follow the time range, and crowded charts stop repeating colours (builds 345, 350–354)

Ninety-five chart time spans across 18 dashboards were fixed at one day. They now scale with the selected range: a **Last 24 hours** chart draws 12–100 points with time-of-day ticks where it drew two. Sparklines and the per-day-average KPI stay daily by design (build 345).

A chart that draws more series than its palette ramp has colours now switches to the 11-colour categorical palette instead of reusing colours — seven dashboard charts had drawn two different series in the same colour. A chart with more than 11 series still cycles the 11 colours. In the AI Assistant, pies never use severity shades, and a pie whose largest slice is 85% or more of the total, with at least three slices, is drawn as a horizontal bar so the smaller categories stay readable. Windows "critical" no longer shares "high"'s red, and the HIGH / MEDIUM / LOW risk tiers read red, orange and blue (builds 350–354).

### :material-circle-box:{ .taiconcolor } Navigation moves to a left rail, with a two-row header and the Cisco Magnetic palette (builds 338–349)

The App takes on the Cisco Magnetic "Workbench scaffold" look: in dark mode a navy page with a blue accent, in light mode higher text contrast, and chart colour ramps that follow the palette (build 338).

The top-bar menus give way to a collapsible **left rail**, 244 px wide or 56 px with icons only. Each category opens its sub-menu beside its own row, and the sub-menu closes on any navigation, on Escape or on a click outside it. The current dashboard carries a check mark and its category stays lit. The rail's collapsed or expanded state is remembered per user in the browser; the Environment Topology view opens with it collapsed; and below 860 px the rail floats over the page instead of taking width. The header becomes two rows — the brand, the **App** version and **build** pills and the light/dark toggle, then the time-range preset pills (**Last 24h**, **7d**, **30d**, **90d**) beside Splunk's own time-range picker for any other range, with **Actions**, **Refresh** and **AI Assistant** at the right. Splunk Web's app bar is hidden (the Splunk bar stays), and a gradient backdrop sits behind the dashboards (builds 339–349).

Panel headers wrap their controls to a second row instead of overflowing the narrower content area, and Splunk tables no longer scroll sideways (build 347).

### :material-circle-box:{ .taiconcolor } Data TA - a newer Splunk Add-on for AWS and a search head are no longer blocked (build 1792598960, 2026-10-21)

- **The AWS S3 Direct screen accepts the Splunk Add-on for AWS 8.1.0 and any later version.** It compared the add-on's version with a list of validated versions, 8.1.0 alone, and warned about any other, 8.3.0 included. Only a version older than 8.1.0 now gets that advisory.
- **A configuration the screen cannot read is reported, not taken as empty.** When the add-on answers a read of its accounts, IAM roles or Generic S3 inputs with an error or without a list (a newer version may serve it at another endpoint), the screen names each request with its HTTP status and what that status most likely means, and shows the configuration to apply instead of creating inputs; the AWS account or the IAM role becomes a typed field where its list could not be read. An unread SQS-Based S3 input list is reported as a warning only. Such a failure used to read as an empty list: *No AWS accounts are configured* hid the form, and an unread input list let a backfill reuse an existing input name or read days an earlier backfill covers. With the input list unread, the form now says so, and the generated stanzas and REST calls carry the same note. **Create backfill** re-lists the inputs before it creates anything, and now creates nothing when that list cannot be read; it used to go ahead as if no input existed.
- **No gates on a search head or Splunk Cloud.** On Splunk Cloud the screen was read-only, and on an instance with no enabled AWS input it held the form behind a confirmation. Both are warnings now, with a strong recommendation to create the inputs on the heavy forwarder that already collects your LogServ data; nothing is blocked, and the messages for a missing or disabled add-on point to the heavy forwarder first. See [Running the TAs on a search head](../install-setup/install-ta.md#running-the-tas-on-a-search-head).
- **A list of apps or indexes the screen cannot read no longer stops it.** When it could not read Splunk's list of apps it said *The Splunk Add-on for AWS is not installed*; it now reads the add-on's own lists and carries on if they answer, and otherwise says it cannot tell. When it could not read the list of indexes, or the list was empty, it left the Index field empty and stopped at *An index is required.*; it now says so and lets you type the index, filled in as `sap_logserv_logs` and checked against Splunk's index naming rule.
- **The account list has a second source.** The screen reads the add-on's accounts from its combined account list, which the add-on's current API reference no longer lists, and now falls back to the account endpoint that reference documents; with version 8.1.0 both return the same accounts.
- **The daily filter refresh runs on a deployment client that holds the Data TA directly**, such as a search head that gets other apps from a deployment server. It used to skip on every deployment client. It now skips only where the deployment server delivered the Data TA, or where the instance's `serverclass.xml` is missing, unreadable or lists no app; that last skip is logged as a warning.
- `README.txt` recommends heavy forwarders strongly and says a search head is not blocked.

`transforms.conf` and `props.conf` are unchanged, so parsing, routing and filtering are those of build 1792189743, and nothing has to be saved again after the update.

### :material-circle-box:{ .taiconcolor } Data TA - every rule reads the whole line, and the ICM route takes only the ABAP folder (build 1792189743, 2026-10-16)

The Data TA's metadata rules (`host`, `source`, `clz_dir`, `clz_subdir`) and its 34 sourcetype routes now read up to 100,000 characters of a line (`LOOKAHEAD = 100000`, as `TRUNCATE` and the filter rules do); every earlier build read the first 4,096. The AWS envelope puts the log text (`_raw`) first and the envelope keys after it, so an AWS event longer than about 4 KB kept the input's own `host` and `source`, got no folder fields and stayed `sap_logserv_logs`: the dashboards, the folder filters and the sourcetype parsing missed it. Azure and GCP envelopes put the keys first and were not affected.

- **The rules stay linear at the new window.** The seven routes that check both folder fields (`abap/audit`, `abap/icm`, `abap/sapstartsrv`, `hana/tracelogs`, `scc/audit`, `scc/tracelogs`, `sap/sapstartsrv`) now use the shape the filter rules already use; the `(?s)^(?=.*...)(?=.*...)` form of build 1791935359 would exceed Splunk's regex match limit near 100,000 characters. The HANA trace route for events without folder fields walks the line token by token, with the same matches as before. The four BIND routes keep a path segment inside the `source` value, so a long line cannot push them past Splunk's recursion limit, and the Windows and sssd routes keep their channel or file name inside it too (`[^"]*` where they had `.*`, which ran on into the log text). Every route and metadata rule was run through Splunk 9.4.3's own regex library as a search over lines just under 100,000 characters in the AWS, Azure and GCP key orders, with long runs, escaped quotes and decoy keys, runs of slashes and Unicode line separators in the log text: each matched exactly as expected, with no limit message. Lines up to 4,096 characters route as before.
- **The ICM route takes only the ABAP ICM folder (`abap/icm`).** It took every folder named `icm`, so a Web Dispatcher's own ICM trace (`webdispatcher/icm`, a Secondary folder of the LogServ service description, not seen in real deliveries) became `sap:abap:icm`; it now keeps `sap_logserv_logs`, like the Web Dispatcher's other Secondary folders. Events indexed earlier keep their sourcetype.
- **The AWS S3 Direct screen** lists `sap/saprouter` for both Environment Topology rows, which read SAP Router data since App build 378.
- **The two scheduled scripts log by level.** The filter upgrade check and the time-filter refresh wrote every line to the error stream, which splunkd records in `splunkd.log` as an `ERROR` of component `ExecProcessor`, INFO lines included. INFO lines now become the scripts' own events (`index=_internal sourcetype=splunk_ta_sap_logserv:filter_check` or `sourcetype=splunk_ta_sap_logserv:filter_time_refresh`); warnings and errors still reach `splunkd.log`.
- **Third-party notices and exact pins.** The add-on ships `THIRD-PARTY-NOTICES.md`, naming the nine Python packages in its `lib/` folder with their licences, and `lib/requirements.txt` pins each one's exact version and PyPI file hashes, so a rebuild cannot pick up a newer release unseen. The bundled libraries are byte-for-byte those of build 1791935359. `README.txt` now describes the add-on.

The change takes effect where the Data TA parses LogServ data, on the heavy forwarders or a single instance; events indexed earlier keep their sourcetype and fields, and nothing has to be saved again. If you added the six `(?s)^` routes to the Data TA's `local/transforms.conf` as a test ([Heavy Forwarder Sizing](../install-setup/hf-sizing.md#version-check)), remove them before you update: `local/` would keep the old REGEX together with the new 100,000-character window, a combination that exceeds the match limit.

### :material-circle-box:{ .taiconcolor } Data TA - six routing rules are tried once per event, not at every character (build 1791935359, 2026-10-13)

Six of the Data TA's sourcetype routes, for `abap/audit`, `abap/sapstartsrv`, `hana/tracelogs`, `scc/audit`, `scc/tracelogs` and `sap/sapstartsrv`, check two folder keys at once with a pattern such as `(?=.*"clz_dir":"abap")(?=.*"clz_subdir":"audit")`. Without a `^` at its start, the regex engine tries such a pattern again at every character of an event it does not match, and each try reads to the end of the first 4,096 characters, so the work for one event grows with the square of its length. Each route fails to match nearly every event, so the six ran this way on almost every LogServ event a heavy forwarder parsed. Splunk's regex match limit counts the work of each start position on its own, so it never stopped these searches and nothing was logged.

The six routes now start with `(?s)^`, so each is tried once per event. The `(?s)` keeps the routing as it was: in Splunk's regular expressions `.` stops at a carriage return, vertical tab, form feed or a Unicode line or paragraph separator as well as at a line feed, and the forwarder ends an event only at a line feed or carriage return, so with a bare `^` such a character in the log text ahead of the folder keys would have left an event unrouted. With `(?s)^` a route matches whenever both folder keys are in the event's first 4,096 characters: it routes every event it routed before, no event in the real LogServ data checked changes sourcetype, the filter rules are not affected, and nothing has to be saved again after the update. On Splunk 9.4.3's own regex library, measured at search time on generated LogServ events of 460 to 4,160 characters, anchoring made the six routes 179 to 1,778 times faster, with the same result for every event, and the `(?s)` costs nothing extra; the gain at index time on a forwarder is still to be measured. Every Data TA version from 0.0.4 on carries these routes. The change takes effect where the Data TA parses LogServ data, on the heavy forwarders or a single instance, once this build is installed there. To size heavy forwarders and measure the cost per event on your own, see [Heavy Forwarder Sizing](../install-setup/hf-sizing.md).

### :material-circle-box:{ .taiconcolor } Data TA — the Filters tab filters by source file, and its rules read the whole line (build 1791565776, 2026-10-09)

The **Configuration → Filters** tab gains two fields, **Include Sources** and **Exclude Sources**. They match the event's whole `source` value — the log file's path, such as `/var/log/zypper.log`, or a name such as `ps` — with `*` for any run of characters (`/` included) and `?` for one character, case-sensitive; an entry can be limited to one folder, as in `linux/linux_secure=/var/log/zypper.log`. **Exclude Sources** drops log files that share a folder with a Primary log type without dropping the folder: zypper and YaST2 arrive in `linux/linux_secure` beside the firewall, kernel, sssd, `lastlog` and `who` logs (2.1 million `/var/log/zypper.log` lines in six weeks of real data on the reference system). **Include Sources** keeps files that an Include Filters allow-list would drop, including events that carry no folder fields at all — Unix command output such as `ps` and `netstat`, and HANA trace files, about 19.9 million real Azure events on the reference system. Both fields are empty by default, so nothing changes until you fill them in. Exclude Sources always wins, like Exclude Filters. See [Configuring Filters](../install-setup/configure-filters.md#how-the-rules-combine) for the order the rules apply in, and [Filter Recipes](../install-setup/configure-filters.md#filter-recipes) for allow-list, deny-list and shared-folder settings.

The existing filters are fixed in four ways:

- **Wildcards stay inside the value, whatever the Python version.** The Data TA built its patterns with Python's `fnmatch`, which let a `*` run past the end of the value into the rest of the line: `linux/c*n` also matched `linux/cache` whenever a later value in the line ended in `n`. The text it generated also differed between Python versions. A `*` now matches only within the value it stands in, and the generated text is the same on every Python version. Patterns with several `*` also run in linear time: each `*` but the last stops at the first place the text after it fits, so the work on a long value no longer multiplies with every `*`. What a pattern matches does not change.
- **Rules read the whole line.** An index-time transform reads only the first 4,096 characters of a line unless told otherwise. In the AWS envelope the log text comes before the `source`, `clz_dir` and `clz_subdir` keys, so on a line whose log text ran past about 4,000 characters the folder keys were out of reach: an Include Filters allow-list dropped the line and an exclude missed it. Every generated filter stanza now sets `LOOKAHEAD = 100000`, the longest line the Data TA indexes, and the patterns skip over the log text, which keeps them within Splunk's regex match limit on lines that long — raising `LOOKAHEAD` alone would have made the old patterns fail there.
- **The AWS S3 Direct screen's filter preview matches the way the forwarder does.** The screen leaves out folders the forwarder's filters would drop, and it compared pattern text by prefix: with Filtering on and the default Include Filters `*/*` it left out every folder, and a pattern such as `*/cron` matched nothing. It now applies the same wildcard rules and the include-everything rule below, and, because a source rule acts on single files rather than folders, says where source rules may drop or keep some of a folder's files.
- **`*/*` or `*` anywhere in Include Filters keeps everything.** Only `*/*` or `*` on its own used to switch the include gate off; mixed with other entries, they did not.

**Behaviour change:** an Include Filters value that mixes `*/*` or a standalone `*` with other entries now keeps every event. Before, `*/*, linux/cron` dropped every event without folder fields, and a standalone `*` beside other entries was ignored, so `*, linux/cron` kept only `linux/cron` — although the upgrade notification already treated both lists as covering every log type. To keep an allow-list, remove `*/*` and `*` from it. With Filtering on, a save that sets Include Sources while Include Filters includes everything is refused, because the entries would have no effect.

The Data TA writes the new rules when the filters are saved, or when the daily refresh rewrites them (with Days in the Past above 0). After updating the Data TA, open **Configuration → Filters**, click **Save**, and on a Deployment Server click **Deploy to Forwarders**, so the forwarders get the regenerated rules. The upgrade notification still reads Include Filters only; source rules neither raise nor clear it.

Smaller changes to how the tab is saved:

- **Days in the Past is read the same way by the Save and by the daily refresh.** A value such as `7.0` is refreshed every day like `7`. A saved value that is not a whole number is logged by the refresh as an ERROR that names the field, and the rules generated last stay in place.
- **An empty Days in the Past field means no time filter**, as the settings file stores it — the same as `0`.
- **Every field is checked on every save**, also with Filtering off: a value with a line break, a tab or another control character, or one ending in a backslash, is refused.
- **A save through the REST API or the CLI that sends only some fields** generates the rules from the saved values of the fields it leaves out, not from their defaults.

The App's Data Doctor reads the source rules, and the new form of the folder rules, from App build 377 on, which follows this Data TA build. App build 376 and earlier ignore source rules, read a pasted `transforms.conf` that holds only source rules as filtering with everything included, and report folder patterns with `*` or `?` as only partly read. See [Reading the Active Filter Configuration](../install-setup/configure-filters.md#reading-the-active-filter-configuration).

The same Data TA build changes two things outside the Filters tab:

- **HANA trace files delivered without folder fields get the `sap:hana:tracelogs` sourcetype.** On the reference system all of the real HANA trace data — about 566,000 events from one Azure HANA system — arrived in a storage folder named `undefined/undefined`, without `clz_dir` and `clz_subdir`, so the route keyed on the `hana/tracelogs` folder never matched it and it stayed under `sap_logserv_logs`. A new route takes the `.trc` files and `backup.log` of `/usr/sap/<SID>/HDB<nn>/<host>/trace/` and of its `DB_<tenant>/` subfolder by their `source` path, and only when the event has no folder fields; an event that has them is routed by its folder as before. The route assumes that these deliveries carry no `clz_subdir` key at all: an event that carries the key, even empty, keeps the sourcetype it had. That could not yet be checked on a raw delivery, because the reference system's Azure access has been unavailable since 2026-10-01. Events indexed earlier keep `sap_logserv_logs`. Routing adds no folder fields, so folder filters still cannot keep or drop these files: Include Filters `hana/tracelogs` does not keep them — use Include Sources or Exclude Sources `/usr/sap/*/HDB??/*/trace/*`. About half of these lines — `backup.log`, the `hdbcons` timings, the SQL trace and load files and the `system_availability` file — are not in the trace-line format the App's HANA Trace extractions read, so the HANA Trace dashboard shows them with severity `UNKNOWN`. From this build on, the HANA system these files come from also appears in the other places that read `sap:hana:tracelogs`: the [Environment Topology](../logserv-app/dashboards/topology.md), with an edge to each tenant whose `DB_<tenant>/` trace folder is delivered, and the [Enterprise Security asset feed](../enterprise-security/asset-identity-feed.md). The other data delivered without folder fields, Unix command output such as `ps` and `netstat`, stays unrouted; see [Data Delivered Without Folder Fields](../getting-started/supported-log-types.md#data-delivered-without-folder-fields), which also explains why you may want to drop it.
- **The daily time-filter refresh reloads the server class in the app that holds it.** On a Deployment Server with Filtering on and Days in the Past above 0, the daily refresh sends the new time cutoff to the Heavy Forwarders by reloading the `SAP_LogServ_HeavyForwarders` server class. Until this build it sent that reload without an app namespace, so whether it found the server class depended on the default app of the user the refresh runs as; when it did not, the refresh logged a WARNING and the forwarders kept the previous cutoff — keeping older events, not dropping more — until the next **Deploy to Forwarders**. The refresh now reads which app holds the server class and reloads it there, falls back to the `search` app and then to the old form, and logs which one worked. With the reload working, each Heavy Forwarder in the server class restarts about once a day to apply the new cutoff, because the server class the Data TA creates maps it with `restartSplunkd = true`. With Filtering off, or Days in the Past at 0, the refresh changes nothing. See [Configuring Filters → Days in the Past](../install-setup/configure-filters.md#days-in-the-past).

### :material-circle-box:{ .taiconcolor } Data TA — the AWS S3 Direct Dashboards list names Network Perimeter on the Linux row (2026-10-01)

The **Dashboards** list labels the Linux row *Linux System & Security / Network Perimeter*, as the App's **Settings → Dashboard Data** does: Network Perimeter's **Firewall Drops in Transit** count reads that row (see App build 374 above). The row reads the same S3 folders as before.

### :material-circle-box:{ .taiconcolor } Data TA — the AWS S3 Direct job name says what is wrong (2026-09-28)

A job name the screen refuses now gets one message per rule it breaks — for example *Job name is 35 characters long; the limit is 24.* or *Job name has an underscore; use a hyphen instead.* — where one message used to list every rule. The field's help no longer shows how the screen names the inputs it creates, which read as a pattern for the job name itself. The **Dashboards** list shows the App's labels for the two shared rows (see App build 369 above).

### :material-circle-box:{ .taiconcolor } Data TA — the filter paths real LogServ data uses (2026-09-25)

The Data TA declares which folder paths each log type arrives under; the filter's coverage warning, the App's Data Doctor and the AWS S3 Direct screen all read that list. Checked against real deliveries, two layouts differ from it: the AWS bucket files Squid under `proxy/squid`, but Azure delivers it under `linux/proxy`; and GCP delivers the Pacemaker cluster log under `linux/pacemaker` and a proxy VM's `/var/log/messages` under `linux/proxy`, where the list named only `linux/slapd` and `linux/messages`. The Data TA now declares both layouts — nothing that matched before stops matching, and routing is unchanged. With Filtering on and an include list that names only the older paths, the coverage warning now lists `linux/pacemaker` and `linux/proxy`, because events under them are dropped at the forwarder. The AWS S3 Direct screen reads both Squid folders and `linux/pacemaker`; a folder a bucket does not have gives an input that finds nothing.

### :material-circle-box:{ .taiconcolor } Data TA — Squid's cache and store logs get their own sourcetypes (2026-09-25)

The Data TA gave all three Squid files the sourcetype `squid:access`, although only `access.log` holds requests: `cache.log` is the daemon's own log and `store.log` the object-store journal. On the reference system the two made up 43% of the real feed's proxy events, counted by any search that takes every `squid:access` event for a request, and tagged for the CIM Web data model. The Data TA now routes `cache.log` to `squid:cache` and `store.log` to `squid:store`; `access.log` stays `squid:access`. All three keep the `proxy/squid` filter path, so filter rules need no change and no upgrade warning appears. Events indexed before the update keep `squid:access`; the App's proxy dashboards count `access.log` lines only and are correct either way. Saved searches of your own that read those two files under `squid:access` need the new names. On the reference system, real `cache.log` lines from the Azure feed arrive as `squid:cache` after the update, still carrying the `splunk_solution` and `cloud_provider` stamps and no automatic fields, while `access.log` lines stay `squid:access`.

### :material-circle-box:{ .taiconcolor } Data TA — the S3 Direct scan checks find the add-on's log (2026-09-25)

Each backfill's **Did its inputs finish their scan?** search, and the check for all backfills below the list, grouped the Splunk Add-on for AWS's log lines by `log_level`. The add-on (8.1.0) writes `level=`, and `stats … by` drops every event whose group-by field is empty, so both searches returned no rows even for a backfill that had run. They now group by `level`, falling back to `log_level` and then to `(none)`, so a line in any log format is counted. On the first real-data backfill — HANA audit logs for 2026-01-01 and 2026-01-02, 794 events — the old search returned nothing and the new one returns the input's 187 log lines, all `INFO`.

The troubleshooting search in the three AWS setup guides had the same flaw: `log_level IN (ERROR,WARN)` matched nothing, because the add-on writes `level` and names the warning level `WARNING`. It now reads `level IN (ERROR,WARNING)`; on the reference system it finds 408 errors and 126 warnings over 30 days, where the old form found none. The step-by-step lists in those guides now render as lists; they had rendered as code blocks, bold markers and all.

### :material-circle-box:{ .taiconcolor } Data TA — long NDJSON lines are unwrapped and kept whole (2026-09-24)

Each LogServ line arrives wrapped in an NDJSON envelope, and the index-time transform `[set_raw_only]` keeps only its `_raw` string. On long lines carrying many escaped characters — from about 1.5 KB, common in some Azure-delivered logs — the transform's regex exceeded Splunk's PCRE depth limit, and the event was indexed with its envelope still on (about 400 events an hour on the affected forwarder). Lines longer than 10,000 bytes were also cut by the default `TRUNCATE`, which took their timestamp with them when `_raw` came before `_time`.

`[set_raw_only]` now uses a possessive pattern that finds the same match at bounded depth; `TRUNCATE = 100000` on `[sap_logserv_logs]` lets lines up to 100,000 bytes through whole; and `LOOKAHEAD = 100000` on `[set_raw_only]` lets the transform reach the end of such a line — an index-time transform searches only the first 4,096 characters by default and misses a longer match silently. Since the fix the heavy forwarders log no regex errors and no truncations, no event arrives wrapped, and the longest line seen (about 52 KB) indexes whole. The fix applies to data parsed after the Data TA is updated on the heavy forwarders; events indexed earlier keep their envelope.

### :material-circle-box:{ .taiconcolor } Data TA — AWS S3 Direct backfills by dashboard (2026-09-24)

The AWS S3 Direct screen no longer asks for a key prefix. You pick the **Dashboard Data rows** to backfill — the same 25 rows as the App's **Settings → Dashboard Data** — and **Scan from / Scan until** as UTC dates, inclusive and at most 366 days apart. The dates select the date folders in the S3 key, not the objects' upload time. The screen creates one Generic S3 input per folder and year, limited to the chosen days and set to stop by itself 24 hours after it is created; it skips days its own earlier backfills already cover, and it leaves out folders or days the TA's filters would discard on arrival, saying why. The list groups the inputs by backfill job, with **Enable all**, **Disable all** and **Delete all**, and two searches per job: one shows whether its inputs scanned, the other counts the events they indexed. After creating a backfill, backfill the same rows and dates in the App so the dashboards pick the events up. Prefer **Disable** to **Delete**: a deleted backfill no longer counts as covering its days.

Inputs created here are stamped `cloud_provider = aws` through the Data TA's own endpoint, `/services/splunk_ta_sap_logserv/s3_direct_meta` — POST only, run as the signed-in user, and limited to the inputs this screen names. Enable and Disable go through the add-on's own endpoint. The Data TA published on 2026-09-20 made both calls to the add-on's native `data/inputs/aws_s3` endpoint, which Splunk Web does not pass through, so from the browser its Enable/Disable failed and no input was stamped. Tested with the Splunk Add-on for AWS 8.1.0. See [AWS Direct S3 Polling — Backfill and Recovery](../install-setup/aws-direct-s3-polling.md).

### :material-circle-box:{ .taiconcolor } Azure and GCP add-ons - Splunk Cloud installs them on a search head too (builds 1792558069 and 1792558072, 2026-10-21)

Both add-ons' `app.manifest` now declares the search-head workload (`_search_heads`, and search head clustering) beside the forwarders, so Splunk Cloud no longer refuses them on a search head. A heavy forwarder stays strongly recommended: an input puts its ingest load on the instance that runs it. `README.txt` and the Inputs page say so, and `README.txt` describes search head clusters, which do not replicate inputs: an input runs only on the member where it was created. Their code is unchanged: every Python file is byte-for-byte that of builds 1792213309 and 1792213464. See [Running the TAs on a search head](../install-setup/install-ta.md#running-the-tas-on-a-search-head).

### :material-circle-box:{ .taiconcolor } Azure and GCP add-ons - third-party notices and exact pins (builds 1792213309 and 1792213464, 2026-10-17)

Both ingest add-ons now ship `THIRD-PARTY-NOTICES.md`, naming the nine Python packages in their `lib/` folder with their licences, and their `lib/requirements.txt` pins each package's exact version and PyPI file hashes, so a rebuild cannot pick up a newer release unseen. Their code is unchanged: every Python file, the add-ons' own and those of the bundled libraries, is byte-for-byte that of the previous 0.1.2 builds, so a heavy forwarder running those needs no update. `README.txt` now describes each add-on correctly; the GCP add-on's described Azure's resources and input. See [Third-Party Software](third-party-licenses.md#python-packages-in-the-add-ons).

## Version 0.1.1

### :material-circle-box:{ .taiconcolor } Compatibility

|                                  |                              |
|----------------------------------|------------------------------|
| Splunk platform versions         | 9.4.3 and later              |
| CIM                              | 5.0.0 and later (per `app.manifest`) |
| Supported OS for data collection | Platform independent         |
| Vendor products                  | SAP LogServ for SAP ECS in Amazon Web Services (AWS), Microsoft Azure, and Google Cloud Platform (GCP) |
| Published App artifact           | The **full-LLM build variant** — the free-form LLM path is present but inert until an LLM provider credential is configured; predefined prompts + MCP dispatch work with no credential (see [Build Variants](../ai-assistant/templates-only-build.md)) |
| AI Assistant prerequisite        | [Splunk MCP Server (Splunkbase App 7931)](https://splunkbase.splunk.com/app/7931) v1.0.3 or later and below v3.0.0 — the 2.x major is supported as of App build 335; v1.1.0+ recommended — on the search head where the LogServ App is installed |
| Azure ingest                     | A dedicated first-party add-on — **Splunk TA for SAP LogServ on Azure** (`splunk_ta_sap_logserv_azure`), installed per Heavy Forwarder |
| GCP ingest                       | A dedicated first-party add-on — **Splunk TA for SAP LogServ on GCP** (`splunk_ta_sap_logserv_gcp`), installed per Heavy Forwarder |

### :material-circle-box:{ .taiconcolor } Data TA — the `days_in_past` guard now fires at the prefix depth the screen recommends (2026-09-18)

The AWS S3 Direct screen blocks a key prefix whose events the forwarder's own `days_in_past` filter would discard on arrival — the check that stops you creating an input which ingests nothing and reports success. It reads the date partition out of the prefix, and it required all six path segments (`logserv/<clz_dir>/<clz_subdir>/<YYYY>/<MM>/<DD>/`), while the screen's own depth gate admits **four** and both its message and the field help recommend exactly four. An operator who followed the screen's advice produced a prefix the guard could never evaluate — and the same blind spot silenced the SQS double-ingest warning for any prefix coarser than a single day.

The check now reads a year, month or day partition, and both callers reason about the **newest** instant the partition can contain:

- a `<YYYY>/` prefix wholly behind the cutoff now blocks, where it was previously accepted unexamined;
- a prefix for the year still being written does **not** block on account of its January — deciding on the oldest instant instead would have produced exactly that false block;
- a year-wide prefix now raises the SQS overlap warning it could not raise before;
- a month out of range (`2025/13/`) and a day that would roll into the next month (`2025/06/31/`) are refused rather than silently widened to a date you never wrote.

The day-level message is word for word the one that already shipped, so nothing changes for a prefix that already worked. See [AWS Direct S3 Polling — Backfill and Recovery](../install-setup/aws-direct-s3-polling.md).

### :material-circle-box:{ .taiconcolor } Splunk MCP Server 2.x support, and the published artifact returns to the full-LLM build (build 335)

The AI Assistant refused to operate against **Splunk MCP Server (Splunkbase App 7931) v2.0.0**: a site that installed the current MCP Server saw an “uncertified version” panel in place of the Assistant. The App carries a deliberate upper bound on the MCP Server version — a supply-chain guard, because a major release is free to rename tools or reshape the request/response envelope, and the bound turns a silent degradation into a clear message. That ceiling moves from **2.0.0 to 3.0.0**, so the whole 2.x major is now accepted. Unchanged: the **v1.0.3 floor** (CVE-2026-20205) and the fail-closed handling of an absent or unparseable version string. **3.x** becomes the new ceiling.

What the change rests on is worth stating plainly. The connection handshake is verified against 2.0.0 in the field — the health probe reads the server version only after the connection succeeds, so seeing the “uncertified” panel at all proves that the transport, the authentication and the protocol handshake were accepted. The tool-listing and tool-call shapes have since been verified too, by a manual check against a live 2.0.0 server: the tool names the Assistant dispatches and the result envelope it reads were both unchanged by that major. Two bounds on that — it is a spot-check of **2.0.0**, not an automated regression suite, and it says nothing about later 2.x minors. On a 2.x minor you are the first to run, run one predefined prompt and confirm the result tile carries data.

This build is also the point at which the published App artifact returns to the **full-LLM build variant** — see [Build Variants](../ai-assistant/templates-only-build.md) and the upgrade note in [Upgrading](../getting-started/upgrading.md).

### :material-circle-box:{ .taiconcolor } Data TA — the AWS S3 Direct screen, for backfill and recovery (2026-09-11)

The Data TA gains a screen — **Splunk Web → *Splunk TA for SAP LogServ* → AWS S3 Direct** — that creates and manages LogServ-scoped **Generic S3** inputs inside the Splunk Add-on for AWS from the browser, as the signed-in user. It adds no Python, no REST handler and no capability of its own.

Generic S3 polls a bucket prefix directly, with no queue. It is a **secondary** channel — backfill, a bucket with no SQS notifications configured, and recovery after an outage — and SQS-Based S3 remains the steady-state path. The screen exists because the add-on's own input form is effectively closed to most operators: its bucket dropdown is populated by `list_buckets()`, which requires the unscopable `s3:ListAllMyBuckets`. The screen asks for the bucket name instead, so the input can be created with only the scoped actions a run actually needs — and **`s3:ListBucket` is the one people miss**, because the SQS-Based S3 path never requires it.

Two things about this input surprise people, and the screen guards both:

- **The key prefix selects the events; the scan-window dates bound the S3 object's `LastModified` — its upload time, never the event time.** A re-staged archive can hold 2025 events in objects written in 2026, so a scan window narrowed to the event dates selects nothing and the run reports success having fetched none. Scan-from therefore defaults to a floor of `2000-01-01T00:00:00Z` and the prefix does the selecting.
- **A blank scan bound is not rejected by the add-on** — an empty scan-until means *unbounded*, and an empty scan-from means *the last seven days*. The screen requires both, offers them as UTC calendar controls, validates as you type, and re-checks before writing.

The scan floor is `2000-01-01T00:00:00Z` rather than the Unix epoch for a concrete reason: **Splunk's own `search/timeparser` rejects every 1970 date.** The add-on validates these dates locally when the input is created but resolves them through that parser on every poll, so a 1970 floor saved cleanly and then failed on every subsequent poll — a silent input that never collected anything and could not be repaired from the form. The screen refuses any date before 1971.

See [AWS Direct S3 Polling — Backfill and Recovery](../install-setup/aws-direct-s3-polling.md).

### :material-circle-box:{ .taiconcolor } String-accuracy pass from the zero-trust docs audit (build 334)

Eight string/label defects surfaced by the 2026-08-18 zero-trust documentation audit, all string/comment/conf-level with no logic change: the three Settings-page strings (and two shipped-conf comments) that still named the audit index by its retired pre-rename form now say `logserv_ai_assistant_audit`; the Environment Topology Live Activity caption now reads "Top N busiest edges" (the table lists the busiest edges of any integration type, not just RFC); the Network Perimeter activity chart title no longer claims a log-scale y-axis; the Host Details "Windows Event Codes" subtitle no longer claims a top-15 cap (the table paginates all event codes); the ES Risk Notable's description now says it aggregates the SAP-side detection searches (its SPL reads all of them, not just the original five correlation searches); the two behavioral-anomaly notable descriptions now describe the daily scan of hourly buckets since the start of the previous day instead of "the most recent hour"; the templates-only Settings banner branches on the build flag, so a templates-only build no longer instructs admins to toggle off a mode that is fixed at compile time; and `collections.conf` types the `mcp_timeout_seconds` field so the setting round-trips typed like its sibling fields.

### :material-circle-box:{ .taiconcolor } elkjs license attribution restored in the shipped notices (build 333)

The Environment Topology layout engine `elkjs` (EPL-2.0) has been bundled since the topology's ELK layouts shipped, but its entry was missing from the generated `THIRD-PARTY-NOTICES.md` — the package was never formally declared as a dependency, so the notices generator (which walks the resolved workspace `node_modules`) skipped it. Build 333 declares the dependency properly; the shipped notices now carry the `elkjs@0.11.1` section with the full EPL-2.0 license text (1236 packages, up from 1235). No functional change — the bundled elkjs bytes are identical. See [Third-Party Software](third-party-licenses.md). Found by the 2026-08-18 zero-trust documentation audit.

### :material-circle-box:{ .taiconcolor } Release packaging — templates-only canonical App; all four artifacts at version 0.1.1 (2026-08-18)

!!! note "Superseded on 2026-09-14"
    The templates-only packaging decision recorded here was reversed in build 335 — the published App artifact is the **full-LLM build variant** again. The version alignment of all four artifacts at 0.1.1 still stands. See the build 335 entry above.

At the time of this release the published v0.1.1 App tarball was the **templates-only build variant** of the current build: the AI Assistant's full predefined-prompt catalog (via the Splunk MCP Server) is fully functional, and the free-form LLM path is **disabled at compile time** — no runtime setting, including a stored `templates_only_mode = 0` from a previous LLM-enabled install, can re-enable it (see [Templates-only Build Variant](../ai-assistant/templates-only-build.md)). The regular, LLM-enabled build of the same source and build number remains available as an archived variant for approved deployments. In the same release pass, the **Data TA was rebuilt** as a canonical 0.1.1 artifact (functionally identical to its predecessor), and the **Azure and GCP ingest add-ons moved from their independent `0.0.6` versioning to `0.1.1`** — their tarball filenames change accordingly (`splunk_ta_sap_logserv_azure-0.1.1.tar.gz`, `splunk_ta_sap_logserv_gcp-0.1.1.tar.gz`) with no functional change. All four artifacts pass AppInspect Cloud-mode precert with 0 errors / 0 failures at their historical baselines.

### :material-circle-box:{ .taiconcolor } Topology top-5 High Traffic SIDs + legend declutter; Data Doctor copy + open-in-search on the rollup SPL (builds 331–332)

In the diagnostic drawer's *Rollup-populating saved searches* section, each printed saved-search definition now carries two corner actions on the SPL block: **copy to clipboard** (copies the definition verbatim) and **open in the Search app**, which opens the SPL in a new browser tab scoped to the diagnosed time window. The opened search has its terminal `| outputlookup` write **removed first** — run verbatim over an arbitrary window, an aggregation search would upsert partial bucket rows over correct summary rows, and the drawer never offers a control that can change data. When the write cannot be removed with certainty the open action is simply not rendered (the copy always is), and a build-time check proves the removal against every shipped aggregation search's definition on every release.

The **High Traffic SID** classification now marks the top **five** SAP systems by total incident calls (was ten since build 324); every other SAP system is **Regular Traffic SID**. Remote partners are unaffected. The ranking mechanics are unchanged — data-derived at render time, SAP systems only, inbound + outbound + bidirectional calls all count — and on an estate with five or fewer systems every SID is still High Traffic.

The partner donuts' legend rows also dropped their per-row **ownership badge** (user feedback: confusing). Because the graph folds every inventory-attributed address into its owner's node, "owner not established" was the only verdict a legend row could ever show — a uniform column of it carried no information. Legend rows now show the endpoint and its call count; ownership badges continue to render where the verdict can actually vary (the Hosts tab rows and the Edge Details "By app server" table), and the underlying inventory is unchanged.

### :material-circle-box:{ .taiconcolor } Environment Topology — hostname + user names on IP endpoints (build 330)

The square partner nodes labelled with raw IP addresses can now say **who and what is behind the address**, straight from the logs. When the evidence exists, a square renders up to two extra lines under its IP — the machine's **hostname**, and a **user line** (the name when exactly one distinct user was seen from that address, a count like "7 users" otherwise, with the full list on hover) — and the Details panel's Overview gains matching rows under the Tag: **Hostname** (with its evidence source), **Users** (every name, grouped by source — HANA audit, Windows logons, SAP start service, SSH sessions) and **Names as of** (how fresh the mapping is). The evidence is same-event only: HANA audit client registrations carry the client host name and the executing DB user next to `client_ip`; Windows **4624 successful-logon** events carry `WorkstationName` and `TargetUserName` next to `IpAddress` (failed logon guesses deliberately claim nothing, and a workstation name is only trusted when it differs from the logging host itself — for interactive and service logons the field names the *local* machine); SAP start service authentication lines carry `user(...)` and the remote address on one line; and Linux `sshd` session lines carry the user and source IP. Ambiguity **suppresses rather than guesses**: a hostname renders only when the IP maps to exactly one machine name (short name + FQDN count as one) and that name is not claimed by a crowd of addresses, and gateway logs are deliberately excluded as a source (their peer-IP and partner-hostname lines never co-occur on one event, so correlating them would be guesswork). The mapping is **"latest known"** — refreshed daily into a new `logserv_topology_ip_enrichment` KV Store collection (folded into the Environment Topology (graph) rollup in Settings → Dashboard Data, so Clear + Backfill cover it) and deliberately not scoped to the time-range picker, so names do not blink out on narrow windows. The build also fixed a self-inflicted deployment lesson worth recording: the new *daily* aggregation search is single-pipeline rather than the usual `| union` shape, because a 30-day daily scan in a union's non-first arms would silently truncate at scale — and its first draft carried a literal `search` prefix, which a *saved* search treats as a search **term** (saved searches prepend search context themselves), silently matching only events containing the word "search"; caught in live verification, fixed before promotion.

### :material-circle-box:{ .taiconcolor } Environment Topology — group select and move (builds 326–328)

The topology canvas now supports moving a whole cluster at once. Hold **Shift and drag** on empty canvas to draw a selection box — every node it touches joins the group and gains a **dashed outline** (deliberately neutral ink, so it can never be misread as a health signal or an edge colour), a status chip at the canvas top-right shows the count, and **dragging any highlighted node moves the whole group rigidly**, edges following their nodes. **Shift/Ctrl/Cmd + click** adds or removes a single node; a **plain click** inspects a node in the Details panel and releases the group; **Escape** or an empty-canvas click clears it; **arrow keys** nudge a focused group; with **Snap mode** on, release applies *one shared* grid offset so the group's shape is preserved. Group moves mark the layout Unsaved and are captured by Save Layout like any drag, including keyboard nudges; the group survives data refreshes and time-range changes. Plain drag on empty canvas still pans — nothing about the existing gestures changed. Group membership is announced to assistive technology (`aria-selected`), keyboard focus regained a visible ring (the imported canvas library removes it), and the canvas's screen-reader instructions were corrected to the real key set. Under the hood the change also retires two latent hazards: the canvas library's **Backspace-deletes-selected-nodes** default is now explicitly disabled, and its built-in selection rectangle — which silently swallowed clicks over the selection's bounding box — is suppressed in favour of the per-node outlines. Adversarially reviewed before implementation (three lenses over the design against the installed canvas-library source; 33 findings including 3 blockers, all folded — among them: the snap pass would have deformed the group by rounding each member independently, a duplicate drag handler would have written NaN positions, and group drags would have rubber-banded through the canvas's 600 ms glide animation). The rendered verification pass then surfaced two follow-up fixes shipped as builds 327 and 328: the HANA-tenant circles' bottom chip had overlapped their health ring since the build-324 tenant redesign (tenants are the one node variant whose name renders inside the disc, so the chip sat directly under the ring at the shared 2 px margin — it now clears at the SID label's 22 px), and Escape initially never cleared the group because Splunk Web keeps a permanently-mounted *hidden* "Disconnected from Splunk server" dialog in the DOM, which the handler's any-dialog guard mistook for an open modal — only a *visible* dialog now owns Escape.

### :material-circle-box:{ .taiconcolor } Environment Topology — High/Regular Traffic SIDs, node icons, host + app-server visibility (builds 324–325)

The SID classification, the node visuals, and two long-standing "what exactly am I looking at" gaps were reworked:

1. **High Traffic / Regular Traffic SIDs** — the classification formerly labelled "Focused SAP SID" is now purely data-derived: the view ranks SAP systems at render time by the **total calls touching them** (inbound + outbound + bidirectional) and marks the top ten **High Traffic**; every other SID is **Regular Traffic**. Only SAP systems compete for the slots — a high-volume client IP can no longer occupy one — and the last hard-coded seed is gone from the aggregation searches (stored rows are classification-neutral; old rows read identically). On estates with ten or fewer systems every SID is High Traffic, by design. Both kinds render at the same large size with the health halo; the Systems-panel highlight now means High Traffic.
2. **Node icons + tenant circles** — every SAP system circle carries an interior icon (an app-server rack for application systems, the database cylinder for database systems), HANA **tenant databases** render as full-size circles with a combined app-servers + database icon and the tag "APP SERVERS - HANA TENANT" (chip: "HANA TENANT"), and horizontal dividers now separate every section in the right panel's tabs.
3. **Host + instance visibility** — hovering a SAP system shows a **Hosts** row (distinct hosts that logged its events in the window), the panel Overview gains a **"Hosts (in range)"** fact, and the Hosts tab lists the SAP **instance numbers** seen on each host (`inst 00, 01`). All three read the same hourly rollup as the Hosts tab itself, so the numbers agree; on a tenant node the count is scoped by the tenant's shared name and the panel says so inline.
4. **RFC per-app-server accuracy** — RFC rollup rows are now keyed **per SID-side gateway listening address** (`local_ip`), fixing a latent last-write-wins collision in which a multi-app-server SID's RFC call counts undercounted whenever two of its app servers served the same partner in the same hour. The Edge Details Overview gains a **"By app server"** table splitting each RFC edge's calls and errors by app-server address, with inventory owner badges. The rows partition the edge's calls, so they sum to the *Calls in window* fact above them.

!!! warning "Upgrading an existing install — the topology graph rollup needs a one-time Clear + Backfill"
    The per-app-server change **re-keys the topology graph rollup's RFC rows**. After upgrading, run **Clear** and then **Backfill** once on **"Environment Topology (graph)"** in Settings → Dashboard Data. Running Backfill *without* the Clear would double-count RFC history (the old collided rows survive next to the new per-app-server rows), and the panel's completeness check will otherwise skip the rollup as already complete. Until the migration runs, RFC calls recorded before the upgrade appear as "(not recorded)" in the By-app-server table and keep the pre-upgrade undercount.

    **The Clear discards topology graph history older than the 30-day backfill window** (the graph retains up to 365 days). On installs older than 30 days, prefer the surgical RFC-only migration, which keeps everything else:

    1. Delete only the collided rows: `DELETE /servicesNS/nobody/splunk_app_sap_logserv/storage/collections/data/logserv_topology_edges?query={"type":"rfc"}` (management port, admin credentials).
    2. Re-run only the RFC arm: from the `[logserv_topology_backfill_edges]` search in `default/savedsearches.conf`, keep the single `sourcetype=sap:abap:gateway` sub-search plus everything after the last `]`, and dispatch it as a normal search over your full raw-data span.

    New installs are unaffected — the standard first-install backfill produces the new keys directly. The Hosts-tab **instance numbers** need no clear: they populate going forward from the hourly aggregation, and a plain Backfill (no Clear) on "Environment Topology (detail tabs)" fills the last 30 days immediately; host rows aggregated before the upgrade simply show no instance list until then.

### :material-circle-box:{ .taiconcolor } Environment Topology — the right panel says what it means (builds 322–323)

Three things the node panel showed but never explained. Each is now stated on
the panel itself.

- **"Which of these IP addresses are my system's own?"** — none of the ones you
  can see, and that is by design. An address the inventory attributes to a
  system is folded into that system's node before the graph is drawn, so an
  address still shown separately is one no system has claimed. Every endpoint on
  the partner charts and the Hosts tab now carries that verdict — `owner: XCP`
  or `owner not established` — with the caveat stated inline that ownership
  comes from an inventory which is **not** limited to the selected time range.
  "Owner not established" is the expected reading on the partner charts, not a
  fault, and the panel says so.

- **"Is 'Top partners' inbound or outbound?"** — it was both, summed. It is now
  **two charts**, one per direction, each listing *every* partner with its exact
  call count. There is no "other" bucket and the legend is not capped, so a
  system with many partners makes the panel taller rather than the list shorter.
  **Hover any slice** for its endpoint, exact count and share of the total —
  worth reaching for on the small ones, because a slice too small to be visible
  is drawn slightly larger so it does not disappear, and the panel says so
  whenever that has been applied. Exact per-direction totals were
  added to the facts table so the charts reconcile against the headline, and
  traffic the data records as **bidirectional** (HANA Tenant) is counted on its
  own line instead of being assigned a direction the record denies.

- **"What are the hosts on the Hosts tab to this system?"** — they are the
  system's own hosts, which is why the inbound/outbound split you might expect
  does not apply to them. Instead, a new **Calls by host and edge type** table
  sits beneath: it names a receiving host wherever the data supports one, and
  falls back to an edge-type row where it does not, so it accounts for **all**
  of the node's calls and can be checked against the Total calls figure on the
  Overview tab.

The Hosts read was also silently capped at 20 rows while the caption reported
that cap as the host count; the cap is now 100, and when it is reached the panel
says so. Three chart-rendering defects that the previous four-partner limit had
been hiding are fixed at the same time: very small slices rendered as background
while their legend row still claimed a colour, a single-slice chart drew nothing
at all, and an empty one asserted "0 calls" as if it were a measurement.

!!! note "Where the numbers come from"
    Nothing here adds a search or a scheduled job. The traffic breakdown is
    computed in the browser from the same hourly rows that already produce the
    node's totals, which is what lets the two reconcile exactly. The one search
    change is an added `eventstats` inside the existing Hosts read, so the panel
    can tell how many hosts exist beyond the ones it is showing.

### :material-circle-box:{ .taiconcolor } Environment Topology — the Edge Details tabs work again (build 321)

Selecting an edge on the Environment Topology canvas now populates its detail
tabs. Since build 240 the four tabs had shown "no events for this edge" for
every edge on every time range: the view passed the *rendered* edge's key —
a composite of its two endpoints and its type — to searches that accept only
the *stored* edge id, so each search was rejected before it ran and nothing was
ever dispatched. The headline figures on the Overview tab came from data
already in the browser, which is why the pane still looked alive.

- **Operations, Performance and Errors** now read the hourly topology rollup
  scoped by the stored ids behind the edge you clicked. Where inventory
  retargeting collapses several underlying edges into one on the canvas, the
  tabs cover all of them; in the rare case that an edge spans more underlying
  edges than one search may address, the tab says how many it covered rather
  than quietly showing a partial total.
- **Activity** is no longer a search at all — it is computed from the same rows
  that produce the Overview totals, so the "successful calls + errors" legend
  is an exact decomposition of "calls in window". Previously the two were
  resolved over slightly different windows.
- **Empty tabs now explain themselves.** A tab that was queried and came back
  empty reads differently from one that could not be queried, so a silent
  failure of this kind cannot hide again. Note that RFC edges legitimately have
  no Operations or Performance rows — those fields are absent from gateway
  events.
- **Three labels corrected on surfaces this made visible again**: the HANA
  Tenant performance chart is titled mean and maximum rather than percentiles
  (percentiles cannot be merged across hourly buckets), the HANA Audit Overview
  row is labelled "Auth failures (CONNECT)" to distinguish it from the broader
  Errors tab, and two RFC performance cells that no search has ever populated
  were removed.

A build-time check now derives the stored id's shape directly from the shipped
searches and refuses to build if the interface stops matching, so this class of
mismatch cannot return unnoticed.


### :material-circle-box:{ .taiconcolor } Data Doctor — rollup SPL in reports + full-length raw samples (build 320)

Two report/drawer enrichments for support workflows:

- **The full SPL of the saved searches that populate a rollup** now appears in the panel
  diagnosis drawer's technical detail, in Copy technical summary, and in the panel and
  dashboard PDFs. Each entry is attributed by its parsed `outputlookup` target (never
  guessed from the registry — the multi-collection rollups made that distinction matter),
  carries its cron schedule verbatim and its last-modified timestamp, and sits under a
  pinned intro stating the SPL is current configuration that was **not** run by the
  diagnosis. Each aggregate names its install-backfill stanza with an "as shipped, the
  search text is identical" note whose premise a build-time check derives from the shipped
  configuration on every release. The dashboard PDF's section is de-duplicated and covers
  every rollup the dashboard reads — healthy panels included; unreadable entries render
  their reason plus an explicit "N of M could not be read" completeness line.
- **Raw event samples are no longer truncated to 500 characters** — each opt-in sample is
  included in full, up to a disclosed 20,000-character safety ceiling (twice Splunk's
  default per-event truncation). The ceiling is applied *before* redaction (whose e-mail
  matcher is now bounded — linear on any input), the credential scrubber gains
  space-delimited SQL/CLI secret shapes (`PASSWORD "x"`, `IDENTIFIED BY x`, `-P x`,
  `-pXxx`, `--password x`), and the samples section + cover banner state that the PDF's
  Latin-1 font may not render every character — the `.json` twin carries the exact text.
  Reports stored by earlier builds remain re-downloadable (the persistence shape check
  accepts the prior banner wording).

### :material-circle-box:{ .taiconcolor } Data Doctor — operator-supplied evidence refinements (build 319)

The operator-supplied ingest-filter evidence (the Diagnostics-page paste) is sharpened on five
fronts:

- **Replay/backdate-proof out-of-date detection** — the "supplied configuration may have
  changed" check now also compares *index time* (from bucket metadata), so replayed events
  with old timestamps no longer evade it; a five-minute clock-skew grace prevents false
  contradictions, and the index-time signal only ever softens a verdict (to *possible*), never
  silences the diagnosis.
- **Days-in-past corroboration** — the "dropped by design" verdict now reports whether
  anything older than the cutoff exists in the index at all (from the same bucket-metadata
  probe, at zero extra search cost), with deliberately non-committal wording when nothing
  older exists: a filter, a young index and ordinary retention are indistinguishable there.
- **A sliding-cutoff context line** on "never received" / "newer data exists" / "may have
  stopped" verdicts whose window ends before the supplied cutoff — the cutoff is surfaced
  without over-claiming it as the cause.
- **The Cloud Provider stamp rides the paste** — a `local/transforms.conf` or settings-conf
  paste records the Data TA's configured `cloud_provider` stamp, and provider-filtered panels
  explain how it interacts with their Cloud filter (including the `aws`-matches-unattributed
  nuance). Stored in the facts row (new `cloud_provider_stamp` column), shown in the page
  summary and in every report's supplied-filters section.
- **A drawer pointer** — when a panel diagnosis lands on an ingest-ambiguous verdict with no
  usable configuration supplied, the drawer (and its *Copy technical summary*) now points at
  the Diagnostics-page paste.

Also fixed: transforms-paste pattern recovery now inverts every `re.escape`d character (a
hyphen-bearing include/exclude pattern previously mis-recovered), lists clamped on read are
marked approximate, and a per-probe runtime cap is no longer dropped by the dashboard sweep's
probe deduplication.

### :material-circle-box:{ .taiconcolor } Data Doctor — partial-data diagnosis: blank columns and zero values (build 318)

Missing data is not always an empty panel. The Data Doctor now diagnoses panels that **have**
data — a table with rows but a blank column, or a KPI stuck at a zero you believe should not be
zero — with two new entry points that work on populated panels:

- Every chart and table panel's toolbar gains a fifth icon, **Diagnose this panel**, opening the
  diagnosis drawer under a **"Panel diagnosis"** header (the empty-panel header remains *"Why is
  this empty?"*).
- Every KPI card gains a corner diagnose control, revealed on hover or keyboard focus. On a card
  showing a zero (formatted zeros like "0 ms" count) it routes into the new zero-value
  resolution.

What the partial-data diagnosis adds:

- **Column coverage.** The table reports which displayed columns are blank — as **counts only,
  never values** (nothing from your rows leaves the panel). Each fully-blank column is traced to
  the raw-event field it displays (through any renames in the query) and corroborated against a
  sample of the source events, distinguishing *"the field is not populated on the source events
  at all"* (a search-time-extraction gap) from *"the source events carry it but the summarised
  rows do not"* (a summarisation gap — the backfill settles it) from *"the aggregation provably
  does not store that column — a backfill cannot add it."* Columns computed inside the query, or
  drawn by a custom renderer, are honestly set aside rather than probed.
- **Zero-value resolution.** A zero KPI is reconciled against the summarised layer and — when
  the panel's raw equivalent emits a single comparable value — a live raw computation.
  Summarised rows that genuinely sum to zero, or an agreeing raw equivalent, certify *"the value
  genuinely is zero"* (never a backfill prescription); a disagreeing raw equivalent is reported
  as a **possible** summarisation gap, never a confirmed fault.
- **The honest floor.** When every displayed column is populated and accounted for, the
  diagnosis says so — *"no defect found"* — and the floor is unreachable while any column could
  not be checked (those are named instead).

A populated panel's rows are living proof the read path works, so the emptiness checks are
skipped with explicit *"Not applicable — this panel returned data"* ledger notes; a panel that
has not finished loading is refused with a plain explanation rather than diagnosed on unknown
facts.

### :material-circle-box:{ .taiconcolor } Data Doctor — deep evidence: cache reconciliation, field probes, clause bisect (build 317)

The Data Doctor's check catalogue is complete. Four deep checks now run **in the panel diagnosis
drawer only** (never in a dashboard sweep — they are the only probes allowed to scan raw events):

- **Summarised-vs-raw reconciliation.** An empty panel that reads summarised data is re-run as
  its exact raw-query equivalent over the already-summarised period. If the raw query returns
  rows the summary lacks, the diagnosis is the **confirmed** *"the summary appears to be missing
  data it should have"* (re-run the backfill); if both agree there is nothing, the diagnosis is
  the health-certifying *"there is genuinely nothing to show"*. Only panels whose raw equivalent
  groups results carry this signal — a scalar count is skipped with an honest note.
- **Field presence probe.** A raw panel that filters on a field is checked against a sample of
  its own sourcetype's events: a field populated on **zero** sampled events reads as a likely
  search-time-extraction gap (*"this field is not populated"* — a missing add-on or broken
  props chain), and a populated field whose expected value never appears reads as a possible
  vocabulary/casing drift (*"none of this panel's expected values appear"*).
- **Clause relaxation.** For an empty raw panel, each filter clause is removed in turn (after a
  control probe confirms the emptiness is in the base search): the diagnosis names **which
  clause excludes every event** and how many events removing it would match.
- **Lookup registration.** A panel using a non-summarised lookup verifies it is registered on
  the search head (a CSV under `default/lookups/` does not register — only the app-root
  `lookups/` directory does).

The environment **report**'s rollup table gains a "Recent buckets" bucket-continuity column
(context only — the live Diagnostics page deliberately omits it), and cached verdicts under a
Cloud Provider filter now state whether any summarised rows carry that provider at all.

Build 317 also fixes a live defect found during this work's review: the Environment Health
dashboard's sub-hour raw queries still used a retired field name (`audit_action`), silently
dropping every HANA failed-CONNECT from the Auth Failures KPI at ranges under 90 minutes and
leaving the Recent Critical Events "Detail" column empty for HANA rows. Both now read the
correct `action_type` field.

### :material-circle-box:{ .taiconcolor } Data Doctor — operator-supplied ingest evidence (build 314)

The Data Doctor closes its own biggest declared boundary: the Data TA's ingest-tier filters
(include/exclude + days-in-past), which run on the Heavy Forwarder / indexer tier and are
invisible from a search head. The **Platform → Diagnostics** page now prints the exact command
to read them, accepts the pasted output (REST JSON/XML, the generated `local/transforms.conf`,
or the settings conf), credential-scrubs and parses it, and stores it as operator-supplied
evidence. Two new diagnosis verdicts consume it: *"Events this old are discarded at ingest by
design"* (window vs the days-in-past cutoff) and *"`<log type>` events are excluded at ingest
by the configured filter rule `<rule>`"* (the include/exclude reconciliation) — each carrying a
*"Recorded as supplied by \<user\>, \<date\>"* provenance line, hedged when the supply is
stale, approximate or partial, and standing down entirely when observed events contradict it.
Reports gain an "Ingest-tier filters (supplied by operator)" section and a machine-readable
`ingestFacts` block; a paste matching a Heavy Forwarder's shipped-defaults shape is flagged
rather than trusted. One new KV collection (`logserv_diag_ingest_facts`, a fixed single row,
no scheduled searches). See
[Supplying the ingest-filter configuration](../logserv-app/dashboards/platform/diagnostics.md#supplying-the-ingest-filter-configuration).

### :material-circle-box:{ .taiconcolor } Data Doctor: platform snapshot, data coverage, raw samples, drawer polish (builds 315–316)

The Data Doctor's deferred capabilities are now built:

- **Platform health snapshot (Tier B).** A new hourly scheduled search, `logserv_diag_platform_aggregate` (two minutes past each hour), copies scheduler outcomes and skip/deferral reasons, search-concurrency warnings, per-index throughput, pipeline-queue depth and PCRE-limit events from `index=_internal` into the world-readable `logserv_diag_platform_snapshot` KV collection — so a **non-admin** diagnosis can see platform health. The Diagnostics page and the environment report render it as a Platform-health section; when the snapshot is stale, empty or unreadable, the section says **NOT AVAILABLE** with the verified reason rather than guessing. A stale dashboard summary's diagnosis can now carry a scheduler-skip evidence line — always provenance-badged ("recorded by the hourly platform snapshot, a collection any authenticated Splunk user can write") and never able to raise the verdict's confidence. A daily retention search (`logserv_diag_platform_retention`) trims the collection to 30 days. The hourly cron slot was freed by moving the four ES behavioral-anomaly searches from `:02` to `:30` of hours 02–05 (behaviourally neutral — their analysis windows are snapped in SPL).
- **Data coverage in the environment report.** A daily event-volume chart (ASCII, up to the most recent 60 days), the `clz_dir`/`clz_subdir` distribution **with its coverage denominator** (events without the routing metadata are called out, not hidden), and per-host counts.
- **Opt-in raw event samples in the panel report.** The diagnosis drawer's Download PDF gains an "Include raw event samples" checkbox (default off, never sticky): up to 5 recent events of the panel's sourcetype(s), credential-scrubbed and email/user-redacted, truncated to 500 characters _(superseded in build 320 — samples now ship in full up to a 20,000-character ceiling; see above)_, clearly labelled as **not** filtered by the panel's own host/provider selections. The report's cover banner states the samples' presence, and a sample-bearing report is **download-only — never saved** to the Saved-reports list (storing raw events in a world-readable collection would bypass index access controls).
- **The drawer now closes on any route change** — browser Back **and** in-app navigation — closing the long-documented C10 quirk.
- **PDF text fidelity.** The `→` arrow rendered as mojibake in every generated PDF (the standard PDF fonts are cp1252-only); it is now ASCII across every report string, with a permanent build gate preventing regressions.
- The shipped scheduler layout is now verified by a permanent build gate: **every enabled scheduled search occupies its own (hour, minute) slot — zero cron collisions.**

### :material-circle-box:{ .taiconcolor } The LogServ Data Doctor — missing-data diagnostic (builds 306–313)

When a panel is empty, the app now explains why — or finds out. The **Data Doctor** is a
built-in missing-data diagnostic, usable by any non-admin user, in four layers:

- **Empty-panel hints (automatic).** Every empty chart, table and KPI card corrects its own
  empty message when the reason is already knowable without a search: an active Cloud/host
  filter, a time range shorter than the panel's data granularity, a failed search, or a query
  clause that can never match. KPI cards use a compact form so the equalised row height holds.
- **"Why is this empty?" — the panel diagnosis drawer.** A budgeted, cancellable series of
  probes walks a gated verdict cascade (the panel's own error first, then index visibility and
  presence, the summarised-data layer, sourcetype presence/staleness) and answers in plain
  language with a confidence level and **who can act** — including the verdict a diagnostic
  must be able to give: *"there genuinely are no such events — nothing is broken."* Panels that
  read summarised data are traced back to the source events their aggregation consumes, so an
  unbuilt rollup ("run the backfill") is distinguished from genuinely absent data. A probe
  that failed or ran out of budget renders NOT CHECKED — never OK, never a fault.
- **Data Doctor reports (PDF + JSON) at three scopes.** The drawer downloads a panel report;
  the Actions menu adds **Diagnose dashboard (PDF)** (every panel on the open dashboard
  classified, the empty ones deep-diagnosed) and **Environment report (PDF)** (index,
  sourcetype and rollup health for the whole install). Each download is a branded, selectable-
  text PDF plus a machine-readable `.json` twin (`logserv.diag/1`) — generated entirely in the
  browser, containing no raw log events, intended for a Splunk support ticket.
- **The Diagnostics page (`#/diagnostics`, builds 311–312).** *Platform → Diagnostics* renders the
  environment health live — summary facts, a per-rollup table with independent **Freshness**
  and **History** verdicts (History uses the same ~30-day completeness convention as Settings →
  Dashboard Data), per-sourcetype window counts + all-time last-seen, the full "what was
  checked" ledger, and the explicit list of what cannot be checked from a browser session.
  Every downloaded report is also **saved automatically** to a new `logserv_diag_reports`
  KV collection and listed on the page for re-download (identical PDF, or the JSON twin) —
  kept 365 days, newest 100, trimmed by a nightly retention search at 01:56 search-head local time. The page
  carries no destructive or admin controls; admin remedies are named as text.

- **Fresh-install correctness (build 313).** Five new root causes are diagnosed for the
  states a brand-new install actually hits: **routing not applied** (events arriving but
  none parsed into the solution's log types — the Data TA missing from the forwarder/indexer
  tier), **feed not started** (an empty summary whose SOURCE events have never arrived — the
  backfill is no longer prescribed when it cannot help), **Windows extraction add-on
  missing** (`Splunk_TA_windows` absent on the search tier while the Windows events exist),
  **KV Store not ready** (mongod warm-up after a restart, previously indistinguishable from
  "never built"), and **future-dated events** (source clock/timezone misconfiguration). The
  index-authorization verdict now names every cause its evidence cannot separate (role,
  missing Data TA, macro override, disabled index); a "never arrived" claim is scoped to the
  index actually probed; a disabled summarisation job upgrades the stale-summary verdict to
  confirmed and names the job; the companion-apps check now includes the Data TA (with its
  expected-tier note); and saved panel reports carry the panel's real title instead of
  "(untitled)".

!!! tip "Honesty guarantees, enforced at build time"
    The diagnostic's rules are pinned by mutation-tested build-gate consistency suites (the build fails on any drift): a free check may never assert a system fault without
    dispatched evidence, an unchecked probe may never read as OK, a rollup may never be
    certified healthy from an unchecked collection, and the reports retention can never wipe
    the saved-reports collection on an empty read (`override_if_empty=false` — verified live).

### :material-circle-box:{ .taiconcolor } About dialog — version, build number and build date (builds 302–303)

The navigation bar has a new **About** item, to the right of *Platform*. Clicking it opens a dialog
showing the app icon, the product name **Splunk for SAP LogServ**, and the **version**, **build
number** and **build date** of the app you are running, with a **Close** button. Clicking outside the dialog or pressing
`Esc` also closes it.

This makes the running build identifiable from inside the UI — useful when confirming an upgrade
landed, or when reporting an issue.

!!! tip "The numbers always match the installed app"
    Version and build are read from the app's own `app.conf` when the app is built, and the build date
    is stamped at the same moment — none of them are typed into the page, so the dialog cannot show a
    stale value. The build date is UTC.

### :material-circle-box:{ .taiconcolor } Stale prompt count removed from the AI Assistant banner (build 301)

The AI Assistant's templates-only banner told users to "run any of the **48** saved searches" — the
catalog actually holds **61** predefined prompts. The count is now gone rather than corrected: the
catalog has grown across releases (40 → 42 → 48 → 61), and a hard-coded number in a user-visible
string goes stale silently. The banner now reads "any of the predefined saved searches".

The same stale count was swept from four other places: the shipped `ai_assistant_settings.conf`
comment (visible to admins via `btool`), two rows in the developer AI Assistant internals reference,
and the architecture page's description of the predefined-prompt path. No behavior change.

### :material-circle-box:{ .taiconcolor } Templates-only build variant now really disables the LLM (build 300)

The app can be built in two variants from one source tree: the standard build (`yarn build`) with the
full LLM-driven AI Assistant, and a **templates-only** build (`yarn build:templates-only`) intended for
partner and restricted-environment distribution, where only the predefined-prompt path is available.

The templates-only build flag was correctly wired, but it no longer disabled what it claimed to. The
user-facing gating had moved to the **runtime** `templates_only_mode` admin setting, so the build flag
was left gating only model discovery and two Settings rows — **a templates-only build still had working
free-form LLM chat**.

The build flag now *forces the runtime setting on*, at the single point where the setting is read:

- **Every read path reports templates-only.** The config reader normalizes both storage sources — the
  KV Store settings row and the `ai_assistant_settings.conf` stanza — through one function, and falls
  back to a built-in default if both reads fail. All three now report `templates_only_mode: true` in a
  templates-only build, whatever is stored. The existing runtime behavior then applies unchanged: chat
  input read-only, Send disabled, the free-form dispatch path short-circuits with an in-chat notice,
  model picker and Power Mode hidden, Provider Credentials tab hidden, explanatory banner shown.
- **Why patching the shipped conf default alone was not enough.** The KV Store row takes precedence
  over the conf file, so a deployment upgrading from a standard build — whose row already holds
  `templates_only_mode = 0` — would have kept the LLM path enabled.
- **The Settings "Templates-only mode" toggle is hidden** in a templates-only build. It could not turn
  the LLM path back on, so showing it would be a control that lies.
- The build also writes `templates_only_mode = true` into the packaged `default/ai_assistant_settings.conf`
  so the shipped artifact is self-describing to `btool` and the REST conf endpoint.

!!! note "What this does *not* change"
    The standard full-LLM build is unaffected — verified at the byte level: the two variants' compiled
    bundles are the same size and differ only in the compiled flag value (plus a per-build style-engine
    salt). The vendor provider modules are still present in the templates-only bundle; this is a
    functional disable, not a code strip. If you need a distribution with the vendor code physically
    removed, that is the separate v0.0.6 line.

!!! tip "Upgrading a templates-only deployment"
    No action needed. Because the setting is forced at read time, an existing KV Store row that says
    the LLM path is enabled is overridden automatically. If you later move that deployment to a standard
    build, the LLM path stays off until an admin explicitly re-enables it in Settings — the safe direction.

### :material-circle-box:{ .taiconcolor } After-hours window fix (build 299)

Every "after hours" filter in the product was a silent no-op. The `[sap:hana:audit]` search-time
calculated fields chained one `EVAL` onto another (`hour_of_day` derived from `EVAL-audit_datetime`),
which Splunk does not reliably resolve — so `hour_of_day` and `day_of_week` measured **0% populated**
and `is_business_hours` was pinned to the dead constant `"false"` on every event.

Two opposite failure modes followed, decided purely by how the comparison was quoted:

- **HANA Audit → "After-Hours / Weekend Admin Activity"** compared against a bare `false`. In a `where`
  clause a bare `false` parses as a *field reference*, not a boolean, so the test never matched: the
  filter degenerated to weekend-only. The panel **omitted every weekday after-hours event** — the most
  security-relevant slice — and labelled every row "Weekend" (the "After Hours" and
  "Weekend / After Hours" labels could never render).
- **Change & Configuration Activity → "After-Hours Changes"** (the KPI, its sparkline, the "Recent
  After-Hours Changes" table, and the `logserv_compliance_rollup`) used the quoted form
  `is_business_hours="false"`, which matched the dead constant and flagged **100% of HANA events** as
  after-hours.

Both are fixed. `props.conf` now derives each field inline from `_time`, and — more importantly —
every consumer computes the window inline instead of reading a search-time calculated field. That
indirection was an invisible dependency for a security filter, and it fails silently in *both*
directions, so the dashboards, the ENRICH classifier and the rollup aggregation arms no longer rely
on it.

**One canonical window now applies to all three change sources:** business hours are
**08:00–18:59**, so after-hours is `hour < 8 OR hour > 18 OR weekend`. Previously HANA delegated to
the dead fields while Windows and Linux used a different 07:00–19:59 window.

!!! warning "Re-run the compliance rollup backfill after upgrading"
    `is_after_hours` is part of the `logserv_compliance_rollup` `_key`, so rows written before this
    build carry the old classification and would not be overwritten by a normal re-aggregation. Use
    **Settings → Dashboard Data → Run backfill** after upgrading.

Two deliberate exceptions are documented in `props.conf` and intentionally left unchanged: the three
Enterprise Security off-hours correlation searches use `hour < 8 OR hour >= 18` (tuned detections
whose notable/risk volume depends on the window), and the `logserv_hana_after_hours_admin` prompt
uses a wider business day (`hour < 6 OR hour >= 20`) as a deep-overnight tripwire — its own
description states that window.

### :material-circle-box:{ .taiconcolor } AI Assistant — configurable MCP request timeout (builds 287–288)

The AI Assistant's browser-side MCP request timeout is now an admin setting instead of a hardcoded 30 seconds. **Settings → AI Assistant → General** gains an **MCP request timeout (seconds)** field (default `60`, range `5`–`600`) that bounds how long the browser waits for each MCP request — tool dispatch, saved-search run, health probe — before aborting it with the `signal is aborted without reason` error. Raise it if a legitimately-slow prompt aborts on a high-ingest instance. It reads per-request from the same KV-Store settings row as the rest of the AI config (`mcp_timeout_seconds`); MCPClient resolves it exactly like `mcp_server_url`. Note this is the browser-side abort — the MCP server (App 7931) has its own separate `mcp.conf [server] timeout` (60s default), so the effective ceiling for any one request is the lower of the two. Build 288/263 adds a **read-only display** of the MCP server's own timeout (App 7931's `mcp.conf [server] timeout`, read cross-app) right beside the client field, so an admin sees both numbers and their relationship at a glance; it degrades to "Not detected" when App 7931 isn't installed. The server timeout stays edited the normal way (that app's `mcp.conf` + a Splunk restart) — it's a different, persistent-process app, so it can't be changed live from our UI.

!!! note "v0.1.1 = the LLM-capable source line, and the published tarball is the full-LLM build again"
    v0.1.1 is the **LLM-capable** source line, at full feature parity with v0.0.6 — the entire dashboard-performance data-layer rewrite (tstats + KV-Store rollups, backfill panel, staggered schedules), the Azure and GCP ingest add-ons, the three-way Multi-Cloud Overview, the Enterprise Security enable + re-stagger, and every AI Assistant fix (prompt repairs, the MCP time-range fix, rollup-backed host prompts). The source additionally carries the full LLM-driven AI Assistant (four vendor providers, free-form chat, Power Mode, privacy tiers, Provider Credentials). **As of App build 335 the published v0.1.1 App artifact is the full-LLM build variant** (see the entry above), so those features are active once an LLM provider credential is configured; a compile-time templates-only variant of the same source remains available for restricted deployments. Everything listed under Version 0.0.6 below is included in v0.1.1.

### :material-circle-box:{ .taiconcolor } Cisco Magnetic re-theme — light + dark mode (builds 246–259)

The entire App — all 21 dashboards, the Environment Topology view, Settings, the AI Assistant, the audit-log viewer, and every modal — was restyled to follow the **Cisco Magnetic design system**, with a **user-switchable light / dark mode**:

1. **Sun / moon toggle** in the navigation bar's right cluster. The choice persists per user per browser; the default is **dark** (continuity with the previous look). Both palettes are the real Magnetic "classic" token sets, with the OneCD teal brand accent on navigation-active states and Magnetic interact blue on buttons, links, selection, and focus.
2. **Typography** — the App now bundles and uses **Inter** (body / UI), **Sharp Sans** (display titles), and **Roboto Mono** (code / SPL) with automatic fallback to the platform stack if a font file fails to load. Font attributions ship in `THIRD-PARTY-NOTICES.md` and `LICENSES/`.
3. **Surfaces and chrome** — cyan-outlined dark cards became Magnetic container cards (subtle borders, 4 px radius, flat surfaces, interact-blue hover affordance and focus rings); tables, KPI cards, buttons, chips, banners, tabs, and spinners follow the Magnetic component grammar in both modes.
4. **Charts** — all chart palettes are mode-aware, built on the Magnetic 11-color accent palette and sentiment ramps; chart gradients flatten appropriately in light mode. Tooltips render on the Magnetic inverse surface in both modes.
5. **Fixes shipped inside the arc** — chart tooltips no longer inherit the bar gradient (build 249–251), PDF download works through the App's own download path (build 256), and panel-chrome clicks no longer swallow the chart zoom controls' clicks (build 253).

The dashboards' *content* — every panel, query, and drilldown — is unchanged; this arc is visual only. Documentation screenshots are being refreshed to the new look progressively.

### :material-circle-box:{ .taiconcolor } Environment Topology — star-system Force layout + floating edges (builds 260–277)

The topology view's Force layout and edge rendering were rebuilt:

1. **Star-system layout** — every high-traffic hub (focused SIDs plus secondary SIDs with enough leaf partners) gets its own proportional horizontal slot with partners ringed around it at a radius scaled to partner count; smaller secondary systems anchor as satellites fanned around their nearest hub, and tiny systems ring tighter. The old behavior — multiple large systems piling onto the canvas center — is gone. The layout is **deterministic**: the same data renders the same picture on every load.
2. **Viewport-aware canvas** — the layout world sizes itself to the canvas aspect ratio, and collapsing or expanding the Live Activity panel **re-fits the graph** so it claims or yields the vertical space (previously collapsing just revealed empty canvas).
3. **Floating edges** — edges now run center-to-center as gently bowed curves clipped at each node's visible boundary, so arrowheads land **on the health ring / outline outer edge** instead of under the node box. Bidirectional pairs bow apart and stay separately clickable; labels sit at the curve apex.
4. **Two-mode polish (builds 271–272)** — a light-mode contrast sweep fixed four spots where near-black text landed on colored fills (the Live Activity source pills, the Save/Manage Layouts modal buttons, and the toolbar's active-toggle state), and the panel-toggle re-fit was hardened to measure the canvas live so it stays correct even in throttled background windows.
5. **PNG / PDF export now renders the topology faithfully (builds 273–274)** — the Actions → Download PNG/PDF capture previously dropped every edge (the rasterizer clips svg content to each svg's box, and the flow library draws edges outside an unsized box) and mis-placed the node health rings. The capture now pre-renders the topology's svg layers through the browser's native SVG renderer before compositing, so exported images match the on-screen canvas — edges, labels, arrowheads, and health rings included.
6. **Secondary SAP SID circles enlarged (build 277)** — secondary SIDs now render at **90% of the focused-SID size** (previously ~two-thirds), so smaller SAP systems read clearly at typical zoom levels. Edge arrowhead clipping, the Layered/Tree layout bounding boxes, and the Force layout's collision spacing all scale with the new size. Database-tagged **partner** nodes keep their previous smaller disc — the change applies to SAP SIDs only.

### :material-circle-box:{ .taiconcolor } AI Assistant — dynamic model discovery (builds 275/276)

Each LLM provider's model picker (the chat panel's per-user picker and the Settings → General `default_model` dropdown) now offers a **live-discovered model list** instead of a fixed hardcoded set:

1. **Curated baseline ∪ vendor-discovered** — the App merges a static curated baseline (always available, even offline) with models discovered from the configured vendor: Anthropic and OpenAI `/v1/models`, **Azure OpenAI deployment discovery** (three-step: `/openai/v1/models` → `/openai/deployments` → the admin's configured deployment names), and **AWS Bedrock** `ListFoundationModels` (Anthropic, on-demand, text, streaming, active models only). Discovery calls are **metadata-only GETs** using the same credential and trust envelope as the existing credential-validation check — no prompt or event data is involved.
2. **Three refresh triggers** — saving a provider credential, a manual **"Refresh model list"** button on Settings → General, and a lazy 24-hour refresh when the chat panel opens. Results cache in the `logserv_ai_models` KV Store collection; every refresh (success or failure) writes a **`model_discovery` audit event** with provider, trigger, model count and duration.
3. **Failures never shrink the picker** — a failed refresh keeps the last-good discovered list and the static baseline is always the floor. A governance toggle (**`model_discovery_enabled`**, default on) disables all vendor listing calls; the pickers then offer the curated baseline only.
4. **Refreshed baselines + honest pricing** — the curated model ids and the vendor cost table used for spend tracking were refreshed to the current model generations. Cost estimates remain **exact-id keyed**: a discovered model with no known price reports $0 rather than a guessed figure.
5. **Azure credential-name fix** — the Azure OpenAI provider now accepts the field names the Settings page actually stores (`endpoint` / `deployment`) in addition to the legacy names (`resource_url` / `deployments`). This also fixes free-form **streaming** for Azure configurations entered through the Settings page.

Model discovery queries the active provider, so it does nothing until a provider credential is configured; in a compile-time templates-only build it is inert and these controls are hidden.

### :material-circle-box:{ .taiconcolor } Blue-gradient icon set (build 278)

The LogServ product branding moves from orange to the brand **blue gradient** (top `#2276CE` → bottom `#0F55A3`, mid ≈ Cisco `#1870C5`):

1. **App icon** — the "LS" launcher/app-header icon is recolored to the gradient and reshaped to **panel-matched corner radii** (4 px at the 36 px rendered size — the same `border-radius: 4px` token as the dashboard panel cards). The identical icon ships in the Data TA, the Azure/GCP ingest add-ons, and the Demo Gen TA, so the Splunk launcher renders every LogServ component consistently.
2. **Docs help icon** — the orange "?" affordance in every dashboard title row is repainted with the same gradient: the rotating square outline becomes an SVG rounded-rect with a gradient stroke (same 4 px radius and 12-second spin), and the glyph an SVG gradient-fill text — a form that also renders faithfully in the dashboard PNG/PDF exports.

### :material-circle-box:{ .taiconcolor } Settings readability, Live Activity panel, link-graph restyle (builds 279–281)

Three UX fixes:

1. **Settings readability** — the Settings page, the Dashboard Data panel, and the Audit Log viewer move to a wider field-label column (`clamp(320px, 30%, 520px)`, previously a fixed 200 px) with larger text: 14 px field labels and 13 px hints, intros, and panel subtitles — matching the page-subtitle size.
2. **Environment Topology "Live Activity" panel** — the bottom panel previously clipped mid-row against its zone (its bottom outline never rendered once the partners table outgrew the panel). It now fills its zone exactly, so the panel outline completes at any height; the partners table scrolls internally under a sticky header; the default expanded height grew from 220 px to 300 px; and expanding the collapsed panel raises a smaller saved-layout height up to the default. Saved layouts otherwise keep their persisted heights, and the resize divider now allows up to 640 px.
3. **Sourcetype Mapping link-graph restyle** — the node bars on the two "Source to sourcetype mapping" panels (Data Pipeline Overview and Host Details) were hard to read in dark mode. In dark mode they now use mid-tone fills — blue `#4d9dbf`, hover-path purple `#9c80e4`, each with a slight vertical gradient — with dark-grey labels; in light mode the stock fills stay, gaining the same subtle gradient and white labels.

### :material-circle-box:{ .taiconcolor } Global Cloud Provider filter (build 282)

A persistent **Cloud Provider** dropdown (`All / aws / azure / gcp`) now sits in every dashboard's title row, to the left of the Refresh-interval picker, and filters **every panel** on that dashboard by cloud provider. The selection is **global and remembered per user** — it carries across dashboard navigation and full page reloads — so you can scope the entire app to one cloud with a single choice. It is intentionally **absent on the three views where it does not apply**: **Multi-Cloud Overview** (already a side-by-side provider split), **Environment Topology**, and **Settings**.

Under the hood, every non-topology KV-Store rollup grain was extended with a `cloud_provider` dimension, so the filter reads straight from the fast rollup tier with no extra query cost. Events with no cloud attribution are counted as `aws` (the same convention Multi-Cloud Overview uses). A Windows Service-Events / PowerShell source-matching fix (`WinEventLog:System` now also matches `XmlWinEventLog:System`) rides along.

!!! warning "Upgrading an existing install — clear the rollups once, then re-backfill"
    This release **changes the rollup grain** (it adds `cloud_provider` to the rollup key), so the previous rollup rows are not overwritten by the new ones — leaving them in place would double-count the "All" view. On upgrade, clear the rollups once and re-seed them: **Settings → Dashboard Data → Clear all rollups**, then **Run backfill** (or let the hourly aggregation refill them over the following day). New installs are unaffected — just run the initial backfill as usual.

### :material-circle-box:{ .taiconcolor } Linux + Windows dashboard-chart fixes (build 284)

Two dashboard charts are fixed:

1. **Linux — "SAP Application Activity"** — the chart rendered 26 long `sap_app` / `sap_sid` combinations as a vertical column chart, so the x-axis labels clipped to "…". It is now a **horizontal top-15 bar chart** — each bar is one `sap_app / sap_sid` combination with its full label on the roomy y-axis — ranked by event volume.
2. **Windows — "Critical / Error" KPI + "PowerShell Activity" chart** — both were empty because of query mismatches, not missing data. **PowerShell Activity** now matches any PowerShell source (Windows PowerShell events index as `XmlWinEventLog:Microsoft-Windows-PowerShell/Operational`, and on the AWS S3 path as `WinEventLog:Powershell`). The **Critical / Error** KPI now counts CIM `severity IN ("critical","high")` — Splunk_TA_windows maps Windows Critical (Level 1) → `critical` and Error (Level 2) → `high`, i.e. the severe end of the CIM severity vocabulary.

### :material-circle-box:{ .taiconcolor } AI Assistant — predefined prompts on the rollup tier (builds 285–286)

Twenty-three high-volume predefined prompts are converted from raw index scans to reads of the hourly KV-Store rollups that already power the dashboards. On high-ingest environments (~10M events/day), the raw scans behind prompts like *Source IPs flagged by firewall and/or proxy* exceeded the AI Assistant's 30-second dispatch timeout (the default at the time; now the configurable `mcp_timeout_seconds`, default 60 s) at wide time ranges and failed with "signal is aborted without reason"; the same prompts now complete in well under 2 seconds even over 30 days.

- **Converted prompts** cover firewall, proxy, DNS, Web Dispatcher, ICM, ABAP work-process, Windows logon/lockout, cross-stack authentication, Linux PAM + firewall-agent, HANA failed-auth + trace-severity, Cloud Connector, error categories, and top-systems-by-calls.
- **Five new rollup metrics** back the prompts that had no existing rollup dimension: `pam` + `cgsfw` on the Linux rollup, `wperr` on the Work Process rollup, `denieddest` on the Proxy rollup, and `logon` on the Windows rollup. The Settings → Dashboard Data backfill covers them automatically.
- **Three prompts intentionally report differently:** *Web Dispatcher slow URIs* now ranks by average response time with a per-URI max column (percentiles don't roll up across hourly buckets); *DNS queries to suspected beaconing domains* now uses the DNS dashboards' gap-variance beaconing detection (daily granularity); and the two *cross-stack auth failure* prompts now use the Cross-Stack Authentication dashboard's canonical failure definition, so their numbers match that dashboard.
- Rollup freshness semantics apply: results reflect data through the most-recently-completed hour. Prompt time ranges keep working — the dispatch window bounds the rollup read.
- The prompt catalog (intent map) is at v0.0.12; saved-search and intent-map SPL remain byte-synced.

A follow-up round in the same session fixed four trend prompts that rendered all-zero charts and two ES prompts that still timed out: the MCP server caps tool responses at its default 100-row limit keeping the FIRST rows, so an hourly trend over 30 days (721 rows) displayed only its oldest ~4 days — the ten >100-row time-series prompts now bin adaptively (`bins=90 minspan=1h`: unchanged hourly behavior at short windows, ~30–90 complete-window points at wide ones, totals verified conserved exactly); the after-hours-admin ES prompt's web-traffic join subsearch now reads the sourcetype-mapping rollup (row-identical, and the prompt completes at any window); and the web-dispatcher response-time anomaly is re-expressed on a new per-host hourly `wd_host` web-timing rollup metric as an avg+max z-score (percentiles don't roll up) — its daily scheduled detection drops from minutes of raw scanning to sub-second as well. Intent map at v0.0.13.

## Version 0.0.6

!!! note "v0.0.6 is primarily a dashboard-performance release"
    v0.0.6 keeps the **entire v0.0.5 feature set unchanged** (21 React dashboards + the Environment Topology view, templates-only AI Assistant with 61 canned prompts + audit log, index-time filtering + Deployment Server automation, Cloud Provider attribution, Enterprise Security integration). The headline of this release is a **dashboard data-layer rewrite** that makes the dashboards fast at high event volume; it also adds **Google Cloud Platform as a third ingest channel** (a dedicated per-HF add-on, see below) and reworks Azure ingest onto a dedicated per-HF add-on. Search-time field extractions, sourcetype routing, and all dashboard *content* are unchanged — only how each panel sources its data changed. **No data re-ingest is required to upgrade.**

### :material-circle-box:{ .taiconcolor } Compatibility

|                                  |                              |
|----------------------------------|------------------------------|
| Splunk platform versions         | 9.4.3 and later              |
| CIM                              | 5.0.0 and later (per `app.manifest`) |
| Supported OS for data collection | Platform independent         |
| Vendor products                  | SAP LogServ for SAP ECS in Amazon Web Services (AWS), Microsoft Azure, and Google Cloud Platform (GCP) |
| AI Assistant prerequisite        | [Splunk MCP Server (Splunkbase App 7931)](https://splunkbase.splunk.com/app/7931) v1.1.0 or later, on the search head where the LogServ App is installed |
| Azure ingest                     | A dedicated first-party add-on — **Splunk TA for SAP LogServ on Azure** (`splunk_ta_sap_logserv_azure`), installed per Heavy Forwarder — ingests Azure Blob via Event Grid → Storage Queue notifications (Azure deployments only; SAP provisions the queue + SAS) |
| GCP ingest                       | A dedicated first-party add-on — **Splunk TA for SAP LogServ on GCP** (`splunk_ta_sap_logserv_gcp`), installed per Heavy Forwarder — ingests Google Cloud Storage via Pub/Sub `OBJECT_FINALIZE` notifications (GCP deployments only; SAP provisions the subscription + service-account key) |

### :material-circle-box:{ .taiconcolor } The problem this release solves

At a customer's reported scale (~10.7M events / 24 h, ~321M over 30 days) the 21 non-Topology dashboards took **over 10 minutes** to populate. Each panel dispatched its own raw, search-time-extraction full-scan with no shared base search, no `tstats`, and no acceleration. (The Environment Topology view was already fast — it had been moved to a KV-Store-backed data layer in v0.0.5.)

### :material-circle-box:{ .taiconcolor } New data architecture — two tiers

Every dashboard panel was re-tiered onto the cheapest *correct* data source and byte-exact-verified against the original raw SPL. The result is a **two-tier data layer** — no Common Information Model (CIM) acceleration is required.

1. **`tstats` on indexed dimensions** — pure count / average panels (Data Pipeline Overview, Host Details, the Environment Health pipeline panels, Multi-Cloud Overview, and the count KPIs across the suite) read via `| tstats` over the already-indexed `WRITE_META` fields. A new `default/fields.conf` declares `INDEXED = true` for `clz_dir` / `clz_subdir` / `splunk_solution` / `cloud_provider`.
2. **KV-Store precompute rollups** — every other high-volume panel reads from a set of **hourly-aggregated KV-Store rollup collections** (`logserv_*_rollup`; later builds added more — the Settings → Dashboard Data tab lists the current inventory). Scheduled saved searches (`logserv_*_aggregate`, hourly on staggered per-search minutes — see [Scheduled-search schedule](../logserv-app/dashboards/performance.md)) precompute each panel's data; the dashboards read it back filtered by a `bucket_ts` range driven by the global time-range picker. Streamstats / per-event-listing panels that cannot be rolled up stay raw (capped with `| head N` where they are time-ordered listings).

Cached reads are uniformly **~0.1–0.6 s** versus 10 s – 19 min raw (speedups of **64× – 5,358×**), validated at 335M events on the test fleet. **Data freshness on the rolled-up panels is hourly** — the same trade-off the Environment Topology view already made. See [Dashboard Performance & Data Freshness](../logserv-app/dashboards/performance.md) for the full picture and the one-time backfill step.

!!! info "No CIM data-model acceleration needed for dashboards"
    An interim build had the four HTTP / DNS / proxy dashboards (Proxy, Web Dispatcher, Cloud Connector, DNS Analytics) read from CIM accelerated data models. That approach was **removed** before this release: when a customer had not accelerated those models (the common case), the queries fell back to a raw full-scan — exactly the slowness this release set out to fix. Those four dashboards now read dedicated KV-Store rollups, so they are fast regardless of the customer's CIM-acceleration state. The LogServ App's CIM *tagging* (eventtypes + tags) for **Enterprise Security** correlation is unaffected — see [Enterprise Security → CIM Compliance](../enterprise-security/cim-compliance.md).

### :material-circle-box:{ .taiconcolor } New features

1. **"Run backfill" — Dashboard Data settings tab** — a new **Settings → Dashboard Data** tab seeds the rollup collections on first install. It dispatches each rollup's aggregation searches as **top-level jobs** (immune to the subsearch wall-clock limits that truncate a bundled backfill at high volume), with a progress bar, completeness banner, and per-rollup status. Idempotent and resumable. **An admin clicks this once after installing on a high-volume instance** to populate dashboard history immediately; otherwise the hourly aggregation seeds history going forward. See [Dashboard Performance & Data Freshness → Backfilling on first install](../logserv-app/dashboards/performance.md#backfilling-on-first-install).
2. **365-day cache retention** — all rollup-retention searches keep a full year of rolled-up history. The install backfill seeds 30 days; the cache then grows to a year organically via the hourly aggregation (seed-and-grow).
3. **Per-panel action toolbar** — every chart and table panel header now carries **Open in Search · Download (CSV) · Inspect (Job Inspector) · Refresh** plus a "&lt;1m ago" last-run stamp. KPI single-value cards get the loading spinner but no toolbar.
4. **Universal loading spinner** — every chart / table renders the orange-dot spinner + "Loading data…" while its search is in flight (KPI cards show a small spinner instead of a dash), replacing the old plain "Loading…" text.

### :material-circle-box:{ .taiconcolor } Role Activity + Sourcetype Mapping performance (build 243)

The last two raw-scan panel groups were moved onto KV-Store rollups so they stay fast at high event volume:

1. **Sourcetype Mapping** (Host Details → Sourcetype Mapping tab + Data Pipeline Overview → Linked Graph) now reads a new `logserv_stmap_rollup` with **`source` normalized** (UUIDs, dates, and long digit-runs stripped to collapse per-day / per-tunnel variants into logical sources). This cut the search from **~50 s to ~2 s** over a 30-day window and the graph from 4,000+ nodes to a few hundred. **User-visible change:** the graph now shows normalized logical sources (e.g. one `…/audit-log_<id>_<date>.csv` node) instead of one node per tunnel-UUID per day.
2. **Role Activity** (Host Details → Role Activity tab) — the 7 per-host breakdown panels now read a new `logserv_hostrole_rollup` (metric discriminator), reproducing the same value / count / percent breakdown **byte-exact**, ~8× faster. No visible change.

Adds 2 rollup collections (24 → 26 hourly aggregates; 24 → 26 retention searches) — fully within the existing staggered schedule (now `:03`–`:28` aggregates / `:30`–`:58` daily).

### :material-circle-box:{ .taiconcolor } Scheduling & Enterprise Security (build 242)

1. **Enterprise Security content shipped disabled by default.** _(Superseded in build 249 — the ES content now ships **enabled** by default; see the build-249 note below.)_ In build 242 all 22 `splunk_sap_logserv_es_*` saved searches shipped with `disabled = 1`. The ES content is dual-mode (it targets the ES Notable / Risk / Asset & Identity frameworks and CIM data models that no-op without ES installed) and no dashboard reads any ES output. See [Enterprise Security → The ES schedule](../enterprise-security/overview.md#the-es-schedule-collision-free).
2. **Scheduled searches re-staggered into three non-overlapping bands** — the 24 hourly rollup aggregates spread one-per-minute across `:05`–`:28` (was all at `:05`), retention + the 2 daily beaconing aggregates moved to an off-peak `:30`–`:58` band, and the (disabled) ES searches re-croned to the back of the hour. No two enabled scheduled searches share an `(hour, minute)`, eliminating the previous `:05` burst and two same-minute collisions. Dispatch windows are unchanged, so data freshness is unaffected. See [Dashboard Performance & Data Freshness → Scheduled-search schedule](../logserv-app/dashboards/performance.md#scheduled-search-schedule).

### :material-circle-box:{ .taiconcolor } Enterprise Security enabled by default + AI Assistant prompt rework (build 249)

1. **The 22 `splunk_sap_logserv_es_*` searches now ship enabled by default**, reversing build 242's disabled-by-default decision. They run on a re-staggered, **collision-free** schedule (no two enabled scheduled searches share an `(hour, minute)`): 16 correlation searches hourly in the disjoint minutes `:29` / odd `:31`–`:59`, the 2 Asset/Identity feeds every 4 hours at `:00` / `:01`, and the 4 behavioral-anomaly searches once **daily** at `:02`. To fit the collision-free schedule, eight correlation searches that ran every 5–15 minutes now run hourly (with matched 65-minute dispatch windows), and the four anomaly searches run daily instead of hourly — a daily run still evaluates every hourly bucket of the prior day, so no detections are missed. The content stays dual-mode (`action.notable` / `action.risk` no-op without ES). To disable or re-tune, see [Enterprise Security → Disabling or tuning the ES content](../enterprise-security/overview.md#disabling-or-tuning-the-es-content).
2. **The 13 ES AI Assistant Security-pack prompts were reworked to function as interactive prompts.** Dispatched by name, they had been erroring on click ever since build 242 disabled their searches; enabling the searches fixes that, and the SPL was repaired — the `anomaly_topology_edge_volume` FATAL `inputlookup … where` error, the dead-constant `is_business_hours` / `is_weekend` off-hours fields (replaced with inline `_time`-based logic), the `service_account_interactive` field bug, and the structurally-empty `after_hours_admin_data_access`. The three 30-day anomaly prompts were converted to a daily cadence. Intent map bumped to v0.0.11.

### :material-circle-box:{ .taiconcolor } Dependency security hygiene — react-router 7.18.1 (build 252)

Bumped `react-router-dom` from 7.14.2 to **7.18.1** (patched line) so dependency / SCA scanners no longer flag the App against [GHSA-4hjh-wcwx-xvwj](https://github.com/remix-run/react-router/security) — a `__manifest`-endpoint DoS in react-router 7.0.0–7.14.x. **The App was never exposed to it:** it is a client-side single-page app served as static assets by Splunk Web and routed entirely by `<HashRouter>` (Declarative Mode, which the advisory explicitly exempts), with no React Router / Remix server runtime and therefore no `__manifest` endpoint. This is a hygiene bump only — no behavior change (routing was re-verified live across the index, settings, dashboard, and topology routes with zero errors).

### :material-circle-box:{ .taiconcolor } Whole-estate AI Assistant host prompts moved onto a KV-Store rollup (build 251)

Four predefined prompts scan the **entire estate** by host — *Top hosts by event volume*, *Noisiest hosts trend*, *Distinct hosts seen*, and *Hosts with the biggest event-volume drop*. They were raw `| top host` / `dc(host)` / per-host-timechart full-scans, so on a large dataset they exceeded the AI Assistant's 30-second request timeout at wide windows (e.g. *Top hosts* at −30 days took > 150 s and aborted with *"signal is aborted without reason"*). Build 251 rewrites all four to read from the existing `logserv_hostdetails_rollup` KV-Store rollup (hourly `(host, bucket)` counts), so each returns **sub-second** at any window — measured −30 d went from > 150 s (abort) to 0.6 s, and the dropdown window still drives the result. The reads are **byte-exact** to the original SPL (the rollup uses the same search-time `host` field, so the displayed hosts and counts are unchanged), and the rollup is the one that already powers the Host Details dashboard (no new collection or scheduled search). On a fresh install the prompts populate older windows once the [Dashboard Data backfill](../logserv-app/dashboards/performance.md) has run, the same as every dashboard. See [Predefined Prompts](../ai-assistant/predefined-prompts.md).

### :material-circle-box:{ .taiconcolor } AI Assistant prompt time-range dropdown now bounds the search (build 250)

The **Time range** dropdown in the AI Assistant's "Browse predefined prompts" window (Last 1h … Last 30d) now actually bounds the dispatched saved search. Previously the selected window was silently dropped, so every predefined prompt ran **unbounded over the whole index** through the Splunk MCP Server — on a large dataset this took minutes and the prompt timed out client-side with *"Error: signal is aborted without reason."* The fix flattens `earliest_time` / `latest_time` to the MCP `run_saved_search` tool's top-level arguments (where App 7931 expects them) instead of nesting them under an ignored `arguments` object. No fixed window is baked into the saved searches — the dropdown drives the time range end-to-end, and both the canned-prompt path and the AI-driven path are fixed. See [Predefined Prompts](../ai-assistant/predefined-prompts.md).

### :material-circle-box:{ .taiconcolor } Azure queue-driven ingest (dedicated add-on)

Azure ingest is the Azure twin of `Splunk_TA_aws`'s SQS-Based S3 input, and ships as a **dedicated, first-party Heavy-Forwarder add-on — Splunk TA for SAP LogServ on Azure (`splunk_ta_sap_logserv_azure`)**, installed per-HF (not via the Deployment Server). Its **`sap_logserv_azure_queue`** modular input consumes Azure **Event Grid → Storage Queue** `BlobCreated` notifications, fetches each LogServ blob over a SAS, and emits its NDJSON via the native EventWriter, so events flow through the Heavy Forwarder's index-time pipeline and reuse the LogServ Data TA's existing sourcetype routing, Filters `nullQueue`, `_time` drop, and `cloud_provider` / `splunk_solution` stamping unchanged (it emits `sourcetype = sap_logserv_logs` and stamps `_meta = cloud_provider::azure`). It is **stdlib-only** (no Azure SDK, Splunk Cloud-clean) and inert until an input instance is configured. This is the model SAP's LogServ-on-Azure collector uses (Storage Queue notifications), and it **replaces the Splunkbase-add-on polling approach** the original v0.0.5 Azure support used. Installing the input on the forwarder tier — with the SAS in the add-on's own `local/`, never Deployment-Server-managed — makes Azure ingest **symmetric with AWS** and removes the per-host-secret-inside-a-DS-app fragility of earlier v0.0.6 iterations (the old `system/local` SAS dance + `sas_token = ******` bundle invariant are gone). Per-instance `index` and `event_sourcetype` (both default `sap_logserv_logs`) let one HF run multiple Azure inputs. Per-HF install + input configuration are documented in [SAP LogServ on Azure — Setup Guide](../install-setup/azure-setup.md). AppInspect Cloud posture: 0 errors / 0 failures / 0 future_failures (the add-on's stdlib-only modular input adds no gating findings; the input-removed Data TA returns to its 11-warning baseline).

### :material-circle-box:{ .taiconcolor } Multi-Cloud Overview goes three-way + Data TA `gcp` dropdown (build 253)

Alongside the GCP add-on (below), the **Multi-Cloud Overview** dashboard was upgraded from a hardcoded two-provider layout to a full **AWS / Azure / GCP** split: a new **GCP Events** KPI + sparkline (the KPI row is now Total / AWS / Azure / GCP), a GCP column in the Top Sourcetypes table, and provider-neutral labels. This also fixes a latent bug for third-provider data: the Top Sourcetypes query hardcoded `Total = AWS + Azure`, which would have silently excluded `gcp`-attributed counts from the Total (single- and dual-cloud installs were unaffected — verified that a window with zero GCP rows still renders `GCP = 0` with a correct Total). The dashboard's "About the cloud_provider field" reference panel was rewritten (it still described a retired Azure ingest mechanism and linked to a non-existent in-app help URL; it now links to the published Azure/GCP Setup Guides). The **Data TA's Configuration → Cloud Provider dropdown gains "Google Cloud Platform"** (`cloud_provider = gcp`) as a fourth choice — see [Configuring Filters → Cloud Provider Attribution](../install-setup/configure-filters.md#cloud-provider-attribution).

### :material-circle-box:{ .taiconcolor } GCP notification-driven ingest (dedicated add-on)

Google Cloud Platform joins AWS and Azure as a first-class ingest channel, via a **dedicated, first-party Heavy-Forwarder add-on — Splunk TA for SAP LogServ on GCP (`splunk_ta_sap_logserv_gcp`)**, installed per-HF (not via the Deployment Server). Its **`sap_logserv_gcp_pubsub`** modular input pulls a **Pub/Sub subscription** fed by the LogServ GCS bucket's `OBJECT_FINALIZE` notifications, fetches each object with a Google **service-account key**, gunzips it, and emits its NDJSON via the native EventWriter — so events flow through the Heavy Forwarder's index-time pipeline and reuse the LogServ Data TA's existing sourcetype routing, Filters `nullQueue`, `_time` drop, and `cloud_provider` / `splunk_solution` stamping unchanged (it emits `sourcetype = sap_logserv_logs` and stamps `_meta = cloud_provider::gcp`). This is the same notification-driven model SAP's own LogServ-on-GCP collector uses, and the same deployment shape as the Azure add-on. It is **stdlib-only** — Pub/Sub + GCS REST over `urllib`, with a pure-Python OAuth2 service-account token exchange (no Google SDK, no vendored dependencies) — so it is Splunk Cloud-clean and adds no third-party attributions. The general-purpose Splunk Add-on for Google Cloud Platform (Splunkbase 3088) was evaluated and does not fit: as of v5.0.3 its Pub/Sub-based bucket input cannot decompress the gzipped LogServ objects. The service account needs exactly the two roles SAP documents for its own forwarder (`roles/pubsub.subscriber` on the subscription + `roles/storage.objectViewer` on the bucket). Per-HF install + input configuration are documented in [SAP LogServ on GCP — Setup Guide](../install-setup/gcp-setup.md). AppInspect Cloud posture: 0 errors / 0 failures / 0 future_failures.

### :material-circle-box:{ .taiconcolor } Changed (user-visible panel shapes)

A few panels changed shape as a consequence of reading from hourly rollups instead of raw events:

1. **All response-time charts now show Avg + Max by hour instead of p50 / p95 / p99 percentiles.** Averages and maxima roll up byte-exact across hourly buckets (Avg = Σsum ÷ Σcount, Max = max-of-per-bucket-max); percentiles cannot be merged across buckets. Affects Web and API Performance ("Response Time (Avg / Max) Over Time", and the "Slow URIs / Slow Clients" tables now show a **Max (ms)** column in place of p95) and HANA Trace ("Operation Duration (Avg / Max)").
2. **HANA Trace "Slowest SQL Operations"** is now a top-operations-by-max-duration table (operation, max ms, avg ms, event count) — the per-event `_time` / host columns cannot survive an aggregate.
3. **Web Dispatcher "URIs by Request Count"** dropped its "Unique Clients" column (a 3-dimension grain would explode at scale).
4. **Panels that remain raw** (and are therefore unaffected): Network Perimeter "Suspicious Activity Indicator", the DNS / Network-Perimeter beaconing tables, Web Dispatcher "Slowest Request Traces", and Cloud Connector "Audit Log" — streamstats / per-event listings that cannot be rolled up byte-exact. (The beaconing and Slowest-Traces panels are now backed by per-day / per-hour rollups so they stay responsive to the time-range picker.)

### :material-circle-box:{ .taiconcolor } Fixed issues

While re-expressing panels, three pre-existing display bugs (all string-vs-number / `match()`-in-base-search predicate mistakes that silently returned 0) were found and fixed:

1. **Cloud Connector HTTP Error Rate** — the KPI compared a string `is_error` field against the number `1` and was stuck at 0%; re-expressed as the `status >= 400` fraction (now ~7.3% on test data).
2. **Change & Configuration "Password Change" / "User Change" KPIs** — a Linux `match(_raw, …)` clause sat in base-search position where `match()` (eval-only) silently no-ops; moved to a post-base `| where`.
3. **`icm_is_error` predicate** — the same string-vs-number trap (`icm_is_error = 1` vs the field's string `"true"`) in the Environment Health severity rollup and the `logserv_top_error_categories` AI prompt; fixed to `= "true"`.

### :material-circle-box:{ .taiconcolor } Third-party software attributions

`THIRD-PARTY-NOTICES.md` was refreshed for v0.0.6 and now lists **1236 unique top-level npm packages** (adds `elkjs@0.11.1`, EPL-2.0, used by the Environment Topology layout engine — previously omitted). The file is generated deterministically from the build's `node_modules/` tree by `yarn build`, shipped at the root of the installed app directory and mirrored at the GitHub source-tree root, alongside the CycloneDX 1.4 `SBOM.json`. See [Third-Party Software](third-party-licenses.md).

### :material-circle-box:{ .taiconcolor } Known issues

1. The hourly rollup data layer means rolled-up panels are accurate to the most-recently-completed hour; sub-hour time-range selections (e.g. "Last 15 minutes") read from the hourly buckets and so reflect completed hours rather than the live partial hour. Use the raw Search app (via the per-panel **Open in Search** toolbar action) for live sub-hour investigation.
2. On a fresh install at high event volume, dashboards show empty until the first hourly aggregation runs or an admin runs the **Dashboard Data → Run backfill** step.


## Version 0.0.5

!!! warning "AI Assistant LLM functionality intentionally disabled pending review"
    The v0.0.5 release ships with the AI Assistant's **LLM-driven path disabled at compile time pending internal review** of the OWASP LLM Top 10 controls. Every customer running v0.0.5 runs the **templates-only build variant** — there is no separate "regular" build published in this release. What's still active: the predefined-prompt path (61 canned prompts via the Splunk MCP Server), tool tiles in the right pane, drill-down chips, audit log, all 21 dashboards + the Environment Topology view, per-dashboard auto-refresh picker, Download PNG. What's disabled: free-form chat input, the model picker, the Power Mode toggle, the Provider Credentials Settings tab, and all vendor (Anthropic / OpenAI / Azure / Bedrock) traffic. The LLM-driven path will be re-enabled in a future release once review concludes — the type-system enforcement, privacy tiers, and OWASP Top 10 hardening are designed and implemented, just gated off via the build flag for now. See the **AI Assistant → Templates-only Build** docs page and the **AI Assistant → OWASP LLM Top 10 Compliance** page for the full picture.

### :material-circle-box:{ .taiconcolor } Compatibility

|                                  |                              |
|----------------------------------|------------------------------|
| Splunk platform versions         | 9.4.3 and later              |
| CIM                              | 5.0.0 and later (per `app.manifest`) |
| Supported OS for data collection | Platform independent         |
| Vendor products                  | SAP LogServ for SAP ECS in Amazon Web Services (AWS) and Microsoft Azure |
| AI Assistant prerequisite        | [Splunk MCP Server (Splunkbase App 7931)](https://splunkbase.splunk.com/app/7931) v1.1.0 or later, on the search head where the LogServ App is installed |
| Azure ingest                     | A dedicated first-party add-on — **Splunk TA for SAP LogServ on Azure** (`splunk_ta_sap_logserv_azure`), installed per Heavy Forwarder — ingests Azure Blob via Event Grid → Storage Queue notifications (Azure deployments only; SAP provisions the queue + SAS) |

### :material-circle-box:{ .taiconcolor } Major architecture change

**The LogServ App is fully rewritten as a React-based application.** Dashboard Studio v2 is no longer used for any of the 21 dashboards. The app now ships as a single React bundle built on `@splunk/react-ui`, `@splunk/visualizations`, and `@xyflow/react`. The Data TA architecture is unchanged from v0.0.4.x — only the UI App tier has been rewritten.

Implications for upgraders:

  - **Search-time field extractions are unchanged** — your existing custom searches, alerts, and reports against `sap_logserv_logs` continue to work without modification.
  - **Dashboard URLs have changed** — old DS v2 deep links (`/app/splunk_app_sap_logserv/<view>?form.global_time...`) are replaced with React Router hash routes (`/app/splunk_app_sap_logserv/home#/<route>?earliest=...&latest=...`). Time-range query params are preserved.
  - **Splunk 9.4.3+ remains the minimum** version. No new floor.
  - **No data re-ingest required** — the upgrade is UI-only.

### :material-circle-box:{ .taiconcolor } New features

1. **AI Assistant** — Splunk-aware chat panel with two paths:

      - **Predefined prompts** (no LLM call): browse 61 saved searches across three packs (`sap_basis` 15, `security` 28, `operations` 18) plus a context-aware **Dashboard Focused** tab that auto-filters to prompts relevant to the current dashboard. Each prompt dispatches via the [Splunk MCP Server](https://splunkbase.splunk.com/app/7931) and renders a tile in the right pane with a static interpretation + suggested-next-steps card. **No vendor LLM is involved in this path.**
      - **Free-form prompts** (LLM-driven): the same MCP tool path is available to one of four AI providers (Anthropic, OpenAI, Azure OpenAI, AWS Bedrock); the LLM picks tools, the orchestrator dispatches, and the LLM synthesizes a narrative response. **Critical privacy invariant — enforced by the TypeScript type system at build time, not by policy: no event data from your Splunk instance is ever transmitted to any AI vendor.** The compiler refuses to put any tool-result value into the outbound payload — there is no runtime check, no flag to flip. _(Corrected in 0.1.2 build 376: the invariant covers raw rows and unsummarized results; a Tier 2 summary carries aggregated field values from the events by design — see [Privacy Tiers](../ai-assistant/privacy-tiers.md).)_

2. **Three privacy tiers** for the free-form path, admin-selectable in Settings:

      - **Tier 0** — Ollama-based local-only (future release).
      - **Tier 1 (default)** — cloud LLM as SPL generator. Tool result summary fed back is *only* `count + timing`. The AI sees no row data and no aggregates.
      - **Tier 2 (admin opt-in)** — adds aggregated metadata: cardinality, per-column top-N values + counts, min/max/avg/sum (numeric), and time range. Still no raw rows.

3. **Environment Topology** — graph-based view of SAP systems, integration partners, and endpoints. Built on `@xyflow/react` with a force-directed initial layout, self-derived IP→SID inventory drawn from multiple SAP sourcetypes (gateway L=, HANA tracelogs, ICM peer fields, saprouter peer hostnames), per-node sidebar tabs (Programs, Calls/Hr, Errors, Hosts), and named saved layouts persisted via Splunk KV Store (schema v4 — viewport zoom + pan + enabled-types + selected-node + active-tab + snap-mode). Data is refreshed hourly by three scheduled saved searches; manual Refresh button in the toolbar for on-demand re-fetch.

4. **Drill-down chips** — every tool result tile in the AI Assistant's right pane carries a `↗ Dashboard` chip (when a related OOTB dashboard is mapped) and a `↗ Run SPL` chip that opens Splunk's Search app with the dispatched SPL pre-populated and the dispatch's exact earliest/latest pre-applied. Same chips render alongside `[→ saved_search]` citations in the chat narrative on the left pane. Dashboards themselves also got drill-downs: ~70 KPIs / charts / tables / table rows across 19 dashboards open contextual cross-cutting searches with current time range preserved.

5. **Per-dashboard auto-refresh picker** — every dashboard's title row now carries a Refresh picker (Never / 30s / 1m / 5m / 15m / 30m / 1hr) with per-user-per-dashboard cadence persisted to a new KV Store collection (`logserv_dashboard_refresh`). All charts and KPIs re-run on each tick via a shared context nonce.

6. **OWASP LLM Top 10 (2025) compliance** — every item has a matching control. Highlights: prompt-injection sanitization with role-marker + jailbreak-pattern filtering; type-bounded data redaction; a CycloneDX 1.4 SBOM shipped with every build; tamper-evident audit log with optional HEC forwarder; per-user rate limit (configurable, default 30/hr); USD spend cap; SPL static-analysis guard blocking write/delete/alert operators; PII redaction for `email` / `user(name)` / `*_ip` / `mac` / `account` (hostname opt-in); session tool-call cap; jailbreak pattern detection on user input. See [OWASP LLM Top 10 Compliance](../ai-assistant/owasp-llm-compliance.md) for the full controls list per item.

7. **Templates-only build variant** — a deployable variant of the LogServ App that disables the LLM-driven flow at compile time. The MCP path + 61 canned prompts + tool tiles + drill-down chips + audit log all stay fully active so the solution can be demonstrated end-to-end without enabling any LLM provider. UI cues: chat input disabled with explanatory placeholder; Send button disabled; model picker hidden; Power Mode toggle hidden; Provider Credentials Settings tab hidden; cyan info-tone banner explains the build mode. Defense in depth: the LLM dispatch entry point bails immediately with a system notice if reached at runtime.

8. **Power Mode** — role-gated `✦ Power` toggle in the AI Assistant chat input. Admin assigns a list of Splunk roles (via `services/authorization/roles`) that may see the toggle; when on, every prompt forces a saved-search dispatch before LLM synthesis (forced-RAG). State persists per-tab in sessionStorage. Audit events tag the toggle state for SOC pivot analysis.

9. **TIME-WINDOW REASONING primer rules** — the AI Assistant's system primer (Tier 1 + Tier 2) now teaches the LLM to: (a) identify the dispatch window before claiming severity, (b) normalize cumulative count to events/hour or events/day before ranking, (c) for any finding ranked `[severity:high]` or `[severity:critical]`, dispatch ONE additional verify query with `earliest=-24h latest=now` BEFORE writing the narrative, and (d) state the window precisely in narrative ("X events in the last 24h" vs. "X cumulative over the search's rolling window"). The result: the AI now self-corrects in one turn instead of needing a follow-up prompt to re-rank cumulative-noise findings.

10. **HostDetails multi-host filter + 3-tab layout** — the Host Details dashboard's host picker is now a `Multiselect` with filter input + Select-All-Matches semantics. Multi-host scope is reflected in URL (`?hosts=h1,h2,h3`) with localStorage persistence. SPL builders splice a `host IN (...)` clause when 2+ hosts are selected. Three tabs: **Overview** (5 KPIs + charts + Host Inventory + Severity Timeline), **Role Activity** (7 role-specific panels with `hideWhenNoData`), **Sourcetype Mapping** (Sankey of source → sourcetype).

11. **Data Pipeline Overview dashboard-wide host filter** — Multiselect + Top-N picker lifted from the chart-level actions slot to the dashboard's title row. Filter scope expanded from one chart to all 4 KPIs + 4 panels + the Sourcetype Mapping linked graph on the second tab.

12. **Path B sourcetype migration** — the legacy `[set_srctype_for_syslog]` transform has been split into four dedicated routing transforms producing four new sourcetypes: `linux:cron`, `linux:warn`, `linux:sudolog`, `linux:slapd`. This clears the AppInspect pretrained-sourcetype warning and avoids field-extraction collisions with `Splunk_TA_nix`'s built-in `[syslog]` stanza. Existing `sourcetype=syslog` data ages out per index retention; dashboards OR both old + new during the transition.

13. **Branded LS app icons** — orange "LS" mark on a dark rounded-square frame. Both the UI App and the Data TA ship the same icon set at 36×36 + 72×72 in regular + Alt variants.

14. **Splunk-pattern legal acknowledgement** — two compile-time legal/liability modals gate the master `enabled` toggle and the audit-forwarder-disabled save (matching Splunk's `splunk_instrumentation` `optInVersion` framework). User identity, Splunk-stamped IP, timestamp, and a SHA-256 of the disclaimer revision are recorded in the audit log so subsequent acknowledgement reviews can prove which revision was acknowledged.

### :material-circle-box:{ .taiconcolor } Enhancements

1. **21 React-based dashboards plus the new Environment Topology view** — every one of the 20 v0.0.4.2 dashboards is a fresh React implementation, a new Multi-Cloud Overview dashboard was added (21 dashboards in total), and the Environment Topology view is a new graph-based surface unique to v0.0.5. All dashboards use the unified dark theme (`#0d1117` page background, `#141b2d` panel fill, `#0877a6` panel outline) and ship the per-dashboard auto-refresh picker.
2. **Saved-Layout schema v4** — the topology view's saved layouts now persist viewport (zoom + pan), enabled integration types, selected node, active right-sidebar tab, and snap-mode in addition to the v3 node + panel positions. Schema migration is in-memory: v1 / v2 / v3 records still load.
3. **`Multiselect` + `Top-N` picker** as a reusable title-row pattern — labelless inline cluster matching the visual idiom across HostDetails and Data Pipeline Overview.
4. **AI Assistant prompt browser tab persistence** — the last selected pack tab is remembered across modal-open events, persisted per-tab via sessionStorage. Persists only when the user actually picked a prompt, not on casual tab-flipping.
5. **Static guidance card per canned prompt** — each predefined prompt's intent-map entry includes an `interpretation` paragraph + bulleted `nextSteps`. Surfaced as a "How to read this result" card after the tool tile lands. Skipped on the AI-driven path (the LLM writes its own commentary). 126 next-step entries split: 64 plain · 57 canned-prompt links · 5 custom-SPL links.
6. **Dashboard Focused prompt browser tab** — first-position tab in the prompt browser that filters the 61 prompts down to those mapped to the current dashboard. Auto-hides when no prompts match. Pack-origin chips on each card so users can find the prompt back in its home pack.
7. **Audit Log Settings tab** — read-only browser of the `logserv_ai_assistant_audit` index with time-range / category / user / limit filters; per-row JSON expand. Inline disclaimer covers the tamper-resistance threat model and recommends HEC-forwarder mitigation. 12 audit categories with distinct gradient-fill chip colors.
8. **HEC audit forwarder** — admin-configurable forwarding of audit events to a separate Splunk / SIEM / S3-with-Object-Lock destination. Browser-side dual-write at flush time. Failure events captured as a separate `audit_forwarder_failure` category so disabled / down forwarders are visible in the audit log itself.
9. **`Visible<T>` brand types** — outbound-message types are tagged `Visible` and unwrap explicitly; the type system refuses to put a `Hidden<MCPToolResult>` into an outbound vendor payload, mechanically enforcing the privacy boundary.
10. **Dynamic timechart span** — every time-series chart's SPL passes a `timechartSpan` computed from the current time range so 30-day windows don't render with 700 data points. Helper at `utils/timechartSpan.ts`.

### :material-circle-box:{ .taiconcolor } Fixed issues

1. **Stale aggregate framing in AI Assistant top-N responses** — the LLM previously cited cumulative aggregates ("4,799 failed authentications") as if they were active rates, leading to misleading "lock the accounts today" recommendations. Build 171's TIME-WINDOW REASONING primer rules now force a verify query before high-severity claims, and the same cumulative number gets correctly downgraded with explicit "stale long-window aggregate, not an active brute-force" framing.
2. **Splunk risky-command safeguard on `nextSteps.spl`** — two intent-map deep-dive strings used `| map maxsearches=1 search="..."` which Splunk flags as risky. Rewrote to first-class subsearch syntax. Intent map version bumped v0.0.8 → v0.0.9.
3. **AZ field bleeding into next osquery section** — the Host Inventory panel's `zone` regex now stops at the `#012` osquery section separator (`[^,#]+` instead of `[^,]+`), so AZ values like `ap-south-1a` no longer carry trailing data from adjacent fields.
4. **MCP cookie auth on same-session HTTP-only Splunk** — verified empirically that the Splunk MCP Server v1.1.0 accepts cookie auth from the same Splunk Web session that's serving the React app, so the default `mcp_server_url` works on HTTP-only Splunk with no bearer token configured. The optional bearer token layers on top via `Authorization: Bearer` and is invalidated on 401 with one retry.
5. **Splunk `services/authorization/roles` endpoint** — Multiselect for the Power Users field reads roles from the correct path; `services/authentication/roles` (a common typo) silently 404s and produces a stuck "Loading roles..." UI.
6. **Splunk Web static-asset cache busting** — every meaningful code change bumps `[install] build` in `app.conf` so browsers don't serve stale bytes after deploy.
7. **Webpack `style-loader` requirement** — adding `import '@xyflow/react/dist/style.css'` exposed a latent webpack-config gap where CSS was being compiled but never reaching the DOM. Both `style-loader` AND `css-loader` are now in the webpack rules.

### :material-circle-box:{ .taiconcolor } Restyled (visual conventions)

1. **21 React dashboards** with the unified dark-theme card style: `#0d1117` page, `#141b2d` panel fill, `#0877a6` panel outline, 3 px rounded corners, 5 px inset, 12 px panel gaps. Equivalent to the v0.0.4.2 DS v2 look but rebuilt natively in styled-components.
2. **Severity dots** — chat findings render with a colored dot (yellow → orange → red → dark-red for low → medium → high → critical) using a radial gradient so they read as glossy beads matching the donut-chart palette aesthetic.
3. **Win11-style 8-dot loading spinner** — replaces the prior cyan-arc indicator in AI Assistant streaming + tool-executing states. CSS-only via single keyframe + per-dot `--angle` variable + staggered `animation-delay`. Reused in the Topology canvas loading overlay (extracted to a shared `Spinner` component).
4. **Cyan-light dotted-underline citation links** — the AI's `[→ saved_search]` citations render as clickable scroll-to-tile spans; sibling `↗ Dashboard` and `↗ Run SPL` chips use the same visual idiom.
5. **Compact Multiselect with Select-All-Matches** — HostDetails + Data Pipeline Overview both use `@splunk/react-ui/Multiselect` with `compact + filter + selectAllAppearance="checkbox"` so typing into the filter narrows the dropdown and the Select All control auto-renames to "Select all matches".
6. **Glossy severity-dot gradients** — `radial-gradient(circle at 35% 30%, ...)` so dots read as 3D beads not flat circles.
7. **Audit-log filter chips with per-category gradients** — 12 categories each get a distinct 3-stop linear gradient with mid-stop ~35–45% luminance for white-text readability, dim-when-unchecked via layered translucent-black wash so the text stays readable.

### :material-circle-box:{ .taiconcolor } Known issues

1. **Tier 0 (Ollama, air-gapped)** is not yet shipped. Tier 0 currently returns "not yet implemented" if selected. Planned for a future release.
2. **`hideWhenNoData` panel-disappearance behavior** continues to apply on HostDetails Role Activity tab. Expected behavior, but empty tabs can feel sparse on hosts that only forward a single sourcetype.

### :material-circle-box:{ .taiconcolor } Splunk Cloud compatibility hardening

Post-initial-release iterations within the v0.0.5.0-beta line that brought the packages to Splunk Cloud Victoria 10.x install-ready posture. All changes are backwards-compatible with on-prem Splunk Enterprise — admins on Enterprise see zero behavior change.

1. **Splunk Cloud Victoria install support** — both the LogServ App and the Data TA now pass `splunk-appinspect inspect --mode precert --included-tags cloud` cleanly. Posture: App = 0/0/0/8/112 (errors / failures / future_failures / baseline warnings / success); Data TA = 0/0/0/11/131. Cleared a Cloud-Victoria-only runtime failure where the LogServ App's Mako template at `appserver/templates/home.html` was being stripped by the Cloud edge proxy because it contained a `<% page_path = ... %>` Python code block (Splunk Cloud Victoria enforces no Python code blocks in Mako templates at runtime, even though `splunk-appinspect` flags it only as a warning). The fix inlines the page-path expression directly into `${make_url(...)}`. Without this, the home view returned HTTP 500 with `TopLevelLookupException` on Splunk Cloud Victoria.

2. **ISC BIND + Squid parsing absorbed natively** — the parsing from the (archived) Splunk Add-on for ISC BIND v2.0.0 and Splunk Add-on for Squid Proxy v2.1.0 is now bundled in the LogServ App, eliminating the need to install those separately. See [Supported Log Types → ISC BIND](../getting-started/supported-log-types.md#isc-bind-iscbind) and [→ Squid Proxy](../getting-started/supported-log-types.md#squid-proxy-squidaccess). Customers who have either standalone TA installed will see a one-time dismissible banner on the LogServ App home view recommending uninstall (otherwise both TAs' parsing runs in parallel, causing duplicate field extraction).

3. **`sc_subadmin` enablement across both packages** — Splunk Cloud Victoria deployments commonly reserve `sc_admin` for Splunk Cloud Operations staff, leaving `sc_subadmin` as the customer's effective top admin role. Both packages now ship with `sc_subadmin` in their `metadata/default.meta` write ACL (`write : [ admin, sc_admin, sc_subadmin ]`). The Data TA's `metadata/default.meta` is post-build-patched by `additional_packaging.py` because UCC's stock build template would silently overwrite the source-level value; a standalone repair script also exists at `tools/scripts/patch_data_ta_sc_subadmin_metadata.py` for patching already-built tarballs. The Data TA's `[script:splunk_ta_sap_logserv_deployment_push]` capability also changed from `admin_all_objects` to the Splunk-standard `edit_deployment_server` so the in-app deployment-push UI works for customer-tier admins. See [Splunk Cloud Victoria Notes](../install-setup/splunk-cloud-victoria-notes.md) for the full role-tier mapping.

4. **AI Assistant settings + T&C acknowledgements migrated to KV Store** — Splunk's REST framework hardcodes `admin_all_objects` as a capability gate on `/configs/conf-X/` writes, IN ADDITION TO the object metadata ACL. On locked-down Splunk Cloud Victoria deployments where `sc_subadmin` doesn't hold `admin_all_objects`, every conf-file write would 403 — including AI Assistant Settings → Save Defaults and every legal-T&C modal Submit. The two mutable conf-file backed stores have been migrated to KV Store collections (`logserv_ai_assistant_settings`, `logserv_ai_assistant_acks`), which check only the collection-level metadata ACL — no capability requirement. A one-shot migration helper in `App.tsx` copies any pre-migration `local/*.conf` values into KV Store on first page load post-upgrade, so customers don't lose customizations or re-prompt on legal modals. See the [Splunk Cloud Victoria Notes](../install-setup/splunk-cloud-victoria-notes.md) page (section "AI Assistant settings + T&C acks in KV Store").

5. **`useIsAdmin` recognizes `sc_admin` + `sc_subadmin`** — the React UI's admin-gating hook (`hooks/useIsAdmin.ts`) expanded from a strict `roles.includes('admin')` check to `roles.some((r) => ADMIN_TIER_ROLES.includes(r))` with `ADMIN_TIER_ROLES = ['admin', 'sc_admin', 'sc_subadmin']`. Without this, the AI Assistant Settings page would have rendered a 403 "Admin access required" fallback for customer-tier Splunk Cloud admins.

6. **Audit-index renamed `logserv_ai_assistant_audit`** — across two hops: `_ai_assistant_audit` → `ai_assistant_audit` (dropped the underscore prefix because AppInspect's `check_lower_cased_index_names` rejects custom-app indexes starting with `_`) → `logserv_ai_assistant_audit` (added the `logserv_` namespace prefix so the index can't collide with any other app that happens to define a generic `ai_assistant_audit`). Functional behavior unchanged across all three names. Both indexes the Data TA provisions are macro-configurable via `sap_logserv_idx_macro` and `sap_logserv_audit_idx_macro`. Customers with existing audit data under either of the older index names will see that data become orphaned on disk after upgrade — not queryable via the new name. Audit retention horizons are typically short and a clean break is acceptable.

7. **Splunk MCP Server JWT `aud = mcp` requirement documented** — Splunk Cloud Victoria's edge proxy auto-injects a JWT into every `/__raw/` splunkd request, and the Splunk MCP Server (Splunkbase App 7931) validates the `aud` claim against the literal `"mcp"`. Common Splunk Cloud Victoria default audiences (e.g., `"Demo"` on non-production stacks) cause the MCP health probe to receive a 403 `Invalid token audience` error, which surfaces as the AI Assistant SETUP REQUIRED banner. The fix is customer-side (re-mint the MCP token with `audience=mcp` OR file a Splunk Cloud Support ticket asking them to align the stack's MCP audience). This is a server-side App 7931 configuration; the LogServ App is audience-agnostic. See [Splunk MCP Setup → Splunk Cloud — JWT `aud` claim must be `mcp`](../ai-assistant/mcp-setup.md#splunk-cloud-jwt-aud-audience-claim-must-be-mcp).

8. **Data TA Cloud-vetting fixes** — cleared 6 pre-existing AppInspect failures + 2 future_failures that had been blocking the Data TA on Splunk Cloud: 4-part SemVer corrected to 3-part (`0.0.5`), `python.version = python3` flag added on scripted-input stanzas, `python.required = 3.13` added on scripted inputs + admin_external handlers, `solnlib<8.0.0` pinned in `requirements.txt` to drop AArch64-incompatible protobuf + gRPC + OpenTelemetry binaries that solnlib 8+ pulls in transitively (also cuts Data TA tarball size 82%, from 9.29 MB → 1.55 MB), illegal `maxTotalDataSizeMB` index property removed, executable shell script relocated alongside `additional_packaging.py` (one level up from `package/`) so UCC stops bundling it.

### :material-circle-box:{ .taiconcolor } Microsoft Azure support

!!! note "Superseded in v0.0.6"
    Azure ingest now uses the dedicated **Splunk TA for SAP LogServ on Azure** add-on (`splunk_ta_sap_logserv_azure`) and its **`sap_logserv_azure_queue`** input (Event Grid → Storage Queue notifications), installed per Heavy Forwarder. The Splunkbase Microsoft-Cloud-Services polling approach described below is the original v0.0.5 implementation, retained here as a release record. See the [Azure Setup Guide](../install-setup/azure-setup.md) for the current setup.

The v0.0.5.0 release adds full Microsoft Azure Blob Storage support alongside the existing AWS S3 ingest. Architectural pattern is symmetric with AWS: the LogServ Data TA pairs with the **Splunk Add-on for Microsoft Cloud Services** (Splunkbase App 3110, v5.0+) on the Heavy Forwarder tier, instead of `Splunk_TA_aws`. Validated end-to-end against a real Azure subscription with the production deployment topology (DS → HF distribution, SAS credential HF-local, NOT pushed via DS).

1. **Azure Blob Storage ingest** — the `mscs_storage_blob` input from the Splunk Add-on for Microsoft Cloud Services polls a configured Azure Blob container under the `logserv/` prefix, downloads each new blob (gzipped NDJSON), and emits events with `sourcetype = sap_logserv_logs`. The LogServ Data TA's existing index-time routing transforms then key on the `source` field's `clz_dir/clz_subdir` segments — identical to the AWS S3 pipeline. No new Data TA configuration required; the routing transforms ARE the multi-cloud abstraction layer.

2. **`cloud_provider` indexed-field attribution** — the Azure input stanza sets `_meta = cloud_provider::azure`, which Splunk persists as an INDEXED field on every event ingested through that input. AWS-ingested events have no `cloud_provider` field on disk (legacy data + AWS S3 input pre-dating Azure support); a new search-time macro `sap_logserv_cloud_provider_default_macro` (`eval cloud_provider=coalesce(cloud_provider, "aws")`) provides the AWS default for cross-cloud reporting. Result: every event in the index reports a `cloud_provider` value of `aws` or `azure`, regardless of when or where it was ingested.

3. **Multi-Cloud Overview dashboard** — new platform-tier dashboard surfaces the per-provider ingest split (event count + sourcetype breakdown + recent activity), built on top of the `sap_logserv_cloud_provider_default_macro`. Lives under the **Platform** navigation group. Useful for capacity-planning across cloud providers + confirming the Azure ingest is healthy.

4. **Four authentication recipes documented** — the [Azure Setup Guide](../install-setup/azure-setup.md) covers four Azure auth paths: (a) Account-key + SAS (testing-grade), (b) Shared Access Signature with container scope (production-friendly, time-bounded), (c) Service Principal with `client_secret`, (d) Managed Identity (no credential stored on the HF — preferred for HFs running on Azure VMs / AKS / Azure App Service). Recipes are independent of the rest of the setup; pick whichever fits the customer's Azure security posture.

5. **Production deployment topology table** — same DS → HF distribution pattern as `Splunk_TA_aws`. Splunk_TA_microsoft-cloudservices is distributed by the Deployment Server to the Heavy Forwarder server class; Search Head and Indexer do NOT have the add-on. SAS credentials and account configuration stay in HF-local config (NOT pushed via DS — environment-specific per-HF).

6. **Compact-JSON requirement called out** — the LogServ Data TA's index-time routing transforms use whitespace-strict regex (`(?=.*"clz_dir":"abap")`) that bypasses silently on pretty-printed JSON. The SAP LogServ collector emits compact JSON natively, but any custom intermediate pipeline that re-formats blobs with `": "` separators would land events at the bootstrap `sap_logserv_logs` sourcetype. Customer-facing docs call this out as a warning.

7. **Data TA Cloud Provider tab + `splunk_solution` indexed field** — the Data TA's **Configuration** page gains a second tab, **Cloud Provider**, with a dropdown (AWS / Microsoft Azure / Not set; default Not set) that stamps an indexed `cloud_provider` field on every event the TA processes — a TA-managed alternative to setting `_meta = cloud_provider::aws|azure` per input. On a Deployment Server the selection deploys to Heavy Forwarders via the same **Deploy to Forwarders** flow as the Filters tab. Separately, the Data TA now always stamps an indexed `splunk_solution = splunk_for_sap_logserv` field on every event (no UI; ships active) so events that flowed through this solution remain identifiable even when the same index also receives data from other solutions. Both fields are written at index time via `WRITE_META` transforms on the bootstrap `sap_logserv_logs` sourcetype. `splunk_solution` is intentionally distinct from the per-sourcetype `vendor_product` search-time field that dashboards and CIM mapping use — the two coexist and do not collide. For a mixed-cloud Heavy Forwarder (one HF ingesting both AWS and Azure), leave the dropdown at Not set and attribute per input via `_meta`. See [Configuring Filters → Cloud Provider Attribution](../install-setup/configure-filters.md#cloud-provider-attribution).

See the [Azure Setup Guide](../install-setup/azure-setup.md) for full step-by-step setup, prerequisites, and troubleshooting.

### :material-circle-box:{ .taiconcolor } Splunk Enterprise Security integration

The LogServ App ships an out-of-the-box Splunk Enterprise Security (ES) content pack. Everything is **dual-mode** — it works with or without ES installed: the `action.notable=1` / `action.risk=1` directives silently no-op when ES is absent, and the Risk Notable's `Risk.All_Risk` data-model search returns 0 rows without ES.

1. **CIM compliance** — 18 eventtypes + matching tags route SAP-specific events (and the absorbed ISC BIND + Squid parsers) into the Authentication / Change / Network_Sessions / Web CIM data models. A new `app.manifest` declares a hard dependency on `Splunk_SA_CIM ≥ 5.0.0`. See [CIM Compliance](../enterprise-security/cim-compliance.md).

2. **19 detection correlation searches + 1 Risk Notable + 2 Asset/Identity feeds** — organized as **6 base/starter** searches (HANA privilege escalation, cross-stack auth-failure burst, ABAP gateway anomalous peer, SCC ACCESS_DENIED burst, HANA failed CONNECT spike, Linux OOM-killer burst), **6 cross-stack** detections, **3 threat-intel** searches, and **4 behavioral / anomaly** detections. All emit `action.notable=1` for ES Notable Review and `action.risk=1` for RBA. The Risk Notable threshold search fires a `severity=critical` notable when accumulated risk on a single object reaches ≥ 100 in 24h. Two scheduled saved searches emit Asset & Identity feed CSVs every 4h. See [Correlation Searches & RBA](../enterprise-security/correlation-searches.md).

3. **Threat-intel framework** — three customer-managed CSV lookups (`logserv_ti_malicious_domains`, `logserv_ti_malicious_ips`, `logserv_ti_compromised_credentials`) ship empty and are populated by the customer; the 3 threat-intel correlation searches join DNS / proxy / authentication events against them. No separate Splunkbase install or ES Threat Framework dependency. See [Threat Intelligence Integration](../enterprise-security/threat-intel.md).

4. **Behavioral / anomaly detections** — statistically-baselined (Z-score via built-in SPL `eventstats`, no MLTK dependency) detections for per-user auth volume, per-host webdispatcher response time, per-edge topology call volume, and per-admin off-hours activity. See [Behavioral & Anomaly Detections](../enterprise-security/behavioral-detections.md).

All ES detections are also **AI Assistant-dispatchable** — they appear as prompts in the Security pack of the predefined-prompt browser. See [Enterprise Security Integration](../enterprise-security/overview.md) for the full overview.

### :material-circle-box:{ .taiconcolor } Third-party software attributions

The v0.0.5.0 LogServ App ships with **`THIRD-PARTY-NOTICES.md`** at the root of the installed app directory (and at the root of the GitHub release source tree). The file lists all 1235 unique top-level npm packages bundled with the React app — names, versions, declared licenses, repository URLs, and full LICENSE / NOTICE / COPYING text where available. License posture: 1012 MIT, 64 ISC, 57 Apache-2.0, 46 BSD-3-Clause, 22 BSD-2-Clause, 11 `@splunk/*` (covered as a Splunk Extension under §1.C of Splunk General Terms), plus a long tail of permissive licenses. **No GPL / AGPL / LGPL components.** See [Third-Party Software](third-party-licenses.md) for the full license-distribution summary and refresh policy.

A CycloneDX 1.4 SBOM (`SBOM.json`) is also regenerated on every build and shipped inside the package alongside `THIRD-PARTY-NOTICES.md`.


## Version 0.0.4.2-beta

### :material-circle-box:{ .taiconcolor } Compatibility

|                                  |                              |
|----------------------------------|------------------------------|
| Splunk platform versions         | 9.4.3 and later              |
| CIM                              | 5.0.0 and later (per `app.manifest`) |
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
9. **KPI sparklines** — ~75 KPIs across all 21 dashboards display an inline daily-trend sparkline below the headline number, using a single-source `timechart + eventstats` pattern. Five flavors: count-based, distinct-count, rate, formatted-volume, and per-day re-detection. One acknowledged exception: the Linux "Top Drop Source" KPI is a string value (`<IP> (<count>)`) with no sparkline.
10. **Click-through drilldowns** — Most KPIs, table rows, and chart points open a filtered Splunk search. Clickable table cells carry a cyan accent so the drilldown affordance is visible.
11. **KPI single values** added to DNS Analytics (Total Queries, Unique Clients, Beaconing Domains), HANA Audit (Total Events, Failed Operations, Active Users), and Web Dispatcher (Total Requests, Error Rate, Avg Response Time). Access Denied Events KPI added to Cloud Connector; Top Drop Source KPI added to Linux.
12. **Enhanced DNS Analytics** — Top Queried Domains, Top Clients by Domain Diversity (DGA detection), Query Type Distribution, and Top DNS Resolvers table.
13. **Enhanced HANA Audit** — Top Users by Activity, Activity by Hour of Day (after-hours detection), and Client IP Analysis.
14. **Enhanced Web Dispatcher** — Request Volume Over Time, Top URIs by Request Count, and Recent Errors (4xx/5xx).
15. **Host Details — 3-tab expansion** — The Host Details dashboard is now organized into three tabs. **Overview** shows a 5-KPI row (Total Events, Data Volume, Active Sourcetypes, Errors/Criticals, Auth Failures), the Host Event Count by Sourcetype timeline, a cross-source Severity Timeline, Host Inventory (CPU/RAM/EC2/OS/region from osquery), Recent Authentication Events + Recent Errors & Criticals cross-source tables, Top Sources, Activity by Hour of Day, and Data Freshness per sourcetype. **Role Activity** contains seven role-specific panels (HANA Audit Activity, ABAP Work Process Mix, Web Dispatcher Traffic by Status, SAP Router Peers, Windows Event Codes, Sudo Commands, DNS Top Queries) that auto-hide via `hideWhenNoData` when the selected host has no data for that component. **Sourcetype Mapping** houses the full-width Sankey chart that was previously inline.
16. **Cross-dashboard navigation** — Every dashboard includes a Navigate to Dashboard dropdown with Go button that preserves the selected time range when switching between dashboards.
17. **In-dashboard documentation link ("More Info" button)** — A cyan **More Info** button in the top-right of every dashboard's toolbar row opens the corresponding online-documentation section in a new browser tab. The link targets the dashboard's section within the appropriate category page (`.../dashboards/applications/#<dashboard-slug>`, etc.) so users can jump from a live dashboard to its narrative documentation in one click. For multi-tab dashboards (Data Pipeline Overview, Host Details) the button appears on every tab.

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

1. **Dashboard "card" style** — All 21 dashboards use a unified visual treatment: `#0d1117` page background, `#141b2d` panel fill, `#0877a6` panel outline, rounded corners, 5 px inset between rect frame and inner viz.
2. **KPI typography standardized** — `majorFontSize: 36`, explicit `labelColor: #7b8ea8`, `labelFontSize: 13`, semantic `majorColor` (`#dc4e41` red for errors, white for neutral counts, orange for warnings, teal for positive signals). The Linux Top Drop Source KPI uses `majorFontSize: 28` as an acknowledged exception for its long-text string display.
3. **Standard red consolidated** — All red color variants (`#e86c5d`, `#af575a`, `#ff3b30`, `#ff2d55`) normalized to single hex `#dc4e41`.
4. **Tables** — Hardcoded header background (`#1e2a3d`), zebra-stripe alternating rows (`#0d1520` / `transparent`), fixed header. Cyan accent on clickable cells indicates drilldown affordance.
5. **12 px panel gaps** — Exact horizontal and vertical spacing between every panel border across all dashboards.
6. **Dashboard descriptions** — Every dashboard now displays a 1-line description below its title.
7. **"Go >" navigation button** — Standardized: 120×25 px at top-left of every dashboard with 10 px padding above and below; majorFontSize 16.
8. **"More Info" documentation button** — Standardized: 140×25 px at top-right of every dashboard, aligned with the right edge of the canvas (10 px padding from the right; x = canvas_width − 150). Same cyan fill `#0877a6`, white text, majorFontSize 16 as the Go button. Opens the dashboard's online-documentation section in a new browser tab via `drilldown.customUrl` with `newTab: true`.

### :material-circle-box:{ .taiconcolor } Known issues

1. The dashboards in the LogServ App use Dashboard Studio v2 format and require Splunk 9.4.3 or later.
2. Several Host Details panels (Host Inventory, Recent Authentication Events, Recent Errors & Criticals, and all seven Role Activity panels) use `hideWhenNoData` and will disappear for hosts that lack the underlying sourcetype data. For example, a Windows host without osquery data will not show the Host Inventory panel; an ABAP-only host will not show the HANA Audit Activity panel on the Role Activity tab. This is the dashboard adapting to the selected host's role — not a bug — but empty tabs can feel sparse on hosts that only forward a single sourcetype.

### :material-circle-box:{ .taiconcolor } Third-party software attributions


## Version 0.0.4.1-beta

### :material-circle-box:{ .taiconcolor } Compatibility

|                                  |                              |
|----------------------------------|------------------------------|
| Splunk platform versions         | 9.4.3 and later              |
| CIM                              | 5.0.0 and later (per `app.manifest`) |
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
| CIM                              | 5.0.0 and later (per `app.manifest`) |
| Supported OS for data collection | Platform independent         |
| Vendor products                  | SAP LogServ for SAP ECS in Amazon Web Services (AWS) |

### :material-circle-box:{ .taiconcolor } New features

1. **Two-package architecture** — The solution is now split into two packages: the **Data TA** (`splunk_ta_sap_logserv`) for data collection and index-time processing, and the **LogServ App** (`splunk_app_sap_logserv`) for dashboards and search-time field extractions. See [Architecture](../getting-started/architecture.md) for details.
2. **Built-in index-time filtering** — Configure include/exclude patterns and time-based filters directly through the Splunk Web UI. Filtered events never consume Splunk license. See [Configuring Filters](../install-setup/configure-filters.md).
3. **AWS Lambda-based filtering** — New deployment option that filters S3 event notifications in AWS before they reach Splunk, reducing S3 GET request costs and SQS message volume. Available via the [AWS Remote S3 Filter Setup Guide](../install-setup/aws-remote-s3-filter-guide.md) or the [Connect to Filter Migration](../install-setup/aws-remote-s3-connect-to-filter-migration-guide.md). Can be used alongside or independently of the native TA filtering.
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
| CIM                              | 5.0.0 and later (per `app.manifest`) |
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
| CIM                              | 5.0.0 and later (per `app.manifest`) |
| Supported OS for data collection | Platform independent         |
| Vendor products                  | SAP LogServ for SAP ECS in Amazon Web Services (AWS) |

### :material-circle-box:{ .taiconcolor } New features

### :material-circle-box:{ .taiconcolor } Fixed issues

### :material-circle-box:{ .taiconcolor } Known issues

1. Drilldown on overview dashboard to host details dashboard has the wrong application name and displays an error when clicking on the host name.

2. The dashboards included in this TA are Dashboard Studio dashboards that may not work with Splunk versions prior to 9.4.

### :material-circle-box:{ .taiconcolor } Third-party software attributions
