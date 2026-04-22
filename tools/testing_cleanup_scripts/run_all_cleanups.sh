#!/bin/bash
# =============================================================================
# run_all_cleanups.sh
#
# Run from your LOCAL machine (Windows/Git Bash).
# SCPs each cleanup script to the appropriate EC2 host and executes it.
#
# Order of operations:
#   1. HFs first (they receive TA from DS, clean them before DS)
#   2. DS second (remove from apps/ and deployment-apps/)
#   3. SH last (remove monolithic TA, prepare for both split packages)
#
# Usage:
#   cd <repo>/tools/testing_cleanup_scripts
#   bash run_all_cleanups.sh
#
# Prerequisites:
#   - SSH config aliases: splunk-sh-idxr, splunk-deploy-server, splunk-hf-01, splunk-hf-02
#   - SSH access with sudo privileges
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
STAGING="/home/ec2-user/logserv_comp_staging"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

info()  { echo -e "${CYAN}[INFO]${NC}  $*"; }
ok()    { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
err()   { echo -e "${RED}[ERROR]${NC} $*" >&2; }

run_cleanup_on_host() {
    local host="$1"
    local script="$2"
    local script_name
    script_name=$(basename "$script")

    echo ""
    echo "========================================================"
    echo "  Running cleanup on: ${host}"
    echo "========================================================"
    echo ""

    # SCP the script to the host
    info "Uploading ${script_name} to ${host}:${STAGING}/"
    ssh "$host" "mkdir -p ${STAGING}"
    scp -q "${script}" "${host}:${STAGING}/${script_name}"

    # Make executable and run with sudo
    info "Executing ${script_name} on ${host}..."
    ssh "$host" "sudo bash ${STAGING}/${script_name}"

    ok "Cleanup complete on ${host}"
}

echo ""
echo "============================================"
echo "  SAP LogServ TA — Full Cleanup"
echo "  Preparing all hosts for split install"
echo "============================================"
echo ""

warn "This will STOP Splunk on each host, remove the monolithic TA, and restart."
echo ""
read -p "Continue? (y/N) " -n 1 -r
echo ""
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "Aborted."
    exit 0
fi

# --- Step 1: Clean HFs first ---
run_cleanup_on_host "splunk-hf-01" "${SCRIPT_DIR}/cleanup_heavy_forwarder.sh"
run_cleanup_on_host "splunk-hf-02" "${SCRIPT_DIR}/cleanup_heavy_forwarder.sh"

# --- Step 2: Clean DS ---
run_cleanup_on_host "splunk-deploy-server" "${SCRIPT_DIR}/cleanup_deploy_server.sh"

# --- Step 3: Clean SH/Indexer ---
run_cleanup_on_host "splunk-sh-idxr" "${SCRIPT_DIR}/cleanup_sh_idxr.sh"

echo ""
echo "========================================================"
echo "  All hosts cleaned. Ready for split TA installation."
echo "========================================================"
echo ""
echo "Execution order for install:"
echo "  1. splunk-sh-idxr:       Install Data TA + UI App, restart"
echo "  2. splunk-deploy-server:  Install Data TA (apps + deployment-apps), restart"
echo "  3. HFs:                   Will receive Data TA automatically from DS"
echo ""
