#!/bin/bash
# run_appinspect.sh — Splunk AppInspect for splunk_ta_sap_logserv
#
# Usage:
#   ./run_appinspect.sh <package.tar.gz>
#
# Example:
#   ./run_appinspect.sh splunk_ta_sap_logserv-0.0.3.tar.gz
#
# Prerequisites:
#   pip install splunk-appinspect
#
# This script runs AppInspect checks for the Data TA package.
#
# Located alongside additional_packaging.py (NOT inside package/) so
# UCC doesn't bundle it into the runtime tarball — AppInspect's
# `check_for_bin_files` flags any file with execute permissions
# outside bin/ inside the published artifact.

set -euo pipefail

PACKAGE="${1:?Usage: $0 <package.tar.gz>}"

if [ ! -f "$PACKAGE" ]; then
    echo "ERROR: File not found: $PACKAGE"
    exit 1
fi

echo "=== Splunk AppInspect: $PACKAGE ==="
echo ""

# Run AppInspect with standard checks
# --mode precert is the mode used for Splunk Cloud / Splunkbase submission
splunk-appinspect inspect "$PACKAGE" \
    --mode precert \
    --output-file appinspect_results.json \
    --data-format junitxml

RESULT=$?

echo ""
echo "=== Results saved to appinspect_results.json ==="

# Also generate a human-readable summary
splunk-appinspect inspect "$PACKAGE" \
    --mode precert \
    2>&1 | tee appinspect_summary.txt

echo ""
echo "=== Summary saved to appinspect_summary.txt ==="

exit $RESULT
