# Quick Install Reference

A single matrix mapping every Splunkbase add-on, prerequisite, and LogServ component to the tier(s) where each gets installed. Use this as a pre-install checklist; for full install steps see the per-package pages linked from each row.

### :material-circle-box:{ .taiconcolor } Package Matrix

!!! note "Single-instance Splunk"
    For a single-instance Splunk deployment (one host playing every role), install every required app on that one host. The matrix below is for distributed topologies — column headings refer to specific tiers. **SH** = Search Head, **IDX** = Indexer, **HFs** = Heavy Forwarders, **DS** = Deployment Server.

| App | Splunkbase | Required? | SH | IDX | HFs | DS |
|---|---|---|:---:|:---:|:---:|:---:|
| **LogServ Data TA** (`splunk_ta_sap_logserv`) | this repo | required | — | ✓ (indexes.conf) | ✓ (via DS) | ✓ (filter UI) |
| **LogServ App** (`splunk_app_sap_logserv`) | this repo | required | ✓ | — | — | — |
| **Splunk Add-on for Unix and Linux** | <a href="https://splunkbase.splunk.com/app/833" target="_blank">833</a> | required (CIM) | ✓ | — | — | — |
| **Splunk Add-on for Microsoft Windows** | <a href="https://splunkbase.splunk.com/app/742" target="_blank">742</a> | required (CIM) | ✓ | — | — | — |
| **Splunk Add-on for AWS** | <a href="https://splunkbase.splunk.com/app/1876" target="_blank">1876</a> | required if SAP ECS in AWS | — | — | ✓ (S3 inputs) | — |
| **Splunk Add-on for Microsoft Cloud Services** | <a href="https://splunkbase.splunk.com/app/3110" target="_blank">3110</a> v5.0+ | required if SAP ECS in Azure | — | — | ✓ (Blob inputs) | — |
| **Splunk MCP Server** | <a href="https://splunkbase.splunk.com/app/7931" target="_blank">7931</a> v1.1.0+ | required for AI Assistant | ✓ | — | — | — |
| **Splunk AI Assistant** | <a href="https://splunkbase.splunk.com/app/200" target="_blank">200</a> | recommended companion to 7931 | ✓ | — | — | — |

### :material-circle-box:{ .taiconcolor } Notes

- **Indexer rationale.** The Data TA goes on the indexer because it bundles `indexes.conf`. See [Why does the Data TA need to go on the Indexer?](../install-setup/install-ta.md#3-where-to-install) for the trade-off + opt-out path.
- **CIM add-ons go on the SH only.** The CIM TAs (Unix/Linux, Windows) carry only search-time content (props/transforms/eventtypes/tags/lookups for the parsing the LogServ App's dashboards consume); none of them need to run on the indexer or HFs for our pipeline. If your installation **also** uses one of these TAs' scripted inputs for some other purpose (e.g., the `cpu.sh` / `vmstat.sh` modular inputs in Splunk_TA_nix), follow that TA's own installation guidance for the indexer/HF side — that usage is independent of this app.
- **No standalone Squid Proxy or ISC BIND add-ons needed.** Their parsing was absorbed into the LogServ App in v0.0.5.0 build 184 (Squid Add-on 2965 v2.1.0 — archived on Splunkbase; ISC BIND Add-on 2876 v2.0.0 — archived). If you have either standalone TA installed alongside the LogServ App, the App's home view shows a one-time dismissible banner recommending uninstall via `Settings → Manage Apps` (otherwise both TAs' parsing applies in parallel — duplicate field extraction).
- **AWS Add-on (1876).** Only needed when SAP ECS data lives in AWS S3. The TA owns the SQS-based S3 inputs that pull data from the dest bucket; the LogServ Data TA then sourcetype-routes events as they're parsed on HFs. The actual `index = sap_logserv_logs` setting that sends events to the right place lives in this TA's S3 input config — not in the LogServ Data TA.
- **Splunk Add-on for Microsoft Cloud Services (3110).** Only needed when SAP ECS data lives in Azure Blob Storage. The TA owns the `mscs_storage_blob` input that polls the configured Azure container under the `logserv/` prefix; the LogServ Data TA then sourcetype-routes events identically to the AWS path. The `index = sap_logserv_logs` setting + the `_meta = cloud_provider::azure` attribution stamp both live in this TA's input stanza — not in the LogServ Data TA. Minimum version 5.0+ for KV Store checkpoint + horizontal scaling. Customers running BOTH AWS and Azure ingest install both add-ons (1876 + 3110) on the same HF tier. See [Azure Setup Guide](../install-setup/azure-setup.md) for the four supported Azure auth recipes + production-topology pattern.
- **MCP Server (7931).** Required for the AI Assistant's predefined-prompt path even when the LLM-driven path is disabled. Without it, the AI Assistant chat panel can't dispatch saved searches.
- **Splunk AI Assistant (200).** The LogServ App uses only the core `splunk_run_saved_search` and `splunk_run_query` MCP tools (which work standalone against 7931), but App 200 follows Splunk's documented co-install pattern and unlocks `saia_*`-prefixed MCP tools that may be used in future LogServ releases.

### :material-circle-box:{ .taiconcolor } Per-Topology Checklists

#### :material-crop-square:{ .taiconcolor } Single Splunk instance

Install all required + recommended apps on the same instance. Splunk auto-creates both indexes (`sap_logserv_logs` + `logserv_ai_assistant_audit`) when the Data TA loads on first start.

#### :material-crop-square:{ .taiconcolor } Distributed (DS + HFs + on-prem SH+IDX)

| Tier | Install |
|---|---|
| **Search Head** | LogServ App, MCP Server (7931), Splunk AI Assistant (200), CIM add-ons (Unix/Linux, Windows) |
| **Indexer** | LogServ Data TA (provides indexes.conf for both indexes). The CIM add-ons are **not** needed here — they carry only search-time content. |
| **Deployment Server** | LogServ Data TA (manages filter UI + pushes Data TA to HFs) |
| **Heavy Forwarders** | Receive LogServ Data TA via the DS automatically. Install the cloud-storage ingest add-on matching where your data lives: AWS add-on (1876) for S3, Splunk Add-on for Microsoft Cloud Services (3110) v5.0+ for Azure Blob Storage, or both. The CIM add-ons are **not** needed here. |

#### :material-crop-square:{ .taiconcolor } Distributed (DS + HFs + Splunk Cloud SH)

| Tier | Install |
|---|---|
| **Splunk Cloud Search Head** | LogServ App, MCP Server (7931), Splunk AI Assistant (200), CIM add-ons (Unix/Linux, Windows) |
| **Splunk Cloud Indexer tier** | Splunk Cloud admin handles. Either (a) install the LogServ Data TA there to use the bundled index defs, OR (b) the Cloud admin manually creates `sap_logserv_logs` and `logserv_ai_assistant_audit` via the Splunk Cloud UI — see [Why does the Data TA need to go on the Indexer?](../install-setup/install-ta.md#3-where-to-install). |
| **Deployment Server** | LogServ Data TA |
| **Heavy Forwarders** | Receive LogServ Data TA via the DS. Install the cloud-storage ingest add-on(s) matching your data: AWS add-on (1876), Splunk Add-on for Microsoft Cloud Services (3110), or both. |

## :material-circle-box:{ .cboxmove } Next Steps

- [Architecture](architecture.md) — full topology diagram + the why behind the package split
- [Data TA Prerequisites](../install-setup/prerequisites.md) — Splunkbase TA prereq detail (which CIM add-on covers which sourcetype)
- [LogServ App Prerequisites](../logserv-app/prerequisites.md) — MCP Server + AI Assistant prereq detail
- [Installing the Data TA](../install-setup/install-ta.md) — full install procedure including the indexer-tier rationale
- [Installing the LogServ App](../logserv-app/installation.md)
