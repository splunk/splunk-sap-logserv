"""
additional_packaging.py - UCC post-build hook

Two jobs:

1. Patch the UCC-generated rh_settings.py to import and use our custom
   FilterSettingsHandler instead of the default AdminExternalHandler.
   (UCC only wires custom handlers for "config" tabs -- those with a table.
   Our filter_settings tab is a "settings" tab, so UCC ignores
   restHandlerModule / restHandlerClass.)

2. Append the deployment_push REST endpoint stanzas to restmap.conf.
   (UCC overwrites restmap.conf if a copy exists in package/default/,
   so we append here instead.)
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
capability            = admin_all_objects
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
