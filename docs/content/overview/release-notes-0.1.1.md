# Release Notes: 0.1.1

This page lists what changed in the 0.1.1 line of Splunk for SAP LogServ, newest first. The 0.1.1 line was frozen on 2026-09-18, at App build 335, and receives no further changes; its work continues in [0.1.2](release-notes.md). To upgrade from a 0.1.1 build, follow [Upgrading to This Release](../getting-started/upgrading.md).

## :material-circle-box:{ .taiconcolor } Compatibility

|                                  |                              |
|----------------------------------|------------------------------|
| Splunk platform versions         | 9.4.3 and later              |
| CIM                              | 5.0.0 and later (per `app.manifest`) |
| Supported OS for data collection | Platform independent         |
| Vendor products                  | SAP LogServ for SAP ECS in Amazon Web Services (AWS), Microsoft Azure, and Google Cloud Platform (GCP) |
| Published App artifact           | The **full-LLM build variant** — the free-form LLM path is present but inert until an LLM provider credential is configured; predefined prompts + MCP dispatch work with no credential (see [Restricting the LLM Path](../ai-assistant/templates-only-build.md)) |
| AI Assistant prerequisite        | [Splunk MCP Server (Splunkbase App 7931)](https://splunkbase.splunk.com/app/7931) v1.0.3 or later and below v3.0.0 — the 2.x major is supported as of App build 335; v1.1.0+ recommended — on the search head where the LogServ App is installed |
| Azure ingest                     | A dedicated first-party add-on — **Splunk TA for SAP LogServ on Azure** (`splunk_ta_sap_logserv_azure`), installed per heavy forwarder |
| GCP ingest                       | A dedicated first-party add-on — **Splunk TA for SAP LogServ on GCP** (`splunk_ta_sap_logserv_gcp`), installed per heavy forwarder |

!!! note "v0.1.1 = the LLM-capable source line, and the published tarball is the full-LLM build again"
    v0.1.1 is the **LLM-capable** source line, at full feature parity with v0.0.6 — the entire dashboard-performance data-layer rewrite (tstats + KV-Store rollups, backfill panel, staggered schedules), the Azure and GCP ingest add-ons, the three-way Multi-Cloud Overview, the Enterprise Security enable + re-stagger, and every AI Assistant fix (prompt repairs, the MCP time-range fix, rollup-backed host prompts). The source additionally carries the full LLM-driven AI Assistant (four vendor providers, free-form chat, Power Mode, privacy tiers, Provider Credentials). **As of App build 335 the published v0.1.1 App artifact is the full-LLM build variant** (see the build 335 entry), so those features are active once an LLM provider credential is configured; a compile-time templates-only variant of the same source remains available for restricted deployments. Everything in [Release Notes: 0.0.6](release-notes-0.0.6.md) is included in v0.1.1; that page maps the v0.0.6 builds 254–266 to the v0.1.1 builds they came from.

## :material-circle-box:{ .taiconcolor } Data TA — the `days_in_past` guard now fires at the prefix depth the screen recommends (2026-09-18)

The AWS S3 Direct screen blocks a key prefix whose events the forwarder's own `days_in_past` filter would discard on arrival — the check that stops you creating an input which ingests nothing and reports success. It reads the date partition out of the prefix, and it required all six path segments (`logserv/<clz_dir>/<clz_subdir>/<YYYY>/<MM>/<DD>/`), while the screen's own depth gate admits **four** and both its message and the field help recommend exactly four. An operator who followed the screen's advice produced a prefix the guard could never evaluate — and the same blind spot silenced the SQS double-ingest warning for any prefix coarser than a single day.

The check now reads a year, month or day partition, and both callers reason about the **newest** instant the partition can contain:

- a `<YYYY>/` prefix wholly behind the cutoff now blocks, where it was previously accepted unexamined;
- a prefix for the year still being written does **not** block on account of its January — deciding on the oldest instant instead would have produced exactly that false block;
- a year-wide prefix now raises the SQS overlap warning it could not raise before;
- a month out of range (`2025/13/`) and a day that would roll into the next month (`2025/06/31/`) are refused rather than silently widened to a date you never wrote.

The day-level message is word for word the one that already shipped, so nothing changes for a prefix that already worked. See [AWS S3 Direct: Backfill and Recovery](../install-setup/aws-s3-direct.md).

## :material-circle-box:{ .taiconcolor } Splunk MCP Server 2.x support, and the published artifact returns to the full-LLM build (build 335)

The AI Assistant refused to operate against **Splunk MCP Server (Splunkbase App 7931) v2.0.0**: a site that installed the current MCP Server saw an “uncertified version” panel in place of the Assistant. The App carries a deliberate upper bound on the MCP Server version — a supply-chain guard, because a major release is free to rename tools or reshape the request/response envelope, and the bound turns a silent degradation into a clear message. That ceiling moves from **2.0.0 to 3.0.0**, so the whole 2.x major is now accepted. Unchanged: the **v1.0.3 floor** (CVE-2026-20205) and the fail-closed handling of an absent or unparseable version string. **3.x** becomes the new ceiling.

What the change rests on is worth stating plainly. The connection handshake is verified against 2.0.0 in the field — the health probe reads the server version only after the connection succeeds, so seeing the “uncertified” panel at all proves that the transport, the authentication and the protocol handshake were accepted. The tool-listing and tool-call shapes have since been verified too, by a manual check against a live 2.0.0 server: the tool names the Assistant dispatches and the result envelope it reads were both unchanged by that major. Two bounds on that — it is a spot-check of **2.0.0**, not an automated regression suite, and it says nothing about later 2.x minors. On a 2.x minor you are the first to run, run one predefined prompt and confirm the result tile carries data.

This build is also the point at which the published App artifact returns to the **full-LLM build variant** — see [Restricting the LLM Path](../ai-assistant/templates-only-build.md) and the upgrade note in [Upgrading](../getting-started/upgrading.md).

## :material-circle-box:{ .taiconcolor } Data TA — the AWS S3 Direct screen, for backfill and recovery (2026-09-11)

The Data TA gains a screen — **Splunk Web → *Splunk TA for SAP LogServ* → AWS S3 Direct** — that creates and manages LogServ-scoped **Generic S3** inputs inside the Splunk Add-on for AWS from the browser, as the signed-in user. It adds no Python, no REST handler and no capability of its own.

Generic S3 polls a bucket prefix directly, with no queue. It is a **secondary** channel — backfill, a bucket with no SQS notifications configured, and recovery after an outage — and SQS-Based S3 remains the steady-state path. The screen exists because the add-on's own input form is effectively closed to most operators: its bucket dropdown is populated by `list_buckets()`, which requires the unscopable `s3:ListAllMyBuckets`. The screen asks for the bucket name instead, so the input can be created with only the scoped actions a run actually needs — and **`s3:ListBucket` is the one people miss**, because the SQS-Based S3 path never requires it.

Two things about this input surprise people, and the screen guards both:

- **The key prefix selects the events; the scan-window dates bound the S3 object's `LastModified` — its upload time, never the event time.** A re-staged archive can hold 2025 events in objects written in 2026, so a scan window narrowed to the event dates selects nothing and the run reports success having fetched none. Scan-from therefore defaults to a floor of `2000-01-01T00:00:00Z` and the prefix does the selecting.
- **A blank scan bound is not rejected by the add-on** — an empty scan-until means *unbounded*, and an empty scan-from means *the last seven days*. The screen requires both, offers them as UTC calendar controls, validates as you type, and re-checks before writing.

The scan floor is `2000-01-01T00:00:00Z` rather than the Unix epoch for a concrete reason: **Splunk's own `search/timeparser` rejects every 1970 date.** The add-on validates these dates locally when the input is created but resolves them through that parser on every poll, so a 1970 floor saved cleanly and then failed on every subsequent poll — a silent input that never collected anything and could not be repaired from the form. The screen refuses any date before 1971.

See [AWS S3 Direct: Backfill and Recovery](../install-setup/aws-s3-direct.md).

## :material-circle-box:{ .taiconcolor } String-accuracy pass from the zero-trust docs audit (build 334)

Eight string/label defects surfaced by the 2026-08-18 zero-trust documentation audit, all string/comment/conf-level with no logic change: the three Settings-page strings (and two shipped-conf comments) that still named the audit index by its retired pre-rename form now say `logserv_ai_assistant_audit`; the Environment Topology Live Activity caption now reads "Top N busiest edges" (the table lists the busiest edges of any integration type, not just RFC); the Network Perimeter activity chart title no longer claims a log-scale y-axis; the Host Details "Windows Event Codes" subtitle no longer claims a top-15 cap (the table paginates all event codes); the ES Risk Notable's description now says it aggregates the SAP-side detection searches (its SPL reads all of them, not just the original five correlation searches); the two behavioral-anomaly notable descriptions now describe the daily scan of hourly buckets since the start of the previous day instead of "the most recent hour"; the templates-only Settings banner branches on the build flag, so a templates-only build no longer instructs admins to toggle off a mode that is fixed at compile time; and `collections.conf` types the `mcp_timeout_seconds` field so the setting round-trips typed like its sibling fields.

## :material-circle-box:{ .taiconcolor } elkjs license attribution restored in the shipped notices (build 333)

The Environment Topology layout engine `elkjs` (EPL-2.0) has been bundled since the topology's ELK layouts shipped, but its entry was missing from the generated `THIRD-PARTY-NOTICES.md` — the package was never formally declared as a dependency, so the notices generator (which walks the resolved workspace `node_modules`) skipped it. Build 333 declares the dependency properly; the shipped notices now carry the `elkjs@0.11.1` section with the full EPL-2.0 license text (1236 packages, up from 1235). No functional change — the bundled elkjs bytes are identical. See [Third-Party Software Licenses](third-party-licenses.md). Found by the 2026-08-18 zero-trust documentation audit.

## :material-circle-box:{ .taiconcolor } Release packaging — templates-only canonical App; all four artifacts at version 0.1.1 (2026-08-18)

!!! note "Superseded by build 335"
    The templates-only packaging decision recorded here was reversed in build 335 — the published App artifact is the **full-LLM build variant** again. The version alignment of all four artifacts at 0.1.1 still stands. See the [build 335 entry](#splunk-mcp-server-2x-support-and-the-published-artifact-returns-to-the-full-llm-build-build-335).

At the time of this release the published v0.1.1 App tarball was the **templates-only build variant** of the current build: the AI Assistant's full predefined-prompt catalog (via the Splunk MCP Server) is fully functional, and the free-form LLM path is **disabled at compile time** — no runtime setting, including a stored `templates_only_mode = 0` from a previous LLM-enabled install, can re-enable it (see [Restricting the LLM Path](../ai-assistant/templates-only-build.md)). The regular, LLM-enabled build of the same source and build number remains available as an archived variant for approved deployments. In the same release pass, the **Data TA was rebuilt** as a canonical 0.1.1 artifact (functionally identical to its predecessor), and the **Azure and GCP ingest add-ons moved from their independent `0.0.6` versioning to `0.1.1`** — their tarball filenames change accordingly (`splunk_ta_sap_logserv_azure-0.1.1.tar.gz`, `splunk_ta_sap_logserv_gcp-0.1.1.tar.gz`) with no functional change. All four artifacts pass AppInspect Cloud-mode precert with 0 errors / 0 failures at their historical baselines.

## :material-circle-box:{ .taiconcolor } Topology top-5 High Traffic SIDs + legend declutter; Data Doctor copy + open-in-search on the rollup SPL (builds 331–332)

In the diagnostic drawer's *Rollup-populating saved searches* section, each printed saved-search definition now carries two corner actions on the SPL block: **copy to clipboard** (copies the definition verbatim) and **open in the Search app**, which opens the SPL in a new browser tab scoped to the diagnosed time window. The opened search has its terminal `| outputlookup` write **removed first** — run verbatim over an arbitrary window, an aggregation search would upsert partial bucket rows over correct summary rows, and the drawer never offers a control that can change data. When the write cannot be removed with certainty the open action is simply not rendered (the copy always is), and a build-time check proves the removal against every shipped aggregation search's definition on every release.

The **High Traffic SID** classification now marks the top **five** SAP systems by total incident calls (was ten since build 324); every other SAP system is **Regular Traffic SID**. Remote partners are unaffected. The ranking mechanics are unchanged — data-derived at render time, SAP systems only, inbound + outbound + bidirectional calls all count — and on an estate with five or fewer systems every SID is still High Traffic.

The partner donuts' legend rows also dropped their per-row **ownership badge** (user feedback: confusing). Because the graph folds every inventory-attributed address into its owner's node, "owner not established" was the only verdict a legend row could ever show — a uniform column of it carried no information. Legend rows now show the endpoint and its call count; ownership badges continue to render where the verdict can actually vary (the Hosts tab rows and the Edge Details "By app server" table), and the underlying inventory is unchanged.

## :material-circle-box:{ .taiconcolor } Environment Topology — hostname + user names on IP endpoints (build 330)

The square partner nodes labelled with raw IP addresses can now say **who and what is behind the address**, straight from the logs. When the evidence exists, a square renders up to two extra lines under its IP — the machine's **hostname**, and a **user line** (the name when exactly one distinct user was seen from that address, a count like "7 users" otherwise, with the full list on hover) — and the Details panel's Overview gains matching rows under the Tag: **Hostname** (with its evidence source), **Users** (every name, grouped by source — HANA audit, Windows logons, SAP start service, SSH sessions) and **Names as of** (how fresh the mapping is). The evidence is same-event only: HANA audit client registrations carry the client host name and the executing DB user next to `client_ip`; Windows **4624 successful-logon** events carry `WorkstationName` and `TargetUserName` next to `IpAddress` (failed logon guesses deliberately claim nothing, and a workstation name is only trusted when it differs from the logging host itself — for interactive and service logons the field names the *local* machine); SAP start service authentication lines carry `user(...)` and the remote address on one line; and Linux `sshd` session lines carry the user and source IP. Ambiguity **suppresses rather than guesses**: a hostname renders only when the IP maps to exactly one machine name (short name + FQDN count as one) and that name is not claimed by a crowd of addresses, and gateway logs are deliberately excluded as a source (their peer-IP and partner-hostname lines never co-occur on one event, so correlating them would be guesswork). The mapping is **"latest known"** — refreshed daily into a new `logserv_topology_ip_enrichment` KV Store collection (folded into the Environment Topology (graph) rollup in Settings → Dashboard Data, so Clear + Backfill cover it) and deliberately not scoped to the time-range picker, so names do not blink out on narrow windows. The build also fixed a self-inflicted deployment lesson worth recording: the new *daily* aggregation search is single-pipeline rather than the usual `| union` shape, because a 30-day daily scan in a union's non-first arms would silently truncate at scale — and its first draft carried a literal `search` prefix, which a *saved* search treats as a search **term** (saved searches prepend search context themselves), silently matching only events containing the word "search"; caught in live verification, fixed before promotion.

## :material-circle-box:{ .taiconcolor } Environment Topology — group select and move (builds 326–328)

The topology canvas now supports moving a whole cluster at once. Hold **Shift and drag** on empty canvas to draw a selection box — every node it touches joins the group and gains a **dashed outline** (deliberately neutral ink, so it can never be misread as a health signal or an edge colour), a status chip at the canvas top-right shows the count, and **dragging any highlighted node moves the whole group rigidly**, edges following their nodes. **Shift/Ctrl/Cmd + click** adds or removes a single node; a **plain click** inspects a node in the Details panel and releases the group; **Escape** or an empty-canvas click clears it; **arrow keys** nudge a focused group; with **Snap mode** on, release applies *one shared* grid offset so the group's shape is preserved. Group moves mark the layout Unsaved and are captured by Save Layout like any drag, including keyboard nudges; the group survives data refreshes and time-range changes. Plain drag on empty canvas still pans — nothing about the existing gestures changed. Group membership is announced to assistive technology (`aria-selected`), keyboard focus regained a visible ring (the imported canvas library removes it), and the canvas's screen-reader instructions were corrected to the real key set. Under the hood the change also retires two latent hazards: the canvas library's **Backspace-deletes-selected-nodes** default is now explicitly disabled, and its built-in selection rectangle — which silently swallowed clicks over the selection's bounding box — is suppressed in favour of the per-node outlines. Adversarially reviewed before implementation (three lenses over the design against the installed canvas-library source; 33 findings including 3 blockers, all folded — among them: the snap pass would have deformed the group by rounding each member independently, a duplicate drag handler would have written NaN positions, and group drags would have rubber-banded through the canvas's 600 ms glide animation). The rendered verification pass then surfaced two follow-up fixes shipped as builds 327 and 328: the HANA-tenant circles' bottom chip had overlapped their health ring since the build-324 tenant redesign (tenants are the one node variant whose name renders inside the disc, so the chip sat directly under the ring at the shared 2 px margin — it now clears at the SID label's 22 px), and Escape initially never cleared the group because Splunk Web keeps a permanently-mounted *hidden* "Disconnected from Splunk server" dialog in the DOM, which the handler's any-dialog guard mistook for an open modal — only a *visible* dialog now owns Escape.

## :material-circle-box:{ .taiconcolor } Environment Topology — High/Regular Traffic SIDs, node icons, host + app-server visibility (builds 324–325)

The SID classification, the node visuals, and two long-standing "what exactly am I looking at" gaps were reworked:

1. **High Traffic / Regular Traffic SIDs** — the classification formerly labelled "Focused SAP SID" is now purely data-derived: the view ranks SAP systems at render time by the **total calls touching them** (inbound + outbound + bidirectional) and marks the top ten **High Traffic**; every other SID is **Regular Traffic**. Only SAP systems compete for the slots — a high-volume client IP can no longer occupy one — and the last hard-coded seed is gone from the aggregation searches (stored rows are classification-neutral; old rows read identically). On estates with ten or fewer systems every SID is High Traffic, by design. Both kinds render at the same large size with the health halo; the Systems-panel highlight now means High Traffic.
2. **Node icons + tenant circles** — every SAP system circle carries an interior icon (an app-server rack for application systems, the database cylinder for database systems), HANA **tenant databases** render as full-size circles with a combined app-servers + database icon and the tag "APP SERVERS - HANA TENANT" (chip: "HANA TENANT"), and horizontal dividers now separate every section in the right panel's tabs.
3. **Host + instance visibility** — hovering a SAP system shows a **Hosts** row (distinct hosts that logged its events in the window), the panel Overview gains a **"Hosts (in range)"** fact, and the Hosts tab lists the SAP **instance numbers** seen on each host (`inst 00, 01`). All three read the same hourly rollup as the Hosts tab itself, so the numbers agree; on a tenant node the count is scoped by the tenant's shared name and the panel says so inline.
4. **RFC per-app-server accuracy** — RFC rollup rows are now keyed **per SID-side gateway listening address** (`local_ip`), fixing a latent last-write-wins collision in which a multi-app-server SID's RFC call counts undercounted whenever two of its app servers served the same partner in the same hour. The Edge Details Overview gains a **"By app server"** table splitting each RFC edge's calls and errors by app-server address, with inventory owner badges. The rows partition the edge's calls, so they sum to the *Calls in window* fact above them.

!!! warning "Upgrading an existing install — the topology graph rollup needs a one-time Clear + Backfill"
    **Superseded by build 378 of 0.1.2.** On a current build, the build-378 rebuild of **Environment Topology (graph)** replaces this migration: its **Clear** and **Backfill**, or its [narrower repair](../getting-started/upgrading.md#narrower-repair-build-378), also re-key the RFC rows, so an install older than build 324 needs no separate RFC migration (see [Upgrading to This Release](../getting-started/upgrading.md#coming-from-app-build-377-or-earlier) and the [build-378 entry](release-notes.md#sap-router-and-rfc-connections-in-the-topology-the-hana-audit-host-hana-trace-lines-read-by-their-format-and-the-sap-client-in-the-icm-trace-rebuild-eleven-rollups-once-build-378)). Do not run the RFC-only steps below on a current build: the shipped `[logserv_topology_backfill_edges]` search now has two gateway arms, outbound and inbound, so keeping "the single" gateway sub-search rebuilds only one direction, after step 1 has deleted every RFC row. The text below applied to builds 324–377.

    The per-app-server change **re-keys the topology graph rollup's RFC rows**. After upgrading, run **Clear** and then **Backfill** once on **"Environment Topology (graph)"** in Settings → Dashboard Data. Running Backfill *without* the Clear would double-count RFC history (the old collided rows survive next to the new per-app-server rows), and the panel's completeness check will otherwise skip the rollup as already complete. Until the migration runs, RFC calls recorded before the upgrade appear as "(not recorded)" in the By-app-server table and keep the pre-upgrade undercount.

    **The Clear discards topology graph history older than the backfill window** (at the time a fixed 30 days; from builds 353–360 of 0.1.2, presets up to 365 days or a custom UTC range; the graph retains up to 365 days). On installs older than 30 days, prefer the surgical RFC-only migration, which keeps everything else:

    1. Delete the RFC rows (the query deletes every RFC row, not only the collided ones): `DELETE /servicesNS/nobody/splunk_app_sap_logserv/storage/collections/data/logserv_topology_edges?query={"type":"rfc"}` (management port, admin credentials).
    2. Re-run only the RFC arm: from the `[logserv_topology_backfill_edges]` search in `default/savedsearches.conf`, keep the single `sourcetype=sap:abap:gateway` sub-search plus everything after the last `]`, and dispatch it as a normal search over your full raw-data span.

    New installs are unaffected — the standard first-install backfill produces the new keys directly. The Hosts-tab **instance numbers** need no clear: they populate going forward from the hourly aggregation, and a plain Backfill (no Clear) on "Environment Topology (detail tabs)" fills the backfill window immediately (at the time, the last 30 days); host rows aggregated before the upgrade simply show no instance list until then.

## :material-circle-box:{ .taiconcolor } Environment Topology — the right panel says what it means (builds 322–323)

Three things the node panel showed but never explained. Each is now stated on
the panel itself.

- **"Which of these IP addresses are my system's own?"** — none of the ones you
  can see, and that is by design. An address the inventory attributes to a
  system is folded into that system's node before the graph is drawn, so an
  address still shown separately is one no system has claimed. Every endpoint on
  the partner charts and the Hosts tab now carries that verdict — `owner: XCP`
  or `owner not established` — with the caveat stated inline that ownership
  comes from an inventory which is **not** limited to the selected time range.
  "Owner not established" is the expected reading on the partner charts, not a
  fault, and the panel says so.

- **"Is 'Top partners' inbound or outbound?"** — it was both, summed. It is now
  **two charts**, one per direction, each listing *every* partner with its exact
  call count. There is no "other" bucket and the legend is not capped, so a
  system with many partners makes the panel taller rather than the list shorter.
  **Hover any slice** for its endpoint, exact count and share of the total —
  worth reaching for on the small ones, because a slice too small to be visible
  is drawn slightly larger so it does not disappear, and the panel says so
  whenever that has been applied. Exact per-direction totals were
  added to the facts table so the charts reconcile against the headline, and
  traffic the data records as **bidirectional** (HANA Tenant) is counted on its
  own line instead of being assigned a direction the record denies.

- **"What are the hosts on the Hosts tab to this system?"** — they are the
  system's own hosts, which is why the inbound/outbound split you might expect
  does not apply to them. Instead, a new **Calls by host and edge type** table
  sits beneath: it names a receiving host wherever the data supports one, and
  falls back to an edge-type row where it does not, so it accounts for **all**
  of the node's calls and can be checked against the Total calls figure on the
  Overview tab.

The Hosts read was also silently capped at 20 rows while the caption reported
that cap as the host count; the cap is now 100, and when it is reached the panel
says so. Three chart-rendering defects that the previous four-partner limit had
been hiding are fixed at the same time: very small slices rendered as background
while their legend row still claimed a colour, a single-slice chart drew nothing
at all, and an empty one asserted "0 calls" as if it were a measurement.

!!! note "Where the numbers come from"
    Nothing here adds a search or a scheduled job. The traffic breakdown is
    computed in the browser from the same hourly rows that already produce the
    node's totals, which is what lets the two reconcile exactly. The one search
    change is an added `eventstats` inside the existing Hosts read, so the panel
    can tell how many hosts exist beyond the ones it is showing.

## :material-circle-box:{ .taiconcolor } Environment Topology — the Edge Details tabs work again (build 321)

Selecting an edge on the Environment Topology canvas now populates its detail
tabs. Since build 240 the four tabs had shown "no events for this edge" for
every edge on every time range: the view passed the *rendered* edge's key —
a composite of its two endpoints and its type — to searches that accept only
the *stored* edge id, so each search was rejected before it ran and nothing was
ever dispatched. The headline figures on the Overview tab came from data
already in the browser, which is why the pane still looked alive.

- **Operations, Performance and Errors** now read the hourly topology rollup
  scoped by the stored ids behind the edge you clicked. Where inventory
  retargeting collapses several underlying edges into one on the canvas, the
  tabs cover all of them; in the rare case that an edge spans more underlying
  edges than one search may address, the tab says how many it covered rather
  than quietly showing a partial total.
- **Activity** is no longer a search at all — it is computed from the same rows
  that produce the Overview totals, so the "successful calls + errors" legend
  is an exact decomposition of "calls in window". Previously the two were
  resolved over slightly different windows.
- **Empty tabs now explain themselves.** A tab that was queried and came back
  empty reads differently from one that could not be queried, so a silent
  failure of this kind cannot hide again. Note that RFC edges legitimately have
  no Operations or Performance rows — those fields are absent from gateway
  events.
- **Three labels corrected on surfaces this made visible again**: the HANA
  Tenant performance chart is titled mean and maximum rather than percentiles
  (percentiles cannot be merged across hourly buckets), the HANA Audit Overview
  row is labelled "Auth failures (CONNECT)" to distinguish it from the broader
  Errors tab, and two RFC performance cells that no search has ever populated
  were removed.

A build-time check now derives the stored id's shape directly from the shipped
searches and refuses to build if the interface stops matching, so this class of
mismatch cannot return unnoticed.

## :material-circle-box:{ .taiconcolor } Data Doctor — rollup SPL in reports + full-length raw samples (build 320)

Two report/drawer enrichments for support workflows:

- **The full SPL of the saved searches that populate a rollup** now appears in the panel
  diagnosis drawer's technical detail, in Copy technical summary, and in the panel and
  dashboard PDFs. Each entry is attributed by its parsed `outputlookup` target (never
  guessed from the registry — the multi-collection rollups made that distinction matter),
  carries its cron schedule verbatim and its last-modified timestamp, and sits under a
  pinned intro stating the SPL is current configuration that was **not** run by the
  diagnosis. Each aggregate names its install-backfill stanza with an "as shipped, the
  search text is identical" note whose premise a build-time check derives from the shipped
  configuration on every release. The dashboard PDF's section is de-duplicated and covers
  every rollup the dashboard reads — healthy panels included; unreadable entries render
  their reason plus an explicit "N of M could not be read" completeness line.
- **Raw event samples are no longer truncated to 500 characters** — each opt-in sample is
  included in full, up to a disclosed 20,000-character safety ceiling (twice Splunk's
  default per-event truncation). The ceiling is applied *before* redaction (whose e-mail
  matcher is now bounded — linear on any input), the credential scrubber gains
  space-delimited SQL/CLI secret shapes (`PASSWORD "x"`, `IDENTIFIED BY x`, `-P x`,
  `-pXxx`, `--password x`), and the samples section + cover banner state that the PDF's
  Latin-1 font may not render every character — the `.json` twin carries the exact text.
  Reports stored by earlier builds remain re-downloadable (the persistence shape check
  accepts the prior banner wording).

## :material-circle-box:{ .taiconcolor } Data Doctor — operator-supplied evidence refinements (build 319)

The operator-supplied ingest-filter evidence (the Diagnostics-page paste) is sharpened on five
fronts:

- **Replay/backdate-proof out-of-date detection** — the "supplied configuration may have
  changed" check now also compares *index time* (from bucket metadata), so replayed events
  with old timestamps no longer evade it; a five-minute clock-skew grace prevents false
  contradictions, and the index-time signal only ever softens a verdict (to *possible*), never
  silences the diagnosis.
- **Days-in-past corroboration** — the "dropped by design" verdict now reports whether
  anything older than the cutoff exists in the index at all (from the same bucket-metadata
  probe, at zero extra search cost), with deliberately non-committal wording when nothing
  older exists: a filter, a young index and ordinary retention are indistinguishable there.
- **A sliding-cutoff context line** on "never received" / "newer data exists" / "may have
  stopped" verdicts whose window ends before the supplied cutoff — the cutoff is surfaced
  without over-claiming it as the cause.
- **The Cloud Provider stamp rides the paste** — a `local/transforms.conf` or settings-conf
  paste records the Data TA's configured `cloud_provider` stamp, and provider-filtered panels
  explain how it interacts with their Cloud filter (including the `aws`-matches-unattributed
  nuance). Stored in the facts row (new `cloud_provider_stamp` column), shown in the page
  summary and in every report's supplied-filters section.
- **A drawer pointer** — when a panel diagnosis lands on an ingest-ambiguous verdict with no
  usable configuration supplied, the drawer (and its *Copy technical summary*) now points at
  the Diagnostics-page paste.

Also fixed: transforms-paste pattern recovery now inverts every `re.escape`d character (a
hyphen-bearing include/exclude pattern previously mis-recovered), lists clamped on read are
marked approximate, and a per-probe runtime cap is no longer dropped by the dashboard sweep's
probe deduplication.

## :material-circle-box:{ .taiconcolor } Data Doctor — partial-data diagnosis: blank columns and zero values (build 318)

Missing data is not always an empty panel. The Data Doctor now diagnoses panels that **have**
data — a table with rows but a blank column, or a KPI stuck at a zero you believe should not be
zero — with two new entry points that work on populated panels:

- Every chart and table panel's toolbar gains a fifth icon, **Diagnose this panel**, opening the
  diagnosis drawer under a **"Panel diagnosis"** header (the empty-panel header remains *"Why is
  this empty?"*).
- Every KPI card gains a corner diagnose control, revealed on hover or keyboard focus. On a card
  showing a zero (formatted zeros like "0 ms" count) it routes into the new zero-value
  resolution.

What the partial-data diagnosis adds:

- **Column coverage.** The table reports which displayed columns are blank — as **counts only,
  never values** (nothing from your rows leaves the panel). Each fully-blank column is traced to
  the raw-event field it displays (through any renames in the query) and corroborated against a
  sample of the source events, distinguishing *"the field is not populated on the source events
  at all"* (a search-time-extraction gap) from *"the source events carry it but the summarised
  rows do not"* (a summarisation gap — the backfill settles it) from *"the aggregation provably
  does not store that column — a backfill cannot add it."* Columns computed inside the query, or
  drawn by a custom renderer, are honestly set aside rather than probed.
- **Zero-value resolution.** A zero KPI is reconciled against the summarised layer and — when
  the panel's raw equivalent emits a single comparable value — a live raw computation.
  Summarised rows that genuinely sum to zero, or an agreeing raw equivalent, certify *"the value
  genuinely is zero"* (never a backfill prescription); a disagreeing raw equivalent is reported
  as a **possible** summarisation gap, never a confirmed fault.
- **The honest floor.** When every displayed column is populated and accounted for, the
  diagnosis says so — *"no defect found"* — and the floor is unreachable while any column could
  not be checked (those are named instead).

A populated panel's rows are living proof the read path works, so the emptiness checks are
skipped with explicit *"Not applicable — this panel returned data"* ledger notes; a panel that
has not finished loading is refused with a plain explanation rather than diagnosed on unknown
facts.

## :material-circle-box:{ .taiconcolor } Data Doctor — deep evidence: cache reconciliation, field probes, clause bisect (build 317)

The Data Doctor's check catalogue is complete. Four deep checks now run **in the panel diagnosis
drawer only** (never in a dashboard sweep — they are the only probes allowed to scan raw events):

- **Summarised-vs-raw reconciliation.** An empty panel that reads summarised data is re-run as
  its exact raw-query equivalent over the already-summarised period. If the raw query returns
  rows the summary lacks, the diagnosis is the **confirmed** *"the summary appears to be missing
  data it should have"* (re-run the backfill); if both agree there is nothing, the diagnosis is
  the health-certifying *"there is genuinely nothing to show"*. Only panels whose raw equivalent
  groups results carry this signal — a scalar count is skipped with an honest note.
- **Field presence probe.** A raw panel that filters on a field is checked against a sample of
  its own sourcetype's events: a field populated on **zero** sampled events reads as a likely
  search-time-extraction gap (*"this field is not populated"* — a missing add-on or broken
  props chain), and a populated field whose expected value never appears reads as a possible
  vocabulary/casing drift (*"none of this panel's expected values appear"*).
- **Clause relaxation.** For an empty raw panel, each filter clause is removed in turn (after a
  control probe confirms the emptiness is in the base search): the diagnosis names **which
  clause excludes every event** and how many events removing it would match.
- **Lookup registration.** A panel using a non-summarised lookup verifies it is registered on
  the search head (a CSV under `default/lookups/` does not register — only the app-root
  `lookups/` directory does).

The environment **report**'s rollup table gains a "Recent buckets" bucket-continuity column
(context only — the live Diagnostics page deliberately omits it), and cached verdicts under a
Cloud Provider filter now state whether any summarised rows carry that provider at all.

Build 317 also fixes a live defect found during this work's review: the Environment Health
dashboard's sub-hour raw queries still used a retired field name (`audit_action`), silently
dropping every HANA failed-CONNECT from the Auth Failures KPI at ranges under 90 minutes and
leaving the Recent Critical Events "Detail" column empty for HANA rows. Both now read the
correct `action_type` field.

## :material-circle-box:{ .taiconcolor } Data Doctor: platform snapshot, data coverage, raw samples, drawer polish (builds 315–316)

The Data Doctor's deferred capabilities are now built:

- **Platform health snapshot (Tier B).** A new hourly scheduled search, `logserv_diag_platform_aggregate` (two minutes past each hour), copies scheduler outcomes and skip/deferral reasons, search-concurrency warnings, per-index throughput, pipeline-queue depth and PCRE-limit events from `index=_internal` into the world-readable `logserv_diag_platform_snapshot` KV collection — so a **non-admin** diagnosis can see platform health. The Diagnostics page and the environment report render it as a Platform-health section; when the snapshot is stale, empty or unreadable, the section says **NOT AVAILABLE** with the verified reason rather than guessing. A stale dashboard summary's diagnosis can now carry a scheduler-skip evidence line — always provenance-badged ("recorded by the hourly platform snapshot, a collection any authenticated Splunk user can write" _(superseded by builds 384–385 of 0.1.2: the collection is writable by the admin, sc_admin and sc_subadmin roles only, and the badge reads "a collection only Splunk administrators can write")_) and never able to raise the verdict's confidence. A daily retention search (`logserv_diag_platform_retention`) trims the collection to 30 days. The hourly cron slot was freed by moving the four ES behavioral-anomaly searches from `:02` to `:30` of hours 02–05 (behaviourally neutral — their analysis windows are snapped in SPL).
- **Data coverage in the environment report.** A daily event-volume chart (ASCII, up to the most recent 60 days), the `clz_dir`/`clz_subdir` distribution **with its coverage denominator** (events without the routing metadata are called out, not hidden), and per-host counts.
- **Opt-in raw event samples in the panel report.** The diagnosis drawer's Download PDF gains an "Include raw event samples" checkbox (default off, never sticky): up to 5 recent events of the panel's sourcetype(s), credential-scrubbed and email/user-redacted, truncated to 500 characters _(superseded by build 320: samples now ship in full, up to a 20,000-character ceiling; see the build-320 entry)_, clearly labelled as **not** filtered by the panel's own host/provider selections. The report's cover banner states the samples' presence, and a sample-bearing report is **download-only — never saved** to the Saved-reports list (storing raw events in a world-readable collection would bypass index access controls).
- **The drawer now closes on any route change** — browser Back **and** in-app navigation — closing the long-documented C10 quirk.
- **PDF text fidelity.** The `→` arrow rendered as mojibake in every generated PDF (the standard PDF fonts are cp1252-only); it is now ASCII across every report string, with a permanent build gate preventing regressions.
- **The four behavioral-anomaly ES searches moved from `:02` to `:30`**, still once a day in hours 02–05, so the hourly platform snapshot has `:02` to itself.
- The shipped scheduler layout is now verified by a permanent build gate: **every enabled scheduled search occupies its own (hour, minute) slot — zero cron collisions.**

## :material-circle-box:{ .taiconcolor } Data Doctor — operator-supplied ingest evidence (build 314)

The Data Doctor closes its own biggest declared boundary: the Data TA's ingest-tier filters
(include/exclude + days-in-past), which run on the heavy forwarder / indexer tier and are
invisible from a search head. The **Platform → Diagnostics** page now prints the exact command
to read them, accepts the pasted output (REST JSON/XML, the generated `local/transforms.conf`,
or the settings conf), credential-scrubs and parses it, and stores it as operator-supplied
evidence. Two new diagnosis verdicts consume it: *"Events this old are discarded at ingest by
design"* (window vs the days-in-past cutoff) and *"`<log type>` events are excluded at ingest
by the configured filter rule `<rule>`"* (the include/exclude reconciliation) — each carrying a
*"Recorded as supplied by \<user\>, \<date\>"* provenance line, hedged when the supply is
stale, approximate or partial, and standing down entirely when observed events contradict it.
Reports gain an "Ingest-tier filters (supplied by operator)" section and a machine-readable
`ingestFacts` block; a paste matching a heavy forwarder's shipped-defaults shape is flagged
rather than trusted. One new KV collection (`logserv_diag_ingest_facts`, a fixed single row,
no scheduled searches). See
[Supplying the ingest-filter configuration](../logserv-app/dashboards/platform/diagnostics.md#supplying-the-ingest-filter-configuration).

## :material-circle-box:{ .taiconcolor } The LogServ Data Doctor — missing-data diagnostic (builds 306–313)

When a panel is empty, the app now explains why — or finds out. The **Data Doctor** is a
built-in missing-data diagnostic, usable by any non-admin user, in four layers:

- **Empty-panel hints (automatic).** Every empty chart, table and KPI card corrects its own
  empty message when the reason is already knowable without a search: an active Cloud/host
  filter, a time range shorter than the panel's data granularity, a failed search, or a query
  clause that can never match. KPI cards use a compact form so the equalised row height holds.
- **"Why is this empty?" — the panel diagnosis drawer.** A budgeted, cancellable series of
  probes walks a gated verdict cascade (the panel's own error first, then index visibility and
  presence, the summarised-data layer, sourcetype presence/staleness) and answers in plain
  language with a confidence level and **who can act** — including the verdict a diagnostic
  must be able to give: *"there genuinely are no such events — nothing is broken."* Panels that
  read summarised data are traced back to the source events their aggregation consumes, so an
  unbuilt rollup ("run the backfill") is distinguished from genuinely absent data. A probe
  that failed or ran out of budget renders NOT CHECKED — never OK, never a fault.
- **Data Doctor reports (PDF + JSON) at three scopes.** The drawer downloads a panel report;
  the Actions menu adds **Diagnose dashboard (PDF)** (every panel on the open dashboard
  classified, the empty ones deep-diagnosed) and **Environment report (PDF)** (index,
  sourcetype and rollup health for the whole install). Each download is a branded, selectable-
  text PDF plus a machine-readable `.json` twin (`logserv.diag/1`) — generated entirely in the
  browser, containing no raw log events, intended for a Splunk support ticket.
- **The Diagnostics page (`#/diagnostics`, builds 311–312).** *Platform → Diagnostics* renders the
  environment health live — summary facts, a per-rollup table with independent **Freshness**
  and **History** verdicts (History uses the same ~30-day completeness convention as Settings →
  Dashboard Data), per-sourcetype window counts + all-time last-seen, the full "what was
  checked" ledger, and the explicit list of what cannot be checked from a browser session.
  Every downloaded report is also **saved automatically** to a new `logserv_diag_reports`
  KV collection and listed on the page for re-download (identical PDF, or the JSON twin) —
  kept 365 days, newest 100, trimmed by a nightly retention search at 01:56 search-head local time. The page
  carries no destructive or admin controls; admin remedies are named as text.

- **Fresh-install correctness (build 313).** Five new root causes are diagnosed for the
  states a brand-new install actually hits: **routing not applied** (events arriving but
  none parsed into the solution's log types — the Data TA missing from the forwarder/indexer
  tier), **feed not started** (an empty summary whose SOURCE events have never arrived — the
  backfill is no longer prescribed when it cannot help), **Windows extraction add-on
  missing** (`Splunk_TA_windows` absent on the search tier while the Windows events exist),
  **KV Store not ready** (mongod warm-up after a restart, previously indistinguishable from
  "never built"), and **future-dated events** (source clock/timezone misconfiguration). The
  index-authorization verdict now names every cause its evidence cannot separate (role,
  missing Data TA, macro override, disabled index); a "never arrived" claim is scoped to the
  index actually probed; a disabled summarisation job upgrades the stale-summary verdict to
  confirmed and names the job; the companion-apps check now includes the Data TA (with its
  expected-tier note); and saved panel reports carry the panel's real title instead of
  "(untitled)".

!!! tip "Honesty guarantees, enforced at build time"
    The diagnostic's rules are pinned by mutation-tested build-gate consistency suites (the build fails on any drift): a free check may never assert a system fault without
    dispatched evidence, an unchecked probe may never read as OK, a rollup may never be
    certified healthy from an unchecked collection, and the reports retention can never wipe
    the saved-reports collection on an empty read (`override_if_empty=false` — verified live).

## :material-circle-box:{ .taiconcolor } About dialog — version, build number and build date (builds 302–303)

!!! note "Superseded by builds 338–349 of 0.1.2"
    The navigation bar's menus were replaced by the left navigation rail. **About** is now at the bottom of the rail, below a divider and after **Settings** (admins only). The dialog shows the same version, build and build date.

The navigation bar has a new **About** item, to the right of *Platform*. Clicking it opens a dialog
showing the app icon, the product name **Splunk for SAP LogServ**, and the **version**, **build
number** and **build date** of the app you are running, with a **Close** button. Clicking outside the dialog or pressing
`Esc` also closes it.

This makes the running build identifiable from inside the UI — useful when confirming an upgrade
landed, or when reporting an issue.

!!! tip "The numbers always match the installed app"
    Version and build are read from the app's own `app.conf` when the app is built, and the build date
    is stamped at the same moment — none of them are typed into the page, so the dialog cannot show a
    stale value. The build date is UTC.

## :material-circle-box:{ .taiconcolor } Stale prompt count removed from the AI Assistant banner (build 301)

The AI Assistant's templates-only banner told users to "run any of the **48** saved searches" — the
catalog actually holds **61** predefined prompts. The count is now gone rather than corrected: the
catalog has grown across releases (40 → 42 → 48 → 61), and a hard-coded number in a user-visible
string goes stale silently. The banner now reads "any of the predefined saved searches".

The same stale count was swept from four other places: the shipped `ai_assistant_settings.conf`
comment (visible to admins via `btool`), two rows in the developer AI Assistant internals reference,
and the architecture page's description of the predefined-prompt path. No behavior change.

## :material-circle-box:{ .taiconcolor } Templates-only build variant now really disables the LLM (build 300)

The app can be built in two variants from one source tree: the standard build (`yarn build`) with the
full LLM-driven AI Assistant, and a **templates-only** build (`yarn build:templates-only`) intended for
partner and restricted-environment distribution, where only the predefined-prompt path is available.

The templates-only build flag was correctly wired, but it no longer disabled what it claimed to. The
user-facing gating had moved to the **runtime** `templates_only_mode` admin setting, so the build flag
was left gating only model discovery and two Settings rows — **a templates-only build still had working
free-form LLM chat**.

The build flag now *forces the runtime setting on*, at the single point where the setting is read:

- **Every read path reports templates-only.** The config reader normalizes both storage sources — the
  KV Store settings row and the `ai_assistant_settings.conf` stanza — through one function, and falls
  back to a built-in default if both reads fail. All three now report `templates_only_mode: true` in a
  templates-only build, whatever is stored. The existing runtime behavior then applies unchanged: chat
  input read-only, Send disabled, the free-form dispatch path short-circuits with an in-chat notice,
  model picker and Power Mode hidden, Provider Credentials tab hidden, explanatory banner shown.
- **Why patching the shipped conf default alone was not enough.** The KV Store row takes precedence
  over the conf file, so a deployment upgrading from a standard build — whose row already holds
  `templates_only_mode = 0` — would have kept the LLM path enabled.
- **The Settings "Templates-only mode" toggle is hidden** in a templates-only build. It could not turn
  the LLM path back on, so showing it would be a control that lies.
- The build also writes `templates_only_mode = true` into the packaged `default/ai_assistant_settings.conf`
  so the shipped artifact is self-describing to `btool` and the REST conf endpoint.

!!! note "What this does *not* change"
    The standard full-LLM build is unaffected — verified at the byte level: the two variants' compiled
    bundles are the same size and differ only in the compiled flag value (plus a per-build style-engine
    salt). The vendor provider modules are still present in the templates-only bundle; this is a
    functional disable, not a code strip. If you need a distribution with the vendor code physically
    removed, that is the separate v0.0.6 line, frozen at App build 266 with no later fixes (see [Release Notes: 0.0.6](release-notes-0.0.6.md)).

!!! tip "Upgrading a templates-only deployment"
    No action needed. Because the setting is forced at read time, an existing KV Store row that says
    the LLM path is enabled is overridden automatically. If you later move that deployment to a standard
    build, the LLM path stays off until an admin explicitly re-enables it in Settings — the safe direction.

## :material-circle-box:{ .taiconcolor } After-hours window fix (build 299)

Every "after hours" filter in the product was a silent no-op. The `[sap:hana:audit]` search-time
calculated fields chained one `EVAL` onto another (`hour_of_day` derived from `EVAL-audit_datetime`),
which Splunk does not reliably resolve — so `hour_of_day` and `day_of_week` measured **0% populated**
and `is_business_hours` was pinned to the dead constant `"false"` on every event.

Two opposite failure modes followed, decided purely by how the comparison was quoted:

- **HANA Audit → "After-Hours / Weekend Admin Activity"** compared against a bare `false`. In a `where`
  clause a bare `false` parses as a *field reference*, not a boolean, so the test never matched: the
  filter degenerated to weekend-only. The panel **omitted every weekday after-hours event** — the most
  security-relevant slice — and labelled every row "Weekend" (the "After Hours" and
  "Weekend / After Hours" labels could never render).
- **Change & Configuration Activity → "After-Hours Changes"** (the KPI, its sparkline, the "Recent
  After-Hours Changes" table, and the `logserv_compliance_rollup`) used the quoted form
  `is_business_hours="false"`, which matched the dead constant and flagged **100% of HANA events** as
  after-hours.

Both are fixed. `props.conf` now derives each field inline from `_time`, and — more importantly —
every consumer computes the window inline instead of reading a search-time calculated field. That
indirection was an invisible dependency for a security filter, and it fails silently in *both*
directions, so the dashboards, the ENRICH classifier and the rollup aggregation arms no longer rely
on it.

**One canonical window now applies to all three change sources:** business hours are
**08:00–18:59**, so after-hours is `hour < 8 OR hour > 18 OR weekend`. Previously HANA delegated to
the dead fields while Windows and Linux used a different 07:00–19:59 window.

!!! warning "Rebuild the compliance rollup after upgrading"
    In this build `is_after_hours` was part of the `logserv_compliance_rollup` `_key`, so rows written before it
    carry the old classification under different keys. A re-aggregation or a backfill writes new rows beside them
    instead of replacing them. After upgrading, open **Settings → Dashboard Data**, click **Clear** on the
    **Change & Configuration Activity** row, then use that row's own **Backfill** with a window that covers the
    history you want. **Run backfill** neither clears nor runs on rows it considers complete. From build 357 of
    0.1.2 the flag is no longer stored; coming from build 356 or earlier, the rebuild listed in
    [Upgrading to This Release → The Work List](../getting-started/upgrading.md#the-work-list) covers this.

Two deliberate exceptions are documented in `props.conf` and intentionally left unchanged: the three
Enterprise Security off-hours correlation searches use `hour < 8 OR hour >= 18` (tuned detections
whose notable/risk volume depends on the window), and the `logserv_hana_after_hours_admin` prompt
uses a wider business day (`hour < 6 OR hour >= 20`) as a deep-overnight tripwire — its own
description states that window.

## :material-circle-box:{ .taiconcolor } Sub-hour time ranges read raw events, a global Refresh button, and a 60-second MCP timeout default (builds 289–298)

- **The MCP request timeout defaults to 60 seconds** (build 289). An install with no saved `mcp_timeout_seconds` now waits 60 seconds, the MCP Server's own default, instead of 30; a saved value still wins.
- **Time ranges under 90 minutes read raw events** (builds 290–296). The dashboards read hourly rollups keyed on `bucket_ts`, so a sub-hour range read a rolled-up panel empty (a window inside one hour matched no bucket) or about four times too high (a window across an hour boundary matched the whole hour). A range under 90 minutes now runs the panel's raw search, and a wider one reads the hourly rollup. This covers every rollup-backed panel of the 21 dashboards, both Sourcetype Mapping link graphs and the Host Details Role Activity tab; the sparklines, the beaconing tables and the `| head N` event lists stay on the rollups.
- **A global Refresh button** (build 297) in the navigation bar re-runs the current view's panels for the selected range, beside the per-dashboard auto-refresh interval.
- **Web Dispatcher follows the Cloud filter** (build 298). Its Top URIs, Traffic by Status Code and Response Time Trend panels showed every provider's data whatever the **Cloud** dropdown said.

These builds shipped to the v0.0.6 line as builds 264 and 265.

## :material-circle-box:{ .taiconcolor } AI Assistant — configurable MCP request timeout (builds 287–288)

The AI Assistant's browser-side MCP request timeout is now an admin setting instead of a hardcoded 30 seconds. **Settings → AI Assistant → General** gains an **MCP request timeout (seconds)** field (default `30`, range `5`–`600`; build 289 raised the default to `60`) that bounds how long the browser waits for each MCP request — tool dispatch, saved-search run, health probe — before aborting it with the `signal is aborted without reason` error. Raise it if a legitimately-slow prompt aborts on a high-ingest instance. It reads per-request from the same KV-Store settings row as the rest of the AI config (`mcp_timeout_seconds`); MCPClient resolves it exactly like `mcp_server_url`. Note this is the browser-side abort — the MCP server (App 7931) has its own separate `mcp.conf [server] timeout` (60s default), so the effective ceiling for any one request is the lower of the two. Build 288 (v0.0.6 build 263) adds a **read-only display** of the MCP server's own timeout (App 7931's `mcp.conf [server] timeout`, read cross-app) right beside the client field, so an admin sees both numbers and their relationship at a glance; it degrades to "Not detected" when App 7931 isn't installed. The server timeout stays edited the normal way (that app's `mcp.conf` + a Splunk restart) — it's a different, persistent-process app, so it can't be changed live from our UI.

## :material-circle-box:{ .taiconcolor } AI Assistant — predefined prompts on the rollup tier (builds 285–286)

Twenty-three high-volume predefined prompts are converted from raw index scans to reads of the hourly KV-Store rollups that already power the dashboards. On high-ingest environments (~10M events/day), the raw scans behind prompts like *Source IPs flagged by firewall and/or proxy* exceeded the AI Assistant's 30-second dispatch timeout (the default at the time; now the configurable `mcp_timeout_seconds`, default 60 s) at wide time ranges and failed with "signal is aborted without reason"; the same prompts now complete in well under 2 seconds even over 30 days.

- **Converted prompts** cover firewall, proxy, DNS, Web Dispatcher, ICM, ABAP work-process, Windows logon/lockout, cross-stack authentication, Linux PAM + firewall-agent, HANA failed-auth + trace-severity, Cloud Connector, error categories, and top-systems-by-calls.
- **Five new rollup metrics** back the prompts that had no existing rollup dimension: `pam` + `cgsfw` on the Linux rollup, `wperr` on the Work Process rollup, `denieddest` on the Proxy rollup, and `logon` on the Windows rollup. The Settings → Dashboard Data backfill covers them automatically.
- **Three prompts intentionally report differently:** *Web Dispatcher slow URIs* now ranks by average response time with a per-URI max column (percentiles don't roll up across hourly buckets); *DNS queries to suspected beaconing domains* now uses the DNS dashboards' gap-variance beaconing detection (daily granularity); and the two *cross-stack auth failure* prompts now use the Cross-Stack Authentication dashboard's canonical failure definition, so their numbers match that dashboard.
- Rollup freshness semantics apply: results reflect data through the most-recently-completed hour. Prompt time ranges keep working — the dispatch window bounds the rollup read.
- The prompt catalog (intent map) is at v0.0.12; saved-search and intent-map SPL remain byte-synced.

A follow-up round in the same session fixed four trend prompts that rendered all-zero charts and two ES prompts that still timed out: the MCP server caps tool responses at its default 100-row limit keeping the FIRST rows, so an hourly trend over 30 days (721 rows) displayed only its oldest ~4 days — the ten >100-row time-series prompts now bin adaptively (`bins=90 minspan=1h`: unchanged hourly behavior at short windows, ~30–90 complete-window points at wide ones, totals verified conserved exactly); the after-hours-admin ES prompt's web-traffic join subsearch now reads the sourcetype-mapping rollup (row-identical, and the prompt completes at any window); and the web-dispatcher response-time anomaly is re-expressed on a new per-host hourly `wd_host` web-timing rollup metric as an avg+max z-score (percentiles don't roll up) — its daily scheduled detection drops from minutes of raw scanning to sub-second as well. Intent map at v0.0.13.

## :material-circle-box:{ .taiconcolor } Linux + Windows dashboard-chart fixes (build 284)

Two dashboard charts are fixed:

1. **Linux — "SAP Application Activity"** — the chart rendered 26 long `sap_app` / `sap_sid` combinations as a vertical column chart, so the x-axis labels clipped to "…". It is now a **horizontal top-15 bar chart** — each bar is one `sap_app / sap_sid` combination with its full label on the roomy y-axis — ranked by event volume.
2. **Windows — "Critical / Error" KPI + "PowerShell Activity" chart** — both were empty because of query mismatches, not missing data. **PowerShell Activity** now matches any PowerShell source (Windows PowerShell events index as `XmlWinEventLog:Microsoft-Windows-PowerShell/Operational`, and on the AWS S3 path as `WinEventLog:Powershell`). The **Critical / Error** KPI now counts CIM `severity IN ("critical","high")` — Splunk_TA_windows maps Windows Critical (Level 1) → `critical` and Error (Level 2) → `high`, i.e. the severe end of the CIM severity vocabulary.

## :material-circle-box:{ .taiconcolor } Global Cloud Provider filter (build 282)

A persistent **Cloud Provider** dropdown (`All / aws / azure / gcp`) now sits in every dashboard's title row, to the left of the Refresh-interval picker, and filters **every panel** on that dashboard by cloud provider. The selection is **global and remembered per user** — it carries across dashboard navigation and full page reloads — so you can scope the entire app to one cloud with a single choice. It is intentionally **absent on the three views where it does not apply**: **Multi-Cloud Overview** (already a side-by-side provider split), **Environment Topology**, and **Settings**.

Under the hood, every non-topology KV-Store rollup grain was extended with a `cloud_provider` dimension, so the filter reads straight from the fast rollup tier with no extra query cost. Events with no cloud attribution are counted as `aws` (the same convention Multi-Cloud Overview uses). A Windows Service-Events / PowerShell source-matching fix (`WinEventLog:System` now also matches `XmlWinEventLog:System`) rides along.

!!! warning "Upgrading an existing install — clear the rollups once, then re-backfill"
    This release **changes the rollup grain** (it adds `cloud_provider` to the rollup key), so the previous rollup rows are not overwritten by the new ones — leaving them in place would double-count the "All" view. On upgrade, clear the rollups once and re-seed them: **Settings → Dashboard Data → Clear all rollups**, then **Run backfill** (or let the hourly aggregation refill them over the following day). New installs are unaffected — just run the initial backfill as usual. To upgrade from a build before 282 to the current release, follow [The Work List](../getting-started/upgrading.md#the-work-list).

## :material-circle-box:{ .taiconcolor } Settings readability, Live Activity panel, link-graph restyle (builds 279–281)

Three UX fixes:

1. **Settings readability** — the Settings page, the Dashboard Data panel, and the Audit Log viewer move to a wider field-label column (`clamp(320px, 30%, 520px)`, previously a fixed 200 px) with larger text: 14 px field labels and 13 px hints, intros, and panel subtitles — matching the page-subtitle size.
2. **Environment Topology "Live Activity" panel** — the bottom panel previously clipped mid-row against its zone (its bottom outline never rendered once the partners table outgrew the panel). It now fills its zone exactly, so the panel outline completes at any height; the partners table scrolls internally under a sticky header; the default expanded height grew from 220 px to 300 px; and expanding the collapsed panel raises a smaller saved-layout height up to the default. Saved layouts otherwise keep their persisted heights, and the resize divider now allows up to 640 px.
3. **Sourcetype Mapping link-graph restyle** — the node bars on the two "Source to sourcetype mapping" panels (Data Pipeline Overview and Host Details) were hard to read in dark mode. In dark mode they now use mid-tone fills — blue `#4d9dbf`, hover-path purple `#9c80e4`, each with a slight vertical gradient — with dark-grey labels; in light mode the stock fills stay, gaining the same subtle gradient and white labels.

## :material-circle-box:{ .taiconcolor } Blue-gradient icon set (build 278)

The LogServ product branding moves from orange to the brand **blue gradient** (top `#2276CE` → bottom `#0F55A3`, mid ≈ Cisco `#1870C5`):

1. **App icon** — the "LS" launcher/app-header icon is recolored to the gradient and reshaped to **panel-matched corner radii** (4 px at the 36 px rendered size — the same `border-radius: 4px` token as the dashboard panel cards). The identical icon ships in the Data TA and the Azure/GCP ingest add-ons, so the Splunk launcher renders every LogServ component consistently.
2. **Docs help icon** — the orange "?" affordance in every dashboard title row is repainted with the same gradient: the rotating square outline becomes an SVG rounded-rect with a gradient stroke (same 4 px radius and 12-second spin), and the glyph an SVG gradient-fill text — a form that also renders faithfully in the dashboard PNG/PDF exports.

## :material-circle-box:{ .taiconcolor } AI Assistant — dynamic model discovery (builds 275/276)

Each LLM provider's model picker (the chat panel's per-user picker and the Settings → General `default_model` dropdown) now offers a **live-discovered model list** instead of a fixed hardcoded set:

1. **Curated baseline ∪ vendor-discovered** — the App merges a static curated baseline (always available, even offline) with models discovered from the configured vendor: Anthropic and OpenAI `/v1/models`, **Azure OpenAI deployment discovery** (three-step: `/openai/v1/models` → `/openai/deployments` → the admin's configured deployment names), and **AWS Bedrock** `ListFoundationModels` (Anthropic, on-demand, text, streaming, active models only). Discovery calls are **metadata-only GETs** using the same credential and trust envelope as the existing credential-validation check — no prompt or event data is involved.
2. **Three refresh triggers** — saving a provider credential, a manual **"Refresh model list"** button on Settings → General, and a lazy 24-hour refresh when the chat panel opens. Results cache in the `logserv_ai_models` KV Store collection; every refresh (success or failure) writes a **`model_discovery` audit event** with provider, trigger, model count and duration.
3. **Failures never shrink the picker** — a failed refresh keeps the last-good discovered list and the static baseline is always the floor. A governance toggle (**`model_discovery_enabled`**, default on) disables all vendor listing calls; the pickers then offer the curated baseline only.
4. **Refreshed baselines + honest pricing** — the curated model ids and the vendor cost table used for spend tracking were refreshed to the current model generations. Cost estimates remain **exact-id keyed**: a discovered model with no known price reports $0 rather than a guessed figure.
5. **Azure credential-name fix** — the Azure OpenAI provider now accepts the field names the Settings page actually stores (`endpoint` / `deployment`) in addition to the legacy names (`resource_url` / `deployments`). This also fixes free-form **streaming** for Azure configurations entered through the Settings page.

Model discovery queries the active provider, so it does nothing until a provider credential is configured; in a compile-time templates-only build it is inert and these controls are hidden.

## :material-circle-box:{ .taiconcolor } Environment Topology — star-system Force layout + floating edges (builds 260–277)

The topology view's Force layout and edge rendering were rebuilt:

1. **Star-system layout** — every high-traffic hub (focused SIDs plus secondary SIDs with enough leaf partners) gets its own proportional horizontal slot with partners ringed around it at a radius scaled to partner count; smaller secondary systems anchor as satellites fanned around their nearest hub, and tiny systems ring tighter. The old behavior — multiple large systems piling onto the canvas center — is gone. The layout is **deterministic**: the same data renders the same picture on every load.
2. **Viewport-aware canvas** — the layout world sizes itself to the canvas aspect ratio, and collapsing or expanding the Live Activity panel **re-fits the graph** so it claims or yields the vertical space (previously collapsing just revealed empty canvas).
3. **Floating edges** — edges now run center-to-center as gently bowed curves clipped at each node's visible boundary, so arrowheads land **on the health ring / outline outer edge** instead of under the node box. Bidirectional pairs bow apart and stay separately clickable; labels sit at the curve apex.
4. **Two-mode polish (builds 271–272)** — a light-mode contrast sweep fixed four spots where near-black text landed on colored fills (the Live Activity source pills, the Save/Manage Layouts modal buttons, and the toolbar's active-toggle state), and the panel-toggle re-fit was hardened to measure the canvas live so it stays correct even in throttled background windows.
5. **PNG / PDF export now renders the topology faithfully (builds 273–274)** — the Actions → Download PNG/PDF capture previously dropped every edge (the rasterizer clips svg content to each svg's box, and the flow library draws edges outside an unsized box) and mis-placed the node health rings. The capture now pre-renders the topology's svg layers through the browser's native SVG renderer before compositing, so exported images match the on-screen canvas — edges, labels, arrowheads, and health rings included.
6. **Secondary SAP SID circles enlarged (build 277)** — secondary SIDs now render at **90% of the focused-SID size** (previously ~two-thirds), so smaller SAP systems read clearly at typical zoom levels. Edge arrowhead clipping, the Layered/Tree layout bounding boxes, and the Force layout's collision spacing all scale with the new size. Database-tagged **partner** nodes keep their previous smaller disc — the change applies to SAP SIDs only.

## :material-circle-box:{ .taiconcolor } Cisco Magnetic re-theme — light + dark mode (builds 246–259)

The entire App — all 21 dashboards, the Environment Topology view, Settings, the AI Assistant, the audit-log viewer, and every modal — was restyled to follow the **Cisco Magnetic design system**, with a **user-switchable light / dark mode**:

1. **Sun / moon toggle** in the navigation bar's right cluster. The choice persists per user per browser; the default is **dark** (continuity with the previous look). Both palettes are the real Magnetic "classic" token sets, with the OneCD teal brand accent on navigation-active states and Magnetic interact blue on buttons, links, selection, and focus.
2. **Typography** — the App now bundles and uses **Inter** (body / UI), **Sharp Sans** (display titles), and **Roboto Mono** (code / SPL) with automatic fallback to the platform stack if a font file fails to load. Font attributions ship in `THIRD-PARTY-NOTICES.md` and `LICENSES/`.
3. **Surfaces and chrome** — cyan-outlined dark cards became Magnetic container cards (subtle borders, 4 px radius, flat surfaces, interact-blue hover affordance and focus rings); tables, KPI cards, buttons, chips, banners, tabs, and spinners follow the Magnetic component grammar in both modes.
4. **Charts** — all chart palettes are mode-aware, built on the Magnetic 11-color accent palette and sentiment ramps; chart gradients flatten appropriately in light mode. Tooltips render on the Magnetic inverse surface in both modes.
5. **Fixes shipped inside the arc** — chart tooltips no longer inherit the bar gradient (build 249–251), PDF download works through the App's own download path (build 256), and panel-chrome clicks no longer swallow the chart zoom controls' clicks (build 253).

The dashboards' *content* — every panel, query, and drilldown — is unchanged; this arc is visual only. Documentation screenshots are being refreshed to the new look progressively.

## :material-circle-box:{ .taiconcolor } Next Steps

- Before you upgrade, follow [Upgrading to This Release](../getting-started/upgrading.md).
- What the current release changes: [Release Notes: 0.1.2](release-notes.md).
