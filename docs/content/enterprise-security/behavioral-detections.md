# Behavioral & Anomaly Detections

The Splunk for SAP LogServ App ships **4 statistically-baselined anomaly detections** that fire when an entity (user, host, edge) deviates from its own historical pattern. They complement the deterministic correlation searches by surfacing threats that don't match a known threat-pattern signature — credential misuse spikes, latency excursions, integration-volume drift, and after-hours admin activity that's anomalous for *that specific* admin.

All 4 use **stats-based Z-score** detection that runs against built-in Splunk SPL — **no Splunk Machine Learning Toolkit (MLTK) dependency**. Customers with MLTK installed can swap the stats clauses for `fit` / `apply` for sharper baselines.

## :material-circle-box:{ .taiconcolor } The 4 anomaly searches

| Search name | What it baselines | Z-score threshold | Schedule |
|---|---|---|---|
| `splunk_sap_logserv_es_anomaly_user_auth_volume` | Per-user authentication-event count, hourly buckets | Z > 3 + count > 10 | daily (02:30) |
| `splunk_sap_logserv_es_anomaly_webdisp_response` | Per-host Web Dispatcher **average** response time, from the hourly `logserv_web_timing_rollup` | Z > 3 + avg > 200 ms | daily (03:30) |
| `splunk_sap_logserv_es_anomaly_topology_edge_volume` | Per-edge call volume from KV Store edge bucket data | abs(Z) > 3 + count > 10 | daily (04:30) |
| `splunk_sap_logserv_es_anomaly_after_hours_admin` | Per-admin off-hours activity, daily buckets | Z > 2 + count > 5 | daily (05:30) |

All four anomaly searches run **once daily** (scheduler-local early morning): an anomalous hour is reported the following morning, not within the hour.

All 4 emit `action.notable=1` (ES Notable Review) and `action.risk=1` (RBA — risk score 30-40 / medium).

## :material-circle-box:{ .taiconcolor } How the stats-based Z-score works

Each search builds the baseline from the **same 30-day window of data** that's being scored, using `eventstats` to compute per-entity mean and standard deviation across the window's hourly (or daily) buckets. Every bucket of the previous day is then compared (the searches run daily):

```spl
| bin _time span=1h
| stats count by entity, _time
| eventstats avg(count) AS avg_count, stdev(count) AS stdev_count by entity
| eval z_score = round((count - avg_count) / stdev_count, 2)
| where _time >= relative_time(now(), "-1d@d") AND z_score > 3 AND count > 10
```

**Combined thresholds** (Z + minimum-floor) keep the false-positive rate low:

- Pure Z-score on a low-volume entity: `count=2, avg=0.1, stdev=0.5` → Z = 3.8, but absolute count is meaningless. The `count > 10` floor filters this.
- Pure absolute count: `count=15, avg=14, stdev=3` → above floor but Z = 0.33, statistically normal. The Z > 3 requirement filters this.
- Both pass → genuinely anomalous: `count=100, avg=12, stdev=4` → Z = 22, count well above floor.

The thresholds are tunable per search via the `where z_score > N` clause (see [Tuning](#tuning)).

## :material-circle-box:{ .taiconcolor } Per-search detail

### :material-crop-square:{ .taiconcolor } 1. Per-User Authentication Volume Z-Score

Compares each user's authentication-event count in each hourly bucket of the previous day to that user's own 30-day hourly baseline. Fires when Z > 3 AND count > 10.

**Threat model:** Brute-force attempts against a previously dormant account, or a misconfigured client polling at high frequency.

**FP profile:** Low. Healthy environments show 0-2 hits per hour from genuine traffic spikes (batch jobs, planned cutovers). If the traffic of an account is legitimate, exclude the account in the search: add `| search NOT auth_user IN ("<account>", ...)` after the `eval` that sets `auth_user` (see [Tuning](#tuning)).

### :material-crop-square:{ .taiconcolor } 2. Webdispatcher Response-Time Anomaly

Compares each host's per-hour latency over the previous day to that host's own 30-day baseline. Fires when Z > 3 AND avg > 200 ms.

**Threat model:** Backend health degradation, network path issue, or DDoS-style request flood degrading response time.

**FP profile:** Low for production hosts on consistent workloads; can be moderate on hosts with bursty workloads (overnight batches, end-of-month processing). Disable the search for planned heavy-load windows, or exclude the affected hosts (see [Tuning](#tuning)).

### :material-crop-square:{ .taiconcolor } 3. Topology Edge Call-Volume Anomaly

Reads pre-aggregated edge bucket rows directly from the `logserv_topology_edges` KV Store collection. Detects edges whose hourly call_count over the previous day is statistically anomalous vs. that edge's own 30-day baseline. Fires when abs(Z) > 3 AND count > 10.

**Threat model:** Surge = abnormally high cross-system traffic (DDoS, lateral-movement automation, failed retry storm). Drop = integration outage on either the source or target side.

**FP profile:** Low. The KV Store's per-edge time series is much cleaner than raw event data, so the baseline is stable. The bidirectional check (`abs(Z) > 3` rather than just `Z > 3`) catches surges and drops, with one limit: the `count > 10` floor applies to drops too, so a drop is flagged only while the edge still has more than 10 calls in the hour. An edge that stops completely writes no bucket row for the hour, so a full outage is not flagged by this search.

**Why this search is different:** It reads pre-aggregated edge bucket rows from the topology KV Store rather than scanning raw events, so its cost scales with the number of edges rather than event volume.

### :material-crop-square:{ .taiconcolor } 4. After-Hours Admin Activity Anomaly

Per-admin off-hours activity baseline vs. that admin's 30-day off-hours pattern, in daily buckets. Off-hours means before 08:00 or from 18:00 on any day, read with `strftime(_time, "%H")` in the time zone the search runs in (the search head's default time zone for the scheduled run). Admins are the `sap:hana:audit` users with `is_admin_user="true"`, the same field as the E3 correlation search; [E3. After-Hours Admin Data Access](correlation-searches.md#e3-after-hours-admin-data-access) says which accounts it matches and how to change it. Lower Z threshold (Z > 2) than the other 3 searches because admin off-hours activity is naturally rare; a smaller deviation is still significant. Fires when Z > 2 AND count > 5.

**Threat model:** Admin-account compromise (attacker active outside the admin's normal window), or insider conducting unauthorized off-hours operations.

**FP profile:** Low for environments with clear business hours. Higher during planned weekend cutovers — those should map to documented change tickets.

## :material-circle-box:{ .taiconcolor } MLTK upgrade path (optional)

If you have the [Splunk Machine Learning Toolkit (MLTK)](https://splunkbase.splunk.com/app/2890){:target="_blank" rel="noopener noreferrer"} installed, you can replace the Z-score steps with an MLTK model trained by `fit` and applied by `apply`. For per-entity baselines, MLTK's `DensityFunction` algorithm can learn one distribution per value of its `by` fields and flag outliers. An outline, for example:

| Stats-based step | MLTK-based replacement (outline) |
|---|---|
| `eventstats avg(count) AS avg_count, stdev(count) AS stdev_count by entity` and `eval z_score = ...` | A training search over the baseline window that ends in a `fit DensityFunction` on `count`, by the entity field, into a model of your own |
| `where z_score > 3` | In the detection search, `apply` that model, then keep the rows that the model marks as outliers |

Take the exact syntax, the options (distribution type, threshold) and the names of the output fields from the MLTK documentation for your version; the App ships no MLTK search to copy.

MLTK adds:

- Per-entity model persistence (the baseline is a saved model, not a per-search calculation)
- Daily and weekly cycles, by adding a time field such as the hour of day or the day of week to the `by` fields
- Distributions other than the normal one that the Z-score assumes (DensityFunction), and other outlier algorithms such as OneClassSVM

For most SAP environments the stats-based approach is sufficient. MLTK becomes valuable when you need:

1. Multi-week seasonal patterns (workload that varies by day-of-week or week-of-month)
2. Non-Gaussian distributions (network traffic with heavy-tailed shapes)
3. Per-entity model lifecycle management (training models offline, deploying via export)

To migrate a single search to MLTK without breaking the others, change the `search` of that one search only (see [Tuning](#tuning)).

## :material-circle-box:{ .taiconcolor } Tuning

Adjust thresholds by editing the `search` of a given search: in Splunk Web (Splunk Cloud and Splunk Enterprise), **Settings → Searches, reports, and alerts → Edit → Advanced edit**; on Splunk Enterprise, alternatively, override the `search =` line in `local/savedsearches.conf` (never edit `default/`). An override replaces the whole search, so start from the full shipped line and change only the clause you need. For example, the end of the user-volume search:

```ini
[splunk_sap_logserv_es_anomaly_user_auth_volume]
search = `sap_logserv_idx_macro` ... | where _time >= relative_time(now(), "-1d@d") AND z_score > 4 AND count > 25 | sort -z_score
```

**General tuning advice:**

- **Too many FPs:** Raise the Z threshold (3 → 4 → 5) AND/OR raise the absolute-count floor.
- **Missing real attacks:** Lower the Z threshold (3 → 2) — but expect more noise; pair with tighter floor.
- **Bursty workloads triggering hits:** Add a `where NOT (entity IN (<known burst entities>))` exclusion clause, with the search's own entity field (`auth_user`, `host`, or `id` for the topology edges) in place of `entity`.
- **Service-account auth volumes drowning out human user signal:** split by username pattern — e.g. `| eval is_svc=if(match(auth_user, "(?i)(adm$|^sapservice|_svc$|^svc_|_batch$|_daemon$|^sap_)"), 1, 0)`, the same classification `splunk_sap_logserv_es_service_account_interactive` applies — into two stanzas: one for service accounts (higher floor), one for humans (lower floor + tighter Z).

## :material-circle-box:{ .taiconcolor } AI Assistant integration

Each of the 4 anomaly searches has a corresponding entry in the AI Assistant predefined-prompt catalog under the Security pack:

- `security.anomaly_user_auth_volume`
- `security.anomaly_webdisp_response`
- `security.anomaly_topology_edge_volume`
- `security.anomaly_after_hours_admin`

Once an admin has turned the AI Assistant on (it ships turned off; see [Set Up the AI Assistant](../ai-assistant/enable.md)), SOC analysts can dispatch them on demand from the AI Assistant's predefined-prompt browser (Security pack) and read the result table plus its static interpretation guidance. A prompt fails while its saved search is disabled; to keep the prompts but stop the daily runs, turn off only the schedule ([Disabling or tuning the ES content](overview.md#disabling-or-tuning-the-es-content)). (Asking the assistant in natural language to *explain* an anomaly requires the free-form path, which activates once an LLM provider credential is configured.)

## :material-circle-box:{ .taiconcolor } See also

- [Correlation Searches & RBA](correlation-searches.md) — Deterministic correlation searches; complement the anomaly detections here
- [Threat Intelligence Integration](threat-intel.md) — Customer-managed CSV lookups for IOC matching
- [Asset & Identity Feed](asset-identity-feed.md) — Identity context that feeds both deterministic + behavioral detections
