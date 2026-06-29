#!/bin/bash
#
# build_logserv_azure_ta.sh — UCC build wrapper for the LogServ Azure TA
# (splunk_ta_sap_logserv_azure: the standalone Azure Storage Queue input,
# split out of the Data TA — design azure_input_split_ta_design_v0.1_20260624.md).
#
# Prerequisites (one-time):
#   - UCC installed in a Python venv at ./.venv (or equivalent on PATH)
#   - source ./.venv/bin/activate                 # before running this script
#
# Usage:
#   ./build_logserv_azure_ta.sh <version>         # e.g. ./build_logserv_azure_ta.sh 0.0.6
#
# Working directory: run from the directory containing
# splunk_ta_sap_logserv_azure/ (the source tree's sap_logserv_package/ dir,
# OR the UCC host's /home/ec2-user/ucc/ dir after the source is SCP'd in).
# Relative paths so the script works in either environment.
#
# Build pipeline:
#   1. Wipe prior tarball + output/ dir.
#   2. ucc-gen build — generates output/splunk_ta_sap_logserv_azure/ from
#      splunk_ta_sap_logserv_azure/package/ + globalConfig.json. UCC auto-
#      invokes additional_packaging.py's cleanup_output_files() AFTER its own
#      templates run (admin_external python.required, inputs.conf _meta +
#      python.required, real-input stub overwrite, lib strip, sc_subadmin meta).
#   3. ucc-gen package — tars output/ into the release artifact.
#
# UCC 6.1.0 prints "Skipping additional packaging." DESPITE calling
# cleanup_output_files(); confirm via the "[additional_packaging] ..." lines.

set -euo pipefail

if [ -z "${1:-}" ]; then
    echo "Usage: $0 <version>" >&2
    echo "Example: $0 0.0.6" >&2
    exit 1
fi
ta_ver="$1"

rm -f splunk_ta_sap_logserv_azure-*.tar.gz
rm -rf output/splunk_ta_sap_logserv_azure

ucc-gen build --source splunk_ta_sap_logserv_azure/package --ta-version "$ta_ver"
ucc-gen package --path output/splunk_ta_sap_logserv_azure

echo ""
echo "Build complete: splunk_ta_sap_logserv_azure-${ta_ver}.tar.gz"
echo ""
echo "Verify post-build patches landed (each should be present in the output above):"
echo "  - [additional_packaging] Overwrote UCC stub with real bin/azure_queue_input.py."
echo "  - [additional_packaging] Patched inputs.conf: [azure_queue_input] python.required + _meta = cloud_provider::azure."
echo "  - [additional_packaging] Patched metadata/default.meta: added sc_subadmin to global write ACL."
