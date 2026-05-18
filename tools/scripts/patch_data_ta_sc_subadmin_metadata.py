#!/usr/bin/env python3
"""
patch_data_ta_sc_subadmin_metadata.py

Standalone repair tool that patches a Data TA's metadata/default.meta to
add `sc_subadmin` to the global write ACL. UCC's stock build template
emits `write : [ admin, sc_admin ]` and silently overwrites the source-
level value in package/metadata/default.meta. Without this patch,
sc_subadmin users on locked-down Splunk Cloud Victoria deployments
(where sc_admin is reserved for Splunk Cloud Ops staff and sc_subadmin
is the customer's effective top admin role) hit 403 on every write
attempt against TA-owned knowledge objects.

This is the SAME patch that `additional_packaging.py`'s
`patch_sc_subadmin_metadata()` applies inside the UCC build pipeline.
Going forward every UCC build auto-applies it (no manual step needed).
This standalone script exists for two cases:

  1. Repairing an ALREADY-BUILT tarball without re-running UCC. Faster
     than a full rebuild when you only need the ACL fix.

  2. Quick post-build verification — call it on the UCC output dir
     after `ucc-gen build` to confirm the patch took.

USAGE
-----

Patch an extracted Data TA directory (most common):

    python3 patch_data_ta_sc_subadmin_metadata.py \\
        /path/to/extracted/splunk_ta_sap_logserv

Patch a tarball in place (extracts, patches, repacks):

    python3 patch_data_ta_sc_subadmin_metadata.py \\
        --tarball /path/to/splunk_ta_sap_logserv-X.Y.Z.tar.gz

The patch is idempotent — running on already-patched input is a no-op
and exits 0 with a "no change" message. Running on input that doesn't
contain the expected stock UCC ACL line prints a WARNING and exits
non-zero so CI can fail loudly.

EXIT CODES
----------

  0   Patched successfully OR no change required (already patched)
  1   metadata/default.meta not found, OR file format unexpected
  2   Tarball mode: tar/gzip operation failed

EXAMPLE — repair the current canonical v0.1.1 Data TA tarball:

    cd package_versions/splunk_sap_logserv_combined_v0.1.1_2026-05-07
    python3 tools/scripts/patch_data_ta_sc_subadmin_metadata.py \\
        --tarball release_binaries/splunk_ta_sap_logserv-0.1.1.tar.gz
"""

import argparse
import os
import shutil
import subprocess
import sys
import tempfile


META_WRITE_OLD = "write : [ admin, sc_admin ]"
META_WRITE_NEW = "write : [ admin, sc_admin, sc_subadmin ]"


def patch_directory(app_dir):
    """Patch metadata/default.meta inside an extracted TA directory.

    Returns (changed, message) tuple. `changed` is True if the file was
    modified, False if no change was needed (already patched). Raises
    on file-not-found or unexpected-format conditions.
    """
    meta_path = os.path.join(app_dir, "metadata", "default.meta")
    if not os.path.isfile(meta_path):
        raise FileNotFoundError(
            "metadata/default.meta not found at {}".format(meta_path)
        )
    with open(meta_path, "r") as f:
        content = f.read()
    if META_WRITE_NEW in content:
        return False, "metadata/default.meta already contains sc_subadmin — no change"
    if META_WRITE_OLD not in content:
        raise ValueError(
            "metadata/default.meta does not contain the expected stock UCC "
            "write ACL '{}'. The file may have been hand-edited or built by "
            "a different tool — please inspect {} manually.".format(
                META_WRITE_OLD, meta_path
            )
        )
    patched = content.replace(META_WRITE_OLD, META_WRITE_NEW)
    with open(meta_path, "w") as f:
        f.write(patched)
    return True, "metadata/default.meta patched: added sc_subadmin to global write ACL"


def patch_tarball(tarball_path):
    """Extract a tarball, patch its metadata, and repack in place."""
    if not os.path.isfile(tarball_path):
        raise FileNotFoundError(
            "Tarball not found: {}".format(tarball_path)
        )
    tarball_path = os.path.abspath(tarball_path)

    with tempfile.TemporaryDirectory() as work_dir:
        # Extract
        try:
            subprocess.run(
                ["tar", "-xzf", tarball_path, "-C", work_dir],
                check=True,
                capture_output=True,
            )
        except subprocess.CalledProcessError as e:
            raise RuntimeError(
                "tar extract failed: {}".format(e.stderr.decode("utf-8", "ignore"))
            )

        # Find the top-level TA dir (single child of work_dir)
        children = [
            os.path.join(work_dir, c)
            for c in os.listdir(work_dir)
            if os.path.isdir(os.path.join(work_dir, c))
        ]
        if len(children) != 1:
            raise RuntimeError(
                "Expected single top-level dir in tarball, found {}: {}".format(
                    len(children), [os.path.basename(c) for c in children]
                )
            )
        ta_name = os.path.basename(children[0])
        app_dir = children[0]

        # Patch
        changed, message = patch_directory(app_dir)
        print(message)
        if not changed:
            return False

        # Repack — back up original first
        backup_path = tarball_path + ".pre-sc_subadmin-patch.bak"
        shutil.copy2(tarball_path, backup_path)
        print("Original tarball backed up to {}".format(backup_path))

        try:
            subprocess.run(
                [
                    "tar",
                    "-czf",
                    tarball_path,
                    "-C",
                    work_dir,
                    ta_name,
                ],
                check=True,
                capture_output=True,
            )
        except subprocess.CalledProcessError as e:
            # Restore from backup on failure
            shutil.copy2(backup_path, tarball_path)
            raise RuntimeError(
                "tar repack failed (backup restored): {}".format(
                    e.stderr.decode("utf-8", "ignore")
                )
            )

        print("Tarball repacked: {}".format(tarball_path))
        return True


def main():
    parser = argparse.ArgumentParser(
        description=(
            "Patch a Splunk Data TA's metadata/default.meta to add sc_subadmin "
            "to the global write ACL. See module docstring for full context."
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument(
        "directory",
        nargs="?",
        help="Path to an extracted Data TA directory (e.g., output/splunk_ta_sap_logserv)",
    )
    group.add_argument(
        "--tarball",
        help=(
            "Path to a Data TA tarball. The script extracts it, patches "
            "metadata, repacks in place, and saves a .pre-sc_subadmin-patch.bak "
            "copy of the original."
        ),
    )
    args = parser.parse_args()

    try:
        if args.tarball:
            changed = patch_tarball(args.tarball)
        else:
            changed, message = patch_directory(args.directory)
            print(message)
    except FileNotFoundError as e:
        print("ERROR: {}".format(e), file=sys.stderr)
        sys.exit(1)
    except ValueError as e:
        print("ERROR: {}".format(e), file=sys.stderr)
        sys.exit(1)
    except RuntimeError as e:
        print("ERROR: {}".format(e), file=sys.stderr)
        sys.exit(2)

    sys.exit(0)


if __name__ == "__main__":
    main()
