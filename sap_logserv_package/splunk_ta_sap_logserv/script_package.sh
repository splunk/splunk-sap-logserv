#!/bin/bash
ta_ver="$1"

ucc-gen build --ta-version $ta_ver
ucc-gen package --path output/*