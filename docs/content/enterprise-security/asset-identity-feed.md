# Asset & Identity Feed for ES Identity Management

The Splunk for SAP LogServ App feeds ES asset and identity management with an SAP system inventory, read from the ABAP gateway, HANA trace, ICM, SAP Router, Cloud Connector and Web Dispatcher logs, and with user identities from the HANA audit, sapstartsrv and sudo logs.

ES correlation searches that return the fields ES's asset and identity correlation uses (commonly `src`, `dest`, `dvc`, `user` and `src_user`), and any app that queries `asset_lookup_by_str` or `identity_lookup_expanded`, get this context for SAP systems and accounts. Of the shipped LogServ searches, only the cross-stack authentication-failure search returns one of these fields (`user`); see [Confirm correlation searches enrich notables](#confirm-correlation-searches-enrich-notables).

## :material-circle-box:{ .taiconcolor } What ships

Two scheduled saved searches that emit CSV lookups every 4 hours:

| Saved search | Cadence | Output lookup | Schema |
|---|---|---|---|
| `splunk_sap_logserv_es_asset_feed` | every 4h (cron `0 */4 * * *`) | `splunk_for_sap_logserv_assets.csv` | ES Asset (17 std cols + 2 extra) |
| `splunk_sap_logserv_es_identity_feed` | every 4h (cron `1 */4 * * *`) | `splunk_for_sap_logserv_identities.csv` | ES Identity (16 std cols + 1 extra) |

The two feeds are scheduled one minute apart (`:00` and `:01`) so they do not dispatch simultaneously.

Each feed reads all of its sources in **one pass** — a single search over the last 7 days, with no subsearch that Splunk could stop early — and replaces its CSV with the result:

- **An empty run keeps the last CSV.** A run that finds no rows (an ingest outage, for example) writes nothing, so the previous inventory stays in place (`outputlookup override_if_empty=false`).
- **No row cap.** The rows are sorted without a limit (`sort 0`), so an inventory larger than Splunk's default sort limit of 10,000 rows is written whole.
- **A short-window run writes nothing.** A run whose search window starts later than midnight six days ago (`-6d@d`) leaves the CSV as it is, so an ad-hoc run over the last hour cannot replace the 7-day inventory with a partial one. This applies to the scheduled runs too: if you override `dispatch.earliest_time` for either feed (Splunk Web: **Settings → Searches, reports, and alerts → Edit → Advanced edit**; Splunk Enterprise: `local/savedsearches.conf`), keep the window starting at or before `-6d@d` (the default is `-7d@d`), or every run writes nothing and the CSV stops updating without an error. To make a feed cheaper, run it less often (change its cron) instead.

## :material-circle-box:{ .taiconcolor } Asset feed

The Asset feed reads 6 inventory sources in one pass and consolidates by IP (when present) or DNS hostname:

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

Two extra columns for SOC analyst readability. They are not standard ES asset fields, so whether ES keeps them in its merged asset records depends on your ES asset field settings; they are always in the CSV itself:
- `_sap_sids` — comma-joined list of SAP SIDs hosted on this asset
- `_roles` — comma-joined list of roles (e.g., `SAP NetWeaver ABAP,SAP NetWeaver ABAP ICM`)

## :material-circle-box:{ .taiconcolor } Identity feed

The Identity feed reads 5 user sources in one pass and consolidates by identity:

1. `sap:hana:audit` `executing_user` → tagged `hana_admin`
2. `sap:hana:audit` `target_user` → tagged `hana_target`
3. `sap:sapstartsrv` `auth_user` → tagged `sap_host_user`
4. `linux:sudolog` `os_user` → tagged `sudo_invoker`
5. `linux:sudolog` `target_user` → tagged `sudo_target`

Priority and category are set by two separate rule lists; in each, the first rule that matches wins (matching is case-insensitive).

`priority`:

| Rule | priority |
|---|---|
| Identity is `SYSTEM` or `root` | critical |
| Identity appears in a `hana_admin` or `hana_target` source | high |
| Identity ends in `adm` (SAP `<sid>adm` service accounts) | medium |
| Otherwise | low |

`category`:

| Rule | category |
|---|---|
| Identity is `SYSTEM` or starts with `_SYS_` or `SAP_` | `SAP HANA system account` |
| Identity ends in `adm` | `SAP service account` |
| Identity appears in a `hana_admin` or `hana_target` source | `SAP HANA user` |
| Identity appears in a `sap_host_user` source | `SAP host control user` |
| Identity appears in a `sudo_invoker` or `sudo_target` source | `OS user` |
| Otherwise | `SAP user` |

So an `<sid>adm` account that also appears in the HANA audit log gets priority `high`, and a `_SYS_` or `SAP_` account gets `high` only when it appears in the HANA audit log (otherwise `medium` if it ends in `adm`, else `low`).

`watchlist=1` for critical+high; `watchlist=0` for medium+low. ES surfaces watchlisted identities in its identity-risk dashboards.

One extra column:
- `_source_type_str` — comma-joined list of source-type tags this identity appears in

## :material-circle-box:{ .taiconcolor } Customer wire-up

After the App installs, the lookups don't exist until the saved searches first run (within 4h of install). The same applies after an App upgrade if your upgrade method does not keep the App's `lookups/` directory: the two CSVs are written there at run time and are not part of the package, so they exist again after the feeds' next run. To populate immediately:

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

The `curl` calls need the search head's management port (8089). On Splunk Cloud Platform you may not be able to reach that port from your network. If you cannot reach it, run each feed from Splunk Web instead: **Settings → Searches, reports, and alerts**, find `splunk_sap_logserv_es_asset_feed` and `splunk_sap_logserv_es_identity_feed`, and choose **Run** for each, signed in as an admin-tier user. Check the time range the run uses: it must start at or before `-6d@d` (the feed's saved window starts at `-7d@d`), or the run writes nothing. Or wait for the feeds' next scheduled run, which comes within 4 hours.

The explicit `dispatch.earliest_time` / `dispatch.latest_time` arguments matter: a REST dispatch does **not** apply the stanza's own dispatch window, and each run that finds rows fully **overwrites** the CSV. The `-7d@d` window above writes the full inventory; a run whose window starts later than `-6d@d` writes nothing and leaves the CSV as it was (see [What ships](#what-ships)). Both feeds set `dispatchAs = user`: the dispatch runs as the account you call it with, so use an admin-tier account (a non-admin's run cannot write the CSV), and `-7d@d` snaps to midnight in that account's time zone. Wait for both jobs to complete (seconds on a small dataset; longer at customer volume — the feeds read several sourcetypes over 7 days), then verify:

```spl
| inputlookup splunk_for_sap_logserv_assets | head 5
| inputlookup splunk_for_sap_logserv_identities | head 5
```

### :material-circle-box:{ .taiconcolor } Add to ES Identity Management

In Splunk Web on the ES search head, open Enterprise Security's asset and identity management settings and add two lookup sources:

1. An **asset** source that reads the lookup definition `splunk_for_sap_logserv_assets` (you can give the source the same name).
2. An **identity** source that reads the lookup definition `splunk_for_sap_logserv_identities`.

The App ships both lookup definitions (in its `default/transforms.conf`) and shares them with all apps (`export = system`), so ES can read them. The names of ES's menus and form fields differ between ES versions; follow the ES documentation for your version on adding an asset or identity lookup. After ES's next merge of its asset and identity sources, verify by running:

```spl
| inputlookup asset_lookup_by_str | search asset="hec53v013858"
| inputlookup identity_lookup_expanded | search identity="xcjadm"
```

The merged record should now include `priority`, `category`, `bunit` from our feed (alongside any CMDB-sourced fields if present).

### :material-circle-box:{ .taiconcolor } Confirm correlation searches enrich notables

ES enriches a notable from the fields its asset and identity correlation uses, commonly asset fields such as `src`, `dest` and `dvc`, and identity fields such as `user` and `src_user` (check the correlation settings of your ES). Of the shipped correlation searches, the cross-stack authentication-failure search returns `user`, so its notables in **Incident Review** carry the identity's priority, category and watchlist flag (for example for `user=xcjadm`). The other searches name accounts in fields such as `executing_user` or `auth_user` and hosts in `host`, which ES does not correlate on, so their notables are not enriched as shipped. To enrich them, add an `eval` that copies those fields (for example `| eval user=executing_user, dest=host`) to the search ([Correlation Searches → Customer tuning](correlation-searches.md#customer-tuning)).

## :material-circle-box:{ .taiconcolor } Integration with CMDB (additive mode)

If the customer already has a CMDB feeding ES's Asset framework, our feed is additive:

- ES merges the records from all of its asset sources
- Where two sources disagree on a field (e.g., CMDB says `owner=John`, our feed says `owner=SAP-Operations`), the precedence you give the sources in ES's asset and identity management settings decides which value ES keeps; how precedence is set depends on your ES version (see the ES documentation)
- Our SAP-stack-specific `category` values (e.g., `Server | Database | SAP HANA`) fill in gaps where the CMDB doesn't have SAP-aware data; `_sap_sids` and `_roles` do too where your ES asset field settings keep them (see [Asset feed](#asset-feed))

To make CMDB authoritative for `owner`/`bunit` while keeping our SAP categorization:

1. Give the CMDB source precedence over our feed in ES's asset and identity management settings
2. ES applies higher-precedence values for shared fields (`owner`, `bunit`)
3. Our `category` fills in (CMDB likely doesn't have it), with `_sap_sids` and `_roles` where your ES keeps them

## :material-circle-box:{ .taiconcolor } Disabling the auto-feed

If a customer doesn't want our auto-feed (e.g., CMDB is fully authoritative):

1. Splunk Web → Settings → Searches, reports, and alerts
2. Filter by `splunk_sap_logserv_es_asset_feed` and `splunk_sap_logserv_es_identity_feed`
3. Edit each → Disable
4. Save

The lookup CSVs remain on disk (last-known state) but are no longer refreshed. A disabled feed does not re-create its CSV, so an App upgrade that does not keep the App's `lookups/` directory leaves ES without it.

## :material-circle-box:{ .taiconcolor } Caveats

- **No MAC addresses.** SAP application logs don't expose MAC addresses. Customers needing MAC-based asset resolution must source it elsewhere (DHCP logs, network gear).
- **Short hostnames vs FQDNs.** Our `dns` column is the `host` field as Splunk indexed it. If Splunk indexed short names but customer DNS uses FQDNs, ES asset lookups by FQDN won't match these rows. Supply the FQDNs from another asset source (your CMDB, or an override CSV of your own; see the last caveat).
- **No identity start/end dates.** Our feed doesn't track account creation/deactivation. Customers needing `startDate`/`endDate` for behavior baselining should layer an HR-system-sourced identity feed alongside ours.
- **A partial run still overwrites.** The feeds keep the last CSV only when a run finds nothing. A run that finds part of the estate — one cloud's ingest stopped for more than 7 days, say — writes the smaller inventory, and the missing assets and identities drop out of ES until their data returns.
- **Static priority/category logic.** The heuristics here are SPL `case()` rules. Customer-specific overrides require a manual override CSV (e.g., `my_company_sap_asset_overrides.csv`), added as an ES asset source with precedence over our feed.

## :material-circle-box:{ .taiconcolor } Example output shape (reference environment — your values will differ)

After a first dispatch in a reference environment:

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
