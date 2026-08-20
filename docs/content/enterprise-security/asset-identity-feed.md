# Asset & Identity Feed for ES Identity Management

The Splunk for SAP LogServ App auto-populates ES's Identity Management framework with SAP system inventory + user identities, derived from the same data sources the Environment Topology view uses.

This means ES correlation searches (and any third-party app querying `asset_lookup_by_str` or `identity_lookup_expanded`) get rich asset/identity context for SAP-side events automatically.

## :material-circle-box:{ .taiconcolor } What ships

Two scheduled saved searches that emit CSV lookups every 4 hours:

| Saved search | Cadence | Output lookup | Schema |
|---|---|---|---|
| `splunk_sap_logserv_es_asset_feed` | every 4h (cron `0 */4 * * *`) | `splunk_for_sap_logserv_assets.csv` | ES Asset (17 std cols + 2 extra) |
| `splunk_sap_logserv_es_identity_feed` | every 4h (cron `1 */4 * * *`) | `splunk_for_sap_logserv_identities.csv` | ES Identity (16 std cols + 1 extra) |

The two feeds are scheduled one minute apart (`:00` and `:01`) so they do not dispatch simultaneously.

## :material-circle-box:{ .taiconcolor } Asset feed

The Asset feed unions 6 inventory subsearches and consolidates by IP (when present) or DNS hostname:

1. `sap:abap:gateway` events with `local_ip=*` → IP+host+SID
2. `sap:hana:tracelogs` with `hana_host=*` → hostname+SID (no IP)
3. `sap:abap:icm` with `icm_local_ip=*` → IP+host+SID
4. `sap:saprouter` events → host-only, categorized as middleware
5. `sap:scc:audit` events → host-only, middleware
6. `sap:webdispatcher:access` events → host-only, application

After dedup, SAP-stack heuristics apply:

- **HANA database servers** → `priority=high, category=Server | Database | SAP HANA`
- **Middleware** (saprouter, SCC) → `priority=high, category=Server | Middleware | SAP`
- **NetWeaver application servers** → `priority=medium, category=Server | Application | SAP NetWeaver`

Hardcoded fields (customer overrides via merger):
- `owner = "SAP-Operations"`
- `bunit = "SAP"`
- `is_expected = 1`, `should_timesync = 1`, `should_update = 1`, `requires_av = 0`

Empty-on-emit (out of scope):
- `mac` — log data doesn't carry MAC addresses
- `nt_host` — Windows hostname not derivable from SAP logs
- `lat / long / city / country` — not in log data
- `pci_domain` — out of scope for SAP-side derivation

Two extra columns for SOC analyst readability (ES merger ignores unknown columns):
- `_sap_sids` — comma-joined list of SAP SIDs hosted on this asset
- `_roles` — comma-joined list of roles (e.g., `SAP NetWeaver ABAP,SAP NetWeaver ABAP ICM`)

## :material-circle-box:{ .taiconcolor } Identity feed

The Identity feed unions 5 user-source subsearches and consolidates by identity:

1. `sap:hana:audit` `executing_user` → tagged `hana_admin`
2. `sap:hana:audit` `target_user` → tagged `hana_target`
3. `sap:sapstartsrv` `auth_user` → tagged `sap_host_user`
4. `linux:sudolog` `os_user` → tagged `sudo_invoker`
5. `linux:sudolog` `target_user` → tagged `sudo_target`

Priority + category heuristics (per identity):

| Match pattern | priority | category |
|---|---|---|
| `(?i)^SYSTEM$` or `^root$` | critical | (per source-type — `SAP HANA system account` or `OS user`) |
| Identity matches `(?i)^SYSTEM$\|^_SYS_\|^SAP_` | (above critical or default high) | `SAP HANA system account` |
| Identity from `hana_admin` or `hana_target` source | high | `SAP HANA user` |
| Identity matches `(?i)adm$` (SAP service accounts) | medium | `SAP service account` |
| Otherwise | low | (per source-type) |

`watchlist=1` for critical+high; `watchlist=0` for medium+low. ES surfaces watchlisted identities in its identity-risk dashboards.

One extra column:
- `_source_type_str` — comma-joined list of source-type tags this identity appears in

## :material-circle-box:{ .taiconcolor } Customer wire-up

After the App installs, the lookups don't exist until the saved searches first run (within 4h of install). To populate immediately:

```bash
# Dispatch the asset feed
curl -sk -u admin:<pw> -X POST \
  -d dispatch.earliest_time=-7d@d -d dispatch.latest_time=now \
  https://<splunk-host>:8089/servicesNS/nobody/splunk_app_sap_logserv/saved/searches/splunk_sap_logserv_es_asset_feed/dispatch

# Dispatch the identity feed
curl -sk -u admin:<pw> -X POST \
  -d dispatch.earliest_time=-7d@d -d dispatch.latest_time=now \
  https://<splunk-host>:8089/servicesNS/nobody/splunk_app_sap_logserv/saved/searches/splunk_sap_logserv_es_identity_feed/dispatch
```

The explicit `dispatch.earliest_time` / `dispatch.latest_time` arguments matter: a REST dispatch does **not** apply the stanza's own dispatch window, and each run fully **overwrites** the CSV — a short-window ad-hoc run would replace the inventory with a truncated one. Wait for both jobs to complete (seconds on a small dataset; longer at customer volume — the feeds union several sourcetypes over 7 days), then verify:

```spl
| inputlookup splunk_for_sap_logserv_assets | head 5
| inputlookup splunk_for_sap_logserv_identities | head 5
```

### :material-circle-box:{ .taiconcolor } Add to ES Identity Management

In Splunk Web (with ES installed):

1. Go to **Settings → Configuration → Identity Management**
2. Under "Asset Lookup Configuration", click **+ New**:
   - Name: `splunk_for_sap_logserv_assets`
   - Lookup table: `splunk_for_sap_logserv_assets`
   - Source app: `splunk_app_sap_logserv`
   - Default match type: `EXACT`
   - Save
3. Under "Identity Lookup Configuration", click **+ New**:
   - Name: `splunk_for_sap_logserv_identities`
   - Lookup table: `splunk_for_sap_logserv_identities`
   - Source app: `splunk_app_sap_logserv`
   - Save

ES's merger framework picks up the new sources within ~5 minutes. Verify by running:

```spl
| inputlookup asset_lookup_by_str | search asset="hec53v013858"
| inputlookup identity_lookup_expanded | search identity="xcjadm"
```

The merged record should now include `priority`, `category`, `bunit` from our feed (alongside any CMDB-sourced fields if present).

### :material-circle-box:{ .taiconcolor } Confirm correlation searches enrich notables

Run any of the base ES correlation searches. Notables in **Incident Review** should show:

- `dest_asset_priority`, `dest_asset_category`, `dest_asset_bunit` populated for `dest=hec53v013858`
- `user_identity_priority`, `user_identity_category`, `user_identity_watchlist` populated for `user=xcjadm`

## :material-circle-box:{ .taiconcolor } Integration with CMDB (additive mode)

If the customer already has a CMDB feeding ES's Asset framework, our feed is additive:

- ES merger framework reconciles across multiple sources
- Per-field precedence is configurable in `lookup_merge.conf`
- Conflicts (e.g., CMDB says `owner=John`, our feed says `owner=SAP-Operations`) resolve per merger precedence
- Our SAP-stack-specific fields (`category=Server | Database | SAP HANA`, `_sap_sids`, `_roles`) fill in gaps where the CMDB doesn't have SAP-aware data

To make CMDB authoritative for `owner`/`bunit` while keeping our SAP categorization:

1. Place CMDB above our feed in the Asset Lookup Configuration order
2. ES applies higher-precedence values for shared fields (`owner`, `bunit`)
3. Our `category`, `_sap_sids`, `_roles` fields fill in (CMDB likely doesn't have these)

## :material-circle-box:{ .taiconcolor } Disabling the auto-feed

If a customer doesn't want our auto-feed (e.g., CMDB is fully authoritative):

1. Splunk Web → Settings → Searches, reports, and alerts
2. Filter by `splunk_sap_logserv_es_asset_feed` and `splunk_sap_logserv_es_identity_feed`
3. Edit each → Disable
4. Save

The lookup CSVs remain on disk (last-known state) but are no longer refreshed.

## :material-circle-box:{ .taiconcolor } Caveats

- **No MAC addresses.** SAP application logs don't expose MAC addresses. Customers needing MAC-based asset resolution must source it elsewhere (DHCP logs, network gear).
- **Short hostnames vs FQDNs.** Our `dns` column is the `host` field as Splunk indexed it. If Splunk indexed short names but customer DNS uses FQDNs, ES asset lookups by FQDN won't match. Fix via forward-lookup expansion in `lookup_merge.conf`.
- **No identity start/end dates.** Our feed doesn't track account creation/deactivation. Customers needing `startDate`/`endDate` for behavior baselining should layer an HR-system-sourced identity feed alongside ours.
- **Static priority/category logic.** The heuristics here are SPL `case()` rules. Customer-specific overrides require a manual override CSV (e.g., `my_company_sap_asset_overrides.csv`) placed above our feed in merge order.

## :material-circle-box:{ .taiconcolor } Example output shape (reference environment — your values will differ)

After first dispatch on splunk-sh-idxr (the reference dev environment):

**Assets**: 22 unique rows
- 6 HANA database servers (high priority)
- 6 middleware servers (high priority — SCC + saprouter)
- 10 NetWeaver application servers (medium priority)

**Identities**: 31 unique rows
- 1 critical OS user (root)
- 1 critical HANA system account (SYSTEM)
- 1 high HANA system account
- 20 high HANA users (DDIC, BKPADMIN, ENCRYPTMON, ...)
- 4 high SAP service accounts
- 2 medium SAP service accounts
- 2 low OS users
