#!/bin/bash

# run this first on the command line before running this script !!!
# source .venv/bin/activate

# usage: ./build_logserv.sh 0.0.3

ta_ver="$1"

ucc-gen build --source splunk_ta_sap_logserv/package --ta-version $ta_ver
ucc-gen package --path output/splunk_ta_sap_logserv
