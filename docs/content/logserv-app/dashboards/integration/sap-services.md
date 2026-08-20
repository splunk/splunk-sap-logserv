# SAP Services

![SAP Services](../../../../images/dashboard-sap-services.png)

## :material-circle-box:{ .taiconcolor } Why This Dashboard Matters

The SAP Services dashboard monitors two host-level services that are critical to SAP system availability: **sapstartsrv** (system startup and management) and the **SAP Host Agent** (host monitoring and management). These services operate at the infrastructure layer, below the application, and their failures can prevent SAP systems from starting or being managed remotely. The authentication story is front-and-center here -- sapstartsrv is a common brute-force target, so the dashboard features an SSL-authentication failure panel as the main investigation surface. (SAP Router activity lives on its own [SAP Router](sap-router.md) dashboard.)

## Panels

- **Total Events** -- Aggregate event count across sapstartsrv and saphostexec
- **Auth Failures** -- Count of sapstartsrv authentication failures
- **SSL/TLS Events** -- Count of events involving SSL/TLS negotiation
- **Event Volume by Service (Normal vs Errors)** -- Full-width stacked column chart with four semantic series: sapstartsrv (normal), sapstartsrv (errors), saphostexec (normal), saphostexec (errors). Errors are defined per service: sapstartsrv = failed authentication events; saphostexec = severity ERROR/WARNING.
- **Sapstartsrv Authentication Events** -- Table of authentication attempts showing user, IP, method, and result
- **Host Agent Severity** -- Pie chart of SAP Host Agent log severity distribution
- **SSL Authentication Failure Sources** -- Full-width table aggregating SSL/TLS auth failures by source IP, with failure count, distinct user count, user list, first/last seen, and activity span (hours); the table paginates, and a row click opens the full event set for that IP.

## :material-circle-box:{ .taiconcolor } Where the Data Comes From

- **Summary-backed panels** read the `logserv_sapservices_rollup` KV Store collection — metric
  `main` (service/auth activity over `sap:sapstartsrv` + `sap:saphostexec`) and metric `ssl`
  (SSL/TLS negotiation facts from sapstartsrv). Populated at minute :21 of every hour by
  `logserv_sapservices_aggregate`.
- **The recent authentication events table** is a live listing dispatched against the raw events at
  view time, capped at the 200 most recent matches.

Summary-backed panels switch automatically to their exact raw-equivalent search when the selected window is shorter than 90 minutes, so sub-hour investigation stays real-time. The collection keeps 365 days of hourly history (trimmed by a daily retention search); a fresh install seeds the last 30 days from **Settings → Dashboard Data → Run backfill**. The global **Cloud** dropdown filters the summaries through the `cloud_provider` dimension stored in every rollup row. Full schedule and freshness reference: [Performance & Data Freshness](../performance.md).


## :material-lightning-bolt:{ .taiconcolor } What to Look For

- **Auth failure sources** -- The SSL Authentication Failure Sources table is the primary investigation surface. A single source IP with many distinct usernames is credential stuffing; many sources with a few usernames each is distributed brute-force; long activity spans indicate a persistent (not opportunistic) attacker.
- **Authentication failures from new IPs** -- Any new source IP appearing in the SSL Authentication Failure Sources table should be cross-referenced with your expected SAP admin network. Production sapstartsrv should rarely see failed authentications from unfamiliar ranges.
- **Error stack rising in the volume chart** -- If the error series in the Event Volume chart grows relative to the normal series, something is actively going wrong. Correlate the spike timing with the host agent severity pie to determine which service is affected.
- **Host Agent ERROR severity** -- If the Host Agent severity distribution shifts toward ERROR, the host monitoring infrastructure may be degrading, which impacts central management capabilities.


