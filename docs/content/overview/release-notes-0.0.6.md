# Release Notes: 0.0.6

This page lists what changed in the 0.0.6 line of Splunk for SAP LogServ. The 0.0.6 line was frozen on 2026-08-07, at App build 266, and receives no further fixes; its work continues in [0.1.2](release-notes.md). To upgrade from a 0.0.6 build, follow [Upgrading to This Release](../getting-started/upgrading.md).

!!! note "v0.0.6 is primarily a dashboard-performance release"
    v0.0.6 keeps the **entire v0.0.5 feature set unchanged** (21 React dashboards + the Environment Topology view, templates-only AI Assistant with 61 canned prompts + audit log, index-time filtering + Deployment Server automation, Cloud Provider attribution, Enterprise Security integration). The headline of this release is a **dashboard data-layer rewrite** that makes the dashboards fast at high event volume; it also adds **Google Cloud Platform as a third ingest channel** (a dedicated per-HF add-on, see below) and reworks Azure ingest onto a dedicated per-HF add-on. Search-time field extractions, sourcetype routing, and all dashboard *content* are unchanged — only how each panel sources its data changed. **No data re-ingest is required to upgrade.**

## :material-circle-box:{ .taiconcolor } Compatibility

|                                  |                              |
|----------------------------------|------------------------------|
| Splunk platform versions         | 9.4.3 and later              |
| CIM                              | 5.0.0 and later (per `app.manifest`) |
| Supported OS for data collection | Platform independent         |
| Vendor products                  | SAP LogServ for SAP ECS in Amazon Web Services (AWS), Microsoft Azure, and Google Cloud Platform (GCP) |
| AI Assistant prerequisite        | [Splunk MCP Server (Splunkbase App 7931)](https://splunkbase.splunk.com/app/7931) v1.1.0 or later, on the search head where the LogServ App is installed |
| Azure ingest                     | A dedicated first-party add-on — **Splunk TA for SAP LogServ on Azure** (`splunk_ta_sap_logserv_azure`), installed per heavy forwarder — ingests Azure Blob via Event Grid → Storage Queue notifications (Azure deployments only; SAP provisions the queue + SAS) |
| GCP ingest                       | A dedicated first-party add-on — **Splunk TA for SAP LogServ on GCP** (`splunk_ta_sap_logserv_gcp`), installed per heavy forwarder — ingests Google Cloud Storage via Pub/Sub `OBJECT_FINALIZE` notifications (GCP deployments only; SAP provisions the subscription + service-account key) |

## :material-circle-box:{ .taiconcolor } The problem this release solves

At a customer's reported scale (~10.7M events / 24 h, ~321M over 30 days) the 21 non-Topology dashboards took **over 10 minutes** to populate. Each panel dispatched its own raw, search-time-extraction full-scan with no shared base search, no `tstats`, and no acceleration. (The Environment Topology view was already fast — it had been moved to a KV-Store-backed data layer in v0.0.5.)

## :material-circle-box:{ .taiconcolor } New data architecture — two tiers

Every dashboard panel was re-tiered onto the cheapest *correct* data source and byte-exact-verified against the original raw SPL. The result is a **two-tier data layer** — no Common Information Model (CIM) acceleration is required.

1. **`tstats` on indexed dimensions** — pure count / average panels (Data Pipeline Overview, Host Details, the Environment Health pipeline panels, Multi-Cloud Overview, and the count KPIs across the suite) read via `| tstats` over the already-indexed `WRITE_META` fields. A new `default/fields.conf` declares `INDEXED = true` for `clz_dir` / `clz_subdir` / `splunk_solution` / `cloud_provider`.
2. **KV-Store precompute rollups** — every other high-volume panel reads from a set of **hourly-aggregated KV-Store rollup collections** (`logserv_*_rollup`; later builds added more — the Settings → Dashboard Data tab lists the current inventory). Scheduled saved searches (`logserv_*_aggregate`, hourly on staggered per-search minutes — see [Scheduled-search schedule](../logserv-app/dashboard-data.md)) precompute each panel's data; the dashboards read it back filtered by a `bucket_ts` range driven by the global time-range picker. Streamstats / per-event-listing panels that cannot be rolled up stay raw (capped with `| head N` where they are time-ordered listings).

Cached reads are uniformly **~0.1–0.6 s** versus 10 s – 19 min raw (speedups of **64× – 5,358×**), validated at 335M events on the test fleet. **Data freshness on the rolled-up panels is hourly** — the same trade-off the Environment Topology view already made. See [Dashboard Data: Backfill and Freshness](../logserv-app/dashboard-data.md) for the full picture and the one-time backfill step.

!!! info "No CIM data-model acceleration needed for dashboards"
    An interim build had the four HTTP / DNS / proxy dashboards (Proxy, Web Dispatcher, Cloud Connector, DNS Analytics) read from CIM accelerated data models. That approach was **removed** before this release: when a customer had not accelerated those models (the common case), the queries fell back to a raw full-scan — exactly the slowness this release set out to fix. Those four dashboards now read dedicated KV-Store rollups, so they are fast regardless of the customer's CIM-acceleration state. The LogServ App's CIM *tagging* (eventtypes + tags) for **Enterprise Security** correlation is unaffected — see [Enterprise Security → CIM Compliance](../enterprise-security/cim-compliance.md).

## :material-circle-box:{ .taiconcolor } New features

1. **"Run backfill" — Dashboard Data settings tab** — a new **Settings → Dashboard Data** tab seeds the rollup collections on first install. It dispatches each rollup's aggregation searches as **top-level jobs** (immune to the subsearch wall-clock limits that truncate a bundled backfill at high volume), with a progress bar, completeness banner, and per-rollup status. Idempotent and resumable. **An admin clicks this once after installing on a high-volume instance** to populate dashboard history immediately; otherwise the hourly aggregation seeds history going forward. See [Dashboard Data: Backfill and Freshness → Backfilling on first install](../logserv-app/dashboard-data.md#backfilling-on-first-install). Build 245 merged the former **Topology** settings tab into this tab: the Environment Topology graph became one more rollup in its table, and its backfill moved to the same per-arm top-level dispatch, so it no longer truncates at high event volume.
2. **365-day cache retention** — all rollup-retention searches keep a full year of rolled-up history. The install backfill seeds 30 days; the cache then grows to a year organically via the hourly aggregation (seed-and-grow).
3. **Per-panel action toolbar** — every chart and table panel header now carries **Open in Search · Download (CSV) · Inspect (Job Inspector) · Refresh** plus a "&lt;1m ago" last-run stamp. KPI single-value cards get the loading spinner but no toolbar.
4. **Universal loading spinner** — every chart / table renders the orange-dot spinner + "Loading data…" while its search is in flight (KPI cards show a small spinner instead of a dash), replacing the old plain "Loading…" text.

## :material-circle-box:{ .taiconcolor } Later builds (254–266), backported from v0.1.1

After build 253 the v0.0.6 line shipped builds 254 to 266. Each carries changes first made in the v0.1.1 line, described in [Release Notes: 0.1.1](release-notes-0.1.1.md) under their v0.1.1 build numbers:

| v0.0.6 builds | v0.1.1 builds | Change |
|---|---|---|
| 254–255 | 246–259, 260–277, 278 | [The Cisco Magnetic re-theme with light and dark mode](release-notes-0.1.1.md#cisco-magnetic-re-theme-light-dark-mode-builds-246259), [the Environment Topology star-system layout and floating edges](release-notes-0.1.1.md#environment-topology-star-system-force-layout-floating-edges-builds-260277) and [the blue-gradient icon set](release-notes-0.1.1.md#blue-gradient-icon-set-build-278) |
| 256–257 | 279–281 | [Settings readability, the Live Activity panel and the link-graph restyle](release-notes-0.1.1.md#settings-readability-live-activity-panel-link-graph-restyle-builds-279281) |
| 258 | 282 | [The global Cloud Provider filter](release-notes-0.1.1.md#global-cloud-provider-filter-build-282); it changes the rollup key, so its upgrade needs the rollups cleared once and backfilled |
| 259 | 284 | [The Linux and Windows chart fixes](release-notes-0.1.1.md#linux-windows-dashboard-chart-fixes-build-284) |
| 260–261 | 285–286 | [Predefined prompts on the rollup tier](release-notes-0.1.1.md#ai-assistant-predefined-prompts-on-the-rollup-tier-builds-285286) |
| 262–263 | 287–288 | [A configurable MCP request timeout, default 30 seconds, and a read-only display of the MCP Server's own timeout](release-notes-0.1.1.md#ai-assistant-configurable-mcp-request-timeout-builds-287288) |
| 264–265 | 289–298 | [The 60-second MCP timeout default, sub-hour ranges read from raw events, a global Refresh button, and Web Dispatcher follows the Cloud filter](release-notes-0.1.1.md#sub-hour-time-ranges-read-raw-events-a-global-refresh-button-and-a-60-second-mcp-timeout-default-builds-289298) |
| 266 | 299 | [The after-hours window fix](release-notes-0.1.1.md#after-hours-window-fix-build-299); its upgrade needs the compliance rollup rebuilt |

Fixes made after build 266 are in the 0.1.1 and 0.1.2 lines only, for example the nightly retention that cannot empty a rollup (0.1.2 build 375), admin-only write access to the App's KV Store collections (0.1.2 builds 383–385) and the Data TA's whole-line routing (Data TA build 1792189743).

## :material-circle-box:{ .taiconcolor } Role Activity + Sourcetype Mapping performance (build 243)

The last two raw-scan panel groups were moved onto KV-Store rollups so they stay fast at high event volume:

1. **Sourcetype Mapping** (Host Details → Sourcetype Mapping tab + Data Pipeline Overview → Linked Graph) now reads a new `logserv_stmap_rollup` with **`source` normalized** (UUIDs, dates, and long digit-runs stripped to collapse per-day / per-tunnel variants into logical sources). This cut the search from **~50 s to ~2 s** over a 30-day window and the graph from 4,000+ nodes to a few hundred. **User-visible change:** the graph now shows normalized logical sources (e.g. one `…/audit-log_<id>_<date>.csv` node) instead of one node per tunnel-UUID per day.
2. **Role Activity** (Host Details → Role Activity tab) — the 7 per-host breakdown panels now read a new `logserv_hostrole_rollup` (metric discriminator), reproducing the same value / count / percent breakdown **byte-exact**, ~8× faster. No visible change.

Adds 2 rollup collections (24 → 26 hourly aggregates; 24 → 26 retention searches) — fully within the existing staggered schedule (now `:03`–`:28` aggregates / `:30`–`:58` daily).

## :material-circle-box:{ .taiconcolor } Scheduling & Enterprise Security (build 242)

1. **Enterprise Security content shipped disabled by default.** _(Superseded by build 249: the ES content now ships **enabled** by default; see the build-249 entry.)_ In build 242 all 22 `splunk_sap_logserv_es_*` saved searches shipped with `disabled = 1`. The ES content is dual-mode (it targets the ES Notable / Risk / Asset & Identity frameworks and CIM data models that no-op without ES installed) and no dashboard reads any ES output. See [Enterprise Security → The ES schedule](../enterprise-security/overview.md#the-es-schedule-collision-free).

    _Correction (2026-10-23): the ES content is not a no-op without ES. Where its searches run without ES, Splunk logs an error for each `notable` and `risk` alert action, which exist only with ES, and the scheduler skips the Risk Notable because the Risk data model is missing. On a search head without ES, turn the ES content off: see [Disabling or tuning the ES content](../enterprise-security/overview.md#disabling-or-tuning-the-es-content)._

2. **Scheduled searches re-staggered into three non-overlapping bands** — the 24 hourly rollup aggregates spread one-per-minute across `:05`–`:28` (was all at `:05`), retention + the 2 daily beaconing aggregates moved to an off-peak `:30`–`:58` band, and the (disabled) ES searches re-croned to the back of the hour. No two enabled scheduled searches share an `(hour, minute)`, eliminating the previous `:05` burst and two same-minute collisions. Dispatch windows are unchanged, so data freshness is unaffected. See [Dashboard Data: Backfill and Freshness → Scheduled-search schedule](../logserv-app/dashboard-data.md#scheduled-search-schedule).

## :material-circle-box:{ .taiconcolor } Enterprise Security enabled by default + AI Assistant prompt rework (build 249)

1. **The 22 `splunk_sap_logserv_es_*` searches now ship enabled by default**, reversing build 242's disabled-by-default decision. They run on a re-staggered, **collision-free** schedule (no two enabled scheduled searches share an `(hour, minute)`): 16 correlation searches hourly in the disjoint minutes `:29` / odd `:31`–`:59`, the 2 Asset/Identity feeds every 4 hours at `:00` / `:01`, and the 4 behavioral-anomaly searches once **daily** at `:02` _(in the 0.1.1 line, build 315 moved them to `:30`, still in hours 02–05; see [builds 315–316](release-notes-0.1.1.md#data-doctor-platform-snapshot-data-coverage-raw-samples-drawer-polish-builds-315316))_. To fit the collision-free schedule, eight correlation searches that ran every 5–15 minutes now run hourly (with matched 65-minute dispatch windows), and the four anomaly searches run daily instead of hourly — a daily run still evaluates every hourly bucket of the prior day, so no detections are missed. The content stays dual-mode (`action.notable` / `action.risk` no-op without ES). To disable or re-tune, see [Enterprise Security → Disabling or tuning the ES content](../enterprise-security/overview.md#disabling-or-tuning-the-es-content).

    _Correction (2026-10-23): the ES content is not a no-op without ES. On a search head without ES the enabled searches still run: Splunk logs an error for each `notable` and `risk` alert action, which exist only with ES, and the scheduler skips the Risk Notable because the Risk data model is missing. On a search head without ES, turn the ES content off: see [Disabling or tuning the ES content](../enterprise-security/overview.md#disabling-or-tuning-the-es-content)._

2. **The 13 ES AI Assistant Security-pack prompts were reworked to function as interactive prompts.** Dispatched by name, they had been erroring on click ever since build 242 disabled their searches; enabling the searches fixes that, and the SPL was repaired — the `anomaly_topology_edge_volume` FATAL `inputlookup … where` error, the dead-constant `is_business_hours` / `is_weekend` off-hours fields (replaced with inline `_time`-based logic), the `service_account_interactive` field bug, and the structurally-empty `after_hours_admin_data_access`. The three 30-day anomaly prompts were converted to a daily cadence. Intent map bumped to v0.0.11.

## :material-circle-box:{ .taiconcolor } Dependency security hygiene — react-router 7.18.1 (build 252)

Bumped `react-router-dom` from 7.14.2 to **7.18.1** (patched line) so dependency / SCA scanners no longer flag the App against [GHSA-4hjh-wcwx-xvwj](https://github.com/remix-run/react-router/security) — a `__manifest`-endpoint DoS in react-router 7.0.0–7.14.x. **The App was never exposed to it:** it is a client-side single-page app served as static assets by Splunk Web and routed entirely by `<HashRouter>` (Declarative Mode, which the advisory explicitly exempts), with no React Router / Remix server runtime and therefore no `__manifest` endpoint. This is a hygiene bump only — no behavior change (routing was re-verified live across the index, settings, dashboard, and topology routes with zero errors).

## :material-circle-box:{ .taiconcolor } Whole-estate AI Assistant host prompts moved onto a KV-Store rollup (build 251)

Four predefined prompts scan the **entire estate** by host — *Top hosts by event volume*, *Noisiest hosts trend*, *Distinct hosts seen*, and *Hosts with the biggest event-volume drop*. They were raw `| top host` / `dc(host)` / per-host-timechart full-scans, so on a large dataset they exceeded the AI Assistant's 30-second request timeout at wide windows (e.g. *Top hosts* at −30 days took > 150 s and aborted with *"signal is aborted without reason"*). Build 251 rewrites all four to read from the existing `logserv_hostdetails_rollup` KV-Store rollup (hourly `(host, bucket)` counts), so each returns **sub-second** at any window — measured −30 d went from > 150 s (abort) to 0.6 s, and the dropdown window still drives the result. The reads are **byte-exact** to the original SPL (the rollup uses the same search-time `host` field, so the displayed hosts and counts are unchanged), and the rollup is the one that already powers the Host Details dashboard (no new collection or scheduled search). On a fresh install the prompts populate older windows once the [Dashboard Data backfill](../logserv-app/dashboard-data.md) has run, the same as every dashboard. See [Predefined Prompts](../ai-assistant/predefined-prompts.md).

## :material-circle-box:{ .taiconcolor } AI Assistant prompt time-range dropdown now bounds the search (build 250)

The **Time range** dropdown in the AI Assistant's "Browse predefined prompts" window (Last 1h … Last 30d) now actually bounds the dispatched saved search. Previously the selected window was silently dropped, so every predefined prompt ran **unbounded over the whole index** through the Splunk MCP Server — on a large dataset this took minutes and the prompt timed out client-side with *"Error: signal is aborted without reason."* The fix flattens `earliest_time` / `latest_time` to the MCP `run_saved_search` tool's top-level arguments (where App 7931 expects them) instead of nesting them under an ignored `arguments` object. No fixed window is baked into the saved searches — the dropdown drives the time range end-to-end, and both the canned-prompt path and the AI-driven path are fixed. See [Predefined Prompts](../ai-assistant/predefined-prompts.md).

## :material-circle-box:{ .taiconcolor } Azure queue-driven ingest (dedicated add-on)

Azure ingest is the Azure twin of `Splunk_TA_aws`'s SQS-Based S3 input, and ships as a **dedicated, first-party Heavy-Forwarder add-on — Splunk TA for SAP LogServ on Azure (`splunk_ta_sap_logserv_azure`)**, installed per-HF (not via the Deployment Server). Its **`sap_logserv_azure_queue`** modular input consumes Azure **Event Grid → Storage Queue** `BlobCreated` notifications, fetches each LogServ blob over a SAS, and emits its NDJSON via the native EventWriter, so events flow through the heavy forwarder's index-time pipeline and reuse the LogServ Data TA's existing sourcetype routing, Filters `nullQueue`, `_time` drop, and `cloud_provider` / `splunk_solution` stamping unchanged (it emits `sourcetype = sap_logserv_logs` and stamps `_meta = cloud_provider::azure`). It is **stdlib-only** (no Azure SDK, Splunk Cloud-clean) and inert until an input instance is configured. This is the model SAP's LogServ-on-Azure collector uses (Storage Queue notifications), and it **replaces the Splunkbase-add-on polling approach** the original v0.0.5 Azure support used. Installing the input on the forwarder tier — with the SAS in the add-on's own `local/`, never Deployment-Server-managed — makes Azure ingest **symmetric with AWS** and removes the per-host-secret-inside-a-DS-app fragility of earlier v0.0.6 iterations (the old `system/local` SAS dance + `sas_token = ******` bundle invariant are gone). A per-instance `index` (default `sap_logserv_logs`) lets one HF run multiple Azure inputs; the emitted sourcetype is always `sap_logserv_logs`. Per-HF install + input configuration are documented in [SAP LogServ on Azure — Setup Guide](../install-setup/azure-setup.md). AppInspect Cloud posture: 0 errors / 0 failures / 0 future_failures (the add-on's stdlib-only modular input adds no gating findings; the input-removed Data TA returns to its 11-warning baseline).

## :material-circle-box:{ .taiconcolor } Multi-Cloud Overview goes three-way + Data TA `gcp` dropdown (build 253)

Alongside the GCP add-on (below), the **Multi-Cloud Overview** dashboard was upgraded from a hardcoded two-provider layout to a full **AWS / Azure / GCP** split: a new **GCP Events** KPI + sparkline (the KPI row is now Total / AWS / Azure / GCP), a GCP column in the Top Sourcetypes table, and provider-neutral labels. This also fixes a latent bug for third-provider data: the Top Sourcetypes query hardcoded `Total = AWS + Azure`, which would have silently excluded `gcp`-attributed counts from the Total (single- and dual-cloud installs were unaffected — verified that a window with zero GCP rows still renders `GCP = 0` with a correct Total). The dashboard's "About the cloud_provider field" reference panel was rewritten (it still described a retired Azure ingest mechanism and linked to a non-existent in-app help URL; it now links to the published Azure/GCP Setup Guides). The **Data TA's Configuration → Cloud Provider dropdown gains "Google Cloud Platform"** (`cloud_provider = gcp`) as a fourth choice — see [Choose Cloud Attribution](../install-setup/cloud-attribution.md).

## :material-circle-box:{ .taiconcolor } GCP notification-driven ingest (dedicated add-on)

Google Cloud Platform joins AWS and Azure as a first-class ingest channel, via a **dedicated, first-party Heavy-Forwarder add-on — Splunk TA for SAP LogServ on GCP (`splunk_ta_sap_logserv_gcp`)**, installed per-HF (not via the Deployment Server). Its **`sap_logserv_gcp_pubsub`** modular input pulls a **Pub/Sub subscription** fed by the LogServ GCS bucket's `OBJECT_FINALIZE` notifications, fetches each object with a Google **service-account key**, gunzips it, and emits its NDJSON via the native EventWriter — so events flow through the heavy forwarder's index-time pipeline and reuse the LogServ Data TA's existing sourcetype routing, Filters `nullQueue`, `_time` drop, and `cloud_provider` / `splunk_solution` stamping unchanged (it emits `sourcetype = sap_logserv_logs` and stamps `_meta = cloud_provider::gcp`). This is the same notification-driven model SAP's own LogServ-on-GCP collector uses, and the same deployment shape as the Azure add-on. It is **stdlib-only** — Pub/Sub + GCS REST over `urllib`, with a pure-Python OAuth2 service-account token exchange (no Google SDK, no vendored dependencies) — so it is Splunk Cloud-clean and adds no third-party attributions. The general-purpose Splunk Add-on for Google Cloud Platform (Splunkbase 3088) was evaluated and does not fit: as of v5.0.3 its Pub/Sub-based bucket input cannot decompress the gzipped LogServ objects. The service account needs exactly the two roles SAP documents for its own forwarder (`roles/pubsub.subscriber` on the subscription + `roles/storage.objectViewer` on the bucket). Per-HF install + input configuration are documented in [SAP LogServ on GCP — Setup Guide](../install-setup/gcp-setup.md). AppInspect Cloud posture: 0 errors / 0 failures / 0 future_failures.

## :material-circle-box:{ .taiconcolor } Changed (user-visible panel shapes)

A few panels changed shape as a consequence of reading from hourly rollups instead of raw events:

1. **All response-time charts now show Avg + Max by hour instead of p50 / p95 / p99 percentiles.** Averages and maxima roll up byte-exact across hourly buckets (Avg = Σsum ÷ Σcount, Max = max-of-per-bucket-max); percentiles cannot be merged across buckets. Affects Web and API Performance ("Response Time (Avg / Max) Over Time", and the "Slow URIs / Slow Clients" tables now show a **Max (ms)** column in place of p95) and HANA Trace ("Operation Duration (Avg / Max)").
2. **HANA Trace "Slowest SQL Operations"** is now a top-operations-by-max-duration table (operation, max ms, avg ms, event count) — the per-event `_time` / host columns cannot survive an aggregate.
3. **Web Dispatcher "URIs by Request Count"** dropped its "Unique Clients" column (a 3-dimension grain would explode at scale).
4. **Panels that remain raw** (and are therefore unaffected): Network Perimeter "Suspicious Activity Indicator", the DNS / Network-Perimeter beaconing tables, Web Dispatcher "Slowest Request Traces", and Cloud Connector "Audit Log" — streamstats / per-event listings that cannot be rolled up byte-exact. (The beaconing and Slowest-Traces panels are now backed by per-day / per-hour rollups so they stay responsive to the time-range picker.)

## :material-circle-box:{ .taiconcolor } Fixed issues

While re-expressing panels, three pre-existing display bugs (all string-vs-number / `match()`-in-base-search predicate mistakes that silently returned 0) were found and fixed:

1. **Cloud Connector HTTP Error Rate** — the KPI compared a string `is_error` field against the number `1` and was stuck at 0%; re-expressed as the `status >= 400` fraction (now ~7.3% on test data).
2. **Change & Configuration "Password Change" / "User Change" KPIs** — a Linux `match(_raw, …)` clause sat in base-search position where `match()` (eval-only) silently no-ops; moved to a post-base `| where`.
3. **`icm_is_error` predicate** — the same string-vs-number trap (`icm_is_error = 1` vs the field's string `"true"`) in the Environment Health severity rollup and the `logserv_top_error_categories` AI prompt; fixed to `= "true"`.

## :material-circle-box:{ .taiconcolor } Third-party software attributions

`THIRD-PARTY-NOTICES.md` was refreshed for v0.0.6 to add `elkjs@0.11.1` (EPL-2.0, the Environment Topology layout engine), and builds 237–251 shipped it with **1236 unique top-level npm packages**. **Known gap:** elkjs was never declared as a dependency in this line, so from build 252 the generator no longer found it. The final v0.0.6 build, 266, bundles elkjs unmodified, but its in-app notices list 1235 packages without the elkjs entry. The v0.0.6 source-tree root copy of the notices, and the shipped notices of v0.1.1 build 333 and later, carry the elkjs section with the full EPL-2.0 text. The file is generated from the build's `node_modules/` tree by `yarn build` and shipped at the root of the installed app directory, alongside the CycloneDX 1.4 `SBOM.json`. See [Third-Party Software Licenses](third-party-licenses.md).

## :material-circle-box:{ .taiconcolor } Known issues

1. The hourly rollup data layer means rolled-up panels are accurate to the most-recently-completed hour; sub-hour time-range selections (e.g. "Last 15 minutes") read from the hourly buckets and so reflect completed hours rather than the live partial hour. Use the raw Search app (via the per-panel **Open in Search** toolbar action) for live sub-hour investigation. _(Superseded by build 265: ranges under 90 minutes read raw events.)_
2. On a fresh install at high event volume, dashboards show empty until the first hourly aggregation runs or an admin runs the **Dashboard Data → Run backfill** step.

## :material-circle-box:{ .taiconcolor } Next Steps

- Before you upgrade, follow [Upgrading to This Release](../getting-started/upgrading.md).
- What the current release changes: [Release Notes: 0.1.2](release-notes.md).
