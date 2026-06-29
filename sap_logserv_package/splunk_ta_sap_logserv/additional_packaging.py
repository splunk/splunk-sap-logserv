"""
additional_packaging.py - UCC post-build hook for the LogServ Data TA.

Jobs (order matters -- see cleanup_output_files):

1. Patch the UCC-generated rh_settings.py to import and use our custom
   FilterSettingsHandler instead of the default AdminExternalHandler.
   (UCC only wires custom handlers for "config" tabs -- those with a table.
   Our filter_settings tab is a "settings" tab, so UCC ignores
   restHandlerModule / restHandlerClass.)

2. Patch EVERY [admin_external:*] stanza in restmap.conf to carry
   handlertype / python.version / python.required = 3.13 / passSystemAuth =
   true. The one such stanza is the Configuration "settings" handler.
   python.required clears the AppInspect Cloud future_failure
   check_admin_external_restmap_conf_python_required; passSystemAuth = true lets
   the UCC Python handler run in system context so a Splunk Cloud Victoria
   sc_subadmin Configuration save doesn't 403 for lack of admin_all_objects.
   MUST run BEFORE job 3 appends the deployment_push [script:] stanza (an
   earlier version mis-placed the inserts past the stanza because the appended
   [script:] block had extended the collected body -- session 047). Walking
   before any append avoids that.

3. Append the deployment_push REST endpoint stanzas to restmap.conf.
   (UCC overwrites restmap.conf if a copy exists in package/default/, so we
   append here.)

4. Append web.conf expose stanza for deployment_push.

5. Add python.required = 3.13 to every inputs.conf stanza that has
   python.version but lacks it -- covers the [script://...] scripted inputs
   (filter refresh / upgrade check). Clears AppInspect Cloud
   check_scripted_inputs_python_required.

6. Defensive cleanup of AArch64-incompatible binaries from lib/ (gRPC /
   protobuf / OpenTelemetry). Belt-and-suspenders alongside the
   solnlib<8.0.0 pin so AppInspect Cloud-mode stays clean if a future UCC /
   dep bump re-introduces them.

7. Patch the UCC-generated metadata/default.meta to add `sc_subadmin` to the
   global write ACL. UCC bakes in `write : [ admin, sc_admin ]` and ignores our
   source-level value; without this patch sc_subadmin users on locked-down
   Splunk Cloud Victoria deployments hit 403 on every write to TA-owned
   knowledge objects. Added session 043.

NOTE: the Azure queue input was split out into its own add-on
(`splunk_ta_sap_logserv_azure`, kind `sap_logserv_azure_queue`, session 066),
so this Data TA no longer carries any modular input -- only the Configuration
(Filters + Cloud Provider) "settings" handler + the deployment_push endpoint.
"""

import os
import re
import glob
import shutil

# ---- deployment push endpoint stanzas ----

DEPLOYMENT_PUSH_STANZAS = """

# --- Custom REST endpoint for deployment server push ---
[script:splunk_ta_sap_logserv_deployment_push]
match                 = /splunk_ta_sap_logserv/deployment_push
script                = splunk_ta_sap_logserv_rh_deployment_push.py
scripttype            = persist
handler               = splunk_ta_sap_logserv_rh_deployment_push.DeploymentPushHandler
requireAuthentication = true
output_modes          = json
passPayload           = true
passHttpHeaders       = true
passSystemAuth        = true
capability            = edit_deployment_server
python.version        = python3
python.required       = 3.13
"""

# ---- web.conf expose stanza for deployment_push ----

WEBCONF_EXPOSE_STANZA = """
[expose:splunk_ta_sap_logserv_deployment_push]
pattern = splunk_ta_sap_logserv/deployment_push
methods = POST, GET
"""

# ---- handler import patch ----

OLD_IMPORT = "from splunktaucclib.rest_handler.admin_external import AdminExternalHandler"
NEW_IMPORT = "from splunk_ta_sap_logserv_rh_filter_settings import FilterSettingsHandler"

OLD_HANDLE = "handler=AdminExternalHandler,"
NEW_HANDLE = "handler=FilterSettingsHandler,"

# ---- AArch64-incompatible / unused-transitive-dep packages to strip ----
# (gRPC + protobuf + OpenTelemetry via solnlib's instrumentation chain; the
# .so files are x86_64-only and fail AppInspect Cloud's AArch64 check. The
# solnlib<8.0.0 pin avoids them; this strip is defensive.)
LIB_STRIP_PATTERNS = [
    "google",
    "grpc",
    "opentelemetry*",
    "protobuf-*.dist-info",
    "grpcio-*.dist-info",
    "googleapis_common_protos-*.dist-info",
    "opentelemetry_*.dist-info",
]

# ---- metadata/default.meta sc_subadmin write-ACL patch ----
META_WRITE_OLD = "write : [ admin, sc_admin ]"
META_WRITE_NEW = "write : [ admin, sc_admin, sc_subadmin ]"


def cleanup_output_files(output_path, ta_name):
    app_dir = os.path.join(output_path, ta_name)
    restmap_path = os.path.join(app_dir, "default", "restmap.conf")
    webconf_path = os.path.join(app_dir, "default", "web.conf")
    inputs_path = os.path.join(app_dir, "default", "inputs.conf")

    # --- 1. Patch rh_settings.py to use our custom handler ---
    rh_path = os.path.join(app_dir, "bin", "{}_rh_settings.py".format(ta_name))
    if os.path.isfile(rh_path):
        with open(rh_path, "r") as f:
            content = f.read()
        content = content.replace(OLD_IMPORT, NEW_IMPORT)
        content = content.replace(OLD_HANDLE, NEW_HANDLE)
        with open(rh_path, "w") as f:
            f.write(content)

    # --- 2. Patch ALL admin_external stanzas (BEFORE any [script:] append) ---
    patch_admin_external_stanzas(restmap_path)

    # --- 3. Append deployment push stanzas to restmap.conf ---
    if os.path.isfile(restmap_path):
        with open(restmap_path, "a") as f:
            f.write(DEPLOYMENT_PUSH_STANZAS)

    # --- 4. Append deployment_push expose stanza to web.conf ---
    if os.path.isfile(webconf_path):
        with open(webconf_path, "a") as f:
            f.write(WEBCONF_EXPOSE_STANZA)
    else:
        with open(webconf_path, "w") as f:
            f.write(WEBCONF_EXPOSE_STANZA.lstrip("\n"))

    # --- 5. Patch inputs.conf: scripted-input python.required ---
    patch_inputs_conf(inputs_path)

    # --- 6. Defensive lib/ strip (AArch64-incompat + unused OTel/gRPC) ---
    lib_dir = os.path.join(app_dir, "lib")
    if os.path.isdir(lib_dir):
        for pattern in LIB_STRIP_PATTERNS:
            for match in glob.glob(os.path.join(lib_dir, pattern)):
                if os.path.isdir(match):
                    shutil.rmtree(match, ignore_errors=True)
                elif os.path.isfile(match):
                    try:
                        os.remove(match)
                    except OSError:
                        pass

    # --- 7. Patch metadata/default.meta to add sc_subadmin write ACL ---
    patch_sc_subadmin_metadata(app_dir)


def patch_admin_external_stanzas(restmap_path):
    """Ensure every [admin_external:*] stanza carries handlertype /
    python.version / python.required = 3.13 / passSystemAuth = true.

    Line-walker: collects each stanza body up to the next '[' header (or EOF)
    and inserts whichever of the four lines are missing, after the stanza's
    last non-blank content line. Idempotent. MUST run before any [script:]
    stanza is appended so a stanza body can't merge with an appended block.
    """
    if not os.path.isfile(restmap_path):
        return
    with open(restmap_path, "r") as f:
        lines = f.readlines()

    out = []
    i = 0
    n = len(lines)
    while i < n:
        line = lines[i]
        out.append(line)
        if re.match(r"^\[admin_external:", line):
            body = []
            j = i + 1
            while j < n and not lines[j].startswith("["):
                body.append(lines[j])
                j += 1
            body_str = "".join(body)
            insertions = []
            if "handlertype" not in body_str:
                insertions.append("handlertype = python\n")
            if "python.version" not in body_str:
                insertions.append("python.version = python3\n")
            if "python.required" not in body_str:
                insertions.append("python.required = 3.13\n")
            if "passSystemAuth" not in body_str:
                insertions.append("passSystemAuth = true\n")
            if insertions:
                last = len(body) - 1
                while last >= 0 and not body[last].strip():
                    last -= 1
                body = body[: last + 1] + insertions + body[last + 1:]
            out.extend(body)
            i = j
        else:
            i += 1

    with open(restmap_path, "w") as f:
        f.writelines(out)


def patch_inputs_conf(inputs_path):
    """Insert python.required = 3.13 right after the python.version line in
    every inputs.conf stanza that declares python.version but lacks it -- the
    [script://...] scripted inputs (filter refresh / upgrade check). Inserting
    after the python.version line (not after the stanza's last content line)
    avoids landing it past an inter-stanza comment block, since "collect body
    until next [stanza]" sweeps trailing comments into the prior stanza's body.
    Idempotent.
    """
    if not os.path.isfile(inputs_path):
        return
    with open(inputs_path, "r") as f:
        lines = f.readlines()

    out = []
    i = 0
    n = len(lines)
    while i < n:
        header = lines[i]
        if not header.startswith("["):
            out.append(header)
            i += 1
            continue
        body = []
        j = i + 1
        while j < n and not lines[j].startswith("["):
            body.append(lines[j])
            j += 1
        out.append(header)
        out.extend(_insert_python_required_after_version(body))
        i = j

    with open(inputs_path, "w") as f:
        f.writelines(out)


def _insert_python_required_after_version(body):
    """Insert python.required = 3.13 right after the python.version line, if
    python.version is present and python.required is not. No-op otherwise."""
    body_str = "".join(body)
    if "python.version" not in body_str or "python.required" in body_str:
        return body
    for idx, ln in enumerate(body):
        if ln.lstrip().startswith("python.version"):
            return body[: idx + 1] + ["python.required = 3.13\n"] + body[idx + 1:]
    return body


def patch_sc_subadmin_metadata(app_dir):
    """Add sc_subadmin to the global write ACL in metadata/default.meta.

    UCC bakes in `write : [ admin, sc_admin ]` and silently overwrites the
    source value. Idempotent. Safe to run from cleanup_output_files() and from
    a standalone repair script against an extracted tarball.
    """
    meta_path = os.path.join(app_dir, "metadata", "default.meta")
    if not os.path.isfile(meta_path):
        return False
    with open(meta_path, "r") as f:
        content = f.read()
    if META_WRITE_NEW in content:
        return False
    if META_WRITE_OLD not in content:
        print(
            "[additional_packaging] WARNING: metadata/default.meta does not "
            "contain the expected stock UCC write ACL '{}'. Skipping "
            "sc_subadmin patch — please verify the file manually.".format(
                META_WRITE_OLD))
        return False
    with open(meta_path, "w") as f:
        f.write(content.replace(META_WRITE_OLD, META_WRITE_NEW))
    print(
        "[additional_packaging] Patched metadata/default.meta: added "
        "sc_subadmin to global write ACL.")
    return True
