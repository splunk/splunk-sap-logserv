# Architecture

## :material-circle-box:{ .taiconcolor } Two-Package Model

The SAP LogServ solution for Splunk is delivered as **two separately installable packages**:

| Package | App ID | Purpose |
|---------|--------|---------|
| **Data TA** | `splunk_ta_sap_logserv` | Data collection, index-time filtering, deployment server automation, configuration UI, ships the `indexes.conf` for `sap_logserv_logs` (SAP data) and `logserv_ai_assistant_audit` (AI Assistant audit log) |
| **LogServ App** | `splunk_app_sap_logserv` | Dashboards, AI Assistant, Environment Topology view, search-time field extractions, macros |

The **Data TA** handles everything that happens at index time: ingesting data from S3, routing events to the correct sourcetype, applying index-time filters, and defining the two indexes the solution writes to. It includes Python scripts, REST handlers, a configuration UI built with Splunk's UCC framework, and `default/indexes.conf` so Splunk auto-creates `sap_logserv_logs` and `logserv_ai_assistant_audit` on first install. Both index names are **macro-configurable** via `sap_logserv_idx_macro` (SAP data) and `sap_logserv_audit_idx_macro` (audit log); customers who rename either index update the matching macro definition. The `logserv_ai_assistant_audit` index is required for the AI Assistant's audit log to function — without it, audit events have no destination index.

The **LogServ App** handles everything that happens at search time: field extractions, field aliases, computed fields, and the dashboards you use to visualize and analyze the data. It contains no Python code and no data collection components.

!!! tip "Why two packages?"
    The split follows Splunk best practices for distributed deployments. The Data TA runs at the ingest tier (Heavy Forwarders for distributed deployments, plus the Indexer where the bundled `indexes.conf` provisions storage) and the LogServ App runs on the Search Head where users interact with dashboards. Keeping these tiers separate means search-only logic (field extractions, dashboards, the AI Assistant chat panel) doesn't bloat the forwarders, and ingest logic (sourcetype routing, REST handlers, UCC config UI) doesn't leak into the Search Head.

## :material-circle-box:{ .taiconcolor } Install Matrix

Where you install each package depends on your Splunk topology:

| Topology | Data TA | LogServ App |
|----------|---------|-------------|
| **Single instance** | Same instance | Same instance |
| **DS + HFs + on-prem SH** | Deployment Server + each HF + Indexer | Search Head only |
| **DS + HFs + Splunk Cloud** | Deployment Server + each HF (Splunk Cloud admin handles the indexer tier — Data TA installed there provides the index defs) | Splunk Cloud SH only |

!!! warning "Important"
    - The Data TA is **never** installed directly on Heavy Forwarders when using a Deployment Server -- the DS distributes it automatically.
    - The LogServ App is **never** installed on Heavy Forwarders or the Deployment Server.
    - On Splunk Cloud, the customer's Splunk Cloud admin handles the indexer tier separately. The Data TA installed on that indexer provides the bundled index definitions.
    - For single-instance deployments, both packages are installed on the same instance and Splunk merges their configurations at runtime.

## :material-circle-box:{ .taiconcolor } Data Flow

The diagram below shows how SAP LogServ data flows from the SAP ECS environment into Splunk:

```
  SAP ECS Environment
        |
        v
  SAP LogServ S3 Bucket (SAP-managed)
        |
        v  (S3 event notifications via SQS)
  Customer's AWS Account
  +-----------------------------------------------+
  |  Destination S3 Bucket  -->  SQS Queue        |
  |         (S3 events trigger SQS messages)      |
  +-----------------------------------------------+
        |
        v  (Splunk AWS Add-on reads from SQS)
  Splunk Heavy Forwarders
  +-----------------------------------------------+
  |  1. Ingest NDJSON from S3 via SQS             |
  |  2. Route to sourcetype (TRANSFORMS)          |
  |  3. Apply index-time filters (nullQueue)      |
  |  4. Forward to indexer                        |
  +-----------------------------------------------+
        |
        v
  Splunk Indexer
  +-----------------------------------------------+
  |  Stores events in sap_logserv_logs index      |
  +-----------------------------------------------+
        |
        v
  Splunk Search Head
  +-----------------------------------------------+
  |  LogServ App: dashboards + field extractions  |
  +-----------------------------------------------+
```

## :material-circle-box:{ .taiconcolor } Index-Time Filtering

The Data TA provides built-in index-time filtering that lets you control which log types are indexed. Filtering happens on the Heavy Forwarders using TRANSFORMS-based queue routing:

- **Include patterns** -- Only ingest log types that match the pattern (e.g., `linux/*` to include only Linux logs)
- **Exclude patterns** -- Drop specific log types (e.g., `linux/cron` to exclude cron logs)
- **Days in past** -- Drop data older than a specified number of days based on the S3 object path date

Filtered events are routed to `nullQueue` and never consume Splunk license. Filter settings are configured on the Deployment Server and pushed to Heavy Forwarders automatically.

See [Configuring Filters](../install-setup/configure-filters.md) for detailed setup instructions.

## :material-circle-box:{ .taiconcolor } Sourcetype Routing

All SAP LogServ data arrives in a single generic format. The Data TA examines each event's metadata during index-time parsing and routes it to the appropriate Splunk sourcetype. Routing is defined in `transforms.conf` using regex-based sourcetype assignment.

Two routing strategies are used:

- **Source-path matching** -- For log types with unique `source` field values (e.g., `/var/log/messages` for Linux syslog, `/var/log/squid/access.log` for Squid proxy)
- **Classification field matching** -- For SAP application logs that share similar source paths, routing matches the `clz_dir` and `clz_subdir` fields in the NDJSON envelope. When the same `clz_subdir` value appears under multiple `clz_dir` paths (e.g., `audit` exists under both `abap/` and `scc/`), compound lookahead regexes match both fields simultaneously to avoid collisions.

For the complete list of supported log types and their sourcetype mappings, see [Supported Log Types](supported-log-types.md).

## :material-circle-box:{ .taiconcolor } React App Architecture

The LogServ App is built as a React application. The Data TA architecture is independent — only the UI tier uses React.

**Stack:**

  - **Build pipeline:** webpack-based bundle build atop `@splunk/webpack-configs`. Each Splunk app page resolves to a single React bundle.
  - **UI primitives:** `@splunk/react-ui` (forms, tables, modals), `@splunk/visualizations` (charts), `@xyflow/react` (Topology graph), `styled-components` for theming.
  - **State management:** React context for cross-cutting concerns (AI Assistant, time range, refresh ticker); `useState` / `useReducer` for component-local state. No Redux.
  - **Data fetching:** custom `useSearch` hook wraps `@splunk/search-job` for SPL dispatches; results expose `rows / loading / error` to consuming components.
  - **Routing:** React Router 7 with `HashRouter` so URLs survive Splunk Web's app-namespace routing; query strings carry time-range hydration (`?earliest=...&latest=...`).

**Build-time feature flags:**

The build supports compile-time variants. The first such flag is `TEMPLATES_ONLY`: when set, the resulting bundle has the AI Assistant's free-form / LLM-driven flow disabled at compile time, NOT runtime — there is no runtime setting that could re-enable it. See the [Templates-only Build](../ai-assistant/templates-only-build.md) page for the user-facing implications.

**Static-asset cache busting:**

Splunk Web caches the React bundle's asset URL by an integer `[install] build` field in `app.conf`. Every meaningful code change bumps this number; without bumping, browsers serve stale bytes after deploy. The 3-part SemVer in `[id] version` is independent of the build number and changes only on user-facing version bumps.

## :material-circle-box:{ .taiconcolor } AI Assistant Architecture

The AI Assistant is a chat-style panel embedded in the React UI App that lets analysts run pre-canned investigations + free-form prompts against their Splunk data. It has two distinct paths and a strong privacy invariant.

**Privacy invariant — type-system-enforced, not policy-enforced:**

```
User question  -->  AI vendor  -->  AI picks tools  -->  MCP server  -->  Splunk
                       |                                       |
                       |  <----  Hidden<MCPToolResult>  <------+
                       |
                       v  (sanitize chokepoint: count + timing only — Tier 1)
                       |  (or aggregated metadata — Tier 2)
                       v
                  AI synthesizes narrative reply
```

Tool results from the Splunk MCP Server are typed `Hidden<MCPToolResult>` in TypeScript. The compiler refuses to put a `Hidden<T>` value into the outbound vendor payload — the only way to convert it is via `sanitize(hidden, summarizer)`, which forces the caller to provide a non-data summary. The summarizer is gated by the active **privacy tier**:

  - **Tier 0 (Ollama, future)** — air-gapped local LLM; no vendor traffic at all.
  - **Tier 1 (default)** — summary is `count + execution_time` only. AI sees no values.
  - **Tier 2 (admin opt-in)** — summary adds aggregated metadata (per-column cardinality, top-N values + counts for categorical, min/max/avg/sum for numeric, time range when `_time` is present). Still no raw rows.

**Two paths:**

  - **Predefined prompts (no LLM call):** the user opens the prompt browser and clicks one of the 48 cataloged prompts. The orchestrator dispatches the saved search via the Splunk MCP Server, renders the result tile in the right pane, and appends a static interpretation + suggested-next-steps card. **No vendor LLM is invoked.** This is the path used in the templates-only build.
  - **Free-form prompts (LLM-driven):** the user types a natural-language question. The orchestrator sends the system primer + user message + tool definitions to the active vendor (Anthropic / OpenAI / Azure OpenAI / AWS Bedrock). The vendor picks tools, the orchestrator dispatches them in parallel via MCP, the vendor sees only the privacy-tier summary, and the vendor synthesizes a narrative response.

**Audit log:**

Every AI Assistant action — both paths — produces audit events into a dedicated `logserv_ai_assistant_audit` index. Categories include `local_only` (canned-prompt dispatches), `vendor_tier1` / `vendor_tier2` (LLM calls with token counts + USD cost estimate), `security_blocked_spl`, `user_prompt_jailbreak_flag`, `session_tool_cap_hit`, `daily_spend_cap_hit`, `audit_forwarder_failure`, plus three legal-acknowledgement categories. The Audit Log tab in Settings provides an in-app browser; an optional HEC forwarder can stream events to a separate Splunk / SIEM destination for tamper-evidence.

**Splunk MCP Server prerequisite:**

The AI Assistant requires [Splunk MCP Server (Splunkbase App 7931)](https://splunkbase.splunk.com/app/7931) v1.1.0 or later, installed on the same search head as the LogServ App. Cookie auth from the same Splunk Web session works by default on HTTP-only Splunk; an optional bearer token can be configured for OAuth-strict environments. See [Splunk MCP Setup](../ai-assistant/mcp-setup.md) for end-to-end configuration and troubleshooting.

## :material-circle-box:{ .taiconcolor } Environment Topology Architecture

The Environment Topology view (also accessible via URL slug `integration-topology` for backward compatibility) is a graph-based visualization of SAP systems, integration partners, and endpoints across the SAP landscape. It is implemented as a React component on top of `@xyflow/react`.

**Data sources:**

The view assembles its node + edge inventory from a union of six SPL searches against the existing sourcetypes (no new ingest required):

  - **`sap:abap:gateway`** — RFC peer/local IPs (`P=<peer>` / `L=<local>` fields)
  - **`sap:abap:icm`** — ICM peer/local IPs
  - **`sap:hana:tracelogs`** — HANA host + tenant SID extracted from the source path (`/usr/sap/<HANA_SID>/HDB<inst>/<host>/trace/DB_<TENANT_SID>/`)
  - **`sap:saprouter`** — peer hostname extracted from the parens after `host <ip>/<service> (<resolved.host>)`
  - **`linux_messages_syslog`** with osquery cpu_brand events — host inventory (CPU, RAM, OS, region, AZ, instance ID)
  - **Default Splunk `host` field** — fallback for hosts not surfaced in the above

**Self-derived IP→SID inventory:**

The "which IP belongs to which SID" mapping is derived from a multi-source `union` SPL with a `mvcount(sids)=1` filter — a host whose multiple sourcetypes all agree on a single SAP SID is unambiguously attributed; otherwise it's surfaced as "unknown". Resolution depends on what your data exposes: unique hostname/IP appearances across multiple SAP sourcetypes (HANA tracelogs, ABAP gateway L=, ICM peer fields, saprouter peer hostnames) attribute cleanly, while shared NAT IPs and external partners typically remain unknown. Additional inventory sources can be added by appending another `union` arm — the inventory framework is extensible per-customer without new ingest.

**Saved layouts:**

User-arranged graph layouts are persisted via Splunk KV Store collection `logserv_topology_layouts`. The schema (currently v4) carries node positions, panel state, viewport zoom + pan, enabled integration types, selected node, active right-sidebar tab, and snap mode. Layouts are per-user-named (an admin can save a default layout that other users see; users can save their own variants). Schema migration is in-memory: v1 / v2 / v3 records still load.

**Data refresh:**

Topology data is populated by three hourly scheduled saved searches (`logserv_topology_aggregate_nodes / _edges / _inventory`, cron `5 * * * *`) that write to the KV Store collections. The view re-reads the KV Store on initial mount, on global TimeRange picker change, and whenever the user clicks the toolbar's **Refresh** button. There is no auto-polling — Splunk's hourly cron is what governs data freshness. The previous Live | Lookup toggle was removed in session 044 because the underlying data only changes hourly, so client-side polling at 30s intervals re-rendered the same data 119 times per hour. Per-node detail panels (right sidebar tabs) continue to re-fetch via on-demand SPL whenever a node is selected.
