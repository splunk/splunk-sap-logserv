# Enterprise Security Integration — Overview

The Splunk for SAP LogServ App ships out-of-the-box integration with **Splunk Enterprise Security (ES)** so SOC analysts can investigate SAP-side threats through ES's standard Incident Review queue, Risk-Based Alerting (RBA) framework, and CIM-aligned correlation searches.

Integration is **dual-mode** — the same App tarball works whether or not ES is installed:

- **With ES installed**: 18 correlation searches emit Notable Events to ES Incident Review; one tier-2 Risk Notable fires when accumulated risk on a single object crosses a threshold; SAP-side Asset & Identity inventory feeds ES's Identity Management framework for asset-context enrichment.
- **Without ES**: the same saved searches still load, dispatch on schedule, and are alertable via standard Splunk workflow. The `action.notable=1` directive silently no-ops; ES-specific Risk Notable returns 0 rows; Asset/Identity feed CSVs still populate but the ES merger framework isn't there to consume them.

## :material-circle-box:{ .taiconcolor } What ships for ES integration

| Capability | Count / Surface | Source |
|---|---|---|
| **CIM data-model tagging** | `Authentication`, `Change`, `Network_Sessions`, `Web` | [CIM Compliance](cim-compliance.md) |
| **Base correlation searches** | 5 (high-confidence SAP threat patterns) | [Correlation Searches](correlation-searches.md#the-5-base-correlation-searches) |
| **Extended cross-stack correlation searches** | 6 (lateral movement, privilege chain, after-hours data access, service-account interactive, HANA user creation off-hours, HANA mass DROP) | [Correlation Searches → Extended cross-stack pack](correlation-searches.md#extended-cross-stack-pack-v2) |
| **Threat-intel correlation searches** | 3 (DNS to malicious domain, proxy to malicious IP, compromised credential use) — joins against 3 customer-managed CSV lookups (ship empty) | [Threat Intelligence Integration](threat-intel.md) |
| **Behavioral / anomaly detections** | 4 stats-based Z-score (per-user auth volume, per-host webdispatcher response time, per-edge topology call volume, per-admin off-hours activity); no MLTK dependency | [Behavioral & Anomaly Detections](behavioral-detections.md) |
| **Tier-2 Risk Notable** | Critical-severity notable when accumulated risk on a single object ≥ 100 in 24h (aggregates risk from all 18 base + extended searches) | [Correlation Searches](correlation-searches.md#tier-2-risk-notable) |
| **Asset Inventory feed** | `splunk_for_sap_logserv_assets.csv` | [Asset & Identity Feed](asset-identity-feed.md) |
| **Identity Inventory feed** | `splunk_for_sap_logserv_identities.csv` | [Asset & Identity Feed](asset-identity-feed.md) |

**Total: 18 correlation searches + 1 Risk Notable + 2 inventory feeds.** All 18 base searches are also AI-Assistant-dispatchable on demand via the predefined-prompt browser (Security pack).

## :material-circle-box:{ .taiconcolor } Splunk dependency

The App declares a hard dependency on `Splunk_SA_CIM ≥ 5.0.0` in its `app.manifest`. Splunk_SA_CIM is the standard Splunk CIM data-model definitions; it ships with ES but can also be installed standalone (free on Splunkbase).

The App does **NOT** declare a hard dep on `SplunkEnterpriseSecuritySuite` — this is intentional, so customers running the App without ES still get full functionality. ES-specific content (notable events, risk events, the Risk data-model search) silently no-ops without ES. Customers who later install ES gain the ES-specific surfaces immediately, with no App reconfiguration needed.

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
| Correlation-search schedules | hourly + every 15 min | Settings → Searches, reports, and alerts |
| Notable severity per search | high / medium | `default/savedsearches.conf` (override in `local/`) |
| Risk scores per event | 80 / 60 / 50 / 40 (varies per search) | `default/savedsearches.conf` `action.risk.param._risk` JSON |
| Risk Notable threshold | `total_risk >= 100` in 24h | The `splunk_sap_logserv_es_risk_notable_threshold` saved search's `\| where ...` clause |
| Asset/Identity feed cadence | every 4h | Cron on the `_asset_feed` / `_identity_feed` saved searches |

All of these are editable in `local/savedsearches.conf` — do not edit `default/`.

## :material-circle-box:{ .taiconcolor } Pages in this section

- **[CIM Compliance](cim-compliance.md)** — How SAP-side events get tagged into Splunk's standard CIM data models so ES correlation searches can consume them.
- **[Correlation Searches](correlation-searches.md)** — The 5 base + 6 extended cross-stack correlation searches, the tier-2 Risk Notable, and the RBA risk-scoring scheme.
- **[Asset & Identity Feed](asset-identity-feed.md)** — How the App auto-populates ES's Identity Management framework with SAP system inventory + user identities.
- **[Threat Intelligence Integration](threat-intel.md)** — The 3 customer-managed CSV lookups + the 3 TI-driven correlation searches that join against them. Customer populates the lookups from their own threat-intel feed.
- **[Behavioral & Anomaly Detections](behavioral-detections.md)** — The 4 stats-based Z-score anomaly detections that complement the deterministic correlation searches by surfacing entities deviating from their own historical patterns. Optional MLTK upgrade path documented.
