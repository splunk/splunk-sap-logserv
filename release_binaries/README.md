# v0.0.6.0 Release Binaries

This directory contains the two installable tarballs for the **Splunk for SAP LogServ** v0.0.6.0 release.

## Canonical tarballs

| Tarball | md5 | Size | Tier |
|---|---|---|---|
| [`splunk_app_sap_logserv-0.0.6.0.tar.gz`](./splunk_app_sap_logserv-0.0.6.0.tar.gz) | `7dc64397bbe524f4f14a9df17334ae99` | 3.87 MB | Search Head |
| [`splunk_ta_sap_logserv-0.0.6.0.tar.gz`](./splunk_ta_sap_logserv-0.0.6.0.tar.gz) | `dcd9ba2a966ea5acc6c726db364cda77` | 1.6 MB | Deployment Server + Heavy Forwarders + Indexer (also installable on Splunk Cloud SH for single-instance Cloud deployments) |

The App tarball is at **build 242** (internal `app.conf` / `app.manifest` version `0.0.6`, proper 3-part SemVer). **Build 242 ships the Enterprise Security content disabled by default and re-staggers the scheduled searches** to eliminate the hourly burst and all same-minute collisions — see "Build 242" below. Build 240 caches the Environment Topology view's right-pane detail tabs onto an hourly KV-Store rollup (the last topology corner still doing live raw scans per node/edge click); **build 241 host-splits the three full-index node aggregate arms so the one-time backfill no longer does a full-index `mvexpand`** — see "Build 240–241" below. Build 239 added the donut/pie empty-after-range-change fix. The Data TA is **unchanged from the v0.0.5.0 line** — its internal `app.conf` version stays at `0.0.5` (the cloud-provider + filesystem-fallback "fsfix" build, md5 `dcd9ba2a966ea5acc6c726db364cda77`, byte-identical to the v0.0.5.0 canonical Data TA). The `0.0.6.0` in the Data TA filename is the combined-snapshot version for directory continuity (matching the App tarball); App and Data TA version independently, and the Data TA had no source changes across the v0.0.5.0 → v0.0.6.0 line (the entire v0.0.6.0 effort is search-head-side: dashboards + KV Store rollup collections + scheduled aggregation searches, all in the App).

Both are installable via Splunk Web (**Apps → Install app from file**) or via CLI:
```bash
/opt/splunk/bin/splunk install app /path/to/<tarball>
```

See [`docs/content/getting-started/quick-install-reference.md`](../docs/content/getting-started/quick-install-reference.md) for the per-tier install matrix and the prerequisite Splunkbase add-ons (CIM modules, Splunk MCP Server for the AI Assistant, the AWS / Microsoft Azure ingest add-ons).

## What's new in v0.0.6.0 — dashboard performance refactor

v0.0.6.0 keeps the **entire v0.0.5.0 feature set unchanged** (21 React dashboards + the Environment Topology view, templates-only AI Assistant with 61 canned prompts + audit log, index-time filtering + Deployment Server automation, Cloud Provider attribution, Enterprise Security integration). The single focus of this release is a **dashboard data-layer rewrite** that makes the dashboards fast at high event volume.

**The problem.** At a customer's reported scale (~10.7M events / 24 h, ~321M over 30 days), the 21 non-Topology dashboards took **>10 minutes** to populate. Each panel dispatched its own raw, search-time-extraction full-scan with no shared base search, no `tstats`, and no acceleration. (The Topology view was already fast — it had been moved to a KV-Store-backed data layer in an earlier release.)

**The fix (App builds 198–237).** Every dashboard panel was re-tiered onto the cheapest correct data source, byte-exact-verified against the original raw SPL. The **final architecture (build 237) has two data tiers** — `tstats` on indexed dimensions, and KV-Store precompute rollups:

1. **`tstats` on indexed dimensions** (builds 198–200) — Data Pipeline Overview, Host Details, and the Environment Health pipeline-count panels read pure counts/avgs via `| tstats` over the already-`WRITE_META`-indexed fields. A new `default/fields.conf` declares `INDEXED = true` for `clz_dir` / `clz_subdir` / `splunk_solution` / `cloud_provider` so `tstats` can read them at search time.
2. **KV-Store precompute rollups** (builds 206–232) — **every** other high-volume dashboard reads from hourly-aggregated KV Store rollup collections. Scheduled saved searches (`logserv_*_aggregate`, cron `5 * * * *`) precompute each panel's data; the dashboards read it back with a `bucket_ts` range filter driven by the global time-range picker. Streamstats/event-listing panels that cannot be rolled up stay raw, capped with `| head N` where they are time-ordered listings.

   - Builds 206–227 covered Work Process Performance, ABAP Operations, Environment Health error classification, HANA Audit, Change & Configuration Activity, SAP Router, ABAP Network & Security, Cross-Stack Authentication, Network Perimeter, Linux, Web & API Performance, HANA Trace, Windows, SAP Services, and Multi-Cloud Overview.
   - **Build 232 retired the interim CIM tier and folded the percentile panels into the rollups** (see below) — bringing four more dashboards (Proxy, Web Dispatcher, Cloud Connector, DNS Analytics) fully onto KV-Store as well.
   - **Build 233 moved the Host Details Overview tab's last raw full-scans onto the rollup tier** — its DATA VOLUME (`sum(len(_raw))`), ERRORS/CRITICALS, and AUTH FAILURES KPIs + sparklines were ~162 s / 29 s / 38 s at 76 M events (minutes at full volume); they now read a new `logserv_hostdetails_rollup` (metrics `vol`/`err`/`auth` per host+bucket) in ~0.1–0.3 s (≈200–580× faster). The Event Count by Sourcetype chart was also rewritten to `tstats` (165 s → 5 s, 30×; sourcetype is indexed). The release now ships **20 rollup collections** (15 from builds 206–227, plus `logserv_cloudconn_rollup`, `logserv_proxy_rollup`, `logserv_dns_rollup`, `logserv_pipeline_rollup`, `logserv_hostdetails_rollup`) plus a per-day beaconing rollup.

**Build 232 — CIM tier removed + percentiles → Avg + Max.** An interim approach (builds 201–205) had the four HTTP/DNS/proxy-semantic dashboards read their status / method / bandwidth / domain panels from the CIM **Web** / **Network_Resolution** / **Authentication** accelerated data models, shipping `summariesonly=false allow_old_summaries=true`. The problem: when a customer had **not** accelerated those models (the common case), the queries fell back to a raw full-scan — exactly the slowness this release set out to fix. Build 232 therefore **ditches the CIM tier entirely** and moves those four dashboards onto dedicated KV-Store rollups, so they are fast regardless of the customer's CIM-acceleration state. In the same build, **every percentile chart (p50/p95/p99) was replaced with an Avg + Max-by-hour chart** — averages and maxima roll up byte-exact across hourly buckets (Avg = Σsum ÷ Σcount, Max = max-of-per-bucket-max), whereas percentiles cannot be merged across buckets.

**Result (validated at 335M events on the test fleet).** Cached reads are uniformly **~0.1–0.6 s** versus 10 s – 19 min raw; speedups range **64× – 5,358×**. Every rolled-up panel was verified byte-exact against its original raw SPL (build 232: all 40 refactored panels re-verified byte-exact post-deploy at 335M; build 233: the 7 Host Details panels re-verified byte-exact). Data freshness on the rolled-up panels is hourly (the same trade-off the Topology view already made).

**Builds 234–237 — universal panel UX + the last raw-scan fixes.**

- **Loading spinner on every panel** (build 234) — every chart/table renders the orange-dot spinner + "Loading data…" while its search is in flight (KPI cards show a small spinner instead of a dash), replacing the old plain "Loading…" text.
- **Per-panel action toolbar** (builds 234–235) — every chart and table panel header now carries **Open in Search · Download (CSV) · Inspect (job inspector) · Refresh** plus a "&lt;1m ago" last-run stamp. Charts auto-wire their search metadata; tables pass it explicitly. (KPI single-value cards get the spinner but no toolbar.)
- **Web Dispatcher "Slowest Request Traces"** (build 236) — was the last estate-wide raw `| sort 20 - total_us` full-scan of the highest-volume web sourcetype (~165 s at scale). Now reads a per-hour top-20 rollup (`logserv_webdisp_slowtrace_rollup`); **byte-exact** (the global 20 slowest are each within their own hour's top-20, so the union re-sorted = the global top-20).
- **Beaconing / suspicious-activity** (build 237) — the 3 DNS / Network-Perimeter `streamstats` periodicity panels now read a per-day gap-statistics rollup (`logserv_beaconing_detail_rollup`), reconstructing avg/variance over the picked range. This is a **close approximation** (per-day gaps miss the inter-arrival gap spanning each midnight boundary) chosen so the panels stay time-picker-responsive; on the validation data the flagged set matched the raw streamstats exactly.

The release now ships **22 rollup collections** (the 20 from builds 206–233 plus `logserv_webdisp_slowtrace_rollup` and `logserv_beaconing_detail_rollup`) plus the per-day beaconing-count rollup.

**User-visible changes in build 232.** A few panels changed shape as a consequence of moving to rollups: HANA Trace "Slowest SQL Operations" became a top-operations-by-Max/Avg-duration table (the per-event `_time`/host columns cannot survive an aggregate); Web Dispatcher "Top URIs" dropped its "Unique Clients" column (a 3-dimension grain would explode at scale); and all response-time charts now show **Avg + Max** instead of p50/p95/p99. Network Perimeter's "Suspicious Activity Indicator", DNS beaconing tables, Web Dispatcher "Slowest Request Traces", and Cloud Connector "Audit Log" stay raw (streamstats / per-event listings that cannot be rolled up byte-exact).

### Build 242 — Enterprise Security disabled by default + scheduled-search staggering

This is a **`savedsearches.conf`-only** release (plus the build-number bump) — no dashboard, rollup, or JavaScript changes. It tunes the scheduled-search workload so it scales cleanly at high event volume.

- **Enterprise Security content ships disabled by default.** All 22 `splunk_sap_logserv_es_*` saved searches (5 correlation searches, the threat-intel + behavioral-anomaly detections, the risk-notable threshold, and the Asset & Identity feeds) now carry `disabled = 1`. The ES content is opt-in — it targets the ES notable / risk / Asset & Identity frameworks and CIM data models that no-op when ES is not installed — and **no dashboard reads any ES output** (verified: the ES searches write only `action.notable` / `action.risk` and the `splunk_for_sap_logserv_{assets,identities}.csv` lookups). Disabling them removes the two heaviest searches on the box (the 30-day anomaly scans) and the per-hour correlation cluster from every customer that has not installed ES. **Enable them after installing Splunk Enterprise Security** — Settings → Searches, Reports & Alerts → filter `splunk_sap_logserv_es_` → Enable, or a `local/savedsearches.conf` `[<name>] disabled = 0` override. See the ES Integration docs.
- **The hourly rollup aggregates were de-bursted.** Previously all 24 always-on rollup-aggregate searches fired at minute `:05` every hour (alongside the two heaviest ES anomaly scans). They are now spread one-per-minute across **`:05`–`:28`** (`<min> * * * *`; the dispatch window is unchanged `-1h@h..@h`, so the firing minute is freshness-neutral — each always processes the just-completed hour). Peak concurrency drops from 24 to ~1–2.
- **Retention + the two daily beaconing aggregates moved to an off-peak `:30`–`:58` band**, 2 minutes apart, across hours 0 and 1 (`00:30`–`00:58` then `01:30`–`01:50`). This keeps every daily search out of the aggregate band and eliminates the two pre-existing same-minute collisions.
- **The (disabled) ES searches were re-croned to the back of the hour** so that enabling them later does not re-create a burst — the heavy 30-day anomaly searches sit on distinct back-of-hour minutes (`48` / `52` / `56`, daily `03:00`), with the lighter threat-intel / correlation searches phase-staggered.

A cron-expanding collision check (expanding `*`, `*/n`, ranges, and comma-lists over the full hour × minute space) confirms **no two enabled scheduled searches share an (hour, minute)**; a post-deploy scheduler-log check showed **0 skipped / 0 deferred**. AppInspect was re-run (the conf changed) — posture unchanged at 0 errors / 0 failures / 0 future_failures / 8 warnings / 109 success.

> **Note on the plan's daily-band table.** The shipped daily band places the hour-1 spillover at `01:30`–`01:50` (not the `01:08`–`01:30` that an earlier draft used) — the draft's hour-1 minutes overlapped the every-hour aggregate band (`:05`–`:28` fires *every* hour, including hour 1), which would have produced 11 collisions. The corrected layout keeps the entire daily band in the stated `:30`–`:58` window.

### Build 240–241 — Environment Topology detail-tab caching

The Environment Topology view's **graph** (nodes / edges / inventory / Live Activity) was already KV-Store-backed and fast. Its **right-pane detail tabs**, however, were the one corner the dashboard-perf refactor never touched — they dispatched a live raw `sap_logserv_idx_macro` scan on every node/edge click (node Calls/Hr · Top Programs · Errors · Hosts; edge Operations · Performance · Errors), which is multi-second-to-minute at high event volume. Build 240 moves them onto the same hourly KV-Store rollup model as the dashboards.

One new collection, **`logserv_topology_detail_rollup`**, with a `metric` discriminator serves all seven tabs (node `node_hourly` / `node_program` / `node_error` / `node_host`; edge `edge_op` / `edge_perf` / `edge_err`). Edge **Activity** reuses the existing `logserv_topology_edges` rows, and the edge Performance headline p50/p95/max still come straight off the edge row — neither needs a new metric. A new hourly aggregate (`logserv_topology_detail_aggregate`, cron `5 * * * *`), one-time backfill, and 365-day retention search populate and trim it; the **Settings → AI Assistant → Dashboard Data → Run backfill** panel now lists this collection (22 rollups total).

- **Node metrics are byte-exact with the old sourcetype-agnostic OR-match** via an explode-dedup pattern (`scope = mvdedup(mvappend(sap_sid, peer_ip, local_ip, client_ip, clientip, host)) | mvexpand scope`), so an event matching a node in two fields is counted once — exactly as the old `(sap_sid=X OR …)` search did. **Edge metrics** replicate the `aggregate_edges` id derivation (`scope` = the sha1[:16] edge id) so the cache key matches the clicked edge.
- **One intentional display change** (the only non-byte-exact tab): the HANA-tenant edge **Performance** distribution now shows **Avg + Max** of `hana_op_duration_ms` instead of the p50/p75/p95/p99/max percentile breakdown — percentiles don't merge across hourly buckets (Avg = Σsum ÷ Σcount, Max = max-of-per-bucket-max). The headline p50/p95/max still come from the edge row, unchanged.
- **Trade-off:** these tabs are now hourly-fresh (like the dashboards) rather than live; the node Calls/Hr chart's most-recent complete hour lags by up to one aggregate cycle.

All seven tabs were verified byte-exact against the original raw search both pre-deploy (22 node/edge cases) and post-deploy reading the populated collection at 335M events, and live-verified in the browser (the node tabs render the rollup data; the edge reads return correct data from the app's authenticated session; the view stays fully responsive). This build **adds conf** (the collection + transforms + metadata + three saved searches), so AppInspect was **re-run** — posture unchanged at 0 errors / 0 failures / 0 future_failures / 8 warnings / 109 success.

**Build 241 — host-split the node aggregate arms (backfill speedup).** The three full-scan node metrics (`node_hourly` / `node_host` / `node_error`) originally used one explode-dedup arm (`mvdedup(mvappend(6 fields)) | mvexpand scope`) that scans the **whole index** — at 335M a single node_host backfill day measured ~1,059 s. Build 241 splits each into (a) a cheap single-pass `stats … by host | eval scope=host` arm (no `mvexpand`, covering host-nodes) + (b) a small 5-SAP-field explode arm scoped to SAP events only (covering SID/IP-nodes). This is **byte-exact** with the old 6-field OR-match because hostnames are disjoint from SID/IP values (the only double-count case is a single event whose host literally equals one of its own SAP-field values — structurally absent; gated by a 9-case de-risk + the same 22-case post-deploy verify, all byte-exact). The dominant full-index `mvexpand` is eliminated (`stats … by host` ≈ 3 s/day); only the SAP-fields explode arm — a subset of events — remains, so the one-time backfill drops from ~hours to tens of minutes (the steady-state hourly aggregate was already fast and is unchanged). Build 241 is JS-identical to build 240 (only `app.conf` build + the `savedsearches.conf` node arms changed); AppInspect re-run, unchanged at 0/0/0 + 8 warnings / 109 success. The Run-backfill panel still handles any slow arm via its resume-on-reopen mechanism.

### Build 239 — pie/donut empty-after-range-change fix

Every chart applies a vertical color gradient to its bars/slices via a shared post-render SVG walker (`GradientWrap`). It cached each color's gradient `<defs>` id, but didn't verify the gradient still existed in the *current* `<svg>`. When the Splunk Pie viz swaps its `<svg>` (or wipes its defs) on a time-range change, the cached id dangled — slices then painted `fill="url(#missing)"`, i.e. **transparent** — so donut/pie charts (e.g. Change & Configuration Activity → "Change Events by Category") rendered as an empty outline with labels but no colored slices after switching the time range. The initial render was always fine; only re-renders broke.

Build 239 fixes it by deriving the gradient id from a source-hex stashed on each element and re-creating the gradient in the live svg when it's missing (convergent — no DOM mutation when the gradient is already present), plus a `requestAnimationFrame` debounce on the redraw observer as a defense-in-depth cap. This is a JavaScript-bundle-only change (`home.js`); no conf, data-model, or rollup changes, so the AppInspect posture and all rollup verification are unaffected. (Build 238 was an interim attempt at this fix that shipped a quote-parsing bug causing an observer loop; it was reverted and never canonical — preserved only under `testing/iteration_tarballs/`.)

### Latent-bug fixes shipped alongside the refactor

While re-expressing panels, three pre-existing display bugs (all string-vs-number / `match()`-in-base-search predicate mistakes that silently returned 0) were found and fixed:

- **Cloud Connector HTTP Error Rate** (build 204) — the KPI compared a string `is_error` field against the number `1` and was stuck at 0%; re-expressed as the `status >= 400` fraction (now ~7.3% on test data). Build 232 carried this corrected semantics into the Cloud Connector KV-Store rollup (`err_count` where `status >= 400`, ÷ total) when the CIM tier was retired.
- **Change & Configuration "Password Change" / "User Change" KPIs** (build 215) — a Linux `match(_raw, …)` clause sat in base-search position where `match()` (eval-only) silently no-ops; moved to a post-base `| where`. `kpiPassword` 0 → 21 on test data.
- **`icm_is_error` predicate** (build 227) — the same string-vs-number trap (`icm_is_error = 1` vs the EVAL's string `"true"`) in the Environment Health severity rollup and the `logserv_top_error_categories` AI prompt; fixed to `="true"`.

### Backfill button + 365-day cache retention (builds 230–231)

- **"Run backfill" Settings button** (build 230) — a new **Settings → AI Assistant → Dashboard Data** tab seeds all the rollup collections on first install. It dispatches each rollup's aggregation arms as **top-level** searches (immune to the subsearch wall-clock limits that truncate a bundled `| union` backfill at high volume), with a progress bar, completeness banner, and per-rollup status. Idempotent and resumable. **An admin clicks this once after installing on a high-volume instance** to populate dashboard history immediately; otherwise the hourly aggregation seeds history going forward.
- **Cache retention raised 30 → 365 days** (build 231) — all 16 rollup-retention searches (15 dashboard rollups + Topology) now keep a full year. The install backfill still seeds 30 days; the cache then grows to a year organically via the hourly aggregation (seed-and-grow).

The previous canonical App builds are preserved in [`../testing/iteration_tarballs/`](../testing/iteration_tarballs/) (canonical chain: build 233 → 237 → 239 → 240 → 241 → 242; build 238 was a reverted interim — an early attempt at the pie fix that shipped an observer-loop bug — kept there for the record but never canonical). The Data TA fsfix tarball is also mirrored there as [`splunk_ta_sap_logserv-0.0.5.0-fsfix-2026-06-01.tar.gz`](../testing/iteration_tarballs/splunk_ta_sap_logserv-0.0.5.0-fsfix-2026-06-01.tar.gz).

## AppInspect

Both tarballs are AppInspect-validated via `splunk-appinspect` in **precert mode with `--included-tags cloud`** (the Splunk Cloud private-app vetting ruleset). To re-run locally:

```bash
pip install splunk-appinspect
splunk-appinspect inspect release_binaries/splunk_app_sap_logserv-0.0.6.0.tar.gz --mode precert --included-tags cloud
splunk-appinspect inspect release_binaries/splunk_ta_sap_logserv-0.0.6.0.tar.gz --mode precert --included-tags cloud
```

Current Cloud-mode posture (re-baselined on the canonical **build-242** App tarball, AppInspect 4.1.3):

- **App** (build 242): 0 errors / 0 failures / 0 future_failures / 8 baseline warnings / 109 success — see [`appinspect_cloud_logserv_app.json`](./appinspect_cloud_logserv_app.json). Identical gating posture to the v0.0.5.0 App. Build 242 **changes conf only** (`savedsearches.conf` — `disabled` flips on the ES searches + `cron_schedule` re-staggering), so AppInspect was **re-run** on the build-242 bundle; disabling searches and changing crons introduce no new findings. The 8 App warnings are the established baseline (pretrained sourcetypes, public-IP literals in JSON examples, Mako template framework).
- **Data TA** (app version 0.0.5, "fsfix"): 0 errors / 0 failures / 0 future_failures / 11 baseline warnings / 123 success — see [`appinspect_cloud_logserv_ta.json`](./appinspect_cloud_logserv_ta.json). Byte-identical to the v0.0.5.0 canonical Data TA; re-baselined here against the exact tarball bytes.

Both tarballs are **Splunk Cloud-installable** (the v0.0.5.0 line cleared all prior Data TA Cloud-vetting failures; see the v0.0.5.0 release notes for that history). The 8 App / 11 Data TA warnings are the established baseline (pretrained sourcetypes, public-IP literals in JSON examples, Mako template framework). Note: AppInspect 4.1.3 reports 220 total checks; an earlier 4.2.0 run reported 242 — the gating posture (0 errors / 0 failures / 0 future_failures) is identical, only the absolute check totals differ by AppInspect version.

Each app also ships a `run_appinspect.sh` helper at `sap_logserv_package/<app>/run_appinspect.sh` that wraps the above.

## Third-party attribution

The App tarball bundles a current CycloneDX 1.4 software bill of materials at `splunk_app_sap_logserv/SBOM.json`, enumerating every third-party dependency with its package URL (purl), version, and hash. It also ships a full attribution document at `splunk_app_sap_logserv/THIRD-PARTY-NOTICES.md` — one section per bundled npm package (1236 packages: name@version, license, repository, and the complete bundled LICENSE/NOTICE text) plus the absorbed-Splunk-add-on attributions. The same file is mirrored at the snapshot root for the GitHub repo; both are regenerated deterministically from the build's `node_modules/` tree by `yarn build` (`bin/generate-third-party-notices.js`), so the listed package versions always match the shipped JavaScript bytes. The Data TA's third-party Python dependencies are pinned in `package/lib/requirements.txt` (notably `solnlib>=5.0.0,<8.0.0` for Splunk Cloud AArch64 compatibility).

## Splunkbase submission status

**Held for further customer review.** The tarballs are ready to ship; submission to the Splunkbase precert API has not been performed and will be initiated by the maintainer who holds Splunkbase credentials. To submit, sign in to <https://splunkbase.splunk.com> and use the **Submit App** UI to upload each tarball as a separate app, or use the Splunkbase REST API with an API key.
