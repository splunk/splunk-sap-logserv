# Upgrading to this release

This page covers upgrading an existing LogServ installation to the current v0.1.1 release — from the v0.0.5 / v0.0.6 lines, or from an earlier v0.1.1 build. The upgrade requires **no data re-ingest**: search-time field extractions and sourcetype routing are compatible, and existing indexed data is read as-is.

!!! warning "The three things to know before you upgrade"
    1. **The published App package is the templates-only build variant.** If you are upgrading an installation that ran a full-LLM build of the App (an approved deployment with free-form chat), installing the published package **disables free-form chat at compile time** — a stored `templates_only_mode = 0` setting (KV Store or `local/` conf) cannot re-enable it, because the build flag forces the setting on wherever it is read. Predefined prompts, MCP dispatch, and the audit log continue unchanged. See [Build Variants](../ai-assistant/templates-only-build.md). If your deployment is approved for the full-LLM variant, obtain that variant instead of the published tarball.
    2. **Dashboards read a rollup cache that starts empty on first upgrade to the rollup architecture** — if you are coming from a pre-rollup build (v0.0.5, or a v0.1.1 App build 244 or earlier), run the one-click backfill after upgrading (or wait for the hourly aggregation to fill the cache in over the following day). Upgrades between rollup-era builds keep the existing cache; KV-Store data survives an app upgrade.
    3. **Enterprise Security content ships enabled, on a collision-free staggered schedule** — the `splunk_sap_logserv_es_*` searches run out of the box (correlations hourly, behavioral anomalies daily, feeds every 4 hours). Without ES installed they no-op harmlessly (their notable/risk actions do nothing); re-tune or disable them in `local/savedsearches.conf` if you don't want the scheduled load. See [Enterprise Security → Disabling or tuning the ES content](../enterprise-security/overview.md#disabling-or-tuning-the-es-content).

## :material-circle-box:{ .taiconcolor } Data TA (`splunk_ta_sap_logserv`) — routine upgrade

Install the v0.1.1 Data TA over your existing one on each tier that carries it (Deployment Server `apps/` + `deployment-apps/`, Heavy Forwarders via the DS push, and the indexer). All `local/` configuration — filter rules, the Cloud Provider selection, and the persisted filter settings — is preserved by a normal app upgrade; a Splunkd restart applies it. Sourcetype routing and the index definitions (`sap_logserv_logs`, `logserv_ai_assistant_audit`) are compatible across these releases.

The Azure and GCP ingest add-ons (`splunk_ta_sap_logserv_azure`, `splunk_ta_sap_logserv_gcp`) upgrade the same way, **directly on each Heavy Forwarder** — never via the Deployment Server (their credentials live in each add-on's own `local/`, which a DS push would wipe). See the [Azure Setup Guide](../install-setup/azure-setup.md) and [GCP Setup Guide](../install-setup/gcp-setup.md).

## :material-circle-box:{ .taiconcolor } UI App (`splunk_app_sap_logserv`) — what changes

### Coming from a pre-rollup build: dashboards populate from a cache that starts empty

Current dashboards read most panels from **KV-Store rollup collections**. On the first upgrade from a pre-rollup build (v0.0.5, or v0.1.1 build 244 and earlier) those collections are created **empty**, and rolled-up panels show no data until they fill. Two ways they fill:

- **Run the backfill once** (recommended on any non-trivial install): **Settings → Dashboard Data → Run backfill** seeds 30 days of history immediately. It is idempotent and resumable.
- Otherwise the hourly aggregation searches fill the cache **one hour at a time going forward**, so dashboards fill in over the following day.

The `tstats`-tier panels (Data Pipeline Overview, Host Details counts, Multi-Cloud Overview, and the count KPIs) work **immediately** — they read the index directly and need no rollup. Sub-90-minute time ranges also work immediately on every panel (they route to the panels' raw queries automatically). See [Dashboard Performance & Data Freshness](../logserv-app/dashboards/performance.md).

Upgrading **between rollup-era builds** keeps the existing cache — KV-Store collections and their data survive an app upgrade as long as the collection definitions are unchanged, and a re-run of the backfill is only needed when the release notes call one out for a specific rollup.

### New scheduled searches, new collections, and a restart

Relative to a pre-rollup build, the upgrade adds the rollup-aggregate / retention / detection scheduled searches and the rollup KV-Store collections. A **Splunkd restart is required** for the collections to be created and the new searches to register — Splunk Web's "Install app from file" upgrade prompts for it. The scheduled searches are staggered so the scheduler never bursts — see [Scheduled-search schedule](../logserv-app/dashboards/performance.md#scheduled-search-schedule).

### Visible UI / panel changes when coming from v0.0.5-era builds

- Every chart and table panel header gains a toolbar (**Open in Search · Download CSV · Inspect · Refresh**), a loading spinner, and the Data Doctor's **Diagnose** action; empty panels explain themselves ([Data Doctor](../logserv-app/dashboards/platform/diagnostics.md)).
- All percentile charts (p50 / p95 / p99) become **Avg + Max** by hour; HANA Trace "Slowest SQL Operations" becomes a top-by-max table; Web Dispatcher "Top URIs" drops its "Unique Clients" column. (See [Release Notes](../overview/release-notes.md).)
- **Rolled-up panels are hourly-fresh** at wide time ranges; sub-90-minute selections automatically use the panels' raw queries, so short-range investigation stays real-time.
- The app renders in the Cisco Magnetic theme (dark default + light mode toggle), and the Environment Topology view has the current star-system layout and node designs.
- Your browser may briefly serve a cached bundle; a hard refresh picks up the new build.

## :material-circle-box:{ .taiconcolor } What is preserved

- **All `local/` configuration** survives the upgrade — `ai_assistant_settings.conf`, audit acknowledgements, telemetry, and any credentials in `passwords.conf`. (In the published templates-only package, stored LLM provider credentials are simply unused.)
- **KV-Store data** — settings, acknowledgements, saved topology layouts, dashboard preferences, and populated rollup collections all persist.
- **Search-time field extractions and sourcetype routing are unchanged** — existing custom searches, alerts, and reports against `sap_logserv_logs` keep working.
- **Dashboard URLs / routes are unchanged** across recent releases. The Settings page moved from `#/settings/ai-assistant` to `#/settings` (the old URL redirects) and is now titled **Application Settings**, with two top-level tabs (AI Assistant, Dashboard Data) — update any runbook that names the old page title.
- **No data re-ingest is required** — existing indexed data is read as-is.

## :material-circle-box:{ .taiconcolor } Recommended upgrade sequence

1. Install the v0.1.1 **UI App** tarball over the existing App on the search head (**Apps → Install app from file → Upgrade**), and restart when prompted.
2. Install the v0.1.1 **Data TA** on the Deployment Server (`apps/` + `deployment-apps/`) and the indexer; push to the Heavy Forwarders via your server class. Upgrade any per-HF Azure / GCP ingest add-ons directly on each HF.
3. Hard-refresh the browser.
4. Coming from a pre-rollup build: run **Settings → Dashboard Data → Run backfill** to populate dashboard history immediately.
5. If you don't run Enterprise Security and don't want the ES searches' scheduled load, disable them per [Enterprise Security → Disabling or tuning](../enterprise-security/overview.md#disabling-or-tuning-the-es-content).

## :material-circle-box:{ .taiconcolor } Rollback

Reinstalling the previous App tarball reverts cleanly — it is a `default/` content swap, and your `local/` configuration is preserved. Rollup collections created by the newer build are harmless to a rolled-back App and can be left in place. The Data TA rolls back the same way (its `local/` filter configuration is preserved), though rolling it back also removes any ingest features introduced since that version — check the [Release Notes](../overview/release-notes.md) before rolling back a Data TA that Heavy Forwarders depend on.

## :material-lightning-bolt:{ .taiconcolor } At a glance

- **The published App is the templates-only build** — upgrading a full-LLM deployment with it disables free-form chat; get the full-LLM variant instead if approved.
- **No data re-ingest**; `local/` and KV-Store data are preserved.
- Coming from a pre-rollup build: **run Settings → Dashboard Data → Run backfill once** so dashboards aren't empty, and expect a **Splunkd restart**.
- **ES content ships enabled** on a staggered schedule — disable it only if you don't want the scheduled load.
