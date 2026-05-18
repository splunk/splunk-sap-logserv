#!/bin/bash
# Dry-run the 6 new prompts (build 158 / session 027 task 5) against live data
# on splunk-sh-idxr. Prints rows + first row keys for each. Iterate until
# every prompt returns non-empty results.
set -e

PASS="SPLUNK-i-05816da9f1678a010"
HOST="splunk-sh-idxr"

run() {
    local name="$1"
    local spl="$2"
    echo "=== $name ==="
    ssh "$HOST" "sudo su - splunk -c 'curl -sk -u admin:$PASS -X POST \
        --data-urlencode \"search=search $spl\" \
        --data \"earliest_time=-30d\" \
        --data \"latest_time=now\" \
        --data \"output_mode=json\" \
        https://localhost:8089/services/search/jobs/oneshot' \
      | python3 -c \"import sys,json; d=json.load(sys.stdin); r=d.get('results',[]); print('rows:',len(r)); print('sample:',r[0] if r else 'EMPTY')\""
    echo
}

run "logserv_topology_top_systems_by_calls" \
'`sap_logserv_idx_macro` (sourcetype=sap:abap:gateway OR sourcetype=sap:abap:icm) sap_sid=* | stats count by sap_sid sourcetype | sort -count'

run "logserv_topology_rfc_partner_failures" \
'`sap_logserv_idx_macro` sourcetype=sap:abap:gateway gw_error_detail=* gw_error_detail!="" peer_ip=* | stats count by peer_ip gw_error_detail | sort -count | head 20'

run "logserv_sap_host_severity_breakdown" \
'`sap_logserv_idx_macro` sourcetype=sap:sapstartsrv severity=* | stats count by host severity | sort -count'

run "logserv_scc_backend_latency" \
'`sap_logserv_idx_macro` sourcetype=sap:scc:http_access response_time_ms=* | rex field=uri "^(?<uri_prefix>/[^/?]+)" | stats avg(response_time_ms) as avg_ms perc95(response_time_ms) as p95_ms perc99(response_time_ms) as p99_ms count by uri_prefix | sort -p95_ms | head 20'

run "logserv_scc_top_destinations" \
'`sap_logserv_idx_macro` sourcetype=sap:scc:http_access | rex field=uri "^(?<uri_prefix>/[^/?]+(?:/[^/?]+)?)" | stats count by uri_prefix status_category | sort -count | head 30'

run "logserv_top_error_categories" \
'`sap_logserv_idx_macro` ((sourcetype="sap:abap:dispatcher" (dp_severity="ERROR" OR dp_severity="FATAL")) OR (sourcetype="sap:abap:icm" icm_is_error=1) OR (sourcetype="sap:abap:gateway" gw_error_detail=* gw_error_detail!="") OR (sourcetype="sap:hana:audit" status!="SUCCESSFUL") OR (sourcetype="sap:hana:tracelogs" hana_trace_severity IN ("error", "fatal")) OR (sourcetype="sap:sapstartsrv" is_auth_event="true" auth_result="failure") OR (sourcetype="sap:scc:audit" scc_audit_type="ACCESS_DENIED") OR (sourcetype="linux_secure" IN_DROP) OR (sourcetype="XmlWinEventLog" severity IN ("critical","error","high")) OR (sourcetype="sap:webdispatcher:access" status>=400) OR (sourcetype="squid:access" action="denied")) | eval Category=case(match(sourcetype,"sap:abap"),"ABAP",match(sourcetype,"sap:hana"),"HANA",sourcetype IN ("sap:sapstartsrv","sap:scc:audit","linux_secure"),"Security",sourcetype IN ("sap:webdispatcher:access","squid:access"),"Web/Network",sourcetype="XmlWinEventLog","OS/Infra",1=1,"Other") | stats count as Errors dc(host) as affected_hosts by Category sourcetype | sort -Errors'
