# Dashboard Performance & Data Freshness

The LogServ App dashboards are designed to stay fast on large environments. This page explains how each dashboard panel sources its data, what "data freshness" means per panel, and the one-time step an admin runs after installing on a high-volume instance.

## :material-circle-box:{ .taiconcolor } How the dashboards source their data

Every panel reads from the cheapest *correct* data source for what it shows. There are two fast tiers plus a small set of panels that stay on raw events.

| Tier | Used for | Freshness | Cost |
|---|---|---|---|
| **`tstats` on indexed fields** | Pure counts and averages over indexed dimensions (event volumes, host / sourcetype / cloud-provider breakdowns) | Real-time | Very low — reads the index's tsidx, no raw-event scan |
| **KV-Store precompute rollups** | Most charts, tables, and KPIs across the dashboard suite | Hourly (most-recently-completed hour) | Near-zero at read time — a scheduled search precomputes the data once per hour |
| **Raw events** | Per-event listings, streamstats periodicity (beaconing), and a few timing traces that cannot be rolled up | Real-time | Bounded with `\| head N` where the panel is a time-ordered listing |

!!! info "No CIM data-model acceleration is required"
    The dashboards do **not** depend on accelerating the Common Information Model (CIM) Web / Authentication / Network data models. The fast path is the app's own KV-Store rollups, which work regardless of whether you have accelerated any CIM model. (The app's CIM *tagging* for Splunk Enterprise Security correlation is a separate, independent feature — see [Enterprise Security → CIM Compliance](../../enterprise-security/cim-compliance.md).)

### The KV-Store rollup layer

Behind the rolled-up panels are **22 KV-Store rollup collections** (`logserv_*_rollup`). For each, a scheduled saved search (`logserv_*_aggregate`, cron `5 * * * *` — five minutes past every hour) aggregates the previous hour's raw events into hour-bucketed rows. The dashboard reads the collection back, filtered to the global time-range picker's window via a `bucket_ts` range. Because the heavy aggregation happens once per hour in the background, opening a dashboard re-reads precomputed rows in roughly **0.1–0.6 seconds** instead of dispatching a full raw scan.

A daily retention search trims each collection to a rolling **365-day** window.

## :material-circle-box:{ .taiconcolor } Scheduled-search schedule

The app's scheduled searches are organized into three non-overlapping bands so that no two enabled scheduled searches ever fire in the same minute and the hourly aggregation never contends with the daily retention. This keeps the scheduler from bursting at high event volume.

| Band | When | What runs |
|---|---|---|
| **Hourly aggregates** | `:05`–`:28` every hour, one per minute | The 24 always-on rollup-aggregate searches (`logserv_*_aggregate`) |
| **Daily retention + beaconing** | `:30`–`:58` (hours `00` and `01`), two minutes apart | The 24 retention trims + the 2 daily beaconing aggregates |
| **Enterprise Security** | back of the hour (disabled by default) | The 22 `splunk_sap_logserv_es_*` searches — see note below |

### Hourly aggregate band (`:05`–`:28`)

Each rollup aggregate dispatches the just-completed hour (`-1h@h`..`@h`), so the firing minute is freshness-neutral — spreading them one-per-minute simply avoids a 24-search burst at `:05`. Peak concurrency is ~1–2 instead of 24.

| Minute | Aggregate | Minute | Aggregate |
|---|---|---|---|
| `:05` | topology nodes | `:17` | linux |
| `:06` | topology edges | `:18` | web timing |
| `:07` | topology inventory | `:19` | hana trace |
| `:08` | topology detail | `:20` | windows |
| `:09` | work-process perf | `:21` | sap services |
| `:10` | severity | `:22` | multi-cloud |
| `:11` | hana audit | `:23` | cloud connector |
| `:12` | compliance | `:24` | proxy |
| `:13` | sap router | `:25` | dns |
| `:14` | abap network | `:26` | pipeline |
| `:15` | cross-stack auth | `:27` | host details |
| `:16` | perimeter | `:28` | web-dispatcher slow traces |

### Daily band (`:30`–`:58`)

Retention trims and the two daily beaconing aggregates run in the off-peak `:30`–`:58` window — 15 searches at `00:30`–`00:58`, the remaining 11 at `01:30`–`01:50`, all two minutes apart. Keeping them at minute `:30`+ guarantees they never collide with the hourly aggregate band (which fires at `:05`–`:28` of *every* hour). Each retention search trims its collection to the rolling 365-day window; the two beaconing aggregates (`00:30`, `00:32`) precompute the per-day DNS/perimeter beaconing statistics.

### Enterprise Security band (disabled by default)

The 22 `splunk_sap_logserv_es_*` searches ship **disabled** (see [Enterprise Security → Enabling the ES content](../../enterprise-security/overview.md#enabling-the-es-content)). They carry de-conflicted crons at the back of the hour so that enabling them after installing ES does not re-create a burst — the heavy 30-day anomaly scans sit on distinct minutes (`:48` / `:52` / `:56`, plus a daily `03:00`), and the lighter threat-intel / correlation searches are phase-staggered clear of both the aggregate and daily bands.

### Measured behavior

On the validation fleet (335M events), the hourly aggregates each complete in roughly **2–17 seconds**; the slowest retention trim is ~1 minute; the scheduler logs **0 skipped / 0 deferred**. The two heaviest searches that used to run at `:05` — the ES 30-day anomaly scans (~150–340 s and ~50–120 s) — are now disabled by default, removing them from every non-ES instance entirely.

## :material-circle-box:{ .taiconcolor } What "data freshness" means per panel

- **`tstats` and raw panels are real-time** — they reflect events the instant they are indexed.
- **Rolled-up panels are accurate to the most-recently-completed hour.** The hourly aggregation runs at five minutes past each hour, so within the current partial hour a rolled-up panel shows data through the last completed hour, not the live partial hour.

!!! lightning "Investigating live, sub-hour activity"
    For minute-level investigation, use a panel's **Open in Search** toolbar action (see below) to jump into Splunk's Search app with the panel's SPL and your selected time range pre-applied — that runs against raw events in real time. The rolled-up dashboard panels are tuned for trend and volume analysis over the hourly grain, not live tailing.

## :material-circle-box:{ .taiconcolor } Backfilling on first install

A freshly installed rollup collection is empty until its hourly aggregation has run. On a high-volume instance you do not want to wait — so the app ships a one-click backfill.

1. Open **Settings → AI Assistant → Dashboard Data** (admin-only).
2. Review the per-rollup status. Collections with no history show an "incomplete history" banner.
3. Click **Run backfill**.

The backfill seeds **30 days** of history into every rollup collection. It dispatches each rollup's component aggregation searches as **top-level Splunk jobs** — this matters at scale: the bundled `*_backfill` saved searches use a single `\| union` that Splunk auto-finalizes at a subsearch wall-clock limit, which silently truncates results at high event volume. The Dashboard Data button avoids that by running each component as its own unrestricted job. It shows a progress bar, is **idempotent** (re-running upserts the same rows), and is **resumable** (it detects collections that are already complete and skips them).

After the initial backfill, the hourly aggregation keeps each collection current and the 365-day retention grows the cached history toward a full year (seed-and-grow). You only need to run the backfill again if you reinstall or deliberately clear a collection.

!!! note "If you skip the backfill"
    You don't have to run it. Without a backfill, rolled-up panels simply start populating from the next hourly aggregation onward, filling in one hour at a time. The backfill is purely to make 30 days of history available immediately.

## :material-circle-box:{ .taiconcolor } Per-panel toolbar

Every chart and table panel header carries a small action toolbar plus a "&lt;1m ago" stamp showing when the panel's search last ran:

| Action | What it does |
|---|---|
| **Open in Search** | Opens Splunk's Search app in a new tab with the panel's SPL and the current time range pre-applied — your real-time, raw drill-down path. |
| **Download (CSV)** | Exports the panel's current result set as CSV. |
| **Inspect** | Opens Splunk's Job Inspector for the panel's last search — useful for diagnosing performance or verifying what ran. |
| **Refresh** | Re-runs the panel's search immediately. |

KPI single-value cards show the loading spinner but no toolbar (they have no tabular result to export or inspect). While any panel's search is in flight it renders an orange-dot loading spinner with "Loading data…".

## :material-lightning-bolt:{ .taiconcolor } What to know at a glance

- **Most panels are hourly-fresh; counts and per-event listings are real-time.** If a rolled-up trend looks an hour behind, that's expected.
- **Scheduled searches are staggered into three bands** — hourly aggregates at `:05`–`:28`, daily retention at `:30`–`:58`, ES (disabled by default) at the back of the hour — so the scheduler never bursts.
- **On a new high-volume install, run Settings → AI Assistant → Dashboard Data → Run backfill once** to populate 30 days of history immediately.
- **No CIM acceleration is needed** for dashboard performance.
- **Use a panel's Open in Search action** for live, sub-hour investigation against raw events.
