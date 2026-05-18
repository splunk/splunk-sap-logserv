# Threat Intelligence Integration

The Splunk for SAP LogServ App ships **3 customer-managed CSV lookups** and **3 correlation searches** that join SAP / DNS / proxy events against those lookups to detect known indicators of compromise. Both the lookups and the correlation searches live entirely inside the LogServ App — no separate Splunkbase dependency, no new install step beyond the App itself.

The lookups ship **empty** (header row only). Customers populate them from their own threat-intel feed; the correlation searches return 0 rows until populated.

## :material-circle-box:{ .taiconcolor } The 3 lookups

| Lookup table | CSV columns | What it represents |
|---|---|---|
| `logserv_ti_malicious_domains` | `domain,category,source,added_date,notes` | Domains flagged as C2, phishing, malware-distribution, etc. |
| `logserv_ti_malicious_ips` | `ip,category,source,added_date,notes` | IPs flagged as C2, scanner, exfiltration endpoint, etc. |
| `logserv_ti_compromised_credentials` | `username,added_date,notes` | Usernames known to be compromised (breach lists, internal incident response findings, etc.) |

**Schema details:**

- `domain` / `ip` / `username` — the indicator itself. Match is case-insensitive (set via `case_sensitive_match = false` on the transforms.conf stanza). Domain values should NOT have a trailing dot — the search normalizes the DNS query field via `rtrim` before lookup.
- `category` — free-form tag identifying the IOC class (e.g., `c2`, `phishing`, `malware`, `exfiltration`, `scanner`). Surfaced in the notable event's rule_title.
- `source` — free-form provenance tag identifying which threat-intel feed the indicator came from (e.g., `Mandiant`, `OpenCTI`, `internal-IR`). Helps tune which feeds produce true positives over time.
- `added_date` — ISO 8601 date the indicator was added. Useful for FP analysis (very old indicators are more likely to have been remediated upstream).
- `notes` — free-form, optional. Surfaced in the rule_description.

## :material-circle-box:{ .taiconcolor } The 3 correlation searches

| Search name | Joins against | Severity | Schedule |
|---|---|---|---|
| `splunk_sap_logserv_es_ti_dns_to_malicious_domain` | `isc:bind:query` ↔ `logserv_ti_malicious_domains` | high | every 10 min |
| `splunk_sap_logserv_es_ti_proxy_to_malicious_ip` | `squid:access` ↔ `logserv_ti_malicious_ips` | high | every 10 min |
| `splunk_sap_logserv_es_ti_compromised_credential_use` | HANA / ABAP / sapstartsrv auth events ↔ `logserv_ti_compromised_credentials` | critical | every 5 min |

All three emit `action.notable=1` for ES Notable Review and `action.risk=1` for the RBA framework. Risk scores: 80 (DNS hit), 70 (proxy hit), 90 (compromised credential — highest because the action — locking the credential — is unambiguous).

## :material-circle-box:{ .taiconcolor } Populating the lookups

Three workflows, depending on the size and freshness expectations of your TI source:

### :material-crop-square:{ .taiconcolor } 1. Splunk Web (small, manual, ad-hoc)

For small lists (< 100 indicators) maintained by hand:

1. **Settings → Lookups → Lookup table files**
2. Filter for `logserv_ti_*`
3. Click the lookup name → upload a new CSV with the same column structure.

Splunk replaces the file in place. The existing transforms.conf stanza stays unchanged.

### :material-crop-square:{ .taiconcolor } 2. Customer-authored saved search (recurring, automated)

For TI feeds that update regularly:

1. Author a saved search that pulls from the TI source (REST API, file ingest, etc.) and emits rows matching the `domain,category,source,added_date,notes` shape.
2. End the SPL with `| outputlookup logserv_ti_malicious_domains` to overwrite the file.
3. Schedule the saved search at whatever cadence matches your feed (hourly, daily, etc.).

This is the canonical pattern Splunk recommends for managed TI feeds. The customer owns the upstream connector; the LogServ App is just the consumer.

### :material-crop-square:{ .taiconcolor } 3. Threat-intel framework (Splunk ES Threat Framework)

If you have ES installed, the ES Threat Framework already maintains its own consolidated threat-intel KV Store collections. Bridge those to the LogServ-side lookups via a saved search:

```spl
| inputlookup threat_intel_by_domain
| where category="malicious"
| eval added_date=strftime(_time, "%Y-%m-%d")
| rename description AS notes
| eval source="splunk-es-threat-framework"
| table domain category source added_date notes
| outputlookup logserv_ti_malicious_domains
```

(Adjust field names + filter logic to match your ES Threat Framework configuration.)

## :material-circle-box:{ .taiconcolor } Tuning + maintenance

- **Stale indicators.** Indicators older than ~30 days have a higher false-positive rate (the upstream threat may already be remediated). Periodically prune via `inputlookup → where added_date >= relative_time(now(), "-30d") → outputlookup` to overwrite with a freshness-filtered view.
- **Source weighting.** If a particular `source` produces too many FPs, pre-filter at lookup-write time so it never reaches the correlation search. A source that produces TPs reliably can be tagged as such in the `notes` field for SOC analyst context.
- **Custom domains.** The `domain` column accepts FQDNs. Wildcard domain patterns (e.g., `*.evil.com`) are NOT directly supported by Splunk's stock `lookup` command — for wildcard support, use a `match=WILDCARD` lookup (configure on the transforms.conf stanza) or a custom-authored detection that uses regex matching against the lookup contents.

## :material-circle-box:{ .taiconcolor } AI Assistant integration

Each of the 3 TI correlation searches has a corresponding entry in the AI Assistant predefined-prompt catalog:

- `security.ti_dns_to_malicious_domain`
- `security.ti_proxy_to_malicious_ip`
- `security.ti_compromised_credential_use`

SOC analysts can ask the AI Assistant to dispatch them on demand: "Show me TI hits across DNS in the last hour" routes to the prompt browser → Security pack → TI: DNS to malicious domain.

## :material-circle-box:{ .taiconcolor } Verifying the lookups loaded correctly

After installing or upgrading the LogServ App, verify the 3 TI lookups are queryable:

```spl
| inputlookup logserv_ti_malicious_domains | head 5
| inputlookup logserv_ti_malicious_ips | head 5
| inputlookup logserv_ti_compromised_credentials | head 5
```

Each should return 0 rows (the lookups ship empty). The fact that the queries DISPATCH cleanly without "lookup table not found" errors confirms the transforms.conf wiring is correct.

## :material-circle-box:{ .taiconcolor } See also

- [Correlation Searches & RBA](correlation-searches.md) — Full list of the 18 correlation searches across the App
- [Behavioral & Anomaly Detections](behavioral-detections.md) — Statistically-baselined detections that complement TI matching
- [Asset & Identity Feed](asset-identity-feed.md) — Customer-managed asset and identity context (similar customer-side population workflow)
