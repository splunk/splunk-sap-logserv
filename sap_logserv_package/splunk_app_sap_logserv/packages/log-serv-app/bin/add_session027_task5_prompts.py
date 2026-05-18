#!/usr/bin/env python3
"""
One-shot helper: add 6 new prompts to default/data/mcp/logserv_intent_map.json
for build 158 / session 027 task 5. Each prompt fills a thin-coverage
dashboard for the new "Dashboard Focused" prompt-browser tab.

Run from the log-serv-app directory:

    python bin/add_session027_task5_prompts.py
"""

import json
from pathlib import Path

# SPL strings — MUST be byte-identical to the matching stanza in
# savedsearches.conf or intentMap.consistency-test.ts will fail.
SPLS = {
    "logserv_topology_top_systems_by_calls":
        "`sap_logserv_idx_macro` (sourcetype=sap:abap:gateway OR sourcetype=sap:abap:icm) sap_sid=* | stats count by sap_sid sourcetype | sort -count",
    "logserv_topology_rfc_partner_failures":
        '`sap_logserv_idx_macro` sourcetype=sap:abap:gateway gw_error_detail=* gw_error_detail!="" peer_ip=* | stats count by peer_ip gw_error_detail | sort -count | head 20',
    "logserv_sap_host_severity_breakdown":
        "`sap_logserv_idx_macro` sourcetype=sap:sapstartsrv severity=* | stats count by host severity | sort -count",
    "logserv_scc_backend_latency":
        '`sap_logserv_idx_macro` sourcetype=sap:scc:http_access response_time_ms=* | rex field=uri "^(?<uri_prefix>/[^/?]+)" | stats avg(response_time_ms) as avg_ms perc95(response_time_ms) as p95_ms perc99(response_time_ms) as p99_ms count by uri_prefix | sort -p95_ms | head 20',
    "logserv_scc_top_destinations":
        '`sap_logserv_idx_macro` sourcetype=sap:scc:http_access | rex field=uri "^(?<uri_prefix>/[^/?]+(?:/[^/?]+)?)" | stats count by uri_prefix status_category | sort -count | head 30',
    "logserv_top_error_categories":
        '`sap_logserv_idx_macro` ((sourcetype="sap:abap:dispatcher" (dp_severity="ERROR" OR dp_severity="FATAL")) OR (sourcetype="sap:abap:icm" icm_is_error=1) OR (sourcetype="sap:abap:gateway" gw_error_detail=* gw_error_detail!="") OR (sourcetype="sap:hana:audit" status!="SUCCESSFUL") OR (sourcetype="sap:hana:tracelogs" hana_trace_severity IN ("error", "fatal")) OR (sourcetype="sap:sapstartsrv" is_auth_event="true" auth_result="failure") OR (sourcetype="sap:scc:audit" scc_audit_type="ACCESS_DENIED") OR (sourcetype="linux_secure" IN_DROP) OR (sourcetype="XmlWinEventLog" severity IN ("critical","error","high")) OR (sourcetype="sap:webdispatcher:access" status>=400) OR (sourcetype="squid:access" action="denied")) | eval Category=case(match(sourcetype,"sap:abap"),"ABAP",match(sourcetype,"sap:hana"),"HANA",sourcetype IN ("sap:sapstartsrv","sap:scc:audit","linux_secure"),"Security",sourcetype IN ("sap:webdispatcher:access","squid:access"),"Web/Network",sourcetype="XmlWinEventLog","OS/Infra",1=1,"Other") | stats count as Errors dc(host) as affected_hosts by Category sourcetype | sort -Errors',
}

NEW_PROMPTS = [
    {
        "id": "sap_basis.topology_top_systems_by_calls",
        "pack": "sap_basis",
        "label": "Top SAP systems by inbound call volume",
        "description": (
            "Counts gateway + ICM events grouped by SAP SID and sourcetype, ranked desc. "
            "Surfaces which SIDs are busiest at the integration layer — useful for capacity "
            "review and for spotting unexpected volume spikes on a system that's normally quiet."
        ),
        "savedSearch": "logserv_topology_top_systems_by_calls",
        "spl": SPLS["logserv_topology_top_systems_by_calls"],
        "renderHint": "table",
        "chartHint": "pie",
        "chartPalette": "categorical",
        "dashboard": "integration-topology",
        "interpretation": (
            "Each row shows total inbound calls (gateway RFC frames + ICM HTTP/RFC requests) "
            "for one SID at one source layer. The biggest rows tell you where your integration "
            "traffic actually lives. A SID that suddenly outranks its peers is worth investigating."
        ),
        "nextSteps": [
            {
                "text": "If one SID dominates, drill into its calls-per-hour pattern via the Environment Topology view.",
                "savedSearch": "logserv_icm_request_volume_trend",
            },
            {
                "text": "Check whether the busiest SID is also showing gateway error growth.",
                "savedSearch": "logserv_abap_gateway_failures",
            },
            "Capacity review heuristic: if total calls/hr have grown 30%+ over baseline without a known release, plan for sizing.",
        ],
    },
    {
        "id": "sap_basis.topology_rfc_partner_failures",
        "pack": "sap_basis",
        "label": "RFC partner peers ranked by gateway error count",
        "description": (
            "Top RFC peer IPs whose connections are producing gateway errors, broken down by "
            "the gw_error_detail category. Identifies which upstream partners are repeatedly "
            "dropping connections, sending malformed frames, or timing out — helpful for "
            "narrowing a flaky-integration finger-point to a specific partner."
        ),
        "savedSearch": "logserv_topology_rfc_partner_failures",
        "spl": SPLS["logserv_topology_rfc_partner_failures"],
        "renderHint": "table",
        "chartHint": "pie",
        "chartPalette": "errors",
        "dashboard": "integration-topology",
        "interpretation": (
            "Peer IPs at the top with high counts on a single error category are usually the "
            "real culprit; peers with a small smattering across many categories are more likely "
            "innocent victims of upstream issues. NiBufIIn/invalid-data on a single peer often "
            "means a misconfigured client or a non-RFC service hitting the RFC port."
        ),
        "nextSteps": [
            {
                "text": "Cross-check the peer's overall connection volume to see if errors are a small fraction or dominant.",
                "savedSearch": "logserv_topology_top_systems_by_calls",
            },
            {
                "text": "If multiple peers show the same error category at once, look at the local SID's workprocess errors — the issue may be local.",
                "savedSearch": "logserv_abap_workprocess_errors",
            },
            "If a peer shows hundreds of NiBufIIn invalid-data and is NOT a known RFC partner, it's almost certainly a port-scan or misdirected non-RFC client.",
        ],
    },
    {
        "id": "operations.sap_host_severity_breakdown",
        "pack": "operations",
        "label": "SAP host control event severity by host",
        "description": (
            "sap:sapstartsrv events grouped by host and severity (Info / Warning / Error). "
            "Surfaces which hosts have noisy host-control activity — sustained Error volume on a "
            "single host is a leading indicator of an unstable startup-srv or persistent OS-level "
            "auth issues with the SAP service account."
        ),
        "savedSearch": "logserv_sap_host_severity_breakdown",
        "spl": SPLS["logserv_sap_host_severity_breakdown"],
        "renderHint": "table",
        "chartHint": "pie",
        "chartPalette": "status",
        "dashboard": "sap-services",
        "interpretation": (
            "A healthy host should have Info dominant; sustained Warning/Error rows mean "
            "something keeps failing in startup-srv interactions. Common causes: OS-level "
            "auth misconfig (sapadm password rotation gap), expired SSL certs, agent reload "
            "loops."
        ),
        "nextSteps": [
            {
                "text": "If Error severity dominates on one host, drill into the auth-failure detail.",
                "savedSearch": "logserv_sap_host_auth_failures",
            },
            "Sustained Warning without Error usually means transient SSL renegotiation churn — verify cert rotation completed cleanly.",
            "If a host has zero Info events but lots of Errors, sapstartsrv may be partially unreachable from the monitoring host.",
        ],
    },
    {
        "id": "operations.scc_backend_latency",
        "pack": "operations",
        "label": "SCC backend round-trip time percentiles by URI",
        "description": (
            "Cloud Connector HTTP-access response-time percentiles (avg / p95 / p99) grouped by "
            "the first URI segment, ranked by p95 desc. Identifies which backend API surfaces are "
            "slowest end-to-end — useful for SLA review and for spotting a backend service "
            "regression after a release."
        ),
        "savedSearch": "logserv_scc_backend_latency",
        "spl": SPLS["logserv_scc_backend_latency"],
        "renderHint": "table",
        "chartPalette": "errors-2",
        "dashboard": ["cloud-connector", "web-api-performance"],
        "interpretation": (
            "p95 is the customer-perceived slow case (1-in-20). p99 is the long-tail. Healthy "
            "backends typically run with p95 well under 1 s; p95 >2 s on a frequently-used URI "
            "means real latency that users will feel. p99 >> p95 suggests intermittent stalls "
            "rather than steady-state slowness."
        ),
        "nextSteps": [
            {
                "text": "Cross-check the slow backend's overall error rate to see if latency comes with errors.",
                "savedSearch": "logserv_cloud_connector_error_rate",
            },
            {
                "text": "If a single URI dominates volume AND latency, drill into per-call status codes to look for upstream 5xx surges.",
                "savedSearch": "logserv_scc_top_destinations",
            },
            "If p99 ramped suddenly without volume change, suspect a backend resource issue (db lock, GC pause) rather than load.",
        ],
    },
    {
        "id": "operations.scc_top_destinations",
        "pack": "operations",
        "label": "SCC top destination URI prefixes by volume",
        "description": (
            "Cloud Connector backend destinations ranked by request volume, broken down by HTTP "
            "status category (2xx_success / 4xx_client / 5xx_server). Tells you which backends "
            "the user community actually depends on most — useful for prioritizing monitoring "
            "alerts and for spotting an unexpected new dependency."
        ),
        "savedSearch": "logserv_scc_top_destinations",
        "spl": SPLS["logserv_scc_top_destinations"],
        "renderHint": "table",
        "chartHint": "pie",
        "chartPalette": "status",
        "dashboard": ["cloud-connector", "web-api-performance"],
        "interpretation": (
            "A high-volume URI with all 2xx_success rows is healthy and busy. A high-volume URI "
            "with significant 4xx/5xx is the priority finding — it's both heavily used AND "
            "frequently failing. New URIs that weren't in last month's top-10 may indicate a "
            "release that introduced a new dependency."
        ),
        "nextSteps": [
            {
                "text": "Drill into the latency profile of the top-volume URIs to see whether high volume comes with high p95.",
                "savedSearch": "logserv_scc_backend_latency",
            },
            "If the same URI shows in top-10 with both high 2xx and high 5xx counts, the backend is partially-degraded (some ops succeed, others fail) — investigate the failing op category.",
            "Verify the top-1 URI matches business expectations — if a non-business URI tops the list, suspect a misconfigured client or a runaway poll loop.",
        ],
    },
    {
        "id": "operations.top_error_categories",
        "pack": "operations",
        "label": "Top error categories across the LogServ estate",
        "description": (
            "Cross-cutting error breakdown across all 11 sourcetype/severity tuples the "
            "Environment Health Total Errors KPI counts, grouped by Category (ABAP / HANA / "
            "Security / Web/Network / OS/Infra) and sourcetype, with affected-host counts. "
            "Mirrors the EH Total Errors KPI's drilldown — same row breakdown, available "
            "as a saved search for AI-driven analysis."
        ),
        "savedSearch": "logserv_top_error_categories",
        "spl": SPLS["logserv_top_error_categories"],
        "renderHint": "table",
        "chartHint": "pie",
        "chartPalette": "errors",
        "dashboard": "environment-health",
        "interpretation": (
            "The top row is your dominant error pressure right now. Multi-category load (e.g. "
            "ABAP + HANA both at the top) usually points to a downstream SID-wide event "
            "(deployment, capacity exhaustion, network partition); single-category load is usually "
            "a layer-specific incident."
        ),
        "nextSteps": [
            {
                "text": "If ABAP dominates, drill into the workprocess error rate by SID + host.",
                "savedSearch": "logserv_abap_workprocess_errors",
            },
            {
                "text": "If HANA dominates, check audit-failure detail for the failing user / action_type.",
                "savedSearch": "logserv_hana_failed_auth",
            },
            {
                "text": "If Security dominates, look at the cross-stack auth correlation.",
                "savedSearch": "logserv_cross_stack_auth_failures",
            },
            "A single host concentrating multiple categories' errors often means that host is the actual incident root cause (e.g., a stuck dispatcher cascading into ICM + workprocess errors at once).",
        ],
    },
]


def main() -> None:
    here = Path(__file__).parent
    project_root = here.parent
    intent_map_path = project_root / "src" / "main" / "resources" / "splunk" / "default" / "data" / "mcp" / "logserv_intent_map.json"
    if not intent_map_path.exists():
        raise SystemExit(f"intent map not found at {intent_map_path}")

    with intent_map_path.open("r", encoding="utf-8") as f:
        data = json.load(f)

    existing_ids = {p["id"] for p in data["prompts"]}
    existing_saved = {p["savedSearch"] for p in data["prompts"]}

    added = 0
    for prompt in NEW_PROMPTS:
        if prompt["id"] in existing_ids:
            print(f"SKIP (id exists): {prompt['id']}")
            continue
        if prompt["savedSearch"] in existing_saved:
            print(f"SKIP (savedSearch exists): {prompt['savedSearch']}")
            continue
        data["prompts"].append(prompt)
        added += 1

    print(f"Added {added} new prompts; total now {len(data['prompts'])}")

    # Bump version
    old_version = data.get("version", "?")
    data["version"] = "0.0.8"
    description = data.get("description", "")
    addendum = (
        " v0.0.8 (Build 158 / session 027 task 5) adds 6 new prompts targeting "
        "thin-coverage dashboards: integration-topology (top systems by calls + RFC partner "
        "failures), sap-services (host severity breakdown), cloud-connector + "
        "web-api-performance (SCC backend latency + top destinations), and "
        "environment-health (top error categories). Powers the new \"Dashboard Focused\" "
        "tab in the prompt browser."
    )
    if "Build 158" not in description:
        data["description"] = description + addendum

    print(f"Bumped version {old_version} -> {data['version']}")

    with intent_map_path.open("w", encoding="utf-8") as f:
        json.dump(data, f, indent=4, ensure_ascii=False)
        f.write("\n")

    print(f"Wrote {intent_map_path}")


if __name__ == "__main__":
    main()
