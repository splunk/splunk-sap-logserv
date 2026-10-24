# LogServ App Prerequisites

Use this page before you install the LogServ App (`splunk_app_sap_logserv`, shown in Splunk Web as Splunk App for SAP LogServ): it lists what the search tier needs beside the App, and who can use and administer it. The ingest tier's requirements are on [Plan and Prerequisites](../getting-started/prerequisites.md), and the two indexes are created first, on the indexer tier (see [Create the indexes](../install-setup/install-ta.md#1-create-the-indexes)).

### :material-circle-box:{ .taiconcolor } Search-Tier Requirements { #required-splunk-add-ons-search-head }

Install these on the search tier: the search head, the Splunk Cloud search head, or every member of a search head cluster.

| Requirement | Version | Why |
|---|---|---|
| **Splunk Enterprise** or **Splunk Cloud Platform** | Splunk Enterprise 9.4.3 or later. Splunk Cloud Platform: Victoria Experience, checked on 10.x (most recently 10.5.2605.10); see [Plan and Prerequisites](../getting-started/prerequisites.md#splunk-platform-requirements) | 9.4.3 is the minimum supported version: the platform this release is tested on. The App bundles its own React, `@splunk/react-ui`, `@splunk/visualizations` and `@xyflow/react`, so the floor is a support baseline, not a component dependency. |
| <a href="https://splunkbase.splunk.com/app/1621" target="_blank">Splunk Common Information Model</a> (`Splunk_SA_CIM`, Splunkbase 1621) | 5.0.0 or later | The only dependency the App's `app.manifest` declares. The App's CIM event tags (Authentication, Change, Network Sessions, Network Resolution, Web) and its Enterprise Security content build on it. Free on Splunkbase, and bundled with Enterprise Security. |
| <a href="https://splunkbase.splunk.com/app/742" target="_blank">Splunk Add-on for Microsoft Windows</a> (Splunkbase 742) | — (no minimum checked) | Required for the Windows panels. No LogServ package extracts fields from `XmlWinEventLog`, so without it the Windows dashboard's Event Code, Severity and Service panels stay empty. |
| <a href="https://splunkbase.splunk.com/app/833" target="_blank">Splunk Add-on for Unix and Linux</a> (Splunkbase 833) | — (no minimum checked) | The CIM and Enterprise Security fields of `linux_secure`. The App parses its other Linux sourcetypes itself. |
| **KV Store** | enabled and healthy | The dashboards read hourly rollups that scheduled searches write to KV Store; Environment Topology and the App's settings are stored there too. On a search head cluster, KV Store replication must be healthy. |
| **Search head cluster** | optional | Supported. Install the App and the add-ons through the deployer; see [Dashboard Data: Backfill and Freshness](dashboard-data.md) for how the scheduled searches behave on a cluster. |

These add-ons go on the search tier only, not on the Deployment Server, the heavy forwarders or the indexers: the Data TA parses LogServ events before it gives them these sourcetypes, so the add-ons' parse-time settings never apply to them.

!!! note "No standalone Squid Proxy or ISC BIND add-ons"
    The parsing of the archived Splunk Add-on for Squid Proxy and Splunk Add-on for ISC BIND is built into the LogServ App. Do not install the standalone add-ons. If either is enabled beside the App, both parse the same events, and the App's home view shows a dismissible banner recommending that you remove it (**Settings > Manage Apps**).

### :material-circle-box:{ .taiconcolor } Roles and Access

- **Searching the data.** Every role that uses the dashboards must be able to search `sap_logserv_logs`. On Splunk Enterprise the default `user` role allows `*`, which matches every index whose name does not start with `_`, so it and the roles that import it (such as `power`) can already search the index. Add the index to any role with a narrowed list (**Settings > Roles >** *role* **> Indexes**). On Splunk Cloud, check each role's **Indexes** tab the same way.
- **App admins.** The App treats only roles named exactly `admin`, `sc_admin` or `sc_subadmin` as admins, and only these roles may write the App's settings and the dashboards' KV Store rollups. So only they can open **Settings** (its AI Assistant and Dashboard Data tabs) and run **Clear** and **Backfill** on the dashboard data. A user whose admin role has any other name sees "403 — Admin access required" there. Give the people who run the App one of these three roles; whether a role that imports one of them is enough has not been tested.
- **The audit index.** Grant read access to `logserv_ai_assistant_audit` only as [Restricting who can read the audit index](../ai-assistant/audit-log.md#restricting-who-can-read-the-audit-index) describes.

!!! note "Enterprise Security content ships enabled"
    The App ships its Enterprise Security searches (the `splunk_sap_logserv_es_*` saved searches, 22 in this release) scheduled and enabled. On a search head without Enterprise Security, we recommend turning them off; see [Disabling or tuning the ES content](../enterprise-security/overview.md#disabling-or-tuning-the-es-content). If you use the AI Assistant's Security prompts, do not disable the 13 searches they run (a disabled search makes its prompt fail): turn off only their schedule, and disable the other 9 (see the linked section).

!!! info "Optional: the AI Assistant"
    The AI Assistant ships disabled, and nothing in this page's table needs it. To use it:

    - Install the <a href="https://splunkbase.splunk.com/app/7931" target="_blank">Splunk MCP Server</a> (Splunkbase 7931) 1.1.0 or later on the same search head as the App; 1.2.1 or later is recommended (Splunk advisory SVD-2026-1004). The predefined prompts use its Run Saved Search tool, which first shipped in 1.1.0. The App's health check blocks only versions below 1.0.3 (the CVE-2026-20205 fix) and sets no upper bound; the newest version verified is 2.0.0.
    - Optionally, install the <a href="https://splunkbase.splunk.com/app/7245" target="_blank">Splunk AI Assistant</a> (Splunkbase 7245) beside it. The LogServ App does not need it: it uses only the MCP Server's own `splunk_run_saved_search` and `splunk_run_query` tools.
    - An admin turns the AI Assistant on and answers its acknowledgements: the liability terms, asked each time it is turned on, and, while audit forwarding is off (the default), the audit-log integrity terms, asked the first time and again when they change ([Set Up the AI Assistant](../ai-assistant/enable.md#4-turn-on-the-ai-assistant-and-answer-both-acknowledgements)).
    - The predefined prompts need no LLM provider or credential. Free-form questions need a provider and its credential, which an admin configures; the shipped default provider is a mock that contacts no vendor.

    The steps are on [Set Up the AI Assistant](../ai-assistant/enable.md). To turn off or restrict the free-form LLM path, see [Restricting the LLM Path](../ai-assistant/templates-only-build.md).

## :material-circle-box:{ .cboxmove } Next Steps

- [Install the App and Seed the Dashboards](installation.md)
