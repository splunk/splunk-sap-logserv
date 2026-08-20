"""
additional_packaging.py - UCC post-build hook

Seven jobs:

1. Patch the UCC-generated rh_settings.py to import and use our custom
   FilterSettingsHandler instead of the default AdminExternalHandler.
   (UCC only wires custom handlers for "config" tabs -- those with a table.
   Our filter_settings tab is a "settings" tab, so UCC ignores
   restHandlerModule / restHandlerClass.)

2. Patch EVERY [admin_external:*] stanza in restmap.conf to carry
   handlertype / python.version / `python.required = 3.13` (AppInspect
   future_failure check_admin_external_restmap_conf_python_required —
   UCC 6.1.0 doesn't emit it by default) / `passSystemAuth = true`.
   MUST run before job 3 appends a [script:] stanza — see
   patch_admin_external_stanzas().

3. Append the deployment_push REST endpoint stanzas to restmap.conf.
   (UCC overwrites restmap.conf if a copy exists in package/default/,
   so we append here instead.)

4. Append web.conf expose stanza for deployment_push.

5. Defensive cleanup of AArch64-incompatible binaries from lib/.
   Belt-and-suspenders alongside the solnlib<8.0.0 pin in
   requirements.txt — if a future UCC bump or transitive-dep change
   re-introduces gRPC / protobuf / OpenTelemetry, this strip ensures
   AppInspect stays clean.

6. Patch inputs.conf [script://...] stanzas to add
   `python.required = 3.13` (AppInspect future_failure
   check_scripted_inputs_python_required — UCC 6.1.0 doesn't emit it
   by default for script stanzas). Was already in v0.0.5.0's
   additional_packaging.py; added to v0.1.1 in session 043 after a
   rebuild surfaced 1 future_failure that the prior released tarball
   somehow lacked.

7. Patch the UCC-generated metadata/default.meta to add `sc_subadmin`
   to the global write ACL. UCC's stock bake-in template emits
   `write : [ admin, sc_admin ]` and ignores our source-level value
   in package/metadata/default.meta. Without this patch, sc_subadmin
   users on locked-down Splunk Cloud Victoria deployments (where
   sc_admin is reserved for Splunk Cloud Ops staff and sc_subadmin is
   the customer's effective top admin role) hit 403 on every write
   attempt against TA-owned knowledge objects (filter Configuration
   UI, passwords realm under the TA namespace, etc.). Added session
   043 (2026-05-15) — verified missing from prior released tarballs
   despite the session-041 source fix.
"""

import os
import re
import shutil
import glob

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

# ---- admin_external python.required + passSystemAuth patch ----
# UCC 6.1.0 emits `python.version = python3` in the admin_external stanza
# but does NOT emit `python.required` (Python 3.13 compat declaration —
# AppInspect future_failure) nor `passSystemAuth`. We add both.
# passSystemAuth = true makes the Configuration settings save (Filters +
# Cloud Provider tabs) write its conf in system context; without it the save
# 403s ("This operation is forbidden") for Splunk Cloud Victoria sc_subadmin
# users who lack admin_all_objects. The metadata write ACL still gates who
# may attempt the save. (Demo Gen TA pattern — passSystemAuth added
# session 047.)
#
# See patch_admin_external_stanzas() below. This replaced a single
# `content.replace(..., 1)` in session 091: UCC currently emits exactly ONE
# admin_external stanza (both Configuration tabs share one MultipleModel
# settings endpoint), so the single replace was sufficient — but it would
# have silently patched only the FIRST stanza if a second ever appeared
# (an added modular input, or a tab that UCC gives its own endpoint). The
# v0.0.6 line already carried the walker; this brings the two lines to
# parity.

# ---- AArch64-incompatible / unused-transitive-dep packages to strip ----
# These come in through solnlib's OpenTelemetry instrumentation chain
# (gRPC + protobuf + OTel) which we don't use. The .so files are
# x86_64-only, which fails AppInspect's AArch64 compatibility check.
# Pinning solnlib<8.0.0 in requirements.txt avoids them in the first
# place; this strip is defensive in case a future version bump
# re-introduces them.

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
# UCC bakes in `write : [ admin, sc_admin ]` and ignores our source-level
# value in package/metadata/default.meta. This patch restores sc_subadmin
# to the write list so Splunk Cloud Victoria customer admins (whose top
# role is sc_subadmin, not sc_admin) can write to TA-owned knowledge
# objects without 403s. Idempotent — running twice or on already-patched
# input is a no-op.

META_WRITE_OLD = "write : [ admin, sc_admin ]"
META_WRITE_NEW = "write : [ admin, sc_admin, sc_subadmin ]"


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


def cleanup_output_files(output_path, ta_name):
    app_dir = os.path.join(output_path, ta_name)

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
    restmap_path = os.path.join(app_dir, "default", "restmap.conf")
    patch_admin_external_stanzas(restmap_path)

    # --- 3. Append deployment push stanzas to restmap.conf ---
    if os.path.isfile(restmap_path):
        with open(restmap_path, "a") as f:
            f.write(DEPLOYMENT_PUSH_STANZAS)

    # --- 4. Append deployment_push expose stanza to web.conf ---
    webconf_path = os.path.join(app_dir, "default", "web.conf")
    if os.path.isfile(webconf_path):
        with open(webconf_path, "a") as f:
            f.write(WEBCONF_EXPOSE_STANZA)
    else:
        with open(webconf_path, "w") as f:
            f.write(WEBCONF_EXPOSE_STANZA.lstrip("\n"))

    # --- 5. Defensive lib/ strip (AArch64-incompat + unused OTel/gRPC) ---
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

    # --- 6. Add python.required = 3.13 to scripted-input stanzas in
    # inputs.conf. Cleared AppInspect Cloud future_failure
    # check_scripted_inputs_python_required. The v0.0.5.0 Data TA's
    # additional_packaging.py already carried this patch (session 041);
    # v0.1.1 was missing it — added session 043 in lockstep with the
    # sc_subadmin metadata patch below.
    inputs_path = os.path.join(app_dir, "default", "inputs.conf")
    if os.path.isfile(inputs_path):
        with open(inputs_path, "r") as f:
            lines = f.readlines()
        out_lines = []
        i = 0
        n = len(lines)
        while i < n:
            line = lines[i]
            out_lines.append(line)
            if line.startswith("[script://"):
                j = i + 1
                body = []
                while j < n and not lines[j].startswith("["):
                    body.append(lines[j])
                    j += 1
                body_str = "".join(body)
                if "python.required" not in body_str:
                    last_idx = len(body) - 1
                    while last_idx >= 0 and not body[last_idx].strip():
                        last_idx -= 1
                    body = (
                        body[: last_idx + 1]
                        + ["python.required = 3.13\n"]
                        + body[last_idx + 1 :]
                    )
                out_lines.extend(body)
                i = j
            else:
                i += 1
        with open(inputs_path, "w") as f:
            f.writelines(out_lines)

    # --- 7. Patch metadata/default.meta to add sc_subadmin write ACL ---
    patch_sc_subadmin_metadata(app_dir)


def patch_sc_subadmin_metadata(app_dir):
    """Add sc_subadmin to the global write ACL in metadata/default.meta.

    UCC bakes in `write : [ admin, sc_admin ]` and silently overwrites
    whatever was in the source's package/metadata/default.meta. Without
    this patch, sc_subadmin users on locked-down Splunk Cloud Victoria
    deployments hit 403 on every write attempt against TA-owned
    knowledge objects.

    Idempotent: running on already-patched input is a no-op. Safe to
    run from cleanup_output_files() AND from a standalone repair script
    against an extracted tarball.

    Args:
        app_dir: path to the UCC-output TA directory
                 (e.g., output/splunk_ta_sap_logserv).
    """
    meta_path = os.path.join(app_dir, "metadata", "default.meta")
    if not os.path.isfile(meta_path):
        return False
    with open(meta_path, "r") as f:
        content = f.read()
    if META_WRITE_NEW in content:
        # Already patched — idempotent no-op.
        return False
    if META_WRITE_OLD not in content:
        # Unexpected ACL value — don't blindly mutate; surface a
        # warning instead so the operator knows to inspect manually.
        print(
            "[additional_packaging] WARNING: metadata/default.meta does not "
            "contain the expected stock UCC write ACL '{}'. Skipping "
            "sc_subadmin patch — please verify the file manually.".format(
                META_WRITE_OLD
            )
        )
        return False
    patched = content.replace(META_WRITE_OLD, META_WRITE_NEW)
    with open(meta_path, "w") as f:
        f.write(patched)
    print(
        "[additional_packaging] Patched metadata/default.meta: added "
        "sc_subadmin to global write ACL."
    )
    return True
