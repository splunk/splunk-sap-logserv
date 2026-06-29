"""
additional_packaging.py - UCC post-build hook for splunk_ta_sap_logserv_azure.

This TA carries ONLY the sap_logserv_azure_queue modular input (the Azure twin of the
AWS SQS-S3 input). It has no Configuration "settings" tab, no deployment_push
endpoint, and no parsing confs -- so this hook is the Azure-only SUBSET of the
Data TA's additional_packaging.py:

1. Patch EVERY [admin_external:*] stanza in restmap.conf to carry handlertype /
   python.version / python.required = 3.13 / passSystemAuth = true. The one such
   stanza here is UCC's auto-generated sap_logserv_azure_queue input-CRUD REST handler.
   python.required clears AppInspect Cloud's
   check_admin_external_restmap_conf_python_required future_failure;
   passSystemAuth = true lets the handler run in system context so a locked-down
   Splunk Cloud sc_subadmin "create input" doesn't 403 for lack of
   admin_all_objects.

2. Patch the generated inputs.conf [sap_logserv_azure_queue] kind stanza to carry
   python.version = python3, python.required = 3.13, and
   _meta = cloud_provider::azure. UCC 6.1.0 emits this stanza with an EMPTY body,
   so all three are added. python.required clears
   check_modular_inputs_python_required; _meta tags every event from any
   instance of this input with the indexed cloud_provider=azure field (per-input
   attribution that survives downstream transforms and works on a mixed
   AWS+Azure HF). Same pattern session 045 used on the Splunk Add-on for
   Microsoft Cloud Services mscs_storage_blob:// stanza.

3. Overwrite UCC's auto-generated bin/sap_logserv_azure_queue.py stub with our real
   implementation from package/bin/. UCC's "Generating inputs code" step
   regenerates the input file from globalConfig.json, ignoring the source --
   without this the deployed TA would carry the stub instead of the queue
   consumer. (Demo Gen / Data TA pattern.)

4. Defensive cleanup of AArch64-incompatible binaries from lib/ (gRPC /
   protobuf / OpenTelemetry). Belt-and-suspenders alongside the solnlib<8.0.0
   pin so AppInspect Cloud-mode stays clean if a future UCC / dep bump
   re-introduces them.

5. Patch the UCC-generated metadata/default.meta to add sc_subadmin to the
   global write ACL. UCC bakes in `write : [ admin, sc_admin ]` and ignores our
   source-level value; without this, sc_subadmin users on locked-down Splunk
   Cloud Victoria deployments hit 403 on every write to TA-owned knowledge
   objects (here: creating/editing an input instance).

NOTE: UCC 6.1.0 prints "additional_packaging.py is present but does not have
`additional_packaging`. Skipping additional packaging." despite calling
cleanup_output_files(). The message refers to a newer-style hook name we don't
use; confirm patches fired via the "[additional_packaging] Patched ..." lines.
"""

import os
import re
import glob
import shutil

# ---- per-input cloud_provider attribution ----
# The sap_logserv_azure_queue is, by definition, an Azure ingest path, so stamp every
# event from it with the indexed cloud_provider=azure field via the kind-stanza
# _meta. (Proven session-045 pattern; survives all downstream transforms.)
AZURE_INPUT_KIND = "[sap_logserv_azure_queue]"
AZURE_META_LINE = "_meta = cloud_provider::azure\n"

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
    inputs_path = os.path.join(app_dir, "default", "inputs.conf")

    # --- 1. Patch ALL admin_external stanzas (the input-CRUD REST handler) ---
    patch_admin_external_stanzas(restmap_path)

    # --- 2. Patch inputs.conf: [sap_logserv_azure_queue] python.required + _meta ---
    patch_inputs_conf(inputs_path)

    # --- 3. Overwrite UCC's auto-generated bin/sap_logserv_azure_queue.py stub ---
    ta_source_root = os.path.dirname(os.path.abspath(__file__))
    src_input_py = os.path.join(
        ta_source_root, "package", "bin", "sap_logserv_azure_queue.py")
    dst_input_py = os.path.join(app_dir, "bin", "sap_logserv_azure_queue.py")
    if os.path.isfile(src_input_py) and os.path.isdir(os.path.dirname(dst_input_py)):
        shutil.copyfile(src_input_py, dst_input_py)
        print("[additional_packaging] Overwrote UCC stub with real "
              "bin/sap_logserv_azure_queue.py.")

    # --- 4. Defensive lib/ strip (AArch64-incompat + unused OTel/gRPC) ---
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

    # --- 5. Patch metadata/default.meta to add sc_subadmin write ACL ---
    patch_sc_subadmin_metadata(app_dir)


def patch_admin_external_stanzas(restmap_path):
    """Ensure every [admin_external:*] stanza carries handlertype /
    python.version / python.required = 3.13 / passSystemAuth = true.

    Line-walker: collects each stanza body up to the next '[' header (or EOF)
    and inserts whichever of the four lines are missing, after the stanza's
    last non-blank content line. Idempotent.
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
    """Patch the generated inputs.conf:

    - The [sap_logserv_azure_queue] modular-input kind stanza: ensure it carries
      python.version = python3, python.required = 3.13, and
      _meta = cloud_provider::azure. UCC 6.1.0 emits this stanza with an EMPTY
      body, so all three must be added.
    - Every OTHER stanza that declares python.version but not python.required:
      insert python.required = 3.13 immediately AFTER the python.version line.

    Idempotent.
    """
    if not os.path.isfile(inputs_path):
        return
    with open(inputs_path, "r") as f:
        lines = f.readlines()

    out = []
    i = 0
    n = len(lines)
    saw_azure_kind = False
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
        if header.strip() == AZURE_INPUT_KIND:
            saw_azure_kind = True
            body = _ensure_stanza_lines(body, [
                ("python.version", "python.version = python3\n"),
                ("python.required", "python.required = 3.13\n"),
                ("_meta", AZURE_META_LINE),
            ])
        else:
            body = _insert_python_required_after_version(body)
        out.append(header)
        out.extend(body)
        i = j

    if not saw_azure_kind:
        # Defensive: UCC didn't emit the kind stanza (unexpected). Append a
        # complete one so attribution + python flags still apply.
        out.append(
            "\n{}\npython.version = python3\npython.required = 3.13\n{}".format(
                AZURE_INPUT_KIND, AZURE_META_LINE))

    with open(inputs_path, "w") as f:
        f.writelines(out)
    print("[additional_packaging] Patched inputs.conf: [sap_logserv_azure_queue] "
          "python.required + _meta = cloud_provider::azure.")


def _ensure_stanza_lines(body, wanted):
    """Append each (token, full_line) whose token is absent from the body,
    after the body's last non-blank line. Order preserved as given."""
    body_str = "".join(body)
    additions = [line for token, line in wanted if token not in body_str]
    if not additions:
        return body
    last = len(body) - 1
    while last >= 0 and not body[last].strip():
        last -= 1
    return body[: last + 1] + additions + body[last + 1:]


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
    source value. Idempotent.
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
