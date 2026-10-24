# Enterprise Security Integration — Overview

The LogServ App ships content for **Splunk Enterprise Security (ES)**, so SOC analysts can investigate SAP-side threats through ES's Incident Review queue, Risk-Based Alerting (RBA) and CIM-aligned correlation searches. Use this page to check the prerequisites, set the content up in order, and turn it off on search heads that do not run ES.

!!! warning "The ES content ships enabled, with or without ES"
    All 22 `splunk_sap_logserv_es_*` saved searches ship with `disabled = 0` and a schedule, so they run on every search head that runs the App. Without ES they do no useful work, and they are not silent: the `notable` and `risk` alert actions do not exist there, so Splunk logs errors in `_internal` (from `sendmodalert` and `SearchScheduler`) saying that these alert actions were not found, and, because there is no Risk data model, the scheduler skips the Risk Notable with the reason "Data model 'Risk' was not found". **On a search head without ES, we recommend turning the ES content off**: see [Disabling or tuning the ES content](#disabling-or-tuning-the-es-content). No dashboard, rollup or AI Assistant prompt reads the results of the scheduled runs.

With ES installed, the 19 detection searches raise notable events in Incident Review and risk events for RBA; one tier-2 Risk Notable fires when accumulated risk on a single object crosses a threshold; and two feeds supply SAP systems and user identities to ES asset and identity management.

## :material-circle-box:{ .taiconcolor } Prerequisites

- **Splunk Enterprise Security on the search head that runs the App.** Notables, risk events and ES asset and identity management exist only where ES runs, so the App must be installed on the ES search head.
- **If ES runs on a search head of its own.** ES can run on a different search head from the one your users open for other apps. On Splunk Cloud Platform in particular, check which search head of your stack runs ES. Install the LogServ App on the ES search head as well, the same way as on the main one ([Install the App and Seed the Dashboards](../logserv-app/installation.md)); the App's dashboards and rollup searches then run there too. On a search head that runs the App without ES, turn the ES content off ([Disabling or tuning the ES content](#disabling-or-tuning-the-es-content)).
- **The Splunk Common Information Model add-on (`Splunk_SA_CIM`) 5.0.0 or later.** It is the only dependency the App declares in its `app.manifest`. Check that it is installed on the ES search head; if it is not, install it (where to get it: [LogServ App Prerequisites](../logserv-app/prerequisites.md#required-splunk-add-ons-search-head)). The App does not declare a dependency on ES (`SplunkEnterpriseSecuritySuite`), so it installs and works without ES. If you add ES later, turn back on any ES searches you turned off; nothing else in the App changes.
- **The CIM data models must search the LogServ index.** On the CIM add-on's setup page, add `sap_logserv_logs` (or the index your `sap_logserv_idx_macro` points at) to the index lists of Authentication, Change, Network_Sessions, Network_Resolution and Web. Add it even where a list is empty: the App does not make `sap_logserv_logs` an index that any role searches by default, so do not rely on an empty list to include it. The App's cross-stack authentication-failure search reads the Authentication data model, and ES's own correlation searches read these data models. [Verifying the integration is live](#verifying-the-integration-is-live) shows whether SAP events reach the models.

#### :material-crop-square:{ .taiconcolor } Where the ES content runs { #install-matrix }

The ES content is search-time and scheduled content inside the LogServ App: nothing is installed or changed on the forwarders or indexers for it. Where the App goes in each topology: [Where Each Package Goes](../getting-started/package-placement.md#package-matrix). In a search head cluster, the App (and with it the ES content) is deployed through the SHC deployer, as usual.

## :material-circle-box:{ .taiconcolor } Setup checklist

1. Check the [prerequisites](#prerequisites) on the search head that runs ES.
2. Install the LogServ App there and let SAP data arrive ([Install the App and Seed the Dashboards](../logserv-app/installation.md)).
3. Check that SAP events reach the CIM data models: [Verifying the integration is live](#verifying-the-integration-is-live).
4. Load the asset and identity feeds and add them to ES: [Customer wire-up](asset-identity-feed.md#customer-wire-up).
5. Optional: fill the three threat-intel lookups from your own threat-intel feed ([Populating the lookups](threat-intel.md#populating-the-lookups)). Until you do, the three threat-intel searches find nothing.
6. Review the severities, risk scores, schedules and the Risk Notable threshold: [Customer-tunable surfaces](#customer-tunable-surfaces).
7. Confirm that notables reach Incident Review: [How notables appear in ES Incident Review](correlation-searches.md#how-notables-appear-in-es-incident-review).
8. On every other search head that runs the App without ES, turn the ES content off: [Disabling or tuning the ES content](#disabling-or-tuning-the-es-content).

## :material-circle-box:{ .taiconcolor } Disabling or tuning the ES content { #disabling-or-tuning-the-es-content }

On a search head without ES, the scheduled ES searches use search capacity and add errors to `_internal`, and nothing reads their results. Turn them off there. On a search head with ES, use the same steps for any single search you do not want.

!!! warning "13 of these searches also run AI Assistant prompts"
    The AI Assistant's Security pack runs 13 of these saved searches on demand: the 6 extended cross-stack searches, the 3 threat-intel searches and the 4 behavioral-anomaly searches. A disabled saved search cannot run, so its prompt then returns an error. If you use those prompts, turn off only the schedule of those 13 (option B below) and disable the other 9 (option A).

The 9 searches that no prompt uses are the 6 base correlation searches (`splunk_sap_logserv_es_hana_privilege_escalation`, `_cross_stack_auth_failure`, `_abap_gateway_anomalous_peer`, `_scc_access_denied_burst`, `_hana_failed_connect_spike`, `_oom_kill_burst`), the Risk Notable (`_risk_notable_threshold`) and the 2 feeds (`_asset_feed`, `_identity_feed`).

**Option A: disable a search** (Splunk Web; Splunk Cloud and Splunk Enterprise):

1. Go to **Settings → Searches, reports, and alerts**.
2. Set **App** to *Splunk App for SAP LogServ* and filter the names on `splunk_sap_logserv_es_`.
3. For each search, choose **Edit → Disable**.

A disabled search stays in the App, and **Edit → Enable** turns it back on.

**Option B: keep a search runnable, but stop its schedule** (Splunk Web; Splunk Cloud and Splunk Enterprise):

1. Go to **Settings → Searches, reports, and alerts** and find the search as above.
2. Choose **Edit → Advanced edit**, set `is_scheduled` to off, and save.

**Splunk Enterprise only: a config override.** Instead of the Splunk Web steps, add one stanza per search to `$SPLUNK_HOME/etc/apps/splunk_app_sap_logserv/local/savedsearches.conf` (never edit `default/`), then restart Splunk:

```ini
# Option A: disable the search
[splunk_sap_logserv_es_hana_privilege_escalation]
disabled = 1

# Option B: keep the search runnable on demand, without a schedule
[splunk_sap_logserv_es_lateral_movement]
enableSched = 0
# ... one stanza per splunk_sap_logserv_es_* search
```

There are 22 ES searches: 19 detections, the Risk Notable and the 2 feeds. To keep some on a search head with ES, but cut the load, start with the anomaly searches below.

!!! info "The cost of the anomaly searches"
    Two of the four behavioral-anomaly searches scan **30 days of raw events** on each run: `splunk_sap_logserv_es_anomaly_user_auth_volume` (HANA audit and sapstartsrv authentication events) and `splunk_sap_logserv_es_anomaly_after_hours_admin` (HANA audit). They read the index directly, not a data model, so data model acceleration does not make them cheaper; they run once a day for that reason. The other two read the App's own hourly KV Store rollups (`logserv_web_timing_rollup`, `logserv_topology_edges`), so their cost depends on the number of hosts and edges, not on event volume. See [Behavioral & Anomaly Detections](behavioral-detections.md).

## :material-circle-box:{ .taiconcolor } The ES schedule (collision-free)

All `splunk_sap_logserv_es_*` scheduled searches ship **enabled** on staggered crons, which run in the search head's local time. They sit in minutes that the App's other scheduled searches leave free, so no two of the App's enabled scheduled searches share an `(hour, minute)`. The other bands are the hourly rollup aggregates and the Data Doctor's platform snapshot (`:02`–`:28` every hour), the nightly retention and maintenance (`00:30`–`00:58`, `01:30`–`01:58` and `02:32`–`02:36`), and the daily late-arrival check at `05:40`. The full schedule is in [Dashboard Data → Scheduled-search schedule](../logserv-app/dashboard-data.md#scheduled-search-schedule).

- The **hourly searches** (the 15 hourly correlation searches and the Risk Notable) run at `:29` and the odd minutes `:31`–`:59`.
- **2 Asset/Identity feeds** run every 4 hours at `:00` / `:01`.
- **4 behavioral-anomaly searches** run **daily** at `:30` (hours 02–05), so the two heavy 30-day scans run once a day, not every hour. Each daily run evaluates every time bucket since the start of the previous day, so no bucket is skipped.

## :material-circle-box:{ .taiconcolor } What ships for ES integration

| Capability | Count / Surface | Source |
|---|---|---|
| **CIM data-model tagging** | `Authentication`, `Change`, `Network_Sessions`, `Web`, and `Network_Resolution` for DNS | [CIM Compliance](cim-compliance.md) |
| **Base correlation searches** | 6 (high-confidence SAP threat patterns) | [Correlation Searches](correlation-searches.md#the-6-base-correlation-searches) |
| **Extended cross-stack correlation searches** | 6 (lateral movement, privilege chain, after-hours admin activity, service-account interactive, HANA user creation off-hours, HANA mass DROP) | [Correlation Searches → Extended cross-stack pack](correlation-searches.md#extended-cross-stack-pack-v2) |
| **Threat-intel correlation searches** | 3 (DNS to malicious domain, proxy to malicious IP, compromised credential use) — joins against 3 customer-managed CSV lookups (ship empty) | [Threat Intelligence Integration](threat-intel.md) |
| **Behavioral / anomaly detections** | 4 stats-based Z-score (per-user auth volume, per-host webdispatcher response time, per-edge topology call volume, per-admin off-hours activity); no MLTK dependency | [Behavioral & Anomaly Detections](behavioral-detections.md) |
| **Tier-2 Risk Notable** | Critical-severity notable when accumulated risk on a single object ≥ 100 in 24h (aggregates risk from all 19 detection searches — base, extended, threat-intel, and anomaly) | [Correlation Searches](correlation-searches.md#tier-2-risk-notable) |
| **Asset Inventory feed** | `splunk_for_sap_logserv_assets.csv` | [Asset & Identity Feed](asset-identity-feed.md) |
| **Identity Inventory feed** | `splunk_for_sap_logserv_identities.csv` | [Asset & Identity Feed](asset-identity-feed.md) |

**Total: 19 detection correlation searches + 1 Risk Notable + 2 Asset/Identity feeds.** The extended cross-stack, threat-intel, and behavioral searches can also be run on demand from the AI Assistant's predefined-prompt browser (Security pack), once an admin has turned the AI Assistant on ([Set Up the AI Assistant](../ai-assistant/enable.md)); the base correlation searches run on their schedule only.

## :material-circle-box:{ .taiconcolor } Verifying the integration is live

Once SAP data arrives and the data models cover the LogServ index (see [Prerequisites](#prerequisites)), SAP events appear in the CIM data models without further setup. Verify with:

```spl
| datamodel Authentication search
| search sourcetype IN ("sap:hana:audit","sap:sapstartsrv","sap:scc:audit","linux:sudolog")
| stats count by sourcetype Authentication.action
```

You should see rows for each populated SAP authentication source, with `Authentication.action` as `success` / `failure`.

Same pattern for `Change`, `Web`, `Network_Sessions` — see [CIM Compliance](cim-compliance.md) for full details.

## :material-circle-box:{ .taiconcolor } Customer-tunable surfaces

| Knob | Default | Where (Advanced edit attribute) |
|---|---|---|
| Correlation-search schedules | hourly (correlations) / daily (anomalies) / every 4h (feeds) | `cron_schedule` |
| Notable severity per search | critical / high / medium | `action.notable.param.severity` |
| Risk scores per result | 20–90 (varies per search and per risk object) | `action.risk.param._risk` (JSON) |
| Risk Notable threshold | `total_risk >= 100` in 24h | `search` of `splunk_sap_logserv_es_risk_notable_threshold`: the `\| where total_risk >= 100` clause |
| Asset/Identity feed cadence | every 4h | `cron_schedule` of `splunk_sap_logserv_es_asset_feed` / `_identity_feed` |

Change these in Splunk Web, which works on Splunk Cloud and Splunk Enterprise alike: **Settings → Searches, reports, and alerts**, find the search, then **Edit → Advanced edit**. On Splunk Enterprise you can instead override the same attributes in `local/savedsearches.conf`; never edit `default/`. A new cron in a minute another App search already uses gives up the collision-free schedule above.

The time windows of the 15 hourly correlation searches are set for an hourly cron. Eleven use a 60-minute window that ends 5 minutes before the run (`dispatch.earliest_time = -65m@m`, `dispatch.latest_time = -5m@m`), so their hourly runs follow on from each other without overlap. Four (the ABAP gateway peer, SCC ACCESS_DENIED, HANA failed-CONNECT and OOM-killer searches) set `earliest=-1h@h latest=now` in the search text, which takes the place of the dispatch window: each run searches from the start of the previous hour up to the run. If you change the cron of one of these searches, change its window to match: the `dispatch.earliest_time` / `dispatch.latest_time` attributes, or the `earliest=` / `latest=` in the search text where the search sets them. Run more often with the same window, a search reports the same events again (repeat notables, and risk counted again); run less often, it leaves events between its windows unsearched.

## :material-circle-box:{ .taiconcolor } Pages in this section

- **[CIM Compliance](cim-compliance.md)** — How SAP-side events get tagged into Splunk's standard CIM data models so ES correlation searches can consume them.
- **[Correlation Searches](correlation-searches.md)** — The 6 base + 6 extended cross-stack correlation searches, the tier-2 Risk Notable, and the RBA risk-scoring scheme.
- **[Asset & Identity Feed](asset-identity-feed.md)** — How the App feeds ES asset and identity management with SAP system inventory + user identities.
- **[Threat Intelligence Integration](threat-intel.md)** — The 3 customer-managed CSV lookups + the 3 TI-driven correlation searches that join against them. Customer populates the lookups from their own threat-intel feed.
- **[Behavioral & Anomaly Detections](behavioral-detections.md)** — The 4 stats-based Z-score anomaly detections that complement the deterministic correlation searches by surfacing entities deviating from their own historical patterns. Optional MLTK upgrade path documented.
