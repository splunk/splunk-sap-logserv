# Environment Topology

![Environment Topology](../../../images/dashboard-environment-topology.png)

### :material-circle-box:{ .taiconcolor } Why This View Matters

The Environment Topology view answers a question every SAP administrator has: *"what's actually talking to what?"* Traditional dashboards show events, errors, and aggregates per source — but the **shape** of how SAP systems integrate with each other (RFC partners, HANA tenant relationships, web traffic boundaries, cross-zone connections) is hidden in those tabular surfaces. This view materializes that shape as an interactive graph drawn from your existing log data — no new ingest, no CMDB integration, no tagging effort required.

Use it to:

- Validate that your topology matches the as-designed architecture (every system shows up; no rogue partners are talking inbound).
- Investigate a single SID's call surface — who calls it, what does it call, where are the errors concentrated?
- Drill from an edge (a single integration relationship) into the raw events with one click — every edge carries a denormalized SPL filter expression so you can pivot to Splunk's universal search instantly.
- Onboard a new analyst by giving them a one-page picture of the SAP landscape before they start digging into individual dashboards.
- Spot orphaned IPs / hosts that don't belong to any known SID — these are typically misconfigured load balancers, scanners, or unauthorized integration partners.

This view replaces the manual hand-drawn architecture diagrams that SAP admin teams typically maintain in slides or wikis. Because it's data-driven, it stays current as systems are added or retired.

### :material-circle-box:{ .taiconcolor } What's on Screen

The view is laid out in four regions:

**Top toolbar** — the layout-mode dropdown (Force / Layered / Tree), Refresh button (re-runs the KV Store fetch while preserving saved positions), Save Layout, Load Layout dropdown with the ⚙ Manage Layouts entry, Snap mode toggle, the saved-layout name chip showing what's currently loaded, a Saved/Unsaved-changes indicator next to it, and a legend row of colour swatches — one per integration type, matching the edge colours on the canvas.

**Left sidebar** — two stacked panels. The **Systems · Integration** panel rolls up the inventory (systems, total calls, partner count) and lists each SAP system with a per-system call-volume bar; **High Traffic** systems (see below) render highlighted. The **Integration types** panel is a checkbox list of the eight tracked integration types (RFC sync, iDoc async, qRFC, tRFC, bgRFC, Web service / SOAP, OData / Gateway, BTP iFlow / CPI) — un-ticking a type dims its edges in the canvas without removing them.

**Center canvas** — the interactive graph itself, rendered with [`@xyflow/react`](https://reactflow.dev/){:target="_blank" rel="noopener noreferrer"}. Nodes:

- **High Traffic SIDs** — the five SAP systems with the most total calls touching them (inbound + outbound + bidirectional) in the visible window, ranked at render time. There is no configured focus list — the ranking is purely data-derived, and only SAP systems compete for the five slots (a high-volume client IP cannot occupy one). On an estate with five or fewer systems, every SID is High Traffic.
- **Regular Traffic SIDs** — every other internal SAP system. Same large circle and health halo as High Traffic; the kinds differ only in the panel's Kind row and the Systems-panel highlight.
- Every SAP system circle carries an **interior icon**: an app-server rack for application systems, a database cylinder for database systems.
- **HANA tenant databases** — full-size circles with a combined app-servers + database icon, tagged "APP SERVERS - HANA TENANT" (chip: "HANA TENANT"). A tenant is a logical database inside a HANA system, named after the application SID it backs — its circle deliberately shares that name.
- **DB-tagged partners** — circular discs with a cylinder icon when the partner is a database vendor (HANA, Oracle, MSSQL, Postgres, DB2). HANA systems specifically are tagged when their SID appears as a `sap_sid` clause on a `hana_tenant`-type edge — distinct from HANA tenants (which are logical databases inside a HANA system, named after the application SID they back).
- **Other partners** — rounded squares for non-DB external endpoints (web partners, gateways, generic IPs).

**IP-labeled squares can carry name lines.** When the logs themselves identify the machine or the people behind an IP endpoint, the square renders up to two extra lines directly under the IP: the **hostname**, and a **user line** (the user name when exactly one distinct user was seen; a count like "7 users" otherwise — hover the line for the full list). The evidence comes from four same-event sources, refreshed daily into the `logserv_topology_ip_enrichment` KV Store collection: HANA audit client registrations (`client_ip` + client host name + `executing_user`), Windows successful-logon events (4624 — `IpAddress` + `WorkstationName` + `TargetUserName`), SAP start service authentication lines (`auth_user` + remote address) and Linux `sshd` session lines. Two honesty rules govern what renders: a hostname shows **only when it is unambiguous** — the IP must map to exactly one machine name (a short name and its FQDN count as one), and that name must not be claimed by a crowd of IPs — and nothing is ever guessed (gateway logs, for example, record partner hostnames and peer IPs on *different* lines, so they are deliberately not correlated). The names are **"latest known"** rather than time-range-scoped: they do not blink out when you narrow the picker, and the Details panel's "Names as of" row tells you how fresh the mapping is.

Each SID and DB partner carries a **3-segment health ring** painted around its perimeter, showing the proportion of normal (green) / warning (orange) / error (red) calls in the visible time window. Non-DB partners (the rounded squares) carry an equivalent rounded-square perimeter outline. Nodes with no calls or with all calls in a single bucket render as a **solid full ring** in the dominant color (a healthy node with all-normal calls shows a solid green ring; an idle node still shows green so you can tell the canvas painting succeeded). The classification: edges with errorRate < 10% route their errors to the warning bucket; edges with errorRate ≥ 10% route to the error bucket; everything else is normal. HANA-tagged nodes additionally route `WARNING`-severity events and slow tenant SQL queries (`hana_op_duration_ms > 1000`) into the warning bucket as a vendor-specific health signal — these counts are first-class fields on the edge bucket rows, computed at hourly aggregation time from `sap:hana:tracelogs`.

**Edges** render as gently bowed curves drawn center-to-center between nodes and clipped at each node's visible boundary — arrowheads land on the health ring / outline outer edge rather than inside the node. When two systems call each other in both directions, the two edges bow apart so each direction stays separately visible and clickable. Edge labels sit at the curve's apex.

**Right sidebar (selection-driven)** — what shows here depends on whether you've selected a node or an edge.

When a **node** is selected, four tabs surface that node's per-selection context:

- **Overview** — a facts table, an hourly call-volume chart, and the partner breakdown. The facts table splits the node's calls three ways — **inbound**, **outbound** and **bidirectional** — alongside the total, using exact figures so they reconcile against everything below them. On SAP system and tenant nodes it also shows **"Hosts (in range)"** — the distinct hosts that logged the node's events in the window, the same figure the Hosts tab's caption reports (both read the same hourly rollup; on a tenant node the count is scoped by the shared name and the panel says so inline). The same number appears as a **Hosts** row in the hover tooltip on SAP system circles. On IP-labeled partner squares with name evidence (see *IP-labeled squares can carry name lines* above), the facts table adds **Hostname** (with its evidence source), **Users** (every user seen from that address, grouped by source) and **Names as of** rows directly under the Tag row. The call chart is hardcoded to the last 24 hours regardless of the global time-range picker (its purpose is "what's happening RIGHT NOW on this node," not "what happened over the picker's window"). For HANA-tagged nodes, an additional roll-up section shows tenants list, tenant SQL ops, p95/max SQL duration, and auth success/fail counts — derived from incident edges in JS, no extra SPL.

    Beneath those sit **two partner donuts**: partners that call this system, and partners this system calls. Each lists **every** partner — there is no "other" bucket and the legend is not capped, so a system with a wide fan-out makes the panel taller rather than the list shorter. Edges the data records as *bidirectional* (HANA Tenant traffic) are counted on their own line instead of being assigned a direction the stored row denies. Legend rows show the endpoint and its call count. (Inventory *ownership* badges render where ownership can actually vary — the Hosts tab rows and the Edge Details "By app server" table; see [Self-Derived IP→SID Inventory](#self-derived-ipsid-inventory).)

    **Hover any slice** (or its legend row) for that endpoint, its exact call count, and its share of the chart's total. Reach for it whenever a slice is small: a slice too small to survive its own outline is drawn slightly larger so it stays visible, so the *angle* of the smallest slices is approximate while the number in the tooltip is exact. The panel says so inline whenever that widening has actually been applied.

- **Top Programs** — the top ABAP programs seen on this node, from `sap:abap:icm`'s `icm_program` field (top 8). RFC functions, HANA actions, and web URIs are not in this tab — they surface per-edge on the Edge Details **Operations** tab.
- **Errors** — categorized error breakdown for the node (HTTP 4xx/5xx, severity ERROR / CRITICAL / FATAL, gateway `gw_error_detail` and `error_function`). Aggregated by sourcetype + error_kind.
- **Hosts** — two tables. The first lists the hosts that logged events for this system, with first-seen / last-seen / `dc(sourcetype)` per host — and, where the events carry them, the SAP **instance numbers** seen on that host (`inst 00, 01`) — and — on a SAP system node — an ownership verdict per row. The read returns the 100 busiest hosts; if a system has more, the panel says so rather than presenting the cap as the count.

    The second, **Calls by host and edge type**, breaks the node's traffic down per receiving host. A row names a host only where the data supports one: a hostname is only ever the *receiving* end of a call, so per-host rows are always inbound, and everything else — calls this node makes, and traffic recorded against a system as a whole — appears as an edge-type row. Because every incident edge lands in exactly one row, the column sums to the **Total calls** figure on the Overview tab, which makes it checkable. Note that its `Calls` column counts edge calls while the `Events` column in the table above counts log events, from a different rollup — the two are not the same measure.

When an **edge** is selected, five tabs surface that edge's per-call context:

- **Overview** — endpoint cards (source / direction / target), pre-computed aggregates (call count, error count, error rate, sourcetype), and an inline activity trend chart. **RFC edges add a "By app server" table** splitting the edge's calls and errors by the SID-side gateway listening address each call was recorded against, with inventory owner badges — the app servers as the gateway log names them, not a full instance inventory. The rows partition the edge's calls, so they sum to the *Calls in window* fact above them.
- **Activity** — full-width stacked-area chart of successful calls + errors over the visible time window. Computed in the browser from the same hourly rows that produce the Overview totals, so the two always agree.
- **Operations** — donut chart of the top 10 entities for this edge type (HTTP URIs, RFC programs, HANA actions, HANA trace components).
- **Performance** — for HTTP edges, latency percentiles (P50 / P95 / Max) and bytes-out plus a per-status-class call-count histogram. For HANA Audit, cached auth success / auth fail headline counts plus a dispatched action-status mix. For HANA Tenant, a cached p95 + max SQL-duration headline (the p95 is a call-weighted blend of the per-hour p95s stored on the edge rows — an approximation), and below it a dispatched **avg + max** chart: true percentiles cannot be merged across hourly buckets, so the chart reads mean and maximum and says so inline. RFC edges have no performance histogram: ICM task counts are not present on gateway events.
- **Errors** — the top 15 failure modes with `error_kind`, `error_detail`, count, and last-seen timestamp. For HANA Audit this covers **all** unsuccessful operations, which is broader than the Overview row (labelled "Auth failures (CONNECT)") directly above it.

!!! note "Tabs that are legitimately empty"
    Not every tab has content for every edge type — an empty tab is not necessarily a fault. **RFC** edges have no Operations or Performance rows at all (`icm_program` and `icm_tasks` are absent from `sap:abap:gateway` events), and any edge type can have an empty Errors tab simply because nothing failed. The pane distinguishes the two cases: when a tab was queried and came back empty it says so, and when nothing could be queried at all it says *that* instead.

Selection is **mutex** — clicking a node clears any selected edge and vice versa, so the right pane never shows mixed context. Clicking empty canvas (the pane) clears both. Each side preserves its own preferred tab independently when you swap between selections. (This *inspection* selection — the cyan glow plus the Details panel — is separate from *group membership* below, which uses a dashed outline: a node can be inspected, in a group, both, or neither.)

### :material-circle-box:{ .taiconcolor } Group select and move

Hold **Shift and drag** on empty canvas to draw a selection box: every node the box touches joins the group and gains a **dashed outline**, and a status chip at the canvas top-right shows the count. Then **drag any highlighted node** to move the whole group rigidly — relative positions are preserved, and the edges follow their nodes (an edge has no position of its own, so moving the nodes *is* moving the edges; edges are not independently selectable). The gesture set:

- **Shift + drag** on empty canvas — draw the selection box (plain drag still pans).
- **Shift / Ctrl / Cmd + click** a node — add it to or remove it from the group (these clicks never open the Details panel).
- **Plain click** any node — inspect it in the Details panel and release the group.
- **Escape** or a click on empty canvas — clear the group.
- **Drag a highlighted node** — move the whole group. Dragging a node *outside* the group releases the group and moves only that node.
- **Arrow keys** (with a focused, selected node) — nudge the whole group.

With **Snap mode** on, releasing a group drag applies *one shared* grid offset to every member, so the group's shape is preserved — members are not rounded to the grid independently. Group moves mark the layout **Unsaved** and are captured by **Save Layout** exactly like single-node drags. The group survives data refreshes and time-range changes; it clears when the node set itself changes (a layout-mode switch or loading a saved layout).

**Bottom panel** — Live Activity table showing the eight busiest integration edges (any type) by call count for the current time range. The panel fills its allotted height exactly — the partners table scrolls internally under a sticky header when it outgrows the panel, so the panel frame always closes cleanly. Drag the divider above the panel to resize it (120–640 px, persisted with saved layouts); expanding the collapsed panel restores at least the 300 px default height. Collapsing or expanding the panel automatically re-fits the graph so it claims (or yields) the freed vertical space.

**MiniMap** (bottom-right of the canvas) — drag the cursor inside the minimap to pan the main canvas. Direction follows the cursor: dragging right → main canvas shows more right-side content; dragging down → shows more bottom content. Magnitude is proportional to your cursor delta scaled by the minimap's viewBox-to-pixel ratio. Single-click does nothing — drag-to-pan is the only minimap interaction.

### :material-circle-box:{ .taiconcolor } Where the Data Comes From

The view reads from a **time-bucketed KV Store** fed by hourly scheduled saved searches. (An earlier design ran six SPL searches on demand every time the view opened, which produced a 5–15 second page load on busy Splunk instances; the data layer was rewritten to the KV Store design described here.)

| KV Store collection | Schema | Populated by |
|---|---|---|
| `logserv_topology_nodes` | one row per (canonical entity, hourly bucket); 10 fields including `event_count`, `last_seen` | `logserv_topology_aggregate_nodes` (hourly cron `5 * * * *`) |
| `logserv_topology_detail_rollup` | one row per (metric, scope, hourly bucket); powers the right pane's per-node and per-edge tabs. Edge metrics (`edge_op` / `edge_perf` / `edge_err`) are keyed by the same stored edge id as `logserv_topology_edges.id` | `logserv_topology_detail_aggregate` (hourly cron `8 * * * *`) |
| `logserv_topology_edges` | one row per (edge, hourly bucket) — RFC edges one row per (edge, app-server `local_ip`, hourly bucket), so multi-app-server call counts stay exact; 22 fields including pre-computed `response_time_p50` / `_p95` / `_max`, `hana_op_p95_ms` / `hana_op_max_ms`, `auth_success_count` / `auth_fail_count`, `error_count`, `warning_count` (`icm_tasks_max` / `icm_tasks_avg` are declared but not currently populated), plus canonical `spl_sourcetype` + `spl_filter_clauses` for right-pane drilldowns | `logserv_topology_aggregate_edges` (hourly cron `6 * * * *`) |
| `logserv_topology_inventory` | flat (no bucket dimension), keyed by canonical_value; IP / host → SID mapping for retargeting raw IPs to their owning SID node | `logserv_topology_aggregate_inventory` (hourly cron `7 * * * *`) |
| `logserv_topology_ip_enrichment` | flat (no bucket dimension), keyed by `<ip>:<evidence_source>`; hostname + user names behind IP endpoints | `logserv_topology_enrichment_aggregate` (daily cron `32 2 * * *`) |

Retention searches keep the KV Store sized: `logserv_topology_retention` (daily, `34 0 * * *`) and `logserv_topology_detail_retention` (daily, `50 1 * * *`) each trim to 365 days of bucket history, and `logserv_topology_enrichment_retention` (daily, `34 2 * * *`) trims enrichment rows unseen for 365 days. The `logserv_topology_backfill_*` searches (disabled by default) let an admin re-populate the 30-day window after a fresh install via Settings → Dashboard Data.

The aggregation searches read from these SPL sources:

| Source | What it contributes |
|---|---|
| `sap:abap:gateway` | RFC peer/local IPs (`P=<peer>` / `L=<local>` fields). The local IP is canonical for IP→SID inventory because it always belongs to **this** host's SID. |
| `sap:abap:icm` | ICM peer/local IPs for HTTP-side traffic. |
| `sap:hana:tracelogs` | HANA host + tenant SID extracted from the source path (`/usr/sap/<HANA_SID>/HDB<inst>/<host>/trace/DB_<TENANT_SID>/`). Yields the rich HANA-side topology including multi-tenant relationships. |
| `sap:webdispatcher:access` | HTTP client IP → web-server host edges (`clientip` / `host` / `uri` / `status`). The source of every HTTP edge and its status-class distribution. |
| `sap:hana:audit` | HANA authentication edges (`client_ip` → HANA host) with auth success/fail counts; also feeds the IP-node name enrichment (client hostname + executing user). |
| `XmlWinEventLog` / `sap:sapstartsrv` / sshd session lines | IP-node **name enrichment** only — the daily pass that puts a hostname / user line under unresolved IP squares. |
| Default Splunk `host` field (cross-source fallback) | Picks up hosts that aren't surfaced in the above. |

When you open the view, the React app fetches a time-window slice of these collections via the Splunk Web REST proxy (`/en-US/splunkd/__raw/servicesNS/nobody/<APP>/storage/collections/data/<NAME>?query={"bucket_ts":{"$gte":...,"$lte":...}}`). The fetch returns in well under a second on production-scale data — orders of magnitude faster than the legacy on-demand path. Clicking an edge dispatches three small searches against the hourly `logserv_topology_detail_rollup` — Operations, Performance and Errors — scoped by the stored edge id(s) behind the edge you clicked. Overview and Activity need no search at all: both are derived from the rows already in the browser. Because inventory retargeting can collapse several stored edges into one you see on the canvas, those three reads cover the whole set, and say so if an edge ever spans more than one.

### :material-circle-box:{ .taiconcolor } Self-Derived IP→SID Inventory

The "which IP belongs to which SID" mapping isn't read from a CMDB or an admin-maintained lookup — it's **self-derived from the same logs you're already ingesting**. The mechanism is a multi-source `union` SPL with a `mvcount(sids)=1` filter: a host whose multiple sourcetypes all agree on a single SAP SID is unambiguously attributed. An endpoint that fails that test simply gets **no inventory row** — nothing is written to record the ambiguity.

Coverage depends on what your data exposes — unique hostname/IP appearances across multiple SAP sourcetypes attribute cleanly, while shared NAT IPs and external partners typically have no row at all (their SAP affiliation isn't observable from logs alone, or they legitimately don't belong to any single SID).

!!! note "Reading the ownership badges — and why an address on a system's panel is never one of its own"
    An address the inventory has attributed to a system is **drawn inside that system's node**: the view folds it in before the graph is laid out. So an address you can still see as a separate endpoint is one no system has claimed — which makes **`owner not established` the expected verdict on the partner donuts**, not a data-quality alarm. On the Hosts tab, where hosts are listed by name rather than folded away, both verdicts occur.

    "Owner not established" means the inventory has not yet seen that host or address carrying exactly one SAP system identifier. There are several reasons it might not have: the host may serve more than one system, it may emit no system identifier at all, two attribution sources may disagree, or it may simply not have been observed since the collection was populated. The panel deliberately does not guess between them.

    One scope caveat the panel states inline: **ownership is not limited to the selected time range.** The inventory accumulates across all observed history, so a badge on a 24-hour view can reflect an attribution learned earlier.

In addition to the inventory, the node-aggregation SPL captures every distinct edge endpoint as a node row in its own right — webdispatcher `clientip`, ABAP gateway `peer_ip`, and HANA Audit `client_ip` (excluding loopback). This means external partners that appear only on the receiving side of integration edges still carry real event counts, not zero, even when they don't have a SID resolution in the inventory.

The inventory itself is extensible per-customer without new ingest: appending another `union` arm to the inventory aggregation SPL adds a new attribution source. Future arms could include ICM `icm_peer_ip`, additional CMDB-style lookup tables, or any other field that uniquely associates an IP / host with a SAP SID.

### :material-circle-box:{ .taiconcolor } Layout Modes

The LAYOUT dropdown switches between three layout algorithms:

- **Force** — a d3-force **star-system** arrangement: every high-traffic hub (focused SIDs, plus any secondary SID with enough leaf partners of its own) gets a proportional horizontal slot, its partners ring around it at a radius scaled to partner count, and smaller secondary systems anchor as satellites fanned around their nearest hub. The layout is deterministic — the same data renders the same picture on every load — and the graph world sizes itself to the canvas aspect ratio. Best for hub-and-spoke SAP landscapes; the default for first-time viewers.
- **Layered** — ELK Sugiyama-layered top-to-bottom flow with orthogonal edges and near-zero edge crossings. Best for traffic-flow analysis where you want to see "what flows into what" structurally.
- **Tree** — ELK mrtree classic top-down tree with hubs at top and spokes radiating downward. Best when the topology is approximately hub-and-spoke shaped.

Both ELK-based modes (Layered + Tree) share the same lazy-loaded elkjs chunk, fetched only when you first pick a Layered or Tree layout, so adding Tree mode after Layered shipped was a near-zero-cost extension. Force mode remains synchronous (no bundle hit on initial load).

Each layout mode has its own **saved-layout slot** — saving a layout in Force doesn't bleed into Layered or Tree. Switching layouts via the LAYOUT dropdown drops the current saved-positions cache so each mode renders fresh from its own algorithm. The Manage Layouts modal (⚙ entry at the top of the Load Layout dropdown) lets you set a per-mode default layout that auto-loads on mount.

### :material-circle-box:{ .taiconcolor } Saved Layouts

User-arranged graph layouts are persisted in Splunk KV Store collection `logserv_topology_layouts`. Each saved layout carries:

- **Layout mode** — Force / Layered / Tree (so a Force-saved arrangement loads back in Force mode, not Layered)
- **Node positions** — where you've manually placed each node on the canvas
- **Panel state** — sidebar tab + width
- **Viewport** — zoom level + pan offset (x, y)
- **Enabled integration types** — which checkboxes are ticked on the leftbar
- **Selected node / edge** — what was selected when you saved
- **Active right-sidebar tab** — Overview / Top Programs / Errors / Hosts (node mode) or Overview / Activity / Operations / Performance / Errors (edge mode)
- **Snap mode** — whether new nodes snap to a grid

Layouts are saved per-user-named — you can save your own variants ("focus on XCQ", "all DBs", "external partners only") and switch between them from the Load Layout dropdown.

The **Manage Layouts modal** (⚙ entry at the top of the Load Layout dropdown) is where two cross-browser preferences live:

- **Per-mode default layout** — pick one saved layout per mode (Force / Layered / Tree) to auto-load on mount when you're using that mode. Each mode section in the modal has its own radio list of mode-matching layouts plus a "(no default)" option.
- **Default layout mode** — tick the *Open in this mode by default* checkbox on one of the three sections to declare which mode the dashboard should open in on next login. The checkbox is mutex across the three sections (or none — "no explicit default" leaves the dashboard opening in Force mode). Ticking the checkbox also switches the active mode immediately so you can see what the default-on-next-login experience will look like.

Both preferences are persisted to Splunk KV Store keyed by Splunk username (collections `logserv_topology_layout_defaults` and `logserv_topology_active_mode`). Browser `localStorage` is used as a fast-mount cache mirror, so on a fresh browser the choices hydrate from KV Store on first paint. If you pick defaults in Chrome and open the topology in Firefox, you'll see the same defaults the next time you log in to the same Splunk instance. When no defaults are stored, the dashboard opens in Force mode with no auto-loaded layout.

### :material-circle-box:{ .taiconcolor } Data Refresh Cadence

The topology data layer is **populated by four hourly scheduled saved searches plus one daily enrichment pass**, all writing to the KV Store:

- `logserv_topology_aggregate_nodes` — cron `5 * * * *`, rolls up event activity per (canonical entity, hour bucket)
- `logserv_topology_aggregate_edges` — cron `6 * * * *`, rolls up call counts + per-type aggregates (HTTP latency, RFC saturation, HANA SQL latency, etc.)
- `logserv_topology_aggregate_inventory` — cron `7 * * * *`, rebuilds the unambiguous IP/host → SID mapping
- `logserv_topology_detail_aggregate` — cron `8 * * * *`, precomputes the per-node / per-edge detail-tab rows
- `logserv_topology_enrichment_aggregate` — cron `32 2 * * *` (daily), recomputes the IP-node hostname/user name lines over the last 30 days

So the KV Store gets a new hourly bucket in the first minutes of each hour. The view re-reads the KV Store:

- On initial page load
- On global TimeRange picker change
- When the user clicks the toolbar's **Refresh** button (useful right after dispatching a backfill saved search)
- When the user selects a different node (dispatches on-demand reads against the hourly `logserv_topology_detail_rollup` KV Store collection — same data layer, dispatched per selection rather than at page load)

There is **no client-side auto-polling**. An earlier Live | Lookup mode toggle polled every 30 seconds — a leftover from the original on-demand SPL data layer; it was removed once the data layer moved to hourly KV Store aggregation, because ~119 of every 120 ticks returned byte-identical data. The hourly cron is what governs data freshness now; tightening the cron schedule (e.g., to `*/15 * * * *`) is the right lever if a customer needs sub-hour data freshness, at the cost of more search-job dispatches.

### :material-lightning-bolt:{ .taiconcolor } What to Look For

- **Health rings with prominent orange or red segments** — a SID showing >25% red (error bucket) is a system whose external integrations are systematically failing. Click into the node and the Errors tab to see which specific edges are degraded.
- **Unattributed endpoints with high edge weight** — an IP or hostname square carrying hundreds of calls but no inventory owner. Open it and check the Hostname / Users rows: a machine with no SAP identifier and heavy inbound traffic is either a shared NAT / load-balancer address or an integration partner nobody documented. Both warrant investigation.
- **Asymmetric edge counts** — an edge showing many calls one direction but very few the other usually means one side is the caller (RFC client) and the other is the callee (RFC server). Use the Operations tab to confirm which.
- **Orphan SIDs** — a node with no edges is a system that's running but not integrated with anything else. May be a quiet test system, or a system whose integration partners aren't monitored.
- **HANA tenants drifting from their HANA system** — multi-tenant HANA produces edges from the parent system to each tenant. Missing tenant edges indicate either tenant outage or audit-log gap. The HANA-tagged DB partners specifically use slow tenant SQL queries (>1000 ms) as a warning signal; a tenant lighting up with orange in its ring after a deploy points at slow-query regressions.
- **Unexpected external partners** — IP-labeled squares with no inventory owner and inbound edges into a production SID are the strongest signal of an undocumented external integration. Use the name lines under the square (hostname / user, where the logs carry them) and the Details panel's endpoint facts to identify the caller.
- **Edge errors clustered on one sourcetype** — clicking an edge and reading the Errors tab can reveal that 90% of failures are 4xx (client-side, not your problem) vs 5xx (server-side, your problem). The status-class breakdown is pre-aggregated hourly into the detail rollup, so clicking through to the Performance tab is a small keyed lookup rather than a scan of raw web-server events.
- **Host counts on the Hosts tab** — a SID showing 3 hosts when you expected 2 may indicate a stale forwarder / VM that should have been decommissioned. A row badged with a *different* system's name is worth a look on its own: it usually means a shared forwarder, or a management host running commands against this system from elsewhere.
- **A lopsided pair of partner donuts** — a system that receives heavily but calls almost nothing (or the reverse) is a useful shape to notice: it separates the integration hubs from the leaf consumers, and a system that has quietly stopped calling out shows up here before it shows up in an error count.

### :material-circle-box:{ .taiconcolor } Notes

- The view's route is `#/topology/integration-topology` — the slug stayed `integration-topology` when the user-visible label changed from "Integration Topology" to "Environment Topology", so existing bookmarks and saved-layout records remain valid.
- Layout persistence works across browser tabs and across Splunk Web sessions — your KV Store records survive Splunkd restarts.
- Layouts are saved **per Splunk user** — every KV Store record is keyed by `<username>::<slug>`, so different users have completely separate records and can't overwrite each other's layouts. If the same user edits the topology in two browser tabs concurrently, the tabs race each other and last-tab-save wins (multi-tab edit-collision protection is planned for a future release).
- The minimap supports drag-only panning. Single-click and scroll-zoom inside the minimap rectangle are intentionally inert — drag is the one interaction.
- RFC rollup rows are keyed per SID-side app server (`local_ip`) since the per-app-server upgrade. Installs upgrading from an earlier release need a one-time **Clear + Backfill** of the "Environment Topology (graph)" rollup (Settings → Dashboard Data) — see the [release notes](../../overview/release-notes.md) for why, and for the RFC-only migration that preserves graph history older than the 30-day backfill window.


