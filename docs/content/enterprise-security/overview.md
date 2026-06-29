# Enterprise Security Integration — Overview

The Splunk for SAP LogServ App ships out-of-the-box integration with **Splunk Enterprise Security (ES)** so SOC analysts can investigate SAP-side threats through ES's standard Incident Review queue, Risk-Based Alerting (RBA) framework, and CIM-aligned correlation searches.

!!! info "The ES content ships ENABLED by default (as of v0.0.6 build 249) on a collision-free schedule"
    All 22 `splunk_sap_logserv_es_*` saved searches ship with `disabled = 0`, re-staggered so no two scheduled searches share an `(hour, minute)`. The ES content is **dual-mode**: when Splunk Enterprise Security isn't installed, the `action.notable` / `action.risk` directives silently no-op — the searches still run, their results stay searchable, and they power the AI Assistant Security-pack prompts. **No dashboard depends on any ES output.** If you don't run ES and would rather not incur the scheduled load, see [Disabling or tuning the ES content](#disabling-or-tuning-the-es-content) below.

Integration is **dual-mode** — the same App tarball works whether or not ES is installed:

- **With ES installed**: the 19 correlation searches emit Notable Events to ES Incident Review; one tier-2 Risk Notable fires when accumulated risk on a single object crosses a threshold; SAP-side Asset & Identity inventory feeds ES's Identity Management framework for asset-context enrichment.
- **Without ES**: the ES searches still run on their schedule, but their ES actions no-op — the `action.notable=1` directive silently does nothing, the ES-specific Risk Notable returns 0 rows, and there's no ES merger framework to consume the Asset/Identity CSVs. Their search results remain searchable and power the AI Assistant Security-pack prompts. The rest of the App (dashboards, AI Assistant, topology) is unaffected — none of it reads ES output.

## :material-circle-box:{ .taiconcolor } What ships for ES integration

| Capability | Count / Surface | Source |
|---|---|---|
| **CIM data-model tagging** | `Authentication`, `Change`, `Network_Sessions`, `Web` | [CIM Compliance](cim-compliance.md) |
| **Base correlation searches** | 6 (high-confidence SAP threat patterns) | [Correlation Searches](correlation-searches.md#the-6-base-correlation-searches) |
| **Extended cross-stack correlation searches** | 6 (lateral movement, privilege chain, after-hours data access, service-account interactive, HANA user creation off-hours, HANA mass DROP) | [Correlation Searches → Extended cross-stack pack](correlation-searches.md#extended-cross-stack-pack-v2) |
| **Threat-intel correlation searches** | 3 (DNS to malicious domain, proxy to malicious IP, compromised credential use) — joins against 3 customer-managed CSV lookups (ship empty) | [Threat Intelligence Integration](threat-intel.md) |
| **Behavioral / anomaly detections** | 4 stats-based Z-score (per-user auth volume, per-host webdispatcher response time, per-edge topology call volume, per-admin off-hours activity); no MLTK dependency | [Behavioral & Anomaly Detections](behavioral-detections.md) |
| **Tier-2 Risk Notable** | Critical-severity notable when accumulated risk on a single object ≥ 100 in 24h (aggregates risk from all 19 base + extended searches) | [Correlation Searches](correlation-searches.md#tier-2-risk-notable) |
| **Asset Inventory feed** | `splunk_for_sap_logserv_assets.csv` | [Asset & Identity Feed](asset-identity-feed.md) |
| **Identity Inventory feed** | `splunk_for_sap_logserv_identities.csv` | [Asset & Identity Feed](asset-identity-feed.md) |

**Total: 19 detection correlation searches + 1 Risk Notable + 2 Asset/Identity feeds.** All 19 detection searches are also AI-Assistant-dispatchable on demand via the predefined-prompt browser (Security pack).

## :material-circle-box:{ .taiconcolor } Splunk dependency

The App declares a hard dependency on `Splunk_SA_CIM ≥ 5.0.0` in its `app.manifest`. Splunk_SA_CIM is the standard Splunk CIM data-model definitions; it ships with ES but can also be installed standalone (free on Splunkbase).

The App does **NOT** declare a hard dep on `SplunkEnterpriseSecuritySuite` — this is intentional, so customers running the App without ES still get full functionality. ES-specific content (notable events, risk events, the Risk data-model search) silently no-ops without ES. Customers who later install ES gain the ES-specific surfaces immediately, with no App reconfiguration needed.

## :material-circle-box:{ .taiconcolor } The ES schedule (collision-free)

The 22 ES searches ship **enabled** on a staggered schedule that is collision-free with the dashboard rollup-aggregate band (`:03`–`:28` every hour) and the daily retention band (`:30`–`:58`, hours 00–01) — no two enabled scheduled searches share an `(hour, minute)`:

- **16 correlation searches** run **hourly** at `:29` and the odd minutes `:31`–`:59`.
- **2 Asset/Identity feeds** run every 4 hours at `:00` / `:01`.
- **4 behavioral-anomaly searches** run **daily** at `:02` (hours 02–05), so the two heavy 30-day scans no longer run every hour.

!!! note "Cadence vs. the original design"
    To fit the collision-free schedule, the eight correlation searches that previously ran every 5–15 minutes now run **hourly** (with matched 65-minute dispatch windows), and the four behavioral-anomaly searches run **daily** instead of hourly. A daily anomaly run still evaluates every hourly bucket of the previous day, so no detections are missed — only the reporting cadence changes. If you have the search capacity and want lower detection latency, raise any search's cadence in `local/savedsearches.conf`.

### Disabling or tuning the ES content

If you don't run Splunk Enterprise Security and would rather not incur the scheduled load, disable the ES searches by either method — never edit `default/`:

**Splunk Web (per search or in bulk):**

1. **Settings → Searches, Reports, and Alerts**.
2. Set the **App** context to *Splunk for SAP LogServ* and filter the name on `splunk_sap_logserv_es_`.
3. For each search (or select all), use the **Edit → Disable** action.

**Config override (all at once):** add a stanza per search to `local/savedsearches.conf`:

```ini
[splunk_sap_logserv_es_anomaly_webdisp_response]
disabled = 1

[splunk_sap_logserv_es_anomaly_user_auth_volume]
disabled = 1
# ... one stanza per splunk_sap_logserv_es_* search you want disabled
```

There are 22 ES searches (19 detections + the Risk Notable + the 2 Asset/Identity feeds). Disable all of them, or just the heaviest few (the three 30-day anomaly scans above are the most expensive).

!!! info "CIM acceleration for the heavy anomaly searches"
    Three behavioral-anomaly searches scan a **30-day** window (`splunk_sap_logserv_es_anomaly_webdisp_response`, `_anomaly_user_auth_volume`, `_anomaly_topology_edge_volume`). On a large environment these should run against **CIM-accelerated** data models (the standard ES design). If you leave the CIM models un-accelerated, those searches become 30-day full scans — acceptable at small/medium volume, but accelerate the Web / Authentication models for high volume. See [CIM Compliance](cim-compliance.md). As of v0.0.6 these run once daily rather than hourly, which already cuts their load substantially.

!!! note "The schedule is collision-free"
    The always-on rollup-aggregate searches occupy minutes `:03`–`:28` of each hour and retention runs `:30`–`:58` (hours 00–01); the ES content is scheduled entirely in the disjoint minutes (`:00`–`:02`, `:29`, and the odd minutes `:31`–`:59`), so no two enabled scheduled searches collide. See [Dashboard Performance & Data Freshness → Scheduled-search schedule](../logserv-app/dashboards/performance.md#scheduled-search-schedule).

## :material-circle-box:{ .taiconcolor } Install matrix

The ES integration sits entirely on the **search head** tier — no changes to the Data TA / forwarder tier are needed.

| Topology | UI App location | ES integration applies |
|---|---|---|
| Single instance | Same instance | Yes |
| DS + HFs + on-prem SH | SH | Yes |
| DS + HFs + Splunk Cloud | Splunk Cloud SH | Yes (when ES is installed on Cloud SH) |

If the customer's SH is in a search-head cluster, the App + ES integration deploy via the SHC deployer per Splunk's standard process.

## :material-circle-box:{ .taiconcolor } Verifying the integration is live

After the App installs (with `Splunk_SA_CIM` satisfied), the four CIM data models pick up SAP-side events automatically. Verify with:

```spl
| datamodel Authentication search
| search sourcetype IN ("sap:hana:audit","sap:sapstartsrv","sap:scc:audit","linux:sudolog")
| stats count by sourcetype Authentication.action
```

You should see rows for each populated SAP authentication source, with `Authentication.action` as `success` / `failure`.

Same pattern for `Change`, `Web`, `Network_Sessions` — see [CIM Compliance](cim-compliance.md) for full details.

## :material-circle-box:{ .taiconcolor } Customer-tunable surfaces

| Knob | Default | Where |
|---|---|---|
| Correlation-search schedules | hourly (correlations) / daily (anomalies) / every 4h (feeds) | Settings → Searches, reports, and alerts |
| Notable severity per search | high / medium | `default/savedsearches.conf` (override in `local/`) |
| Risk scores per event | 80 / 60 / 50 / 40 (varies per search) | `default/savedsearches.conf` `action.risk.param._risk` JSON |
| Risk Notable threshold | `total_risk >= 100` in 24h | The `splunk_sap_logserv_es_risk_notable_threshold` saved search's `\| where ...` clause |
| Asset/Identity feed cadence | every 4h | Cron on the `_asset_feed` / `_identity_feed` saved searches |

All of these are editable in `local/savedsearches.conf` — do not edit `default/`.

## :material-circle-box:{ .taiconcolor } Pages in this section

- **[CIM Compliance](cim-compliance.md)** — How SAP-side events get tagged into Splunk's standard CIM data models so ES correlation searches can consume them.
- **[Correlation Searches](correlation-searches.md)** — The 6 base + 6 extended cross-stack correlation searches, the tier-2 Risk Notable, and the RBA risk-scoring scheme.
- **[Asset & Identity Feed](asset-identity-feed.md)** — How the App auto-populates ES's Identity Management framework with SAP system inventory + user identities.
- **[Threat Intelligence Integration](threat-intel.md)** — The 3 customer-managed CSV lookups + the 3 TI-driven correlation searches that join against them. Customer populates the lookups from their own threat-intel feed.
- **[Behavioral & Anomaly Detections](behavioral-detections.md)** — The 4 stats-based Z-score anomaly detections that complement the deterministic correlation searches by surfacing entities deviating from their own historical patterns. Optional MLTK upgrade path documented.
