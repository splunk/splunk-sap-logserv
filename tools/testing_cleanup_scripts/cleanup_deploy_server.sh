#!/bin/bash
# =============================================================================
# cleanup_deploy_server.sh
#
# Run ON splunk-deploy-server as root (or via sudo).
# Removes the monolithic splunk_ta_sap_logserv from both etc/apps/ and
# etc/deployment-apps/, and prepares for clean install of the split Data TA.
#
# splunk-deploy-server is an RPM install — use systemctl.
# DO NOT use /opt/splunk/bin/splunk start/stop on this host.
#
# Usage:
#   sudo bash cleanup_deploy_server.sh
#
# What this script does:
#   1. Stops Splunk (systemctl)
#   2. Removes the old monolithic TA from etc/apps/
#   3. Removes the old TA from etc/deployment-apps/
#   4. Notes serverclass.conf for manual review
#   5. Starts Splunk (systemctl)
# =============================================================================

set -euo pipefail

SPLUNK_HOME="/opt/splunk"
TA_APP_DIR="${SPLUNK_HOME}/etc/apps/splunk_ta_sap_logserv"
TA_DEPLOY_DIR="${SPLUNK_HOME}/etc/deployment-apps/splunk_ta_sap_logserv"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info()  { echo -e "${GREEN}[INFO]${NC}  $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }

echo ""
echo "============================================"
echo "  Cleanup: splunk-deploy-server"
echo "  Removing monolithic TA for clean install"
echo "============================================"
echo ""

# --- Pre-flight: show what exists ---
echo "=== Current state ==="
echo -n "  Data TA (apps):        "
[ -d "$TA_APP_DIR" ] && echo "EXISTS" || echo "not found"
echo -n "  Data TA (deploy-apps): "
[ -d "$TA_DEPLOY_DIR" ] && echo "EXISTS" || echo "not found"
echo ""

# --- Show local/ contents if any ---
if [ -d "${TA_APP_DIR}/local" ]; then
    warn "Data TA has local/ dir with runtime configs:"
    ls -la "${TA_APP_DIR}/local/" 2>/dev/null
    echo ""
fi
if [ -d "${TA_DEPLOY_DIR}/local" ]; then
    warn "deployment-apps copy has local/ dir:"
    ls -la "${TA_DEPLOY_DIR}/local/" 2>/dev/null
    echo ""
fi

# --- Stop Splunk (RPM/systemctl) ---
info "Stopping Splunk via systemctl..."
systemctl stop Splunkd 2>&1 || warn "Splunk may already be stopped"
echo ""

# --- Remove old monolithic TA from apps ---
if [ -d "$TA_APP_DIR" ]; then
    info "Removing Data TA from apps: ${TA_APP_DIR}"
    rm -rf "$TA_APP_DIR"
    info "  Done"
else
    info "Data TA not found in apps — skipping"
fi

# --- Remove from deployment-apps ---
if [ -d "$TA_DEPLOY_DIR" ]; then
    info "Removing Data TA from deployment-apps: ${TA_DEPLOY_DIR}"
    rm -rf "$TA_DEPLOY_DIR"
    info "  Done"
else
    info "Data TA not found in deployment-apps — skipping"
fi

# --- Note serverclass.conf ---
SERVERCLASS_FILES=$(find "${SPLUNK_HOME}/etc" -name "serverclass.conf" -path "*/local/*" 2>/dev/null)
if [ -n "$SERVERCLASS_FILES" ]; then
    warn "Found serverclass.conf file(s) with possible SAP_LogServ entries:"
    for f in $SERVERCLASS_FILES; do
        echo "  FILE: $f"
        grep -A5 "SAP_LogServ" "$f" 2>/dev/null || echo "    (no SAP_LogServ stanzas found)"
    done
    echo ""
    warn "The TA will recreate the server class automatically on first filter save."
    warn "For a fully clean slate, remove the SAP_LogServ_HeavyForwarders stanzas manually."
fi

# --- Start Splunk (RPM/systemctl) ---
info "Starting Splunk via systemctl..."
systemctl start Splunkd 2>&1
echo ""

# --- Post-flight verification ---
echo "=== Post-cleanup state ==="
echo -n "  Data TA (apps):        "
[ -d "$TA_APP_DIR" ] && echo -e "${RED}STILL EXISTS — ERROR${NC}" || echo "removed"
echo -n "  Data TA (deploy-apps): "
[ -d "$TA_DEPLOY_DIR" ] && echo -e "${RED}STILL EXISTS — ERROR${NC}" || echo "removed"
echo ""

info "Cleanup complete. Ready for clean install of the split Data TA."
echo ""
echo "Next steps:"
echo "  1. Install Data TA to apps:           copy to ${TA_APP_DIR}/"
echo "  2. Install Data TA to deployment-apps: copy to ${TA_DEPLOY_DIR}/"
echo "  3. Restart Splunk:                     sudo systemctl restart Splunkd"
echo "  4. The UI App does NOT go on this server."
