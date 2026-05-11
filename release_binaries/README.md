# v0.0.5.0 Release Binaries

This directory contains the two installable tarballs for the **Splunk for SAP LogServ** v0.0.5.0 release.

## Canonical tarballs

| Tarball | md5 | Size | Tier |
|---|---|---|---|
| [`splunk_app_sap_logserv-0.0.5.0.tar.gz`](./splunk_app_sap_logserv-0.0.5.0.tar.gz) | `2ff103459935e8200a6407789c242ca8` | 3.26 MB | Search Head |
| [`splunk_ta_sap_logserv-0.0.5.0.tar.gz`](./splunk_ta_sap_logserv-0.0.5.0.tar.gz) | `c12a06bc9183810b83377d8e6bc1ee09` | 8.86 MB | Deployment Server + Heavy Forwarders + Indexer |

Both are installable via Splunk Web (**Apps → Install app from file**) or via CLI:
```bash
/opt/splunk/bin/splunk install app /path/to/<tarball>
```

See [`docs/content/getting-started/quick-install-reference.md`](../docs/content/getting-started/quick-install-reference.md) for the per-tier install matrix and the prerequisite Splunkbase add-ons (CIM modules, Splunk MCP Server for the AI Assistant).

## What's in v0.0.5.0

The v0.0.5.0 release ships the React-based LogServ App with:

- **22 React-based dashboards** organized as Environment Health (default landing) + Topology + Applications (5) + Integration (5) + Security (3) + Platform (6). Single React bundle built on `@splunk/react-ui`, `@splunk/visualizations`, and `@xyflow/react`. Replaces the Dashboard Studio v2 layout that shipped in v0.0.4.2.
- **Environment Topology view** — graph-based visualization of SAP systems, integration partners, and endpoints. Force-directed initial layout, self-derived IP→SID inventory, named saved layouts via Splunk KV Store, Live mode auto-refresh.
- **AI Assistant — templates-only build** — predefined-prompt browser (48 canned saved searches across SAP Basis / Security / Operations packs, dispatched via the Splunk MCP Server with no LLM call). The free-form / LLM-driven path is **disabled at compile time** in this build pending internal review of the OWASP LLM Top 10 controls. Admins see the chat panel and the prompt browser; the chat input is read-only and Provider Credentials / Power Mode are hidden.
- **Audit log** — every AI Assistant action recorded in the dedicated `_ai_assistant_audit` index, with an in-app browser at **Settings → AI Assistant → Audit Log** and an optional HEC forwarder for tamper-evidence.
- **Index-time filtering + Deployment Server automation** — control which log types ingest via the Splunk Web UI; filtered events incur zero license cost.
- **Splunk 9.4.3 or later** is the minimum supported version. See the full release notes at [`docs/content/overview/release-notes.md`](../docs/content/overview/release-notes.md).

## Why "templates-only" in v0.0.5.0

The v0.0.5.0 release deliberately ships with the LLM-driven path **physically removed from the bundle at build time**. The MCP-based predefined-prompt path stays fully active so the solution can be demonstrated end-to-end against your data without enabling any external LLM provider. No event data is transmitted outside the Splunk deployment, no AI-generated narrative is produced, no provider credential needs to be configured.

The full LLM capabilities (free-form chat, Anthropic / OpenAI / Azure OpenAI / AWS Bedrock providers, three privacy tiers, Power Mode) are planned for a subsequent release behind a runtime admin toggle.

## AppInspect

Both tarballs were AppInspect-validated via `splunk-appinspect` in precert mode for the v0.0.5.0 release. To re-run locally:

```bash
pip install splunk-appinspect
splunk-appinspect inspect release_binaries/splunk_app_sap_logserv-0.0.5.0.tar.gz --mode precert
splunk-appinspect inspect release_binaries/splunk_ta_sap_logserv-0.0.5.0.tar.gz --mode precert
```

Each app also ships a `run_appinspect.sh` helper at `sap_logserv_package/<app>/run_appinspect.sh` that wraps the above.

## Splunkbase submission status

**Held for further customer review.** The tarballs are ready to ship; submission to the Splunkbase precert API has not been performed and will be initiated by the maintainer who holds Splunkbase credentials. To submit, sign in to <https://splunkbase.splunk.com> and use the **Submit App** UI to upload each tarball as a separate app, or use the Splunkbase REST API with an API key.
