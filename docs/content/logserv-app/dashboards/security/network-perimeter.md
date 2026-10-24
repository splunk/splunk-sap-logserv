# Network Perimeter

![Network Perimeter](../../../../images/dashboard-network-perimeter.png)

## :material-circle-box:{ .taiconcolor } Why This Dashboard Matters

Firewall drops, proxy traffic, and DNS queries are three different lenses on the same underlying question: **what is crossing the network boundary and should it be there?** Each lens lives on its own operational dashboard ([Linux](../platform/linux.md), [Proxy Analytics](../platform/proxy.md), [DNS Analytics](../platform/dns-analytics.md)), but an attacker rarely limits themselves to a single surface -- a compromised host often shows up in several of these signals at the same time. Network Perimeter puts the three sources on one dashboard: rejected traffic (firewall drops at the host and in transit), outbound flow (proxy), and resolution activity (DNS), with a dedicated cross-source panel that ranks hosts by combined suspicious-signal score. Use it as the first stop for "is our network perimeter healthy and clean?"

## :material-circle-box:{ .taiconcolor } Requires

- **Sourcetypes:** `linux_secure` (the kernel firewall lines), `squid:access` (its `access.log` lines), and `isc:bind:query` and `isc:bind:queryerror` (the query events, selected with `tag=dns`).
- **Search-head add-ons:** none beyond the LogServ App. The firewall fields are read from the raw `linux_secure` lines, and the Squid and BIND parsing is built into the App.
- **Dashboard Data rows** on **Settings → Dashboard Data**: *Network Perimeter*; *Linux System & Security / Network Perimeter* (for **Firewall Drops in Transit**); and *Beaconing detection (Environment Health / DNS / Network Perimeter)* (for the beaconing panels). Rebuild every row the dashboard reads. On a new install, **Run backfill** there seeds the last 30 days by default (60, 90, 180 or 365 days, or a custom range, are also offered); without a backfill the summary-backed panels fill one hour (the beaconing panels one day) at a time. See [Backfilling on first install](../../dashboard-data.md#backfilling-on-first-install).

## :material-circle-box:{ .taiconcolor } Panels

The title row carries the app-wide **Cloud Provider** picker (All / aws / azure / gcp). Every panel on this dashboard is scoped by it; leave it on **All** unless you are deliberately isolating one ingest channel.

- **Firewall Drops at Host** -- Count of kernel firewall `IN_DROP` events from `linux_secure`: packets addressed to the host itself, dropped by its INPUT chain
- **Firewall Drops in Transit** -- Count of kernel firewall `FWD_DROP` events: packets a host was routing on to another system, dropped by its FORWARD chain. Only hosts that forward traffic, such as VPN or IPsec gateways, log these. Read from the [Linux](../platform/linux.md) dashboard's summary data, so it shows 0, or undercounts, for any period the Linux rollup has not summarised: its aggregation turned off, or those days not backfilled. The row to rebuild in **Settings → Dashboard Data** is *Linux System & Security / Network Perimeter*
- **Proxy Requests** -- Count of HTTP requests handled by Squid
- **DNS Queries** -- Count of DNS query events (`tag=dns`: `isc:bind:query` and `isc:bind:queryerror`)
- **Beaconing Domains** (red) -- Domains exhibiting periodic query patterns (low variance in inter-query interval) -- candidate C2 channels. Beaconing is detected **per UTC calendar day** (a domain's inter-query gaps are analysed within each UTC day, whatever timezone you view the dashboard in), and the KPI is the **sum of each day's distinct beaconing-domain count** over the selected range -- a domain beaconing every day for a week counts 7. Its sparkline has one point per UTC day, and hovering a point shows that UTC date; a UTC day that has not ended yet is drawn at 0 and labelled *not yet computed*. The beaconing panels are refreshed by a daily scheduled search (00:30 search-head local time), so they can lag up to 24 h; the other panels on this dashboard refresh hourly
- **Denied Requests** (orange when non-zero) -- Count of proxy requests with `status=403` or `vendor_action="TCP_DENIED"`; click to drill down. [Proxy Analytics](../platform/proxy.md) counts denied requests by the App's `action="denied"` instead, so the two counts can differ
- **Outbound Bandwidth** -- `sum(bytes_out)` across all proxy requests, formatted KB/MB/GB
- **Perimeter Activity Over Time** -- Full-width column chart of the three sources over time, one bar per source in each time bucket; simultaneous spikes across two or three series are the correlation signal to watch for. Its firewall series is **Firewall Drops at Host**; drops in transit are not charted here. Its DNS series counts `isc:bind:query` only, so it can be lower than the DNS Queries KPI.
- **Blocked Source IPs** -- Every source IP in the firewall log, ranked by **Total** (paginated) and split into **At Host** and **In Transit / Other**, with unique target count and protocols seen; row drilldown to the matching events
- **Blocked Destination Ports** -- All destination ports targeted by firewall traffic, grouped by port + protocol, ranked by **Total** (paginated) and split the same way

    *Both Blocked tables count every firewall event carrying a source IP / destination port. At Host is the `IN_DROP` events among them; In Transit / Other is the rest: nearly all `FWD_DROP`, plus any other firewall line logged with a source or port. ICMP carries no destination port, so ICMP drops appear in Blocked Source IPs but not in Blocked Destination Ports.*
- **Firewall Drops at Host by Protocol** -- Column chart of `IN_DROP` events over time (drops at the host, INPUT chain), one bar per protocol in each time bucket: TCP, UDP, ICMP, and any other protocol the drop lines name. Protocol shifts are often the clearest signal (ICMP spikes = ping flood / recon; UDP spikes = DNS amplification / port scan; TCP spikes = SYN-style port scan)
- **Proxy Denied Traffic Over Time** -- Column chart of denied proxy requests over time -- the outbound complement to the firewall drops
- **Outbound Domains by Volume & Bytes** -- All destination domains receiving outbound traffic, ranked by bytes (paginated), with request count and unique client count. Row drilldown opens the events for that domain.
- **DNS Query Type Distribution** -- Donut of query-type mix (A / AAAA / PTR / TXT / MX / other). High TXT or MX volume from non-mail hosts is a DNS-tunneling / exfiltration indicator.
- **Queried Domains** -- Table (right of the query-type donut) of all queried domains ranked by query count, with unique-client count and per-domain `%TXT` / `%MX` ratios for quick anomaly spotting. Row drilldown opens DNS query events for that domain.
- **Suspicious Activity Indicator** -- Full-width cross-source table of internal hosts appearing in **both** beaconing DNS queries and denied proxy requests, ranked by signal score (`beacon_domains × 3 + denied_requests`). Columns: Host, Beaconing Domains, Beaconing Queries, Denied Proxy Requests, Signal Score. Row drilldown opens the Host Details dashboard for that host (its full cross-sourcetype activity), carrying the current time range.

## :material-lightning-bolt:{ .taiconcolor } What to Look For

- **Correlated spikes across sources** -- The Perimeter Activity Over Time chart is the quickest read on "is something happening right now?" Watch for days when two or three of the series spike together -- that's usually an active event (port scan, active C2, exfiltration window) rather than baseline drift.
- **Protocol shifts in firewall drops** -- The protocol chart of drops at the host is more diagnostic than raw drop counts. A normally TCP-heavy mix suddenly showing tall UDP or ICMP bars signals a different attacker technique.
- **Blocked Source IPs concentration** -- A single source IP generating the overwhelming majority of drops is either a persistent attacker or a misconfigured internal host. Either way, the action is the same: investigate that specific IP.
- **Drops in transit** -- `FWD_DROP` comes only from hosts that route traffic, such as VPN or IPsec gateways. On a gateway it is traffic the forwarding policy does not allow, often a monitoring or discovery job probing the systems behind the gateway, and it can outnumber the drops at the host many times over. Use the In Transit / Other column of Blocked Source IPs to find the source, then allow its traffic or stop the job. Drops in transit on a host that should not route at all mean IP forwarding is switched on there.
- **TXT-heavy queries to a single domain** -- A domain in Queried Domains with a high `%TXT` ratio is a DNS-tunneling pattern. Cross-reference the Suspicious Activity Indicator to see which hosts are issuing those queries.
- **Hosts in the Suspicious Activity table** -- Any non-empty row here is worth investigating. A host showing up in both beaconing DNS and denied proxy is strong evidence of compromise -- the DNS lookups suggest malware C2, and the denied proxy requests suggest the same malware trying to reach blocked destinations.
- **Outbound Bandwidth spikes** -- A sudden rise in the Outbound Bandwidth KPI that isn't matched by a proportional rise in Proxy Requests means individual transfers are getting larger -- often the signature of an exfiltration event.

## :material-circle-box:{ .taiconcolor } Related Dashboards

- [Linux System & Security](../platform/linux.md) -- the full firewall and kernel view of each Linux host.
- [Proxy Analytics](../platform/proxy.md) -- outbound traffic by domain, client and cache action.
- [DNS Analytics](../platform/dns-analytics.md) -- resolvers, clients and the beaconing tables.
- [Host Details](../platform/host-details.md) -- where the Suspicious Activity Indicator rows lead.

??? info "Where the data comes from"
    This dashboard synthesises three perimeter sources, all summary-backed:

    - **`logserv_perimeter_rollup`** (populated at minute :16 of every hour by
      `logserv_perimeter_aggregate`) carries seven metrics: `fw` (firewall actions/sources/ports —
      the `SRC=` / `DST=` / `DPT=` / `PROTO=` fields are extracted from the raw `linux_secure` events at
      aggregation time), `proxy` + `proxydom` (Squid request/denied/bandwidth counts and per-domain
      traffic), `dnscount` + `dnstype` + `dnsq` (DNS query volume, types, and per-query/source counts
      over the `tag=dns` events), and `activity` (the combined activity chart's classification).
    - **Firewall Drops in Transit** reads the [Linux](../platform/linux.md) dashboard's
      `logserv_linux_rollup` collection (metric `kernel`, the kernel tag of every `linux_secure` line
      per hour), because the perimeter `fw` metric does not tell a `FWD_DROP` line from other firewall
      lines. For any period that rollup has not summarised (its aggregation turned off, or those days
      not backfilled) it shows 0 or undercounts. The row to rebuild in **Settings → Dashboard Data** is
      *Linux System & Security / Network Perimeter*.
    - **The beaconing panels** read the daily collections: `logserv_beaconing_rollup` (00:30) for the
      KPI and `logserv_beaconing_detail_rollup` (00:32, metrics `qs` + `denied`) for the suspicious
      activity detail — daily cadence because the gap-variance detection needs a day of
      inter-arrival history, so these panels update once per day rather than hourly.

    The hourly summary-backed panels switch automatically to their exact raw-equivalent search when the selected window is shorter than 90 minutes, so sub-hour investigation stays real-time; the beaconing panels always read their daily summaries. Each collection keeps 365 days of history (trimmed by a daily retention search). The global **Cloud** dropdown filters the summaries through the `cloud_provider` dimension stored in every rollup row. Full schedule and freshness reference: [Dashboard Data: Backfill and Freshness](../../dashboard-data.md).
