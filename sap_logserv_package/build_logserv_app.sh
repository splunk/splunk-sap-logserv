#!/bin/bash
# =============================================================================
# build_logserv_app.sh — Build script for the LogServ UI App
#
# Packages splunk_app_sap_logserv into a Splunk-installable tar.gz.
# No UCC build needed — this is a hand-crafted Splunk app.
#
# Usage:
#   ./build_logserv_app.sh <version>
#
# Example:
#   ./build_logserv_app.sh 0.0.3
#
# Output:
#   splunk_app_sap_logserv-<version>.tar.gz (in current directory)
#
# Prerequisites:
#   Run from the sap_logserv_package/ directory.
# =============================================================================

set -euo pipefail

APP_ID="splunk_app_sap_logserv"
SOURCE_DIR="${APP_ID}/package"
OUTPUT_DIR="output"

if [ -z "${1:-}" ]; then
    echo "ERROR: Version number required."
    echo "Usage: $0 <version>"
    echo "Example: $0 0.0.3"
    exit 1
fi

APP_VER="$1"
TARBALL="${APP_ID}-${APP_VER}.tar.gz"

# Verify source exists
if [ ! -d "$SOURCE_DIR" ]; then
    echo "ERROR: Source directory not found: $SOURCE_DIR"
    echo "Run this script from the sap_logserv_package/ directory."
    exit 1
fi

echo "=== Building ${APP_ID} v${APP_VER} ==="
echo ""

# Clean previous output
rm -rf "${OUTPUT_DIR}/${APP_ID}"
mkdir -p "${OUTPUT_DIR}"

# Copy package contents into output with correct app directory name
echo "Copying package contents to ${OUTPUT_DIR}/${APP_ID}/..."
cp -r "$SOURCE_DIR" "${OUTPUT_DIR}/${APP_ID}"

# Update version in app.conf
APP_CONF="${OUTPUT_DIR}/${APP_ID}/default/app.conf"
if [ -f "$APP_CONF" ]; then
    echo "Setting version to ${APP_VER} in app.conf..."
    sed -i "s/^version = .*/version = ${APP_VER}/" "$APP_CONF"
else
    echo "WARNING: app.conf not found at ${APP_CONF}"
fi

# Remove run_appinspect.sh from the package (it's a dev tool, not part of the app)
rm -f "${OUTPUT_DIR}/${APP_ID}/run_appinspect.sh"

# Create the tar.gz from the output directory
echo "Creating ${TARBALL}..."
(cd "$OUTPUT_DIR" && tar -czf "../${TARBALL}" "${APP_ID}/")

# Show results
echo ""
echo "=== Build complete ==="
echo "Package: ${TARBALL}"
echo "Size: $(du -h "${TARBALL}" | cut -f1)"
echo "Contents:"
tar -tzf "${TARBALL}" | head -20
ENTRY_COUNT=$(tar -tzf "${TARBALL}" | wc -l)
echo "... (${ENTRY_COUNT} entries total)"
echo ""
