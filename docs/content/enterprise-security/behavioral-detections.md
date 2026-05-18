# Behavioral & Anomaly Detections

The Splunk for SAP LogServ App ships **4 statistically-baselined anomaly detections** that fire when an entity (user, host, edge) deviates from its own historical pattern. They complement the deterministic correlation searches by surfacing threats that don't match a known threat-pattern signature — credential misuse spikes, latency excursions, integration-volume drift, and after-hours admin activity that's anomalous for *that specific* admin.

All 4 use **stats-based Z-score** detection that runs against built-in Splunk SPL — **no Splunk Machine Learning Toolkit (MLTK) dependency**. Customers with MLTK installed can swap the stats clauses for `fit` / `apply` for sharper baselines.

## :material-circle-box:{ .taiconcolor } The 4 anomaly searches

| Search name | What it baselines | Z-score threshold | Schedule |
|---|---|---|---|
| `splunk_sap_logserv_es_anomaly_user_auth_volume` | Per-user authentication-event count, hourly buckets | Z > 3 + count > 10 | hourly |
| `splunk_sap_logserv_es_anomaly_webdisp_response` | Per-host webdispatcher P95 response time, hourly buckets | Z > 3 + P95 > 200 ms | hourly |
| `splunk_sap_logserv_es_anomaly_topology_edge_volume` | Per-edge call volume from KV Store edge bucket data | abs(Z) > 3 + count > 10 | hourly |
| `splunk_sap_logserv_es_anomaly_after_hours_admin` | Per-admin off-hours activity, daily buckets | Z > 2 + count > 5 | daily |

All 4 emit `action.notable=1` (ES Notable Review) and `action.risk=1` (RBA — risk score 30-40 / medium).

## :material-circle-box:{ .taiconcolor } How the stats-based Z-score works

Each search builds the baseline from the **same 30-day window of data** that's being scored, using `eventstats` to compute per-entity mean and standard deviation across the window's hourly (or daily) buckets. The most-recent bucket is then compared:

```spl
| bin _time span=1h
| stats count by entity, _time
| eventstats avg(count) AS avg_count, stdev(count) AS stdev_count by entity
| eval z_score = round((count - avg_count) / stdev_count, 2)
| where _time >= relative_time(now(), "-1h@h") AND z_score > 3 AND count > 10
```

**Combined thresholds** (Z + minimum-floor) keep the false-positive rate low:

- Pure Z-score on a low-volume entity: `count=2, avg=0.1, stdev=0.5` → Z = 3.8, but absolute count is meaningless. The `count > 10` floor filters this.
- Pure absolute count: `count=15, avg=14, stdev=3` → above floor but Z = 0.33, statistically normal. The Z > 3 requirement filters this.
- Both pass → genuinely anomalous: `count=100, avg=12, stdev=4` → Z = 22, count well above floor.

The thresholds are tunable per search via the `where z_score > N` clause in `default/savedsearches.conf` (or by overriding in `local/savedsearches.conf`).

## :material-circle-box:{ .taiconcolor } Per-search detail

### :material-crop-square:{ .taiconcolor } 1. Per-User Authentication Volume Z-Score

Compares each user's most-recent-hour authentication-event count to that user's own 30-day hourly baseline. Fires when Z > 3 AND count > 10.

**Threat model:** Brute-force attempts against a previously dormant account, or a misconfigured client polling at high frequency.

**FP profile:** Low. Healthy environments show 0-2 hits per hour from genuine traffic spikes (batch jobs, planned cutovers). Tag the affected accounts in the Identity feed (`category=service`) if the traffic is legitimate — future events for tagged accounts can be filtered downstream.

### :material-crop-square:{ .taiconcolor } 2. Webdispatcher Response-Time Anomaly

Compares each host's most-recent-hour P95 latency to that host's own 30-day baseline. Fires when Z > 3 AND P95 > 200 ms.

**Threat model:** Backend health degradation, network path issue, or DDoS-style request flood degrading response time.

**FP profile:** Low for production hosts on consistent workloads; can be moderate on hosts with bursty workloads (overnight batches, end-of-month processing). Pre-disable the search during planned heavy-load windows or document expected windows in the FP-tuning guide.

### :material-crop-square:{ .taiconcolor } 3. Topology Edge Call-Volume Anomaly

Reads pre-aggregated edge bucket rows directly from the `logserv_topology_edges` KV Store collection. Detects edges whose most-recent-hour call_count is statistically anomalous vs. that edge's own 30-day baseline. Fires when abs(Z) > 3 AND count > 10.

**Threat model:** Surge = abnormally high cross-system traffic (DDoS, lateral-movement automation, failed retry storm). Drop = integration outage on either the source or target side.

**FP profile:** Low. The KV Store's per-edge time series is much cleaner than raw event data, so the baseline is stable. The bidirectional check (`abs(Z) > 3` rather than just `Z > 3`) catches both surges AND drops.

**Why this search is unique:** It reads from the topology KV Store rather than dispatching live SPL against raw events. Search execution time is sub-second regardless of cluster size.

### :material-crop-square:{ .taiconcolor } 4. After-Hours Admin Activity Anomaly

Per-admin off-hours activity baseline vs. that admin's 30-day off-hours pattern. Lower Z threshold (Z > 2) than the other 3 searches because admin off-hours activity is naturally rare; a smaller deviation is still significant. Fires when Z > 2 AND count > 5.

**Threat model:** Admin-account compromise (attacker active outside the admin's normal window), or insider conducting unauthorized off-hours operations.

**FP profile:** Low for environments with clear business hours. Higher during planned weekend cutovers — those should map to documented change tickets.

## :material-circle-box:{ .taiconcolor } MLTK upgrade path (optional)

If you have the [Splunk Machine Learning Toolkit (MLTK)](https://splunkbase.splunk.com/app/2890){:target="_blank" rel="noopener noreferrer"} installed, you can swap the stats clauses for MLTK's `fit` / `apply` commands for sharper baselines:

| Stats-based clause | MLTK-based replacement |
|---|---|
| `eventstats avg(count) AS avg_count, stdev(count) AS stdev_count by entity` | `\| fit StandardScaler count by entity` (then `apply` against new data) |
| `eval z_score = (count - avg_count) / stdev_count` | The `apply` output's `<entity>_zscore` column |
| `where z_score > 3` | `where <entity>_zscore > 3` |

MLTK adds:

- Per-entity model persistence (the baseline is a saved model, not a per-search calculation)
- Seasonal decomposition (handles weekly / monthly cycles natively)
- DensityFunction / OneClassSVM for non-Gaussian distributions

For most SAP environments the stats-based approach is sufficient. MLTK becomes valuable when you need:

1. Multi-week seasonal patterns (workload that varies by day-of-week or week-of-month)
2. Non-Gaussian distributions (network traffic with heavy-tailed shapes)
3. Per-entity model lifecycle management (training models offline, deploying via export)

To migrate a single search to MLTK without breaking the others, edit `local/savedsearches.conf` with an override stanza for that one search.

## :material-circle-box:{ .taiconcolor } Tuning

Adjust thresholds in `local/savedsearches.conf` (override the `search =` line for a given stanza):

```ini
[splunk_sap_logserv_es_anomaly_user_auth_volume]
search = `sap_logserv_idx_macro` ... | where _time >= relative_time(now(), "-1h@h") AND z_score > 4 AND count > 25 | sort -z_score
```

**General tuning advice:**

- **Too many FPs:** Raise the Z threshold (3 → 4 → 5) AND/OR raise the absolute-count floor.
- **Missing real attacks:** Lower the Z threshold (3 → 2) — but expect more noise; pair with tighter floor.
- **Bursty workloads triggering hits:** Add a `where NOT (entity IN (<known burst entities>))` exclusion clause, OR pre-tag the entity in the Identity feed and filter downstream.
- **Service-account auth volumes drowning out human user signal:** The `is_service_account` field (when populated by the props EVAL pipeline) lets you split the search into two stanzas — one for service accounts (higher floor), one for humans (lower floor + tighter Z).

## :material-circle-box:{ .taiconcolor } AI Assistant integration

Each of the 4 anomaly searches has a corresponding entry in the AI Assistant predefined-prompt catalog under the Security pack:

- `security.anomaly_user_auth_volume`
- `security.anomaly_webdisp_response`
- `security.anomaly_topology_edge_volume`
- `security.anomaly_after_hours_admin`

SOC analysts can ask the AI Assistant to dispatch them on demand for an investigative "explain why this user looks anomalous" workflow.

## :material-circle-box:{ .taiconcolor } See also

- [Correlation Searches & RBA](correlation-searches.md) — Deterministic correlation searches; complement the anomaly detections here
- [Threat Intelligence Integration](threat-intel.md) — Customer-managed CSV lookups for IOC matching
- [Asset & Identity Feed](asset-identity-feed.md) — Identity context that feeds both deterministic + behavioral detections
