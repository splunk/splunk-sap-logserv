# CIM Compliance

The Splunk for SAP LogServ App tags every supported SAP-side sourcetype into the relevant Splunk Common Information Model (CIM) data models, so ES correlation searches and RBA risk framework can consume the data through the standard `| datamodel <Model> search ...` interface.

## :material-circle-box:{ .taiconcolor } CIM models in scope

The App participates in 4 CIM data models, declared in `app.manifest` under `info.commonInformationModels`:

| Model | Use case | SAP-side sourcetypes |
|---|---|---|
| **Authentication** | login attempts (success / failure) | `sap:hana:audit` (CONNECT events), `sap:sapstartsrv`, `sap:scc:audit` (ACCESS_DENIED), `linux:sudolog` |
| **Change** | account / role / config modifications | `sap:hana:audit` (DDL events), `sap:scc:audit` (CONFIGURATION_CHANGED, SERVICE_*) |
| **Network_Sessions** | TCP-level connection tracking | `sap:abap:gateway`, `sap:saprouter` |
| **Web** | HTTP request/response | `sap:webdispatcher:access`, `sap:scc:http_access`, `sap:abap:icm` |

For sourcetypes that don't fit any stock CIM model (HANA tracelogs, ABAP application-tier internal logs), the App still extracts rich search-time fields and adds `vendor_product = "SAP NetWeaver ABAP"` (or similar) for cross-cutting search consistency, but doesn't tag them into a CIM model.

## :material-circle-box:{ .taiconcolor } How the tagging works

Two configuration files drive CIM tagging:

### :material-circle-box:{ .taiconcolor } `default/eventtypes.conf`

Defines 9 SAP-specific eventtypes, each filtering events that should participate in a particular CIM model. For example:

```ini
[sap_hana_authentication]
search = sourcetype="sap:hana:audit" (action_type="CONNECT" OR audit_category="SYSTEM Logins")

[sap_hana_change]
search = sourcetype="sap:hana:audit" (action_type IN ("ALTER USER","CREATE USER","DROP USER","GRANT","REVOKE", ...) OR audit_category IN ("User Administration", ...))
```

A single sourcetype like `sap:hana:audit` can route to multiple eventtypes — CONNECT events go to `sap_hana_authentication`, while DDL events go to `sap_hana_change`.

### :material-circle-box:{ .taiconcolor } `default/tags.conf`

Activates CIM tags on each eventtype:

```ini
[eventtype=sap_hana_authentication]
authentication = enabled

[eventtype=sap_hana_change]
change = enabled

[eventtype=sap_abap_gateway_session]
network = enabled
session = enabled
```

When you query `tag=authentication` (or use the Authentication data model), Splunk includes events from every eventtype that has `authentication = enabled`.

## :material-circle-box:{ .taiconcolor } CIM-required field coverage

For each tagged sourcetype, the App's `default/props.conf` provides the CIM-required fields via `EXTRACT-`, `EVAL-`, and `FIELDALIAS-` directives.

### :material-circle-box:{ .taiconcolor } Example: sap:hana:audit

| CIM field | Source |
|---|---|
| `action` | EVAL — `case(action_type=="CONNECT" AND status=="SUCCESSFUL", "success", action_type=="CONNECT" AND status IN ("UNSUCCESSFUL","FAILED"), "failure", match(action_type,"(?i)create"), "created", match(action_type,"(?i)alter|grant|revoke"), "modified", ...)` |
| `app` | EVAL literal `"sap_hana"` |
| `vendor_product` | EVAL literal `"SAP HANA"` |
| `user` | FIELDALIAS-user = `executing_user` (the user PERFORMING the action) |
| `dest_user` | FIELDALIAS-dest_user = `target_user` (the affected user, for Change model) |
| `src` | FIELDALIAS-src = `client_ip` |
| `dest` | FIELDALIAS-dest = `db_hostname` |
| `change_type` | EVAL — `case(match(action_type,"(?i)(user|role|grant|revoke)"), "account", ...)` |
| `object` | FIELDALIAS-object = `target_user` |
| `object_category` | EVAL — `case(match(action_type,"(?i)user"), "user account", ...)` |

Same pattern applies to other sourcetypes. See `default/props.conf` in the App package for the full per-sourcetype field-mapping detail.

## :material-circle-box:{ .taiconcolor } Verifying CIM compliance

Run the following on a Splunk instance with the App installed (and the underlying SAP-side data ingested):

```spl
| datamodel Authentication search
| search sourcetype IN ("sap:hana:audit","sap:sapstartsrv","sap:scc:audit","linux:sudolog")
| stats count by sourcetype Authentication.action
```

You should see results like:

```
sourcetype                  Authentication.action  count
linux:sudolog               success                369
sap:hana:audit              failure                19
sap:hana:audit              success                604
sap:sapstartsrv             failure                566
sap:scc:audit               failure                27
```

Repeat for the other models:

```spl
| datamodel Change search | search sourcetype IN ("sap:hana:audit","sap:scc:audit") | stats count by sourcetype All_Changes.action
| datamodel Web search | search sourcetype IN ("sap:webdispatcher:access","sap:scc:http_access","sap:abap:icm") | stats count by sourcetype Web.action
| datamodel Network_Sessions search | search sourcetype IN ("sap:abap:gateway","sap:saprouter") | stats count by sourcetype
```

If `| datamodel ...` returns rows for our sourcetypes, ES can consume them — every standard ES Authentication / Change / Web / Network_Sessions correlation search will include SAP-side events automatically.

## :material-circle-box:{ .taiconcolor } Sourcetype coverage matrix

| Sourcetype | Tagged into | Severity |
|---|---|---|
| `sap:hana:audit` | Authentication + Change | (CONNECT events: high-priority for ES Auth dashboards) |
| `sap:webdispatcher:access` | Web | medium |
| `sap:scc:http_access` | Web | medium |
| `sap:abap:icm` | Web | medium |
| `sap:abap:gateway` | Network_Sessions | medium |
| `sap:saprouter` | Network_Sessions | medium |
| `sap:sapstartsrv` | Authentication | medium |
| `sap:scc:audit` | Authentication (ACCESS_DENIED) + Change (CONFIGURATION_CHANGED, SERVICE_*) | medium |
| `linux:sudolog` | Authentication + privileged | medium |

## :material-circle-box:{ .taiconcolor } Known limitations

### :material-circle-box:{ .taiconcolor } F5: Web events appear at two tiers

Both `sap:webdispatcher:access` (front-end TLS-terminating load balancer) and `sap:scc:http_access` (backend tunnel traversal) capture HTTP events for the same logical request chain. ES's Web data model surfaces both as distinct events.

This is correct CIM-aligned behavior — each tier records its own view, and ES dashboards can drill into either. But correlation queries that count "unique HTTP requests" should dedupe carefully (e.g., by the request-id field if both tiers carry one, or by `_time` window + `client_ip` + `uri`).

### :material-circle-box:{ .taiconcolor } F6: Some sourcetypes have no clean CIM fit

ABAP application-tier internal logs (`sap:abap:dispatcher`, `sap:abap:enqueueserver`, `sap:abap:event`, `sap:abap:messageserver`, `sap:abap:sapstartsrv`, `sap:abap:workprocess`) and HANA tracelogs (`sap:hana:tracelogs`) don't map cleanly to any stock Splunk CIM model. The App provides rich search-time fields for them but doesn't force a poor-fit mapping. Our own dashboards consume these directly; ES correlation searches built on these would need to use sourcetype-explicit SPL rather than CIM-data-model search.

### :material-circle-box:{ .taiconcolor } sap:abap:audit currently has minimal extraction

The ABAP security audit log (`sap:abap:audit`) is binary/hex format. The App extracts SID + instance + the audit marker; richer field extraction would require a more accessible source format (e.g., SM20/SM19 export) is available. As a result, this sourcetype is currently NOT tagged into Authentication or Change — events are in the index but not in CIM dashboards. Expected to land in a future release.
