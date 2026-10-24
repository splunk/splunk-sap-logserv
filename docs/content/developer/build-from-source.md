# Building the Packages from Source

This page shows how to build each package of Splunk for SAP LogServ from the repository's sources and how to vet a build with AppInspect. Use it when you need a variant that is not published, such as the templates-only LogServ App, or when you change the source. For a normal install, use the tarballs in the repository's [`release_binaries/`](https://github.com/splunk/splunk-sap-logserv/tree/main/release_binaries).

Paths are relative to the repository root; the sources are under `sap_logserv_package/`.

## :material-circle-box:{ .taiconcolor } Before You Start

| Package | Source | Tools | Output |
|---|---|---|---|
| LogServ App (`splunk_app_sap_logserv`) | `sap_logserv_package/splunk_app_sap_logserv/`, a Yarn workspace; the App is `packages/log-serv-app` | Node.js 22 or later, Yarn 1.x (Classic), GNU tar | `packages/log-serv-app/stage/`, then a tarball you create |
| Data TA (`splunk_ta_sap_logserv`) | `sap_logserv_package/splunk_ta_sap_logserv/` | A Python 3 virtual environment with UCC (`splunk-add-on-ucc-framework`) 6.6.0 | `output/splunk_ta_sap_logserv/` and `splunk_ta_sap_logserv-<version>.tar.gz` |
| LogServ Azure add-on (`splunk_ta_sap_logserv_azure`) | `sap_logserv_package/splunk_ta_sap_logserv_azure/` | The same UCC environment | `splunk_ta_sap_logserv_azure-<version>.tar.gz` |
| LogServ GCP add-on (`splunk_ta_sap_logserv_gcp`) | `sap_logserv_package/splunk_ta_sap_logserv_gcp/` | The same UCC environment | `splunk_ta_sap_logserv_gcp-<version>.tar.gz` |

The 0.1.2 release was built with Node.js 23 and Yarn 1.22 for the App, UCC 6.6.0 for the three add-ons, and AppInspect 4.3.1. Both builds download packages (from the npm registry and from PyPI), so they need network access.

Versions are 3-part SemVer (for example `0.1.2`): AppInspect rejects a 4-part version.

---

## :material-circle-box:{ .taiconcolor } Build the LogServ App

1. Install the dependencies at the workspace root:

    ```bash
    cd sap_logserv_package/splunk_app_sap_logserv
    yarn install --frozen-lockfile --ignore-engines
    ```

    `--frozen-lockfile` installs exactly what `yarn.lock` records and fails instead of changing it. `--ignore-engines` is needed on Node.js 23, because a development dependency (jest 30) declares an `engines` range that leaves Node.js 23 out.

2. If you changed the source, set the version and the build number in `packages/log-serv-app/src/main/resources/splunk/default/app.conf`: `[id] version` and `[launcher] version` for a new version (and `version` in `src/main/resources/splunk/app.manifest`), and a higher `[install] build` for every change. Splunk Web caches the App's assets by build number, so a new build with an unchanged number serves stale files; see [Splunk Static-Asset Cache Busting](ai-assistant-internals.md#splunk-static-asset-cache-busting).

3. Build:

    ```bash
    cd packages/log-serv-app
    yarn build
    ```

    `yarn build` runs these steps in order and stops at the first that fails:

    - `bin/check-intent-map.js`: each predefined prompt's SPL must equal its `savedsearches.conf` stanza byte for byte, and every prompt-shaped stanza must have a prompt
    - `bin/check-diagnostics.js`: the consistency-test suites and the conf-drift checks
    - `bin/build.js build`: the production webpack build into `stage/` (it empties `stage/` first)
    - `yarn types:build` (`tsc`): type-checks the source and writes declaration files to `types/`
    - `bin/generate-sbom.js`: `stage/SBOM.json`
    - `bin/generate-third-party-notices.js`: `stage/THIRD-PARTY-NOTICES.md`, generated from the installed `node_modules/`

    `yarn build:ci` runs `yarn audit --groups dependencies --level high` first and fails on a high or critical advisory.

4. Package `stage/` with the App's directory name at the top, in the same directory:

    ```bash
    tar -czf splunk_app_sap_logserv-0.1.2.tar.gz --transform 's|^stage|splunk_app_sap_logserv|' stage
    ```

    `--transform` is a GNU tar option (Linux, and Git Bash on Windows).

For local development, `yarn link:app` links `stage/` into `$SPLUNK_HOME/etc/apps/splunk_app_sap_logserv` (`bin/build.js link`).

!!! warning "Do not use build_logserv_app.sh"
    `sap_logserv_package/build_logserv_app.sh` predates the React App: it copies `splunk_app_sap_logserv/package/`, a directory that no longer exists. Build the App with Yarn as above.

### :material-circle-box:{ .taiconcolor } The Templates-Only Variant

```bash
cd sap_logserv_package/splunk_app_sap_logserv/packages/log-serv-app
yarn build:templates-only
```

This runs the same steps with the compile-time `TEMPLATES_ONLY` flag: `bin/build.js build --templates-only` sets `LOGSERV_TEMPLATES_ONLY=true` for webpack. The resulting bundle reports the runtime `templates_only_mode` setting as on at every config read, whatever is stored, and hides that toggle. After webpack, the build sets `templates_only_mode = true` in the staged `stage/default/ai_assistant_settings.conf` (the source file is not changed) and fails if it cannot verify the change. The vendor provider code stays in the bundle, unreachable. Package `stage/` as in step 4. `yarn build:ci:templates-only` adds the audit gate.

What the variant does and does not restrict is described in [Restricting the LLM Path](../ai-assistant/templates-only-build.md) and [The Build Flag Pattern](ai-assistant-internals.md#the-build-flag-pattern-templates_only-and-future-flags).

---

## :material-circle-box:{ .taiconcolor } Build the Data TA

The Data TA, the LogServ Azure add-on and the LogServ GCP add-on are UCC add-ons. `ucc-gen build` generates the add-on from `globalConfig.json` and `package/`, installs the Python packages listed in `package/lib/requirements.txt` into its `lib/`, and then runs the add-on's `additional_packaging.py`; `ucc-gen package` makes the tarball. What `additional_packaging.py` patches is described in [Data TA Internals](data-ta-internals.md#build-time-patches).

1. Create a Python virtual environment with UCC (once):

    ```bash
    python3 -m venv .venv
    source .venv/bin/activate
    pip install splunk-add-on-ucc-framework==6.6.0
    ```

2. If you changed the source, set the version in `meta.version` of `splunk_ta_sap_logserv/globalConfig.json`, and keep `version` in `package/app.manifest` the same.

3. With the virtual environment active, build from `sap_logserv_package/`:

    ```bash
    cd sap_logserv_package
    bash build_logserv_ta.sh 0.1.2
    ```

    Run the wrappers with `bash`: they are committed without the executable bit, so `./build_logserv_ta.sh` fails with "Permission denied" in a fresh clone.

    The wrapper first deletes every `splunk_ta_sap_logserv-*.tar.gz` and the `output/splunk_ta_sap_logserv/` directory in the current directory (move a tarball you want to keep out of it first), then runs:

    ```bash
    ucc-gen build --source splunk_ta_sap_logserv/package --ta-version 0.1.2
    ucc-gen package --path output/splunk_ta_sap_logserv
    ```

4. Check the build output for this line, and for any `WARNING`:

    ```
    [additional_packaging] Patched metadata/default.meta: added sc_subadmin to global write ACL.
    ```

`requirements.txt` pins every package to an exact version with its sha256 hashes, so pip refuses a downloaded file that does not match. The add-on sources have no `default/app.conf`: UCC generates it, writes the version into it and stamps `[install] build` with the time of the build in Unix seconds. That is why add-on builds have numbers such as 1792598960 (2026-10-21 16:09:20 UTC). Every 0.1.2 build has the same `[launcher] version`, which matters when a Deployment Server distributes the Data TA; see [Deployment-Apps Sync](data-ta-internals.md#deployment-apps-sync).

---

## :material-circle-box:{ .taiconcolor } Build the LogServ Azure and GCP Add-ons

Use the same virtual environment. Set the version in each add-on's `globalConfig.json` (`meta.version`) and `package/app.manifest`, then build from `sap_logserv_package/`:

```bash
cd sap_logserv_package
bash build_logserv_azure_ta.sh 0.1.2
bash build_logserv_gcp_ta.sh 0.1.2
```

Each wrapper deletes its own old tarball and `output/` directory, then runs `ucc-gen build --source splunk_ta_sap_logserv_azure/package --ta-version <version>` and `ucc-gen package --path output/splunk_ta_sap_logserv_azure` (for GCP, `splunk_ta_sap_logserv_gcp`). Check the output for these lines (Azure shown; for GCP they name `sap_logserv_gcp_pubsub` and `cloud_provider::gcp`):

```
[additional_packaging] Overwrote UCC stub with real bin/sap_logserv_azure_queue.py.
[additional_packaging] Patched inputs.conf: [sap_logserv_azure_queue] python.required + _meta = cloud_provider::azure.
[additional_packaging] Patched metadata/default.meta: added sc_subadmin to global write ACL.
```

The wrappers' closing hint still names an older input file (`azure_queue_input.py`, `gcp_queue_input.py`); go by the lines above.

---

## :material-circle-box:{ .taiconcolor } Vet a Package with AppInspect

Run Splunk AppInspect on every tarball before you install or publish it, always with `--included-tags cloud`, which adds the Splunk Cloud vetting checks:

```bash
pip install splunk-appinspect==4.3.1
splunk-appinspect inspect splunk_ta_sap_logserv-0.1.2.tar.gz \
    --mode precert --included-tags cloud \
    --output-file appinspect_cloud_logserv_ta.json --data-format json
```

- The target is 0 errors, 0 failures and 0 future failures.
- Compare each check with the published report of the canonical build in `release_binaries/` (`appinspect_cloud_logserv_app-0.1.2.json`, `appinspect_cloud_logserv_ta-0.1.2.json`, `appinspect_cloud_logserv_azure_ta-0.1.2.json`, `appinspect_cloud_logserv_gcp_ta-0.1.2.json`). A check whose result changed needs a reason.
- Treat a `check_for_existence_of_python_code_block_in_mako_template` warning as a blocker: AppInspect reports it only as a warning, but Splunk Cloud Victoria enforces the rule when the page is served, and the page then fails to load.

The `run_appinspect.sh` script in the Data TA source runs without `--included-tags cloud`; use the command above instead.

---

## :material-circle-box:{ .taiconcolor } Next Steps

- Install your build: [Create the Indexes and Install the Data TA](../install-setup/install-ta.md) and [Install the App and Seed the Dashboards](../logserv-app/installation.md).
- Replacing a running build: [Upgrading to This Release](../getting-started/upgrading.md).
- Test it end to end: [Clean Deployment Test (Lab)](testing-guide.md).
