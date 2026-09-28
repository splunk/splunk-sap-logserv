# Upgrading to this release

This page covers upgrading an existing LogServ installation to the current v0.1.2 release — from the v0.0.5 / v0.0.6 / v0.1.1 lines, or from an earlier v0.1.2 build. The upgrade requires **no data re-ingest**: search-time field extractions and sourcetype routing are compatible, and existing indexed data is read as-is.

!!! warning "The three things to know before you upgrade"
    1. **The published App package is the full-LLM build variant.** If you are upgrading an installation that ran the templates-only build, the compile-time force is removed, so the deployment's stored `templates_only_mode` setting governs again — and an installation with no stored value falls back to the shipped default of **off**, which means free-form chat becomes available as soon as an LLM provider credential is configured. An upgrade creates no credential, so nothing reaches a vendor until an admin configures one. To keep a deployment restricted, turn **Settings → AI Assistant → Templates-only mode** on after upgrading, or install a templates-only build instead. See [Build Variants](../ai-assistant/templates-only-build.md).
    2. **Dashboards read a rollup cache that starts empty on first upgrade to the rollup architecture** — if you are coming from a pre-rollup build (v0.0.5, or a v0.1.1 App build 244 or earlier), run the one-click backfill after upgrading (or wait for the hourly aggregation to fill the cache in over the following day). Upgrades between rollup-era builds keep the existing cache; KV-Store data survives an app upgrade.
    3. **Enterprise Security content ships enabled, on a collision-free staggered schedule** — the `splunk_sap_logserv_es_*` searches run out of the box (correlations hourly, behavioral anomalies daily, feeds every 4 hours). Without ES installed they no-op harmlessly (their notable/risk actions do nothing); re-tune or disable them in `local/savedsearches.conf` if you don't want the scheduled load. See [Enterprise Security → Disabling or tuning the ES content](../enterprise-security/overview.md#disabling-or-tuning-the-es-content).

## :material-circle-box:{ .taiconcolor } Data TA (`splunk_ta_sap_logserv`) — routine upgrade

Install the v0.1.2 Data TA over your existing one on each tier that carries it (Deployment Server `apps/` + `deployment-apps/`, Heavy Forwarders via the DS push, and the indexer). All `local/` configuration — filter rules, the Cloud Provider selection, and the persisted filter settings — is preserved by a normal app upgrade; a Splunkd restart applies it. Sourcetype routing and the index definitions (`sap_logserv_logs`, `logserv_ai_assistant_audit`) are compatible across these releases.

The v0.1.2 Data TA routes Squid's `cache.log` and `store.log` to their own sourcetypes, `squid:cache` and `squid:store`; `access.log` stays `squid:access`, and all three keep the `proxy/squid` filter path. Events indexed before the update keep `squid:access`. The App's dashboards count requests from `access.log` lines only, so they are unaffected; saved searches or alerts of your own that read those two files under `squid:access` need the new names.

It also declares the folder paths real LogServ deliveries use beside the older layout: `linux/proxy` (Squid on Azure, a proxy VM's `/var/log/messages` on GCP) and `linux/pacemaker` (the Pacemaker cluster log on GCP). If Filtering is on with an explicit include list, add them where those logs should be kept — the coverage warning names them, because events under them are dropped at the forwarder.

The Azure and GCP ingest add-ons (`splunk_ta_sap_logserv_azure`, `splunk_ta_sap_logserv_gcp`) upgrade the same way, **directly on each Heavy Forwarder** — never via the Deployment Server (their credentials live in each add-on's own `local/`, which a DS push would wipe). See the [Azure Setup Guide](../install-setup/azure-setup.md) and [GCP Setup Guide](../install-setup/gcp-setup.md).

## :material-circle-box:{ .taiconcolor } UI App (`splunk_app_sap_logserv`) — what changes

### Coming from a pre-rollup build: dashboards populate from a cache that starts empty

Current dashboards read most panels from **KV-Store rollup collections**. On the first upgrade from a pre-rollup build (v0.0.5, or v0.1.1 build 244 and earlier) those collections are created **empty**, and rolled-up panels show no data until they fill. Two ways they fill:

- **Run the backfill once** (recommended on any non-trivial install): **Settings → Dashboard Data → Run backfill** seeds 30 days of history immediately. It is idempotent and resumable.
- Otherwise the hourly aggregation searches fill the cache **one hour at a time going forward**, so dashboards fill in over the following day.

The `tstats`-tier panels (Data Pipeline Overview, Host Details counts, Multi-Cloud Overview, and the count KPIs) work **immediately** — they read the index directly and need no rollup. Sub-90-minute time ranges also work immediately on every panel (they route to the panels' raw queries automatically). See [Dashboard Performance & Data Freshness](../logserv-app/dashboards/performance.md).

Upgrading **between rollup-era builds** keeps the existing cache — KV-Store collections and their data survive an app upgrade as long as the collection definitions are unchanged, and a re-run of the backfill is only needed when the release notes call one out for a specific rollup.

!!! warning "Coming from App build 355 or earlier: rebuild Beaconing detection once"
    Earlier builds keyed each day of the Beaconing detection rollups on midnight in the time zone of the search that wrote it: the scheduled daily searches used the search head's time zone, a **Settings → Dashboard Data** backfill used the signed-in admin's. Where the two differ, a day could be stored twice, and the **Beaconing Domains** KPI summed both copies (1,777 against 1,103 over 30 days on the reference system). Current builds key every day on UTC midnight, but rows written earlier keep their old keys until retention trims them. If your search head does not run in UTC, or a Beaconing backfill was ever run from Settings by an admin whose time zone is not UTC, click **Clear** then **Backfill** on the **Beaconing detection** row in **Settings → Dashboard Data** once. The rebuild is safe either way.

!!! warning "Coming from App build 356 or earlier: rebuild Change & Configuration Activity once"
    Earlier builds stored the after-hours flag in the Change & Configuration rollup, classified in the time zone of whichever search wrote the row: the hourly schedule used the search head's time zone, a **Settings → Dashboard Data** backfill used the signed-in admin's. If a backfill was ever run from Settings in a time zone different from the search head's, the hours where the two classifications disagreed were stored twice, which inflated **Total Change Events** and **After-Hours Changes** (by about 24% over 30 days on the reference system). The rebuild below is safe either way. After upgrading, open **Settings → Dashboard Data**, click **Clear** on the **Change & Configuration Activity** row, then **Backfill** that row with a window covering the history you want (the collection keeps up to 365 days). No other rollup needs rebuilding for this.

!!! warning "Coming from App build 357 or earlier: rebuild Linux System & Security once"
    Earlier builds recorded fragments of ordinary words as **Kernel Event Types** — the first capital letter of a sentence-case kernel message ("Write cache…" became `W`), and tags cut short at their first digit (`EXT4` became `EXT`). Current builds take only a genuine ALL-CAPS tag. The old categories stay in the Linux rollup until its 365-day retention trims them, so after upgrading, click **Clear** then **Backfill** on the **Linux System & Security** row in **Settings → Dashboard Data** once. Both rebuilds can run in the same visit.

!!! warning "Coming from App build 363 or earlier: rebuild the proxy and HANA rollups once"
    Builds 364 and 365 parse real SAP LogServ records as they arrive, JSON escapes included: Squid proxy logs in the `logformat=splunk_recommended_squid` form (earlier builds extracted no proxy fields from them), the HANA audit status of every action, not only connect-type actions, and password statements in upper case. Rollup rows written before the upgrade keep the old values, and three rows keep them under the old key `(none)`. After upgrading, open **Settings → Dashboard Data** and click **Clear** then **Backfill** on **Proxy Analytics**, **HANA Audit** and **Cross-Stack Authentication**; then **Backfill**, without Clear, **Network Perimeter**, **Environment Health**, **Beaconing detection** and the two **Environment Topology** rows, which recount what they already hold. The Environment Topology rows are the slowest to rebuild. Proxy request totals fall where Squid's `store.log` and `cache.log` are collected: those lines are not requests and are no longer counted.

### New scheduled searches, new collections, and a restart

Relative to a pre-rollup build, the upgrade adds the rollup-aggregate / retention / detection scheduled searches and the rollup KV-Store collections. A **Splunkd restart is required** for the collections to be created and the new searches to register — Splunk Web's "Install app from file" upgrade prompts for it. The scheduled searches are staggered so the scheduler never bursts — see [Scheduled-search schedule](../logserv-app/dashboards/performance.md#scheduled-search-schedule).

### Visible UI / panel changes when coming from v0.0.5-era builds

- Every chart and table panel header gains a toolbar (**Open in Search · Download CSV · Inspect · Refresh**), a loading spinner, and the Data Doctor's **Diagnose** action; empty panels explain themselves ([Data Doctor](../logserv-app/dashboards/platform/diagnostics.md)).
- All percentile charts (p50 / p95 / p99) become **Avg + Max** by hour; HANA Trace "Slowest SQL Operations" becomes a top-by-max table; Web Dispatcher "Top URIs" drops its "Unique Clients" column. (See [Release Notes](../overview/release-notes.md).)
- **Rolled-up panels are hourly-fresh** at wide time ranges; sub-90-minute selections automatically use the panels' raw queries, so short-range investigation stays real-time.
- The app renders in the Cisco Magnetic theme (dark default + light mode toggle), and the Environment Topology view has the current star-system layout and node designs.
- Your browser may briefly serve a cached bundle; a hard refresh picks up the new build.

## :material-circle-box:{ .taiconcolor } What is preserved

- **All `local/` configuration** survives the upgrade — `ai_assistant_settings.conf`, audit acknowledgements, telemetry, and any credentials in `passwords.conf`. (A stored LLM provider credential carried forward from an earlier install becomes live again on the published full-LLM build — see the warning at the top of this page.)
- **KV-Store data** — settings, acknowledgements, saved topology layouts, dashboard preferences, and populated rollup collections all persist.
- **Search-time field extractions and sourcetype routing are unchanged** — existing custom searches, alerts, and reports against `sap_logserv_logs` keep working.
- **Dashboard URLs / routes are unchanged** across recent releases. The Settings page moved from `#/settings/ai-assistant` to `#/settings` (the old URL redirects) and is now titled **Application Settings**, with two top-level tabs (AI Assistant, Dashboard Data) — update any runbook that names the old page title.
- **No data re-ingest is required** — existing indexed data is read as-is.

## :material-circle-box:{ .taiconcolor } Recommended upgrade sequence

1. Install the v0.1.2 **UI App** tarball over the existing App on the search head (**Apps → Install app from file → Upgrade**), and restart when prompted.
2. Install the v0.1.2 **Data TA** on the Deployment Server (`apps/` + `deployment-apps/`) and the indexer; push to the Heavy Forwarders via your server class. Upgrade any per-HF Azure / GCP ingest add-ons directly on each HF.
3. Hard-refresh the browser.
4. Coming from a pre-rollup build: run **Settings → Dashboard Data → Run backfill** to populate dashboard history immediately.
5. If you don't run Enterprise Security and don't want the ES searches' scheduled load, disable them per [Enterprise Security → Disabling or tuning](../enterprise-security/overview.md#disabling-or-tuning-the-es-content).

## :material-circle-box:{ .taiconcolor } Rollback

Reinstalling the previous App tarball reverts cleanly — it is a `default/` content swap, and your `local/` configuration is preserved. Rollup collections created by the newer build are harmless to a rolled-back App and can be left in place. The Data TA rolls back the same way (its `local/` filter configuration is preserved), though rolling it back also removes any ingest features introduced since that version — check the [Release Notes](../overview/release-notes.md) before rolling back a Data TA that Heavy Forwarders depend on.

## :material-lightning-bolt:{ .taiconcolor } At a glance

- **The published App is the full-LLM build** — upgrading a templates-only deployment with it lets the stored `templates_only_mode` setting govern again; free-form chat activates only once an LLM provider credential is configured.
- **No data re-ingest**; `local/` and KV-Store data are preserved.
- Coming from a pre-rollup build: **run Settings → Dashboard Data → Run backfill once** so dashboards aren't empty, and expect a **Splunkd restart**.
- **ES content ships enabled** on a staggered schedule — disable it only if you don't want the scheduled load.
