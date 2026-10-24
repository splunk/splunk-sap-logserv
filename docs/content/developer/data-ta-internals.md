# Data TA Internals

This page describes how the Data TA (`splunk_ta_sap_logserv`) works inside: its filtering, its Deployment Server automation, the server-side part of the AWS S3 Direct screen, its build-time patches, and the internals of the LogServ Azure and GCP add-ons. It is for developers who maintain, extend or test these packages; to install or configure them, use the install guides.

## :material-circle-box:{ .taiconcolor } Overview

The filtering system provides index-time event filtering via TRANSFORMS-based queue routing. It includes a UI built on UCC (Splunk Universal Configuration Console), custom REST handlers, Deployment Server automation, and background scripted inputs for daily maintenance and upgrade detection.

## :material-circle-box:{ .taiconcolor } Architecture Summary

```
+-------------------------------------------------------+
|  Splunk Web (UCC Configuration UI)                    |
|  Configuration -> Filters + Cloud Provider tabs       |
|  + filter_settings_hook.js (Deploy button, banners)   |
+---------------------------+---------------------------+
                            | Save
                            v
+-------------------------------------------------------------+
|  splunk_ta_sap_logserv_rh_filter_settings.py (REST Handler) |
|  - Validates patterns                                       |
|  - Saves settings to settings conf                          |
|  - Generates local/transforms.conf + local/props.conf       |
|  - Syncs and mirrors to deployment-apps/ (if DS)            |
|  - Creates server class (if DS, first time)                 |
|  - Reloads confs via REST API                               |
+---------------------------+---------------------------------+
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

## :material-circle-box:{ .taiconcolor } Source File Map

All source files live under the UCC package directory:

```
sap_logserv_package/splunk_ta_sap_logserv/
|-- globalConfig.json                          # UCC UI definition (Filters + Cloud Provider tabs)
|-- additional_packaging.py                    # UCC post-build patcher (see Build-Time Patches)
|-- run_appinspect.sh                          # Dev tool — MUST stay outside package/ (an
|                                              #   executable in package/ trips check_for_bin_files)
`-- package/
    |-- app.manifest                                # TA version and metadata
    |-- README.txt                                  # Where to install (ships in the tarball)
    |-- THIRD-PARTY-NOTICES.md                      # Bundled third-party software
    |-- bin/
    |   |-- splunk_ta_sap_logserv_filter_utils.py        # Core library
    |   |-- splunk_ta_sap_logserv_rh_filter_settings.py  # REST handler: Filters + Cloud Provider tabs
    |   |-- splunk_ta_sap_logserv_rh_deployment_push.py  # REST handler: Deploy button
    |   |-- splunk_ta_sap_logserv_rh_s3_direct_meta.py   # REST handler: AWS S3 Direct cloud_provider stamp
    |   |-- logserv_filter_time_refresh.py               # Daily epoch cutoff refresh
    |   `-- logserv_filter_upgrade_check.py              # Upgrade coverage check
    |-- lib/
    |   `-- requirements.txt   # Exact, hash-pinned Python packages; UCC installs them into lib/
    |-- default/
    |   |-- transforms.conf    # Sourcetype routing + @logserv_filter annotations
    |   |-- props.conf         # Index-time parsing and the TRANSFORMS chains
    |   |-- inputs.conf        # Scripted input schedules
    |   |-- macros.conf        # Index name redirect macro
    |   |-- indexes.conf       # sap_logserv_logs + logserv_ai_assistant_audit
    |   `-- data/ui/
    |       |-- nav/default.xml               # Nav: Configuration, AWS S3 Direct, Search
    |       `-- views/logserv_s3_direct.xml   # The AWS S3 Direct view
    |-- metadata/
    |   `-- default.meta       # Default permissions and export settings
    |-- static/                # App icons (appIcon*.png)
    |-- LICENSES/              # Absorbed-add-on license texts
    `-- appserver/static/
        |-- logserv_s3_direct.js      # AWS S3 Direct screen (Generic S3 backfill inputs)
        |-- logserv_s3_direct.css
        `-- js/build/custom/
            |-- filter_settings_hook.js   # UCC hook (DS detection, Deploy button)
            `-- cloud_provider_hook.js    # UCC hook (Cloud Provider tab)
```

`run_appinspect.sh` runs `--mode precert` without `--included-tags cloud`. Run AppInspect as described in [Building the Packages from Source](build-from-source.md#vet-a-package-with-appinspect) instead.

---

## :material-circle-box:{ .taiconcolor } Build-Time Patches

`additional_packaging.py` runs after `ucc-gen build` has generated the add-on (UCC calls its `cleanup_output_files()`) and patches the output in seven steps:

1. Points the generated settings handler (`bin/splunk_ta_sap_logserv_rh_settings.py`) at `FilterSettingsHandler` instead of the stock `AdminExternalHandler`. UCC wires custom handlers only for tabs with a table, and the Filters tab is a settings tab.
2. Adds `handlertype`, `python.version`, `python.required = 3.13` and `passSystemAuth = true` to every `[admin_external:*]` stanza of `restmap.conf`. `python.required` clears an AppInspect future failure. Splunk defines `passSystemAuth` only for `[script:*]` stanzas, so on `[admin_external:*]` it has no effect: the settings saves of `sc_subadmin` and other roles without `admin_all_objects` are carried by the handler's filesystem fallback (step 2 of [Configuration REST Handler](#configuration-rest-handler-filters-cloud-provider-tabs)). The comment in `additional_packaging.py` that says otherwise is out of date.
3. Appends the `[script:]` stanzas of the two persistent endpoints, `deployment_push` and `s3_direct_meta`, to `restmap.conf`.
4. Appends their `[expose:]` stanzas to `web.conf` (see [web.conf Expose Stanza](#webconf-expose-stanza)).
5. Removes gRPC, protobuf and OpenTelemetry packages from `lib/` if a dependency ever brings them in: their binaries fail AppInspect's AArch64 check. The `solnlib` pin below 8 in `lib/requirements.txt` keeps them out in the first place.
6. Adds `python.required = 3.13` to the `[script://...]` stanzas of `inputs.conf`.
7. Adds `sc_subadmin` to the global write ACL in `metadata/default.meta` (below).

Several of these are AppInspect Cloud fixes: deleting or truncating the file silently regresses the AppInspect result and locks out a delegated `sc_subadmin` role. How to run the build is described in [Building the Packages from Source](build-from-source.md).

### :material-circle-box:{ .taiconcolor } The sc_subadmin Write-ACL Patch

UCC's build template writes `write : [ admin, sc_admin ]` into the generated `metadata/default.meta` and ignores the value in the source's `package/metadata/default.meta`, so it grants write only to `admin` and `sc_admin`. Some Splunk Cloud stacks give their administrators a delegated-admin role named `sc_subadmin`. Splunk does not supply this role, and the packages grant it write access by name (see [Splunk Cloud roles](../getting-started/splunk-cloud.md#splunk-cloud-roles)). Without the patch, that role gets 403 on every write to an object the Data TA owns. (The docstring of `additional_packaging.py` that calls `sc_subadmin` the customer's top administrator role is out of date.) Step 7 re-adds it after the UCC step, and the build prints:

```
[additional_packaging] Patched metadata/default.meta: added sc_subadmin to global write ACL.
```

The LogServ Azure and GCP add-ons apply the same patch in their own `additional_packaging.py`.

To patch a Data TA that is already built, without running UCC again, use the standalone repair script [`tools/scripts/patch_data_ta_sc_subadmin_metadata.py`](https://github.com/splunk/splunk-sap-logserv/tree/main/tools/scripts):

```bash
# Against an extracted Data TA directory:
python3 tools/scripts/patch_data_ta_sc_subadmin_metadata.py /path/to/extracted/splunk_ta_sap_logserv

# Against a tarball (extracts, patches, repacks in place + .pre-sc_subadmin-patch.bak backup):
python3 tools/scripts/patch_data_ta_sc_subadmin_metadata.py --tarball /path/to/splunk_ta_sap_logserv-X.Y.Z.tar.gz
```

Both invocations are idempotent: running on already-patched input is a no-op (a tarball is then neither repacked nor backed up). The script exits 0 when it patched or found nothing to change; 1 when the tarball or `metadata/default.meta` is missing, or the file does not hold the expected stock ACL; and 2 when a tar step fails or the tarball does not hold exactly one top-level directory. A failed repack restores the tarball from the backup.

---

## :material-circle-box:{ .taiconcolor } Key Components

### :material-circle-box:{ .taiconcolor } Core Library

**splunk_ta_sap_logserv_filter_utils.py**{style="font-size: 1.2em;"}

This is the central module. All other components import from it.

#### :material-crop-square:{ .taiconcolor } Key Functions

| Function | Purpose |
|----------|---------|
| `get_app_path()` | Determines the app installation path (checks `SPLUNK_HOME`, falls back to relative path) |
| `discover_supported_types(app_path)` | Scans `default/transforms.conf` for `@logserv_filter` annotations |
| `find_uncovered_types(supported, patterns)` | Compares supported types against user include patterns |
| `parse_comma_patterns(string)` | Splits a folder-pattern field (Include / Exclude Filters) into a list; empty entries are dropped |
| `parse_source_patterns(value)` | Splits a source field (Include / Exclude Sources) into its entries; only spaces around an entry are stripped, and empty entries are kept so that validation rejects a doubled or trailing comma |
| `validate_patterns(patterns, field_name)` | Validates folder-pattern syntax (dir/subdir format, valid characters) |
| `validate_single_pattern(pattern)` | Validates one folder pattern against rules |
| `validate_source_entry(entry)` / `validate_source_patterns(patterns, field_name)` | Validate source entries against the grammar in [Validation Layers](#validation-layers); the message names the field and the entry |
| `validate_source_field(value, field_name)` | Validates a whole source field value as submitted or stored: its length, then every entry |
| `filter_pattern_fragment(pattern)` | The hand-written translator `f(p)`: one folder segment or source pattern to the REGEX fragment of a JSON value; raises on any character it does not know |
| `filter_lookahead(key, fragment)` | One condition `LA(key, frag)` for `clz_dir`, `clz_subdir` or `source` |
| `is_pass_all_include(include_patterns)` | Whether Include Filters keeps every event (no include gate) |
| `fnmatch_patterns_to_combined_regex(patterns)` | Compatibility helper kept for existing importers: one REGEX in the generator's shape for a folder list, without chunking |
| `epoch_cutoff_from_days(days_in_past)` | Computes the epoch timestamp for midnight N days ago (UTC) |
| `generate_epoch_less_than_regex(cutoff_epoch)` | Generates a digit-by-digit regex matching epoch values less than the cutoff |
| `generate_transforms_stanzas(include, exclude, days, include_sources=None, exclude_sources=None)` | Generates the filter transform stanzas; re-validates every entry and raises on an invalid one |
| `generate_props_filter_lines(include, exclude, days, enabled, include_sources=None, exclude_sources=None)` | Generates the `TRANSFORMS-00-filter` line naming exactly the stanzas `generate_transforms_stanzas` emits, in chain order |
| `write_local_conf(app_path, conf_name, content)` | Writes between marker comments in local conf files |
| `write_local_conf_section(app_path, conf_name, content, marker_start, marker_end)` | Generalised marker-block writer — lets two independent marker blocks (filter + cloud provider) coexist in one local conf |
| `update_local_stanza(app_path, conf_name, stanza, kv)` | Direct filesystem stanza write — the `RestError[403]` fallback used when the caller lacks `admin_all_objects` |
| `get_ta_version(app_path)` | Reads `[launcher] version` from `default/app.conf` (falls back to `app.manifest` if not present) |
| `get_server_roles(session_key)` | Queries /services/server/info for roles |
| `is_deployment_server(session_key)` | Two-step DS detection (roles + client probe) |
| `get_deployment_apps_path()` | Returns the `etc/deployment-apps/` path for the TA |
| `ensure_deployment_app_synced(app_path)` | Copies the full app to `deployment-apps/` when no copy exists or the `[launcher] version` differs; otherwise does nothing (see [Deployment-Apps Sync](#deployment-apps-sync)) |
| `mirror_to_deployment_apps(app_path)` | Copies local/transforms.conf and local/props.conf |
| `ensure_serverclass(session_key)` | Creates server class + app mapping via REST + file |

#### :material-crop-square:{ .taiconcolor } Constants

| Constant | Value | Purpose |
|----------|-------|---------|
| `APP_NAME` | `splunk_ta_sap_logserv` | App directory name |
| `SERVERCLASS_NAME` | `SAP_LogServ_HeavyForwarders` | Auto-created server class name |
| `SETTINGS_CONF` | `splunk_ta_sap_logserv_settings` | UCC settings conf file |
| `FILTER_STANZA` | `filter_settings` | Stanza name in settings conf |
| `SYSTEM_MESSAGE_NAME` | `logserv_filter_upgrade_warning` | System message banner name for upgrade warnings |
| `ANNOTATION_PATTERN` | Compiled regex | Matches `@logserv_filter:` annotation comment lines |
| `VALID_SEGMENT_PATTERN` | Compiled regex | Validates characters in dir/subdir pattern segments |
| `FILTER_REGEX_SKIP` | Regex text (`SKIP` in [Filter Regex Generation](#filter-regex-generation)) | Where every generated filter REGEX starts: the line start, or just past the `_raw` value |
| `FILTER_REGEX_GAP` | Regex text (the gap inside `LA` in [Filter Regex Generation](#filter-regex-generation)) | What a lookahead may cross before its key: anything on the line except a `"_raw"` key |
| `FILTER_LOOKAHEAD` | `100000` | `LOOKAHEAD` of every generated filter stanza (= `TRUNCATE` in `default/props.conf`) |
| `FILTER_REGEX_MAX_CHARS` | `8000` | A list whose REGEX would pass this many characters is split into numbered stanzas |
| `SOURCE_PATTERN_MAX_LEN` / `SOURCE_FIELD_MAX_LEN` | `512` / `4096` | Longest source pattern / longest source field value |
| `FILTER_MARKER_START` / `FILTER_MARKER_END` | Marker comments | Delimit generated filter content in local conf files |
| `CLOUD_PROVIDER_MARKER_START` / `CLOUD_PROVIDER_MARKER_END` | Marker comments | Delimit the generated `[logserv_set_cloud_provider]` block — separate from the filter block so the daily time-refresh preserves it |

### :material-circle-box:{ .taiconcolor } Configuration REST Handler (Filters + Cloud Provider tabs)

**splunk_ta_sap_logserv_rh_filter_settings.py**{style="font-size: 1.2em;"}

UCC REST handler (extends `AdminExternalHandler`) registered in `globalConfig.json`. UCC generates ONE `MultipleModel` settings endpoint shared by all Configuration tabs, so this single handler class serves both the **Filters** and the **Cloud Provider** tab — it dispatches on the payload (`if 'cloud_provider' in self.callerArgs.data`), validating against `VALID_CLOUD_PROVIDERS` and writing/clearing the `[logserv_set_cloud_provider]` override inside its own CLOUD_PROVIDER marker block (see [Marker Comments](#marker-comments)); on a DS it then syncs, mirrors and reloads as a Filters save does. For a Filters save it handles the Save action:

1. **Validates** patterns server-side (blocks save on failure via `admin.ArgValidationException`): `include_sources` and `exclude_sources` on **every** save, then every posted value on every save for conf safety (`_validate_posted_values()`: no control character, tab included, and no trailing backslash), the folder patterns and Days in the Past when filtering is enabled — see [Validation Layers](#validation-layers)
2. **Saves** settings to `splunk_ta_sap_logserv_settings.conf` (default UCC behavior — the happy path). **Falls back to a direct filesystem write** when the UCC REST write raises `RestError[403]` ("This operation is forbidden"): splunkd gates `/configs/conf-*` writes on `admin_all_objects` independently of the object metadata ACL, so Splunk Cloud `sc_subadmin` and hardened on-prem `admin` roles fail the REST path. `update_local_stanza()` writes the stanza to `local/<settings>.conf` directly, bypassing that gate (`passSystemAuth` is NOT honoured for UCC `[admin_external:*]` handlers)
3. **Generates** `local/transforms.conf` and `local/props.conf` with filter stanzas, from all five filter fields (`include_filters`, `exclude_filters`, `include_sources`, `exclude_sources`, `days_in_past`) as saved: `_effective_filter_settings()` takes each field the request posts (an emptied field is `''`, as splunktaucclib stores it), and for a field a partial REST/CLI save leaves out the stored value (one GET of `configs/conf-splunk_ta_sap_logserv_settings/filter_settings`, only when a field is missing; on a read failure the old defaults, with a WARNING). Step 1 dry-runs the generators on these values when filtering is enabled, so a value they would refuse is refused before anything is saved
4. **Syncs and mirrors** to deployment-apps if on a DS (full app copy only on the first copy or a version change, then the filter configs; see [Deployment-Apps Sync](#deployment-apps-sync))
5. **Creates** server class if on a DS (first time only)
6. **Reloads** confs via REST API (`/servicesNS/nobody/splunk_ta_sap_logserv/configs/conf-transforms/_reload` and `.../conf-props/_reload`, then `/services/data/transforms/extractions/_reload` and `/services/data/props/extractions/_reload`)
7. **Checks** for uncovered types and manages system message banner

### :material-circle-box:{ .taiconcolor } Deploy Button REST Handler

**splunk_ta_sap_logserv_rh_deployment_push.py**{style="font-size: 1.2em;"}

Persistent REST handler (`PersistentServerConnectionApplication`) registered in `restmap.conf` and gated by the `edit_deployment_server` capability. Provides two endpoints:

- **GET** `/services/splunk_ta_sap_logserv/deployment_push` — Returns `is_deployment_server` and, on a DS, the status of the `SAP_LogServ_HeavyForwarders` server class (exists, disabled, has client targeting); the JS hooks use it to render the UI
- **POST** — Triggers a Deployment Server reload via `/services/deployment/server/config/_reload`

:material-lightning-bolt:{ .taiconcolor } **Deploy to Forwarders reloads the whole Deployment Server.** `/services/deployment/server/config/_reload` reloads every server class on the DS, not only `SAP_LogServ_HeavyForwarders`, so pending changes in other server classes are pushed at the same time. The [Daily Time Refresh](#daily-time-refresh) uses the scoped `serverclasses/<name>/reload` instead.

As a persistent handler it sets up its own `sys.path` and needs an `[expose:]` stanza; see [Persistent Handler sys.path](#persistent-handler-syspath) and [web.conf Expose Stanza](#webconf-expose-stanza).

### :material-circle-box:{ .taiconcolor } AWS S3 Direct Stamp Handler

**splunk_ta_sap_logserv_rh_s3_direct_meta.py**{style="font-size: 1.2em;"}

Persistent REST handler behind `POST /services/splunk_ta_sap_logserv/s3_direct_meta` (form field `name`). The AWS S3 Direct screen (`appserver/static/logserv_s3_direct.js`) creates Generic S3 inputs (`aws_s3://`) in the Splunk Add-on for AWS through that add-on's own UCC endpoint, which has no `_meta` field. Right after each create succeeds, the screen calls this handler, which:

1. accepts only the input names the screen generates (`logserv_backfill_<job>_<folder-slug>_<year>`);
2. writes `_meta = cloud_provider::aws` into that input's stanza through `/servicesNS/nobody/Splunk_TA_aws/configs/conf-inputs/`;
3. disables and re-enables that one input through `data/inputs/aws_s3/<name>`, so the input starts again from the stanza as written.

It calls splunkd with the caller's session token and has no `passSystemAuth` or `capability` line, so every write is checked against the caller's own permissions. The screen therefore offers its **Create** button only to a user with `admin_all_objects`; for anyone else it shows the generated configuration for an administrator to apply. The handler stamps every input it creates without looking at the Cloud Provider dropdown, so with the dropdown on **AWS** both stamps are written; see [Choose Cloud Attribution](../install-setup/cloud-attribution.md).

### :material-circle-box:{ .taiconcolor } UCC Hooks

**filter_settings_hook.js**{style="font-size: 1.2em;"}

JavaScript hook loaded by UCC on the Filters tab. `cloud_provider_hook.js` does the same on the Cloud Provider tab, with its own Deploy to Forwarders button. Lifecycle methods:

- `onCreate` / `onRender` / `onEditLoad` — Calls `checkDeploymentServer()` to GET the deployment push endpoint. If DS detected, injects the deploy banner, server class guidance notices, and Deploy button into the DOM
- `onSaveSuccess` — Triggers `window.location.reload()` after 500ms to reflect server-side changes

### :material-circle-box:{ .taiconcolor } Daily Time Refresh

**logserv_filter_time_refresh.py**{style="font-size: 1.2em;"}

Scripted input (runs every 86400 seconds / once per day):

1. Reads filter settings from the settings conf via REST — all six keys: `filter_enabled`, `include_filters`, `exclude_filters`, `include_sources`, `exclude_sources`, `days_in_past`
2. Regenerates `local/transforms.conf` and `local/props.conf` with updated epoch cutoff regex
3. Mirrors to deployment-apps if on a DS
4. Reloads the `SAP_LogServ_HeavyForwarders` server class if on a DS, in the namespace of the app that holds it (see below), so the heavy forwarders fetch the new cutoff on their next phone-home
5. Reloads confs

It does steps 2–5 only while filtering is enabled and `days_in_past` is above 0; otherwise it logs why and exits.

:material-lightning-bolt:{ .taiconcolor } **Where the scoped reload is sent.** A server-class reload (`deployment/server/serverclasses/<name>/reload`) has to be sent in the namespace of the app whose `serverclass.conf` holds the class. `ensure_serverclass()` creates the class through `/services/...` as the admin who saves the filters, so it lands in that admin's default app — typically `search`, where its ACL reads `app = search`, `owner = nobody`, `sharing = app`. A POST to `/services/deployment/server/serverclasses/SAP_LogServ_HeavyForwarders/reload` resolves in the default app of `splunk-system-user` (the input's `passAuth` user), which need not be the app that holds the class, so the refresh resolves the namespace instead:

1. `GET /servicesNS/-/-/deployment/server/serverclasses/SAP_LogServ_HeavyForwarders?output_mode=json` (read-only) and take `entry[0].acl.app`; the value is used only if it is a plain app name — it matches `[A-Za-z0-9_.-]+` and is not dots only — because it becomes part of a URL path
2. `POST /servicesNS/nobody/<app>/deployment/server/serverclasses/SAP_LogServ_HeavyForwarders/reload`
3. On any failure — no owning app, a refused or failed POST — fall back to `/servicesNS/nobody/search/...`, then to `/services/...`; a path already tried is not tried again, and the first HTTP 200 or 201 ends the sequence

It logs at INFO which path reloaded the class, or a WARNING that lists every path tried and its result when none did. No reload failure raises out of `main()`, and the conf reload of step 5 runs either way. A failed reload only delays the forwarders: they keep the previous cutoff until the next Deploy to Forwarders, and a stale cutoff is **less** restrictive — older events pass — never more.

:material-lightning-bolt:{ .taiconcolor } **A working reload restarts the forwarders once a day.** The cutoff text changes every UTC day, so each run gives the forwarders a changed app, and `ensure_serverclass()` maps the Data TA with `restartSplunkd = true` — each heavy forwarder in the class restarts to apply it. The refresh runs every 86,400 seconds counted from the Deployment Server's last start, so that restart is not tied to a maintenance window. Only a Deployment Server with filtering enabled and `days_in_past` above 0 does this.

:material-lightning-bolt:{ .taiconcolor } **It must read every filter field.** The refresh rewrites the whole FILTER marker block, so a field it does not read and pass to the generators disappears from the generated rules within a day — and on a DS the stripped block is mirrored and pushed to the heavy forwarders by the scoped reload. Any new filter field must be threaded through this script as well as the REST handler.

:material-lightning-bolt:{ .taiconcolor } **Invalid stored values:** the generators re-validate every entry and raise on an invalid one (for example a hand-edited `local/splunk_ta_sap_logserv_settings.conf`). The refresh generates both files before writing either; on an error it logs an ERROR (`level=ERROR` in the script's stderr, which splunkd logs under `component=ExecProcessor`), writes and mirrors nothing, and leaves the last good block in `local/transforms.conf` and `local/props.conf` in place. It never emits a REGEX built from unvalidated text. A stored Include Sources while Include Filters is pass-all is not an error here: the refresh ignores it and logs a WARNING (the handler refuses that combination at save time when filtering is enabled).

:material-lightning-bolt:{ .taiconcolor } **`days_in_past` takes the same ERROR path.** `get_filter_settings()` parses it with `parse_days_in_past()`, the parser the generators use at save, so every value a save turned into a time filter (`7`, `7.0`, `1e1`) is refreshed too; `None` / `''` read as 0 (no time filter, no refresh). A stored value that is not a finite whole number comes back as `days_error`, and `main()` logs it at ERROR through `log_not_refreshed()` — the same message as an invalid pattern — and writes nothing, so the last good block stays in place. A value whose cutoff would fall before 1970 is refused by the generators the same way.

:material-lightning-bolt:{ .taiconcolor } **Deployment client guard:** on a deployment client whose Data TA came from the DS, the script skips the refresh, so a heavy forwarder never overwrites the filter configs the DS pushed; see [Deployment Client Guard](#deployment-client-guard).

### :material-circle-box:{ .taiconcolor } Upgrade Coverage Check

**logserv_filter_upgrade_check.py**{style="font-size: 1.2em;"}

Scripted input (runs every 600 seconds / 10 minutes):

1. Compares current TA version against last-checked version (persisted in state file)
2. On version change, discovers supported types from `@logserv_filter` annotations
3. Compares against user's include patterns (`include_filters` only — exclude patterns and both source fields are not part of the comparison; a list containing `*/*` or `*` covers every type)
4. Creates a Splunk system message banner if uncovered types are found

??? tip "Performance"
    The version check is ~2ms on unchanged runs. Full comparison only runs once per version change.

---

## :material-circle-box:{ .taiconcolor } How Filtering Works Technically

### :material-circle-box:{ .taiconcolor } Filter Chain

All filtering happens via a single `TRANSFORMS-00-filter` line in `local/props.conf` under the `[sap_logserv_logs]` stanza. The `TRANSFORMS-*` classes run in ASCII order of their names, so the `00` prefix puts the filters before the metadata (`01`), sourcetype routing (`02`–`09`), stamp (`50`–`51`) and unwrap (`99`) transforms. Splunk's `props.conf` specification documents only the order of the transforms inside one class; the order across classes is Splunk's observed behaviour. See [TRANSFORMS-00-filter Ordering](#transforms-00-filter-ordering) for why the order matters.

The filter chain is evaluated left to right, and the last transform whose REGEX matches sets the queue:

| # | Stanza | Generated when | REGEX | FORMAT |
|---|--------|----------------|-------|--------|
| 1 | `logserv_filter_include_drop` | include gate on | `.` (every event) | `nullQueue` |
| 2 | `logserv_filter_include_allow` | include gate on | folder includes | `indexQueue` |
| 3 | `logserv_filter_include_sources` | include gate on and `include_sources` not empty | source includes | `indexQueue` |
| 4 | `logserv_filter_time_drop` | `days_in_past` > 0 | epoch < cutoff | `nullQueue` |
| 5 | `logserv_filter_exclude` | `exclude_filters` not empty | folder excludes | `nullQueue` |
| 6 | `logserv_filter_exclude_sources` | `exclude_sources` not empty | source excludes | `nullQueue` |

This "deny-all, then allow" approach ensures only explicitly included events pass through, and placing the time filter and the excludes last makes them win over both include steps.

- **Include gate:** on when the folder include list is not pass-all. The list is **pass-all when it is empty or contains any `*/*` or bare `*` entry**; then stanzas 1–3 are not generated. Earlier builds treated only an exact `['*/*']` as pass-all — `*/*, x` gated out every event without folder fields and a bare `*` was skipped. A bare `*` in `exclude_filters` still excludes nothing.
- **Include Sources while pass-all:** refused by the handler at save time when filtering is enabled ("has no effect"); not generated, with a WARNING from `generate_transforms_stanzas()`, when it reaches the generators anyway (a refresh of a hand-edited conf).
- **Pass-all test:** `is_pass_all_include()` (the old `_is_wildcard_include` name is kept as an alias). A `dir/subdir` entry whose segments are only `*` characters, such as `**/*`, counts as pass-all too.
- **Stanza layout:** every generated stanza has the keys `REGEX`, `FORMAT`, `DEST_KEY = queue` and `LOOKAHEAD = 100000`, in that order (`LOOKAHEAD` last). Each name appears in the props line only when its stanza is generated, and every generated stanza is named in the props line.
- **Chunks:** a long list is split over several stanzas (see [Chunking](#chunking)). Chunk 1 keeps the plain name, chunk *n* ≥ 2 is `<name>_<n>` (`logserv_filter_exclude_2`, ...), and all chunks of a list sit together at the list's place in the line, so last-match-wins is unchanged.

The generated `local/props.conf` block (one line; names shown here for the case where every field is in use and the source exclude list needed two chunks):

```ini
[sap_logserv_logs]
TRANSFORMS-00-filter = logserv_filter_include_drop, logserv_filter_include_allow, logserv_filter_include_sources, logserv_filter_time_drop, logserv_filter_exclude, logserv_filter_exclude_sources, logserv_filter_exclude_sources_2
```

And one generated `local/transforms.conf` stanza (Exclude Sources `/var/log/zypper.log`):

```ini
[logserv_filter_exclude_sources]
REGEX = (?:^|"_raw"\s*:\s*"(?:[^"\\]++|\\.)*+")(?:(?=(?:(?!"_raw")[^\n])*?"source"\s*:\s*"\/var\/log\/zypper\.log"))
FORMAT = nullQueue
DEST_KEY = queue
LOOKAHEAD = 100000
```

The filter transforms run at `TRANSFORMS-00`, before `TRANSFORMS-01-metadata` (`extract_host`, `extract_source`, `extract_clz`), so they match the raw envelope text — the `"source"`, `"clz_dir"` and `"clz_subdir"` keys of the NDJSON line — not `MetaData:Source` or the indexed fields.

### :material-circle-box:{ .taiconcolor } Filter Regex Generation

Folder patterns (`include_filters`, `exclude_filters`) and source patterns (`include_sources`, `exclude_sources`) are translated by one hand-written translator. `fnmatch.translate` is never used: its output changed in Python 3.13, its Python 3.14 output cannot be unwrapped, and its `*` (`.*`) ran past the end of the JSON value into later keys or the `_raw` text. The exact generated text — byte-exact, because the App's Data Doctor parses generated `transforms.conf` back into patterns and its `check:diagnostics` gate pins this shape:

```
SKIP          = (?:^|"_raw"\s*:\s*"(?:[^"\\]++|\\.)*+")
LA(key, frag) = (?=(?:(?!"_raw")[^\n])*?"key"\s*:\s*"frag")
split p on runs of '*'  ->  segments S0, S1, ..., Sk   (k = number of star RUNS; '**' counts as one '*')
seg(S)  : per character - ? -> [^"]   [A-Za-z0-9_] -> itself   any other allowed character c -> backslash + c
k = 0   : f(p) = seg(S0)
k >= 1  : f(p) = seg(S0) + (?>[^"]*?seg(S1)) + ... + (?>[^"]*?seg(S(k-1))) + [^"]* + seg(Sk)
folder   d/s    -> LA(clz_dir, f(d)) LA(clz_subdir, f(s))
source   p      -> LA(source, f(p))
combined d/s=p  -> LA(clz_dir, f(d)) LA(clz_subdir, f(s)) LA(source, f(p))
REGEX of a chunk = SKIP + "(?:" + entries joined by "|" + ")"
```

`SKIP` is `FILTER_REGEX_SKIP` and the gap inside `LA` is `FILTER_REGEX_GAP`. In `seg`, the characters `/ . - : + @ ~` become `\/ \. \- \: \+ \@ \~`. A run of `*` is one or more `*` in a row; every run before the last becomes an atomic group, so the cost stays linear (see [Linear Wildcard Matching](#linear-wildcard-matching)). Golden examples (one entry each):

```
linux/linux_secure      (?:^|"_raw"\s*:\s*"(?:[^"\\]++|\\.)*+")(?:(?=(?:(?!"_raw")[^\n])*?"clz_dir"\s*:\s*"linux")(?=(?:(?!"_raw")[^\n])*?"clz_subdir"\s*:\s*"linux_secure"))
/var/log/zypper.log     (?:^|"_raw"\s*:\s*"(?:[^"\\]++|\\.)*+")(?:(?=(?:(?!"_raw")[^\n])*?"source"\s*:\s*"\/var\/log\/zypper\.log"))
hana/*                  (?:^|"_raw"\s*:\s*"(?:[^"\\]++|\\.)*+")(?:(?=(?:(?!"_raw")[^\n])*?"clz_dir"\s*:\s*"hana")(?=(?:(?!"_raw")[^\n])*?"clz_subdir"\s*:\s*"[^"]*"))
/var/log/YaST2/*        (?:^|"_raw"\s*:\s*"(?:[^"\\]++|\\.)*+")(?:(?=(?:(?!"_raw")[^\n])*?"source"\s*:\s*"\/var\/log\/YaST2\/[^"]*"))
linux/linux_secure=/var/log/zypper.log
                        (?:^|"_raw"\s*:\s*"(?:[^"\\]++|\\.)*+")(?:(?=(?:(?!"_raw")[^\n])*?"clz_dir"\s*:\s*"linux")(?=(?:(?!"_raw")[^\n])*?"clz_subdir"\s*:\s*"linux_secure")(?=(?:(?!"_raw")[^\n])*?"source"\s*:\s*"\/var\/log\/zypper\.log"))
```

Golden examples with more than one `*` (source entries; the whole chunk REGEX):

```
/usr/sap/*/trace/*             (?:^|"_raw"\s*:\s*"(?:[^"\\]++|\\.)*+")(?:(?=(?:(?!"_raw")[^\n])*?"source"\s*:\s*"\/usr\/sap\/(?>[^"]*?\/trace\/)[^"]*"))
*zypper*                       (?:^|"_raw"\s*:\s*"(?:[^"\\]++|\\.)*+")(?:(?=(?:(?!"_raw")[^\n])*?"source"\s*:\s*"(?>[^"]*?zypper)[^"]*"))
/usr/sap/*/HDB*/*/trace/*.trc  (?:^|"_raw"\s*:\s*"(?:[^"\\]++|\\.)*+")(?:(?=(?:(?!"_raw")[^\n])*?"source"\s*:\s*"\/usr\/sap\/(?>[^"]*?\/HDB)(?>[^"]*?\/)(?>[^"]*?\/trace\/)[^"]*\.trc"))
/var/log/**/x.log              (?:^|"_raw"\s*:\s*"(?:[^"\\]++|\\.)*+")(?:(?=(?:(?!"_raw")[^\n])*?"source"\s*:\s*"\/var\/log\/[^"]*\/x\.log"))
```

How the shape works:

- **Whole-value, case-sensitive matching.** Each condition ends with the value's closing `"`, so a pattern matches the whole value. `?` becomes `[^"]`, and a run of `*` becomes `[^"]*` or, before the last run, a lazy `[^"]*?` inside an atomic group, so a wildcard can never leave its JSON value; a source `*` crosses `/` (it is still inside the value). The generated PCRE does not fold case.
- **Where the search starts.** In Azure and GCP envelopes `source`, `clz_dir` and `clz_subdir` sit before `_raw`; in AWS envelopes after it (`_raw, _time, host, source, clzfilename, clz_dir, clz_subdir`). In both layouts the metadata keys are grouped and never separated by `_raw`. `SKIP` therefore anchors either at the line start or right after the `_raw` value — the same possessive skip `[set_raw_only]` ships with — and each condition is a lookahead whose gap may not run past a `"_raw"` key, so text inside the event is never searched for envelope keys. JSON escaping inside `_raw` puts a backslash before every quote, so an unescaped `"key"` cannot match there anyway. An envelope that puts `_raw` between the keys one entry needs does not match that entry: a folder entry needs `clz_dir` and `clz_subdir`, and a combined entry also `source`, on the same side of `_raw`. A plain source entry needs only `source`, which one of the two starts always reaches, so it still matches (split envelopes have never been seen).
- **Order-free conditions.** The lookaheads of one entry may match in any key order.
- **Plain source entries reach events without folder fields**; folder and combined entries need both `clz_dir` and `clz_subdir`.
- **The time stanza** keeps its unanchored `"_time"` epoch regex and gains `LOOKAHEAD = 100000`.

??? tip "Why this shape — Splunk PCRE probes"
    Every candidate was run on Splunk's own PCRE as `rex field=line "(?<h>REGEX)"` with `match_limit = 100000` and `depth_limit = 1000` (the transforms.conf `MATCH_LIMIT` / `DEPTH_LIMIT` defaults), over synthetic envelopes of 177 and 99,162 bytes in the AWS order, the clz-first order and a split order, with and without JSON-escaped quotes in `_raw`, matching and non-matching:

    | Candidate | Result |
    |---|---|
    | The old anchored shape `^(?=.*K1)(?=.*K2)`, greedy or lazy | FATAL "has exceeded configured match_limit" |
    | Unanchored two-key alternation in both orders | Correct |
    | The same with three keys (six orders) | FATAL match_limit |
    | Six orders with a gap that stops at `"_raw"`, 21 entries | FATAL "regular expression is too large" |
    | `SKIP` + lookaheads: folder, source, combined, 40- and 80-entry lists | Correct on every envelope |
    | Unanchored `"source"` condition; the time regex | Correct |

    So raising `LOOKAHEAD` alone would have broken the existing filters on long lines: the shape had to change with it. Any change to the shape needs the same kind of check on Splunk's PCRE, on lines close to 100,000 characters, matching and non-matching, in every envelope order.

#### :material-crop-square:{ .taiconcolor } Linear Wildcard Matching

The rule gives every run of `*` before the last the form `(?>[^"]*?seg)`: the regex engine places the segment that follows the run at its leftmost occurrence in the value, and because the group is atomic it never goes back to try a later one. Only the last run, `[^"]*`, backtracks, and only one level deep. The work to match a `source`, `clz_dir` or `clz_subdir` value therefore grows linearly with the length of the value, however many `*` the pattern has. The same rule applies to source patterns and to the `dir` and `subdir` parts of folder patterns.

**Why.** Translating every `*` to `[^"]*` makes the engine try every way of dividing the value among the stars: a pattern with *k* runs of `*` takes about *n*<sup>*k*</sup> steps on a value of *n* characters that it does not match. On Splunk's PCRE2, with the transforms.conf default `MATCH_LIMIT` of 100,000, that translation exceeded the limit for `*a*a*b` through `*a*a*a*a*a*a*b` on a `source` of `/` and 150 `a` characters, for `/var/log/********x` on `/var/log/` and 80 `y` characters, and for `*/*/*/*/*/*.x` and `*/*/*/*/*/*/*/*.x` on a path with 17 slashes: the search-time `rex` used for the check stopped with a match-limit error. At index time a filter REGEX that exceeds the limit is expected to count as no match (this has not been measured on a forwarder), so an Exclude rule would silently keep the event and an Include rule would drop it, and whether that happens depends on the `source` values in the data, not only on the pattern. Realistic patterns (up to four `*` with distinctive text between them) stayed inside the limit, but nothing guaranteed it.

**Same matches.** The segments between runs have a fixed length (a `?` is one character), so placing a middle segment at its leftmost occurrence never loses a match that a later placement would find. Checked on 54,974 random pattern and value pairs against a glob oracle, with no disagreement, and on Splunk's PCRE2: 16 of 16 patterns gave the oracle's result on all 50 envelopes each, with no match-limit message, among them six of the eight patterns that had exceeded the limit (`*a*a*b`, `*a*a*a*a*a*b`, `*a*a*a*a*a*a*b`, `/var/log/********x`, `*/*/*/*/*/*.x`, `*/*/*/*/*/*/*/*.x`).

**Runs count once.** `**` produces the same text as `*`, so the generated text cannot tell them apart. The App's Data Doctor, which reads generated `transforms.conf` back into patterns, therefore shows each run of `*` as a single `*`: `/var/log/**/x.log` appears as `/var/log/*/x.log`, which matches the same values.

#### :material-crop-square:{ .taiconcolor } Chunking

Each list is de-duplicated (first occurrence kept, order preserved). Entries are added to the current chunk until the next entry would take its REGEX past `FILTER_REGEX_MAX_CHARS` (8,000 characters); that entry starts a new chunk. Splunk's PCRE compiled an 80-entry combined list (12,765 characters) in this shape, but refused a 16,000-character REGEX of an earlier candidate shape as "regular expression is too large", so 8,000 leaves a margin. A single entry whose alternative alone would pass the limit is refused with a message naming the entry.

#### :material-crop-square:{ .taiconcolor } Python Compatibility

The possessive quantifiers in `SKIP` and the atomic groups of the `*` rule need Python 3.11+ `re`, but the shipped code never compiles a generated REGEX: it is text written to a conf file and run by Splunk's PCRE. The module must import and run on Splunk's Python 3.9 as well as 3.13 (`python.required = 3.13`), because the persistent settings handler, Deploy to Forwarders, the S3 Direct stamp handler and both scripted inputs import it. Tests compile the REGEX on 3.13 / 3.14. On 3.8 / 3.9, which have neither, they replace the possessive body of `SKIP` with an atomic-group emulation (`(?=((?:[^"\\]+|\\.)*))\1`): the same matches, without the catastrophic backtracking a plain `++` -> `+` copy shows on 3.8. Each atomic group `(?>X)` of the `*` rule is emulated the same way, as `(?=(X))\N`, with *N* numbered left to right after the group of the `SKIP` emulation.

### :material-circle-box:{ .taiconcolor } Validation Layers

A value reaches a conf file through three paths — the UCC REST write, the `RestError[403]` filesystem fallback (`update_local_stanza()`), and a hand edit — so the source fields are checked in three places:

1. **Splunk Web / UCC.** `globalConfig.json` defines `include_sources` and `exclude_sources` as `text` entities after `exclude_filters` (so `days_in_past`, the hook's anchor, stays last) with a string validator (at most 4,096 characters) and a regex validator `^[A-Za-z0-9/._:*?=,+@~ -]*$`. UCC runs them in the browser and in the generated `rh_settings.py` before the REST write — before a 403 can reach the fallback, whether filtering is on or off. They are not enough on their own: empty values skip validators, and Python's `re.match` lets `$` accept a trailing newline.
2. **The REST handler.** The full grammar runs on **every** save for the two source fields, even with filtering disabled, because their values are written to a conf either way; a stray `"`, `\` or newline would otherwise reach a conf line or a REGEX. Every other posted value (`include_filters`, `exclude_filters`, `filter_enabled`, `days_in_past`, and any unexpected key) is checked on every save too, for conf safety only: no control character, tab included, and no trailing backslash (`_validate_posted_values()`), so the 403 fallback cannot write a line break into the settings conf. The folder patterns and Days in the Past are checked against their grammar when filtering is enabled, as before, together with the pass-all rule for Include Sources and a dry run of the generators, so a value they would refuse is refused before anything is saved.
3. **The generators.** `generate_transforms_stanzas()` / `generate_props_filter_lines()` re-validate every entry and raise on an invalid one, whatever path the value came by: the handler refuses the save, and the daily refresh logs an ERROR and keeps the last good block (see [Daily Time Refresh](#daily-time-refresh)).

The source grammar:

```
list    := entry ("," entry)*            (spaces around entries are stripped; any other whitespace is rejected; empty entries rejected)
entry   := srcpat | folder "=" srcpat
folder  := dir "/" subdir                (as Include/Exclude Filters: [A-Za-z0-9*?._:-]+ per segment; no bare *)
srcpat  := 1..512 of [A-Za-z0-9/._:*?+@~-], with at least one character that is not * ? or /
```

Rejected characters: `"` `\` `,` (the list separator) `=` (inside a source pattern) whitespace `[` `]`, control characters and non-ASCII. Rejected source patterns: `*`, `**`, `/*`, `*/*` — anything that would match everything.

### :material-circle-box:{ .taiconcolor } AWS S3 Direct Filter Preview

`appserver/static/logserv_s3_direct.js` decides which folders a backfill leaves out because this forwarder's filters would drop their events. It mirrors the generator's folder matching — per segment, case-sensitive, `*` and `?` as wildcards, and the pass-all rule — instead of the prefix comparison it used before, which left out every folder under the default `*/*` and never matched a pattern such as `*/cron`. Source rules act on single files, so the preview cannot decide them per folder: they never change a folder's verdict, they only add a note — "some files may be kept by Include Sources" on a folder the include gate leaves out, "some files may be dropped by Exclude Sources" on a planned folder — as the App's Data Doctor marks its folder verdicts approximate. A stored value the generator would refuse is reported first (the forwarder then keeps the rules it generated last, which the screen cannot see). The preview reads this forwarder's stored settings; on a forwarder whose Data TA a Deployment Server manages they can be older than the pushed rules (only `transforms.conf` and `props.conf` are mirrored to `deployment-apps/`), and a plan with a source note says so.

### :material-circle-box:{ .taiconcolor } Time Filter Regex

The time filter matches epoch timestamps in the raw JSON `"_time"` field. A TRANSFORMS `REGEX` is fixed text and cannot compute "N days ago" when an event arrives, so the cutoff is a pre-computed regex that matches epoch values less than the cutoff. This regex must be refreshed daily to maintain accuracy. Its stanza, like every generated filter stanza, sets `LOOKAHEAD = 100000`.

??? tip "Failure mode"
    If the daily refresh doesn't run, the cutoff is not advanced: it stays one day further in the past for each missed day, so the filter drops slightly less data — up to one extra day of older events per missed day is kept — until the next refresh or Save.

### :material-circle-box:{ .taiconcolor } Why TRANSFORMS Instead of INGEST_EVAL

The Data TA filters with TRANSFORMS-based queue routing (`REGEX`, `FORMAT = nullQueue` or `indexQueue`, `DEST_KEY = queue`, `LOOKAHEAD`), not with `INGEST_EVAL`. This is a design constraint of the project, recorded as "INGEST_EVAL is unavailable on Splunk Cloud heavy forwarders". That premise has not been re-checked against Splunk's current documentation, so treat it as the project's choice rather than as a statement about what a Splunk platform supports. A change to `INGEST_EVAL` would also have to keep the generated `transforms.conf` shape that the App's Data Doctor parses back (see [Filter Regex Generation](#filter-regex-generation)).

---

## :material-circle-box:{ .taiconcolor } Deployment Server Automation

### :material-circle-box:{ .taiconcolor } DS Detection

Two-step detection in `is_deployment_server()`:

1. **Fast path** — Check `server_roles` from `/services/server/info` for `deployment_server`
2. **Fallback** — If role is absent, query `/services/deployment/server/clients` to check for connected deployment clients. Returns true only if at least one client is connected

??? tip "Why the fallback exists"
    Splunk removes the `deployment_server` role from `server_roles` when no server class is defined in any `serverclass.conf`, so a fresh DS has no role yet. `/services/deployment/server/clients` returns 0 clients on HFs (no false positives) and returns the connected clients on a real DS even without any server classes. The `/services/deployment/server/config` endpoint cannot be used as a fallback because it returns HTTP 200 on ALL Splunk Enterprise instances (including HFs), causing false positives.

### :material-circle-box:{ .taiconcolor } Server Class Creation

`ensure_serverclass()` creates `SAP_LogServ_HeavyForwarders` in three steps:

1. **REST API create** — POST to `/services/deployment/server/serverclasses` with `name` parameter to create the server class

    :material-lightning-bolt:{ .taiconcolor } The `disabled` parameter is NOT supported during creation (Splunk returns an error).

2. **REST API disable** — Separate POST to `/services/deployment/server/serverclasses/SAP_LogServ_HeavyForwarders` with `disabled=true` to disable the server class. This ensures no deployment occurs until the admin configures client targeting and enables the server class in Forwarder Management.

3. **File-based app mapping** — After REST creates and disables the server class, the function locates the resulting `serverclass.conf` (which Splunk may write to `system/local/` or `apps/search/local/`) and appends the app mapping stanza:

```ini
[serverClass:SAP_LogServ_HeavyForwarders:app:splunk_ta_sap_logserv]
restartSplunkd = true
stateOnClient = enabled
```

!!! note
    The app mapping cannot be created via REST API — the URL path format `serverclasses/{name}/app:{appname}` returns HTTP 404.

### :material-circle-box:{ .taiconcolor } Deployment-Apps Sync

`ensure_deployment_app_synced()` runs on a DS after every Save on the Filters or Cloud Provider tab, and in the daily time refresh. It copies the full package from `etc/apps/splunk_ta_sap_logserv/` (including that copy's `local/`) to `etc/deployment-apps/splunk_ta_sap_logserv/` in two cases only:

1. **First copy:** `deployment-apps/splunk_ta_sap_logserv/` does not exist yet.
2. **Version change:** the `[launcher] version` in `default/app.conf` differs between the two copies. The `deployment-apps/` copy is deleted and copied again.

When the versions are equal it copies nothing. `mirror_to_deployment_apps()` then copies only `local/transforms.conf` and `local/props.conf`. Two consequences:

- Every 0.1.2 build has `[launcher] version = 0.1.2`; builds differ only in `[install] build`, which is not compared. A newer build with the same version installed in `etc/apps/` is **not** copied, so the heavy forwarders keep the older code and `default/` files and receive only the new filter rules. Update `deployment-apps/` by hand, as [Upgrading](../getting-started/upgrading.md) describes.
- A copy made because of a version change deletes anything added by hand under `deployment-apps/splunk_ta_sap_logserv/local/` that `etc/apps/.../local/` does not have.

Deploy to Forwarders copies nothing; it only reloads the Deployment Server.

### :material-circle-box:{ .taiconcolor } Deployment Client Guard

The `logserv_filter_time_refresh.py` scripted input checks whether the instance is a deployment client but not a Deployment Server. If so, it skips the refresh when the Deployment Server delivered the Data TA (`$SPLUNK_HOME/var/run/serverclass.xml` lists `splunk_ta_sap_logserv`) or when that record is missing, unreadable or lists no app. Without this guard, a heavy forwarder would read its own empty local settings on the daily run, regenerate the configs with only a time filter, and overwrite the complete filter chain pushed by the DS. A deployment client that holds the Data TA directly (its `serverclass.xml` lists other apps but not the Data TA, for example a search head that is a deployment client for other apps) refreshes its own filter, as a single instance does.

---

## :material-circle-box:{ .taiconcolor } Adding Support for New Sourcetypes

### :material-circle-box:{ .taiconcolor } Step 1: Add a Routing Transform

Add the `@logserv_filter` annotation on the line immediately above the stanza header in `default/transforms.conf`:

```ini
# @logserv_filter: newdir/newsubdir
[set_srctype_for_new_logtype]
REGEX = "clz_subdir":"newsubdir"
FORMAT = sourcetype::sap:newlogtype
DEST_KEY = MetaData:Sourcetype
LOOKAHEAD = 100000
```

:material-lightning-bolt:{ .taiconcolor } **The annotation is critical.** It declares which `clz_dir/clz_subdir` values the transform handles. Without it, the upgrade check cannot detect that a new log type is supported, and users won't be notified.

Multiple values can be comma-separated:

```ini
# @logserv_filter: newdir/type_a, newdir/type_b, newdir/type_c
[set_srctype_for_new_dir]
REGEX = "clz_subdir":"(type_a|type_b|type_c)"
FORMAT = sourcetype::sap:newdir:logs
DEST_KEY = MetaData:Sourcetype
LOOKAHEAD = 100000
```

When the same `clz_subdir` value exists under multiple `clz_dir` paths (e.g., `audit` appears under both `abap/` and `scc/`), key the route on **both folder fields** with the filter generator's shape: its REGEX is byte-equal to the Include Filters REGEX of that one folder, `fnmatch_patterns_to_combined_regex(['scc/audit'])` in `splunk_ta_sap_logserv_filter_utils.py` (see [Filter Regex Generation](#filter-regex-generation)):

```ini
# @logserv_filter: scc/audit
[set_srctype_scc_audit]
REGEX = (?:^|"_raw"\s*:\s*"(?:[^"\\]++|\\.)*+")(?:(?=(?:(?!"_raw")[^\n])*?"clz_dir"\s*:\s*"scc")(?=(?:(?!"_raw")[^\n])*?"clz_subdir"\s*:\s*"audit"))
FORMAT = sourcetype::sap:scc:audit
DEST_KEY = MetaData:Sourcetype
LOOKAHEAD = 100000
```

:material-lightning-bolt:{ .taiconcolor } **When to key on both folders:** Check if the `clz_subdir` you are adding already exists in another `clz_dir` path. If it does, both the existing and new transforms must key on both folder fields. Current collision-prone values include `audit` (abap, scc), `sapstartsrv` (abap, sap), `tracelogs` (hana, scc) and `icm` (abap; the Web Dispatcher's `webdispatcher/icm` is a Secondary folder the Data TA leaves unrouted - builds of 2026-10-13 and earlier keyed the ICM route on `clz_subdir` alone and typed it `sap:abap:icm`).

:material-lightning-bolt:{ .taiconcolor } **Give every routing stanza `LOOKAHEAD = 100000`, and never pair a `(?=.*...)` lookahead with it.** The AWS envelope puts `_raw` first (`_raw, _time, host, source, clzfilename, clz_dir, clz_subdir`), so with Splunk's default window of 4,096 characters an AWS event longer than about 4 KB kept the input's own `host` and `source`, got no folder fields and stayed `sap_logserv_logs`; every Data TA build up to the one of 2026-10-13 had that limit. A route on one literal key is a linear scan at any window, as long as nothing repeated in it can run past the value's closing quote: the BIND routes match a path segment with `[^\/"]` for that reason, because with `[^\/]` the segment loop ran on through the rest of the line, one nested PCRE frame per slash against `DEPTH_LIMIT`; the Windows and sssd routes use `[^"]*` where they had `.*`, which ran on into the event text and, where PCRE2's `.` stops at a Unicode line separator, backtracked over it. A route on two keys needs the generator's shape: it starts only at the line start or just after the `_raw` value, skips that value possessively and never crosses a `_raw` key, so its work grows linearly with the line. The older form `(?s)^(?=.*"clz_dir":"X")(?=.*"clz_subdir":"Y")` reads the whole window in each lookahead, and near 100,000 characters it exceeds Splunk's match limit (see the probes under [Filter Regex Generation](#filter-regex-generation)). Without the `^` it was worse: PCRE retried it at every character of a line it did not match, so the work grew with the square of the line length, and `MATCH_LIMIT`, which counts the work of each start position on its own, never stopped it. Every Data TA version from 0.0.4 to the 0.1.2 build of 2026-10-09 shipped those routes unanchored; the build of 2026-10-13 added `(?s)^` (179 to 1,778 times faster at search time on lines of 460 to 4,160 characters), and the build of 2026-10-16 (1792189743) moved them to the generator's shape with the 100,000-character window.

### :material-circle-box:{ .taiconcolor } Step 2: Add to TRANSFORMS Chain

Add your new transform to the appropriate `TRANSFORMS-*` line in the `[sap_logserv_logs]` stanza of `default/props.conf`:

```ini
[sap_logserv_logs]
...
TRANSFORMS-10-srctype_for_newdir = set_srctype_for_new_logtype
```

Pick the next free number in `10`–`49` for the TRANSFORMS prefix. Current allocation: `00` = filters, `01` = metadata (`extract_host`, `extract_source`, `extract_clz`), `02`–`09` = sourcetype routing (all in use), `50`–`51` = indexed-field stamps (`splunk_solution`, `cloud_provider`), `99` = `set_raw_only`.

### :material-circle-box:{ .taiconcolor } Step 3: Add Sourcetype Configuration

If the new sourcetype needs field extractions, calculated fields, or CIM field aliases, add a `[sap:newlogtype]` stanza to `default/props.conf`.

### :material-circle-box:{ .taiconcolor } Step 4: Bump the Version

Bump `meta.version` in `globalConfig.json` — `ucc-gen` stamps it into the built `default/app.conf`, which is what `get_ta_version()` reads (it falls back to `app.manifest` only when `app.conf` is absent, i.e. before the UCC build). Keep `package/app.manifest` in sync so source and artifact agree. The version change triggers the upgrade check to compare the new annotations against existing user include patterns.

??? tip "What Happens on Upgrade"
    1. The `logserv_filter_upgrade_check.py` scripted input detects the version change within 10 minutes
    2. It scans the updated `default/transforms.conf` for `@logserv_filter` annotations
    3. If the user's include patterns don't cover the new log types, a system message banner appears across all Splunk Web pages
    4. The user updates their include patterns (or uses `*/*`) and the banner clears

### :material-circle-box:{ .taiconcolor } Routing Data Without Folder Fields

Some LogServ data arrives without `clz_dir` and `clz_subdir`: SAP files it in a storage folder named `undefined/undefined` (see [Data Delivered Without Folder Fields](../getting-started/supported-log-types.md#data-delivered-without-folder-fields)), and no folder route can match it. The Data TA routes one such kind, the HANA trace directory, by the envelope's `source` path, as the last entry of `TRANSFORMS-08-srctype_for_scc_and_hana_trace`, after the folder route `set_srctype_hana_tracelogs`:

```ini
[set_srctype_hana_tracelogs_by_source]
REGEX = ^(?!(?>[^"]+|"_raw"\s*:\s*"(?:[^"\\]++|\\.)*+"|")*?"clz_subdir"\s*:)(?=(?>[^"]+|"_raw"\s*:\s*"(?:[^"\\]++|\\.)*+"|")*?"source"\s*:\s*"\/usr\/sap\/[A-Z0-9]{3}\/HDB\d{2}\/[^"\/]+\/trace\/(?:DB_[^"\/]+\/)?(?:[^"\/]+\.trc|backup\.log)")
FORMAT = sourcetype::sap:hana:tracelogs
DEST_KEY = MetaData:Sourcetype
LOOKAHEAD = 100000
```

- **Why it exists.** In the LogServ deliveries examined when the route was written, all of the real HANA trace data — the `.trc` files and `backup.log` of `/usr/sap/<SID>/HDB<nn>/<host>/trace/` and `trace/DB_<tenant>/` — arrived without folder fields. `[set_srctype_hana_tracelogs]` keys on `clz_dir=hana` and `clz_subdir=tracelogs`, so it never matched real data (only the synthetic events of the Demo Data Generator TA, `splunk_ta_sap_logserv_demo_gen`, carry that folder; it is an internal tool that generates LogServ-shaped events for testing and demos, and it is not part of the release), and the trace files stayed `sap_logserv_logs`.
- **What it matches.** The whole `source` value in the envelope: `/usr/sap/`, a three-character SID of upper-case letters and digits, `HDB` and two digits, one host folder, `trace/`, optionally one `DB_<tenant>/` folder, then a `.trc` file or `backup.log`. Other files in those folders (`backint.log`, `.trc.gz`), deeper subfolders, a lower-case SID, a path written with `\/` escapes and `source` text inside the escaped `_raw` (where every quote has a backslash before it) do not match and keep `sap_logserv_logs`.
- **The guard.** The negative lookahead at the start, `(?!(?>...)*?"clz_subdir"\s*:)`, limits the route to envelopes without a `clz_subdir` key — only when there are no folder fields. Like the `source` condition, it walks the line from its start over whole tokens - a run of characters without a quote, the `_raw` key with its whole value (skipped possessively, as `[set_raw_only]` does), or one quote - inside an atomic group, so it sees every envelope key on either side of `_raw`, never the event text, and its work grows linearly with the line. As the last entry of class 08 the route would otherwise win over every route of classes 02–08 for any event whose path matched; with the guard, an event that has folder fields is routed by its folder exactly as before. The class 09 routes (`sap/*`) all need `"clz_subdir":"..."`, so none can match an event the guard lets through: the source route is final for it. The guard tests for the key, not its value: an envelope written with `"clz_subdir":""` or `"clz_subdir":null` is not routed. The index shows only that the real events had no non-empty folder value; that their envelopes carry no `clz_subdir` key at all still has to be confirmed on one raw `undefined/undefined` blob.
- **LOOKAHEAD.** 100,000 characters, like every routing stanza: the window `[extract_source]` reads, so an event is routed here only when its indexed `source` holds the path the App reads the SID, instance, host and tenant from. Builds of 2026-10-13 and earlier left both at the default 4,096 and scanned the line character by character (`^(?![^\n]*?"clz_subdir"\s*:)[^\n]*?"source"...`): on an AWS-order envelope whose `_raw` ran past that window neither matched, and the event stayed `sap_logserv_logs` with the input's own `source`. At 100,000 characters that form exceeds the match limit, so the shape changed with the window; the matches did not. The route also accepts spaces around the colon, which `[extract_source]` does not; no real envelope has them.
- **No `@logserv_filter` annotation.** An annotation declares the folders a route handles, and every reader treats it as a folder: the upgrade coverage check compares the folders with Include Filters, the AWS S3 Direct screen plans its inputs per folder, and the App's `SOURCETYPE_CLZ_MAP`, which `check:diagnostics` re-derives from the annotations, gives the Data Doctor its kept/dropped verdicts. These events have no folder, and folder filters can neither keep nor drop them; only Include Sources and Exclude Sources reach them. Annotating the stanza `hana/tracelogs` would change none of those lists — the folder route declares it already, and both annotation parsers de-duplicate — but it would claim that the folder decides these events. The stanza's comment says why it has none. The gate's derivation reads only annotated stanzas, so it skips this one.
- **Filters and history.** The filters run in `TRANSFORMS-00`, before routing, so the route changes no filter decision. Routing is index-time: events indexed before the Data TA update keep `sap_logserv_logs`.
- **Demo Data Generator lockstep.** The Demo Data Generator's `fidelity.ROUTING` mirrors the Data TA routing, and its fidelity test compares the two. It carries the forms of this Data TA build, and its `compile_routing()` rewrites the possessive quantifiers and atomic groups, which need Python 3.11, into forms with the same matches for the Python 3.9 of Splunk 9.4. Every Demo Data Generator HANA trace template carries the `hana/tracelogs` folder, so no generated output changes.

The other data delivered without folder fields, the Unix command output (`ps`, `top`, `netstat`, ...), is deliberately left unrouted: it is not a LogServ log type, and each event holds a single table row, a header line or a table whose line breaks are the two characters `\n`, which no sourcetype the solution ships parses.

---

## :material-circle-box:{ .taiconcolor } LogServ Azure and GCP Add-on Internals

The LogServ Azure add-on (`splunk_ta_sap_logserv_azure`) and the LogServ GCP add-on (`splunk_ta_sap_logserv_gcp`) are UCC add-ons with one modular input each and no parsing configuration of their own. Each input fetches the LogServ files its cloud announces and writes their NDJSON lines through the modular-input EventWriter (not HEC), so the events go through the index-time pipeline of the instance that runs the input, where the Data TA routes, filters and stamps them.

| | LogServ Azure add-on | LogServ GCP add-on |
|---|---|---|
| Input kind and script | `sap_logserv_azure_queue`, `bin/sap_logserv_azure_queue.py` | `sap_logserv_gcp_pubsub`, `bin/sap_logserv_gcp_pubsub.py` |
| Helpers (`bin/lib/`) | `azure_storage_rest.py`, `azure_eventgrid.py`, `azure_checkpoint.py` | `gcp_rest.py`, `gcp_auth.py`, `gcp_notifications.py`, `gcp_checkpoint.py` |
| Notification read | Event Grid `BlobCreated` messages on an Azure Storage Queue | GCS `OBJECT_FINALIZE` notifications on a Pub/Sub subscription |
| Credential | SAS token | Google service-account JSON key (OAuth2 tokens minted with a standard-library RS256 implementation) |
| Batch per request (default) | 32 messages (at most 32), visibility timeout 300 s | 10 messages |
| When a message is done | Each message is deleted on its own, once its blobs are done | One acknowledge per pull batch, after every message in it is processed |
| Dedup key | Blob URL + ETag | `bucket/object#generation` |
| `cloud_provider` stamp | `_meta = cloud_provider::azure` on the input-kind stanza | `_meta = cloud_provider::gcp` on the input-kind stanza |

The helpers use only the Python standard library (`urllib`, `xml.etree`, ...), with no Azure or Google SDK, which keeps the add-ons free of compiled wheels that fail AppInspect's AArch64 check.

### :material-circle-box:{ .taiconcolor } One Firing

Every `interval` seconds (60 by default) the input:

1. Reads its settings and its credential from `passwords.conf`. UCC stores it under the realm `__REST_CREDENTIAL__#<app>#data/inputs/<input kind>`.
2. Drains the queue or subscription within a time budget of 90% of the interval, at most 240 seconds, and at most `max_blobs_per_fire` / `max_objects_per_fire` files (500 by default). Per message:
    - a message delivered more times than the poison threshold (5 by default) is dropped; the Azure input can first copy it to a dead-letter queue, and the GCP input sees the delivery count only when the subscription has a dead-letter policy;
    - the notification is parsed, and the input's own **Include filters** / **Exclude filters** decide which files it keeps;
    - each file that is not in the dedup record is fetched, gunzipped (plain text is accepted too) and split into lines, and every line is written with sourcetype `sap_logserv_logs` (fixed in the code; the **Sourcetype** field on the input form is display-only) and the input's index (`sap_logserv_logs` by default);
    - the message is deleted (Azure) or acknowledged (GCP) once every file in it is ingested or skipped; a file that no longer exists (HTTP 404) or cannot be decoded is skipped. After a transient or access error the message is left for redelivery.
3. Writes the dedup record and logs a summary line.

### :material-circle-box:{ .taiconcolor } Dedup Record and One Input per Queue

Delivery is at-least-once on both clouds, so each input keeps a dedup record: a JSON file named `<input name>.dedup.json` in the modular input's checkpoint directory on the instance that runs it. Entries expire after 7 days, and the file keeps at most 50,000. It is written at the end of each firing, so a process killed in the middle of a firing loses that firing's entries.

Nothing shares the record: not a clone of the input on the same heavy forwarder, not an input with the same name on another one. A single input per queue or subscription is therefore effectively duplicate-free. Every further input on the same queue or subscription is a competing consumer with its own record, and a message that comes back (a lapsed visibility lease or ack deadline, a failed delete or acknowledge, a process that died before it) can be ingested twice. Google also documents that Pub/Sub may redeliver a message even after a successful acknowledge. On GCP the whole pull batch has to finish inside the subscription's ack deadline, because the input acknowledges once per batch and never extends the deadline.

### :material-circle-box:{ .taiconcolor } The Input Handler

The Inputs page is served by UCC's generated `[admin_external:*]` handler, the stock `AdminExternalHandler`. It runs as the signed-in user, so creating, editing (including replacing the SAS token or key) or deleting an input needs `admin_all_objects`, on Splunk Cloud and on Splunk Enterprise alike. This is inferred from the identical handler of other UCC add-ons in the project; it has not been retested on these two. The `passSystemAuth = true` line that each add-on's `additional_packaging.py` adds to that stanza has no effect there, and unlike the Data TA's Configuration tabs the add-ons have no filesystem fallback.

### :material-circle-box:{ .taiconcolor } Build-Time Patches of the Add-ons

Each add-on's `additional_packaging.py` patches the UCC output in five steps:

1. Adds `handlertype`, `python.version`, `python.required = 3.13` and `passSystemAuth = true` to every `[admin_external:*]` stanza of `restmap.conf`.
2. Adds `python.version = python3`, `python.required = 3.13` and the `_meta = cloud_provider::<cloud>` line to the input-kind stanza of `inputs.conf`.
3. Copies the real input script from `package/bin/` over the stub UCC generates from `globalConfig.json`.
4. Removes gRPC, protobuf and OpenTelemetry packages from `lib/` if a dependency brings them in.
5. Adds `sc_subadmin` to the global write ACL in `metadata/default.meta` (see [The sc_subadmin Write-ACL Patch](#the-sc_subadmin-write-acl-patch)).

The build prints an `[additional_packaging] ...` line for steps 2, 3 and 5.

---

## :material-circle-box:{ .taiconcolor } Testing Environments

### :material-circle-box:{ .taiconcolor } Environment 1: Single Instance (Standalone)

**Setup:** One Splunk Enterprise instance acting as Search Head, Indexer, and data receiver.

??? tip "What to test"
    - Filter save generates correct `local/transforms.conf` and `local/props.conf`
    - Conf reload works without restart
    - Include, exclude, and time filters work correctly in search results
    - Include Sources keeps a file whose folder is not included, and events without folder fields; Exclude Sources drops only the named files while the primary types in the same folder still arrive
    - A long line (4,097 to 99,999 characters, `_raw` before the metadata keys) is judged like a short one
    - Disabling filtering clears the generated conf files
    - Pattern validation blocks invalid input — the source fields also with filtering disabled
    - No Deployment Server UI elements appear (no banner, no deploy button)

### :material-circle-box:{ .taiconcolor } Environment 2: Deployment Server + Heavy Forwarders

**Setup:** Three instances minimum: DS (can be combined with SH/Indexer), HF-01 (deployment client), HF-02 (deployment client).

??? tip "What to test"
    - DS detection works (banner and deploy button appear)
    - The first filter save copies the full app to `deployment-apps/`; a later save with the same version copies only the filter configs
    - Filter configs are mirrored to `deployment-apps/local/`
    - Server class `SAP_LogServ_HeavyForwarders` is auto-created with app mapping
    - Client targeting (IP-based) matches HFs correctly
    - Deploy button triggers reload and HFs receive the TA
    - Filter update round-trip: change on DS → deploy → verify on HFs
    - Time refresh script skips on HFs (deployment client guard)
    - Time refresh script runs correctly on DS and mirrors updated configs, with the source stanzas still present after the refresh

### :material-circle-box:{ .taiconcolor } Environment 3: Splunk Cloud + On-Premises Heavy Forwarders

**Setup:** Splunk Cloud instance (Search Head / Indexer), separate on-premises DS, on-premises HFs configured as deployment clients.

??? tip "What to test"
    - Same as Environment 2, but additionally verify:
    - The **LogServ App** is installed on the Splunk Cloud search head for dashboards and search-time knowledge objects. The **Data TA** is installed on the on-prem DS and HFs. The two indexes are created on the Cloud stack in **Settings > Indexes** or with ACS, before any data arrives. Filtering is NOT configured on the Cloud side
    - Filter configuration and TA distribution to HFs are managed entirely from the on-premises DS
    - Filtering works at the HF level before data reaches Splunk Cloud
    - No INGEST_EVAL dependency (TRANSFORMS-only filtering)

### :material-circle-box:{ .taiconcolor } Environment 4: Fresh DS with No Prior Server Classes

**Setup:** DS with deployment clients connected but no `serverclass.conf` exists.

??? tip "What to test"
    - DS detection works via the fallback (connected clients check)
    - `ensure_serverclass()` creates `serverclass.conf` from scratch
    - The `deployment_server` role activates after server class creation
    - Full deployment workflow completes successfully

---

## :material-circle-box:{ .taiconcolor } Known Gotchas and Technical Notes

### :material-circle-box:{ .taiconcolor } Local Imports in Utility Functions

Functions in `splunk_ta_sap_logserv_filter_utils.py` import `splunk.rest` **locally** (inside the function body). `splunk.rest` exists only in Splunk's own Python, so a module-level import would fail wherever the module is loaded outside Splunk. Some functions also import standard-library modules (`json`, `configparser`, `glob`) locally; that is style, not necessity.

The critical detail is that **local imports are scoped to the function they are declared in**. They do NOT carry into sibling functions. Each function that needs `splunk.rest` or `json` must import them independently. For example, both `get_server_roles()` and `is_deployment_server()` need their own local `import splunk.rest as rest` and `import json` statements — the imports inside `get_server_roles()` are not visible to `is_deployment_server()` even though one calls the other.

Forgetting a local import inside a function that has a bare `except Exception: pass` block is particularly dangerous because the resulting `NameError` is silently swallowed, causing the function to return a default value without any log output.

### :material-circle-box:{ .taiconcolor } Persistent Handler sys.path

Persistent REST handlers (`splunk_ta_sap_logserv_rh_deployment_push.py`, `splunk_ta_sap_logserv_rh_s3_direct_meta.py`) do NOT get `import_declare_test` from UCC. They require explicit `sys.path` setup at the top of the file to import from the app's `bin/` and `lib/` directories. Without this, the handler returns 500 errors from splunkd.

### :material-circle-box:{ .taiconcolor } web.conf Expose Stanza

Custom persistent endpoints are not accessible through the Splunk Web proxy (port 8000) by default. They require an `[expose:]` stanza in `web.conf`. This is injected by `additional_packaging.py` during the UCC build:

```ini
[expose:splunk_ta_sap_logserv_deployment_push]
pattern = splunk_ta_sap_logserv/deployment_push
methods = POST, GET

[expose:splunk_ta_sap_logserv_s3_direct_meta]
pattern = splunk_ta_sap_logserv/s3_direct_meta
methods = POST
```

### :material-circle-box:{ .taiconcolor } Server Class REST API Limitations

- The `disabled` parameter and the app mapping cannot be set through the REST create; see [Server Class Creation](#server-class-creation)
- Splunk may write `serverclass.conf` to different locations (`system/local/` or `apps/search/local/`). The code searches multiple locations
- A scoped reload (`serverclasses/<name>/reload`) must be sent in the namespace of the app that holds the class. Read it from the class's `acl.app` (`GET /servicesNS/-/-/deployment/server/serverclasses/<name>`) rather than relying on `/services/...`, which resolves in the calling user's default app — see [Daily Time Refresh](#daily-time-refresh). Deploy to Forwarders uses the global `/services/deployment/server/config/_reload`, which has no such dependency but reloads every server class on the DS

### :material-circle-box:{ .taiconcolor } TRANSFORMS-00-filter Ordering

The `00` prefix sorts the filter class before every other `TRANSFORMS-*` class of `[sap_logserv_logs]`. That classes run in ASCII order of their names is not in Splunk's `props.conf` specification, which documents only the order inside one class; it is Splunk's observed behaviour, and the filters working in the lab depend on it. The filters must run before `TRANSFORMS-99-set_raw`, because they match the NDJSON envelope keys that the unwrap removes. Running first saves no processing: Splunk still applies every later transform to an event the filters dropped.

All queue-setting filter transforms — the source stanzas and every chunk included — MUST stay in that single line: Splunk does not reliably carry `DEST_KEY = queue` across separate `TRANSFORMS-xx` directives, and only within one line is "last match wins" guaranteed. Because the filters run before `TRANSFORMS-01-metadata`, they cannot use `SOURCE_KEY = MetaData:Source`: at that point it still holds the input's own source, not the envelope's `source` value.

### :material-circle-box:{ .taiconcolor } Marker Comments

Generated filter content in `local/transforms.conf` and `local/props.conf` is wrapped in marker comments:

```
### BEGIN LOGSERV FILTER CONFIG - DO NOT EDIT MANUALLY ###
...
### END LOGSERV FILTER CONFIG ###
```

The `write_local_conf()` function replaces content between these markers (or appends them if not present). Manual customizations outside the markers are preserved. The Cloud Provider tab writes its own independent block between `### BEGIN LOGSERV CLOUD_PROVIDER CONFIG - DO NOT EDIT MANUALLY ###` / `### END LOGSERV CLOUD_PROVIDER CONFIG ###` markers (via `write_local_conf_section()`), so the daily filter time-refresh regenerating the filter block leaves the cloud-provider block untouched. With **Not set** the block is removed; empty content clears only the block of its own marker pair.
