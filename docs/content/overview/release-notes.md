# Release Notes


## Version 0.0.5 (latest)

!!! warning "AI Assistant LLM functionality intentionally disabled pending review"
    The v0.0.5 release ships with the AI Assistant's **LLM-driven path disabled at compile time pending internal review** of the OWASP LLM Top 10 controls. Every customer running v0.0.5 runs the **templates-only build variant** — there is no separate "regular" build published in this release. What's still active: the predefined-prompt path (61 canned prompts via the Splunk MCP Server), tool tiles in the right pane, drill-down chips, audit log, all 21 dashboards + the Environment Topology view, per-dashboard auto-refresh picker, Download PNG. What's disabled: free-form chat input, the model picker, the Power Mode toggle, the Provider Credentials Settings tab, and all vendor (Anthropic / OpenAI / Azure / Bedrock) traffic. The LLM-driven path will be re-enabled in a future release once review concludes — the type-system enforcement, privacy tiers, and OWASP Top 10 hardening are designed and implemented, just gated off via the build flag for now. See the **AI Assistant → Templates-only Build** docs page and the **AI Assistant → OWASP LLM Top 10 Compliance** page for the full picture.

### :material-circle-box:{ .taiconcolor } Compatibility

|                                  |                              |
|----------------------------------|------------------------------|
| Splunk platform versions         | 9.4.3 and later              |
| CIM                              | 5.1.1 and later              |
| Supported OS for data collection | Platform independent         |
| Vendor products                  | SAP LogServ for SAP ECS in Amazon Web Services (AWS) and Microsoft Azure |
| AI Assistant prerequisite        | [Splunk MCP Server (Splunkbase App 7931)](https://splunkbase.splunk.com/app/7931) v1.1.0 or later, on the search head where the LogServ App is installed |
| Azure ingest prerequisite        | [Splunk Add-on for Microsoft Cloud Services (Splunkbase App 3110)](https://splunkbase.splunk.com/app/3110) v5.0+, on the Heavy Forwarder tier (Azure deployments only) |

### :material-circle-box:{ .taiconcolor } Major architecture change

**The LogServ App is fully rewritten as a React-based application.** Dashboard Studio v2 is no longer used for any of the 21 dashboards. The app now ships as a single React bundle built on `@splunk/react-ui`, `@splunk/visualizations`, and `@xyflow/react`. The Data TA architecture is unchanged from v0.0.4.x — only the UI App tier has been rewritten.

Implications for upgraders:

  - **Search-time field extractions are unchanged** — your existing custom searches, alerts, and reports against `sap_logserv_logs` continue to work without modification.
  - **Dashboard URLs have changed** — old DS v2 deep links (`/app/splunk_app_sap_logserv/<view>?form.global_time...`) are replaced with React Router hash routes (`/app/splunk_app_sap_logserv/home#/<route>?earliest=...&latest=...`). Time-range query params are preserved.
  - **Splunk 9.4.3+ remains the minimum** version. No new floor.
  - **No data re-ingest required** — the upgrade is UI-only.

### :material-circle-box:{ .taiconcolor } New features

1. **AI Assistant** — Splunk-aware chat panel with two paths:

      - **Predefined prompts** (no LLM call): browse 61 saved searches across three packs (`sap_basis` 15, `security` 28, `operations` 18) plus a context-aware **Dashboard Focused** tab that auto-filters to prompts relevant to the current dashboard. Each prompt dispatches via the [Splunk MCP Server](https://splunkbase.splunk.com/app/7931) and renders a tile in the right pane with a static interpretation + suggested-next-steps card. **No vendor LLM is involved in this path.**
      - **Free-form prompts** (LLM-driven): the same MCP tool path is available to one of four AI providers (Anthropic, OpenAI, Azure OpenAI, AWS Bedrock); the LLM picks tools, the orchestrator dispatches, and the LLM synthesizes a narrative response. **Critical privacy invariant — enforced by the TypeScript type system at build time, not by policy: no event data from your Splunk instance is ever transmitted to any AI vendor.** The compiler refuses to put any tool-result value into the outbound payload — there is no runtime check, no flag to flip.

2. **Three privacy tiers** for the free-form path, admin-selectable in Settings:

      - **Tier 0** — Ollama-based local-only (future release).
      - **Tier 1 (default)** — cloud LLM as SPL generator. Tool result summary fed back is *only* `count + timing`. The AI sees no row data and no aggregates.
      - **Tier 2 (admin opt-in)** — adds aggregated metadata: cardinality, per-column top-N values + counts, min/max/avg/sum (numeric), and time range. Still no raw rows.

3. **Environment Topology** — graph-based view of SAP systems, integration partners, and endpoints. Built on `@xyflow/react` with a force-directed initial layout, self-derived IP→SID inventory drawn from multiple SAP sourcetypes (gateway L=, HANA tracelogs, ICM peer fields, saprouter peer hostnames), per-node sidebar tabs (Programs, Calls/Hr, Errors, Hosts), and named saved layouts persisted via Splunk KV Store (schema v4 — viewport zoom + pan + enabled-types + selected-node + active-tab + snap-mode). Data is refreshed hourly by three scheduled saved searches; manual Refresh button in the toolbar for on-demand re-fetch.

4. **Drill-down chips** — every tool result tile in the AI Assistant's right pane carries a `↗ Dashboard` chip (when a related OOTB dashboard is mapped) and a `↗ Run SPL` chip that opens Splunk's Search app with the dispatched SPL pre-populated and the dispatch's exact earliest/latest pre-applied. Same chips render alongside `[→ saved_search]` citations in the chat narrative on the left pane. Dashboards themselves also got drill-downs: ~70 KPIs / charts / tables / table rows across 19 dashboards open contextual cross-cutting searches with current time range preserved.

5. **Per-dashboard auto-refresh picker** — every dashboard's title row now carries a Refresh picker (Never / 30s / 1m / 5m / 15m / 30m / 1hr) with per-user-per-dashboard cadence persisted to a new KV Store collection (`logserv_dashboard_refresh`). All charts and KPIs re-run on each tick via a shared context nonce.

6. **OWASP LLM Top 10 (2025) compliance** — every item has a matching control. Highlights: prompt-injection sanitization with role-marker + jailbreak-pattern filtering; type-bounded data redaction; a CycloneDX 1.4 SBOM shipped with every build; tamper-evident audit log with optional HEC forwarder; per-user rate limit (configurable, default 30/hr); USD spend cap; SPL static-analysis guard blocking write/delete/alert operators; PII redaction for `email` / `user(name)` / `*_ip` / `mac` / `account` (hostname opt-in); session tool-call cap; jailbreak pattern detection on user input. See [OWASP LLM Top 10 Compliance](../ai-assistant/owasp-llm-compliance.md) for the full controls list per item.

7. **Templates-only build variant** — a deployable variant of the LogServ App that disables the LLM-driven flow at compile time. The MCP path + 61 canned prompts + tool tiles + drill-down chips + audit log all stay fully active so the solution can be demonstrated end-to-end without enabling any LLM provider. UI cues: chat input disabled with explanatory placeholder; Send button disabled; model picker hidden; Power Mode toggle hidden; Provider Credentials Settings tab hidden; cyan info-tone banner explains the build mode. Defense in depth: the LLM dispatch entry point bails immediately with a system notice if reached at runtime.

8. **Power Mode** — role-gated `✦ Power` toggle in the AI Assistant chat input. Admin assigns a list of Splunk roles (via `services/authorization/roles`) that may see the toggle; when on, every prompt forces a saved-search dispatch before LLM synthesis (forced-RAG). State persists per-tab in sessionStorage. Audit events tag the toggle state for SOC pivot analysis.

9. **TIME-WINDOW REASONING primer rules** — the AI Assistant's system primer (Tier 1 + Tier 2) now teaches the LLM to: (a) identify the dispatch window before claiming severity, (b) normalize cumulative count to events/hour or events/day before ranking, (c) for any finding ranked `[severity:high]` or `[severity:critical]`, dispatch ONE additional verify query with `earliest=-24h latest=now` BEFORE writing the narrative, and (d) state the window precisely in narrative ("X events in the last 24h" vs. "X cumulative over the search's rolling window"). The result: the AI now self-corrects in one turn instead of needing a follow-up prompt to re-rank cumulative-noise findings.

10. **HostDetails multi-host filter + 3-tab layout** — the Host Details dashboard's host picker is now a `Multiselect` with filter input + Select-All-Matches semantics. Multi-host scope is reflected in URL (`?hosts=h1,h2,h3`) with localStorage persistence. SPL builders splice a `host IN (...)` clause when 2+ hosts are selected. Three tabs: **Overview** (5 KPIs + charts + Host Inventory + Severity Timeline), **Role Activity** (7 role-specific panels with `hideWhenNoData`), **Sourcetype Mapping** (Sankey of source → sourcetype).

11. **Data Pipeline Overview dashboard-wide host filter** — Multiselect + Top-N picker lifted from the chart-level actions slot to the dashboard's title row. Filter scope expanded from one chart to all 4 KPIs + 4 panels + the Sourcetype Mapping linked graph on the second tab.

12. **Path B sourcetype migration** — the legacy `[set_srctype_for_syslog]` transform has been split into four dedicated routing transforms producing four new sourcetypes: `linux:cron`, `linux:warn`, `linux:sudolog`, `linux:slapd`. This clears the AppInspect pretrained-sourcetype warning and avoids field-extraction collisions with `Splunk_TA_nix`'s built-in `[syslog]` stanza. Existing `sourcetype=syslog` data ages out per index retention; dashboards OR both old + new during the transition.

13. **Branded LS app icons** — orange "LS" mark on a dark rounded-square frame. Both the UI App and the Data TA ship the same icon set at 36×36 + 72×72 in regular + Alt variants.

14. **Splunk-pattern legal acknowledgement** — two compile-time legal/liability modals gate the master `enabled` toggle and the audit-forwarder-disabled save (matching Splunk's `splunk_instrumentation` `optInVersion` framework). User identity, Splunk-stamped IP, timestamp, and a SHA-256 of the disclaimer revision are recorded in the audit log so subsequent acknowledgement reviews can prove which revision was acknowledged.

### :material-circle-box:{ .taiconcolor } Enhancements

1. **21 React-based dashboards plus the new Environment Topology view** — every one of the 20 v0.0.4.2 dashboards is a fresh React implementation, a new Multi-Cloud Overview dashboard was added (21 dashboards in total), and the Environment Topology view is a new graph-based surface unique to v0.0.5. All dashboards use the unified dark theme (`#0d1117` page background, `#141b2d` panel fill, `#0877a6` panel outline) and ship the per-dashboard auto-refresh picker.
2. **Saved-Layout schema v4** — the topology view's saved layouts now persist viewport (zoom + pan), enabled integration types, selected node, active right-sidebar tab, and snap-mode in addition to the v3 node + panel positions. Schema migration is in-memory: v1 / v2 / v3 records still load.
3. **`Multiselect` + `Top-N` picker** as a reusable title-row pattern — labelless inline cluster matching the visual idiom across HostDetails and Data Pipeline Overview.
4. **AI Assistant prompt browser tab persistence** — the last selected pack tab is remembered across modal-open events, persisted per-tab via sessionStorage. Persists only when the user actually picked a prompt, not on casual tab-flipping.
5. **Static guidance card per canned prompt** — each predefined prompt's intent-map entry includes an `interpretation` paragraph + bulleted `nextSteps`. Surfaced as a "How to read this result" card after the tool tile lands. Skipped on the AI-driven path (the LLM writes its own commentary). 126 next-step entries split: 64 plain · 57 canned-prompt links · 5 custom-SPL links.
6. **Dashboard Focused prompt browser tab** — first-position tab in the prompt browser that filters the 61 prompts down to those mapped to the current dashboard. Auto-hides when no prompts match. Pack-origin chips on each card so users can find the prompt back in its home pack.
7. **Audit Log Settings tab** — read-only browser of the `logserv_ai_assistant_audit` index with time-range / category / user / limit filters; per-row JSON expand. Inline disclaimer covers the tamper-resistance threat model and recommends HEC-forwarder mitigation. 12 audit categories with distinct gradient-fill chip colors.
8. **HEC audit forwarder** — admin-configurable forwarding of audit events to a separate Splunk / SIEM / S3-with-Object-Lock destination. Browser-side dual-write at flush time. Failure events captured as a separate `audit_forwarder_failure` category so disabled / down forwarders are visible in the audit log itself.
9. **`Visible<T>` brand types** — outbound-message types are tagged `Visible` and unwrap explicitly; the type system refuses to put a `Hidden<MCPToolResult>` into an outbound vendor payload, mechanically enforcing the privacy boundary.
10. **Dynamic timechart span** — every time-series chart's SPL passes a `timechartSpan` computed from the current time range so 30-day windows don't render with 700 data points. Helper at `utils/timechartSpan.ts`.

### :material-circle-box:{ .taiconcolor } Fixed issues

1. **Stale aggregate framing in AI Assistant top-N responses** — the LLM previously cited cumulative aggregates ("4,799 failed authentications") as if they were active rates, leading to misleading "lock the accounts today" recommendations. Build 171's TIME-WINDOW REASONING primer rules now force a verify query before high-severity claims, and the same cumulative number gets correctly downgraded with explicit "stale long-window aggregate, not an active brute-force" framing.
2. **Splunk risky-command safeguard on `nextSteps.spl`** — two intent-map deep-dive strings used `| map maxsearches=1 search="..."` which Splunk flags as risky. Rewrote to first-class subsearch syntax. Intent map version bumped v0.0.8 → v0.0.9.
3. **AZ field bleeding into next osquery section** — the Host Inventory panel's `zone` regex now stops at the `#012` osquery section separator (`[^,#]+` instead of `[^,]+`), so AZ values like `ap-south-1a` no longer carry trailing data from adjacent fields.
4. **MCP cookie auth on same-session HTTP-only Splunk** — verified empirically that the Splunk MCP Server v1.1.0 accepts cookie auth from the same Splunk Web session that's serving the React app, so the default `mcp_server_url` works on HTTP-only Splunk with no bearer token configured. The optional bearer token layers on top via `Authorization: Bearer` and is invalidated on 401 with one retry.
5. **Splunk `services/authorization/roles` endpoint** — Multiselect for the Power Users field reads roles from the correct path; `services/authentication/roles` (a common typo) silently 404s and produces a stuck "Loading roles..." UI.
6. **Splunk Web static-asset cache busting** — every meaningful code change bumps `[install] build` in `app.conf` so browsers don't serve stale bytes after deploy.
7. **Webpack `style-loader` requirement** — adding `import '@xyflow/react/dist/style.css'` exposed a latent webpack-config gap where CSS was being compiled but never reaching the DOM. Both `style-loader` AND `css-loader` are now in the webpack rules.

### :material-circle-box:{ .taiconcolor } Restyled (visual conventions)

1. **21 React dashboards** with the unified dark-theme card style: `#0d1117` page, `#141b2d` panel fill, `#0877a6` panel outline, 3 px rounded corners, 5 px inset, 12 px panel gaps. Equivalent to the v0.0.4.2 DS v2 look but rebuilt natively in styled-components.
2. **Severity dots** — chat findings render with a colored dot (yellow → orange → red → dark-red for low → medium → high → critical) using a radial gradient so they read as glossy beads matching the donut-chart palette aesthetic.
3. **Win11-style 8-dot loading spinner** — replaces the prior cyan-arc indicator in AI Assistant streaming + tool-executing states. CSS-only via single keyframe + per-dot `--angle` variable + staggered `animation-delay`. Reused in the Topology canvas loading overlay (extracted to a shared `Spinner` component).
4. **Cyan-light dotted-underline citation links** — the AI's `[→ saved_search]` citations render as clickable scroll-to-tile spans; sibling `↗ Dashboard` and `↗ Run SPL` chips use the same visual idiom.
5. **Compact Multiselect with Select-All-Matches** — HostDetails + Data Pipeline Overview both use `@splunk/react-ui/Multiselect` with `compact + filter + selectAllAppearance="checkbox"` so typing into the filter narrows the dropdown and the Select All control auto-renames to "Select all matches".
6. **Glossy severity-dot gradients** — `radial-gradient(circle at 35% 30%, ...)` so dots read as 3D beads not flat circles.
7. **Audit-log filter chips with per-category gradients** — 12 categories each get a distinct 3-stop linear gradient with mid-stop ~35–45% luminance for white-text readability, dim-when-unchecked via layered translucent-black wash so the text stays readable.

### :material-circle-box:{ .taiconcolor } Known issues

1. **Tier 0 (Ollama, air-gapped)** is not yet shipped. Tier 0 currently returns "not yet implemented" if selected. Planned for a future release.
2. **`hideWhenNoData` panel-disappearance behavior** continues to apply on HostDetails Role Activity tab. Expected behavior, but empty tabs can feel sparse on hosts that only forward a single sourcetype.

### :material-circle-box:{ .taiconcolor } Splunk Cloud compatibility hardening

Post-initial-release iterations within the v0.0.5.0-beta line that brought the packages to Splunk Cloud Victoria 10.x install-ready posture. All changes are backwards-compatible with on-prem Splunk Enterprise — admins on Enterprise see zero behavior change.

1. **Splunk Cloud Victoria install support** — both the LogServ App and the Data TA now pass `splunk-appinspect inspect --mode precert --included-tags cloud` cleanly. Posture: App = 0/0/0/8/112 (errors / failures / future_failures / baseline warnings / success); Data TA = 0/0/0/11/131. Cleared a Cloud-Victoria-only runtime failure where the LogServ App's Mako template at `appserver/templates/home.html` was being stripped by the Cloud edge proxy because it contained a `<% page_path = ... %>` Python code block (Splunk Cloud Victoria enforces no Python code blocks in Mako templates at runtime, even though `splunk-appinspect` flags it only as a warning). The fix inlines the page-path expression directly into `${make_url(...)}`. Without this, the home view returned HTTP 500 with `TopLevelLookupException` on Splunk Cloud Victoria.

2. **ISC BIND + Squid parsing absorbed natively** — the parsing from the (archived) Splunk Add-on for ISC BIND v2.0.0 and Splunk Add-on for Squid Proxy v2.1.0 is now bundled in the LogServ App, eliminating the need to install those separately. See [Supported Log Types → ISC BIND](../getting-started/supported-log-types.md#isc-bind-iscbind) and [→ Squid Proxy](../getting-started/supported-log-types.md#squid-proxy-squidaccess). Customers who have either standalone TA installed will see a one-time dismissible banner on the LogServ App home view recommending uninstall (otherwise both TAs' parsing runs in parallel, causing duplicate field extraction).

3. **`sc_subadmin` enablement across both packages** — Splunk Cloud Victoria deployments commonly reserve `sc_admin` for Splunk Cloud Operations staff, leaving `sc_subadmin` as the customer's effective top admin role. Both packages now ship with `sc_subadmin` in their `metadata/default.meta` write ACL (`write : [ admin, sc_admin, sc_subadmin ]`). The Data TA's `metadata/default.meta` is post-build-patched by `additional_packaging.py` because UCC's stock build template would silently overwrite the source-level value; a standalone repair script also exists at `tools/scripts/patch_data_ta_sc_subadmin_metadata.py` for patching already-built tarballs. The Data TA's `[script:splunk_ta_sap_logserv_deployment_push]` capability also changed from `admin_all_objects` to the Splunk-standard `edit_deployment_server` so the in-app deployment-push UI works for customer-tier admins. See [Splunk Cloud Victoria Notes](../install-setup/splunk-cloud-victoria-notes.md) for the full role-tier mapping.

4. **AI Assistant settings + T&C acknowledgements migrated to KV Store** — Splunk's REST framework hardcodes `admin_all_objects` as a capability gate on `/configs/conf-X/` writes, IN ADDITION TO the object metadata ACL. On locked-down Splunk Cloud Victoria deployments where `sc_subadmin` doesn't hold `admin_all_objects`, every conf-file write would 403 — including AI Assistant Settings → Save Defaults and every legal-T&C modal Submit. The two mutable conf-file backed stores have been migrated to KV Store collections (`logserv_ai_assistant_settings`, `logserv_ai_assistant_acks`), which check only the collection-level metadata ACL — no capability requirement. A one-shot migration helper in `App.tsx` copies any pre-migration `local/*.conf` values into KV Store on first page load post-upgrade, so customers don't lose customizations or re-prompt on legal modals. See the [Splunk Cloud Victoria Notes](../install-setup/splunk-cloud-victoria-notes.md) page (section "AI Assistant settings + T&C acks in KV Store").

5. **`useIsAdmin` recognizes `sc_admin` + `sc_subadmin`** — the React UI's admin-gating hook (`hooks/useIsAdmin.ts`) expanded from a strict `roles.includes('admin')` check to `roles.some((r) => ADMIN_TIER_ROLES.includes(r))` with `ADMIN_TIER_ROLES = ['admin', 'sc_admin', 'sc_subadmin']`. Without this, the AI Assistant Settings page would have rendered a 403 "Admin access required" fallback for customer-tier Splunk Cloud admins.

6. **Audit-index renamed `logserv_ai_assistant_audit`** — across two hops: `_ai_assistant_audit` → `ai_assistant_audit` (dropped the underscore prefix because AppInspect's `check_lower_cased_index_names` rejects custom-app indexes starting with `_`) → `logserv_ai_assistant_audit` (added the `logserv_` namespace prefix so the index can't collide with any other app that happens to define a generic `ai_assistant_audit`). Functional behavior unchanged across all three names. Both indexes the Data TA provisions are macro-configurable via `sap_logserv_idx_macro` and `sap_logserv_audit_idx_macro`. Customers with existing audit data under either of the older index names will see that data become orphaned on disk after upgrade — not queryable via the new name. Audit retention horizons are typically short and a clean break is acceptable.

7. **Splunk MCP Server JWT `aud = mcp` requirement documented** — Splunk Cloud Victoria's edge proxy auto-injects a JWT into every `/__raw/` splunkd request, and the Splunk MCP Server (Splunkbase App 7931) validates the `aud` claim against the literal `"mcp"`. Common Splunk Cloud Victoria default audiences (e.g., `"Demo"` on non-production stacks) cause the MCP health probe to receive a 403 `Invalid token audience` error, which surfaces as the AI Assistant SETUP REQUIRED banner. The fix is customer-side (re-mint the MCP token with `audience=mcp` OR file a Splunk Cloud Support ticket asking them to align the stack's MCP audience). This is a server-side App 7931 configuration; the LogServ App is audience-agnostic. See [Splunk MCP Setup → Splunk Cloud — JWT `aud` claim must be `mcp`](../ai-assistant/mcp-setup.md#splunk-cloud-jwt-aud-audience-claim-must-be-mcp).

8. **Data TA Cloud-vetting fixes** — cleared 6 pre-existing AppInspect failures + 2 future_failures that had been blocking the Data TA on Splunk Cloud: 4-part SemVer corrected to 3-part (`0.0.5`), `python.version = python3` flag added on scripted-input stanzas, `python.required = 3.13` added on scripted inputs + admin_external handlers, `solnlib<8.0.0` pinned in `requirements.txt` to drop AArch64-incompatible protobuf + gRPC + OpenTelemetry binaries that solnlib 8+ pulls in transitively (also cuts Data TA tarball size 82%, from 9.29 MB → 1.55 MB), illegal `maxTotalDataSizeMB` index property removed, executable shell script relocated alongside `additional_packaging.py` (one level up from `package/`) so UCC stops bundling it.

### :material-circle-box:{ .taiconcolor } Microsoft Azure support

The v0.0.5.0 release adds full Microsoft Azure Blob Storage support alongside the existing AWS S3 ingest. Architectural pattern is symmetric with AWS: the LogServ Data TA pairs with the **Splunk Add-on for Microsoft Cloud Services** (Splunkbase App 3110, v5.0+) on the Heavy Forwarder tier, instead of `Splunk_TA_aws`. Validated end-to-end against a real Azure subscription with the production deployment topology (DS → HF distribution, SAS credential HF-local, NOT pushed via DS).

1. **Azure Blob Storage ingest** — the `mscs_storage_blob` input from the Splunk Add-on for Microsoft Cloud Services polls a configured Azure Blob container under the `logserv/` prefix, downloads each new blob (gzipped NDJSON), and emits events with `sourcetype = sap_logserv_logs`. The LogServ Data TA's existing index-time routing transforms then key on the `source` field's `clz_dir/clz_subdir` segments — identical to the AWS S3 pipeline. No new Data TA configuration required; the routing transforms ARE the multi-cloud abstraction layer.

2. **`cloud_provider` indexed-field attribution** — the Azure input stanza sets `_meta = cloud_provider::azure`, which Splunk persists as an INDEXED field on every event ingested through that input. AWS-ingested events have no `cloud_provider` field on disk (legacy data + AWS S3 input pre-dating Azure support); a new search-time macro `sap_logserv_cloud_provider_default_macro` (`eval cloud_provider=coalesce(cloud_provider, "aws")`) provides the AWS default for cross-cloud reporting. Result: every event in the index reports a `cloud_provider` value of `aws` or `azure`, regardless of when or where it was ingested.

3. **Multi-Cloud Overview dashboard** — new platform-tier dashboard surfaces the per-provider ingest split (event count + sourcetype breakdown + recent activity), built on top of the `sap_logserv_cloud_provider_default_macro`. Lives under the **Platform** navigation group as the 23rd registered dashboard. Useful for capacity-planning across cloud providers + confirming the Azure ingest is healthy.

4. **Four authentication recipes documented** — the [Azure Setup Guide](../install-setup/azure-setup.md) covers four Azure auth paths: (a) Account-key + SAS (testing-grade), (b) Shared Access Signature with container scope (production-friendly, time-bounded), (c) Service Principal with `client_secret`, (d) Managed Identity (no credential stored on the HF — preferred for HFs running on Azure VMs / AKS / Azure App Service). Recipes are independent of the rest of the setup; pick whichever fits the customer's Azure security posture.

5. **Production deployment topology table** — same DS → HF distribution pattern as `Splunk_TA_aws`. Splunk_TA_microsoft-cloudservices is distributed by the Deployment Server to the Heavy Forwarder server class; Search Head and Indexer do NOT have the add-on. SAS credentials and account configuration stay in HF-local config (NOT pushed via DS — environment-specific per-HF).

6. **Compact-JSON requirement called out** — the LogServ Data TA's index-time routing transforms use whitespace-strict regex (`(?=.*"clz_dir":"abap")`) that bypasses silently on pretty-printed JSON. The SAP LogServ collector emits compact JSON natively, but any custom intermediate pipeline that re-formats blobs with `": "` separators would land events at the bootstrap `sap_logserv_logs` sourcetype. Customer-facing docs call this out as a warning.

7. **Data TA Cloud Provider tab + `splunk_solution` indexed field** — the Data TA's **Configuration** page gains a second tab, **Cloud Provider**, with a dropdown (AWS / Microsoft Azure / Not set; default Not set) that stamps an indexed `cloud_provider` field on every event the TA processes — a TA-managed alternative to setting `_meta = cloud_provider::aws|azure` per input. On a Deployment Server the selection deploys to Heavy Forwarders via the same **Deploy to Forwarders** flow as the Filters tab. Separately, the Data TA now always stamps an indexed `splunk_solution = splunk_for_sap_logserv` field on every event (no UI; ships active) so events that flowed through this solution remain identifiable even when the same index also receives data from other solutions. Both fields are written at index time via `WRITE_META` transforms on the bootstrap `sap_logserv_logs` sourcetype. `splunk_solution` is intentionally distinct from the per-sourcetype `vendor_product` search-time field that dashboards and CIM mapping use — the two coexist and do not collide. For a mixed-cloud Heavy Forwarder (one HF ingesting both AWS and Azure), leave the dropdown at Not set and attribute per input via `_meta`. See [Configuring Filters → Cloud Provider Attribution](../install-setup/configure-filters.md#cloud-provider-attribution).

See the [Azure Setup Guide](../install-setup/azure-setup.md) for full step-by-step setup, prerequisites, and troubleshooting.

### :material-circle-box:{ .taiconcolor } Splunk Enterprise Security integration

The LogServ App ships an out-of-the-box Splunk Enterprise Security (ES) content pack. Everything is **dual-mode** — it works with or without ES installed: the `action.notable=1` / `action.risk=1` directives silently no-op when ES is absent, and the Risk Notable's `Risk.All_Risk` data-model search returns 0 rows without ES.

1. **CIM compliance** — 18 eventtypes + matching tags route SAP-specific events (and the absorbed ISC BIND + Squid parsers) into the Authentication / Change / Network_Sessions / Web CIM data models. A new `app.manifest` declares a hard dependency on `Splunk_SA_CIM ≥ 5.0.0`. See [CIM Compliance](../enterprise-security/cim-compliance.md).

2. **19 detection correlation searches + 1 Risk Notable + 2 Asset/Identity feeds** — organized as **6 base/starter** searches (HANA privilege escalation, cross-stack auth-failure burst, ABAP gateway anomalous peer, SCC ACCESS_DENIED burst, HANA failed CONNECT spike, Linux OOM-killer burst), **6 cross-stack** detections, **3 threat-intel** searches, and **4 behavioral / anomaly** detections. All emit `action.notable=1` for ES Notable Review and `action.risk=1` for RBA. The Risk Notable threshold search fires a `severity=critical` notable when accumulated risk on a single object reaches ≥ 100 in 24h. Two scheduled saved searches emit Asset & Identity feed CSVs every 4h. See [Correlation Searches & RBA](../enterprise-security/correlation-searches.md).

3. **Threat-intel framework** — three customer-managed CSV lookups (`logserv_ti_malicious_domains`, `logserv_ti_malicious_ips`, `logserv_ti_compromised_credentials`) ship empty and are populated by the customer; the 3 threat-intel correlation searches join DNS / proxy / authentication events against them. No separate Splunkbase install or ES Threat Framework dependency. See [Threat Intelligence Integration](../enterprise-security/threat-intel.md).

4. **Behavioral / anomaly detections** — statistically-baselined (Z-score via built-in SPL `eventstats`, no MLTK dependency) detections for per-user auth volume, per-host webdispatcher response time, per-edge topology call volume, and per-admin off-hours activity. See [Behavioral & Anomaly Detections](../enterprise-security/behavioral-detections.md).

All ES detections are also **AI Assistant-dispatchable** — they appear as prompts in the Security pack of the predefined-prompt browser. See [Enterprise Security Integration](../enterprise-security/overview.md) for the full overview.

### :material-circle-box:{ .taiconcolor } Third-party software attributions

The v0.0.5.0 LogServ App ships with **`THIRD-PARTY-NOTICES.md`** at the root of the installed app directory (and at the root of the GitHub release source tree). The file lists all 1235 unique top-level npm packages bundled with the React app — names, versions, declared licenses, repository URLs, and full LICENSE / NOTICE / COPYING text where available. License posture: 1012 MIT, 64 ISC, 57 Apache-2.0, 46 BSD-3-Clause, 22 BSD-2-Clause, 11 `@splunk/*` (covered as a Splunk Extension under §1.C of Splunk General Terms), plus a long tail of permissive licenses. **No GPL / AGPL / LGPL components.** See [Third-Party Software](third-party-licenses.md) for the full license-distribution summary and refresh policy.

A CycloneDX 1.4 SBOM (`SBOM.json`) is also regenerated on every build and shipped inside the package alongside `THIRD-PARTY-NOTICES.md`.


## Version 0.0.4.2-beta

### :material-circle-box:{ .taiconcolor } Compatibility

|                                  |                              |
|----------------------------------|------------------------------|
| Splunk platform versions         | 9.4.3 and later              |
| CIM                              | 5.1.1 and later              |
| Supported OS for data collection | Platform independent         |
| Vendor products                  | SAP LogServ for SAP ECS in Amazon Web Services (AWS) |

### :material-circle-box:{ .taiconcolor } New features

1. **3 new SAP service sourcetypes** — `sap:sapstartsrv` (SAP Start Service / Host Control Agent with auth and SSL/TLS negotiation fields), `sap:saphostexec` (SAP Host Agent execution logs), and `sap:saprouter` (SAP Router connection and trace logs). These cover the `sap/sapstartsrv`, `sap/saphostexec`, and `sap/saprouter` log types in the LogServ S3 bucket.
2. **28 total sourcetype routing transforms** with `@logserv_filter` annotations for index-time filter support.
3. **~176 total search-time directives** (EXTRACT, EVAL, FIELDALIAS) across all SAP-specific sourcetypes in the LogServ App.
4. **15 new dashboards** in the LogServ App, bringing the total to **20**. Dashboards are organized into 4 purpose-driven navigation groups plus a top-level Environment Health landing page (reorganized from the previous 3-group structure so that the top menu is balanced and each group answers a specific class of question):
      - **Top-level** — Environment Health (default landing)
      - **Applications (5 dashboards)** — the SAP app runtime itself: ABAP Network & Security, ABAP Operations, **Work Process Performance** (new), HANA Audit, HANA Trace
      - **Integration (5 dashboards)** — how SAP talks to other systems: SAP Services, **SAP Router** (new), Cloud Connector, Web Dispatcher, **Web and API Performance** (new)
      - **Security (3 dashboards)** — cross-source synthesis for security posture and compliance: **Network Perimeter** (new), **Cross-Stack Authentication** (new), **Change & Configuration Activity** (new)
      - **Platform (6 dashboards)** — infrastructure, ingest, and forensics: Data Pipeline Overview, DNS Analytics, Linux System & Security, Windows Events, Proxy Analytics, Host Details
5. **6 new dashboards from Phase 2** (added after the original 14):
      - **Cross-Stack Authentication** — unified authentication failure analysis across SAP, HANA, and Windows layers, with per-layer KPIs, source-IP aggregation, and per-layer recent-failure tables
      - **SAP Router** — SAP Router connection activity, error analysis, and network boundary monitoring (separated out of SAP Services to give router its own investigation surface)
      - **Work Process Performance** — SAP ABAP work process utilization with all 13 SAP-standard dev_w* trace category codes, dispatcher health, and function-level activity
      - **Web and API Performance** — Web Dispatcher four-stage request timing (`dt1`-`dt4`), response-time percentiles, TLS version and cipher-suite distributions, and a cross-source panel overlaying HTTP error rate against Cloud Connector auth failure rate
      - **Network Perimeter** — unified network-boundary view synthesizing firewall drops, proxy outbound traffic, and DNS resolution into one dashboard; includes firewall-drops-by-protocol, top outbound domains with byte volumes, and a cross-source Suspicious Activity Indicator table ranking internal hosts by combined beaconing-DNS + denied-proxy signal score
      - **Change & Configuration Activity** — compliance-focused audit trail unifying HANA user/role/privilege/DDL changes, Windows account and group modifications (15 canonical security EventCodes), and Linux sudo + useradd/usermod/userdel/passwd activity; includes source-prefixed operator identities, a category taxonomy, and two compliance-focused "Recent" tables (Privileged Changes + After-Hours Changes)
6. **Environment Health dashboard** — Cross-cutting operations view with 6 KPIs, 6 category-specific error trend charts (ABAP, HANA, Security, Web/Network, Cloud Connector, OS/Infra), critical events table, host error matrix, and performance panels. Every panel drills down to the relevant detailed dashboard. Now set as the default landing page.
7. **Tabbed Data Pipeline Overview** — Two tabs: "Overview" (5 KPIs + 14-column Sourcetype Summary table + Host Latest Activity) and "Linked Graph" (full-width source-to-sourcetype link graph). The Sourcetype Summary table includes Status (Fresh/Stale/Very Stale), Trend sparkline, % of Total, Avg/Day, Volume, App Errors, Hosts, Sources, Events (1h), First Seen, Last Seen, and Lag columns.
8. **HANA Audit security panels** — Three new panels surface the rich `sap:hana:audit` field set: Risk-Tiered Event Timeline (stacked column by `risk_level`), After-Hours / Weekend Admin Activity (table filtered to admin users outside business hours), and High-Risk Events (table of `is_critical=true` events with SQL Statement column).
9. **KPI sparklines** — ~75 KPIs across all 21 dashboards display an inline daily-trend sparkline below the headline number, using a single-source `timechart + eventstats` pattern. Five flavors: count-based, distinct-count, rate, formatted-volume, and per-day re-detection. One acknowledged exception: the Linux "Top Drop Source" KPI is a string value (`<IP> (<count>)`) with no sparkline.
10. **Click-through drilldowns** — Most KPIs, table rows, and chart points open a filtered Splunk search. Clickable table cells carry a cyan accent so the drilldown affordance is visible.
11. **KPI single values** added to DNS Analytics (Total Queries, Unique Clients, Beaconing Domains), HANA Audit (Total Events, Failed Operations, Active Users), and Web Dispatcher (Total Requests, Error Rate, Avg Response Time). Access Denied Events KPI added to Cloud Connector; Top Drop Source KPI added to Linux.
12. **Enhanced DNS Analytics** — Top Queried Domains, Top Clients by Domain Diversity (DGA detection), Query Type Distribution, and Top DNS Resolvers table.
13. **Enhanced HANA Audit** — Top Users by Activity, Activity by Hour of Day (after-hours detection), and Client IP Analysis.
14. **Enhanced Web Dispatcher** — Request Volume Over Time, Top URIs by Request Count, and Recent Errors (4xx/5xx).
15. **Host Details — 3-tab expansion** — The Host Details dashboard is now organized into three tabs. **Overview** shows a 5-KPI row (Total Events, Data Volume, Active Sourcetypes, Errors/Criticals, Auth Failures), the Host Event Count by Sourcetype timeline, a cross-source Severity Timeline, Host Inventory (CPU/RAM/EC2/OS/region from osquery), Recent Authentication Events + Recent Errors & Criticals cross-source tables, Top Sources, Activity by Hour of Day, and Data Freshness per sourcetype. **Role Activity** contains seven role-specific panels (HANA Audit Activity, ABAP Work Process Mix, Web Dispatcher Traffic by Status, SAP Router Peers, Windows Event Codes, Sudo Commands, DNS Top Queries) that auto-hide via `hideWhenNoData` when the selected host has no data for that component. **Sourcetype Mapping** houses the full-width Sankey chart that was previously inline.
16. **Cross-dashboard navigation** — Every dashboard includes a Navigate to Dashboard dropdown with Go button that preserves the selected time range when switching between dashboards.
17. **In-dashboard documentation link ("More Info" button)** — A cyan **More Info** button in the top-right of every dashboard's toolbar row opens the corresponding online-documentation section in a new browser tab. The link targets the dashboard's section within the appropriate category page (`.../dashboards/applications/#<dashboard-slug>`, etc.) so users can jump from a live dashboard to its narrative documentation in one click. For multi-tab dashboards (Data Pipeline Overview, Host Details) the button appears on every tab.

### :material-circle-box:{ .taiconcolor } Enhancements (per-dashboard restructures)

1. **SAP Services** — Removed the 4 router-related panels (now on the SAP Router dashboard); featured SSL Authentication Failure Sources full-width; replaced Event Volume by Service line chart with a stacked column chart showing Normal vs Errors per service.
2. **Windows Events** — Removed Security Event Actions chart and Top Users table (now on Cross-Stack Authentication); featured Top Event Codes full-width with 7 enriched columns (Event Code, Description, Source log, Severity, Events, Hosts, Last Seen).
3. **Proxy Analytics** — Replaced single-slice donuts (Content Types → Cache Action Distribution column; HTTP Methods → Top Clients by Domain Diversity bar). Added new bottom row: Top URL Domains by Bytes Out + Bandwidth Over Time by Domain.
4. **DNS Analytics** — Replaced the uninterpretable Volume & Packet Size scatter plot with a Top DNS Resolvers table; restructured row 2 to 4 panels including Query Type Distribution donut moved up to pair with the trend chart.
5. **ABAP Operations** — Work Process Categories donut widened to 836 px with bottom legend showing all 13 friendly category names (uses the shared `wp_category_name` props.conf EVAL).
6. **Cloud Connector** — Renamed "Error Rate" → "HTTP Error Rate" to clarify scope; added Access Denied Events KPI (4th KPI in row).
7. **Linux System & Security** — Added Top Drop Source KPI surfacing the highest single-source firewall drop count in `<IP> (<count>)` format (4th KPI in row).

### :material-circle-box:{ .taiconcolor } Fixed issues

1. DNS Analytics beaconing panels now use correct `message_type="Query"` case (was `"QUERY"`).
2. Web Dispatcher data source had hardcoded Unix timestamps; replaced with `$global_time.earliest$`/`$global_time.latest$` tokens.
3. **Work Process Categories labels** — The Work Process Categories panel on the ABAP Operations dashboard now displays meaningful names for all 13 standard SAP dev_w* trace component codes (A = ABAP Processor, B = Database Interface, C = Communication, D = Dispatcher, M = Memory Management, N = Network (NI), O = Enqueue / Lock, Q = RFC Queue, R = Roll Area, S = SQL / Statistics, T = Task Handler, X = RFC / CPIC, Y = Dynpro / Screen). Previously only A/B/C/M were mapped and the rest appeared as single-letter codes. The same `wp_category_name` mapping is now also used on the Work Process Performance dashboard.
4. **KPI panel alignment** — KPI single-value widgets on all three-KPI dashboards are evenly spaced with the rightmost KPI outline aligned to the right edge of panels below.
5. **Right-edge symmetry** — All rows on width=1920 dashboards now cap at R=1910; width=1600 dashboards cap at R=1590. Symmetric 10 px padding on both sides.
6. **HANA Trace component noise filter** — Top Components, Component by Severity, and Source File Hotspots panels now filter out parsing artifacts ("INFO", "of", "service:") that previously diluted real component data.
7. **Ingest Errors KPI on Data Pipeline Overview** — Refined to exclude ExecProcessor noise (which wraps all scheduled-script output as ERROR-level regardless of the script's actual log level). Filters to real Python ERRORs only.
8. **SSL Authentication Failure Sources panel (SAP Services)** — Replaced the previous Sapstartsrv SSL/TLS Events panel which showed empty columns due to mismatched field extractions. Now aggregates by source IP using fields that actually exist in the data (auth_user, remote_ip, remote_port) and provides row drilldown to the full event set per IP.
9. **Empty-safe KPI pattern** — All count-based and dc-based KPIs now display `0` instead of `###` when the underlying search returns no events (uses a synthetic-row appendpipe wrap).

### :material-circle-box:{ .taiconcolor } Restyled (visual conventions)

1. **Dashboard "card" style** — All 21 dashboards use a unified visual treatment: `#0d1117` page background, `#141b2d` panel fill, `#0877a6` panel outline, rounded corners, 5 px inset between rect frame and inner viz.
2. **KPI typography standardized** — `majorFontSize: 36`, explicit `labelColor: #7b8ea8`, `labelFontSize: 13`, semantic `majorColor` (`#dc4e41` red for errors, white for neutral counts, orange for warnings, teal for positive signals). The Linux Top Drop Source KPI uses `majorFontSize: 28` as an acknowledged exception for its long-text string display.
3. **Standard red consolidated** — All red color variants (`#e86c5d`, `#af575a`, `#ff3b30`, `#ff2d55`) normalized to single hex `#dc4e41`.
4. **Tables** — Hardcoded header background (`#1e2a3d`), zebra-stripe alternating rows (`#0d1520` / `transparent`), fixed header. Cyan accent on clickable cells indicates drilldown affordance.
5. **12 px panel gaps** — Exact horizontal and vertical spacing between every panel border across all dashboards.
6. **Dashboard descriptions** — Every dashboard now displays a 1-line description below its title.
7. **"Go >" navigation button** — Standardized: 120×25 px at top-left of every dashboard with 10 px padding above and below; majorFontSize 16.
8. **"More Info" documentation button** — Standardized: 140×25 px at top-right of every dashboard, aligned with the right edge of the canvas (10 px padding from the right; x = canvas_width − 150). Same cyan fill `#0877a6`, white text, majorFontSize 16 as the Go button. Opens the dashboard's online-documentation section in a new browser tab via `drilldown.customUrl` with `newTab: true`.

### :material-circle-box:{ .taiconcolor } Known issues

1. The dashboards in the LogServ App use Dashboard Studio v2 format and require Splunk 9.4.3 or later.
2. Several Host Details panels (Host Inventory, Recent Authentication Events, Recent Errors & Criticals, and all seven Role Activity panels) use `hideWhenNoData` and will disappear for hosts that lack the underlying sourcetype data. For example, a Windows host without osquery data will not show the Host Inventory panel; an ABAP-only host will not show the HANA Audit Activity panel on the Role Activity tab. This is the dashboard adapting to the selected host's role — not a bug — but empty tabs can feel sparse on hosts that only forward a single sourcetype.

### :material-circle-box:{ .taiconcolor } Third-party software attributions


## Version 0.0.4.1-beta

### :material-circle-box:{ .taiconcolor } Compatibility

|                                  |                              |
|----------------------------------|------------------------------|
| Splunk platform versions         | 9.4.3 and later              |
| CIM                              | 5.1.1 and later              |
| Supported OS for data collection | Platform independent         |
| Vendor products                  | SAP LogServ for SAP ECS in Amazon Web Services (AWS) |

### :material-circle-box:{ .taiconcolor } New features

1. **12 new SAP application sourcetypes** — 9 SAP ABAP types (`sap:abap:audit`, `sap:abap:dispatcher`, `sap:abap:enqueueserver`, `sap:abap:event`, `sap:abap:gateway`, `sap:abap:icm`, `sap:abap:messageserver`, `sap:abap:sapstartsrv`, `sap:abap:workprocess`), 1 HANA trace type (`sap:hana:tracelogs`), and 2 SAP Cloud Connector types (`sap:scc:audit`, `sap:scc:http_access`).
2. **Compound lookahead routing** — New routing pattern for log types where the same `clz_subdir` value appears under multiple `clz_dir` paths (e.g., `audit` exists under both `abap/` and `scc/`). Uses regex lookahead to match both fields simultaneously.
3. **Search-time SID/instance extraction** — ABAP and HANA sourcetypes extract `sap_sid` and `sap_instance` from the `source` metadata field using `EXTRACT ... in source` directives in the LogServ App.
4. **~128 total search-time directives** across all SAP-specific sourcetypes.

### :material-circle-box:{ .taiconcolor } Fixed issues

### :material-circle-box:{ .taiconcolor } Known issues

1. The dashboards in the LogServ App use Dashboard Studio v2 format and require Splunk 9.4.3 or later.

### :material-circle-box:{ .taiconcolor } Third-party software attributions


## Version 0.0.3-beta

### :material-circle-box:{ .taiconcolor } Compatibility

|                                  |                              |
|----------------------------------|------------------------------|
| Splunk platform versions         | 9.4.3 and later              |
| CIM                              | 5.1.1 and later              |
| Supported OS for data collection | Platform independent         |
| Vendor products                  | SAP LogServ for SAP ECS in Amazon Web Services (AWS) |

### :material-circle-box:{ .taiconcolor } New features

1. **Two-package architecture** — The solution is now split into two packages: the **Data TA** (`splunk_ta_sap_logserv`) for data collection and index-time processing, and the **LogServ App** (`splunk_app_sap_logserv`) for dashboards and search-time field extractions. See [Architecture](../getting-started/architecture.md) for details.
2. **Built-in index-time filtering** — Configure include/exclude patterns and time-based filters directly through the Splunk Web UI. Filtered events never consume Splunk license. See [Configuring Filters](../install-setup/configure-filters.md).
3. **AWS Lambda-based filtering** — New deployment option that filters S3 event notifications in AWS before they reach Splunk, reducing S3 GET request costs and SQS message volume. Available via the [AWS Remote S3 Filter Setup Guide](../install-setup/aws-remote-s3-filter-guide.md) or the [Connect to Filter Migration](../install-setup/aws-remote-s3-connect-to-filter-migration-guide.md). Can be used alongside or independently of the native TA filtering.
4. **Deployment Server automation** — When installed on a Deployment Server, the TA automatically stages filter configurations for distribution to Heavy Forwarders and provides a one-click "Deploy to Forwarders" button.
5. **Upgrade notifications** — A system message banner alerts administrators when a TA upgrade adds support for new log types that are not covered by existing include filter patterns.
6. **Daily time filter refresh** — A built-in scripted input automatically refreshes the time-based filter cutoff once per day to maintain accuracy of the rolling time window.
7. **SAP HANA Audit field extractions** — 14 EXTRACT, 11 EVAL, and 16 FIELDALIAS directives for the `sap:hana:audit` sourcetype.
8. **SAP Web Dispatcher field extractions** — 18 EXTRACT, 3 EVAL, and 6 FIELDALIAS directives for the `sap:webdispatcher:access` sourcetype.

### :material-circle-box:{ .taiconcolor } Fixed issues

1. Dashboards moved from Data TA to dedicated LogServ App package for proper distributed deployment support.

### :material-circle-box:{ .taiconcolor } Known issues

1. The dashboards in the LogServ App use Dashboard Studio v2 format and require Splunk 9.4.3 or later.

### :material-circle-box:{ .taiconcolor } Third-party software attributions


## Version 0.0.2-beta

### :material-circle-box:{ .taiconcolor } Compatibility

|                                  |                              |
|----------------------------------|------------------------------|
| Splunk platform versions         | 9.4.x, 10.0.x                |
| CIM                              | 5.1.1 and later              |
| Supported OS for data collection | Platform independent         |
| Vendor products                  | SAP LogServ for SAP ECS in Amazon Web Services (AWS) |

### :material-circle-box:{ .taiconcolor } New features

### :material-circle-box:{ .taiconcolor } Fixed issues

1. Drilldown on overview dashboard to host details dashboard had the wrong application name and displayed an error when clicking on the host name.
2. Renamed the 'logserv_web_dispatcher_access.xml' dashboard to 'logserv_web_dispatcher.xml'.
3. Renamed the 'sap_rise_host_details.xml' dashboard to 'logserv_host_details.xml'.
4. Updated the '~/ui/nav/default.xml' with updated dashboard names.

### :material-circle-box:{ .taiconcolor } Known issues

1. The dashboards included in this TA are Dashboard Studio dashboards that may not work with Splunk versions prior to 9.4.

### :material-circle-box:{ .taiconcolor } Third-party software attributions


## Version 0.0.1-beta

### :material-circle-box:{ .taiconcolor } Compatibility


|                                  |                              |
|----------------------------------|------------------------------|
| Splunk platform versions         | 9.4.x, 10.0.x                |
| CIM                              | 5.1.1 and later              |
| Supported OS for data collection | Platform independent         |
| Vendor products                  | SAP LogServ for SAP ECS in Amazon Web Services (AWS) |

### :material-circle-box:{ .taiconcolor } New features

### :material-circle-box:{ .taiconcolor } Fixed issues

### :material-circle-box:{ .taiconcolor } Known issues

1. Drilldown on overview dashboard to host details dashboard has the wrong application name and displays an error when clicking on the host name.

2. The dashboards included in this TA are Dashboard Studio dashboards that may not work with Splunk versions prior to 9.4.

### :material-circle-box:{ .taiconcolor } Third-party software attributions
