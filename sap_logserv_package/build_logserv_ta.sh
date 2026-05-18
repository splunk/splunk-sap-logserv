#!/bin/bash
#
# build_logserv_ta.sh — UCC build wrapper for the LogServ Data TA
#
# Prerequisites (one-time):
#   - UCC installed in a Python venv at ./.venv (or equivalent on PATH)
#   - source ./.venv/bin/activate                 # before running this script
#
# Usage:
#   ./build_logserv_ta.sh <version>
#
# Example:
#   ./build_logserv_ta.sh 0.1.1
#
# Working directory: this script must be run from the directory containing
# splunk_ta_sap_logserv/ (i.e., the source tree's sap_logserv_package/ dir,
# OR the UCC host's /home/ec2-user/ucc/ dir after the source is SCP'd in).
# The cleanup paths below are RELATIVE so the script works in either
# environment without modification.
#
# Build pipeline:
#   1. Wipe prior tarball + output/ dir (so stale artifacts don't bleed
#      into the new build)
#   2. ucc-gen build — generates output/splunk_ta_sap_logserv/ from
#      splunk_ta_sap_logserv/package/ + globalConfig.json. UCC also auto-
#      invokes additional_packaging.py's cleanup_output_files() hook
#      AFTER its own templates have run, which is where our six post-
#      build patches live (handler swap, restmap append, web.conf expose,
#      inputs.conf python.required injection, restmap.conf admin_external
#      python.required injection, sc_subadmin metadata write-ACL patch).
#   3. ucc-gen package — tars output/ into the release artifact.
#
# Stickies / things to know:
#   - UCC 6.1.0 prints "additional_packaging.py is present but does not
#     have `additional_packaging`. Skipping additional packaging." DESPITE
#     calling cleanup_output_files(). The message refers to a newer-style
#     hook function name we don't use. Confirm patches fired by looking
#     for "[additional_packaging] Patched ..." lines in the build output.
#   - Audit-index storage paths on disk are NOT renamed by re-running this
#     script; an upgrade from a prior audit-index name leaves orphaned
#     bucket data under the old path. Plan a clean break.

set -euo pipefail

if [ -z "${1:-}" ]; then
    echo "Usage: $0 <version>" >&2
    echo "Example: $0 0.1.1" >&2
    exit 1
fi
ta_ver="$1"

# Clean up old build artifacts (relative paths — works in both source
# checkout and UCC host envs).
rm -f splunk_ta_sap_logserv-*.tar.gz
rm -rf output/splunk_ta_sap_logserv

ucc-gen build --source splunk_ta_sap_logserv/package --ta-version "$ta_ver"
ucc-gen package --path output/splunk_ta_sap_logserv

echo ""
echo "Build complete: splunk_ta_sap_logserv-${ta_ver}.tar.gz"
echo ""
echo "Verify post-build patches landed (each line should be present):"
echo "  - [additional_packaging] Patched metadata/default.meta: added sc_subadmin to global write ACL."
echo "If a patch line is missing OR a WARNING was printed, inspect the build output above before promoting the tarball."
