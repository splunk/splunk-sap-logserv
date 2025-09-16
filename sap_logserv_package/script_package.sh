#!/bin/bash
ta_ver="$1"

ucc-gen build --source splunk_ta_sap_logserv/package --ta-version $ta_ver
ucc-gen package --path output/splunk_ta_sap_logserv
