# Correlation Searches & RBA

The Splunk for SAP LogServ App ships **19 correlation searches** in three tiers:

- **6 base correlation searches** — the starter pack, signal-heavy and FP-tuned for the SAP-specific threat patterns SOC analysts encounter most.
- **6 extended cross-stack correlation searches** — added in the extended ES content pack. Detect cross-source chains that customers can't easily author themselves because they require SAP-specific knowledge of which sourcetype emits the auth event vs. the privilege change vs. the data event.
- **3 threat-intel correlation searches + 4 behavioral / anomaly searches** — see [Threat Intelligence Integration](threat-intel.md) and [Behavioral & Anomaly Detections](behavioral-detections.md) for those.

Plus **1 tier-2 Risk Notable** that aggregates risk events from all 19 detection searches and fires when accumulated risk on a single object crosses a threshold (Risk-Based Alerting / RBA).

All correlation searches are scheduled saved searches in `default/savedsearches.conf`. For ES Content Management, the App also ships correlation-search metadata in `default/correlationsearches.conf`: one stanza for each of the 19 detection searches and the Risk Notable, with `rule_name`, `rule_title`, `security_domain`, `severity` and `nes_fields`.

Several searches compare the hour of an event against **business hours, 08:00 to 18:00**: E3 and E5 below, and the after-hours admin anomaly search ([Behavioral & Anomaly Detections](behavioral-detections.md)). They read the hour with `strftime(_time, "%H")` and treat an event as outside business hours when it falls before 08:00 or at 18:00 or later, on any day; E5 also counts all of Saturday and Sunday. `strftime` renders in the time zone of the user the search runs as, so a scheduled run uses the search head's default time zone. To use other hours, change every `oh_hour` comparison in the search, so that all of them use the same window: E3 has two (one for the HANA events, one in the subsearch that counts Web Dispatcher requests), E5 has one (next to its day-of-week test), and the after-hours admin anomaly search has one (see [Customer tuning](#customer-tuning)).

## :material-circle-box:{ .taiconcolor } The 6 base correlation searches

| # | Search name | What it detects | Severity | Schedule |
|---|---|---|---|---|
| 1 | `splunk_sap_logserv_es_hana_privilege_escalation` | HANA `GRANT WITH ADMIN OPTION` or any `ALTER USER` on the SYSTEM user | high | hourly |
| 2 | `splunk_sap_logserv_es_cross_stack_auth_failure` | Same user fails authentication on 2+ different SAP stacks (HANA, sapstartsrv, SCC, sudo) within the same window | high | hourly |
| 3 | `splunk_sap_logserv_es_abap_gateway_anomalous_peer` | New ABAP gateway peer IP not seen (or seen <5 times) in the prior 30 days | medium | hourly |
| 4 | `splunk_sap_logserv_es_scc_access_denied_burst` | 3+ SCC ACCESS_DENIED events on a single host within 1h | medium | hourly |
| 5 | `splunk_sap_logserv_es_hana_failed_connect_spike` | 5+ failed HANA CONNECT attempts by a single user on a single host within 1h | medium | hourly |
| 6 | `splunk_sap_logserv_es_oom_kill_burst` | 3+ Linux OOM-killer (out-of-memory) events on a single host within 1h | medium | hourly |

### :material-circle-box:{ .taiconcolor } Why "6 starter, well-vetted" instead of 15-20

The starter set is intentionally small + signal-heavy:

- Each search has been dry-run on live data before shipping
- Most return 0 rows on healthy-environment data (low FP rate by design — they fire on real attack patterns)
- Easier to false-positive-tune in customer environments
- Easier to document for SOC analysts during onboarding

You can add your own correlation searches on top. Use a shipped search as the model, and keep your search under its own name, so an App upgrade does not replace your work. The hourly correlation searches share a pattern you can keep: a 60-minute dispatch window that ends 5 minutes before the run (`dispatch.earliest_time = -65m@m`, `dispatch.latest_time = -5m@m`; four set their own `earliest` / `latest` in the search instead), the `action.notable` parameters (severity, rule title, security domain) and an `action.risk` list of risk objects and scores. The Risk Notable counts only the searches it names in its `source IN (...)` list, so add a new search's name there if its risk should count toward the threshold.

There are two ways to make the copy:

- **In ES Content Management**, as a new correlation search, with a shipped search's SPL and actions as the model. ES then manages it as a correlation search.
- **In Splunk Web**, with **Settings → Searches, reports, and alerts → Edit → Clone**. The copy is an ordinary saved search. Before you rely on it, open it with **Edit → Advanced edit** and check that it kept the shipped search's `action.notable` and `action.risk` settings, which raise its notables and risk events. It has no ES correlation-search metadata: the App's `default/correlationsearches.conf`, which holds that metadata (`rule_name` and the other entries), has one stanza per shipped search name, and none for the copy.

### :material-circle-box:{ .taiconcolor } Per-search detail

#### :material-crop-square:{ .taiconcolor } 1. HANA Privilege Escalation

```spl
`sap_logserv_idx_macro` sourcetype="sap:hana:audit" tag=change
  (action_type=GRANT OR (action_type="ALTER USER" AND target_user="SYSTEM"))
| where (action_type="GRANT" AND match(sql_statement, "(?i)WITH ADMIN OPTION"))
    OR (action_type="ALTER USER" AND target_user="SYSTEM")
| stats count, latest(_time) AS last_seen, values(sql_statement) AS sql_statements
        by executing_user, target_user, host, action_type
| sort -count
```

!!! warning "`match()` must not appear in a base-search clause"
    `match()` is an eval-only function — in a base-search position it silently matches nothing, so the GRANT disjunct would never fire. That is why the shipped search pre-filters broadly in the base clause and applies the `match()` predicate in `| where`. Keep that structure if you copy this search as a template.

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

**Threat model:** Credential stuffing or coordinated brute force. The same compromised credential is tried against multiple SAP stacks. A user appearing in failure events across 2+ sourcetypes within the same 60-minute dispatch window is the **highest-signal indicator** of this attack pattern.

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
| stats count, latest(_time) AS last_seen, values(client_ip) AS client_ips,
        values(src_host) AS src_hosts by executing_user host
| where count >= 5
| sort -count
```

**Threat model:** A user repeatedly failing HANA CONNECT (5+ in an hour) — above the noise floor of routine SCC tunnel-credential failures (~1-2/hr).

**FP profile:** Low. 5/hr threshold is above routine failure rates.

#### :material-crop-square:{ .taiconcolor } 6. Linux OOM-Killer Burst

Fires when a host logs 3 or more Linux OOM-killer (out-of-memory) events within an hour (sourcetypes `linux:warn` and `syslog`). Security domain `endpoint`.

**Threat model:** A spike of kernel out-of-memory kills can indicate a memory-exhaustion attack, a runaway/compromised process, or resource-starvation that takes SAP services offline. Clustered OOM kills warrant operational + security review.

**FP profile:** Low to medium. Legitimately busy hosts under memory pressure can produce bursts; correlate with known workload spikes or capacity events.

## :material-circle-box:{ .taiconcolor } Extended cross-stack pack (v2)

Six additional correlation searches detect cross-source threat chains that customers can't easily author themselves. The patterns require SAP-specific knowledge of which sourcetype emits the authentication event vs. the privilege change vs. the data-tier event — knowledge that's inside the LogServ App rather than in stock Splunk content.

| # | Search name | What it detects | Severity | Schedule |
|---|---|---|---|---|
| E1 | `splunk_sap_logserv_es_lateral_movement` | Same user authenticates successfully into 3+ HANA SIDs within 60s | high | hourly |
| E2 | `splunk_sap_logserv_es_privilege_chain` | Same account on one HANA host: auth failure, auth success and a privilege change in the same hour (in any order) | high | hourly |
| E3 | `splunk_sap_logserv_es_after_hours_admin_data_access` | HANA admin user active in the HANA audit log outside business hours; each result also carries a count of the host's off-hours Web Dispatcher requests (normally 0 on the scheduled run; see E3) | high | hourly |
| E4 | `splunk_sap_logserv_es_service_account_interactive` | Service account (identified by username pattern) generated interactive HANA CONNECT | medium | hourly |
| E5 | `splunk_sap_logserv_es_hana_user_creation_off_hours` | `CREATE USER` on HANA outside business hours or on weekends | medium | hourly |
| E6 | `splunk_sap_logserv_es_hana_mass_drop` | 5+ DROP statements by a single user on a single host within 10 min | high | hourly |

### :material-circle-box:{ .taiconcolor } Per-search detail (extended pack)

#### :material-crop-square:{ .taiconcolor } E1. Lateral Movement

Same user authenticates successfully into 3+ SAP HANA SIDs within a 60-second window. The cross-SID hop pattern is the canonical lateral-movement signal across the SAP estate.

**Threat model:** An attacker with valid credentials probing the estate to find which systems the credential is authorized on. Healthy environments show this only for monitoring service accounts that legitimately poll every SID.

**FP profile:** Low — most environments have monitoring service accounts that legitimately span SIDs. Exclude those accounts in the search: add `| search NOT auth_user IN ("<account>", ...)` after the `eval` that sets `auth_user` (see [Customer tuning](#customer-tuning)).

#### :material-crop-square:{ .taiconcolor } E2. Privilege Chain (Credential Stuffing → Escalation)

Same account on a single HANA host has BOTH authentication failures AND a successful authentication AND a privilege-change event (GRANT, ALTER USER, CREATE USER/ROLE) within a 1-hour window. The search counts the three kinds of event; it does not check their order. Highest-priority investigation pattern in the SAP-side ES content.

**Threat model:** Credential stuffing → established access → escalation chain. The textbook compromise pattern.

**FP profile:** Very low. Healthy admin operations look like (success + change), not (failure + success + change).

#### :material-crop-square:{ .taiconcolor } E3. After-Hours Admin Data Access

An admin user is active in the HANA audit log outside business hours (before 08:00 or from 18:00). The search groups the off-hours HANA audit events by admin user and HANA host. For each result it adds the number of off-hours Web Dispatcher requests on the same host (`host_web_events`, read from the App's hourly rollup; `0` when it finds none), as context: it does not require web traffic, and it does not match the web requests to the user. On the scheduled run this count is normally `0`, whatever the web traffic was: the rollup writes an hour's row only after that hour has ended, and the search's 60-minute window ends before then. Run on demand over a longer time range, the search shows the off-hours requests.

"Admin user" means `is_admin_user="true"`, a field the App sets on `sap:hana:audit` events when `executing_user` contains `admin` (case-insensitive) or is one of three account names from the App's reference environment. Apart from those three names, HANA's `SYSTEM` user and SAP `<sid>adm` accounts do not match. If your admin accounts are named differently, change the `is_admin_user` calculated field for `sap:hana:audit`, which the App ships as the `EVAL-is_admin_user` line under `[sap:hana:audit]` in its `default/props.conf` (Splunk Web: **Settings → Fields → Calculated fields**, as an admin-tier user; Splunk Enterprise: the same line in the App's `local/props.conf`, never in `default/`). The same field drives the after-hours admin anomaly search.

**Threat model:** Admin-account compromise → data exfiltration via authenticated session that spans the database and HTTP tiers. Off-hours timing reduces the likelihood of being noticed in real time.

**FP profile:** Low for human admin accounts; moderate for service accounts that legitimately do this. Exclude those accounts in the search: add `NOT executing_user IN ("<account>", ...)` to its base search, before the first `|` (see [Customer tuning](#customer-tuning)).

#### :material-crop-square:{ .taiconcolor } E4. Service-Account Interactive HANA Login

Service accounts generated interactive HANA CONNECT events. Service accounts are identified inside the search itself by username pattern against `executing_user` (`adm$`, `^sapservice`, `_svc$`, `^svc_`, `_batch$`, `_daemon$`, `^sap_`). Service accounts should run programmatic workloads, never interactive sessions.

**Threat model:** Either misuse (admin using a service-account credential because it has higher privileges than their own) or compromise (attacker who obtained a service-account credential and is using it interactively from a workstation).

**FP profile:** Very low if the username patterns match your naming convention. To change coverage, edit the `eval is_svc=...` clause in the search (see [Customer tuning](#customer-tuning)).

#### :material-crop-square:{ .taiconcolor } E5. HANA User Creation Outside Business Hours

`CREATE USER` on HANA outside business hours (before 08:00 or from 18:00) or at any time on Saturday or Sunday. Should map to a known change ticket; off-window creation often indicates ad-hoc / unauthorized provisioning.

**Threat model:** Insider creating a backdoor account when fewer admins are watching. Less aggressive than mass DROP but still a containment-relevant signal.

**FP profile:** Low for typical environments. Higher during planned cutover weekends — operators expecting weekend CREATE USER activity should pre-disable this search for the maintenance window.

#### :material-crop-square:{ .taiconcolor } E6. HANA Mass DROP { #e6-hana-mass-dropdelete }

5+ DROP statements (TABLE, SCHEMA, VIEW, PROCEDURE, USER, ROLE, INDEX) by a single user on a single host within one 10-minute bucket. Only these DROP statements count; DELETE statements are not matched. Indicates either large-scale schema cleanup (which should map to a change ticket) or destructive insider activity.

**Threat model:** Destructive insider, ransomware-style data destruction, or inadvertent operator error during cleanup.

**FP profile:** Low at this threshold (5 in 10 min is well above routine ad-hoc cleanup activity). Schema migrations for a major release will produce hits — pre-disable the search during planned migration windows or document the mapping in the change ticket.

## :material-circle-box:{ .taiconcolor } RBA — Risk-Based Alerting

Each of the 19 detection searches carries `action.risk = 1` annotations, so its results also feed ES's Risk Framework: each result row of a run adds the listed score to each listed risk object.

### :material-circle-box:{ .taiconcolor } Per-search risk table

| Search | risk_object_field | risk_object_type | risk_score |
|---|---|---|---|
| HANA privilege escalation | `executing_user`, `target_user`, `host` | user, user, system | 80, 40, 30 |
| Cross-stack auth failure | `user` | user | 60 (one result row per user per run, so it accumulates across hourly runs) |
| ABAP gateway anomalous peer | `peer_ip`, `host` | other, system | 40, 20 |
| SCC ACCESS_DENIED burst | `host` | system | 50 |
| HANA failed CONNECT spike | `executing_user`, `host` | user, system | 50, 30 |
| Linux OOM-killer burst | `host` | system | 50 |
| Lateral movement | `auth_user` | user | 70 |
| Privilege chain | `auth_user`, `host` | user, system | 80, 40 |
| After-hours admin data access | `executing_user`, `host` | user, system | 70, 30 |
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

For the HANA searches, `host` is the HANA host that wrote the audit record (the client's host name is `src_host`), so their system risk lands on the database host. The failed-CONNECT spike and after-hours admin searches list client host names in `src_hosts`.

### :material-circle-box:{ .taiconcolor } Multi-object risk per event

Where a result names several objects (operator, target and host for privilege escalation), each object receives its own score from the list, so all three accrue risk at once. Example:

```ini
action.risk.param._risk = [
  {"risk_object_field":"executing_user","risk_object_type":"user","risk_score":80},
  {"risk_object_field":"target_user","risk_object_type":"user","risk_score":40},
  {"risk_object_field":"host","risk_object_type":"system","risk_score":30}
]
```

The tier-2 Risk Notable below sums the scores per risk object (`stats sum(All_Risk.risk_score) ... by All_Risk.risk_object`), so each of the three objects accumulates its own score.

## :material-circle-box:{ .taiconcolor } Tier-2 Risk Notable

The App also ships `splunk_sap_logserv_es_risk_notable_threshold` — a higher-tier correlation search that aggregates risk events from all 19 detection searches and creates a critical-severity Notable when a single risk_object accumulates ≥ 100 risk_score in 24h.

```spl
| from datamodel:Risk.All_Risk
| search source IN (
    "splunk_sap_logserv_es_hana_privilege_escalation",
    "splunk_sap_logserv_es_cross_stack_auth_failure",
    ...                     <- the shipped stanza enumerates all 19 detection
    ...                        searches: base, extended, threat-intel, anomaly
    "splunk_sap_logserv_es_anomaly_after_hours_admin")
| stats sum(All_Risk.risk_score) AS total_risk
        values(All_Risk.risk_object_type) AS risk_object_type
        values(source) AS source_searches
        dc(source) AS distinct_searches
        latest(_time) AS last_event by All_Risk.risk_object
| rename All_Risk.risk_object AS risk_object
| where total_risk >= 100
```

**Why threshold 100?** It's the conservative starter:
- Two hourly runs of the cross-stack auth-failure search that flag the same user within 24h (60 + 60 = 120) → fires
- One privilege-escalation result gives 80, 40 and 30 to its three objects — none alone reaches 100, but a second result for the same operator compounds (80 + 80 = 160)
- The threshold is yours to set: raise it if the Risk Notable fires on activity you accept, lower it if you want notice sooner (see [Customer tuning](#customer-tuning)).

**ES dependency:** the Risk Notable reads from the `Risk.All_Risk` data model, which ES provides. Without ES there is no Risk data model, so the scheduler skips the search, with the reason "Data model 'Risk' was not found", rather than running it and returning nothing. On a search head without ES, disable it: see [Disabling or tuning the ES content](overview.md#disabling-or-tuning-the-es-content).

## :material-circle-box:{ .taiconcolor } How notables appear in ES Incident Review

When a base correlation search fires:

1. **Notable created** with the search's `rule_title` template substituted with row field values
   - Example: "HANA Privilege Escalation: ALTER USER by xcnadm on SYSTEM"
2. **Severity badge** matches `action.notable.param.severity` (high / medium)
3. **Security domain** badge from `action.notable.param.security_domain`: `identity`, `access`, `network` or `endpoint` for the base searches (E6 and the Risk Notable use `threat`)
4. **`nes_fields`**: each search names the fields that identify a finding in `action.notable.param.nes_fields`, for example `executing_user,target_user,host` (operator, target and host) for privilege escalation. How Incident Review uses these fields depends on your ES version; see the ES documentation.

When the tier-2 Risk Notable fires:

1. **Critical-severity notable** with title like "High accumulated risk: xcnadm (160) across 3 SAP correlation searches"
2. **Security domain** = `threat`
3. **One row per risk object**: the search returns one result for each `risk_object` over the threshold (`stats ... by All_Risk.risk_object`), and names `risk_object` in `nes_fields`

## :material-circle-box:{ .taiconcolor } Customer tuning

Change the severity, schedule, risk scores or SPL of a search in Splunk Web, which works on Splunk Cloud and Splunk Enterprise alike:

1. Go to **Settings → Searches, reports, and alerts**, set **App** to *Splunk App for SAP LogServ* and find the search.
2. Choose **Edit → Advanced edit** and change the attribute: `action.notable.param.severity`, `cron_schedule`, `action.risk.param._risk` or `search`.
3. Save.

For example, to raise the Risk Notable threshold to 150, open `splunk_sap_logserv_es_risk_notable_threshold` and change `| where total_risk >= 100` near the end of its `search` to `| where total_risk >= 150`, leaving the rest of the search as it is.

On Splunk Enterprise you can instead override the attribute in `local/savedsearches.conf` (never edit `default/`). An overridden `search` replaces the whole shipped search, so copy the full shipped line from `default/savedsearches.conf` and change only the part you need; then restart Splunk.

## :material-circle-box:{ .taiconcolor } Disabling individual correlation searches

To stop a search without uninstalling the App, disable it in **Settings → Searches, reports, and alerts** (**Edit → Disable**), or turn off only its schedule. A disabled search stays in the App and can be enabled again. The extended, threat-intel and anomaly searches also run AI Assistant prompts, which fail while their search is disabled; the steps and the list are in [Disabling or tuning the ES content](overview.md#disabling-or-tuning-the-es-content).

## :material-circle-box:{ .taiconcolor } See also

- [CIM Compliance](cim-compliance.md) — How the underlying tagging works
- [Asset & Identity Feed](asset-identity-feed.md) — How asset context enriches notable events
- [Threat Intelligence Integration](threat-intel.md) — The 3 customer-managed CSV lookups + 3 TI-driven correlation searches
- [Behavioral & Anomaly Detections](behavioral-detections.md) — The 4 statistically-baselined anomaly searches with optional MLTK upgrade path
