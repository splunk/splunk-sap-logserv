# v0.0.5.0 Release Binaries

This directory contains the two installable tarballs for the **Splunk for SAP LogServ** v0.0.5.0 release.

## Canonical tarballs

| Tarball | md5 | Size | Tier |
|---|---|---|---|
| [`splunk_app_sap_logserv-0.0.5.0.tar.gz`](./splunk_app_sap_logserv-0.0.5.0.tar.gz) | `86e5a04b3947f95ed332e20bdc6da94e` | 2.8 MB | Search Head |
| [`splunk_ta_sap_logserv-0.0.5.0.tar.gz`](./splunk_ta_sap_logserv-0.0.5.0.tar.gz) | `409120096648d0d2b7399e8e42f40c9b` | 1.6 MB | Deployment Server + Heavy Forwarders + Indexer (also installable on Splunk Cloud SH for single-instance Cloud deployments) |

The App tarball is at **build 193** and the Data TA at **app version 0.0.5** (proper 3-part SemVer, internal build 1778797192-class) as of 2026-05-17 (session 044). Nine change sets from the original build 174 are now bundled:

1. **Splunk Cloud compatibility fix** (App build 182 — see "Cloud-fix" below). Required for installation on Splunk Cloud Victoria 10.x.
2. **ISC BIND + Squid parsing absorption** (App build 184 — see "Absorbed parsing" below). Customers no longer need the separately-archived `Splunk_TA_isc-bind` v2.0.0 or `Splunk_TA_squid` v2.1.0 add-ons.
3. **Icon-rendering fix on Splunk Cloud** (App build 185 — see "Icon fix" below). Adds the missing `app.manifest` so Splunk Cloud Victoria renders the app's icon in the launcher / Apps switcher instead of a generic placeholder.
4. **Splunk Cloud `sc_subadmin` enablement — metadata + capability** (App build 186 + Data TA — see "sc_subadmin enablement" below). Allows customer-tier Splunk Cloud admins (whose top role is `sc_subadmin`, not `sc_admin`) to write to `storage/passwords` and other knowledge objects.
5. **Data TA Cloud-vetting fixes** (Data TA app version `0.0.5` — see "Data TA Cloud-vetting" below). Cleared 5 pre-existing AppInspect Cloud-mode failures that had been blocking Data TA install on Splunk Cloud: 4-part SemVer version corrected to 3-part, missing `python.version`/`python.required` flags added to scripted inputs + REST handler stanzas, audit-index renamed `_ai_assistant_audit` → `logserv_ai_assistant_audit` (underscore-prefix violation + `maxTotalDataSizeMB` illegal property both cleared by the rename + property removal).
6. **Audit-index rename in App** (App build 187 → 188 coordinated with Data TA fix). The App's `ai_assistant_settings.conf` `audit_index_name`, `macros.conf` audit macro, and `auditWriter.ts` JS default were all updated from `_ai_assistant_audit` → `logserv_ai_assistant_audit` to remain in sync with the Data TA's renamed index.
7. **v0.1.1 feature-parity overlay + useIsAdmin fix** (App build 190 → 191) — see "v0.1.1 feature-parity overlay" below.
8. **Session 042 — AI Assistant settings + acks migrated to KV Store** (App build 192) — see "KV Store migration for sc_subadmin enablement" below. Removes the last `admin_all_objects` capability-gated write paths in the App; sc_subadmin users can now Save Defaults + accept legal T&C modals without 403 errors.
9. **Session 044 — Topology Live / Lookup toggle removed** (App build 193) — see "Live / Lookup toggle removed (session 044)" below. The 30-second polling effect re-fetched KV Store rows that only update hourly; 119 of every 120 ticks were no-ops. Manual Refresh button retained for cases where an admin just dispatched a backfill and wants results before the next hourly aggregation.

The TA tarball was also respun earlier in session 040 to (a) drop now-stale `Splunk_TA_isc-bind` + `Splunk_TA_squid` dependencies that were preventing the TA from rendering cleanly on Splunk Cloud (their parsing now lives in the App, not the TA), and (b) clear two `python.required = 3.13` AppInspect future_failures that had been carried forward from the original v0.0.5.0 release.

The previous canonical builds (App 174 / 181 / 182 / 184 / 185 / 188 / 191 / 192, TA 1778087892 / 1778087893) are preserved in [`../testing/iteration_tarballs/`](../testing/iteration_tarballs/) and [`../testing/release_binaries/`](../testing/release_binaries/).

Both are installable via Splunk Web (**Apps → Install app from file**) or via CLI:
```bash
/opt/splunk/bin/splunk install app /path/to/<tarball>
```

See [`docs/content/getting-started/quick-install-reference.md`](../docs/content/getting-started/quick-install-reference.md) for the per-tier install matrix and the prerequisite Splunkbase add-ons (CIM modules, Splunk MCP Server for the AI Assistant).

## What's in v0.0.5.0

The v0.0.5.0 release ships the React-based LogServ App with:

- **22 React-based dashboards** organized as Environment Health (default landing) + Topology + Applications (5) + Integration (5) + Security (3) + Platform (6). Single React bundle built on `@splunk/react-ui`, `@splunk/visualizations`, and `@xyflow/react`. Replaces the Dashboard Studio v2 layout that shipped in v0.0.4.2.
- **Environment Topology view** — graph-based visualization of SAP systems, integration partners, and endpoints. Force-directed initial layout, self-derived IP→SID inventory, named saved layouts via Splunk KV Store, Live mode auto-refresh.
- **AI Assistant — templates-only build** — predefined-prompt browser (48 canned saved searches across SAP Basis / Security / Operations packs, dispatched via the Splunk MCP Server with no LLM call). The free-form / LLM-driven path is **disabled at compile time** in this build pending internal review of the OWASP LLM Top 10 controls. Admins see the chat panel and the prompt browser; the chat input is read-only and Provider Credentials / Power Mode are hidden.
- **Audit log** — every AI Assistant action recorded in the dedicated `_ai_assistant_audit` index, with an in-app browser at **Settings → AI Assistant → Audit Log** and an optional HEC forwarder for tamper-evidence.
- **Index-time filtering + Deployment Server automation** — control which log types ingest via the Splunk Web UI; filtered events incur zero license cost.
- **Splunk 9.4.3 or later** is the minimum supported version. See the full release notes at [`docs/content/overview/release-notes.md`](../docs/content/overview/release-notes.md).

## Why "templates-only" in v0.0.5.0

The v0.0.5.0 release deliberately ships with the LLM-driven path **physically removed from the bundle at build time**. The MCP-based predefined-prompt path stays fully active so the solution can be demonstrated end-to-end against your data without enabling any external LLM provider. No event data is transmitted outside the Splunk deployment, no AI-generated narrative is produced, no provider credential needs to be configured.

The full LLM capabilities (free-form chat, Anthropic / OpenAI / Azure OpenAI / AWS Bedrock providers, three privacy tiers, Power Mode) are planned for a subsequent release behind a runtime admin toggle.

## v0.1.1 feature-parity overlay (App build 191, 2026-05-14)

The v0.0.5.0 App was originally forked at build 174 (April 2026) and missed all subsequent enhancements that landed in v0.1.1 (sessions 035-037 topology rewrite, sessions 022-029 AI Assistant polish + audit log + HEC forwarder + drilldown UX, sessions 025-027 Settings UI reorganization, session 033+ Enterprise Security integration). Session 041 brought v0.0.5.0 up to **v0.1.1 feature parity** while preserving the templates-only LLM strip.

### What's new vs prior v0.0.5.0 build 188

Full v0.1.1 webapp + default-conf overlay, plus:

- **Topology view rewrite** (sessions 035-037): KV Store-backed data layer (~sub-second page load vs on-demand SPL), Force / Layered / Tree layout switcher with lazy-loaded `elkjs` (~280 KB chunk), 5-tab edge inspector (Calls / Programs / Errors / Hosts + per-edge Activity / Operations / Performance / Errors), 3-segment call-bucket health rings, DB-vendor tagging (HANA / Oracle / MSSQL / Postgres / DB2), Manage Layouts modal with cross-browser per-mode defaults, MiniMap click-to-center + drag-to-pan, 3 new KV Store collections (`logserv_topology_nodes` / `_edges` / `_inventory`) + 7 scheduled saved searches that pre-aggregate the topology data
- **AI Assistant polish** (sessions 022-029): Audit Log Settings tab + HEC audit forwarder + acceptance modals, drilldown chips + citation chips, Dashboard-Focused prompt-browser tab, 61 canned prompts (was 40), dashboard hyperlinks
- **Settings UI reorganization** (sessions 025-027): 5-tab layout (General + Provider Credentials + Splunk MCP + Audit Log + Topology), per-dashboard refresh-interval picker
- **Enterprise Security integration** (session 033): 18 ES correlation searches (5 base + 6 cross-stack + 3 threat-intel + 4 behavioral) emitting Notable Events when ES is installed, Asset & Identity feeds, CIM-aligned eventtypes + tags. Silently no-ops when ES isn't installed.

### Three-layer LLM-disable enforcement (preserved)

Any one of these three layers prevents LLM dispatch independently of the others:

1. **Compile-time** — `buildFlags.TEMPLATES_ONLY === true` (set via `LOGSERV_TEMPLATES_ONLY=true` env var that `yarn build:templates-only` injects). Webpack's DefinePlugin replaces references with the literal `true`, dead-code-eliminating the would-be vendor-dispatch branches from the bundle.
2. **Runtime** — `ai_assistant_settings.conf` `templates_only_mode = true` is the default in v0.0.5.0. v0.1.1 source uses this flag to gate the chat-input field, Power Mode toggle, Provider Credentials tab visibility, etc.
3. **Physical** — the six LLM-specific provider files (`AnthropicProvider.ts`, `OpenAIProvider.ts`, `AzureOpenAIProvider.ts`, `BedrockProvider.ts`, `anthropicEventTranslator.ts`, `sseUtils.ts`) are absent from source. The `providers/index.ts` factory collapses ALL provider names (including `anthropic`, `openai`, `azure_openai`, `bedrock`, `ollama`) to MockProvider. Even if a future code change accidentally re-introduces a dispatch path, there is no provider to dispatch to. Verified at the bundle level: `grep AnthropicProvider home.js` returns 0 matches.

### Build + deploy verification

Built locally via `yarn build:templates-only` (Node 23 + yarn 1.22 on the user's Windows machine), 99-second clean build, 1416 SBOM components, TypeScript 0 errors, webpack 2 warnings (asset-size only). Deployed to `splunk-sh-idxr` (Splunk Enterprise 9.4.3) via the standard `cp -rT` local-backup pattern. REST API smoke-test confirms: app loaded clean, all 7 v0.1.1 topology + dashboard KV Store collections registered, runtime templates-only mode active, audit-index resolution intact. Only ERROR-level events in `_internal` since deploy are the expected "Alert action 'risk'/'notable' not found" entries — those are the ES correlation searches firing on a non-ES host (silent no-op per session-033 design; same behavior expected on the user's non-ES Splunk Cloud).

## Live / Lookup toggle removed (session 044, 2026-05-17)

The Environment Topology toolbar previously carried a **Live | Lookup** mode toggle that, when set to Live, wired a 30-second `setInterval` to bump the `refreshNonce` and re-trigger every topology query. The original intent (build 125) was auto-refresh against on-demand SPL — but the session-035 data-layer rewrite moved topology to KV Store collections populated by **hourly** scheduled saved searches (`logserv_topology_aggregate_nodes/_edges/_inventory`, cron `5 * * * *`). With the new data layer in place, ~119 of every 120 Live-mode ticks returned byte-identical KV Store data and re-rendered the same graph. The toggle provided no value for the main graph and was misleadingly named.

Build 193 removes:

- The `Live | Lookup` `ModeToggle` button-group in `TopologyToolbar.tsx`
- The associated `ModeToggle` + `ModeButton` styled-components (unused after JSX removal)
- The `liveMode` + `onToggleLiveMode` props on the toolbar interface
- The `liveMode` state + 30-second polling `useEffect` in `IntegrationTopology.tsx`
- The `LIVE_REFRESH_MS = 30_000` constant

**Manual Refresh button retained.** It still bumps `refreshNonce` exactly once when clicked, useful for admins who just dispatched a backfill saved search and want to see results before the next hourly aggregation. Per-node detail panels (`useNodeData`) continue to re-fetch on node-selection change (independent live SPL via `useSearch`).

**Saved searches unchanged.** The three hourly aggregation searches continue to run on their `5 * * * *` cron schedule and populate the KV Store with fresh bucket rows. Net data freshness is unchanged from prior builds when Live was off — the only change is that the misleading "Live" toggle is gone.

The "Live Activity" bottom-panel drawer is a separate feature (a collapsible recent-activity feed) and is unaffected by this change.

## KV Store migration for sc_subadmin enablement (App build 192, 2026-05-14)

The session-041 `sc_subadmin` fix at `metadata/default.meta` (build 186) enabled writes to `storage/passwords` and other metadata-ACL-gated endpoints, but Splunk's `/configs/conf-X/` REST endpoint imposes a SEPARATE hardcoded capability gate (`admin_all_objects`) that no metadata ACL change can bypass. On Splunk Cloud Victoria deployments where `sc_subadmin` does NOT hold `admin_all_objects`, every conf-file write 403'd — including:

- **Save Defaults** on the AI Assistant Settings page (`POST /configs/conf-ai_assistant_settings/defaults`)
- **Accept T&C modal** on enabling AI Assistant or disabling the audit forwarder (`POST /configs/conf-ai_assistant_acks/<stanza>`)

Build 192 migrates both mutable conf-file backed stores to KV Store collections:

| Was | Now |
|---|---|
| `local/ai_assistant_settings.conf [defaults]` (conf-file) | KV Store collection `logserv_ai_assistant_settings`, single row `_key = defaults` |
| `local/ai_assistant_acks.conf [<stanza>]` user-state fields (conf-file) | KV Store collection `logserv_ai_assistant_acks`, one row per stanza |

KV Store endpoints (`/storage/collections/data/<collection>`) are governed by collection-level metadata ACL only — no `admin_all_objects` capability requirement. Both collections ship with `write : [ * ]` ACL matching the seven pre-existing topology + dashboard preference collections (which already work for sc_subadmin without capability escalation).

**Operator-controlled `optInVersion` stays in `default/ai_assistant_acks.conf`** — bumping the version still re-prompts everyone (same UX as before). Only the user-acknowledgement fields (`optInVersionAcknowledged`, `optInChoice`, `optInChoiceAt`) moved to KV Store.

**Customer upgrade preservation:** a one-shot migration helper in `App.tsx` runs on first page load post-upgrade. For each store, if the KV Store row is absent AND the conf-file carries non-default values (customer had previously saved settings or accepted T&Cs), the values are copied into the KV Store row. Idempotent — subsequent loads find the KV Store row populated and no-op. Best-effort: failures don't block the UI. Customers who had customized settings or accepted T&Cs on a prior build don't get re-prompted spuriously.

**Splunk Enterprise compatibility:** zero behavior change. The App on Enterprise reads from KV Store (which works there too) and falls back to the conf-file on first load before any KV Store write. Admins on Enterprise see exactly the same Save / Accept UX as before; the only difference is the storage backend.

**AppInspect Cloud-mode posture (build 192):** 0 errors / 0 failures / 0 future_failures / 8 baseline warnings / 112 success — identical to build 191. The two new KV Store collections + their ACL stanzas are checked by the same baseline rules as the seven pre-existing topology collections; no new findings.

## Data TA sc_subadmin write ACL fix (session 043, 2026-05-15)

The session-041 `metadata/default.meta` fix added `sc_subadmin` to the global write ACL in the Data TA source at `package/metadata/default.meta`. **But UCC's build pipeline overwrites that source-level file with a baked-in template that hardcodes `write : [ admin, sc_admin ]`** — silently dropping our sc_subadmin addition. The released Data TA tarballs through session 042 carried the stock UCC default and a sc_subadmin user on Splunk Cloud Victoria would hit 403 on any write to Data TA-owned knowledge objects (filter Configuration UI, anything in `storage/passwords` under the Data TA namespace, etc.).

Session 043 adds a UCC post-build patcher to `additional_packaging.py` that re-injects sc_subadmin into the output `metadata/default.meta` after UCC's template has run. Idempotent: re-running on already-patched input is a no-op; running on input that doesn't match the expected stock UCC ACL line prints a WARNING and skips so misconfigured manual edits surface loudly. The same logic also lives as a standalone repair script at `tools/scripts/patch_data_ta_sc_subadmin_metadata.py` that can be invoked against an already-built tarball without re-running UCC.

**Customer impact:** sc_subadmin users on locked-down Splunk Cloud Victoria can now write to Data TA-owned knowledge objects. Combined with the session-042 KV Store migration in the App, this clears the last hardcoded `admin_all_objects` capability gate facing sc_subadmin on the entire LogServ stack (App + Data TA).

The session-043 Data TA respin preserves the same AppInspect Cloud-mode posture as the prior build (0/0/0/11/131 success); the patcher's addition is invisible to the checker.

## Data TA Cloud-vetting (Data TA app version 0.0.5, 2026-05-14)

Prior to this build, the v0.0.5.0 Data TA carried **5 pre-existing AppInspect Cloud-mode failures** that were tolerated on Splunk Enterprise but blocked Splunk Cloud install. Cleared in this build:

1. **`check_version_is_valid_semver`** — `version = 0.0.5.0` (4-part) was invalid per Splunkbase SemVer 2.0.0. Fixed by rebuilding the TA with `ucc-gen build --ta-version 0.0.5` (3-part). The tarball filename stays `splunk_ta_sap_logserv-0.0.5.0.tar.gz` for snapshot-directory continuity, but the internal `app.conf` `[id] version` + `[launcher] version` + `app.manifest` `info.id.version` are all now `0.0.5`.

2. **`check_scripted_inputs_python_version`** — `[script://./bin/logserv_filter_time_refresh.py]` (and its sibling `logserv_filter_upgrade_check.py`) in `default/inputs.conf` lacked the required `python.version = python3` flag. Added explicitly. Also added `python.required = 3.13` to clear the related future_failure check `check_scripted_inputs_python_required` (applied via `additional_packaging.py` post-UCC hook).

3. **`check_indexes_conf_properties`** — the audit index stanza had an illegal `maxTotalDataSizeMB = 5000` property (only `homePath`, `coldPath`, `thawedPath`, `frozenTimePeriodInSecs`, `disabled`, `datatype`, `repFactor` are allowed on Splunk Cloud). Removed the line. Index retention is now governed solely by `frozenTimePeriodInSecs = 7776000` (~90 days).

4. **`check_lower_cased_index_names`** — the audit index `[_ai_assistant_audit]` started with an underscore (reserved for Splunk's internal indexes like `_internal`, `_audit`). Renamed to **`[logserv_ai_assistant_audit]`** — the `logserv_` prefix namespaces the index to this app so it never collides with another app that might define a generic `ai_assistant_audit` index. The LogServ App's `ai_assistant_settings.conf`, `macros.conf`, and `auditWriter.ts` were updated in lockstep.

5. **`check_rest_handler_python_executable_exists`** — the custom REST script `[script:splunk_ta_sap_logserv_deployment_push]` (deployment-server push endpoint) lacked the required `python.version` flag. Added explicitly via `additional_packaging.py`. Also added `python.required = 3.13` to clear the related future_failure check `check_admin_external_restmap_conf_python_required`.

**Customer migration note:** customers running the prerelease state with existing audit data under `$SPLUNK_DB/_ai_assistant_audit/db/` will see that data become orphaned on disk after upgrade — not queryable via the new index name. Audit retention horizons are typically short, so a clean break is acceptable. If a customer needs to preserve historical audit events, they can search the bucket files directly via a temporary `[_ai_assistant_audit_legacy]` index stanza referencing the old path, or restore from backup to the new index location.

**Splunk Enterprise compatibility:** all 5 fixes are forward-compatible with on-prem Splunk Enterprise. The version normalization (4-part → 3-part) doesn't break Enterprise installs. The `python.version` / `python.required` declarations are valid on Enterprise. The index rename is a clean break either way (no transition mechanism on Enterprise vs Cloud).

## sc_subadmin enablement (App build 186 + Data TA build 1778087894, 2026-05-13)

Splunk Cloud Victoria deployments may reserve the `sc_admin` role for Splunk Cloud Ops staff and never expose it to customers — in which case `sc_subadmin` becomes the customer's effective top admin role. The default UCC-generated `metadata/default.meta` granted write access only to `[admin, sc_admin]`, which locked sc_subadmin users out of credential storage and other writable knowledge objects. Saving any provider credential (AI Assistant LLM keys, audit forwarder HEC token, etc.) returned `"User '<name>' with roles { ..., sc_subadmin, ... } cannot write: /nobody/<app>/passwords/..."`.

The session-041 fix (applied to BOTH the App and the Data TA):

1. **`metadata/default.meta`** write list expanded from `[admin, sc_admin]` to `[admin, sc_admin, sc_subadmin]`. Allows sc_subadmin to write to `storage/passwords` and all other knowledge objects in the app.
2. **Data TA `default/restmap.conf [script:splunk_ta_sap_logserv_deployment_push]`** capability requirement changed from `admin_all_objects` → `edit_deployment_server` (a Splunk-standard capability that's auto-granted to `admin` on Enterprise and typically also held by sc_subadmin on Cloud). The capability change is sourced via `sap_logserv_package/splunk_ta_sap_logserv/additional_packaging.py BACKFILL_STANZAS` (the build-time patch that injects the stanza into the UCC-generated `restmap.conf`).

**Splunk Enterprise compatibility:** Both changes are backwards-compatible with on-prem Splunk Enterprise. `sc_admin` and `sc_subadmin` are Splunk Cloud-only roles — on Enterprise, Splunk's metadata parser silently ignores unknown roles and the `admin` role retains all write access. `edit_deployment_server` is granted to `admin` on Enterprise via the wildcard `* = enabled`, so DS push continues to work identically. Enterprise admins see zero behavior change.

## Icon fix (build 185, 2026-05-13)

The original v0.0.5.0 App tarball (and builds 174 / 181 / 182 / 184) did **not** ship an `app.manifest` file. AppInspect Cloud flagged this as `check_for_valid_package_id: skipped` ("Splunk App packages doesn't contain `app.manifest` file"). Splunk Cloud Victoria 10.x interpreted the missing manifest as an "incomplete app" and rendered the app with a generic placeholder icon in the launcher + Apps switcher instead of the actual `static/appIcon.png` art.

Build 185 adds an `app.manifest` modeled on the v0.1.1 manifest structure (`schemaVersion: 2.0.0`), declares the `Splunk_SA_CIM >=5.0.0` dependency, sets `targetWorkloads: ["_search_heads"]`, and lists Standalone / Distributed / SHC as supported deployments. AppInspect Cloud's `check_for_valid_package_id` now resolves to `success` (no longer skipped). On reinstall, Splunk Cloud renders the app's actual orange-frame "LS" icon.

The TA tarball ships the same fix posture and additionally:
- Drops the stale `Splunk_TA_isc-bind` + `Splunk_TA_squid` hard dependencies (their parsing now lives in the App, not the TA). Splunk Cloud no longer marks the TA as "dependency unmet" → degraded → no icon.
- Adds `python.required = 3.13` to the `[script://./bin/logserv_filter_upgrade_check.py]` scripted input stanza and the `[admin_external:splunk_ta_sap_logserv_settings]` REST handler stanza, clearing 2 AppInspect Cloud `future_failure` advisories that had been carried forward from the original v0.0.5.0 release.

## Absorbed parsing (build 184, 2026-05-12)

Two Splunkbase add-ons were absorbed into this App: their parsing (props/transforms/eventtypes/tags/lookups) now ships natively so customers no longer need them as separate installs. Both add-ons are **archived** by Splunk Inc. (no longer maintained on Splunkbase).

| Absorbed add-on | Version | License | Sourcetypes |
|---|---|---|---|
| Splunk Add-on for ISC BIND | v2.0.0 | `LicenseRef-Splunk-1-2020` | `isc:bind:query`, `:queryerror`, `:lameserver`, `:network`, `:transfer` |
| Splunk Add-on for Squid Proxy | v2.1.0 | `LicenseRef-Splunk-8-2021` | `squid:access` (`squid:access:recommended` not absorbed) |

Detail in [`../THIRD-PARTY-NOTICES.md`](../THIRD-PARTY-NOTICES.md) under "Absorbed Splunk add-ons". License files included at `LICENSES/LicenseRef-Splunk-1-2020.txt` and `LICENSES/LicenseRef-Splunk-8-2021.txt` inside the tarball.

**One customization vs the absorbed v2.1.0 Squid lookup:** the absorbed `squid_actions_210.csv` maps `TCP_DENIED`/`UDP_DENIED`/`TCP_SWAPFAIL`/`UDP_INVALID` to `denied` (not `blocked` as the original TA does). This deviates from CIM Proxy data-model standard vocabulary (`blocked`) to match the field-value expectations of our Environment Health + Proxy dashboards (`action="denied"`). Other actions map per the original (`TCP_HIT → allowed`, etc.).

**Customer-upgrade note:** customers who currently have `Splunk_TA_isc-bind` or `Splunk_TA_squid` installed alongside the LogServ App will see double-parsing when build 184 lands. The App now ships a runtime compatibility banner that detects this and recommends uninstalling the standalone add-on(s) via `Settings → Manage Apps`. The banner only renders when one or both archived TAs are detected; it's dismissible (persists in `localStorage`).

## Cloud-fix (build 182, 2026-05-12)

The original v0.0.5.0 build 174 carried a custom Mako template at `appserver/templates/home.html` with an embedded `<% page_path = ... %>` Python code block. AppInspect Cloud-mode flagged this as a WARNING (`check_for_existence_of_python_code_block_in_mako_template`) but allowed the tarball to pass vetting. Splunk Cloud Victoria 10.2.x enforces this policy at runtime — installing build 174 on Splunk Cloud produced a `TopLevelLookupException: Splunk has failed to locate the template for uri 'splunk_app_sap_logserv:/templates/home.html'` and the home view returned HTTP 500.

The build-182 fix:
- Keeps `appserver/templates/home.html` and the `template=` attribute in `home.xml`
- Inlines the page-path expression directly into the `${make_url(...)}` script-src so there's no `<% %>` Python code block
- Verified on Splunk Enterprise 9.4.3 (`splunk-jaclyn` + `splunk-sh-idxr`) — home view renders cleanly with all KPIs + dashboards
- AppInspect Cloud-mode now shows the Mako check as `success` (no warning)

## AppInspect

Both tarballs are AppInspect-validated via `splunk-appinspect` in **precert mode with `--included-tags cloud`** (the Splunk Cloud private-app vetting ruleset). To re-run locally:

```bash
pip install splunk-appinspect
splunk-appinspect inspect release_binaries/splunk_app_sap_logserv-0.0.5.0.tar.gz --mode precert --included-tags cloud
splunk-appinspect inspect release_binaries/splunk_ta_sap_logserv-0.0.5.0.tar.gz --mode precert --included-tags cloud
```

Current Cloud-mode posture (App build 193 / Data TA app version 0.0.5):

- **App**: 0 errors / 0 failures / 0 future_failures / 8 baseline warnings / 112 success — see [`appinspect_cloud_logserv_app.json`](./appinspect_cloud_logserv_app.json). Identical to builds 191 / 192; the Live mode removal in build 193 is a pure subtraction with no AppInspect impact.
- **TA**: 0 errors / 0 failures / 0 future_failures / 11 baseline warnings / 131 success — see [`appinspect_cloud_logserv_ta.json`](./appinspect_cloud_logserv_ta.json). **Both tarballs are now Splunk Cloud-installable** (previous baselines had 5 Data TA failures that blocked Cloud install; all cleared in this build — see "Data TA Cloud-vetting" above).

(For reference: build 174 was 0/0/0/9/106 — every subsequent App build added passing checks as we resolved skipped/future_failure/warning advisories. The Data TA went 6 failures → 0 in build app-version-0.0.5.)

Each app also ships a `run_appinspect.sh` helper at `sap_logserv_package/<app>/run_appinspect.sh` that wraps the above.

## Splunkbase submission status

**Held for further customer review.** The tarballs are ready to ship; submission to the Splunkbase precert API has not been performed and will be initiated by the maintainer who holds Splunkbase credentials. To submit, sign in to <https://splunkbase.splunk.com> and use the **Submit App** UI to upload each tarball as a separate app, or use the Splunkbase REST API with an API key.
