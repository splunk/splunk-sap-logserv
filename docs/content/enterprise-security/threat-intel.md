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
| `splunk_sap_logserv_es_ti_dns_to_malicious_domain` | `isc:bind:query` ↔ `logserv_ti_malicious_domains` | high | hourly |
| `splunk_sap_logserv_es_ti_proxy_to_malicious_ip` | `squid:access` ↔ `logserv_ti_malicious_ips` | high | hourly |
| `splunk_sap_logserv_es_ti_compromised_credential_use` | `sap:hana:audit`, `sap:abap:audit` and `sap:sapstartsrv` events that carry a user name ↔ `logserv_ti_compromised_credentials` | critical | hourly |

The compromised-credential search does not limit itself to logins: it takes any event of those three sourcetypes, reads the user from `executing_user`, `user` or `src_user` (the first that is set), lowercases it and looks it up.

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
2. End the SPL with `| outputlookup override_if_empty=false logserv_ti_malicious_domains` to overwrite the file. Without `override_if_empty=false`, Splunk deletes the file when the search returns no rows — so a run during an outage of your TI connector would empty the list; with it, an empty run leaves the previous list in place.
3. Schedule the saved search at whatever cadence matches your feed (hourly, daily, etc.).

The customer owns the upstream connector; the LogServ App only reads the lookup.

### :material-crop-square:{ .taiconcolor } 3. Threat-intel framework (Splunk ES Threat Framework)

If you have ES installed, the ES Threat Framework already maintains its own consolidated threat-intel KV Store collections. Bridge those to the LogServ-side lookups via a saved search of your own. The names of ES's threat-intel lookups and their fields depend on your ES version and configuration, so look them up first (the ES documentation, or **Settings → Lookups → Lookup definitions** on the ES search head). In this template, replace each `<...>` placeholder with the name from your ES:

```spl
| inputlookup <ES lookup that holds domain indicators>
| rename <ES domain field> AS domain, <ES description field> AS notes
| eval category="<category>", source="splunk-es-threat-framework", added_date=strftime(now(), "%Y-%m-%d")
| table domain category source added_date notes
| outputlookup override_if_empty=false logserv_ti_malicious_domains
```

This sets `added_date` to the day of the copy. If your ES lookup has a time field for each indicator, use it there instead, and add a filter (`| where ...`) if you want only some of the indicators.

## :material-circle-box:{ .taiconcolor } Tuning + maintenance

- **Stale indicators.** Indicators older than ~30 days have a higher false-positive rate (the upstream threat may already be remediated). Periodically prune them with `| inputlookup logserv_ti_malicious_domains | where strptime(added_date, "%Y-%m-%d") >= relative_time(now(), "-30d") | outputlookup override_if_empty=false logserv_ti_malicious_domains` (and the same for the other two lists) to overwrite each list with a freshness-filtered view. `added_date` is a date string, so convert it with `strptime` before comparing it with a time; this form expects `YYYY-MM-DD`. (With the flag, a prune that would remove every indicator leaves the list as it is; to empty it on purpose, upload a header-only CSV as in workflow 1.)
- **Upgrades.** The three lists ship in the App's `lookups/` directory as header-only files, so an upgrade that installs the package may replace rows you added. As a precaution, export a list you maintain by hand (workflow 1, or a one-off `outputlookup`) before upgrading and re-upload it afterwards; a list written by a recurring saved search (workflow 2 or 3) is refilled on its next run. See [Upgrading](../getting-started/upgrading.md).
- **Source weighting.** If a particular `source` produces too many FPs, pre-filter at lookup-write time so it never reaches the correlation search. A source that produces TPs reliably can be tagged as such in the `notes` field for SOC analyst context.
- **Custom domains.** The `domain` column accepts FQDNs. Wildcard domain patterns (e.g., `*.evil.com`) do not match as shipped, because the lookup definition matches exactly (case-insensitive). For wildcard support, give the lookup definition a wildcard match type (`match_type = WILDCARD(domain)` on its `transforms.conf` stanza; in Splunk Web, edit the lookup definition `logserv_ti_malicious_domains` under **Settings → Lookups → Lookup definitions** and set the same match type in its advanced options), or write your own detection that uses regex matching against the lookup contents.

## :material-circle-box:{ .taiconcolor } AI Assistant integration

Each of the 3 TI correlation searches has a corresponding entry in the AI Assistant predefined-prompt catalog:

- `security.ti_dns_to_malicious_domain`
- `security.ti_proxy_to_malicious_ip`
- `security.ti_compromised_credential_use`

Once an admin has turned the AI Assistant on (it ships turned off; see [Set Up the AI Assistant](../ai-assistant/enable.md)), SOC analysts can dispatch them on demand from the AI Assistant's predefined-prompt browser → Security pack → **TI: DNS query to malicious domain** (and siblings). A prompt fails while its saved search is disabled. Natural-language routing ("Show me TI hits across DNS in the last hour") requires the free-form path, which activates once an LLM provider credential is configured; without one, dispatch is via the prompt browser only.

## :material-circle-box:{ .taiconcolor } Verifying the lookups loaded correctly

After installing or upgrading the LogServ App, verify the 3 TI lookups are queryable:

```spl
| inputlookup logserv_ti_malicious_domains | head 5
| inputlookup logserv_ti_malicious_ips | head 5
| inputlookup logserv_ti_compromised_credentials | head 5
```

Each should return 0 rows (the lookups ship empty). The fact that the queries DISPATCH cleanly without "lookup table not found" errors confirms the transforms.conf wiring is correct.

## :material-circle-box:{ .taiconcolor } See also

- [Correlation Searches & RBA](correlation-searches.md) — Full list of the correlation searches across the App
- [Behavioral & Anomaly Detections](behavioral-detections.md) — Statistically-baselined detections that complement TI matching
- [Asset & Identity Feed](asset-identity-feed.md) — Customer-managed asset and identity context (similar customer-side population workflow)
