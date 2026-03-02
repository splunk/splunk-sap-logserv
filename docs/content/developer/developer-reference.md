# Developer Reference: Architecture and Internals

### :material-circle-box:{ .taiconcolor } Overview

This document covers the internal architecture of the SAP LogServ TA's filtering and deployment automation system. It is intended for developers who need to maintain, extend, or test the TA.

The filtering system provides index-time event filtering via TRANSFORMS-based queue routing. It includes a UI built on UCC (Splunk Universal Configuration Console), custom REST handlers, deployment server automation, and background scripted inputs for daily maintenance and upgrade detection.

<br>

### :material-circle-box:{ .taiconcolor } Architecture Summary

```
+-------------------------------------------------------+
|  Splunk Web (UCC Configuration UI)                    |
|  Configuration -> Filters tab                         |
|  + filter_settings_hook.js (Deploy button, banners)   |
+---------------------------+---------------------------+
                            | Save
                            v
+-------------------------------------------------------+
|  rh_filter_settings.py (REST Handler)                 |
|  - Validates patterns                                 |
|  - Saves settings to settings conf                    |
|  - Generates local/transforms.conf + local/props.conf |
|  - Mirrors to deployment-apps/ (if DS)                |
|  - Creates server class (if DS, first time)           |
|  - Reloads confs via REST API                         |
+---------------------------+---------------------------+
                            |
              +-------------+-------------+
              v                           v
    +------------+          +--------------------+
    | Single     |          | Deployment Server  |
    | Instance   |          |                    |
    | (done)     |          | deployment-apps/   |
    +------------+          | + serverclass.conf |
                            | + Deploy button    |
                            +---------+----------+
                                      | Phone home
                                      v
                            +------------------+
                            | Heavy Forwarders |
                            | (receive TA +    |
                            |  filter configs) |
                            +------------------+
```

<br>

### :material-circle-box:{ .taiconcolor } Source File Map

All source files live under the UCC package directory:

```
sap_logserv_package/splunk_ta_sap_logserv/
├── globalConfig.json                          # UCC UI definition (Filters tab)
├── additional_packaging.py                    # UCC build hook (web.conf expose)
└── package/
    ├── bin/
    │   ├── splunk_ta_sap_logserv_filter_utils.py      # Core library
    │   ├── splunk_ta_sap_logserv_rh_filter_settings.py # REST handler: Filters tab
    │   ├── splunk_ta_sap_logserv_rh_deployment_push.py # REST handler: Deploy button
    │   ├── logserv_filter_time_refresh.py              # Daily epoch cutoff refresh
    │   └── logserv_filter_upgrade_check.py             # Upgrade coverage check
    ├── default/
    │   ├── transforms.conf    # Sourcetype routing + @logserv_filter annotations
    │   ├── props.conf         # Sourcetype configs, TRANSFORMS chains
    │   └── inputs.conf        # Scripted input schedules
    └── appserver/static/js/build/custom/
        └── filter_settings_hook.js   # UCC hook (DS detection, Deploy button)
```

<br>

---

## Key Components

### :material-circle-box:{ .taiconcolor } Core Library

**filter_utils.py**{style="font-size: 1.2em;"}

This is the central module. All other components import from it.

#### :material-crop-square:{ .taiconcolor } Key Functions

| Function | Purpose |
|----------|---------|
| `discover_supported_types(app_path)` | Scans `default/transforms.conf` for `@logserv_filter` annotations |
| `find_uncovered_types(supported, patterns)` | Compares supported types against user include patterns |
| `parse_comma_patterns(string)` | Splits comma-separated pattern string into list |
| `validate_patterns(patterns, field_name)` | Validates pattern syntax (dir/subdir format, valid characters) |
| `validate_single_pattern(pattern)` | Validates one pattern against rules |
| `generate_transforms_stanzas(include, exclude, days)` | Generates filter transform stanzas with regex |
| `generate_props_filter_lines(include, exclude, days, enabled)` | Generates the `TRANSFORMS-00-filter` line |
| `write_local_conf(app_path, conf_type, content)` | Writes between marker comments in local conf files |
| `is_deployment_server(session_key)` | Two-step DS detection (roles + client probe) |
| `ensure_deployment_app_synced(app_path)` | Full app copy/upgrade to deployment-apps/ |
| `mirror_to_deployment_apps(app_path)` | Copies local/transforms.conf and local/props.conf |
| `ensure_serverclass(session_key)` | Creates server class + app mapping via REST + file |
| `get_ta_version(app_path)` | Reads version from app.manifest |
| `get_server_roles(session_key)` | Queries /services/server/info for roles |

#### :material-crop-square:{ .taiconcolor } Constants

| Constant | Value | Purpose |
|----------|-------|---------|
| `APP_NAME` | `splunk_ta_sap_logserv` | App directory name |
| `SERVERCLASS_NAME` | `SAP_LogServ_HeavyForwarders` | Auto-created server class name |
| `SETTINGS_CONF` | `splunk_ta_sap_logserv_settings` | UCC settings conf file |
| `FILTER_STANZA` | `filter_settings` | Stanza name in settings conf |
| `FILTER_MARKER_START` / `FILTER_MARKER_END` | Marker comments | Delimit generated content in local conf files |

<br>

### :material-circle-box:{ .taiconcolor } Filters Tab REST Handler

**rh_filter_settings.py**{style="font-size: 1.2em;"}

UCC REST handler (extends `AdminExternalHandler`) registered in `globalConfig.json`. Handles the Save action:

1. **Validates** patterns server-side (blocks save on failure via `admin.ArgValidationException`)
2. **Saves** settings to `splunk_ta_sap_logserv_settings.conf` (default UCC behavior)
3. **Generates** `local/transforms.conf` and `local/props.conf` with filter stanzas
4. **Reloads** confs via REST API (`/configs/conf-transforms/_reload`, `/configs/conf-props/_reload`)
5. **Mirrors** to deployment-apps if on a DS
6. **Creates** server class if on a DS (first time only)
7. **Checks** for uncovered types and manages system message banner

<br>

### :material-circle-box:{ .taiconcolor } Deploy Button REST Handler

**rh_deployment_push.py**{style="font-size: 1.2em;"}

Persistent REST handler (`PersistentServerConnectionApplication`) registered in `restmap.conf`. Provides two endpoints:

- **GET** `/services/splunk_ta_sap_logserv/deployment_push` — Returns `is_deployment_server` boolean and server class status (used by the JS hook to render the UI)
- **POST** — Triggers deployment reload via `/services/deployment/server/config/_reload`

!!! note
    Persistent handlers do NOT get `import_declare_test`. They require explicit `sys.path` setup for the app's `bin/` and `lib/` directories at the top of the file.

!!! note
    Custom persistent endpoints require an `[expose:]` stanza in `web.conf` to be accessible through the Splunk Web proxy (port 8000). This is handled by `additional_packaging.py` during the UCC build.

<br>

### :material-circle-box:{ .taiconcolor } UCC Hook

**filter_settings_hook.js**{style="font-size: 1.2em;"}

JavaScript hook loaded by UCC on the Filters tab. Lifecycle methods:

- `onCreate` / `onRender` / `onEditLoad` — Calls `checkDeploymentServer()` to GET the deployment push endpoint. If DS detected, injects the deploy banner, server class guidance notices, and Deploy button into the DOM
- `onSaveSuccess` — Triggers `window.location.reload()` after 500ms to reflect server-side changes

<br>

### :material-circle-box:{ .taiconcolor } Daily Time Refresh

**logserv_filter_time_refresh.py**{style="font-size: 1.2em;"}

Scripted input (runs every 86400 seconds / once per day):

1. Reads filter settings from the settings conf via REST
2. Regenerates `local/transforms.conf` and `local/props.conf` with updated epoch cutoff regex
3. Mirrors to deployment-apps if on a DS
4. Reloads confs

:material-lightning-bolt:{ .taiconcolor } **Deployment client guard:** If the instance is a deployment client (HF) but NOT a deployment server, the script skips execution entirely. This prevents HFs from overwriting filter configs pushed by the DS.

<br>

### :material-circle-box:{ .taiconcolor } Upgrade Coverage Check

**logserv_filter_upgrade_check.py**{style="font-size: 1.2em;"}

Scripted input (runs every 600 seconds / 10 minutes):

1. Compares current TA version against last-checked version (persisted in state file)
2. On version change, discovers supported types from `@logserv_filter` annotations
3. Compares against user's include patterns
4. Creates a Splunk system message banner if uncovered types are found

??? tip "Performance"
    The version check is ~2ms on unchanged runs. Full comparison only runs once per version change.

<br>

---

## How Filtering Works Technically

### :material-circle-box:{ .taiconcolor } Filter Chain

All filtering happens via a single `TRANSFORMS-00-filter` line in `local/props.conf` under the `[sap_logserv_logs]` stanza. The `00` prefix ensures filters run before any sourcetype routing transforms (`01`–`99`).

The filter chain is evaluated left to right:

1. **`logserv_filter_include_drop`** — Drops ALL events (sends to `nullQueue`)
2. **`logserv_filter_include_allow`** — Rescues events matching include patterns (sends back to `indexQueue`)
3. **`logserv_filter_time_drop`** — Drops events with old timestamps (sends to `nullQueue`)
4. **`logserv_filter_exclude_*`** — Drops events matching exclude patterns (sends to `nullQueue`)

This "deny-all, then allow" approach ensures only explicitly included events pass through.

<br>

### :material-circle-box:{ .taiconcolor } Include/Exclude Regex Generation

User-facing fnmatch patterns (e.g., `linux/*`) are converted to Splunk-compatible regex that matches against the raw NDJSON event data. The include_allow regex uses lookahead assertions to match `clz_dir` and `clz_subdir` fields:

```
^(?=.*"clz_dir"\s*:\s*"linux")(?=.*"clz_subdir"\s*:\s*".+")
```

Multiple include patterns are OR'd together with `|`.

<br>

### :material-circle-box:{ .taiconcolor } Time Filter Regex

The time filter matches epoch timestamps in the raw JSON `"_time"` field. Since TRANSFORMS cannot use dynamic expressions (unlike INGEST_EVAL which is unavailable on Splunk Cloud), the cutoff is a pre-computed regex that matches epoch values less than the cutoff. This regex must be refreshed daily to maintain accuracy.

??? tip "Failure mode"
    If the daily refresh doesn't run, the cutoff becomes one day older, filtering slightly more data. This is the safer direction.

<br>

### :material-circle-box:{ .taiconcolor } Why TRANSFORMS Instead of INGEST_EVAL

`INGEST_EVAL` is the preferred modern approach for index-time filtering, but it is **unavailable on Splunk Cloud** (heavy forwarders managed by Splunk Cloud don't support it). TRANSFORMS-based filtering works on all deployment architectures including Splunk Cloud with on-premises Heavy Forwarders.

<br>

---

## Deployment Server Automation

### :material-circle-box:{ .taiconcolor } DS Detection

Two-step detection in `is_deployment_server()`:

1. **Fast path** — Check `server_roles` from `/services/server/info` for `deployment_server`
2. **Fallback** — If role is absent, query `/services/deployment/server/clients` to check for connected deployment clients. Returns true only if at least one client is connected

??? tip "Why the fallback exists"
    Splunk drops the `deployment_server` role when no `serverclass.conf` exists. The `/services/deployment/server/config` endpoint cannot be used as a fallback because it returns HTTP 200 on ALL Splunk Enterprise instances (including HFs), causing false positives.

<br>

### :material-circle-box:{ .taiconcolor } Server Class Creation

`ensure_serverclass()` creates `SAP_LogServ_HeavyForwarders` in two steps:

1. **REST API** — POST to `/services/deployment/server/serverclasses` with `name` parameter to create the server class

    :material-lightning-bolt:{ .taiconcolor } The `disabled` parameter is NOT supported during creation (Splunk returns an error).

2. **File-based app mapping** — After REST creates the server class, the function locates the resulting `serverclass.conf` (which Splunk may write to `system/local/` or `apps/search/local/`) and appends the app mapping stanza:

```ini
[serverClass:SAP_LogServ_HeavyForwarders:app:splunk_ta_sap_logserv]
restartSplunkd = true
stateOnClient = enabled
```

!!! note
    The app mapping cannot be created via REST API — the URL path format `serverclasses/{name}/app:{appname}` returns HTTP 404.

<br>

### :material-circle-box:{ .taiconcolor } Deployment Client Guard

The `logserv_filter_time_refresh.py` scripted input checks whether the instance is a deployment client (but not a DS). If so, it skips execution to prevent overwriting filter configs that were pushed by the DS. Without this guard, the time refresh script would read the HF's empty local settings, regenerate configs with only a time filter, and overwrite the complete filter chain.

<br>

---

## Adding Support for New Sourcetypes

### :material-circle-box:{ .taiconcolor } Step 1: Add a Routing Transform

Add the `@logserv_filter` annotation on the line immediately above the stanza header in `default/transforms.conf`:

```ini
# @logserv_filter: newdir/newsubdir
[set_srctype_for_new_logtype]
REGEX = "clz_subdir":"newsubdir"
FORMAT = sourcetype::sap:newlogtype
DEST_KEY = MetaData:Sourcetype
```

:material-lightning-bolt:{ .taiconcolor } **The annotation is critical.** It declares which `clz_dir/clz_subdir` values the transform handles. Without it, the upgrade check cannot detect that a new log type is supported, and users won't be notified.

Multiple values can be comma-separated:

```ini
# @logserv_filter: newdir/type_a, newdir/type_b, newdir/type_c
[set_srctype_for_new_dir]
REGEX = "clz_subdir":"(type_a|type_b|type_c)"
FORMAT = sourcetype::sap:newdir:logs
DEST_KEY = MetaData:Sourcetype
```

<br>

### :material-circle-box:{ .taiconcolor } Step 2: Add to TRANSFORMS Chain

Add your new transform to the appropriate `TRANSFORMS-*` line in the `[sap_logserv_logs]` stanza of `default/props.conf`:

```ini
[sap_logserv_logs]
...
TRANSFORMS-07-srctype_for_newdir = set_srctype_for_new_logtype
```

Use a number between `01` and `98` for the TRANSFORMS prefix. `00` is reserved for filters and `99` is reserved for `set_raw_only`.

<br>

### :material-circle-box:{ .taiconcolor } Step 3: Add Sourcetype Configuration

If the new sourcetype needs field extractions, calculated fields, or CIM field aliases, add a `[sap:newlogtype]` stanza to `default/props.conf`.

<br>

### :material-circle-box:{ .taiconcolor } Step 4: Bump the Version

Update the version in `package/app.manifest` (and `globalConfig.json` if applicable). This triggers the upgrade check to compare the new annotations against existing user include patterns.

??? tip "What Happens on Upgrade"
    1. The `logserv_filter_upgrade_check.py` scripted input detects the version change within 10 minutes
    2. It scans the updated `default/transforms.conf` for `@logserv_filter` annotations
    3. If the user's include patterns don't cover the new log types, a system message banner appears across all Splunk Web pages
    4. The user updates their include patterns (or uses `*/*`) and the banner clears

<br>

---

## Testing Environments

### :material-circle-box:{ .taiconcolor } Environment 1: Single Instance (Standalone)

**Setup:** One Splunk Enterprise instance acting as Search Head, Indexer, and data receiver.

??? tip "What to test"
    - Filter save generates correct `local/transforms.conf` and `local/props.conf`
    - Conf reload works without restart
    - Include, exclude, and time filters work correctly in search results
    - Disabling filtering clears the generated conf files
    - Pattern validation blocks invalid input
    - No deployment server UI elements appear (no banner, no deploy button)

<br>

### :material-circle-box:{ .taiconcolor } Environment 2: Deployment Server + Heavy Forwarders

**Setup:** Three instances minimum: DS (can be combined with SH/Indexer), HF-01 (deployment client), HF-02 (deployment client).

??? tip "What to test"
    - DS detection works (banner and deploy button appear)
    - Filter save triggers full app copy to `deployment-apps/`
    - Filter configs are mirrored to `deployment-apps/local/`
    - Server class `SAP_LogServ_HeavyForwarders` is auto-created with app mapping
    - Client targeting (IP-based) matches HFs correctly
    - Deploy button triggers reload and HFs receive the TA
    - Filter update round-trip: change on DS → deploy → verify on HFs
    - Time refresh script skips on HFs (deployment client guard)
    - Time refresh script runs correctly on DS and mirrors updated configs

<br>

### :material-circle-box:{ .taiconcolor } Environment 3: Splunk Cloud + On-Premises Heavy Forwarders

**Setup:** Splunk Cloud instance (Search Head / Indexer), separate on-premises DS, on-premises HFs configured as deployment clients.

??? tip "What to test"
    - Same as Environment 2, but additionally verify:
    - The TA is installed on the Splunk Cloud instance for dashboards and search-time knowledge objects, but filtering is NOT configured there
    - Filter configuration and TA distribution to HFs are managed entirely from the on-premises DS
    - Filtering works at the HF level before data reaches Splunk Cloud
    - No INGEST_EVAL dependency (TRANSFORMS-only filtering)

<br>

### :material-circle-box:{ .taiconcolor } Environment 4: Fresh DS with No Prior Server Classes

**Setup:** DS with deployment clients connected but no `serverclass.conf` exists.

??? tip "What to test"
    - DS detection works via the fallback (connected clients check)
    - `ensure_serverclass()` creates `serverclass.conf` from scratch
    - The `deployment_server` role activates after server class creation
    - Full deployment workflow completes successfully

<br>

---

## Known Gotchas and Technical Notes

### :material-circle-box:{ .taiconcolor } Persistent Handler sys.path

Persistent REST handlers (`rh_deployment_push.py`) do NOT get `import_declare_test` from UCC. They require explicit `sys.path` setup at the top of the file to import from the app's `bin/` and `lib/` directories. Without this, the handler returns 500 errors from splunkd.

<br>

### :material-circle-box:{ .taiconcolor } web.conf Expose Stanza

Custom persistent endpoints are not accessible through the Splunk Web proxy (port 8000) by default. They require an `[expose:]` stanza in `web.conf`. This is injected by `additional_packaging.py` during the UCC build:

```ini
[expose:splunk_ta_sap_logserv_deployment_push]
pattern = splunk_ta_sap_logserv/deployment_push
methods = POST, GET
```

<br>

### :material-circle-box:{ .taiconcolor } Server Class REST API Limitations

- The `disabled` parameter is NOT accepted during server class creation. Create first, then POST to the specific server class URL to disable
- App mappings (`:app:appname` stanzas) CANNOT be created via REST API. The URL format returns 404. Use file-based append instead
- Splunk may write `serverclass.conf` to different locations (`system/local/` or `apps/search/local/`). The code searches multiple locations

<br>

### :material-circle-box:{ .taiconcolor } Deployment Client Config Overwrite

Without the deployment client guard in `logserv_filter_time_refresh.py`, HFs would regenerate filter configs from their own (empty) local settings on the daily time refresh run. This overwrites the complete filter chain pushed by the DS with only a time filter. The guard checks for the `deployment_client` role and skips execution if found.

<br>

### :material-circle-box:{ .taiconcolor } TRANSFORMS-00-filter Ordering

The filter TRANSFORMS line MUST use prefix `00` to ensure it runs before sourcetype routing (`01`–`99`). If filters ran after routing, events would already have their sourcetype set but would then be dropped, wasting processing.

<br>

### :material-circle-box:{ .taiconcolor } Marker Comments

Generated filter content in `local/transforms.conf` and `local/props.conf` is wrapped in marker comments:

```
### BEGIN LOGSERV FILTER CONFIG - DO NOT EDIT MANUALLY ###
...
### END LOGSERV FILTER CONFIG ###
```

The `write_local_conf()` function replaces content between these markers (or appends them if not present). Manual customizations outside the markers are preserved.

<br>

### :material-circle-box:{ .taiconcolor } DS Role Disappears Without Server Classes

Splunk removes the `deployment_server` role from `server_roles` when no server class is defined in any `serverclass.conf`. The `is_deployment_server()` fallback handles this by checking for connected deployment clients via the `/services/deployment/server/clients` endpoint. This endpoint returns 0 clients on HFs (no false positives) and returns connected clients on a real DS even without any server classes.

:material-lightning-bolt:{ .taiconcolor } The `/services/deployment/server/config` endpoint CANNOT be used as a fallback because it returns HTTP 200 on ALL Splunk Enterprise instances, including HFs.
