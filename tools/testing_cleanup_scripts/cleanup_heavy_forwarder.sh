#!/bin/bash
# =============================================================================
# cleanup_heavy_forwarder.sh
#
# Run ON splunk-hf-01 or splunk-hf-02 as root (or via sudo).
# Removes the monolithic splunk_ta_sap_logserv pushed by the DS.
#
# HFs are RPM installs — use systemctl.
# DO NOT use /opt/splunk/bin/splunk start/stop on these hosts.
#
# Usage:
#   sudo bash cleanup_heavy_forwarder.sh
#
# What this script does:
#   1. Stops Splunk (systemctl)
#   2. Removes the old monolithic TA from etc/apps/
#   3. Starts Splunk (systemctl)
#
# After cleanup, the DS will push the new split Data TA to these HFs
# automatically via the SAP_LogServ_HeavyForwarders server class.
# The UI App is NEVER installed on HFs.
# =============================================================================

set -euo pipefail

SPLUNK_HOME="/opt/splunk"
TA_APP_DIR="${SPLUNK_HOME}/etc/apps/splunk_ta_sap_logserv"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info()  { echo -e "${GREEN}[INFO]${NC}  $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }

HOSTNAME=$(hostname -s 2>/dev/null || hostname)

echo ""
echo "============================================"
echo "  Cleanup: ${HOSTNAME} (Heavy Forwarder)"
echo "  Removing monolithic TA for clean install"
echo "============================================"
echo ""

# --- Pre-flight ---
echo "=== Current state ==="
echo -n "  Data TA (apps): "
[ -d "$TA_APP_DIR" ] && echo "EXISTS" || echo "not found"
echo ""

if [ -d "${TA_APP_DIR}/local" ]; then
    warn "Data TA has local/ dir (may contain DS-pushed filter configs):"
    ls -la "${TA_APP_DIR}/local/" 2>/dev/null
    echo ""
fi

# --- Stop Splunk (RPM/systemctl) ---
info "Stopping Splunk via systemctl..."
systemctl stop Splunkd 2>&1 || warn "Splunk may already be stopped"
echo ""

# --- Remove old monolithic TA ---
if [ -d "$TA_APP_DIR" ]; then
    info "Removing Data TA: ${TA_APP_DIR}"
    rm -rf "$TA_APP_DIR"
    info "  Done"
else
    info "Data TA not found — nothing to remove"
fi

# --- Start Splunk (RPM/systemctl) ---
info "Starting Splunk via systemctl..."
systemctl start Splunkd 2>&1
echo ""

# --- Post-flight ---
echo "=== Post-cleanup state ==="
echo -n "  Data TA (apps): "
[ -d "$TA_APP_DIR" ] && echo -e "${RED}STILL EXISTS — ERROR${NC}" || echo "removed"
echo ""

info "Cleanup complete."
echo ""
echo "Next steps:"
echo "  The DS will push the new split Data TA to this HF automatically"
echo "  after the Data TA is installed in deployment-apps on the DS."
echo "  The UI App is NEVER installed on HFs."
