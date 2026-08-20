# Change & Configuration Activity

![Change & Configuration Activity](../../../../images/dashboard-change-config.png)

## :material-circle-box:{ .taiconcolor } Why This Dashboard Matters

Compliance conversations (SOX, PCI, internal change management) all require evidence that configuration changes are (1) authorized, (2) attributable to a specific operator, and (3) happening in approved maintenance windows. That evidence lives scattered across three audit trails: HANA audit logs (user/role/privilege/password operations and DDL), Windows Security Event Log (account and group modifications), and Linux syslog (sudo commands plus `useradd`/`usermod`/`userdel`/`passwd` events). This dashboard unifies the three into a single audit trail with a consistent operator column and category taxonomy, plus two compliance-focused "recent" tables: one filtered to privileged actions, one filtered to after-hours activity.

## Panels

!!! warning "Leave the Cloud Provider picker on All for compliance reporting"
    The title row carries the app-wide **Cloud Provider** picker. Any setting other than **All** silently narrows the audit trail to one ingest channel — for compliance evidence, always leave it on **All**.

- **Total Change Events** -- Aggregate count of change events across all three sources
- **User Account Changes** -- Count of user-management actions (HANA `User Management`/`User Creation`/`User Deletion`; Windows EventCodes 4720/4722/4725/4726/4738/4781; Linux `useradd`/`usermod`/`userdel`)
- **Permission Grants** -- Count of privilege/group-membership grants (HANA `Permission Grant`; Windows EventCodes 4728/4732/4756 -- "added to group")
- **Password Events** -- Count of password changes and resets (HANA `Password Management`/`Password Reset`; Windows EventCode 4724; Linux `passwd`)
- **After-Hours Changes** (orange when non-zero) -- Count of change events occurring outside business hours (weekday 8am-7pm, i.e. 08:00-18:59) or on weekends. All three sources use the same window, computed from each event's `_time` on the search head
- **Unique Operators** -- Distinct count of source-prefixed operator identities (e.g., `HANA:XCPADM`, `Windows:domain\admin`, `Linux:ops-user`)
- **Change Activity Over Time (by Source)** -- Stacked column by day (left half of the row, beside the Category donut), series split by source (HANA / Windows / Linux). Same-day spikes across two or three series often line up with maintenance windows; isolated spikes in one source worth investigating.
- **Change Events by Category** -- Donut showing the category mix: Permission Grant, Permission Revoke, User Management, Password Change, Group Membership, Account Status, Sudo Command, DDL / Config, Other.
- **Operators by Change Count (Source-Prefixed)** -- Full-width table of operator identities across all three stacks ranked by change events (paginated), with source-prefixed identities so operator activity is clearly scoped to each system.
- **HANA Audit -- Change Events** -- Full-width table of the 500 most recent HANA user/role/privilege/password/DDL actions with Operator, Target, Category, Action, Status, Host.
- **Windows -- Account & Group Modifications** -- Full-width table of the 500 most recent Windows Security events across all 15 canonical account/group EventCodes, with human-readable Description column derived from EventCode.
- **Linux -- Sudo & Command Activity** -- Full-width table of the 500 most recent sudo commands + `useradd`/`usermod`/`userdel`/`groupadd`/`groupmod`/`groupdel`/`passwd` activity, with Operator (extracted from sudo prefix or PAM `(user)` pattern) and Command.
- **Recent Privileged Changes (Compliance Focus)** -- Table (left half of the bottom row) of the 500 most recent events in the highest-risk subset: HANA Permission Grants + User Creations + Audit Policy changes; Windows account creation/enable/password-reset + local-group additions; Linux `useradd` / `usermod` / `userdel` / `visudo` activity. This is the "who gave themselves or others more access" report.
- **Recent After-Hours Changes (Outside Business Hours)** -- Table (right half of the bottom row) of the 500 most recent change events with `is_after_hours=1`. This is the "who was working outside the change window" report -- high compliance value.

## :material-circle-box:{ .taiconcolor } Where the Data Comes From

Sources span the three change surfaces: `sap:hana:audit` (user/role/privilege/DDL changes),
`XmlWinEventLog` (account and group changes) and the Linux family (`linux_messages_syslog`,
`linux_secure`, `linux:sudolog`, `linux:cron`, `linux:warn`, `linux:slapd`, plus legacy `syslog`).

- **Summary-backed panels** — the KPIs, sparklines, activity chart, category donut and operator
  table read the `logserv_compliance_rollup` KV Store collection: metric `main` carries an hourly
  grain over (change source, category, operator, after-hours flag), and metrics `userchg`,
  `permgrant` and `password` pre-compute their KPIs' exact filters per hour. The after-hours flag is
  computed from the event timestamp at aggregation time (outside 08:00–18:59, or a weekend).
  Populated at minute :12 of every hour by `logserv_compliance_aggregate`.
- **Live panels** — the five audit-trail tables (HANA, Windows, Linux, Privileged Changes,
  After-Hours) are per-event listings dispatched against the raw events at view time (capped at the
  500 most recent matches each) — deliberately raw, so the compliance record shows actual
  events rather than summaries.

Summary-backed panels switch automatically to their exact raw-equivalent search when the selected window is shorter than 90 minutes, so sub-hour investigation stays real-time. The collection keeps 365 days of hourly history (trimmed by a daily retention search); a fresh install seeds the last 30 days from **Settings → Dashboard Data → Run backfill**. The global **Cloud** dropdown filters the summaries through the `cloud_provider` dimension stored in every rollup row. Full schedule and freshness reference: [Performance & Data Freshness](../performance.md).


## :material-lightning-bolt:{ .taiconcolor } What to Look For

- **Rows in the Privileged Changes table with unfamiliar operators** -- The "headline" compliance question. A permission grant or group-addition you don't recognize is the first thing to investigate.
- **After-Hours activity on business days** -- The After-Hours table surfaces all outside-window activity. Weekend entries are often planned maintenance; weekday late-night or early-morning entries warrant a check against your change tickets.
- **Single operator dominating the Operators by Change Count table** -- One identity generating most changes can be legitimate (an admin performing a large rollout) or concerning (an account being abused). The source prefix tells you which system to look at first.
- **Category-mix drift** -- If the Change Events by Category donut suddenly shows a large "Permission Grant" slice where it's historically been minor, someone has been handing out privileges. Check the HANA Audit table for details.
- **Source asymmetry** -- The stacked column should show all three sources over time. If one source goes silent, it's likely a logging-pipeline issue rather than "no changes happened". Correlate with [Data Pipeline Overview](../platform/data-pipeline-overview.md).
- **Linux sudo commands starting with useradd/usermod/visudo/passwd** -- These are the Linux equivalent of admin changes; they show up in both the Linux table and the Privileged Changes table for visibility.

!!! note "Compliance-focused exception: no row drill-downs on the After-Hours and Privileged Changes tables"
    Two compliance-focused tables on this dashboard intentionally have **no row drill-downs** — the **After-Hours Changes** and **Recent Privileged Changes** tables. Clicking through to raw events from a compliance audit-trail report would pollute the trail with the reviewer's own search activity in subsequent compliance reports. Per-source operational tables on the same dashboard (HANA Audit, Windows Account & Group Modifications, Linux Sudo & Command Activity) DO get drill-downs.


