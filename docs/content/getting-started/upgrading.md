# Upgrading from v0.0.5 to v0.0.6

v0.0.6 is a **dashboard-performance release** — the feature set is unchanged from v0.0.5. The upgrade is **UI-App-only and requires no data re-ingest**: search-time field extractions, sourcetype routing, and the Data TA are all unchanged. This page covers what changes, the two things to do after upgrading, and how to roll back.

!!! warning "The two things to know before you upgrade"
    1. **Dashboards look empty until the rollup cache is populated** — run the one-click backfill after upgrading (or wait for the hourly aggregation to fill them in over the following day).
    2. **Enterprise Security search cadences change** — v0.0.6 ships the ES content enabled by default on a re-staggered, collision-free schedule; the eight previously-sub-hourly correlation searches now run hourly and the four anomaly searches run daily. Re-tune any of them in `local/savedsearches.conf` if you want different cadences.

## :material-circle-box:{ .taiconcolor } Data TA (`splunk_ta_sap_logserv`) — effectively a no-op

The v0.0.6 Data TA is **byte-identical to the v0.0.5 Data TA** (its internal `app.conf` version stays `0.0.5`; the `0.0.6.0` in the filename is snapshot-naming continuity only). Sourcetype routing, index-time filtering, Deployment Server automation, and the index definitions (`sap_logserv_logs`, `logserv_ai_assistant_audit`) are unchanged.

If you are already on the released v0.0.5 Data TA, installing the v0.0.6 Data TA changes nothing — you can skip it, or reinstall it harmlessly. There is no change to the Heavy Forwarder / Deployment Server tier.

## :material-circle-box:{ .taiconcolor } UI App (`splunk_app_sap_logserv`) — what changes

### Dashboards populate from a cache that starts empty

v0.0.6 dashboards read most panels from **KV-Store rollup collections** that are created **empty** on upgrade. Until they are populated, rolled-up panels show no data. Two ways they fill:

- **Run the backfill once** (recommended on any non-trivial install): **Settings → Dashboard Data → Run backfill** seeds 30 days of history immediately. It is idempotent and resumable.
- Otherwise the hourly aggregation searches fill the cache **one hour at a time going forward**, so dashboards fill in over the following day.

The `tstats`-tier panels (Data Pipeline Overview, Host Details counts, Multi-Cloud Overview, and the count KPIs) work **immediately** — they read the index directly and need no rollup. See [Dashboard Performance & Data Freshness](../logserv-app/dashboards/performance.md).

### Enterprise Security content stays enabled, on a new schedule

The 22 `splunk_sap_logserv_es_*` saved searches ship **enabled** by default in v0.0.6 (as they did in v0.0.5), but on a re-staggered, **collision-free** schedule. To fit it, the eight correlation searches that previously ran every 5–15 minutes now run **hourly**, and the four behavioral-anomaly searches run **daily** instead of hourly — a daily run still evaluates every hourly bucket of the prior day, so no detections are missed, and the two heavy 30-day scans no longer run every hour.

- **No ES installed** → the searches run but their `action.notable` / `action.risk` directives no-op; their results stay searchable and power the AI Assistant Security-pack prompts. If you'd rather not incur the scheduled load, see [Enterprise Security → Disabling or tuning the ES content](../enterprise-security/overview.md#disabling-or-tuning-the-es-content).
- **ES installed** → Notable / Risk / Asset & Identity output continues, on the new cadence. See [Enterprise Security → The ES schedule](../enterprise-security/overview.md#the-es-schedule-collision-free).
- If you had *explicitly* set ES search state or cadence in `local/savedsearches.conf`, that local override persists and wins over the new default.

### New scheduled searches, new collections, and a restart

The upgrade adds the rollup-aggregate / retention / beaconing scheduled searches and ~29 KV-Store rollup collections. A **Splunkd restart is required** for the collections to be created and the new searches to register — Splunk Web's "Install app from file" upgrade prompts for it. The scheduled searches are staggered (hourly aggregates at `:05`–`:28`, retention at `:30`–`:58`) so the scheduler never bursts — see [Scheduled-search schedule](../logserv-app/dashboards/performance.md#scheduled-search-schedule).

### Visible UI / panel changes (cosmetic — no action needed)

- Every chart and table panel header gains a toolbar (**Open in Search · Download CSV · Inspect · Refresh**) and a loading spinner.
- All percentile charts (p50 / p95 / p99) become **Avg + Max** by hour; HANA Trace "Slowest SQL Operations" becomes a top-by-max table; Web Dispatcher "Top URIs" drops its "Unique Clients" column. (See [Release Notes → Changed](../overview/release-notes.md).)
- **Rolled-up panels are now hourly-fresh** rather than real-time. Sub-hour selections (e.g. "Last 15 minutes") reflect the last completed hour — use a panel's **Open in Search** action for live drill-down.
- Your browser may briefly serve a cached bundle; a hard refresh picks up the new build.

## :material-circle-box:{ .taiconcolor } What is preserved

- **All `local/` configuration** survives the upgrade — LLM credentials (`passwords.conf`), `ai_assistant_settings.conf`, audit acknowledgements, and telemetry.
- **Search-time field extractions and sourcetype routing are unchanged** — existing custom searches, alerts, and reports against `sap_logserv_logs` keep working.
- **Dashboard URLs / routes are unchanged** from v0.0.5 (both are the React app).
- **No data re-ingest is required** — existing indexed data is read as-is.
- The **Environment Topology** graph keeps working (its base collections persist with data); its right-pane detail tabs are new rollups and fill via the same backfill.

## :material-circle-box:{ .taiconcolor } Recommended upgrade sequence

1. Install the v0.0.6 **UI App** tarball over v0.0.5 (**Apps → Install app from file → Upgrade**), and restart when prompted.
2. The **Data TA** is a no-op — skip it, or reinstall harmlessly (no behavior change).
3. Hard-refresh the browser.
4. Run **Settings → Dashboard Data → Run backfill** to populate dashboard history immediately.
5. If you use Splunk Enterprise Security, **re-enable the `splunk_sap_logserv_es_*` searches**.

## :material-circle-box:{ .taiconcolor } Rollback

Reinstalling the v0.0.5 UI App tarball reverts cleanly — it is a `default/` content swap, and your `local/` configuration is preserved. The now-unused rollup collections are harmless and can be left in place. The Data TA needs no rollback (it is unchanged).

## :material-lightning-bolt:{ .taiconcolor } At a glance

- **UI-App-only upgrade; no data re-ingest, no Data TA change.**
- **Run the Dashboard Data → Run backfill once** so dashboards aren't empty.
- **Re-enable the ES searches** if you run Enterprise Security.
- A **Splunkd restart** is needed for the new collections and scheduled searches.
