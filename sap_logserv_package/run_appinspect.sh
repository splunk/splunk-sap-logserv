#! /bin/sh

#usage:
#./run_appinsecpt.sh <splunkbase_username> <splunkbase_password> <package_name>


python3 ../tools/scripts/app_spec.py --username=$1 --password=$2 --package_name=../../sap_logserv_package/$3 --allowed_failures=0 --included_tags=cloud