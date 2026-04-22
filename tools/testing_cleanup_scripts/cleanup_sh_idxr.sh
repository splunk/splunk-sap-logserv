#!/bin/bash
# =============================================================================
# cleanup_sh_idxr.sh
#
# Run ON splunk-sh-idxr as root (or via sudo).
# Removes the monolithic splunk_ta_sap_logserv and prepares for clean install
# of both the split Data TA + UI App.
#
# splunk-sh-idxr uses systemd (boot-start enabled) — use systemctl.
#
# Usage:
#   sudo bash cleanup_sh_idxr.sh
#
# What this script does:
#   1. Stops Splunk
#   2. Removes the old monolithic TA from etc/apps/
#   3. Removes the old TA from etc/deployment-apps/ (if present — SH also
#      serves as DS combo for testing)
#   4. Removes any UI App directory if it exists (clean slate)
#   5. Cleans up any logserv-related system messages
#   6. Starts Splunk
# =============================================================================

set -euo pipefail

SPLUNK_HOME="/opt/splunk"
TA_APP_DIR="${SPLUNK_HOME}/etc/apps/splunk_ta_sap_logserv"
UI_APP_DIR="${SPLUNK_HOME}/etc/apps/splunk_app_sap_logserv"
TA_DEPLOY_DIR="${SPLUNK_HOME}/etc/deployment-apps/splunk_ta_sap_logserv"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info()  { echo -e "${GREEN}[INFO]${NC}  $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }

echo ""
echo "============================================"
echo "  Cleanup: splunk-sh-idxr"
echo "  Removing monolithic TA for clean install"
echo "============================================"
echo ""

# --- Pre-flight: show what exists ---
echo "=== Current state ==="
echo -n "  Data TA (apps):        "
[ -d "$TA_APP_DIR" ] && echo "EXISTS" || echo "not found"
echo -n "  Data TA (deploy-apps): "
[ -d "$TA_DEPLOY_DIR" ] && echo "EXISTS" || echo "not found"
echo -n "  UI App (apps):         "
[ -d "$UI_APP_DIR" ] && echo "EXISTS" || echo "not found"
echo ""

# --- Show local/ contents if any (these are runtime-generated configs) ---
if [ -d "${TA_APP_DIR}/local" ]; then
    warn "Data TA has local/ dir with runtime configs:"
    ls -la "${TA_APP_DIR}/local/" 2>/dev/null
    echo ""
fi

# --- Stop Splunk (systemctl) ---
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

# --- Remove from deployment-apps (SH also serves as DS combo) ---
if [ -d "$TA_DEPLOY_DIR" ]; then
    info "Removing Data TA from deployment-apps: ${TA_DEPLOY_DIR}"
    rm -rf "$TA_DEPLOY_DIR"
    info "  Done"
else
    info "Data TA not found in deployment-apps — skipping"
fi

# --- Remove UI App if it exists (clean slate) ---
if [ -d "$UI_APP_DIR" ]; then
    info "Removing existing UI App: ${UI_APP_DIR}"
    rm -rf "$UI_APP_DIR"
    info "  Done"
else
    info "UI App not found — nothing to remove"
fi

# --- Clean up serverclass.conf entries for SAP_LogServ if present ---
SERVERCLASS_FILES=$(find "${SPLUNK_HOME}/etc" -name "serverclass.conf" -path "*/local/*" 2>/dev/null)
if [ -n "$SERVERCLASS_FILES" ]; then
    warn "Found serverclass.conf file(s) — review manually for SAP_LogServ_HeavyForwarders entries:"
    echo "$SERVERCLASS_FILES"
    echo ""
    warn "The TA will recreate the server class automatically on first filter save."
    warn "If you want a fully clean slate, remove the SAP_LogServ stanzas manually."
fi

# --- Start Splunk (systemctl) ---
info "Starting Splunk via systemctl..."
systemctl start Splunkd 2>&1
echo ""

# --- Post-flight verification ---
echo "=== Post-cleanup state ==="
echo -n "  Data TA (apps):        "
[ -d "$TA_APP_DIR" ] && echo -e "${RED}STILL EXISTS — ERROR${NC}" || echo "removed"
echo -n "  Data TA (deploy-apps): "
[ -d "$TA_DEPLOY_DIR" ] && echo -e "${RED}STILL EXISTS — ERROR${NC}" || echo "removed"
echo -n "  UI App (apps):         "
[ -d "$UI_APP_DIR" ] && echo -e "${RED}STILL EXISTS — ERROR${NC}" || echo "removed"
echo ""

info "Cleanup complete. Ready for clean install of both packages."
echo ""
echo "Next steps:"
echo "  1. Install Data TA:  copy to ${TA_APP_DIR}/"
echo "  2. Install UI App:   copy to ${UI_APP_DIR}/"
echo "  3. Restart Splunk:   sudo systemctl restart Splunkd"
