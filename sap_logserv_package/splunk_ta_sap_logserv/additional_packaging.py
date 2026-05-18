"""
additional_packaging.py - UCC post-build hook

Six jobs:

1. Patch the UCC-generated rh_settings.py to import and use our custom
   FilterSettingsHandler instead of the default AdminExternalHandler.
   (UCC only wires custom handlers for "config" tabs -- those with a table.
   Our filter_settings tab is a "settings" tab, so UCC ignores
   restHandlerModule / restHandlerClass.)

2. Append the deployment_push REST endpoint stanzas to restmap.conf.
   (UCC overwrites restmap.conf if a copy exists in package/default/,
   so we append here instead.)

3. Append web.conf expose stanza for deployment_push.

4. Patch inputs.conf [script://...] stanzas to add python.required = 3.13.
   (Cleared AppInspect Cloud future_failure
   check_scripted_inputs_python_required — added session 041.)

5. Patch restmap.conf [admin_external:*] stanzas to add
   python.required = 3.13. (Cleared AppInspect Cloud future_failure
   check_admin_external_restmap_conf_python_required — added session 041.)

6. Patch the UCC-generated metadata/default.meta to add `sc_subadmin`
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

# ---- metadata/default.meta sc_subadmin write-ACL patch ----
# UCC bakes in `write : [ admin, sc_admin ]` and ignores our source-level
# value in package/metadata/default.meta. This patch restores sc_subadmin
# to the write list so Splunk Cloud Victoria customer admins (whose top
# role is sc_subadmin, not sc_admin) can write to TA-owned knowledge
# objects without 403s. Idempotent — running twice or on already-patched
# input is a no-op.

META_WRITE_OLD = "write : [ admin, sc_admin ]"
META_WRITE_NEW = "write : [ admin, sc_admin, sc_subadmin ]"


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

    # --- 2. Append deployment push stanzas to restmap.conf ---
    restmap_path = os.path.join(app_dir, "default", "restmap.conf")
    if os.path.isfile(restmap_path):
        with open(restmap_path, "a") as f:
            f.write(DEPLOYMENT_PUSH_STANZAS)

    # --- 3. Append deployment_push expose stanza to web.conf ---
    webconf_path = os.path.join(app_dir, "default", "web.conf")
    if os.path.isfile(webconf_path):
        with open(webconf_path, "a") as f:
            f.write(WEBCONF_EXPOSE_STANZA)
    else:
        with open(webconf_path, "w") as f:
            f.write(WEBCONF_EXPOSE_STANZA.lstrip("\n"))

    # --- 4. Add python.required = 3.13 to scripted-input stanzas in inputs.conf
    # (cleared AppInspect Cloud future_failure
    # check_scripted_inputs_python_required — added session 041).
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
                # Collect stanza body
                j = i + 1
                body = []
                while j < n and not lines[j].startswith("["):
                    body.append(lines[j])
                    j += 1
                body_str = "".join(body)
                if "python.required" not in body_str:
                    # Insert after the last non-blank line of stanza body
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

    # --- 5. Add python.required = 3.13 to [admin_external:*] stanzas in
    # restmap.conf (cleared AppInspect Cloud future_failure
    # check_admin_external_restmap_conf_python_required — added session 041).
    if os.path.isfile(restmap_path):
        with open(restmap_path, "r") as f:
            lines = f.readlines()
        out_lines = []
        i = 0
        n = len(lines)
        while i < n:
            line = lines[i]
            out_lines.append(line)
            if line.startswith("[admin_external:"):
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
        with open(restmap_path, "w") as f:
            f.writelines(out_lines)

    # --- 6. Patch metadata/default.meta to add sc_subadmin write ACL ---
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
