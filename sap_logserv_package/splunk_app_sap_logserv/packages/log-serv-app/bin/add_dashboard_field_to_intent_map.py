#!/usr/bin/env python3
"""
One-shot helper: add the `dashboard` field to each entry in
default/data/mcp/logserv_intent_map.json. Run from the log-serv-app
directory:

    python bin/add_dashboard_field_to_intent_map.py

Build 156 / session 027. Single-string for one dashboard, array for
multi-target prompts. The mapping below is the source of truth.
"""

import json
import os
from pathlib import Path

# Saved-search → dashboard slug(s). Single string for one dashboard;
# array for multi-target. Slugs match dashboardRegistry.ts entries.
DASHBOARD_MAPPING = {
    "logserv_abap_workprocess_errors": ["work-process-performance", "abap-operations"],
    "logserv_dispatcher_softcancel_reasons": ["abap-operations", "work-process-performance"],
    "logserv_abap_gateway_failures": "abap-security",
    "logserv_abap_enqueue_errors": "abap-operations",
    "logserv_abap_message_server_errors": "abap-operations",
    "logserv_icm_request_type_mix": ["abap-operations", "web-api-performance"],
    "logserv_icm_request_volume_trend": "abap-operations",
    "logserv_icm_top_peer_ips": "abap-security",
    "logserv_hana_failed_auth": ["hana-audit", "cross-stack-authentication"],
    "logserv_hana_admin_user_management": ["hana-audit", "change-config"],
    "logserv_hana_after_hours_admin": ["hana-audit", "change-config"],
    "logserv_hana_user_creation": ["hana-audit", "change-config"],
    "logserv_hana_permission_grants": ["hana-audit", "change-config"],
    "logserv_hana_trace_errors": "hana-trace",
    "logserv_hana_trace_severity_trend": "hana-trace",
    "logserv_cross_stack_auth_failures": "cross-stack-authentication",
    "logserv_cross_stack_auth_failures_trend": "cross-stack-authentication",
    "logserv_data_freshness": "data-pipeline-overview",
    "logserv_dns_beaconing_24h": ["dns-analytics", "network-perimeter"],
    "logserv_event_volume_by_sourcetype_trend": "data-pipeline-overview",
    "logserv_event_volume_drop": "data-pipeline-overview",
    "logserv_events_by_clz_dir": "data-pipeline-overview",
    "logserv_firewall_drops_by_port": ["network-perimeter", "linux"],
    "logserv_firewall_proxy_correlation": "network-perimeter",
    "logserv_linux_pam_auth_failures": ["linux", "cross-stack-authentication"],
    "logserv_linux_firewall_agent_warnings": "linux",
    "logserv_noisy_hosts_trend": ["data-pipeline-overview", "host-details"],
    "logserv_proxy_top_denied_urls": ["proxy", "network-perimeter"],
    "logserv_proxy_error_rate_trend": "proxy",
    "logserv_sap_host_auth_failures": ["sap-services", "cross-stack-authentication"],
    "logserv_sap_router_volume_trend": "sap-router",
    "logserv_saprouter_anomalies": "sap-router",
    "logserv_sap_router_failures": "sap-router",
    "logserv_top_external_domains": "dns-analytics",
    "logserv_top_hosts_by_volume": ["data-pipeline-overview", "host-details"],
    "logserv_total_events_kpi": "environment-health",
    "logserv_distinct_hosts_kpi": "environment-health",
    "logserv_webdispatcher_5xx_rate_trend": ["web-dispatcher", "web-api-performance"],
    "logserv_webdispatcher_slow_uris": ["web-dispatcher", "web-api-performance"],
    "logserv_cloud_connector_error_rate": ["cloud-connector", "web-api-performance"],
    "logserv_windows_account_lockouts": ["windows", "cross-stack-authentication"],
    "logserv_windows_logon_successes": ["windows", "cross-stack-authentication"],
}


def main() -> None:
    here = Path(__file__).parent
    project_root = here.parent
    intent_map_path = project_root / "src" / "main" / "resources" / "splunk" / "default" / "data" / "mcp" / "logserv_intent_map.json"
    if not intent_map_path.exists():
        raise SystemExit(f"intent map not found at {intent_map_path}")

    with intent_map_path.open("r", encoding="utf-8") as f:
        data = json.load(f)

    prompts = data.get("prompts", [])
    print(f"Loaded {len(prompts)} prompts from {intent_map_path}")

    missing = []
    updated = 0
    for prompt in prompts:
        ss = prompt.get("savedSearch")
        if ss in DASHBOARD_MAPPING:
            prompt["dashboard"] = DASHBOARD_MAPPING[ss]
            updated += 1
        else:
            missing.append(ss)

    if missing:
        print(f"WARNING: no mapping defined for: {missing}")
    print(f"Added `dashboard` to {updated} prompts")

    # Bump version
    old_version = data.get("version", "?")
    data["version"] = "0.0.7"
    description = data.get("description", "")
    addendum = (
        " v0.0.7 (Build 156) adds an optional `dashboard` field per prompt: "
        "either a single OOTB dashboard slug (e.g. \"hana-audit\") or an array "
        "of slugs for cross-cutting prompts (e.g. [\"hana-audit\", "
        "\"cross-stack-authentication\"]). Slugs match `dashboardRegistry.ts`."
    )
    if "Build 156" not in description:
        data["description"] = description + addendum

    print(f"Bumped version {old_version} -> {data['version']}")

    # Write back with the same formatting style (4-space indent matches existing file)
    with intent_map_path.open("w", encoding="utf-8") as f:
        json.dump(data, f, indent=4, ensure_ascii=False)
        f.write("\n")  # trailing newline to match existing convention

    print(f"Wrote {intent_map_path}")


if __name__ == "__main__":
    main()
