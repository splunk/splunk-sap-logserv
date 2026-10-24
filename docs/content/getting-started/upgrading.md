# Upgrading to This Release

Use this page to bring an existing Splunk for SAP LogServ installation up to the current release: LogServ App build 394, Data TA build 1792598960, LogServ Azure add-on build 1792558069 and LogServ GCP add-on build 1792558072, all at version 0.1.2. It applies whether you come from 0.0.5, 0.0.6, 0.1.1 or an earlier 0.1.2 build: find your builds, note the rows of the work list that apply to them, then follow the upgrade sequence.

!!! info "What an upgrade does not touch"
    No data is re-ingested. Events already indexed keep the sourcetype, host, source and folder fields they were indexed with: the Data TA's routing changes apply only to events parsed after you update it. The `local/` configuration of every package and the App's KV Store data (settings, acknowledgements, saved layouts, dashboard data) survive the upgrade. Two things do change for data you already have: some search-time fields, which every search computes anew, and the values some dashboard rollups store, which is why some rows in **Settings → Dashboard Data** need a one-time rebuild.

<br>

## :material-circle-box:{ .taiconcolor } 1. Find Your Builds { #find-your-builds }

**LogServ App.** Click **About** at the bottom of the App's left navigation rail. The dialog shows the version, the build and the build date. (App builds 302 to 338 have **About** in the top navigation bar; earlier builds have none.) On any build, the same from a search on the search head:

```spl
| rest /services/apps/local splunk_server=local
| search title=splunk_app_sap_logserv
| table title version build
```

**Data TA.** Check each instance that parses LogServ data, every heavy forwarder or the single instance, not only the Deployment Server: see [Version Check](capacity-planning.md#version-check). Every 0.1.2 Data TA build has the version `0.1.2`; the builds are told apart only by their build number, which is the time the package was built, in epoch seconds.

**LogServ Azure and GCP add-ons.** Run the search above on each heavy forwarder, or search head, that runs them, with `title=splunk_ta_sap_logserv_azure` or `title=splunk_ta_sap_logserv_gcp`.

Then read your App build in the work list's terms:

| Your LogServ App | Use in the work list |
|---|---|
| Version 0.1.2 | Its build number |
| Version 0.1.1, build 282 to 335, or version 0.0.6, build 258 or later (266 is its last build, and carries the 0.1.1 changes up to build 299) | Build 335 |
| Version 0.1.1, build 245 to 281, or version 0.0.6 before build 258 | Build 281: a full rebuild of the dashboard data |
| Version 0.0.5, or version 0.1.1, build 244 or earlier | Build 244: a pre-rollup build |

<br>

## :material-circle-box:{ .taiconcolor } 2. The Work List { #the-work-list }

Each row of the tables below starts at the last build that lacks a change. **Apply every row whose build is at or above yours**, all of them, in one pass after the upgrade. Rows about **Settings → Dashboard Data** say which rows there to rebuild; [How to Rebuild a Row](#how-to-rebuild-a-row) gives the steps.

#### :material-crop-square:{ .taiconcolor } Rows to Rebuild, by Starting Build { #rows-to-rebuild-by-starting-build }

The Dashboard Data steps of the App work list, combined for the builds an upgrade usually starts from. A row that one change clears and another only backfills needs its Clear and Backfill once. The rows are named as in **Settings → Dashboard Data**; *Beaconing detection* there reads *Beaconing detection (Environment Health / DNS / Network Perimeter)*.

| Your App build | Clear, then Backfill | Backfill only, without Clear |
|---|---|---|
| 383 or later | None | None |
| 379 | Work Process Performance / ABAP Operations | None |
| 378 | Work Process Performance / ABAP Operations | Host Role Activity (Host Details); Environment Topology (graph) |
| 364 to 377 | 12 rows: Work Process Performance / ABAP Operations; HANA Audit; HANA Trace; Environment Health; ABAP Network & Security; Host Role Activity (Host Details); Environment Topology (graph); Environment Topology (detail tabs); Multi-Cloud Overview; Data Pipeline Overview; Host Details; Sourcetype Mapping (Host Details / Data Pipeline) | Change & Configuration Activity; Cross-Stack Authentication |
| 358 to 363 (the released builds 360, 362 and 363) | 14 rows: the 12 above, Proxy Analytics and Cross-Stack Authentication | Change & Configuration Activity; Network Perimeter; Beaconing detection |
| 355 or earlier: 336 (the first 0.1.2 build), or 335 (from the table above) | 17 rows: the 14 above, Beaconing detection, Change & Configuration Activity and Linux System & Security / Network Perimeter | Network Perimeter |
| 281 (from the table above) | Every row, with **Clear all data** | None |
| 244 (from the table above) | Every row, with **Clear all data**: the rollups start empty, but the Environment Topology (graph) row already holds the earlier build's rows | None |

The other steps of the work list still apply to you, whichever line of this table you are on.

#### :material-crop-square:{ .taiconcolor } LogServ App { #ui-app-splunk_app_sap_logserv-what-changes }

Coming from App build 388 or later, there is nothing to rebuild, and no acknowledgement is asked again.

| Coming from App build | Changed in | After upgrading |
|---|---|---|
| 386 or earlier | 388 | With the AI Assistant enabled, the next admin who clicks **Save Defaults** in **Settings → AI Assistant → General** is asked once to accept the enablement acknowledgement, now at version 3; answering No turns the AI Assistant off. While it is disabled nothing is asked, until it is turned on, which always asks. A `local/ai_assistant_acks.conf` that sets `optInVersion` under `[logserv-ai-assistant-enable-tc]` keeps the old version: remove that line. See [Legal Acknowledgement Modals](../ai-assistant/settings.md#legal-acknowledgement-modals). |
| 385 or earlier | 386 | With audit forwarding off, the next **Save Defaults** asks once to acknowledge the audit-log integrity text, now at version 2. With forwarding on nothing is asked. An `optInVersion` line under `[logserv-ai-assistant-tc]` in `local/ai_assistant_acks.conf` keeps the old version: remove it. |
| 383 or earlier | 385 | The App's collections that hold dashboard data (the rollups, the five Environment Topology data collections and the Data Doctor's platform snapshot) can be written by the `admin`, `sc_admin` and `sc_subadmin` roles only; every role still reads them. The topology layout collections (saved layouts, their defaults and each user's layout mode), the dashboard refresh intervals and the Data Doctor's saved reports and ingest facts stay writable by every role. The App's scheduled searches and the Settings backfill keep working. Its searches that write these collections run as the user who starts them. A `[collections/<name>]` stanza with an `access` line in the App's `metadata/local.meta` keeps its own permissions: remove it to take the new ones. A scheduled search of your own that writes into one of these collections and is owned by a non-admin user stops writing. Start the App's writing searches (a retention, a backfill, an ES feed) through the REST API only with an admin-tier account. |
| 379 or earlier | 383, the first released build after 379 | **Clear, then Backfill** Work Process Performance / ABAP Operations, or use the [narrower repair](#narrower-repair-build-383). `wp_category_name` takes SAP's names for the work process trace components: ten values are renamed and nine more letters get names ([field changes](#search-time-field-changes)). The AI Assistant's settings, acknowledgements and model cache can be written by admin-tier roles only. Users whose roles hold neither `edit_tcp` nor `edit_log_alert_event` now see a warning in the AI Assistant panel: their AI Assistant activity is not written to the audit index ([Who Can Write Audit Events](../ai-assistant/audit-log.md#who-can-write-audit-events)). |
| 378 or earlier | 379 | **Backfill**, without Clear, Host Role Activity (Host Details) and Environment Topology (graph). Where the next row applies too, its Clear and Backfill cover both. |
| 377 or earlier | 378 | **Clear, then Backfill** eleven rows and **Backfill** two more: see [Coming From App Build 377 or Earlier](#coming-from-app-build-377-or-earlier). HANA audit, HANA trace and ICM fields change ([field changes](#search-time-field-changes)). |
| 376 or earlier | 377 | Nothing to rebuild. A `search` override in `local/savedsearches.conf` for `logserv_topology_aggregate_nodes`, `logserv_topology_aggregate_edges`, `logserv_topology_detail_aggregate`, `logserv_topology_enrichment_aggregate` or one of their backfill twins keeps the old loopback filter, which leaves out only 127.0.0.1: remove it to take the shipped search, which leaves out every loopback address (127.0.0.0/8). Claude 5.x turns now count toward the AI Assistant's daily spend cap (`daily_spend_cap_usd`, **Settings → AI Assistant → General**): raise it if your users run those models heavily. |
| 375 or earlier | 376 | **Before upgrading**, export the threat-intel lists you keep by hand (step 1 of the [upgrade sequence](#recommended-upgrade-sequence)). After upgrading, if ES reads the asset and identity feed CSVs and your upgrade method does not keep the App's `lookups/` directory, dispatch both feeds once ([Customer Wire-up](../enterprise-security/asset-identity-feed.md#customer-wire-up)). A `search` override of `logserv_topology_retention` in `local/savedsearches.conf` keeps the old search, which trims the edges inside a subsearch of the nodes trim: remove it. The nightly retention window now ends at 02:36. |
| 374 or earlier | 375 | Earlier builds could empty a rollup when Splunkd restarted just before the nightly retention. In **Settings → Dashboard Data**, a row whose aggregation is on but whose **History** reads `empty`, or much shorter than you expect, can be rebuilt with **Backfill** over the history you want, as far back as its raw events are still in the index (at most 365 days). A `search` override for a `logserv_*_retention` stanza in `local/savedsearches.conf` keeps the old behaviour: remove it, or add `override_if_empty=false` to each `outputlookup` it runs. |
| 366 or earlier | 367 | Nothing to rebuild. `vendor_product` and `app` on `linux:slapd` change for Pacemaker lines ([field changes](#search-time-field-changes)). |
| 363 or earlier | 364 to 365 | **Clear, then Backfill** Proxy Analytics, HANA Audit and Cross-Stack Authentication; then **Backfill**, without Clear, Network Perimeter, Environment Health, Beaconing detection and the two Environment Topology rows, which recount what they hold. Rows written before keep the old values, some under the old key `(none)`. Proxy request totals fall where Squid's `store.log` and `cache.log` are collected: those lines are not requests and are no longer counted. Several fields change ([field changes](#search-time-field-changes)). |
| 357 or earlier | 356 to 358 | **Clear, then Backfill** Linux System & Security / Network Perimeter: it recorded fragments of ordinary words as **Kernel Event Types**. Coming from 356 or earlier, also Change & Configuration Activity: it stored the after-hours flag in the time zone of the search that wrote the row, so where a Settings backfill ran in another time zone than the search head's, hours were stored twice. Coming from 355 or earlier, also Beaconing detection: it keyed each day on midnight in the writing search's time zone, so a day could be stored twice. Each rebuild is safe whether or not your data was affected. |
| 281 or earlier | 282 | The dashboard rollups (all but the Environment Topology's) added `cloud_provider` to the keys of their rows. **Clear all data** (**Settings → Dashboard Data**, Danger zone), then **Run backfill** over the history you want. This replaces every other Clear and Backfill of this list. |
| 244 or earlier | 245 | The dashboards move to the rollup collections, which the upgrade creates empty; the Environment Topology collections already hold the earlier build's rows: see [Coming From a Pre-rollup Build](#coming-from-a-pre-rollup-build-dashboards-populate-from-a-cache-that-starts-empty). **Clear all data** (**Settings → Dashboard Data**, Danger zone), then one **Run backfill** over the history you want. This replaces every other Clear and Backfill of this list. |

#### :material-crop-square:{ .taiconcolor } Coming From App Build 377 or Earlier { #coming-from-app-build-377-or-earlier }

App build 378 changes values that several rollups store, most of them in the keys the rows are stored under:

- the search-time `host` of HANA audit events is the HANA host that wrote the record (the client's host name is `src_host`), and HANA audit records with no client fields now parse;
- HANA trace lines take severity, component and duration from their exact format (`backup.log` levels; hdbcons timings in microseconds and seconds converted to milliseconds; hdbcons, SQL-trace, load and availability files carry no severity);
- RFC edges in the Environment Topology count connections, in the direction they were made;
- the three digits after a session ID in the ICM trace (`dev_icm`) are read as the SAP client (`sap_client`), no longer as an HTTP status, so the ICM error counts change and the ICM status panels are replaced.

Rows written earlier keep the old values, most under the old keys. The first hourly run after the upgrade rewrites the last hour or two under the new keys, so those hours count twice until rebuilt, and so does any later Backfill over earlier days, **Backfill N days** for late-arriving data included. Until you rebuild: HANA Audit's *Failed Operations by HANA Host* lists client hosts beside the HANA hosts for the days before the upgrade; HANA Trace keeps record files under UNKNOWN and `backup.log` lines under fragment components, and misses microsecond-timed commands; ABAP Network & Security counts ICM sessions in SAP clients 400 to 599 as ICM errors; the Environment Topology draws a second, reversed edge for the old RFC rows, and an edge with a node of its own for each client host name of the old HANA audit rows. After the upgrade, the average on HANA Trace's *hdbcons Command Duration (Avg / Max)* panel usually falls, because microsecond-timed commands now count.

**After** the upgrade (a Clear before it is undone by the old build's last runs), **Clear, then Backfill** each of these rows with a window that covers its whole history, using each row's own **Backfill**:

- HANA Audit
- HANA Trace
- Environment Health
- ABAP Network & Security
- Host Role Activity (Host Details)
- Environment Topology (graph)
- Environment Topology (detail tabs)
- Multi-Cloud Overview
- Data Pipeline Overview
- Host Details
- Sourcetype Mapping (Host Details / Data Pipeline)

Then **Backfill**, without Clear, **Change & Configuration Activity** and **Cross-Stack Authentication**: they gain the HANA audit records that have no client fields, under keys that do not change.

- A Backfill without the Clear counts the upgraded hours twice, on Environment Health too, which sums its error counts across hosts. On ABAP Network & Security alone it keeps the old ICM error counts instead. Where the search below returns 0, your ICM error counts were never affected, and a **Backfill** alone is enough on that row:

    ```spl
    | inputlookup logserv_abapnet_rollup where metric="icmerr" | stats count
    ```

- Keep the Settings page open until the **Environment Topology (graph)** row has finished: that row writes each month only once every search of the month has finished. SAP Router edges have no history until the Environment Topology rows are backfilled.
- The Clear removes everything a row holds, including history older than the raw events still in your index, which no Backfill can bring back. To keep that history, use the [narrower repair](#narrower-repair-build-378) instead.
- This rebuild also re-keys the RFC rows by application server, the change of 0.1.1 builds 324 to 325. No separate RFC migration is needed: do not run the RFC-only steps in the [0.1.1 release notes](../overview/release-notes-0.1.1.md) on this release. The shipped edges backfill now has two gateway searches, one per direction, and those steps keep only one of them.
- A `search` override in `local/savedsearches.conf` for a rollup aggregation or backfill search keeps the old search after the upgrade: compare it with the shipped one, or remove it.
- `sap:abap:icm` leaves the CIM Web data model (its `sap_abap_icm_request` eventtype is removed). If that data model is accelerated, ICM events summarized before the upgrade stay in its summaries until they age out of the summary range or you rebuild the acceleration.
- With a Data TA build before 1792189743, the AWS S3 Direct screen does not list the `sap/saprouter` folder under the two Environment Topology rows: when you load SAP Router history from S3 for the topology, also select its **SAP Router** row.

#### :material-crop-square:{ .taiconcolor } Coming From a Pre-rollup Build { #coming-from-a-pre-rollup-build-dashboards-populate-from-a-cache-that-starts-empty }

Current dashboards read most panels from KV Store rollup collections. On the first upgrade from a pre-rollup build (0.0.5, or a 0.1.1 build 244 or earlier) the rollup collections are created empty, and the rolled-up panels show no data until they fill. The Environment Topology collections are not empty: the earlier build already kept and filled them, with RFC edges keyed before the per-application-server breakdown and drawn in the opposite direction, and HANA audit edges to client hosts. A Backfill does not remove those rows, and the topology keeps them for up to 365 days beside the new ones, so the Environment Topology would draw doubled or reversed RFC edges and nodes for client hosts.

1. **Clear all data** first: in **Settings → Dashboard Data**, Danger zone, after the upgrade and clear of the nightly retention window. It empties every rollup and the Environment Topology collections; the rollups are empty anyway.
2. **Run the backfill once** (recommended on any install with real data): choose a **Backfill window** that covers the raw history your index holds, usually the 365-day preset, then click **Run backfill**. The window is 30 days by default; it also offers 60, 90, 180 or 365 days, or a custom range of whole UTC days back to the 365-day retention. The backfill is idempotent and can be run again. See [Backfilling on First Install](../logserv-app/dashboard-data.md#backfilling-on-first-install). Without it, the hourly aggregation searches fill the collections one hour at a time from the upgrade on.

The `tstats` panels (Data Pipeline Overview, the Host Details counts, Multi-Cloud Overview and the count KPIs) read the index directly and work at once, and so does every panel at a time range under 90 minutes, which reads raw events.

Coming from a 0.0.5 build before 192 or a 0.1.1 build before 240, open the App once as an admin after the upgrade: on that first page load it copies the AI Assistant settings and acknowledgements that those builds kept in `local/` conf files into the KV Store.

#### :material-crop-square:{ .taiconcolor } New Scheduled Searches, New Collections, and a Restart { #new-scheduled-searches-new-collections-and-a-restart }

Relative to a pre-rollup build, the upgrade adds the rollup aggregation, retention and detection searches and the rollup collections. A Splunkd restart is required for the collections to be created and the new searches to register; Splunk Web's **Install app from file** upgrade asks for it. The scheduled searches are staggered so the scheduler never bursts; see [Scheduled-Search Schedule](../logserv-app/dashboard-data.md#scheduled-search-schedule).

#### :material-crop-square:{ .taiconcolor } Visible UI / Panel Changes When Coming From v0.0.5-era Builds { #visible-ui-panel-changes-when-coming-from-v005-era-builds }

- Every chart and table panel header has a toolbar (**Open in Search**, **Download CSV**, **Inspect**, **Refresh**), a loading spinner and the Data Doctor's **Diagnose** action; empty panels explain themselves ([Data Doctor](../logserv-app/dashboards/platform/diagnostics.md)).
- Percentile charts (p50 / p95 / p99) become **Avg + Max** by hour; HANA Trace's slowest-operations panel is a top-by-max table; Web Dispatcher's *Top URIs* has no *Unique Clients* column.
- Rolled-up panels are hourly-fresh at wide time ranges; ranges under 90 minutes use the panels' raw searches, so short-range investigation stays real-time.
- The App uses the Cisco Magnetic theme (dark by default, with a light mode), a left navigation rail, and the current Environment Topology layout and node designs.
- Your browser may briefly serve a cached bundle; a hard refresh loads the new build.

#### :material-crop-square:{ .taiconcolor } Search-Time Field Changes { #search-time-field-changes }

The App computes these fields when a search runs, so the change applies to events old and new as soon as the App is upgraded. The App's dashboards use the new fields. Saved searches, alerts and reports of your own that read them need the new names or values.

| Coming from App build | Sourcetype | Change |
|---|---|---|
| 379 or earlier | `sap:abap:workprocess` | `wp_category_name` takes SAP's names for the trace components: C, D, M, N, O, Q, R, S, T and X are renamed (for example `C = Database (DBSL)`, `D = Diag Processor`, `Q = Other`), and E, G, H, I, J, L, P, V and W, which read `<letter> = Other`, get names. |
| 377 or earlier | `sap:hana:audit` | `host` is the HANA host that wrote the record; the client's host name is the new `src_host`. Searches that group `by host` now group by HANA host. Records with no client fields parse fully. |
| 377 or earlier | `sap:hana:tracelogs` | Record files (hdbcons, SQL trace, loads, system availability) carry no `hana_trace_severity`; `backup.log` lines carry their own level and component. New fields: `hana_trace_file_type`, `hana_backup_level`, `hana_op`, `hana_op_duration`, `hana_op_duration_unit`; `hana_op_duration_ms` is always in milliseconds. |
| 377 or earlier | `sap:abap:icm` | `icm_status_code`, `status` and `action` are gone. The SAP client of a session is `sap_client`, its user `icm_user`, its terminal `icm_terminal`. `icm_is_error` is true only on lines the ICM logged as errors. On connection lines `src` and `dest` follow the connection's direction (`icm_conn_role`). The `sap_abap_icm_request` eventtype and its tag are removed. |
| 377 or earlier | `sap:webdispatcher:access` | New `sap_sid` and `sap_instance`, read from the log's path. |
| 377 or earlier | `sap:saprouter`, `sap:abap:gateway` | New fields for the SAP Router targets (`saprouter_target_*`, `saprouter_fail_target_ip`) and the gateway's connection records (`gw_remgw_*`, `gw_client_*`, `rfc_peer_port`, `rfc_local_port`). |
| 366 or earlier | `linux:slapd` | `vendor_product` and `app` read `Pacemaker` and `pacemaker` on `pacemaker.log` lines; `slapd.log` lines keep `OpenLDAP` and `slapd`. |
| 364 or earlier | `linux:slapd` | `os_user` is removed. Pacemaker lines carry `resource_agent` and `cluster_resource`, or `pacemaker_daemon` and `pacemaker_function`. |
| 364 or earlier | `sap:hana:audit` | `sql_statement` and `command` are shown without JSON escapes. |
| 364 or earlier | `sap:sapstartsrv` | `source_location` reads file names that contain a dot and skips the `[Thr N]` thread marker. |
| 364 or earlier | `squid:cache`, `squid:store` | New sourcetype stanzas for the Data TA's new Squid routes, with no automatic key=value fields. |
| 363 or earlier | `linux:sudolog` | `command` holds the whole command, with continuation lines joined and escapes removed. |
| 363 or earlier | `lastlog` | `USERNAME` accepts user names with `-`, the header line is skipped, and the new `PORT` field holds lastlog's Port column (for example `<console>`). |
| 363 or earlier | `sap:hana:audit` | `status` and `target_user` are read for every action, not only connect-type actions; user and privilege statements match in any letter case and when quoted; `audit_datetime` is set on records whose time ends in `Z`. |
| 363 or earlier | `squid:access` | Proxy fields are also extracted from Squid's `logformat=splunk_recommended_squid` form. |
| 363 or earlier | `sap:abap:gateway`, `sap:scc:http_access`, `sap:sapstartsrv`, `sap:saphostexec` | `gw_error_detail`, the Cloud Connector's `http_version` and the `error_message` of the Start Service and the Host Agent end where the line ends. |

#### :material-crop-square:{ .taiconcolor } Data TA { #data-ta-work-list }

The Data TA does its work where LogServ data is parsed, on the heavy forwarders or a single instance, so its changes reach events parsed after it is updated there; events indexed earlier keep their sourcetype and fields. Apply every row whose build is later than yours. Coming from 0.0.5, 0.0.6 or 0.1.1, every 0.1.2 row applies: their routing is that of the first 0.1.2 build.

| Coming from Data TA | Changed in | What changes, and what to do |
|---|---|---|
| A build before 1792598960 | 1792598960 (2026-10-21) | Parsing, routing and filtering are unchanged, and nothing has to be saved again. The AWS S3 Direct screen accepts the Splunk Add-on for AWS 8.1.0 and any later version (earlier builds warned about any version but 8.1.0) and no longer blocks a search head or Splunk Cloud. |
| A build before 1792189743 | 1792189743 (2026-10-16) | **Before you update**, remove routes of your own from the Data TA's `local/transforms.conf`, such as the six `(?s)^` routes of build 1791935359 if you added them there as a test ([Version Check](capacity-planning.md#version-check)): `local/` wins over `default/` key by key, so the old REGEX would stay in effect with the new 100,000-character window, a combination that exceeds Splunk's regex match limit. Every metadata rule and sourcetype route now reads up to 100,000 characters of a line; earlier builds read 4,096. An AWS event longer than about 4 KB used to keep the input's own host and source, get no folder fields and stay `sap_logserv_logs`, while the filters (from 1791565776) already judged it by its folder fields; it now gets its real host, source, folder fields and sourcetype. Searches of your own that find such events under `sap_logserv_logs` need their final sourcetype. The ICM route takes only the ABAP ICM folder (`abap/icm`): a `webdispatcher/icm` folder keeps `sap_logserv_logs`. The BIND, Windows and sssd routes match only within the `source` value. |
| A build before 1791935359 | 1791935359 (2026-10-13) | Data TA builds from 0.0.4.1 up to, but not including, this one carry five or six routes whose cost grows with the square of the line length: 2.4 ms of CPU per event on the lab heavy forwarder, about 400 events a second for one pipeline set. Update every instance that parses LogServ data before you size or add hardware ([Capacity Planning and First Start](capacity-planning.md)). |
| A build before 1791565776 | 1791565776 (2026-10-09) | **Configuration → Filters** gains **Include Sources** and **Exclude Sources** (empty by default), and the filter rules read the whole line. Behaviour change: an Include Filters list that mixes `*/*` or a standalone `*` with other entries now keeps every event. Before, `*/*, linux/cron` dropped every event without folder fields, and `*, linux/cron` kept only `linux/cron`. To keep an allow-list, remove `*/*` and `*` from it. HANA `.trc` files and `backup.log` delivered without folder fields get `sap:hana:tracelogs` from their path ([Data Delivered Without Folder Fields](supported-log-types.md#data-delivered-without-folder-fields)). With Filtering on, open **Configuration → Filters** after the update, click **Save**, and on a Deployment Server click **Deploy to Forwarders**, so the forwarders get the regenerated rules. On a Deployment Server with Filtering on and Days in the Past above 0, the daily filter refresh now finds and reloads the server class (before, whether it found it depended on the default app of the user the refresh runs as, and when it did not, the forwarders kept the previous cutoff), so each forwarder in the server class restarts about once a day to apply the new cutoff ([Days in the Past](../install-setup/configure-filters.md#days-in-the-past)). Use App build 377 or later with it: the Data Doctor of App build 376 and earlier ignores source rules and reports folder patterns with `*` or `?` as only partly read ([Reading the Active Filter Configuration](../install-setup/configure-filters.md#reading-the-active-filter-configuration)). |
| A build before 1790374045 | 1790374045 (2026-09-25) | The Data TA declares the folder paths `linux/proxy` and `linux/pacemaker`: with Filtering on and an explicit Include Filters list, add them where those logs should be kept, because events under them are dropped at the forwarder ([Upgrade Notifications](../install-setup/configure-filters.md#upgrade-notifications)). |
| A build before 1790368041 | 1790368041 (2026-09-25) | Squid's `cache.log` goes to `squid:cache` and `store.log` to `squid:store`; `access.log` stays `squid:access`, and all three keep the `proxy/squid` filter path. Events indexed earlier keep `squid:access`. The App's dashboards count `access.log` lines only; searches of your own that read the other two files under `squid:access` need the new names. |
| A build before 1790292318 | 1790292318 (2026-09-24) | Long NDJSON lines are unwrapped and kept whole: lines with many escaped characters, from about 1.5 KB, no longer keep their envelope, and lines up to 100,000 bytes are no longer cut at 10,000. Events indexed earlier keep their envelope. |
| A 0.0.5 build whose version reads `0.0.5.0` (four parts), or 0.0.5.1 | 0.0.5 (version `0.0.5`) | The audit index is `logserv_ai_assistant_audit`; those builds define `_ai_assistant_audit` instead. Where the Data TA holds your index definitions, the update defines the new index; where they are defined elsewhere (the indexer tier, Splunk Cloud), create `logserv_ai_assistant_audit` there ([Create the Indexes](../install-setup/install-ta.md#1-create-the-indexes)), and update a copy of the Data TA that an indexer holds. Then check that **Audit index name** under **Settings → AI Assistant → General → Audit & Telemetry** reads `logserv_ai_assistant_audit`. Audit events written earlier stay in `_ai_assistant_audit` and are not searchable under the new name. |
| 0.0.4.2 or earlier | 0.0.5 | The cron, warn, sudo and slapd logs move from Splunk's `syslog` sourcetype to `linux:cron`, `linux:warn`, `linux:sudolog` and `linux:slapd`. Events indexed as `syslog` keep it until retention removes them; the App's Linux and Change & Configuration searches read both. |

**Splunk Add-on for AWS.** Nothing in the solution enforces a version. Splunk's advisory SVD-2026-1005 (third-party package fixes) says to upgrade the add-on to 8.2.2 or later, so run 8.2.2 or later on the forwarders; these docs were checked with 8.3.1. The AWS S3 Direct screen was validated with 8.1.0 and shows an advisory for an older version.

**AWS Copy stacks.** A stack created from an earlier `splunk-logserv-remote-s3-copy.yaml` runs its Lambda on `python3.9`, which AWS has deprecated. The current template uses `python3.12`; the function's code is unchanged. Update the stack with the current template, keeping your parameter values ([AWS Remote S3 Copy guide](../install-setup/aws-remote-s3-copy-guide.md)). Filter stacks already run `python3.12` and need no change.

**Cloud Provider dropdown.** If the Data TA's **Configuration → Cloud Provider** tab is set to a cloud on your forwarders, read [Choose Cloud Attribution](../install-setup/cloud-attribution.md) before you change anything. The inputs of the LogServ Azure and GCP add-ons always stamp `cloud_provider`, the AWS S3 Direct screen stamps every input it creates, and the dropdown adds its value beside such a stamp, not in its place, so those events carry the field twice. The recommended setting is **Not set**, with `_meta = cloud_provider::aws` on each SQS-Based S3 input; to move a fleet from the dropdown set to **AWS** to that setting, see [Alternative for AWS-Only Fleets](../install-setup/cloud-attribution.md#alternative-the-dropdown-set-to-aws). A change applies to events parsed after it.

#### :material-crop-square:{ .taiconcolor } LogServ Azure and GCP Add-ons { #ingest-add-ons }

- **Update them on each heavy forwarder, or search head, that runs them**, never through the Deployment Server: each input's credential (the Azure SAS, the GCP service-account key) is stored, encrypted, in the add-on's own `local/passwords.conf` on that instance. An app upgrade keeps that file, and nothing has to be moved to `system/local`; a Deployment Server push would replace it. See [Install the Azure Add-on](../install-setup/azure-setup.md#install-the-azure-add-on) and the [GCP Setup Guide](../install-setup/gcp-setup.md).
- **Any 0.1.2 build runs the same code.** Builds 1792558069 (Azure) and 1792558072 (GCP) change only the workloads the add-ons declare (so that a search head is an allowed target, Splunk Cloud included) and their README and Inputs-page text, and builds 1792213309 and 1792213464 only their third-party notices, package pins and README text; every Python file is that of the first 0.1.2 builds.
- **Azure, coming from 0.0.5.** 0.0.5 read Azure data with the Splunk Add-on for Microsoft Cloud Services (Splunkbase 3110), which its setup guide placed in the `SAP_LogServ_HeavyForwarders` server class. Set up the LogServ Azure add-on on the forwarder that will read SAP's queue ([Configure the Input](../install-setup/azure-setup.md#configure-the-input)), then disable the Microsoft Cloud Services input that read the LogServ storage, so no blob is indexed twice.
- **GCP, onboarded with an SAP-issued key.** The add-on signs in with the service-account key its input holds, wherever that account lives, so a deployment that uses a key SAP issued for a service account in the SAP-managed LogServ project needs no change. New onboarding uses the customer-homed sequence in [The Onboarding Sequence](../install-setup/gcp-setup.md#the-onboarding-sequence).
- **GCP, coming from the Splunk Add-on for Google Cloud Platform (Splunkbase 3088).** As of its version 5.0.3 (checked 2026-07-05), its *Cloud Pub/Sub Based Bucket* input does not decompress gzipped objects, so it fails on LogServ's `*.json.gz` objects, and it needs `roles/pubsub.viewer` beyond the roles SAP documents. Use the LogServ GCP add-on, and disable any 3088 input on the LogServ subscription.

<br>

## :material-circle-box:{ .taiconcolor } 3. Upgrade Sequence { #recommended-upgrade-sequence }

The packages can be updated in either order. This order checks the forwarders before the App and leaves the Dashboard Data rebuild, which reads the indexed events, for the end.

1. **Prepare.**
    - Find your builds and note the work-list rows that apply.
    - Export the threat-intel lists you keep by hand. `logserv_ti_malicious_domains.csv`, `logserv_ti_malicious_ips.csv` and `logserv_ti_compromised_credentials.csv` ship in the App's `lookups/` directory as header-only files, so an upgrade may replace rows you added. For example `| inputlookup logserv_ti_malicious_domains | outputcsv logserv_ti_malicious_domains_backup` writes to `$SPLUNK_HOME/var/run/splunk/csv/` on the search head; re-upload the list afterwards under **Settings → Lookups → Lookup table files**. A list that a recurring saved search writes ([Threat Intelligence Integration](../enterprise-security/threat-intel.md)) is refilled on that search's next run.
    - Note the `local/` overrides the rows name: `search` overrides in `local/savedsearches.conf`, `[collections/...]` stanzas in the App's `metadata/local.meta`, `optInVersion` lines in `local/ai_assistant_acks.conf`, and routes of your own in the Data TA's `local/transforms.conf`. Remove those routes before you update the Data TA.
    - Plan the Dashboard Data rebuild for a time clear of the nightly retention window: 00:34–00:58, 01:30–01:58 and 02:34–02:36 in the search head's local time.
2. **Update the Data TA where it parses data**, as described in [Updating the Data TA](#data-ta-splunk_ta_sap_logserv-routine-upgrade) below.
3. **Update the LogServ Azure and GCP add-ons** on each heavy forwarder, or search head, that runs them: **Apps → Manage Apps → Install app from file** with **Upgrade app** selected, or `$SPLUNK_HOME/bin/splunk install app <tarball> -update 1`, then restart Splunk. On a Splunk Cloud search head, update them as private apps ([On Splunk Cloud](#on-splunk-cloud)).
4. **Check each forwarder's build** ([Version Check](capacity-planning.md#version-check)).
5. **Update the LogServ App on the search head.** On Splunk Enterprise: **Apps → Manage Apps → Install app from file**, select the tarball and **Upgrade app**, then restart Splunk when asked. On a search head cluster, never update the members one by one: on the deployer, replace `$SPLUNK_HOME/etc/shcluster/apps/splunk_app_sap_logserv` with the new build, keeping any `local/` you keep there, then run `splunk apply shcluster-bundle` ([Splunk Enterprise: search head cluster](../logserv-app/installation.md#splunk-enterprise-search-head-cluster)). On Splunk Cloud, see [On Splunk Cloud](#on-splunk-cloud).
6. **Hard-refresh the browser**, then open **About** and check that it shows build 394.
7. **Work through the App rows of the work list**, the Dashboard Data rebuild included ([How to Rebuild a Row](#how-to-rebuild-a-row)). If you also load history from S3 with the [AWS S3 Direct](../install-setup/aws-s3-direct.md) screen, let that backfill finish first, so that one rebuild includes it.
8. **Enterprise Security content.** The App ships its `splunk_sap_logserv_es_*` searches enabled: correlation searches hourly, behavioral anomalies daily, feeds every 4 hours. They run on their schedules whether or not Enterprise Security is installed, and their notable and risk actions need it. On a search head without Enterprise Security, disable them ([Disabling or Tuning the ES Content](../enterprise-security/overview.md#disabling-or-tuning-the-es-content)). Thirteen of them also run the AI Assistant's Security-pack prompts: if you use those prompts, read that section before you disable anything.
9. **Check the result.** In **Settings → Dashboard Data**, every row shows its history and none reads *failed — re-run* or *truncated — re-run*; the dashboards show data for the ranges you rebuilt.

#### :material-crop-square:{ .taiconcolor } Updating the Data TA { #data-ta-splunk_ta_sap_logserv-routine-upgrade }

Install the new tarball over the existing one where the Data TA runs: **Apps → Manage Apps → Install app from file** with **Upgrade app** selected, or `$SPLUNK_HOME/bin/splunk install app <tarball> -update 1`, then restart Splunk when asked. An app upgrade keeps `local/`.

- **Single instance**, or **heavy forwarders without a Deployment Server:** on each instance. Coming from a build before 1791565776 with Filtering on, click **Save** on **Configuration → Filters** on each one.
- **Heavy forwarders with a Deployment Server:** on the Deployment Server only, then into `deployment-apps/` and out to the forwarders, as below. Do not install it directly on a forwarder that the Deployment Server manages: the next push replaces that copy, its `local/` included.
- **A Splunk Cloud search head that runs LogServ inputs:** as a private app ([On Splunk Cloud](#on-splunk-cloud)).
- **An indexer:** only if you installed the Data TA there. On an indexer only its `indexes.conf` takes effect. The 0.0.5 builds with the version `0.0.5`, and 0.0.6, 0.1.1 and 0.1.2, define the same two indexes, `sap_logserv_logs` and `logserv_ai_assistant_audit`, so such a copy can stay as it is; updating it there as well does no harm. Early 0.0.5 builds (version `0.0.5.0`) and 0.0.5.1 define `_ai_assistant_audit` instead: update that copy, or create `logserv_ai_assistant_audit` on the indexer tier ([Data TA](#data-ta-work-list)).

With a Deployment Server:

1. Install the new build over `etc/apps/splunk_ta_sap_logserv/` on the Deployment Server.
2. Replace the copy in `etc/deployment-apps/`, keeping its `local/` folder. A Save on the Configuration page copies the Data TA into `deployment-apps/` only when that copy is missing or its version differs, and every 0.1.2 build has the version `0.1.2`, so a later 0.1.2 build never gets there by itself ([Later Builds With the Same Version](../install-setup/distribute-data-ta.md#later-builds-with-the-same-version)). As the user Splunk runs as:

    ```bash
    cd $SPLUNK_HOME/etc/deployment-apps
    mv splunk_ta_sap_logserv ~/splunk_ta_sap_logserv.before-upgrade
    tar -xzf /path/to/splunk_ta_sap_logserv-0.1.2.tar.gz -C .
    cp -a ~/splunk_ta_sap_logserv.before-upgrade/local splunk_ta_sap_logserv/
    grep -E "^(version|build)" splunk_ta_sap_logserv/default/app.conf
    ```

    The last command shows the new build. If the old copy has a `metadata/local.meta`, copy it into `splunk_ta_sap_logserv/metadata/` as well. Keep the moved copy until every forwarder runs the new build. The same steps work coming from 0.0.5, 0.0.6 or 0.1.1. (There a Save would also replace the `deployment-apps/` copy, because the version changes, with a copy of `etc/apps/splunk_ta_sap_logserv/`, `local/` included, which drops anything you added by hand under `deployment-apps/splunk_ta_sap_logserv/local/`.)

3. Coming from a build before 1791565776 with Filtering on: open **Configuration → Filters** on the Deployment Server and click **Save**, so the rules are generated in the new form and copied into `deployment-apps/`.
4. Click **Deploy to Forwarders** on the Filters tab. Each forwarder picks the change up at its next phone-home (60 seconds by default) and restarts; allow 5 minutes or more. The button reloads every server class on the Deployment Server ([Deploy to Forwarders](../install-setup/distribute-data-ta.md#4-deploy-to-forwarders)).
5. Check the build on each forwarder ([Version Check](capacity-planning.md#version-check)).

#### :material-crop-square:{ .taiconcolor } On Splunk Cloud { #on-splunk-cloud }

Update each package on the Splunk Cloud stack the way you installed it, as a private app: in Splunk Web, open the gear icon next to **Apps**, then **Install app from file** and **Upload App**, sign in with your splunk.com account and upload the tarball. When the **Uploaded Apps** table shows it as **Approved** (Splunk Cloud vets the package first), click **Install**. The Data TA is needed on the stack only where LogServ inputs run on the search head ([Splunk Cloud Considerations](splunk-cloud.md)).

Every 0.1.2 build keeps the version `0.1.2`. On a Splunk Cloud 10.5 stack, later 0.1.2 builds of the App and the Data TA installed over earlier ones in this way, without a restart prompt (tested 2026-10-21); other Splunk Cloud versions have not been tested. If your stack does not offer **Install** because version 0.1.2 is already installed, stop there: do not uninstall the installed app to make room for the new one, because uninstalling removes its `local/` configuration. Open a Splunk Cloud support case instead.

Forwarders you run yourself are updated as described above. The narrower repairs below need the search head's management port, which on Splunk Cloud must first be opened for you. If you cannot reach it, use the Clear and Backfill instead.

<br>

## :material-circle-box:{ .taiconcolor } 4. How to Rebuild a Row { #how-to-rebuild-a-row }

1. Rebuild **after** the upgrade, on the new build: a Clear done before the upgrade is undone by the old build's last hourly runs.
2. Pick a time clear of the nightly retention window, 00:34–00:58, 01:30–01:58 and 02:34–02:36 search-head time. A retention search rewrites its whole collection and erases rows that a backfill running at the same time has just added.
3. Open **Settings → Dashboard Data** ([The Dashboard Data Settings Tab](../logserv-app/dashboard-data.md#the-dashboard-data-settings-tab)). Under **Backfill window**, choose a window that covers the history you want: the 365-day preset reaches as far back as a rollup keeps rows, and a custom range takes whole UTC days. The default is 30 days. A window longer than 90 days shows a cost warning first; for scale, a 365-day backfill of every row took 195 minutes on the reference system. The two flat Environment Topology collections (the host-to-SID inventory and the IP enrichment) always read the last 30 days.
4. For each **Clear, then Backfill** row: note its **History**, click **Clear** and confirm, then click the same row's **Backfill**. Wait until it has finished before you start the next row.
5. For each **Backfill only** row: click its own **Backfill**, without Clear.
6. Use each row's own **Backfill**, not the button under the window (**Run backfill**, or **Re-run backfill (all)**): it backfills only the rows it considers incomplete, or every row when it considers all of them complete. Use it only where this page says so: after **Clear all data**, coming from build 281 or earlier.
7. Keep the page open until the **Environment Topology (graph)** row has finished.
8. A row that shows *failed — re-run* or *truncated — re-run* needs its **Backfill** again; repeating a backfill is safe.

The Clear removes everything a row holds, including history older than the raw events your index still holds, which no Backfill can bring back. For the two biggest rebuilds a narrower repair keeps that history.

#### :material-crop-square:{ .taiconcolor } Narrower Repair After App Build 378 { #narrower-repair-build-378 }

Use this instead of the Clear and Backfill of [Coming From App Build 377 or Earlier](#coming-from-app-build-377-or-earlier) to keep history older than your raw events. It deletes only the rows inside the window you will backfill and leaves older rows as they are. It needs the search head's management port; if you cannot reach it (on Splunk Cloud it must first be opened for you), use the Clear and Backfill instead.

1. **Pick the window.** Its first day, *W*, is the first UTC day whose raw events your index still holds in full, and no earlier than 365 days ago, the furthest a Backfill reaches. This search finds the oldest event over all time (`earliest=0`; the time picker does not limit it) and returns *W* as the epoch seconds of that UTC midnight:

    ```spl
    | tstats min(_time) as first where `sap_logserv_idx_macro` earliest=0
    | eval W = max((floor(first/86400)+1)*86400, floor(relative_time(now(), "-365d")/86400)*86400)
    ```

    The day of the oldest event may be held only in part, so *W* is the UTC midnight after it. Rows older than *W* keep their old values, and no raw event is left that a later Backfill could count beside them. The custom range of step 3 starts on *W*'s date in UTC.

2. **Delete the rows from *W* onward**, after the upgrade and clear of the nightly retention window: one REST call per collection in the table, on the search head's management port, with an admin-tier account. For example:

    ```bash
    curl -k -u admin -G -X DELETE \
      "https://<search-head>:8089/servicesNS/nobody/splunk_app_sap_logserv/storage/collections/data/logserv_hana_category_rollup" \
      --data-urlencode 'query={"bucket_ts":{"$gte":<W>}}'
    ```

    The same call with `-X GET` in place of `-X DELETE` returns rows the query matches (at most 50,000 by default, so it shows what the query matches, not how many): check it first. A DELETE without its query empties the whole collection.

    | Row | Collections |
    |---|---|
    | HANA Audit | `logserv_hana_category_rollup` |
    | HANA Trace | `logserv_hana_trace_rollup` |
    | Environment Health | `logserv_severity_rollup` |
    | ABAP Network & Security | `logserv_abapnet_rollup` |
    | Host Role Activity (Host Details) | `logserv_hostrole_rollup` |
    | Environment Topology (graph) | `logserv_topology_nodes` and `logserv_topology_edges`; and all of `logserv_topology_inventory` (the call without `query`), which has no time field and holds only the current mapping of addresses and hosts to systems: the Backfill rebuilds it from the last 30 days |
    | Environment Topology (detail tabs) | `logserv_topology_detail_rollup` |
    | Multi-Cloud Overview | `logserv_mc_rollup` |
    | Data Pipeline Overview | `logserv_pipeline_rollup` |
    | Host Details | `logserv_hostdetails_rollup` |
    | Sourcetype Mapping (Host Details / Data Pipeline) | `logserv_stmap_rollup` |

3. **Then backfill.** Do every delete before any Backfill. Then **Backfill** each of the eleven rows with its own **Backfill** over a custom range from *W* to today, and **Backfill** Change & Configuration Activity and Cross-Stack Authentication without Clear. Keep the Settings page open until the Environment Topology (graph) row has finished.

#### :material-crop-square:{ .taiconcolor } Narrower Repair After App Build 383 { #narrower-repair-build-383 }

The Clear of **Work Process Performance / ABAP Operations** also removes the dispatcher, ICM and ABAP Operations panels' history, although their stored values did not change. To keep the older history, delete only the trace-component rows (`metric` `wp`) from *W* onward, with *W* chosen as in the build-378 repair above:

```bash
curl -k -u admin -G -X DELETE \
  "https://<search-head>:8089/servicesNS/nobody/splunk_app_sap_logserv/storage/collections/data/logserv_wp_perf_rollup" \
  --data-urlencode 'query={"metric":"wp","bucket_ts":{"$gte":<W>}}'
```

Check the query with `-X GET` first, as above. Then **Backfill** the row with its own **Backfill** over a custom range from *W* to today. The Backfill rewrites the row's other rows in that range under the keys they already have, so nothing is counted twice; trace-component rows older than *W* keep their old names. If you cannot reach the management port, use the Clear and Backfill instead.

<br>

## :material-circle-box:{ .taiconcolor } What Is Preserved { #what-is-preserved }

- **`local/` configuration** survives an app upgrade: the App's `ai_assistant_settings.conf`, any acknowledgement files written by 0.0.5 builds before 192 or 0.1.1 builds before 240 (later builds keep the acknowledgements in the KV Store) and the credentials in its `passwords.conf`; the Data TA's filter and Cloud Provider settings; the Azure and GCP inputs and their credentials. On forwarders that a Deployment Server manages, the Data TA's `local/` is the one in the Deployment Server's `deployment-apps/` copy.
- **KV Store data** persists: settings, acknowledgements, saved topology layouts, dashboard preferences and the rollup collections. Collections and their data survive an app upgrade; the work list names the rows whose stored values must be rebuilt.
- **Indexed events** keep their index, sourcetype and index-time fields. Search-time fields follow the installed App ([Search-Time Field Changes](#search-time-field-changes)).
- **Dashboard URLs** are unchanged across recent releases. The Settings page moved from `#/settings/ai-assistant` to `#/settings` (the old URL redirects) and is titled **Application Settings**, with two top-level tabs, **AI Assistant** and **Dashboard Data**: update any runbook that names the old page title.

<br>

## :material-circle-box:{ .taiconcolor } Restricted Deployments: Templates-only and v0.0.6 { #restricted-deployments }

- **The published App is the full-LLM build.** No templates-only package is published for 0.1.2. After you upgrade a deployment that ran the templates-only build, or the v0.0.6 line, its stored `templates_only_mode` setting governs, and a deployment with no stored value takes the shipped default, **off**. Free-form questions are then allowed whenever the AI Assistant is enabled. Nothing goes to an LLM vendor until an admin selects a provider and saves its credential (the shipped provider is a built-in mock), but a provider credential stored before the upgrade is used again. An upgrade creates no credential.
- **To keep the deployment restricted**, turn **Templates-only mode** on under **Settings → AI Assistant → General** after the upgrade and click **Save Defaults**, or build the templates-only variant from this release's source and install that instead ([Restricting the LLM Path](../ai-assistant/templates-only-build.md), [Building the Packages from Source](../developer/build-from-source.md)).
- **v0.0.6** remains the option where a policy requires the LLM vendor code to be absent from the package. It is frozen at App build 266 and receives no fixes: it lacks every change of 0.1.1 after build 299 and of every 0.1.2 build ([Release Notes: 0.1.1](../overview/release-notes-0.1.1.md), [Release Notes: 0.1.2](../overview/release-notes.md)). An upgrade from v0.0.6 to 0.1.2 brings the vendor code back, restricted only by the setting above.

<br>

## :material-circle-box:{ .taiconcolor } Rollback { #rollback }

Reinstalling an earlier App tarball restores its `default/` content, and your `local/` configuration stays. It does not roll back the KV Store data:

- Collections that only the newer build created stay in place, unused by the older App.
- If the build you leave changed what a rollup stores (the Clear rows of the work list: builds 282, 356 to 358, 364 to 365, 378 and 383), the restored build's hourly aggregation rewrites the last hour or two (Beaconing detection: the last two days) under its old keys, beside the rows the newer build wrote, and any Backfill it runs over earlier days does the same. Those hours are then counted twice. After rolling back across such a build, wait until the restored build is running, then **Clear** and **Backfill** the rows its work-list entry names ([How to Rebuild a Row](#how-to-rebuild-a-row)). A Clear done before the rollback is undone by the newer build's last runs, and upgrading again later needs the same rebuild again.
- Rolling back to App build 374 or earlier brings back retention searches that can empty a rollup after a restart.

The Data TA rolls back the same way, and its `local/` filter configuration stays. Rolling it back also removes the parsing, routing and filtering changes made since that build ([Data TA](#data-ta-work-list)); events parsed in the meantime keep the sourcetype they got. With a Deployment Server, an earlier build that has the same version goes into `deployment-apps/` by hand, as for an upgrade.

<br>

## :material-circle-box:{ .taiconcolor } Removing the Solution { #removing-the-solution }

To take Splunk for SAP LogServ out of a deployment, stop the data first, then remove each package from the tier it is on. The indexed data and the App's KV Store data are handled in their own steps.

1. **Stop the data.**
    - **AWS:** on each heavy forwarder, disable or delete the SQS-Based S3 inputs of the Splunk Add-on for AWS that read SAP's queue. The backfill inputs that the AWS S3 Direct screen created also live in the Splunk Add-on for AWS: delete them with **Delete all** on that screen while the Data TA is still installed. In AWS, delete the CloudFormation stack you created from the Connect, Filter or Copy template. With Copy, empty its bucket first: CloudFormation does not delete a bucket that still holds objects. The Lambda code bucket you created for Filter or Copy is not part of the stack.
    - **Azure and GCP:** delete the inputs on each heavy forwarder or search head that runs them, or remove the add-ons in step 4.
    - Tell SAP that the access it granted for the connection is no longer needed.
2. **Decide what happens to the indexed data, before you remove the Data TA.** Removing a package does not delete indexed data: the buckets of `sap_logserv_logs` and `logserv_ai_assistant_audit` stay on disk. Where the Data TA's own `indexes.conf` defines the two indexes (a single instance, or an indexer you installed it on), removing the Data TA removes their definitions, and the data can no longer be searched. To keep it searchable, define both indexes elsewhere now, for example by copying the two stanzas of the Data TA's `default/indexes.conf` into `system/local/indexes.conf` on that instance. Deleting the data is step 5.
3. **Search head: the LogServ App.**
    - If Enterprise Security reads the App's asset and identity lookups (`splunk_for_sap_logserv_assets`, `splunk_for_sap_logserv_identities`), remove them from ES's Asset and Identity Management first ([Add to ES Identity Management](../enterprise-security/asset-identity-feed.md#add-to-es-identity-management)): they are removed with the App.
    - Its settings, acknowledgement records, saved layouts and dashboard data are in its KV Store collections, all named `logserv_*`, not in its directory. Export what you want to keep. If none of it may remain, delete the collections' contents right before you remove the App, while it is still installed: one REST call per collection, with an admin-tier account, on the management port (on Splunk Cloud it must first be opened for you). The collections are the stanzas of the App's `default/collections.conf`, 40 in build 394. This lists their names from the tarball you installed:

        ```bash
        tar -xzOf splunk_app_sap_logserv-0.1.2.tar.gz splunk_app_sap_logserv/default/collections.conf \
          | sed -n 's/^\[\(.*\)\]$/\1/p'
        ```

        Then, for each name:

        ```bash
        curl -k -u admin -X DELETE \
          "https://<search-head>:8089/servicesNS/nobody/splunk_app_sap_logserv/storage/collections/data/<collection>"
        ```

    - Remove the App: on Splunk Enterprise, `$SPLUNK_HOME/bin/splunk remove app splunk_app_sap_logserv` as the user Splunk runs as, then restart Splunk (or stop Splunk, delete `$SPLUNK_HOME/etc/apps/splunk_app_sap_logserv` and start Splunk); on a search head cluster, delete `splunk_app_sap_logserv` from the deployer's `$SPLUNK_HOME/etc/shcluster/apps/` and push the bundle with `splunk apply shcluster-bundle`, which removes it from the members; on Splunk Cloud, uninstall it as you would any private app. Its own credentials (`local/passwords.conf`), lookups and configuration go with its directory. Notable and risk events its searches already wrote stay in Enterprise Security's indexes.
    - The add-ons the App needs on the search head (CIM, the Windows and Unix and Linux add-ons, the Splunk MCP Server) are separate apps: remove them only if nothing else uses them.

4. **Heavy forwarders and the Deployment Server.**
    - **With a Deployment Server:** the Data TA reached the forwarders through the `SAP_LogServ_HeavyForwarders` server class. In **Settings → Forwarder Management** (Agent Management in Splunk Enterprise 10.0 and later), take the Data TA out of that class, or delete the class if it holds nothing else (the 0.0.5 Azure setup put the Splunk Add-on for Microsoft Cloud Services in it too). In the files, the class is the `[serverClass:SAP_LogServ_HeavyForwarders]` stanza and the Data TA's place in it the `[serverClass:SAP_LogServ_HeavyForwarders:app:splunk_ta_sap_logserv]` stanza, in the `serverclass.conf` that `$SPLUNK_HOME/bin/splunk btool serverclass list --debug | grep SAP_LogServ` shows. Remove only those stanzas, never the whole file, which holds your other server classes too, then run `$SPLUNK_HOME/bin/splunk reload deploy-server`. Then check each forwarder, and where `$SPLUNK_HOME/etc/apps/splunk_ta_sap_logserv` is still there, remove it. Last, remove the Data TA from the Deployment Server itself, `etc/apps/splunk_ta_sap_logserv` and `etc/deployment-apps/splunk_ta_sap_logserv` together: while it is installed in `etc/apps/`, its daily filter refresh can copy it back into `deployment-apps/`.
    - **Without a Deployment Server:** remove the Data TA from each forwarder (`$SPLUNK_HOME/bin/splunk remove app splunk_ta_sap_logserv`, then restart).
    - **LogServ Azure and GCP add-ons:** remove them from each forwarder or search head that runs them. Each input's credential is in the add-on's own `local/passwords.conf` and goes with it.
    - **Single instance, an indexer you installed it on, or a Splunk Cloud search head that ran the inputs:** remove the Data TA there too, after step 2.

5. **Delete the indexes, if the data is not to be kept.** To delete the data, remove the indexes where you created them ([Create the Indexes](../install-setup/install-ta.md#1-create-the-indexes)): under **Settings → Indexes** on a standalone indexer or on Splunk Cloud; on an indexer cluster, with Splunk's procedure for removing an index from the cluster. Where the Data TA's own `indexes.conf` defined them and you removed it in step 4, their buckets are still on disk, in the directories that file gave them: stop Splunk, delete `$SPLUNK_DB/sap_logserv_logs` and `$SPLUNK_DB/logserv_ai_assistant_audit`, and start Splunk again.

<br>

## :material-lightning-bolt:{ .taiconcolor } At a Glance { #at-a-glance }

- Find your builds (**About** in the App; [Version Check](capacity-planning.md#version-check) for the Data TA), then apply every work-list row at or above your build.
- No data re-ingest; `local/` and KV Store data are kept. Indexed events keep their sourcetype; some search-time fields change.
- Rebuild the Dashboard Data rows the work list names, after the upgrade, clear of the nightly retention window, with each row's own **Backfill**.
- With a Deployment Server, a later 0.1.2 Data TA build goes into `deployment-apps/` by hand.
- The published App is the full-LLM build: turn **Templates-only mode** on to keep a deployment restricted.
- On a search head without Enterprise Security, disable the App's ES searches.

<br>

## :material-circle-box:{ .cboxmove } Next Steps

1. [Verify Your Data](verify-data.md): check that events arrive with their sourcetypes after the update.
2. [Dashboard Data: Backfill and Freshness](../logserv-app/dashboard-data.md): what each Dashboard Data row holds and how fresh it is.
3. [Release Notes: 0.1.2](../overview/release-notes.md): what each build changed.
