# Correlation Searches & RBA

The Splunk for SAP LogServ App ships **18 correlation searches** in three tiers:

- **5 base correlation searches** — the starter pack, signal-heavy and FP-tuned for the SAP-specific threat patterns SOC analysts encounter most.
- **6 extended cross-stack correlation searches** — added in the extended ES content pack. Detect cross-source chains that customers can't easily author themselves because they require SAP-specific knowledge of which sourcetype emits the auth event vs. the privilege change vs. the data event.
- **3 threat-intel correlation searches + 4 behavioral / anomaly searches** — see [Threat Intelligence Integration](threat-intel.md) and [Behavioral & Anomaly Detections](behavioral-detections.md) for those.

Plus **1 tier-2 Risk Notable** that aggregates risk events from all 18 base searches and fires when accumulated risk on a single object crosses a threshold (Risk-Based Alerting / RBA).

All correlation searches are scheduled saved searches in `default/savedsearches.conf` with parallel ES Content Management metadata in `default/correlationsearches.conf`. They appear under **Settings → Content Management** when ES is installed.

## :material-circle-box:{ .taiconcolor } The 5 base correlation searches

| # | Search name | What it detects | Severity | Schedule |
|---|---|---|---|---|
| 1 | `splunk_sap_logserv_es_hana_privilege_escalation` | HANA `GRANT WITH ADMIN OPTION` or any `ALTER USER` on the SYSTEM user | high | hourly |
| 2 | `splunk_sap_logserv_es_cross_stack_auth_failure` | Same user fails authentication on 2+ different SAP stacks (HANA, sapstartsrv, SCC, sudo) within the same window | high | every 15 min |
| 3 | `splunk_sap_logserv_es_abap_gateway_anomalous_peer` | New ABAP gateway peer IP not seen (or seen <5 times) in the prior 30 days | medium | hourly |
| 4 | `splunk_sap_logserv_es_scc_access_denied_burst` | 3+ SCC ACCESS_DENIED events on a single host within 1h | medium | hourly |
| 5 | `splunk_sap_logserv_es_hana_failed_connect_spike` | 5+ failed HANA CONNECT attempts by a single user on a single host within 1h | medium | every 15 min |

### :material-circle-box:{ .taiconcolor } Why "5 starter, well-vetted" instead of 15-20

The starter set is intentionally small + signal-heavy:

- Each search has been dry-run on live data before shipping
- 4 of 5 return 0 rows on healthy-environment data (low FP rate by design — they fire on real attack patterns)
- Easier to false-positive-tune in customer environments
- Easier to document for SOC analysts during onboarding

Customers + community can layer additional ES correlation searches on top — see [the design doc](https://github.com/splunk/splunk-sap-logserv){:target="_blank" rel="noopener noreferrer"} for guidance on adding searches.

### :material-circle-box:{ .taiconcolor } Per-search detail

#### :material-crop-square:{ .taiconcolor } 1. HANA Privilege Escalation

```spl
`sap_logserv_idx_macro` sourcetype="sap:hana:audit" tag=change
  ((action_type=GRANT AND match(sql_statement, "(?i)WITH ADMIN OPTION"))
   OR (action_type="ALTER USER" AND target_user="SYSTEM"))
| stats count, latest(_time) AS last_seen, values(sql_statement) AS sql_statements
        by executing_user, target_user, host, action_type
| sort -count
```

**Threat model:** A SAP HANA admin or compromised account uses `GRANT ... WITH ADMIN OPTION` (creating a privilege-pivot path) or runs `ALTER USER SYSTEM ...` (modifying the SYSTEM superuser). Both warrant change-ticket review.

**FP profile:** Medium. `ALTER USER SYSTEM RESET CONNECT ATTEMPTS` is operationally common after lockout recovery. SOC needs to correlate with change tickets or whitelist routine maintenance.

#### :material-crop-square:{ .taiconcolor } 2. Cross-Stack Authentication Failure Burst

```spl
| datamodel Authentication search
| search Authentication.action="failure" sourcetype IN ("sap:hana:audit","sap:sapstartsrv","sap:scc:audit","linux:sudolog")
| rename Authentication.user AS user
| stats values(sourcetype) AS sourcetypes, dc(sourcetype) AS distinct_sourcetypes,
        count, latest(_time) AS last_seen by user
| where distinct_sourcetypes >= 2
| sort -distinct_sourcetypes -count
```

**Threat model:** Credential stuffing or coordinated brute force. The same compromised credential is tried against multiple SAP stacks. A user appearing in failure events across 2+ sourcetypes within a 15-minute window is the **highest-signal indicator** of this attack pattern.

**FP profile:** Very low. Only fires on actual cross-stack pattern; healthy environments produce 0 rows.

#### :material-crop-square:{ .taiconcolor } 3. ABAP Gateway Anomalous Peer

```spl
`sap_logserv_idx_macro` sourcetype="sap:abap:gateway" peer_ip=*
   earliest=-1h@h latest=now
| stats count by peer_ip host
| join type=outer peer_ip [
    search `sap_logserv_idx_macro` sourcetype="sap:abap:gateway" peer_ip=*
       earliest=-30d@d latest=-1h@h
    | stats count AS historical_count by peer_ip
  ]
| where isnull(historical_count) OR historical_count < 5
| sort -count
```

**Threat model:** A new RFC client appears at the SAP ABAP gateway. Could be a legitimate new integration or an unauthorized scanning attempt. The 30-day baseline + 1-hour detection window catches anything new.

**FP profile:** Low. Will fire on genuine new peers; SOC reviews → either whitelists or blocks.

#### :material-crop-square:{ .taiconcolor } 4. SCC ACCESS_DENIED Burst

```spl
`sap_logserv_idx_macro` sourcetype="sap:scc:audit" scc_audit_type=ACCESS_DENIED
   earliest=-1h@h latest=now
| stats count, latest(_time) AS last_seen, values(scc_account_id) AS account_ids by host
| where count >= 3
| sort -count
```

**Threat model:** SAP Cloud Connector logs ACCESS_DENIED when an inbound tunnel request hits a backend that isn't on the SCC allowlist. 3+ events on a single host in an hour signals either misconfigured allowlist or external probing.

**FP profile:** Low. ACCESS_DENIED events are sparse under normal operations.

#### :material-crop-square:{ .taiconcolor } 5. HANA Failed CONNECT Spike Per User

```spl
`sap_logserv_idx_macro` sourcetype="sap:hana:audit" action_type=CONNECT status=UNSUCCESSFUL
   earliest=-1h@h latest=now
| stats count, latest(_time) AS last_seen, values(client_ip) AS client_ips
        by executing_user host
| where count >= 5
| sort -count
```

**Threat model:** A user repeatedly failing HANA CONNECT (5+ in an hour) — above the noise floor of routine SCC tunnel-credential failures (~1-2/hr).

**FP profile:** Low. 5/hr threshold is above routine failure rates.

## :material-circle-box:{ .taiconcolor } Extended cross-stack pack (v2)

Six additional correlation searches detect cross-source threat chains that customers can't easily author themselves. The patterns require SAP-specific knowledge of which sourcetype emits the authentication event vs. the privilege change vs. the data-tier event — knowledge that's inside the LogServ App rather than in stock Splunk content.

| # | Search name | What it detects | Severity | Schedule |
|---|---|---|---|---|
| 6 | `splunk_sap_logserv_es_lateral_movement` | Same user authenticates successfully into 3+ HANA SIDs within 60s | high | every 15 min |
| 7 | `splunk_sap_logserv_es_privilege_chain` | Same account: auth failure → success → privilege change in 1h | high | hourly |
| 8 | `splunk_sap_logserv_es_after_hours_admin_data_access` | Same user active in HANA audit + webdispatcher access on the same host outside business hours | high | hourly |
| 9 | `splunk_sap_logserv_es_service_account_interactive` | Service account (flagged via `is_service_account`) generated interactive HANA CONNECT | medium | every 15 min |
| 10 | `splunk_sap_logserv_es_hana_user_creation_off_hours` | `CREATE USER` on HANA outside business hours or on weekends | medium | hourly |
| 11 | `splunk_sap_logserv_es_hana_mass_drop` | 5+ DROP statements by a single user on a single host within 10 min | high | every 10 min |

### :material-circle-box:{ .taiconcolor } Per-search detail (extended pack)

#### :material-crop-square:{ .taiconcolor } 6. Lateral Movement

Same user authenticates successfully into 3+ SAP HANA SIDs within a 60-second window. The cross-SID hop pattern is the canonical lateral-movement signal across the SAP estate.

**Threat model:** An attacker with valid credentials probing the estate to find which systems the credential is authorized on. Healthy environments show this only for monitoring service accounts that legitimately poll every SID.

**FP profile:** Low — most environments have monitoring service accounts that legitimately span SIDs; tag those in the Identity feed (`category=service`) so the existing classification can be used to filter the alert downstream.

#### :material-crop-square:{ .taiconcolor } 7. Privilege Chain (Credential Stuffing → Escalation)

Same account on a single HANA host has BOTH authentication failures AND a successful authentication AND a privilege-change event (GRANT, ALTER USER, CREATE USER/ROLE) within a 1-hour window. Highest-priority investigation pattern in the SAP-side ES content.

**Threat model:** Credential stuffing → established access → escalation chain. The textbook compromise pattern.

**FP profile:** Very low. Healthy admin operations look like (success + change), not (failure + success + change).

#### :material-crop-square:{ .taiconcolor } 8. After-Hours Admin Data Access

Same user is active across BOTH HANA audit AND webdispatcher access logs outside business hours, on the same host. Cross-source signal indicating a potential off-hours data-extraction pattern.

**Threat model:** Admin-account compromise → data exfiltration via authenticated session that spans the database and HTTP tiers. Off-hours timing reduces the likelihood of being noticed in real time.

**FP profile:** Low for human admin accounts; moderate for service accounts that legitimately do this. Tag service accounts in the Identity feed to filter.

#### :material-crop-square:{ .taiconcolor } 9. Service-Account Interactive HANA Login

Service accounts (flagged via `is_service_account="true"` in the EVAL output of the props extraction layer) generated interactive HANA CONNECT events. Service accounts should run programmatic workloads, never interactive sessions.

**Threat model:** Either misuse (admin using a service-account credential because it has higher privileges than their own) or compromise (attacker who obtained a service-account credential and is using it interactively from a workstation).

**FP profile:** Very low if the Identity feed accurately classifies service accounts. The `is_service_account` field comes from the props-time EVAL pipeline, so coverage matches whatever username pattern matching is configured there.

#### :material-crop-square:{ .taiconcolor } 10. HANA User Creation Outside Business Hours

`CREATE USER` on HANA outside business hours or on weekends. Should map to a known change ticket; off-window creation often indicates ad-hoc / unauthorized provisioning.

**Threat model:** Insider creating a backdoor account when fewer admins are watching. Less aggressive than mass DROP but still a containment-relevant signal.

**FP profile:** Low for typical environments. Higher during planned cutover weekends — operators expecting weekend CREATE USER activity should pre-disable this search for the maintenance window.

#### :material-crop-square:{ .taiconcolor } 11. HANA Mass DROP/DELETE

5+ DROP statements (TABLE, SCHEMA, VIEW, PROCEDURE, USER, ROLE, INDEX) by a single user on a single host within 10 minutes. Indicates either large-scale schema cleanup (which should map to a change ticket) or destructive insider activity.

**Threat model:** Destructive insider, ransomware-style data destruction, or inadvertent operator error during cleanup.

**FP profile:** Low at this threshold (5 in 10 min is well above routine ad-hoc cleanup activity). Schema migrations for a major release will produce hits — pre-disable the search during planned migration windows or document the mapping in the change ticket.

## :material-circle-box:{ .taiconcolor } RBA — Risk-Based Alerting

Each of the 5 base correlation searches carries `action.risk = 1` annotations so events also feed ES's Risk Framework.

### :material-circle-box:{ .taiconcolor } Per-search risk table

| Search | risk_object_field | risk_object_type | risk_score |
|---|---|---|---|
| HANA privilege escalation | `executing_user`, `target_user`, `host` | user, user, system | 80, 40, 30 |
| Cross-stack auth failure | `user` | user | 60 (per-event accumulating) |
| ABAP gateway anomalous peer | `peer_ip`, `host` | other, system | 40, 20 |
| SCC ACCESS_DENIED burst | `host` | system | 50 |
| HANA failed CONNECT spike | `executing_user`, `host` | user, system | 50, 30 |
| Lateral movement | `auth_user` | user | 70 |
| Privilege chain | `auth_user`, `host` | user, system | 80, 40 |
| After-hours admin data access | `auth_user`, `host` | user, system | 70, 30 |
| Service account interactive | `executing_user` | user | 60 |
| HANA user creation off-hours | `executing_user` | user | 50 |
| HANA mass DROP | `executing_user`, `host` | user, system | 70, 50 |
| TI: DNS to malicious domain | `src_ips` | system | 80 |
| TI: proxy to malicious IP | `src_ips` | system | 70 |
| TI: compromised credential use | `auth_user` | user | 90 |
| Anomaly: user auth volume | `auth_user` | user | 30 |
| Anomaly: webdispatcher response | `host` | system | 30 |
| Anomaly: topology edge volume | `source` | system | 30 |
| Anomaly: after-hours admin | `auth_user` | user | 40 |

### :material-circle-box:{ .taiconcolor } Multi-object risk per event

Where a single notable affects multiple objects (operator + target + host for privilege escalation), the score is split across all three so each accrues risk simultaneously. Example:

```ini
action.risk.param._risk = [
  {"risk_object_field":"executing_user","risk_object_type":"user","risk_score":80},
  {"risk_object_field":"target_user","risk_object_type":"user","risk_score":40},
  {"risk_object_field":"host","risk_object_type":"system","risk_score":30}
]
```

ES Risk Framework correctly aggregates across the three when consumed by tier-2 RBA searches.

## :material-circle-box:{ .taiconcolor } Tier-2 Risk Notable

The App also ships `splunk_sap_logserv_es_risk_notable_threshold` — a higher-tier correlation search that aggregates risk events from the 5 base searches and creates a critical-severity Notable when a single risk_object accumulates ≥ 100 risk_score in 24h.

```spl
| from datamodel:Risk.All_Risk
| search source IN (
    "splunk_sap_logserv_es_hana_privilege_escalation",
    "splunk_sap_logserv_es_cross_stack_auth_failure",
    "splunk_sap_logserv_es_abap_gateway_anomalous_peer",
    "splunk_sap_logserv_es_scc_access_denied_burst",
    "splunk_sap_logserv_es_hana_failed_connect_spike")
| stats sum(All_Risk.risk_score) AS total_risk
        values(All_Risk.risk_object_type) AS risk_object_type
        values(source) AS source_searches
        dc(source) AS distinct_searches
        latest(_time) AS last_event by All_Risk.risk_object
| rename All_Risk.risk_object AS risk_object
| where total_risk >= 100
```

**Why threshold 100?** It's the conservative starter:
- Two cross-stack-auth-failure events for the same user (60 + 60 = 120) → fires
- One privilege-escalation event distributes 80/40/30 across three objects — none alone exceeds 100, but a second event compounds
- Operations with high event volume can lower the threshold to 60; low-volume environments raise to 200. Customer-tunable.

**ES dependency:** the Risk Notable reads from `Risk.All_Risk` data model. Without ES, the Risk data model isn't accelerated and the search returns 0 rows silently — perfect dual-mode behavior.

## :material-circle-box:{ .taiconcolor } How notables appear in ES Incident Review

When a base correlation search fires:

1. **Notable created** with the search's `rule_title` template substituted with row field values
   - Example: "HANA Privilege Escalation: ALTER USER by xcnadm on SYSTEM"
2. **Severity badge** matches `action.notable.param.severity` (high / medium)
3. **Security domain** badge: `identity` / `access` / `network` / `threat`
4. **Grouping** by `nes_fields` — ES groups similar notables (same operator + target + host) into one row in Incident Review

When the tier-2 Risk Notable fires:

1. **Critical-severity notable** with title like "High accumulated risk: xcnadm (160) across 3 SAP correlation searches"
2. **Security domain** = `threat`
3. **Grouping** by `risk_object` — one notable per high-risk object

## :material-circle-box:{ .taiconcolor } Customer tuning

Override severity, schedule, or risk scores in `local/savedsearches.conf` (do not edit `default/`). For example, to raise the Risk Notable threshold to 150:

```ini
[splunk_sap_logserv_es_risk_notable_threshold]
search = | from datamodel:Risk.All_Risk | search source IN (...) | stats sum(All_Risk.risk_score) AS total_risk ... by All_Risk.risk_object | rename All_Risk.risk_object AS risk_object | where total_risk >= 150
```

Restart Splunk or reload saved searches via REST after editing.

## :material-circle-box:{ .taiconcolor } Disabling individual correlation searches

Customers who don't want a particular search firing can disable it without uninstalling the App:

1. Settings → Searches, reports, and alerts
2. Filter by `splunk_sap_logserv_es_*`
3. Click the search → Edit → Disable
4. Save

The disabled search stops scheduling but remains in the App for re-enable later.

## :material-circle-box:{ .taiconcolor } See also

- [CIM Compliance](cim-compliance.md) — How the underlying tagging works
- [Asset & Identity Feed](asset-identity-feed.md) — How asset context enriches notable events
- [Threat Intelligence Integration](threat-intel.md) — The 3 customer-managed CSV lookups + 3 TI-driven correlation searches
- [Behavioral & Anomaly Detections](behavioral-detections.md) — The 4 statistically-baselined anomaly searches with optional MLTK upgrade path
