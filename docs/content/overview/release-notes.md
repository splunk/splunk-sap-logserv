# Release Notes


## Version 0.1.1 (latest)

### :material-circle-box:{ .taiconcolor } Compatibility

|                                  |                              |
|----------------------------------|------------------------------|
| Splunk platform versions         | 9.4.3 and later              |
| CIM                              | 5.0.0 and later (per `app.manifest`) |
| Supported OS for data collection | Platform independent         |
| Vendor products                  | SAP LogServ for SAP ECS in Amazon Web Services (AWS), Microsoft Azure, and Google Cloud Platform (GCP) |
| Published App artifact           | The **templates-only build variant** — predefined prompts + MCP dispatch fully active; no LLM provider credential required (see [Build Variants](../ai-assistant/templates-only-build.md)) |
| AI Assistant prerequisite        | [Splunk MCP Server (Splunkbase App 7931)](https://splunkbase.splunk.com/app/7931) v1.0.3 or later (v1.1.0+ recommended), on the search head where the LogServ App is installed |
| Azure ingest                     | A dedicated first-party add-on — **Splunk TA for SAP LogServ on Azure** (`splunk_ta_sap_logserv_azure`), installed per Heavy Forwarder |
| GCP ingest                       | A dedicated first-party add-on — **Splunk TA for SAP LogServ on GCP** (`splunk_ta_sap_logserv_gcp`), installed per Heavy Forwarder |

### :material-circle-box:{ .taiconcolor } String-accuracy pass from the zero-trust docs audit (build 334)

Eight string/label defects surfaced by the 2026-08-18 zero-trust documentation audit, all string/comment/conf-level with no logic change: the three Settings-page strings (and two shipped-conf comments) that still named the audit index by its retired pre-rename form now say `logserv_ai_assistant_audit`; the Environment Topology Live Activity caption now reads "Top N busiest edges" (the table lists the busiest edges of any integration type, not just RFC); the Network Perimeter activity chart title no longer claims a log-scale y-axis; the Host Details "Windows Event Codes" subtitle no longer claims a top-15 cap (the table paginates all event codes); the ES Risk Notable's description now says it aggregates the SAP-side detection searches (its SPL reads all of them, not just the original five correlation searches); the two behavioral-anomaly notable descriptions now describe the daily scan of hourly buckets since the start of the previous day instead of "the most recent hour"; the templates-only Settings banner branches on the build flag, so a templates-only build no longer instructs admins to toggle off a mode that is fixed at compile time; and `collections.conf` types the `mcp_timeout_seconds` field so the setting round-trips typed like its sibling fields.

### :material-circle-box:{ .taiconcolor } elkjs license attribution restored in the shipped notices (build 333)

The Environment Topology layout engine `elkjs` (EPL-2.0) has been bundled since the topology's ELK layouts shipped, but its entry was missing from the generated `THIRD-PARTY-NOTICES.md` — the package was never formally declared as a dependency, so the notices generator (which walks the resolved workspace `node_modules`) skipped it. Build 333 declares the dependency properly; the shipped notices now carry the `elkjs@0.11.1` section with the full EPL-2.0 license text (1236 packages, up from 1235). No functional change — the bundled elkjs bytes are identical. See [Third-Party Software](third-party-licenses.md). Found by the 2026-08-18 zero-trust documentation audit.

### :material-circle-box:{ .taiconcolor } Release packaging — templates-only canonical App; all four artifacts at version 0.1.1 (2026-08-18)

The published v0.1.1 App tarball is now the **templates-only build variant** of the current build: the AI Assistant's full predefined-prompt catalog (via the Splunk MCP Server) is fully functional, and the free-form LLM path is **disabled at compile time** — no runtime setting, including a stored `templates_only_mode = 0` from a previous LLM-enabled install, can re-enable it (see [Templates-only Build Variant](../ai-assistant/templates-only-build.md)). The regular, LLM-enabled build of the same source and build number remains available as an archived variant for approved deployments. In the same release pass, the **Data TA was rebuilt** as a canonical 0.1.1 artifact (functionally identical to its predecessor), and the **Azure and GCP ingest add-ons moved from their independent `0.0.6` versioning to `0.1.1`** — their tarball filenames change accordingly (`splunk_ta_sap_logserv_azure-0.1.1.tar.gz`, `splunk_ta_sap_logserv_gcp-0.1.1.tar.gz`) with no functional change. All four artifacts pass AppInspect Cloud-mode precert with 0 errors / 0 failures at their historical baselines.

### :material-circle-box:{ .taiconcolor } Topology top-5 High Traffic SIDs + legend declutter; Data Doctor copy + open-in-search on the rollup SPL (builds 331–332)

In the diagnostic drawer's *Rollup-populating saved searches* section, each printed saved-search definition now carries two corner actions on the SPL block: **copy to clipboard** (copies the definition verbatim) and **open in the Search app**, which opens the SPL in a new browser tab scoped to the diagnosed time window. The opened search has its terminal `| outputlookup` write **removed first** — run verbatim over an arbitrary window, an aggregation search would upsert partial bucket rows over correct summary rows, and the drawer never offers a control that can change data. When the write cannot be removed with certainty the open action is simply not rendered (the copy always is), and a build-time check proves the removal against every shipped aggregation search's definition on every release.

The **High Traffic SID** classification now marks the top **five** SAP systems by total incident calls (was ten since build 324); every other SAP system is **Regular Traffic SID**. Remote partners are unaffected. The ranking mechanics are unchanged — data-derived at render time, SAP systems only, inbound + outbound + bidirectional calls all count — and on an estate with five or fewer systems every SID is still High Traffic.

The partner donuts' legend rows also dropped their per-row **ownership badge** (user feedback: confusing). Because the graph folds every inventory-attributed address into its owner's node, "owner not established" was the only verdict a legend row could ever show — a uniform column of it carried no information. Legend rows now show the endpoint and its call count; ownership badges continue to render where the verdict can actually vary (the Hosts tab rows and the Edge Details "By app server" table), and the underlying inventory is unchanged.

### :material-circle-box:{ .taiconcolor } Environment Topology — hostname + user names on IP endpoints (build 330)

The square partner nodes labelled with raw IP addresses can now say **who and what is behind the address**, straight from the logs. When the evidence exists, a square renders up to two extra lines under its IP — the machine's **hostname**, and a **user line** (the name when exactly one distinct user was seen from that address, a count like "7 users" otherwise, with the full list on hover) — and the Details panel's Overview gains matching rows under the Tag: **Hostname** (with its evidence source), **Users** (every name, grouped by source — HANA audit, Windows logons, SAP start service, SSH sessions) and **Names as of** (how fresh the mapping is). The evidence is same-event only: HANA audit client registrations carry the client host name and the executing DB user next to `client_ip`; Windows **4624 successful-logon** events carry `WorkstationName` and `TargetUserName` next to `IpAddress` (failed logon guesses deliberately claim nothing, and a workstation name is only trusted when it differs from the logging host itself — for interactive and service logons the field names the *local* machine); SAP start service authentication lines carry `user(...)` and the remote address on one line; and Linux `sshd` session lines carry the user and source IP. Ambiguity **suppresses rather than guesses**: a hostname renders only when the IP maps to exactly one machine name (short name + FQDN count as one) and that name is not claimed by a crowd of addresses, and gateway logs are deliberately excluded as a source (their peer-IP and partner-hostname lines never co-occur on one event, so correlating them would be guesswork). The mapping is **"latest known"** — refreshed daily into a new `logserv_topology_ip_enrichment` KV Store collection (folded into the Environment Topology (graph) rollup in Settings → Dashboard Data, so Clear + Backfill cover it) and deliberately not scoped to the time-range picker, so names do not blink out on narrow windows. The build also fixed a self-inflicted deployment lesson worth recording: the new *daily* aggregation search is single-pipeline rather than the usual `| union` shape, because a 30-day daily scan in a union's non-first arms would silently truncate at scale — and its first draft carried a literal `search` prefix, which a *saved* search treats as a search **term** (saved searches prepend search context themselves), silently matching only events containing the word "search"; caught in live verification, fixed before promotion.

### :material-circle-box:{ .taiconcolor } Environment Topology — group select and move (builds 326–328)

The topology canvas now supports moving a whole cluster at once. Hold **Shift and drag** on empty canvas to draw a selection box — every node it touches joins the group and gains a **dashed outline** (deliberately neutral ink, so it can never be misread as a health signal or an edge colour), a status chip at the canvas top-right shows the count, and **dragging any highlighted node moves the whole group rigidly**, edges following their nodes. **Shift/Ctrl/Cmd + click** adds or removes a single node; a **plain click** inspects a node in the Details panel and releases the group; **Escape** or an empty-canvas click clears it; **arrow keys** nudge a focused group; with **Snap mode** on, release applies *one shared* grid offset so the group's shape is preserved. Group moves mark the layout Unsaved and are captured by Save Layout like any drag, including keyboard nudges; the group survives data refreshes and time-range changes. Plain drag on empty canvas still pans — nothing about the existing gestures changed. Group membership is announced to assistive technology (`aria-selected`), keyboard focus regained a visible ring (the imported canvas library removes it), and the canvas's screen-reader instructions were corrected to the real key set. Under the hood the change also retires two latent hazards: the canvas library's **Backspace-deletes-selected-nodes** default is now explicitly disabled, and its built-in selection rectangle — which silently swallowed clicks over the selection's bounding box — is suppressed in favour of the per-node outlines. Adversarially reviewed before implementation (three lenses over the design against the installed canvas-library source; 33 findings including 3 blockers, all folded — among them: the snap pass would have deformed the group by rounding each member independently, a duplicate drag handler would have written NaN positions, and group drags would have rubber-banded through the canvas's 600 ms glide animation). The rendered verification pass then surfaced two follow-up fixes shipped as builds 327 and 328: the HANA-tenant circles' bottom chip had overlapped their health ring since the build-324 tenant redesign (tenants are the one node variant whose name renders inside the disc, so the chip sat directly under the ring at the shared 2 px margin — it now clears at the SID label's 22 px), and Escape initially never cleared the group because Splunk Web keeps a permanently-mounted *hidden* "Disconnected from Splunk server" dialog in the DOM, which the handler's any-dialog guard mistook for an open modal — only a *visible* dialog now owns Escape.

### :material-circle-box:{ .taiconcolor } Environment Topology — High/Regular Traffic SIDs, node icons, host + app-server visibility (builds 324–325)

The SID classification, the node visuals, and two long-standing "what exactly am I looking at" gaps were reworked:

1. **High Traffic / Regular Traffic SIDs** — the classification formerly labelled "Focused SAP SID" is now purely data-derived: the view ranks SAP systems at render time by the **total calls touching them** (inbound + outbound + bidirectional) and marks the top ten **High Traffic**; every other SID is **Regular Traffic**. Only SAP systems compete for the slots — a high-volume client IP can no longer occupy one — and the last hard-coded seed is gone from the aggregation searches (stored rows are classification-neutral; old rows read identically). On estates with ten or fewer systems every SID is High Traffic, by design. Both kinds render at the same large size with the health halo; the Systems-panel highlight now means High Traffic.
2. **Node icons + tenant circles** — every SAP system circle carries an interior icon (an app-server rack for application systems, the database cylinder for database systems), HANA **tenant databases** render as full-size circles with a combined app-servers + database icon and the tag "APP SERVERS - HANA TENANT" (chip: "HANA TENANT"), and horizontal dividers now separate every section in the right panel's tabs.
3. **Host + instance visibility** — hovering a SAP system shows a **Hosts** row (distinct hosts that logged its events in the window), the panel Overview gains a **"Hosts (in range)"** fact, and the Hosts tab lists the SAP **instance numbers** seen on each host (`inst 00, 01`). All three read the same hourly rollup as the Hosts tab itself, so the numbers agree; on a tenant node the count is scoped by the tenant's shared name and the panel says so inline.
4. **RFC per-app-server accuracy** — RFC rollup rows are now keyed **per SID-side gateway listening address** (`local_ip`), fixing a latent last-write-wins collision in which a multi-app-server SID's RFC call counts undercounted whenever two of its app servers served the same partner in the same hour. The Edge Details Overview gains a **"By app server"** table splitting each RFC edge's calls and errors by app-server address, with inventory owner badges. The rows partition the edge's calls, so they sum to the *Calls in window* fact above them.

!!! warning "Upgrading an existing install — the topology graph rollup needs a one-time Clear + Backfill"
    The per-app-server change **re-keys the topology graph rollup's RFC rows**. After upgrading, run **Clear** and then **Backfill** once on **"Environment Topology (graph)"** in Settings → Dashboard Data. Running Backfill *without* the Clear would double-count RFC history (the old collided rows survive next to the new per-app-server rows), and the panel's completeness check will otherwise skip the rollup as already complete. Until the migration runs, RFC calls recorded before the upgrade appear as "(not recorded)" in the By-app-server table and keep the pre-upgrade undercount.

    **The Clear discards topology graph history older than the 30-day backfill window** (the graph retains up to 365 days). On installs older than 30 days, prefer the surgical RFC-only migration, which keeps everything else:

    1. Delete only the collided rows: `DELETE /servicesNS/nobody/splunk_app_sap_logserv/storage/collections/data/logserv_topology_edges?query={"type":"rfc"}` (management port, admin credentials).
    2. Re-run only the RFC arm: from the `[logserv_topology_backfill_edges]` search in `default/savedsearches.conf`, keep the single `sourcetype=sap:abap:gateway` sub-search plus everything after the last `]`, and dispatch it as a normal search over your full raw-data span.

    New installs are unaffected — the standard first-install backfill produces the new keys directly. The Hosts-tab **instance numbers** need no clear: they populate going forward from the hourly aggregation, and a plain Backfill (no Clear) on "Environment Topology (detail tabs)" fills the last 30 days immediately; host rows aggregated before the upgrade simply show no instance list until then.

### :material-circle-box:{ .taiconcolor } Environment Topology — the right panel says what it means (builds 322–323)

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

### :material-circle-box:{ .taiconcolor } Environment Topology — the Edge Details tabs work again (build 321)

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


### :material-circle-box:{ .taiconcolor } Data Doctor — rollup SPL in reports + full-length raw samples (build 320)

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

### :material-circle-box:{ .taiconcolor } Data Doctor — operator-supplied evidence refinements (build 319)

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

### :material-circle-box:{ .taiconcolor } Data Doctor — partial-data diagnosis: blank columns and zero values (build 318)

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

### :material-circle-box:{ .taiconcolor } Data Doctor — deep evidence: cache reconciliation, field probes, clause bisect (build 317)

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

### :material-circle-box:{ .taiconcolor } Data Doctor — operator-supplied ingest evidence (build 314)

The Data Doctor closes its own biggest declared boundary: the Data TA's ingest-tier filters
(include/exclude + days-in-past), which run on the Heavy Forwarder / indexer tier and are
invisible from a search head. The **Platform → Diagnostics** page now prints the exact command
to read them, accepts the pasted output (REST JSON/XML, the generated `local/transforms.conf`,
or the settings conf), credential-scrubs and parses it, and stores it as operator-supplied
evidence. Two new diagnosis verdicts consume it: *"Events this old are discarded at ingest by
design"* (window vs the days-in-past cutoff) and *"`<log type>` events are excluded at ingest
by the configured filter rule `<rule>`"* (the include/exclude reconciliation) — each carrying a
*"Recorded as supplied by \<user\>, \<date\>"* provenance line, hedged when the supply is
stale, approximate or partial, and standing down entirely when observed events contradict it.
Reports gain an "Ingest-tier filters (supplied by operator)" section and a machine-readable
`ingestFacts` block; a paste matching a Heavy Forwarder's shipped-defaults shape is flagged
rather than trusted. One new KV collection (`logserv_diag_ingest_facts`, a fixed single row,
no scheduled searches). See
[Supplying the ingest-filter configuration](../logserv-app/dashboards/platform/diagnostics.md#supplying-the-ingest-filter-configuration).

### :material-circle-box:{ .taiconcolor } Data Doctor: platform snapshot, data coverage, raw samples, drawer polish (builds 315–316)

The Data Doctor's deferred capabilities are now built:

- **Platform health snapshot (Tier B).** A new hourly scheduled search, `logserv_diag_platform_aggregate` (two minutes past each hour), copies scheduler outcomes and skip/deferral reasons, search-concurrency warnings, per-index throughput, pipeline-queue depth and PCRE-limit events from `index=_internal` into the world-readable `logserv_diag_platform_snapshot` KV collection — so a **non-admin** diagnosis can see platform health. The Diagnostics page and the environment report render it as a Platform-health section; when the snapshot is stale, empty or unreadable, the section says **NOT AVAILABLE** with the verified reason rather than guessing. A stale dashboard summary's diagnosis can now carry a scheduler-skip evidence line — always provenance-badged ("recorded by the hourly platform snapshot, a collection any authenticated Splunk user can write") and never able to raise the verdict's confidence. A daily retention search (`logserv_diag_platform_retention`) trims the collection to 30 days. The hourly cron slot was freed by moving the four ES behavioral-anomaly searches from `:02` to `:30` of hours 02–05 (behaviourally neutral — their analysis windows are snapped in SPL).
- **Data coverage in the environment report.** A daily event-volume chart (ASCII, up to the most recent 60 days), the `clz_dir`/`clz_subdir` distribution **with its coverage denominator** (events without the routing metadata are called out, not hidden), and per-host counts.
- **Opt-in raw event samples in the panel report.** The diagnosis drawer's Download PDF gains an "Include raw event samples" checkbox (default off, never sticky): up to 5 recent events of the panel's sourcetype(s), credential-scrubbed and email/user-redacted, truncated to 500 characters _(superseded in build 320 — samples now ship in full up to a 20,000-character ceiling; see above)_, clearly labelled as **not** filtered by the panel's own host/provider selections. The report's cover banner states the samples' presence, and a sample-bearing report is **download-only — never saved** to the Saved-reports list (storing raw events in a world-readable collection would bypass index access controls).
- **The drawer now closes on any route change** — browser Back **and** in-app navigation — closing the long-documented C10 quirk.
- **PDF text fidelity.** The `→` arrow rendered as mojibake in every generated PDF (the standard PDF fonts are cp1252-only); it is now ASCII across every report string, with a permanent build gate preventing regressions.
- The shipped scheduler layout is now verified by a permanent build gate: **every enabled scheduled search occupies its own (hour, minute) slot — zero cron collisions.**

### :material-circle-box:{ .taiconcolor } The LogServ Data Doctor — missing-data diagnostic (builds 306–313)

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

### :material-circle-box:{ .taiconcolor } About dialog — version, build number and build date (builds 302–303)

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

### :material-circle-box:{ .taiconcolor } Stale prompt count removed from the AI Assistant banner (build 301)

The AI Assistant's templates-only banner told users to "run any of the **48** saved searches" — the
catalog actually holds **61** predefined prompts. The count is now gone rather than corrected: the
catalog has grown across releases (40 → 42 → 48 → 61), and a hard-coded number in a user-visible
string goes stale silently. The banner now reads "any of the predefined saved searches".

The same stale count was swept from four other places: the shipped `ai_assistant_settings.conf`
comment (visible to admins via `btool`), two rows in the developer AI Assistant internals reference,
and the architecture page's description of the predefined-prompt path. No behavior change.

### :material-circle-box:{ .taiconcolor } Templates-only build variant now really disables the LLM (build 300)

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
    removed, that is the separate v0.0.6 line.

!!! tip "Upgrading a templates-only deployment"
    No action needed. Because the setting is forced at read time, an existing KV Store row that says
    the LLM path is enabled is overridden automatically. If you later move that deployment to a standard
    build, the LLM path stays off until an admin explicitly re-enables it in Settings — the safe direction.

### :material-circle-box:{ .taiconcolor } After-hours window fix (build 299)

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

!!! warning "Re-run the compliance rollup backfill after upgrading"
    `is_after_hours` is part of the `logserv_compliance_rollup` `_key`, so rows written before this
    build carry the old classification and would not be overwritten by a normal re-aggregation. Use
    **Settings → Dashboard Data → Run backfill** after upgrading.

Two deliberate exceptions are documented in `props.conf` and intentionally left unchanged: the three
Enterprise Security off-hours correlation searches use `hour < 8 OR hour >= 18` (tuned detections
whose notable/risk volume depends on the window), and the `logserv_hana_after_hours_admin` prompt
uses a wider business day (`hour < 6 OR hour >= 20`) as a deep-overnight tripwire — its own
description states that window.

### :material-circle-box:{ .taiconcolor } AI Assistant — configurable MCP request timeout (builds 287–288)

The AI Assistant's browser-side MCP request timeout is now an admin setting instead of a hardcoded 30 seconds. **Settings → AI Assistant → General** gains an **MCP request timeout (seconds)** field (default `60`, range `5`–`600`) that bounds how long the browser waits for each MCP request — tool dispatch, saved-search run, health probe — before aborting it with the `signal is aborted without reason` error. Raise it if a legitimately-slow prompt aborts on a high-ingest instance. It reads per-request from the same KV-Store settings row as the rest of the AI config (`mcp_timeout_seconds`); MCPClient resolves it exactly like `mcp_server_url`. Note this is the browser-side abort — the MCP server (App 7931) has its own separate `mcp.conf [server] timeout` (60s default), so the effective ceiling for any one request is the lower of the two. Build 288/263 adds a **read-only display** of the MCP server's own timeout (App 7931's `mcp.conf [server] timeout`, read cross-app) right beside the client field, so an admin sees both numbers and their relationship at a glance; it degrades to "Not detected" when App 7931 isn't installed. The server timeout stays edited the normal way (that app's `mcp.conf` + a Splunk restart) — it's a different, persistent-process app, so it can't be changed live from our UI.

!!! note "v0.1.1 = the LLM-capable source line — but the published tarball is the templates-only build"
    v0.1.1 is the **LLM-capable** source line, at full feature parity with v0.0.6 — the entire dashboard-performance data-layer rewrite (tstats + KV-Store rollups, backfill panel, staggered schedules), the Azure and GCP ingest add-ons, the three-way Multi-Cloud Overview, the Enterprise Security enable + re-stagger, and every AI Assistant fix (prompt repairs, the MCP time-range fix, rollup-backed host prompts). The source additionally carries the full LLM-driven AI Assistant (four vendor providers, free-form chat, Power Mode, privacy tiers, Provider Credentials). **The published v0.1.1 App artifact, however, is the templates-only build variant** (see the packaging entry above): the LLM path is compile-time disabled in it, and only the separately-built full-LLM variant activates those features. Everything listed under Version 0.0.6 below is included in v0.1.1.

### :material-circle-box:{ .taiconcolor } Cisco Magnetic re-theme — light + dark mode (builds 246–259)

The entire App — all 21 dashboards, the Environment Topology view, Settings, the AI Assistant, the audit-log viewer, and every modal — was restyled to follow the **Cisco Magnetic design system**, with a **user-switchable light / dark mode**:

1. **Sun / moon toggle** in the navigation bar's right cluster. The choice persists per user per browser; the default is **dark** (continuity with the previous look). Both palettes are the real Magnetic "classic" token sets, with the OneCD teal brand accent on navigation-active states and Magnetic interact blue on buttons, links, selection, and focus.
2. **Typography** — the App now bundles and uses **Inter** (body / UI), **Sharp Sans** (display titles), and **Roboto Mono** (code / SPL) with automatic fallback to the platform stack if a font file fails to load. Font attributions ship in `THIRD-PARTY-NOTICES.md` and `LICENSES/`.
3. **Surfaces and chrome** — cyan-outlined dark cards became Magnetic container cards (subtle borders, 4 px radius, flat surfaces, interact-blue hover affordance and focus rings); tables, KPI cards, buttons, chips, banners, tabs, and spinners follow the Magnetic component grammar in both modes.
4. **Charts** — all chart palettes are mode-aware, built on the Magnetic 11-color accent palette and sentiment ramps; chart gradients flatten appropriately in light mode. Tooltips render on the Magnetic inverse surface in both modes.
5. **Fixes shipped inside the arc** — chart tooltips no longer inherit the bar gradient (build 249–251), PDF download works through the App's own download path (build 256), and panel-chrome clicks no longer swallow the chart zoom controls' clicks (build 253).

The dashboards' *content* — every panel, query, and drilldown — is unchanged; this arc is visual only. Documentation screenshots are being refreshed to the new look progressively.

### :material-circle-box:{ .taiconcolor } Environment Topology — star-system Force layout + floating edges (builds 260–277)

The topology view's Force layout and edge rendering were rebuilt:

1. **Star-system layout** — every high-traffic hub (focused SIDs plus secondary SIDs with enough leaf partners) gets its own proportional horizontal slot with partners ringed around it at a radius scaled to partner count; smaller secondary systems anchor as satellites fanned around their nearest hub, and tiny systems ring tighter. The old behavior — multiple large systems piling onto the canvas center — is gone. The layout is **deterministic**: the same data renders the same picture on every load.
2. **Viewport-aware canvas** — the layout world sizes itself to the canvas aspect ratio, and collapsing or expanding the Live Activity panel **re-fits the graph** so it claims or yields the vertical space (previously collapsing just revealed empty canvas).
3. **Floating edges** — edges now run center-to-center as gently bowed curves clipped at each node's visible boundary, so arrowheads land **on the health ring / outline outer edge** instead of under the node box. Bidirectional pairs bow apart and stay separately clickable; labels sit at the curve apex.
4. **Two-mode polish (builds 271–272)** — a light-mode contrast sweep fixed four spots where near-black text landed on colored fills (the Live Activity source pills, the Save/Manage Layouts modal buttons, and the toolbar's active-toggle state), and the panel-toggle re-fit was hardened to measure the canvas live so it stays correct even in throttled background windows.
5. **PNG / PDF export now renders the topology faithfully (builds 273–274)** — the Actions → Download PNG/PDF capture previously dropped every edge (the rasterizer clips svg content to each svg's box, and the flow library draws edges outside an unsized box) and mis-placed the node health rings. The capture now pre-renders the topology's svg layers through the browser's native SVG renderer before compositing, so exported images match the on-screen canvas — edges, labels, arrowheads, and health rings included.
6. **Secondary SAP SID circles enlarged (build 277)** — secondary SIDs now render at **90% of the focused-SID size** (previously ~two-thirds), so smaller SAP systems read clearly at typical zoom levels. Edge arrowhead clipping, the Layered/Tree layout bounding boxes, and the Force layout's collision spacing all scale with the new size. Database-tagged **partner** nodes keep their previous smaller disc — the change applies to SAP SIDs only.

### :material-circle-box:{ .taiconcolor } AI Assistant — dynamic model discovery (builds 275/276)

Each LLM provider's model picker (the chat panel's per-user picker and the Settings → General `default_model` dropdown) now offers a **live-discovered model list** instead of a fixed hardcoded set:

1. **Curated baseline ∪ vendor-discovered** — the App merges a static curated baseline (always available, even offline) with models discovered from the configured vendor: Anthropic and OpenAI `/v1/models`, **Azure OpenAI deployment discovery** (three-step: `/openai/v1/models` → `/openai/deployments` → the admin's configured deployment names), and **AWS Bedrock** `ListFoundationModels` (Anthropic, on-demand, text, streaming, active models only). Discovery calls are **metadata-only GETs** using the same credential and trust envelope as the existing credential-validation check — no prompt or event data is involved.
2. **Three refresh triggers** — saving a provider credential, a manual **"Refresh model list"** button on Settings → General, and a lazy 24-hour refresh when the chat panel opens. Results cache in the `logserv_ai_models` KV Store collection; every refresh (success or failure) writes a **`model_discovery` audit event** with provider, trigger, model count and duration.
3. **Failures never shrink the picker** — a failed refresh keeps the last-good discovered list and the static baseline is always the floor. A governance toggle (**`model_discovery_enabled`**, default on) disables all vendor listing calls; the pickers then offer the curated baseline only.
4. **Refreshed baselines + honest pricing** — the curated model ids and the vendor cost table used for spend tracking were refreshed to the current model generations. Cost estimates remain **exact-id keyed**: a discovered model with no known price reports $0 rather than a guessed figure.
5. **Azure credential-name fix** — the Azure OpenAI provider now accepts the field names the Settings page actually stores (`endpoint` / `deployment`) in addition to the legacy names (`resource_url` / `deployments`). This also fixes free-form **streaming** for Azure configurations entered through the Settings page.

In the published v0.1.1 artifact — the templates-only build — model discovery is inert and these controls are hidden; the feature applies to the LLM-enabled build variant.

### :material-circle-box:{ .taiconcolor } Blue-gradient icon set (build 278)

The LogServ product branding moves from orange to the brand **blue gradient** (top `#2276CE` → bottom `#0F55A3`, mid ≈ Cisco `#1870C5`):

1. **App icon** — the "LS" launcher/app-header icon is recolored to the gradient and reshaped to **panel-matched corner radii** (4 px at the 36 px rendered size — the same `border-radius: 4px` token as the dashboard panel cards). The identical icon ships in the Data TA, the Azure/GCP ingest add-ons, and the Demo Gen TA, so the Splunk launcher renders every LogServ component consistently.
2. **Docs help icon** — the orange "?" affordance in every dashboard title row is repainted with the same gradient: the rotating square outline becomes an SVG rounded-rect with a gradient stroke (same 4 px radius and 12-second spin), and the glyph an SVG gradient-fill text — a form that also renders faithfully in the dashboard PNG/PDF exports.

### :material-circle-box:{ .taiconcolor } Settings readability, Live Activity panel, link-graph restyle (builds 279–281)

Three UX fixes:

1. **Settings readability** — the Settings page, the Dashboard Data panel, and the Audit Log viewer move to a wider field-label column (`clamp(320px, 30%, 520px)`, previously a fixed 200 px) with larger text: 14 px field labels and 13 px hints, intros, and panel subtitles — matching the page-subtitle size.
2. **Environment Topology "Live Activity" panel** — the bottom panel previously clipped mid-row against its zone (its bottom outline never rendered once the partners table outgrew the panel). It now fills its zone exactly, so the panel outline completes at any height; the partners table scrolls internally under a sticky header; the default expanded height grew from 220 px to 300 px; and expanding the collapsed panel raises a smaller saved-layout height up to the default. Saved layouts otherwise keep their persisted heights, and the resize divider now allows up to 640 px.
3. **Sourcetype Mapping link-graph restyle** — the node bars on the two "Source to sourcetype mapping" panels (Data Pipeline Overview and Host Details) were hard to read in dark mode. In dark mode they now use mid-tone fills — blue `#4d9dbf`, hover-path purple `#9c80e4`, each with a slight vertical gradient — with dark-grey labels; in light mode the stock fills stay, gaining the same subtle gradient and white labels.

### :material-circle-box:{ .taiconcolor } Global Cloud Provider filter (build 282)

A persistent **Cloud Provider** dropdown (`All / aws / azure / gcp`) now sits in every dashboard's title row, to the left of the Refresh-interval picker, and filters **every panel** on that dashboard by cloud provider. The selection is **global and remembered per user** — it carries across dashboard navigation and full page reloads — so you can scope the entire app to one cloud with a single choice. It is intentionally **absent on the three views where it does not apply**: **Multi-Cloud Overview** (already a side-by-side provider split), **Environment Topology**, and **Settings**.

Under the hood, every non-topology KV-Store rollup grain was extended with a `cloud_provider` dimension, so the filter reads straight from the fast rollup tier with no extra query cost. Events with no cloud attribution are counted as `aws` (the same convention Multi-Cloud Overview uses). A Windows Service-Events / PowerShell source-matching fix (`WinEventLog:System` now also matches `XmlWinEventLog:System`) rides along.

!!! warning "Upgrading an existing install — clear the rollups once, then re-backfill"
    This release **changes the rollup grain** (it adds `cloud_provider` to the rollup key), so the previous rollup rows are not overwritten by the new ones — leaving them in place would double-count the "All" view. On upgrade, clear the rollups once and re-seed them: **Settings → Dashboard Data → Clear all rollups**, then **Run backfill** (or let the hourly aggregation refill them over the following day). New installs are unaffected — just run the initial backfill as usual.

### :material-circle-box:{ .taiconcolor } Linux + Windows dashboard-chart fixes (build 284)

Two dashboard charts are fixed:

1. **Linux — "SAP Application Activity"** — the chart rendered 26 long `sap_app` / `sap_sid` combinations as a vertical column chart, so the x-axis labels clipped to "…". It is now a **horizontal top-15 bar chart** — each bar is one `sap_app / sap_sid` combination with its full label on the roomy y-axis — ranked by event volume.
2. **Windows — "Critical / Error" KPI + "PowerShell Activity" chart** — both were empty because of query mismatches, not missing data. **PowerShell Activity** now matches any PowerShell source (Windows PowerShell events index as `XmlWinEventLog:Microsoft-Windows-PowerShell/Operational`, and on the AWS S3 path as `WinEventLog:Powershell`). The **Critical / Error** KPI now counts CIM `severity IN ("critical","high")` — Splunk_TA_windows maps Windows Critical (Level 1) → `critical` and Error (Level 2) → `high`, i.e. the severe end of the CIM severity vocabulary.

### :material-circle-box:{ .taiconcolor } AI Assistant — predefined prompts on the rollup tier (builds 285–286)

Twenty-three high-volume predefined prompts are converted from raw index scans to reads of the hourly KV-Store rollups that already power the dashboards. On high-ingest environments (~10M events/day), the raw scans behind prompts like *Source IPs flagged by firewall and/or proxy* exceeded the AI Assistant's 30-second dispatch timeout (the default at the time; now the configurable `mcp_timeout_seconds`, default 60 s) at wide time ranges and failed with "signal is aborted without reason"; the same prompts now complete in well under 2 seconds even over 30 days.

- **Converted prompts** cover firewall, proxy, DNS, Web Dispatcher, ICM, ABAP work-process, Windows logon/lockout, cross-stack authentication, Linux PAM + firewall-agent, HANA failed-auth + trace-severity, Cloud Connector, error categories, and top-systems-by-calls.
- **Five new rollup metrics** back the prompts that had no existing rollup dimension: `pam` + `cgsfw` on the Linux rollup, `wperr` on the Work Process rollup, `denieddest` on the Proxy rollup, and `logon` on the Windows rollup. The Settings → Dashboard Data backfill covers them automatically.
- **Three prompts intentionally report differently:** *Web Dispatcher slow URIs* now ranks by average response time with a per-URI max column (percentiles don't roll up across hourly buckets); *DNS queries to suspected beaconing domains* now uses the DNS dashboards' gap-variance beaconing detection (daily granularity); and the two *cross-stack auth failure* prompts now use the Cross-Stack Authentication dashboard's canonical failure definition, so their numbers match that dashboard.
- Rollup freshness semantics apply: results reflect data through the most-recently-completed hour. Prompt time ranges keep working — the dispatch window bounds the rollup read.
- The prompt catalog (intent map) is at v0.0.12; saved-search and intent-map SPL remain byte-synced.

A follow-up round in the same session fixed four trend prompts that rendered all-zero charts and two ES prompts that still timed out: the MCP server caps tool responses at its default 100-row limit keeping the FIRST rows, so an hourly trend over 30 days (721 rows) displayed only its oldest ~4 days — the ten >100-row time-series prompts now bin adaptively (`bins=90 minspan=1h`: unchanged hourly behavior at short windows, ~30–90 complete-window points at wide ones, totals verified conserved exactly); the after-hours-admin ES prompt's web-traffic join subsearch now reads the sourcetype-mapping rollup (row-identical, and the prompt completes at any window); and the web-dispatcher response-time anomaly is re-expressed on a new per-host hourly `wd_host` web-timing rollup metric as an avg+max z-score (percentiles don't roll up) — its daily scheduled detection drops from minutes of raw scanning to sub-second as well. Intent map at v0.0.13.

## Version 0.0.6

!!! note "v0.0.6 is primarily a dashboard-performance release"
    v0.0.6 keeps the **entire v0.0.5 feature set unchanged** (21 React dashboards + the Environment Topology view, templates-only AI Assistant with 61 canned prompts + audit log, index-time filtering + Deployment Server automation, Cloud Provider attribution, Enterprise Security integration). The headline of this release is a **dashboard data-layer rewrite** that makes the dashboards fast at high event volume; it also adds **Google Cloud Platform as a third ingest channel** (a dedicated per-HF add-on, see below) and reworks Azure ingest onto a dedicated per-HF add-on. Search-time field extractions, sourcetype routing, and all dashboard *content* are unchanged — only how each panel sources its data changed. **No data re-ingest is required to upgrade.**

### :material-circle-box:{ .taiconcolor } Compatibility

|                                  |                              |
|----------------------------------|------------------------------|
| Splunk platform versions         | 9.4.3 and later              |
| CIM                              | 5.0.0 and later (per `app.manifest`) |
| Supported OS for data collection | Platform independent         |
| Vendor products                  | SAP LogServ for SAP ECS in Amazon Web Services (AWS), Microsoft Azure, and Google Cloud Platform (GCP) |
| AI Assistant prerequisite        | [Splunk MCP Server (Splunkbase App 7931)](https://splunkbase.splunk.com/app/7931) v1.1.0 or later, on the search head where the LogServ App is installed |
| Azure ingest                     | A dedicated first-party add-on — **Splunk TA for SAP LogServ on Azure** (`splunk_ta_sap_logserv_azure`), installed per Heavy Forwarder — ingests Azure Blob via Event Grid → Storage Queue notifications (Azure deployments only; SAP provisions the queue + SAS) |
| GCP ingest                       | A dedicated first-party add-on — **Splunk TA for SAP LogServ on GCP** (`splunk_ta_sap_logserv_gcp`), installed per Heavy Forwarder — ingests Google Cloud Storage via Pub/Sub `OBJECT_FINALIZE` notifications (GCP deployments only; SAP provisions the subscription + service-account key) |

### :material-circle-box:{ .taiconcolor } The problem this release solves

At a customer's reported scale (~10.7M events / 24 h, ~321M over 30 days) the 21 non-Topology dashboards took **over 10 minutes** to populate. Each panel dispatched its own raw, search-time-extraction full-scan with no shared base search, no `tstats`, and no acceleration. (The Environment Topology view was already fast — it had been moved to a KV-Store-backed data layer in v0.0.5.)

### :material-circle-box:{ .taiconcolor } New data architecture — two tiers

Every dashboard panel was re-tiered onto the cheapest *correct* data source and byte-exact-verified against the original raw SPL. The result is a **two-tier data layer** — no Common Information Model (CIM) acceleration is required.

1. **`tstats` on indexed dimensions** — pure count / average panels (Data Pipeline Overview, Host Details, the Environment Health pipeline panels, Multi-Cloud Overview, and the count KPIs across the suite) read via `| tstats` over the already-indexed `WRITE_META` fields. A new `default/fields.conf` declares `INDEXED = true` for `clz_dir` / `clz_subdir` / `splunk_solution` / `cloud_provider`.
2. **KV-Store precompute rollups** — every other high-volume panel reads from a set of **hourly-aggregated KV-Store rollup collections** (`logserv_*_rollup`; later builds added more — the Settings → Dashboard Data tab lists the current inventory). Scheduled saved searches (`logserv_*_aggregate`, hourly on staggered per-search minutes — see [Scheduled-search schedule](../logserv-app/dashboards/performance.md)) precompute each panel's data; the dashboards read it back filtered by a `bucket_ts` range driven by the global time-range picker. Streamstats / per-event-listing panels that cannot be rolled up stay raw (capped with `| head N` where they are time-ordered listings).

Cached reads are uniformly **~0.1–0.6 s** versus 10 s – 19 min raw (speedups of **64× – 5,358×**), validated at 335M events on the test fleet. **Data freshness on the rolled-up panels is hourly** — the same trade-off the Environment Topology view already made. See [Dashboard Performance & Data Freshness](../logserv-app/dashboards/performance.md) for the full picture and the one-time backfill step.

!!! info "No CIM data-model acceleration needed for dashboards"
    An interim build had the four HTTP / DNS / proxy dashboards (Proxy, Web Dispatcher, Cloud Connector, DNS Analytics) read from CIM accelerated data models. That approach was **removed** before this release: when a customer had not accelerated those models (the common case), the queries fell back to a raw full-scan — exactly the slowness this release set out to fix. Those four dashboards now read dedicated KV-Store rollups, so they are fast regardless of the customer's CIM-acceleration state. The LogServ App's CIM *tagging* (eventtypes + tags) for **Enterprise Security** correlation is unaffected — see [Enterprise Security → CIM Compliance](../enterprise-security/cim-compliance.md).

### :material-circle-box:{ .taiconcolor } New features

1. **"Run backfill" — Dashboard Data settings tab** — a new **Settings → Dashboard Data** tab seeds the rollup collections on first install. It dispatches each rollup's aggregation searches as **top-level jobs** (immune to the subsearch wall-clock limits that truncate a bundled backfill at high volume), with a progress bar, completeness banner, and per-rollup status. Idempotent and resumable. **An admin clicks this once after installing on a high-volume instance** to populate dashboard history immediately; otherwise the hourly aggregation seeds history going forward. See [Dashboard Performance & Data Freshness → Backfilling on first install](../logserv-app/dashboards/performance.md#backfilling-on-first-install).
2. **365-day cache retention** — all rollup-retention searches keep a full year of rolled-up history. The install backfill seeds 30 days; the cache then grows to a year organically via the hourly aggregation (seed-and-grow).
3. **Per-panel action toolbar** — every chart and table panel header now carries **Open in Search · Download (CSV) · Inspect (Job Inspector) · Refresh** plus a "&lt;1m ago" last-run stamp. KPI single-value cards get the loading spinner but no toolbar.
4. **Universal loading spinner** — every chart / table renders the orange-dot spinner + "Loading data…" while its search is in flight (KPI cards show a small spinner instead of a dash), replacing the old plain "Loading…" text.

### :material-circle-box:{ .taiconcolor } Role Activity + Sourcetype Mapping performance (build 243)

The last two raw-scan panel groups were moved onto KV-Store rollups so they stay fast at high event volume:

1. **Sourcetype Mapping** (Host Details → Sourcetype Mapping tab + Data Pipeline Overview → Linked Graph) now reads a new `logserv_stmap_rollup` with **`source` normalized** (UUIDs, dates, and long digit-runs stripped to collapse per-day / per-tunnel variants into logical sources). This cut the search from **~50 s to ~2 s** over a 30-day window and the graph from 4,000+ nodes to a few hundred. **User-visible change:** the graph now shows normalized logical sources (e.g. one `…/audit-log_<id>_<date>.csv` node) instead of one node per tunnel-UUID per day.
2. **Role Activity** (Host Details → Role Activity tab) — the 7 per-host breakdown panels now read a new `logserv_hostrole_rollup` (metric discriminator), reproducing the same value / count / percent breakdown **byte-exact**, ~8× faster. No visible change.

Adds 2 rollup collections (24 → 26 hourly aggregates; 24 → 26 retention searches) — fully within the existing staggered schedule (now `:03`–`:28` aggregates / `:30`–`:58` daily).

### :material-circle-box:{ .taiconcolor } Scheduling & Enterprise Security (build 242)

1. **Enterprise Security content shipped disabled by default.** _(Superseded in build 249 — the ES content now ships **enabled** by default; see the build-249 note below.)_ In build 242 all 22 `splunk_sap_logserv_es_*` saved searches shipped with `disabled = 1`. The ES content is dual-mode (it targets the ES Notable / Risk / Asset & Identity frameworks and CIM data models that no-op without ES installed) and no dashboard reads any ES output. See [Enterprise Security → The ES schedule](../enterprise-security/overview.md#the-es-schedule-collision-free).
2. **Scheduled searches re-staggered into three non-overlapping bands** — the 24 hourly rollup aggregates spread one-per-minute across `:05`–`:28` (was all at `:05`), retention + the 2 daily beaconing aggregates moved to an off-peak `:30`–`:58` band, and the (disabled) ES searches re-croned to the back of the hour. No two enabled scheduled searches share an `(hour, minute)`, eliminating the previous `:05` burst and two same-minute collisions. Dispatch windows are unchanged, so data freshness is unaffected. See [Dashboard Performance & Data Freshness → Scheduled-search schedule](../logserv-app/dashboards/performance.md#scheduled-search-schedule).

### :material-circle-box:{ .taiconcolor } Enterprise Security enabled by default + AI Assistant prompt rework (build 249)

1. **The 22 `splunk_sap_logserv_es_*` searches now ship enabled by default**, reversing build 242's disabled-by-default decision. They run on a re-staggered, **collision-free** schedule (no two enabled scheduled searches share an `(hour, minute)`): 16 correlation searches hourly in the disjoint minutes `:29` / odd `:31`–`:59`, the 2 Asset/Identity feeds every 4 hours at `:00` / `:01`, and the 4 behavioral-anomaly searches once **daily** at `:02`. To fit the collision-free schedule, eight correlation searches that ran every 5–15 minutes now run hourly (with matched 65-minute dispatch windows), and the four anomaly searches run daily instead of hourly — a daily run still evaluates every hourly bucket of the prior day, so no detections are missed. The content stays dual-mode (`action.notable` / `action.risk` no-op without ES). To disable or re-tune, see [Enterprise Security → Disabling or tuning the ES content](../enterprise-security/overview.md#disabling-or-tuning-the-es-content).
2. **The 13 ES AI Assistant Security-pack prompts were reworked to function as interactive prompts.** Dispatched by name, they had been erroring on click ever since build 242 disabled their searches; enabling the searches fixes that, and the SPL was repaired — the `anomaly_topology_edge_volume` FATAL `inputlookup … where` error, the dead-constant `is_business_hours` / `is_weekend` off-hours fields (replaced with inline `_time`-based logic), the `service_account_interactive` field bug, and the structurally-empty `after_hours_admin_data_access`. The three 30-day anomaly prompts were converted to a daily cadence. Intent map bumped to v0.0.11.

### :material-circle-box:{ .taiconcolor } Dependency security hygiene — react-router 7.18.1 (build 252)

Bumped `react-router-dom` from 7.14.2 to **7.18.1** (patched line) so dependency / SCA scanners no longer flag the App against [GHSA-4hjh-wcwx-xvwj](https://github.com/remix-run/react-router/security) — a `__manifest`-endpoint DoS in react-router 7.0.0–7.14.x. **The App was never exposed to it:** it is a client-side single-page app served as static assets by Splunk Web and routed entirely by `<HashRouter>` (Declarative Mode, which the advisory explicitly exempts), with no React Router / Remix server runtime and therefore no `__manifest` endpoint. This is a hygiene bump only — no behavior change (routing was re-verified live across the index, settings, dashboard, and topology routes with zero errors).

### :material-circle-box:{ .taiconcolor } Whole-estate AI Assistant host prompts moved onto a KV-Store rollup (build 251)

Four predefined prompts scan the **entire estate** by host — *Top hosts by event volume*, *Noisiest hosts trend*, *Distinct hosts seen*, and *Hosts with the biggest event-volume drop*. They were raw `| top host` / `dc(host)` / per-host-timechart full-scans, so on a large dataset they exceeded the AI Assistant's 30-second request timeout at wide windows (e.g. *Top hosts* at −30 days took > 150 s and aborted with *"signal is aborted without reason"*). Build 251 rewrites all four to read from the existing `logserv_hostdetails_rollup` KV-Store rollup (hourly `(host, bucket)` counts), so each returns **sub-second** at any window — measured −30 d went from > 150 s (abort) to 0.6 s, and the dropdown window still drives the result. The reads are **byte-exact** to the original SPL (the rollup uses the same search-time `host` field, so the displayed hosts and counts are unchanged), and the rollup is the one that already powers the Host Details dashboard (no new collection or scheduled search). On a fresh install the prompts populate older windows once the [Dashboard Data backfill](../logserv-app/dashboards/performance.md) has run, the same as every dashboard. See [Predefined Prompts](../ai-assistant/predefined-prompts.md).

### :material-circle-box:{ .taiconcolor } AI Assistant prompt time-range dropdown now bounds the search (build 250)

The **Time range** dropdown in the AI Assistant's "Browse predefined prompts" window (Last 1h … Last 30d) now actually bounds the dispatched saved search. Previously the selected window was silently dropped, so every predefined prompt ran **unbounded over the whole index** through the Splunk MCP Server — on a large dataset this took minutes and the prompt timed out client-side with *"Error: signal is aborted without reason."* The fix flattens `earliest_time` / `latest_time` to the MCP `run_saved_search` tool's top-level arguments (where App 7931 expects them) instead of nesting them under an ignored `arguments` object. No fixed window is baked into the saved searches — the dropdown drives the time range end-to-end, and both the canned-prompt path and the AI-driven path are fixed. See [Predefined Prompts](../ai-assistant/predefined-prompts.md).

### :material-circle-box:{ .taiconcolor } Azure queue-driven ingest (dedicated add-on)

Azure ingest is the Azure twin of `Splunk_TA_aws`'s SQS-Based S3 input, and ships as a **dedicated, first-party Heavy-Forwarder add-on — Splunk TA for SAP LogServ on Azure (`splunk_ta_sap_logserv_azure`)**, installed per-HF (not via the Deployment Server). Its **`sap_logserv_azure_queue`** modular input consumes Azure **Event Grid → Storage Queue** `BlobCreated` notifications, fetches each LogServ blob over a SAS, and emits its NDJSON via the native EventWriter, so events flow through the Heavy Forwarder's index-time pipeline and reuse the LogServ Data TA's existing sourcetype routing, Filters `nullQueue`, `_time` drop, and `cloud_provider` / `splunk_solution` stamping unchanged (it emits `sourcetype = sap_logserv_logs` and stamps `_meta = cloud_provider::azure`). It is **stdlib-only** (no Azure SDK, Splunk Cloud-clean) and inert until an input instance is configured. This is the model SAP's LogServ-on-Azure collector uses (Storage Queue notifications), and it **replaces the Splunkbase-add-on polling approach** the original v0.0.5 Azure support used. Installing the input on the forwarder tier — with the SAS in the add-on's own `local/`, never Deployment-Server-managed — makes Azure ingest **symmetric with AWS** and removes the per-host-secret-inside-a-DS-app fragility of earlier v0.0.6 iterations (the old `system/local` SAS dance + `sas_token = ******` bundle invariant are gone). Per-instance `index` and `event_sourcetype` (both default `sap_logserv_logs`) let one HF run multiple Azure inputs. Per-HF install + input configuration are documented in [SAP LogServ on Azure — Setup Guide](../install-setup/azure-setup.md). AppInspect Cloud posture: 0 errors / 0 failures / 0 future_failures (the add-on's stdlib-only modular input adds no gating findings; the input-removed Data TA returns to its 11-warning baseline).

### :material-circle-box:{ .taiconcolor } Multi-Cloud Overview goes three-way + Data TA `gcp` dropdown (build 253)

Alongside the GCP add-on (below), the **Multi-Cloud Overview** dashboard was upgraded from a hardcoded two-provider layout to a full **AWS / Azure / GCP** split: a new **GCP Events** KPI + sparkline (the KPI row is now Total / AWS / Azure / GCP), a GCP column in the Top Sourcetypes table, and provider-neutral labels. This also fixes a latent bug for third-provider data: the Top Sourcetypes query hardcoded `Total = AWS + Azure`, which would have silently excluded `gcp`-attributed counts from the Total (single- and dual-cloud installs were unaffected — verified that a window with zero GCP rows still renders `GCP = 0` with a correct Total). The dashboard's "About the cloud_provider field" reference panel was rewritten (it still described a retired Azure ingest mechanism and linked to a non-existent in-app help URL; it now links to the published Azure/GCP Setup Guides). The **Data TA's Configuration → Cloud Provider dropdown gains "Google Cloud Platform"** (`cloud_provider = gcp`) as a fourth choice — see [Configuring Filters → Cloud Provider Attribution](../install-setup/configure-filters.md#cloud-provider-attribution).

### :material-circle-box:{ .taiconcolor } GCP notification-driven ingest (dedicated add-on)

Google Cloud Platform joins AWS and Azure as a first-class ingest channel, via a **dedicated, first-party Heavy-Forwarder add-on — Splunk TA for SAP LogServ on GCP (`splunk_ta_sap_logserv_gcp`)**, installed per-HF (not via the Deployment Server). Its **`sap_logserv_gcp_pubsub`** modular input pulls a **Pub/Sub subscription** fed by the LogServ GCS bucket's `OBJECT_FINALIZE` notifications, fetches each object with a Google **service-account key**, gunzips it, and emits its NDJSON via the native EventWriter — so events flow through the Heavy Forwarder's index-time pipeline and reuse the LogServ Data TA's existing sourcetype routing, Filters `nullQueue`, `_time` drop, and `cloud_provider` / `splunk_solution` stamping unchanged (it emits `sourcetype = sap_logserv_logs` and stamps `_meta = cloud_provider::gcp`). This is the same notification-driven model SAP's own LogServ-on-GCP collector uses, and the same deployment shape as the Azure add-on. It is **stdlib-only** — Pub/Sub + GCS REST over `urllib`, with a pure-Python OAuth2 service-account token exchange (no Google SDK, no vendored dependencies) — so it is Splunk Cloud-clean and adds no third-party attributions. The general-purpose Splunk Add-on for Google Cloud Platform (Splunkbase 3088) was evaluated and does not fit: as of v5.0.3 its Pub/Sub-based bucket input cannot decompress the gzipped LogServ objects. The service account needs exactly the two roles SAP documents for its own forwarder (`roles/pubsub.subscriber` on the subscription + `roles/storage.objectViewer` on the bucket). Per-HF install + input configuration are documented in [SAP LogServ on GCP — Setup Guide](../install-setup/gcp-setup.md). AppInspect Cloud posture: 0 errors / 0 failures / 0 future_failures.

### :material-circle-box:{ .taiconcolor } Changed (user-visible panel shapes)

A few panels changed shape as a consequence of reading from hourly rollups instead of raw events:

1. **All response-time charts now show Avg + Max by hour instead of p50 / p95 / p99 percentiles.** Averages and maxima roll up byte-exact across hourly buckets (Avg = Σsum ÷ Σcount, Max = max-of-per-bucket-max); percentiles cannot be merged across buckets. Affects Web and API Performance ("Response Time (Avg / Max) Over Time", and the "Slow URIs / Slow Clients" tables now show a **Max (ms)** column in place of p95) and HANA Trace ("Operation Duration (Avg / Max)").
2. **HANA Trace "Slowest SQL Operations"** is now a top-operations-by-max-duration table (operation, max ms, avg ms, event count) — the per-event `_time` / host columns cannot survive an aggregate.
3. **Web Dispatcher "URIs by Request Count"** dropped its "Unique Clients" column (a 3-dimension grain would explode at scale).
4. **Panels that remain raw** (and are therefore unaffected): Network Perimeter "Suspicious Activity Indicator", the DNS / Network-Perimeter beaconing tables, Web Dispatcher "Slowest Request Traces", and Cloud Connector "Audit Log" — streamstats / per-event listings that cannot be rolled up byte-exact. (The beaconing and Slowest-Traces panels are now backed by per-day / per-hour rollups so they stay responsive to the time-range picker.)

### :material-circle-box:{ .taiconcolor } Fixed issues

While re-expressing panels, three pre-existing display bugs (all string-vs-number / `match()`-in-base-search predicate mistakes that silently returned 0) were found and fixed:

1. **Cloud Connector HTTP Error Rate** — the KPI compared a string `is_error` field against the number `1` and was stuck at 0%; re-expressed as the `status >= 400` fraction (now ~7.3% on test data).
2. **Change & Configuration "Password Change" / "User Change" KPIs** — a Linux `match(_raw, …)` clause sat in base-search position where `match()` (eval-only) silently no-ops; moved to a post-base `| where`.
3. **`icm_is_error` predicate** — the same string-vs-number trap (`icm_is_error = 1` vs the field's string `"true"`) in the Environment Health severity rollup and the `logserv_top_error_categories` AI prompt; fixed to `= "true"`.

### :material-circle-box:{ .taiconcolor } Third-party software attributions

`THIRD-PARTY-NOTICES.md` was refreshed for v0.0.6 and now lists **1236 unique top-level npm packages** (adds `elkjs@0.11.1`, EPL-2.0, used by the Environment Topology layout engine — previously omitted). The file is generated deterministically from the build's `node_modules/` tree by `yarn build`, shipped at the root of the installed app directory and mirrored at the GitHub source-tree root, alongside the CycloneDX 1.4 `SBOM.json`. See [Third-Party Software](third-party-licenses.md).

### :material-circle-box:{ .taiconcolor } Known issues

1. The hourly rollup data layer means rolled-up panels are accurate to the most-recently-completed hour; sub-hour time-range selections (e.g. "Last 15 minutes") read from the hourly buckets and so reflect completed hours rather than the live partial hour. Use the raw Search app (via the per-panel **Open in Search** toolbar action) for live sub-hour investigation.
2. On a fresh install at high event volume, dashboards show empty until the first hourly aggregation runs or an admin runs the **Dashboard Data → Run backfill** step.


## Version 0.0.5

!!! warning "AI Assistant LLM functionality intentionally disabled pending review"
    The v0.0.5 release ships with the AI Assistant's **LLM-driven path disabled at compile time pending internal review** of the OWASP LLM Top 10 controls. Every customer running v0.0.5 runs the **templates-only build variant** — there is no separate "regular" build published in this release. What's still active: the predefined-prompt path (61 canned prompts via the Splunk MCP Server), tool tiles in the right pane, drill-down chips, audit log, all 21 dashboards + the Environment Topology view, per-dashboard auto-refresh picker, Download PNG. What's disabled: free-form chat input, the model picker, the Power Mode toggle, the Provider Credentials Settings tab, and all vendor (Anthropic / OpenAI / Azure / Bedrock) traffic. The LLM-driven path will be re-enabled in a future release once review concludes — the type-system enforcement, privacy tiers, and OWASP Top 10 hardening are designed and implemented, just gated off via the build flag for now. See the **AI Assistant → Templates-only Build** docs page and the **AI Assistant → OWASP LLM Top 10 Compliance** page for the full picture.

### :material-circle-box:{ .taiconcolor } Compatibility

|                                  |                              |
|----------------------------------|------------------------------|
| Splunk platform versions         | 9.4.3 and later              |
| CIM                              | 5.0.0 and later (per `app.manifest`) |
| Supported OS for data collection | Platform independent         |
| Vendor products                  | SAP LogServ for SAP ECS in Amazon Web Services (AWS) and Microsoft Azure |
| AI Assistant prerequisite        | [Splunk MCP Server (Splunkbase App 7931)](https://splunkbase.splunk.com/app/7931) v1.1.0 or later, on the search head where the LogServ App is installed |
| Azure ingest                     | A dedicated first-party add-on — **Splunk TA for SAP LogServ on Azure** (`splunk_ta_sap_logserv_azure`), installed per Heavy Forwarder — ingests Azure Blob via Event Grid → Storage Queue notifications (Azure deployments only; SAP provisions the queue + SAS) |

### :material-circle-box:{ .taiconcolor } Major architecture change

**The LogServ App is fully rewritten as a React-based application.** Dashboard Studio v2 is no longer used for any of the 21 dashboards. The app now ships as a single React bundle built on `@splunk/react-ui`, `@splunk/visualizations`, and `@xyflow/react`. The Data TA architecture is unchanged from v0.0.4.x — only the UI App tier has been rewritten.

Implications for upgraders:

  - **Search-time field extractions are unchanged** — your existing custom searches, alerts, and reports against `sap_logserv_logs` continue to work without modification.
  - **Dashboard URLs have changed** — old DS v2 deep links (`/app/splunk_app_sap_logserv/<view>?form.global_time...`) are replaced with React Router hash routes (`/app/splunk_app_sap_logserv/home#/<route>?earliest=...&latest=...`). Time-range query params are preserved.
  - **Splunk 9.4.3+ remains the minimum** version. No new floor.
  - **No data re-ingest required** — the upgrade is UI-only.

### :material-circle-box:{ .taiconcolor } New features

1. **AI Assistant** — Splunk-aware chat panel with two paths:

      - **Predefined prompts** (no LLM call): browse 61 saved searches across three packs (`sap_basis` 15, `security` 28, `operations` 18) plus a context-aware **Dashboard Focused** tab that auto-filters to prompts relevant to the current dashboard. Each prompt dispatches via the [Splunk MCP Server](https://splunkbase.splunk.com/app/7931) and renders a tile in the right pane with a static interpretation + suggested-next-steps card. **No vendor LLM is involved in this path.**
      - **Free-form prompts** (LLM-driven): the same MCP tool path is available to one of four AI providers (Anthropic, OpenAI, Azure OpenAI, AWS Bedrock); the LLM picks tools, the orchestrator dispatches, and the LLM synthesizes a narrative response. **Critical privacy invariant — enforced by the TypeScript type system at build time, not by policy: no event data from your Splunk instance is ever transmitted to any AI vendor.** The compiler refuses to put any tool-result value into the outbound payload — there is no runtime check, no flag to flip.

2. **Three privacy tiers** for the free-form path, admin-selectable in Settings:

      - **Tier 0** — Ollama-based local-only (future release).
      - **Tier 1 (default)** — cloud LLM as SPL generator. Tool result summary fed back is *only* `count + timing`. The AI sees no row data and no aggregates.
      - **Tier 2 (admin opt-in)** — adds aggregated metadata: cardinality, per-column top-N values + counts, min/max/avg/sum (numeric), and time range. Still no raw rows.

3. **Environment Topology** — graph-based view of SAP systems, integration partners, and endpoints. Built on `@xyflow/react` with a force-directed initial layout, self-derived IP→SID inventory drawn from multiple SAP sourcetypes (gateway L=, HANA tracelogs, ICM peer fields, saprouter peer hostnames), per-node sidebar tabs (Programs, Calls/Hr, Errors, Hosts), and named saved layouts persisted via Splunk KV Store (schema v4 — viewport zoom + pan + enabled-types + selected-node + active-tab + snap-mode). Data is refreshed hourly by three scheduled saved searches; manual Refresh button in the toolbar for on-demand re-fetch.

4. **Drill-down chips** — every tool result tile in the AI Assistant's right pane carries a `↗ Dashboard` chip (when a related OOTB dashboard is mapped) and a `↗ Run SPL` chip that opens Splunk's Search app with the dispatched SPL pre-populated and the dispatch's exact earliest/latest pre-applied. Same chips render alongside `[→ saved_search]` citations in the chat narrative on the left pane. Dashboards themselves also got drill-downs: ~70 KPIs / charts / tables / table rows across 19 dashboards open contextual cross-cutting searches with current time range preserved.

5. **Per-dashboard auto-refresh picker** — every dashboard's title row now carries a Refresh picker (Never / 30s / 1m / 5m / 15m / 30m / 1hr) with per-user-per-dashboard cadence persisted to a new KV Store collection (`logserv_dashboard_refresh`). All charts and KPIs re-run on each tick via a shared context nonce.

6. **OWASP LLM Top 10 (2025) compliance** — every item has a matching control. Highlights: prompt-injection sanitization with role-marker + jailbreak-pattern filtering; type-bounded data redaction; a CycloneDX 1.4 SBOM shipped with every build; tamper-evident audit log with optional HEC forwarder; per-user rate limit (configurable, default 30/hr); USD spend cap; SPL static-analysis guard blocking write/delete/alert operators; PII redaction for `email` / `user(name)` / `*_ip` / `mac` / `account` (hostname opt-in); session tool-call cap; jailbreak pattern detection on user input. See [OWASP LLM Top 10 Compliance](../ai-assistant/owasp-llm-compliance.md) for the full controls list per item.

7. **Templates-only build variant** — a deployable variant of the LogServ App that disables the LLM-driven flow at compile time. The MCP path + 61 canned prompts + tool tiles + drill-down chips + audit log all stay fully active so the solution can be demonstrated end-to-end without enabling any LLM provider. UI cues: chat input disabled with explanatory placeholder; Send button disabled; model picker hidden; Power Mode toggle hidden; Provider Credentials Settings tab hidden; cyan info-tone banner explains the build mode. Defense in depth: the LLM dispatch entry point bails immediately with a system notice if reached at runtime.

8. **Power Mode** — role-gated `✦ Power` toggle in the AI Assistant chat input. Admin assigns a list of Splunk roles (via `services/authorization/roles`) that may see the toggle; when on, every prompt forces a saved-search dispatch before LLM synthesis (forced-RAG). State persists per-tab in sessionStorage. Audit events tag the toggle state for SOC pivot analysis.

9. **TIME-WINDOW REASONING primer rules** — the AI Assistant's system primer (Tier 1 + Tier 2) now teaches the LLM to: (a) identify the dispatch window before claiming severity, (b) normalize cumulative count to events/hour or events/day before ranking, (c) for any finding ranked `[severity:high]` or `[severity:critical]`, dispatch ONE additional verify query with `earliest=-24h latest=now` BEFORE writing the narrative, and (d) state the window precisely in narrative ("X events in the last 24h" vs. "X cumulative over the search's rolling window"). The result: the AI now self-corrects in one turn instead of needing a follow-up prompt to re-rank cumulative-noise findings.

10. **HostDetails multi-host filter + 3-tab layout** — the Host Details dashboard's host picker is now a `Multiselect` with filter input + Select-All-Matches semantics. Multi-host scope is reflected in URL (`?hosts=h1,h2,h3`) with localStorage persistence. SPL builders splice a `host IN (...)` clause when 2+ hosts are selected. Three tabs: **Overview** (5 KPIs + charts + Host Inventory + Severity Timeline), **Role Activity** (7 role-specific panels with `hideWhenNoData`), **Sourcetype Mapping** (Sankey of source → sourcetype).

11. **Data Pipeline Overview dashboard-wide host filter** — Multiselect + Top-N picker lifted from the chart-level actions slot to the dashboard's title row. Filter scope expanded from one chart to all 4 KPIs + 4 panels + the Sourcetype Mapping linked graph on the second tab.

12. **Path B sourcetype migration** — the legacy `[set_srctype_for_syslog]` transform has been split into four dedicated routing transforms producing four new sourcetypes: `linux:cron`, `linux:warn`, `linux:sudolog`, `linux:slapd`. This clears the AppInspect pretrained-sourcetype warning and avoids field-extraction collisions with `Splunk_TA_nix`'s built-in `[syslog]` stanza. Existing `sourcetype=syslog` data ages out per index retention; dashboards OR both old + new during the transition.

13. **Branded LS app icons** — orange "LS" mark on a dark rounded-square frame. Both the UI App and the Data TA ship the same icon set at 36×36 + 72×72 in regular + Alt variants.

14. **Splunk-pattern legal acknowledgement** — two compile-time legal/liability modals gate the master `enabled` toggle and the audit-forwarder-disabled save (matching Splunk's `splunk_instrumentation` `optInVersion` framework). User identity, Splunk-stamped IP, timestamp, and a SHA-256 of the disclaimer revision are recorded in the audit log so subsequent acknowledgement reviews can prove which revision was acknowledged.

### :material-circle-box:{ .taiconcolor } Enhancements

1. **21 React-based dashboards plus the new Environment Topology view** — every one of the 20 v0.0.4.2 dashboards is a fresh React implementation, a new Multi-Cloud Overview dashboard was added (21 dashboards in total), and the Environment Topology view is a new graph-based surface unique to v0.0.5. All dashboards use the unified dark theme (`#0d1117` page background, `#141b2d` panel fill, `#0877a6` panel outline) and ship the per-dashboard auto-refresh picker.
2. **Saved-Layout schema v4** — the topology view's saved layouts now persist viewport (zoom + pan), enabled integration types, selected node, active right-sidebar tab, and snap-mode in addition to the v3 node + panel positions. Schema migration is in-memory: v1 / v2 / v3 records still load.
3. **`Multiselect` + `Top-N` picker** as a reusable title-row pattern — labelless inline cluster matching the visual idiom across HostDetails and Data Pipeline Overview.
4. **AI Assistant prompt browser tab persistence** — the last selected pack tab is remembered across modal-open events, persisted per-tab via sessionStorage. Persists only when the user actually picked a prompt, not on casual tab-flipping.
5. **Static guidance card per canned prompt** — each predefined prompt's intent-map entry includes an `interpretation` paragraph + bulleted `nextSteps`. Surfaced as a "How to read this result" card after the tool tile lands. Skipped on the AI-driven path (the LLM writes its own commentary). 126 next-step entries split: 64 plain · 57 canned-prompt links · 5 custom-SPL links.
6. **Dashboard Focused prompt browser tab** — first-position tab in the prompt browser that filters the 61 prompts down to those mapped to the current dashboard. Auto-hides when no prompts match. Pack-origin chips on each card so users can find the prompt back in its home pack.
7. **Audit Log Settings tab** — read-only browser of the `logserv_ai_assistant_audit` index with time-range / category / user / limit filters; per-row JSON expand. Inline disclaimer covers the tamper-resistance threat model and recommends HEC-forwarder mitigation. 12 audit categories with distinct gradient-fill chip colors.
8. **HEC audit forwarder** — admin-configurable forwarding of audit events to a separate Splunk / SIEM / S3-with-Object-Lock destination. Browser-side dual-write at flush time. Failure events captured as a separate `audit_forwarder_failure` category so disabled / down forwarders are visible in the audit log itself.
9. **`Visible<T>` brand types** — outbound-message types are tagged `Visible` and unwrap explicitly; the type system refuses to put a `Hidden<MCPToolResult>` into an outbound vendor payload, mechanically enforcing the privacy boundary.
10. **Dynamic timechart span** — every time-series chart's SPL passes a `timechartSpan` computed from the current time range so 30-day windows don't render with 700 data points. Helper at `utils/timechartSpan.ts`.

### :material-circle-box:{ .taiconcolor } Fixed issues

1. **Stale aggregate framing in AI Assistant top-N responses** — the LLM previously cited cumulative aggregates ("4,799 failed authentications") as if they were active rates, leading to misleading "lock the accounts today" recommendations. Build 171's TIME-WINDOW REASONING primer rules now force a verify query before high-severity claims, and the same cumulative number gets correctly downgraded with explicit "stale long-window aggregate, not an active brute-force" framing.
2. **Splunk risky-command safeguard on `nextSteps.spl`** — two intent-map deep-dive strings used `| map maxsearches=1 search="..."` which Splunk flags as risky. Rewrote to first-class subsearch syntax. Intent map version bumped v0.0.8 → v0.0.9.
3. **AZ field bleeding into next osquery section** — the Host Inventory panel's `zone` regex now stops at the `#012` osquery section separator (`[^,#]+` instead of `[^,]+`), so AZ values like `ap-south-1a` no longer carry trailing data from adjacent fields.
4. **MCP cookie auth on same-session HTTP-only Splunk** — verified empirically that the Splunk MCP Server v1.1.0 accepts cookie auth from the same Splunk Web session that's serving the React app, so the default `mcp_server_url` works on HTTP-only Splunk with no bearer token configured. The optional bearer token layers on top via `Authorization: Bearer` and is invalidated on 401 with one retry.
5. **Splunk `services/authorization/roles` endpoint** — Multiselect for the Power Users field reads roles from the correct path; `services/authentication/roles` (a common typo) silently 404s and produces a stuck "Loading roles..." UI.
6. **Splunk Web static-asset cache busting** — every meaningful code change bumps `[install] build` in `app.conf` so browsers don't serve stale bytes after deploy.
7. **Webpack `style-loader` requirement** — adding `import '@xyflow/react/dist/style.css'` exposed a latent webpack-config gap where CSS was being compiled but never reaching the DOM. Both `style-loader` AND `css-loader` are now in the webpack rules.

### :material-circle-box:{ .taiconcolor } Restyled (visual conventions)

1. **21 React dashboards** with the unified dark-theme card style: `#0d1117` page, `#141b2d` panel fill, `#0877a6` panel outline, 3 px rounded corners, 5 px inset, 12 px panel gaps. Equivalent to the v0.0.4.2 DS v2 look but rebuilt natively in styled-components.
2. **Severity dots** — chat findings render with a colored dot (yellow → orange → red → dark-red for low → medium → high → critical) using a radial gradient so they read as glossy beads matching the donut-chart palette aesthetic.
3. **Win11-style 8-dot loading spinner** — replaces the prior cyan-arc indicator in AI Assistant streaming + tool-executing states. CSS-only via single keyframe + per-dot `--angle` variable + staggered `animation-delay`. Reused in the Topology canvas loading overlay (extracted to a shared `Spinner` component).
4. **Cyan-light dotted-underline citation links** — the AI's `[→ saved_search]` citations render as clickable scroll-to-tile spans; sibling `↗ Dashboard` and `↗ Run SPL` chips use the same visual idiom.
5. **Compact Multiselect with Select-All-Matches** — HostDetails + Data Pipeline Overview both use `@splunk/react-ui/Multiselect` with `compact + filter + selectAllAppearance="checkbox"` so typing into the filter narrows the dropdown and the Select All control auto-renames to "Select all matches".
6. **Glossy severity-dot gradients** — `radial-gradient(circle at 35% 30%, ...)` so dots read as 3D beads not flat circles.
7. **Audit-log filter chips with per-category gradients** — 12 categories each get a distinct 3-stop linear gradient with mid-stop ~35–45% luminance for white-text readability, dim-when-unchecked via layered translucent-black wash so the text stays readable.

### :material-circle-box:{ .taiconcolor } Known issues

1. **Tier 0 (Ollama, air-gapped)** is not yet shipped. Tier 0 currently returns "not yet implemented" if selected. Planned for a future release.
2. **`hideWhenNoData` panel-disappearance behavior** continues to apply on HostDetails Role Activity tab. Expected behavior, but empty tabs can feel sparse on hosts that only forward a single sourcetype.

### :material-circle-box:{ .taiconcolor } Splunk Cloud compatibility hardening

Post-initial-release iterations within the v0.0.5.0-beta line that brought the packages to Splunk Cloud Victoria 10.x install-ready posture. All changes are backwards-compatible with on-prem Splunk Enterprise — admins on Enterprise see zero behavior change.

1. **Splunk Cloud Victoria install support** — both the LogServ App and the Data TA now pass `splunk-appinspect inspect --mode precert --included-tags cloud` cleanly. Posture: App = 0/0/0/8/112 (errors / failures / future_failures / baseline warnings / success); Data TA = 0/0/0/11/131. Cleared a Cloud-Victoria-only runtime failure where the LogServ App's Mako template at `appserver/templates/home.html` was being stripped by the Cloud edge proxy because it contained a `<% page_path = ... %>` Python code block (Splunk Cloud Victoria enforces no Python code blocks in Mako templates at runtime, even though `splunk-appinspect` flags it only as a warning). The fix inlines the page-path expression directly into `${make_url(...)}`. Without this, the home view returned HTTP 500 with `TopLevelLookupException` on Splunk Cloud Victoria.

2. **ISC BIND + Squid parsing absorbed natively** — the parsing from the (archived) Splunk Add-on for ISC BIND v2.0.0 and Splunk Add-on for Squid Proxy v2.1.0 is now bundled in the LogServ App, eliminating the need to install those separately. See [Supported Log Types → ISC BIND](../getting-started/supported-log-types.md#isc-bind-iscbind) and [→ Squid Proxy](../getting-started/supported-log-types.md#squid-proxy-squidaccess). Customers who have either standalone TA installed will see a one-time dismissible banner on the LogServ App home view recommending uninstall (otherwise both TAs' parsing runs in parallel, causing duplicate field extraction).

3. **`sc_subadmin` enablement across both packages** — Splunk Cloud Victoria deployments commonly reserve `sc_admin` for Splunk Cloud Operations staff, leaving `sc_subadmin` as the customer's effective top admin role. Both packages now ship with `sc_subadmin` in their `metadata/default.meta` write ACL (`write : [ admin, sc_admin, sc_subadmin ]`). The Data TA's `metadata/default.meta` is post-build-patched by `additional_packaging.py` because UCC's stock build template would silently overwrite the source-level value; a standalone repair script also exists at `tools/scripts/patch_data_ta_sc_subadmin_metadata.py` for patching already-built tarballs. The Data TA's `[script:splunk_ta_sap_logserv_deployment_push]` capability also changed from `admin_all_objects` to the Splunk-standard `edit_deployment_server` so the in-app deployment-push UI works for customer-tier admins. See [Splunk Cloud Victoria Notes](../install-setup/splunk-cloud-victoria-notes.md) for the full role-tier mapping.

4. **AI Assistant settings + T&C acknowledgements migrated to KV Store** — Splunk's REST framework hardcodes `admin_all_objects` as a capability gate on `/configs/conf-X/` writes, IN ADDITION TO the object metadata ACL. On locked-down Splunk Cloud Victoria deployments where `sc_subadmin` doesn't hold `admin_all_objects`, every conf-file write would 403 — including AI Assistant Settings → Save Defaults and every legal-T&C modal Submit. The two mutable conf-file backed stores have been migrated to KV Store collections (`logserv_ai_assistant_settings`, `logserv_ai_assistant_acks`), which check only the collection-level metadata ACL — no capability requirement. A one-shot migration helper in `App.tsx` copies any pre-migration `local/*.conf` values into KV Store on first page load post-upgrade, so customers don't lose customizations or re-prompt on legal modals. See the [Splunk Cloud Victoria Notes](../install-setup/splunk-cloud-victoria-notes.md) page (section "AI Assistant settings + T&C acks in KV Store").

5. **`useIsAdmin` recognizes `sc_admin` + `sc_subadmin`** — the React UI's admin-gating hook (`hooks/useIsAdmin.ts`) expanded from a strict `roles.includes('admin')` check to `roles.some((r) => ADMIN_TIER_ROLES.includes(r))` with `ADMIN_TIER_ROLES = ['admin', 'sc_admin', 'sc_subadmin']`. Without this, the AI Assistant Settings page would have rendered a 403 "Admin access required" fallback for customer-tier Splunk Cloud admins.

6. **Audit-index renamed `logserv_ai_assistant_audit`** — across two hops: `_ai_assistant_audit` → `ai_assistant_audit` (dropped the underscore prefix because AppInspect's `check_lower_cased_index_names` rejects custom-app indexes starting with `_`) → `logserv_ai_assistant_audit` (added the `logserv_` namespace prefix so the index can't collide with any other app that happens to define a generic `ai_assistant_audit`). Functional behavior unchanged across all three names. Both indexes the Data TA provisions are macro-configurable via `sap_logserv_idx_macro` and `sap_logserv_audit_idx_macro`. Customers with existing audit data under either of the older index names will see that data become orphaned on disk after upgrade — not queryable via the new name. Audit retention horizons are typically short and a clean break is acceptable.

7. **Splunk MCP Server JWT `aud = mcp` requirement documented** — Splunk Cloud Victoria's edge proxy auto-injects a JWT into every `/__raw/` splunkd request, and the Splunk MCP Server (Splunkbase App 7931) validates the `aud` claim against the literal `"mcp"`. Common Splunk Cloud Victoria default audiences (e.g., `"Demo"` on non-production stacks) cause the MCP health probe to receive a 403 `Invalid token audience` error, which surfaces as the AI Assistant SETUP REQUIRED banner. The fix is customer-side (re-mint the MCP token with `audience=mcp` OR file a Splunk Cloud Support ticket asking them to align the stack's MCP audience). This is a server-side App 7931 configuration; the LogServ App is audience-agnostic. See [Splunk MCP Setup → Splunk Cloud — JWT `aud` claim must be `mcp`](../ai-assistant/mcp-setup.md#splunk-cloud-jwt-aud-audience-claim-must-be-mcp).

8. **Data TA Cloud-vetting fixes** — cleared 6 pre-existing AppInspect failures + 2 future_failures that had been blocking the Data TA on Splunk Cloud: 4-part SemVer corrected to 3-part (`0.0.5`), `python.version = python3` flag added on scripted-input stanzas, `python.required = 3.13` added on scripted inputs + admin_external handlers, `solnlib<8.0.0` pinned in `requirements.txt` to drop AArch64-incompatible protobuf + gRPC + OpenTelemetry binaries that solnlib 8+ pulls in transitively (also cuts Data TA tarball size 82%, from 9.29 MB → 1.55 MB), illegal `maxTotalDataSizeMB` index property removed, executable shell script relocated alongside `additional_packaging.py` (one level up from `package/`) so UCC stops bundling it.

### :material-circle-box:{ .taiconcolor } Microsoft Azure support

!!! note "Superseded in v0.0.6"
    Azure ingest now uses the dedicated **Splunk TA for SAP LogServ on Azure** add-on (`splunk_ta_sap_logserv_azure`) and its **`sap_logserv_azure_queue`** input (Event Grid → Storage Queue notifications), installed per Heavy Forwarder. The Splunkbase Microsoft-Cloud-Services polling approach described below is the original v0.0.5 implementation, retained here as a release record. See the [Azure Setup Guide](../install-setup/azure-setup.md) for the current setup.

The v0.0.5.0 release adds full Microsoft Azure Blob Storage support alongside the existing AWS S3 ingest. Architectural pattern is symmetric with AWS: the LogServ Data TA pairs with the **Splunk Add-on for Microsoft Cloud Services** (Splunkbase App 3110, v5.0+) on the Heavy Forwarder tier, instead of `Splunk_TA_aws`. Validated end-to-end against a real Azure subscription with the production deployment topology (DS → HF distribution, SAS credential HF-local, NOT pushed via DS).

1. **Azure Blob Storage ingest** — the `mscs_storage_blob` input from the Splunk Add-on for Microsoft Cloud Services polls a configured Azure Blob container under the `logserv/` prefix, downloads each new blob (gzipped NDJSON), and emits events with `sourcetype = sap_logserv_logs`. The LogServ Data TA's existing index-time routing transforms then key on the `source` field's `clz_dir/clz_subdir` segments — identical to the AWS S3 pipeline. No new Data TA configuration required; the routing transforms ARE the multi-cloud abstraction layer.

2. **`cloud_provider` indexed-field attribution** — the Azure input stanza sets `_meta = cloud_provider::azure`, which Splunk persists as an INDEXED field on every event ingested through that input. AWS-ingested events have no `cloud_provider` field on disk (legacy data + AWS S3 input pre-dating Azure support); a new search-time macro `sap_logserv_cloud_provider_default_macro` (`eval cloud_provider=coalesce(cloud_provider, "aws")`) provides the AWS default for cross-cloud reporting. Result: every event in the index reports a `cloud_provider` value of `aws` or `azure`, regardless of when or where it was ingested.

3. **Multi-Cloud Overview dashboard** — new platform-tier dashboard surfaces the per-provider ingest split (event count + sourcetype breakdown + recent activity), built on top of the `sap_logserv_cloud_provider_default_macro`. Lives under the **Platform** navigation group. Useful for capacity-planning across cloud providers + confirming the Azure ingest is healthy.

4. **Four authentication recipes documented** — the [Azure Setup Guide](../install-setup/azure-setup.md) covers four Azure auth paths: (a) Account-key + SAS (testing-grade), (b) Shared Access Signature with container scope (production-friendly, time-bounded), (c) Service Principal with `client_secret`, (d) Managed Identity (no credential stored on the HF — preferred for HFs running on Azure VMs / AKS / Azure App Service). Recipes are independent of the rest of the setup; pick whichever fits the customer's Azure security posture.

5. **Production deployment topology table** — same DS → HF distribution pattern as `Splunk_TA_aws`. Splunk_TA_microsoft-cloudservices is distributed by the Deployment Server to the Heavy Forwarder server class; Search Head and Indexer do NOT have the add-on. SAS credentials and account configuration stay in HF-local config (NOT pushed via DS — environment-specific per-HF).

6. **Compact-JSON requirement called out** — the LogServ Data TA's index-time routing transforms use whitespace-strict regex (`(?=.*"clz_dir":"abap")`) that bypasses silently on pretty-printed JSON. The SAP LogServ collector emits compact JSON natively, but any custom intermediate pipeline that re-formats blobs with `": "` separators would land events at the bootstrap `sap_logserv_logs` sourcetype. Customer-facing docs call this out as a warning.

7. **Data TA Cloud Provider tab + `splunk_solution` indexed field** — the Data TA's **Configuration** page gains a second tab, **Cloud Provider**, with a dropdown (AWS / Microsoft Azure / Not set; default Not set) that stamps an indexed `cloud_provider` field on every event the TA processes — a TA-managed alternative to setting `_meta = cloud_provider::aws|azure` per input. On a Deployment Server the selection deploys to Heavy Forwarders via the same **Deploy to Forwarders** flow as the Filters tab. Separately, the Data TA now always stamps an indexed `splunk_solution = splunk_for_sap_logserv` field on every event (no UI; ships active) so events that flowed through this solution remain identifiable even when the same index also receives data from other solutions. Both fields are written at index time via `WRITE_META` transforms on the bootstrap `sap_logserv_logs` sourcetype. `splunk_solution` is intentionally distinct from the per-sourcetype `vendor_product` search-time field that dashboards and CIM mapping use — the two coexist and do not collide. For a mixed-cloud Heavy Forwarder (one HF ingesting both AWS and Azure), leave the dropdown at Not set and attribute per input via `_meta`. See [Configuring Filters → Cloud Provider Attribution](../install-setup/configure-filters.md#cloud-provider-attribution).

See the [Azure Setup Guide](../install-setup/azure-setup.md) for full step-by-step setup, prerequisites, and troubleshooting.

### :material-circle-box:{ .taiconcolor } Splunk Enterprise Security integration

The LogServ App ships an out-of-the-box Splunk Enterprise Security (ES) content pack. Everything is **dual-mode** — it works with or without ES installed: the `action.notable=1` / `action.risk=1` directives silently no-op when ES is absent, and the Risk Notable's `Risk.All_Risk` data-model search returns 0 rows without ES.

1. **CIM compliance** — 18 eventtypes + matching tags route SAP-specific events (and the absorbed ISC BIND + Squid parsers) into the Authentication / Change / Network_Sessions / Web CIM data models. A new `app.manifest` declares a hard dependency on `Splunk_SA_CIM ≥ 5.0.0`. See [CIM Compliance](../enterprise-security/cim-compliance.md).

2. **19 detection correlation searches + 1 Risk Notable + 2 Asset/Identity feeds** — organized as **6 base/starter** searches (HANA privilege escalation, cross-stack auth-failure burst, ABAP gateway anomalous peer, SCC ACCESS_DENIED burst, HANA failed CONNECT spike, Linux OOM-killer burst), **6 cross-stack** detections, **3 threat-intel** searches, and **4 behavioral / anomaly** detections. All emit `action.notable=1` for ES Notable Review and `action.risk=1` for RBA. The Risk Notable threshold search fires a `severity=critical` notable when accumulated risk on a single object reaches ≥ 100 in 24h. Two scheduled saved searches emit Asset & Identity feed CSVs every 4h. See [Correlation Searches & RBA](../enterprise-security/correlation-searches.md).

3. **Threat-intel framework** — three customer-managed CSV lookups (`logserv_ti_malicious_domains`, `logserv_ti_malicious_ips`, `logserv_ti_compromised_credentials`) ship empty and are populated by the customer; the 3 threat-intel correlation searches join DNS / proxy / authentication events against them. No separate Splunkbase install or ES Threat Framework dependency. See [Threat Intelligence Integration](../enterprise-security/threat-intel.md).

4. **Behavioral / anomaly detections** — statistically-baselined (Z-score via built-in SPL `eventstats`, no MLTK dependency) detections for per-user auth volume, per-host webdispatcher response time, per-edge topology call volume, and per-admin off-hours activity. See [Behavioral & Anomaly Detections](../enterprise-security/behavioral-detections.md).

All ES detections are also **AI Assistant-dispatchable** — they appear as prompts in the Security pack of the predefined-prompt browser. See [Enterprise Security Integration](../enterprise-security/overview.md) for the full overview.

### :material-circle-box:{ .taiconcolor } Third-party software attributions

The v0.0.5.0 LogServ App ships with **`THIRD-PARTY-NOTICES.md`** at the root of the installed app directory (and at the root of the GitHub release source tree). The file lists all 1235 unique top-level npm packages bundled with the React app — names, versions, declared licenses, repository URLs, and full LICENSE / NOTICE / COPYING text where available. License posture: 1012 MIT, 64 ISC, 57 Apache-2.0, 46 BSD-3-Clause, 22 BSD-2-Clause, 11 `@splunk/*` (covered as a Splunk Extension under §1.C of Splunk General Terms), plus a long tail of permissive licenses. **No GPL / AGPL / LGPL components.** See [Third-Party Software](third-party-licenses.md) for the full license-distribution summary and refresh policy.

A CycloneDX 1.4 SBOM (`SBOM.json`) is also regenerated on every build and shipped inside the package alongside `THIRD-PARTY-NOTICES.md`.


## Version 0.0.4.2-beta

### :material-circle-box:{ .taiconcolor } Compatibility

|                                  |                              |
|----------------------------------|------------------------------|
| Splunk platform versions         | 9.4.3 and later              |
| CIM                              | 5.0.0 and later (per `app.manifest`) |
| Supported OS for data collection | Platform independent         |
| Vendor products                  | SAP LogServ for SAP ECS in Amazon Web Services (AWS) |

### :material-circle-box:{ .taiconcolor } New features

1. **3 new SAP service sourcetypes** — `sap:sapstartsrv` (SAP Start Service / Host Control Agent with auth and SSL/TLS negotiation fields), `sap:saphostexec` (SAP Host Agent execution logs), and `sap:saprouter` (SAP Router connection and trace logs). These cover the `sap/sapstartsrv`, `sap/saphostexec`, and `sap/saprouter` log types in the LogServ S3 bucket.
2. **28 total sourcetype routing transforms** with `@logserv_filter` annotations for index-time filter support.
3. **~176 total search-time directives** (EXTRACT, EVAL, FIELDALIAS) across all SAP-specific sourcetypes in the LogServ App.
4. **15 new dashboards** in the LogServ App, bringing the total to **20**. Dashboards are organized into 4 purpose-driven navigation groups plus a top-level Environment Health landing page (reorganized from the previous 3-group structure so that the top menu is balanced and each group answers a specific class of question):
      - **Top-level** — Environment Health (default landing)
      - **Applications (5 dashboards)** — the SAP app runtime itself: ABAP Network & Security, ABAP Operations, **Work Process Performance** (new), HANA Audit, HANA Trace
      - **Integration (5 dashboards)** — how SAP talks to other systems: SAP Services, **SAP Router** (new), Cloud Connector, Web Dispatcher, **Web and API Performance** (new)
      - **Security (3 dashboards)** — cross-source synthesis for security posture and compliance: **Network Perimeter** (new), **Cross-Stack Authentication** (new), **Change & Configuration Activity** (new)
      - **Platform (6 dashboards)** — infrastructure, ingest, and forensics: Data Pipeline Overview, DNS Analytics, Linux System & Security, Windows Events, Proxy Analytics, Host Details
5. **6 new dashboards from Phase 2** (added after the original 14):
      - **Cross-Stack Authentication** — unified authentication failure analysis across SAP, HANA, and Windows layers, with per-layer KPIs, source-IP aggregation, and per-layer recent-failure tables
      - **SAP Router** — SAP Router connection activity, error analysis, and network boundary monitoring (separated out of SAP Services to give router its own investigation surface)
      - **Work Process Performance** — SAP ABAP work process utilization with all 13 SAP-standard dev_w* trace category codes, dispatcher health, and function-level activity
      - **Web and API Performance** — Web Dispatcher four-stage request timing (`dt1`-`dt4`), response-time percentiles, TLS version and cipher-suite distributions, and a cross-source panel overlaying HTTP error rate against Cloud Connector auth failure rate
      - **Network Perimeter** — unified network-boundary view synthesizing firewall drops, proxy outbound traffic, and DNS resolution into one dashboard; includes firewall-drops-by-protocol, top outbound domains with byte volumes, and a cross-source Suspicious Activity Indicator table ranking internal hosts by combined beaconing-DNS + denied-proxy signal score
      - **Change & Configuration Activity** — compliance-focused audit trail unifying HANA user/role/privilege/DDL changes, Windows account and group modifications (15 canonical security EventCodes), and Linux sudo + useradd/usermod/userdel/passwd activity; includes source-prefixed operator identities, a category taxonomy, and two compliance-focused "Recent" tables (Privileged Changes + After-Hours Changes)
6. **Environment Health dashboard** — Cross-cutting operations view with 6 KPIs, 6 category-specific error trend charts (ABAP, HANA, Security, Web/Network, Cloud Connector, OS/Infra), critical events table, host error matrix, and performance panels. Every panel drills down to the relevant detailed dashboard. Now set as the default landing page.
7. **Tabbed Data Pipeline Overview** — Two tabs: "Overview" (5 KPIs + 14-column Sourcetype Summary table + Host Latest Activity) and "Linked Graph" (full-width source-to-sourcetype link graph). The Sourcetype Summary table includes Status (Fresh/Stale/Very Stale), Trend sparkline, % of Total, Avg/Day, Volume, App Errors, Hosts, Sources, Events (1h), First Seen, Last Seen, and Lag columns.
8. **HANA Audit security panels** — Three new panels surface the rich `sap:hana:audit` field set: Risk-Tiered Event Timeline (stacked column by `risk_level`), After-Hours / Weekend Admin Activity (table filtered to admin users outside business hours), and High-Risk Events (table of `is_critical=true` events with SQL Statement column).
9. **KPI sparklines** — ~75 KPIs across all 21 dashboards display an inline daily-trend sparkline below the headline number, using a single-source `timechart + eventstats` pattern. Five flavors: count-based, distinct-count, rate, formatted-volume, and per-day re-detection. One acknowledged exception: the Linux "Top Drop Source" KPI is a string value (`<IP> (<count>)`) with no sparkline.
10. **Click-through drilldowns** — Most KPIs, table rows, and chart points open a filtered Splunk search. Clickable table cells carry a cyan accent so the drilldown affordance is visible.
11. **KPI single values** added to DNS Analytics (Total Queries, Unique Clients, Beaconing Domains), HANA Audit (Total Events, Failed Operations, Active Users), and Web Dispatcher (Total Requests, Error Rate, Avg Response Time). Access Denied Events KPI added to Cloud Connector; Top Drop Source KPI added to Linux.
12. **Enhanced DNS Analytics** — Top Queried Domains, Top Clients by Domain Diversity (DGA detection), Query Type Distribution, and Top DNS Resolvers table.
13. **Enhanced HANA Audit** — Top Users by Activity, Activity by Hour of Day (after-hours detection), and Client IP Analysis.
14. **Enhanced Web Dispatcher** — Request Volume Over Time, Top URIs by Request Count, and Recent Errors (4xx/5xx).
15. **Host Details — 3-tab expansion** — The Host Details dashboard is now organized into three tabs. **Overview** shows a 5-KPI row (Total Events, Data Volume, Active Sourcetypes, Errors/Criticals, Auth Failures), the Host Event Count by Sourcetype timeline, a cross-source Severity Timeline, Host Inventory (CPU/RAM/EC2/OS/region from osquery), Recent Authentication Events + Recent Errors & Criticals cross-source tables, Top Sources, Activity by Hour of Day, and Data Freshness per sourcetype. **Role Activity** contains seven role-specific panels (HANA Audit Activity, ABAP Work Process Mix, Web Dispatcher Traffic by Status, SAP Router Peers, Windows Event Codes, Sudo Commands, DNS Top Queries) that auto-hide via `hideWhenNoData` when the selected host has no data for that component. **Sourcetype Mapping** houses the full-width Sankey chart that was previously inline.
16. **Cross-dashboard navigation** — Every dashboard includes a Navigate to Dashboard dropdown with Go button that preserves the selected time range when switching between dashboards.
17. **In-dashboard documentation link ("More Info" button)** — A cyan **More Info** button in the top-right of every dashboard's toolbar row opens the corresponding online-documentation section in a new browser tab. The link targets the dashboard's section within the appropriate category page (`.../dashboards/applications/#<dashboard-slug>`, etc.) so users can jump from a live dashboard to its narrative documentation in one click. For multi-tab dashboards (Data Pipeline Overview, Host Details) the button appears on every tab.

### :material-circle-box:{ .taiconcolor } Enhancements (per-dashboard restructures)

1. **SAP Services** — Removed the 4 router-related panels (now on the SAP Router dashboard); featured SSL Authentication Failure Sources full-width; replaced Event Volume by Service line chart with a stacked column chart showing Normal vs Errors per service.
2. **Windows Events** — Removed Security Event Actions chart and Top Users table (now on Cross-Stack Authentication); featured Top Event Codes full-width with 7 enriched columns (Event Code, Description, Source log, Severity, Events, Hosts, Last Seen).
3. **Proxy Analytics** — Replaced single-slice donuts (Content Types → Cache Action Distribution column; HTTP Methods → Top Clients by Domain Diversity bar). Added new bottom row: Top URL Domains by Bytes Out + Bandwidth Over Time by Domain.
4. **DNS Analytics** — Replaced the uninterpretable Volume & Packet Size scatter plot with a Top DNS Resolvers table; restructured row 2 to 4 panels including Query Type Distribution donut moved up to pair with the trend chart.
5. **ABAP Operations** — Work Process Categories donut widened to 836 px with bottom legend showing all 13 friendly category names (uses the shared `wp_category_name` props.conf EVAL).
6. **Cloud Connector** — Renamed "Error Rate" → "HTTP Error Rate" to clarify scope; added Access Denied Events KPI (4th KPI in row).
7. **Linux System & Security** — Added Top Drop Source KPI surfacing the highest single-source firewall drop count in `<IP> (<count>)` format (4th KPI in row).

### :material-circle-box:{ .taiconcolor } Fixed issues

1. DNS Analytics beaconing panels now use correct `message_type="Query"` case (was `"QUERY"`).
2. Web Dispatcher data source had hardcoded Unix timestamps; replaced with `$global_time.earliest$`/`$global_time.latest$` tokens.
3. **Work Process Categories labels** — The Work Process Categories panel on the ABAP Operations dashboard now displays meaningful names for all 13 standard SAP dev_w* trace component codes (A = ABAP Processor, B = Database Interface, C = Communication, D = Dispatcher, M = Memory Management, N = Network (NI), O = Enqueue / Lock, Q = RFC Queue, R = Roll Area, S = SQL / Statistics, T = Task Handler, X = RFC / CPIC, Y = Dynpro / Screen). Previously only A/B/C/M were mapped and the rest appeared as single-letter codes. The same `wp_category_name` mapping is now also used on the Work Process Performance dashboard.
4. **KPI panel alignment** — KPI single-value widgets on all three-KPI dashboards are evenly spaced with the rightmost KPI outline aligned to the right edge of panels below.
5. **Right-edge symmetry** — All rows on width=1920 dashboards now cap at R=1910; width=1600 dashboards cap at R=1590. Symmetric 10 px padding on both sides.
6. **HANA Trace component noise filter** — Top Components, Component by Severity, and Source File Hotspots panels now filter out parsing artifacts ("INFO", "of", "service:") that previously diluted real component data.
7. **Ingest Errors KPI on Data Pipeline Overview** — Refined to exclude ExecProcessor noise (which wraps all scheduled-script output as ERROR-level regardless of the script's actual log level). Filters to real Python ERRORs only.
8. **SSL Authentication Failure Sources panel (SAP Services)** — Replaced the previous Sapstartsrv SSL/TLS Events panel which showed empty columns due to mismatched field extractions. Now aggregates by source IP using fields that actually exist in the data (auth_user, remote_ip, remote_port) and provides row drilldown to the full event set per IP.
9. **Empty-safe KPI pattern** — All count-based and dc-based KPIs now display `0` instead of `###` when the underlying search returns no events (uses a synthetic-row appendpipe wrap).

### :material-circle-box:{ .taiconcolor } Restyled (visual conventions)

1. **Dashboard "card" style** — All 21 dashboards use a unified visual treatment: `#0d1117` page background, `#141b2d` panel fill, `#0877a6` panel outline, rounded corners, 5 px inset between rect frame and inner viz.
2. **KPI typography standardized** — `majorFontSize: 36`, explicit `labelColor: #7b8ea8`, `labelFontSize: 13`, semantic `majorColor` (`#dc4e41` red for errors, white for neutral counts, orange for warnings, teal for positive signals). The Linux Top Drop Source KPI uses `majorFontSize: 28` as an acknowledged exception for its long-text string display.
3. **Standard red consolidated** — All red color variants (`#e86c5d`, `#af575a`, `#ff3b30`, `#ff2d55`) normalized to single hex `#dc4e41`.
4. **Tables** — Hardcoded header background (`#1e2a3d`), zebra-stripe alternating rows (`#0d1520` / `transparent`), fixed header. Cyan accent on clickable cells indicates drilldown affordance.
5. **12 px panel gaps** — Exact horizontal and vertical spacing between every panel border across all dashboards.
6. **Dashboard descriptions** — Every dashboard now displays a 1-line description below its title.
7. **"Go >" navigation button** — Standardized: 120×25 px at top-left of every dashboard with 10 px padding above and below; majorFontSize 16.
8. **"More Info" documentation button** — Standardized: 140×25 px at top-right of every dashboard, aligned with the right edge of the canvas (10 px padding from the right; x = canvas_width − 150). Same cyan fill `#0877a6`, white text, majorFontSize 16 as the Go button. Opens the dashboard's online-documentation section in a new browser tab via `drilldown.customUrl` with `newTab: true`.

### :material-circle-box:{ .taiconcolor } Known issues

1. The dashboards in the LogServ App use Dashboard Studio v2 format and require Splunk 9.4.3 or later.
2. Several Host Details panels (Host Inventory, Recent Authentication Events, Recent Errors & Criticals, and all seven Role Activity panels) use `hideWhenNoData` and will disappear for hosts that lack the underlying sourcetype data. For example, a Windows host without osquery data will not show the Host Inventory panel; an ABAP-only host will not show the HANA Audit Activity panel on the Role Activity tab. This is the dashboard adapting to the selected host's role — not a bug — but empty tabs can feel sparse on hosts that only forward a single sourcetype.

### :material-circle-box:{ .taiconcolor } Third-party software attributions


## Version 0.0.4.1-beta

### :material-circle-box:{ .taiconcolor } Compatibility

|                                  |                              |
|----------------------------------|------------------------------|
| Splunk platform versions         | 9.4.3 and later              |
| CIM                              | 5.0.0 and later (per `app.manifest`) |
| Supported OS for data collection | Platform independent         |
| Vendor products                  | SAP LogServ for SAP ECS in Amazon Web Services (AWS) |

### :material-circle-box:{ .taiconcolor } New features

1. **12 new SAP application sourcetypes** — 9 SAP ABAP types (`sap:abap:audit`, `sap:abap:dispatcher`, `sap:abap:enqueueserver`, `sap:abap:event`, `sap:abap:gateway`, `sap:abap:icm`, `sap:abap:messageserver`, `sap:abap:sapstartsrv`, `sap:abap:workprocess`), 1 HANA trace type (`sap:hana:tracelogs`), and 2 SAP Cloud Connector types (`sap:scc:audit`, `sap:scc:http_access`).
2. **Compound lookahead routing** — New routing pattern for log types where the same `clz_subdir` value appears under multiple `clz_dir` paths (e.g., `audit` exists under both `abap/` and `scc/`). Uses regex lookahead to match both fields simultaneously.
3. **Search-time SID/instance extraction** — ABAP and HANA sourcetypes extract `sap_sid` and `sap_instance` from the `source` metadata field using `EXTRACT ... in source` directives in the LogServ App.
4. **~128 total search-time directives** across all SAP-specific sourcetypes.

### :material-circle-box:{ .taiconcolor } Fixed issues

### :material-circle-box:{ .taiconcolor } Known issues

1. The dashboards in the LogServ App use Dashboard Studio v2 format and require Splunk 9.4.3 or later.

### :material-circle-box:{ .taiconcolor } Third-party software attributions


## Version 0.0.3-beta

### :material-circle-box:{ .taiconcolor } Compatibility

|                                  |                              |
|----------------------------------|------------------------------|
| Splunk platform versions         | 9.4.3 and later              |
| CIM                              | 5.0.0 and later (per `app.manifest`) |
| Supported OS for data collection | Platform independent         |
| Vendor products                  | SAP LogServ for SAP ECS in Amazon Web Services (AWS) |

### :material-circle-box:{ .taiconcolor } New features

1. **Two-package architecture** — The solution is now split into two packages: the **Data TA** (`splunk_ta_sap_logserv`) for data collection and index-time processing, and the **LogServ App** (`splunk_app_sap_logserv`) for dashboards and search-time field extractions. See [Architecture](../getting-started/architecture.md) for details.
2. **Built-in index-time filtering** — Configure include/exclude patterns and time-based filters directly through the Splunk Web UI. Filtered events never consume Splunk license. See [Configuring Filters](../install-setup/configure-filters.md).
3. **AWS Lambda-based filtering** — New deployment option that filters S3 event notifications in AWS before they reach Splunk, reducing S3 GET request costs and SQS message volume. Available via the [AWS Remote S3 Filter Setup Guide](../install-setup/aws-remote-s3-filter-guide.md) or the [Connect to Filter Migration](../install-setup/aws-remote-s3-connect-to-filter-migration-guide.md). Can be used alongside or independently of the native TA filtering.
4. **Deployment Server automation** — When installed on a Deployment Server, the TA automatically stages filter configurations for distribution to Heavy Forwarders and provides a one-click "Deploy to Forwarders" button.
5. **Upgrade notifications** — A system message banner alerts administrators when a TA upgrade adds support for new log types that are not covered by existing include filter patterns.
6. **Daily time filter refresh** — A built-in scripted input automatically refreshes the time-based filter cutoff once per day to maintain accuracy of the rolling time window.
7. **SAP HANA Audit field extractions** — 14 EXTRACT, 11 EVAL, and 16 FIELDALIAS directives for the `sap:hana:audit` sourcetype.
8. **SAP Web Dispatcher field extractions** — 18 EXTRACT, 3 EVAL, and 6 FIELDALIAS directives for the `sap:webdispatcher:access` sourcetype.

### :material-circle-box:{ .taiconcolor } Fixed issues

1. Dashboards moved from Data TA to dedicated LogServ App package for proper distributed deployment support.

### :material-circle-box:{ .taiconcolor } Known issues

1. The dashboards in the LogServ App use Dashboard Studio v2 format and require Splunk 9.4.3 or later.

### :material-circle-box:{ .taiconcolor } Third-party software attributions


## Version 0.0.2-beta

### :material-circle-box:{ .taiconcolor } Compatibility

|                                  |                              |
|----------------------------------|------------------------------|
| Splunk platform versions         | 9.4.x, 10.0.x                |
| CIM                              | 5.0.0 and later (per `app.manifest`) |
| Supported OS for data collection | Platform independent         |
| Vendor products                  | SAP LogServ for SAP ECS in Amazon Web Services (AWS) |

### :material-circle-box:{ .taiconcolor } New features

### :material-circle-box:{ .taiconcolor } Fixed issues

1. Drilldown on overview dashboard to host details dashboard had the wrong application name and displayed an error when clicking on the host name.
2. Renamed the 'logserv_web_dispatcher_access.xml' dashboard to 'logserv_web_dispatcher.xml'.
3. Renamed the 'sap_rise_host_details.xml' dashboard to 'logserv_host_details.xml'.
4. Updated the '~/ui/nav/default.xml' with updated dashboard names.

### :material-circle-box:{ .taiconcolor } Known issues

1. The dashboards included in this TA are Dashboard Studio dashboards that may not work with Splunk versions prior to 9.4.

### :material-circle-box:{ .taiconcolor } Third-party software attributions


## Version 0.0.1-beta

### :material-circle-box:{ .taiconcolor } Compatibility


|                                  |                              |
|----------------------------------|------------------------------|
| Splunk platform versions         | 9.4.x, 10.0.x                |
| CIM                              | 5.0.0 and later (per `app.manifest`) |
| Supported OS for data collection | Platform independent         |
| Vendor products                  | SAP LogServ for SAP ECS in Amazon Web Services (AWS) |

### :material-circle-box:{ .taiconcolor } New features

### :material-circle-box:{ .taiconcolor } Fixed issues

### :material-circle-box:{ .taiconcolor } Known issues

1. Drilldown on overview dashboard to host details dashboard has the wrong application name and displays an error when clicking on the host name.

2. The dashboards included in this TA are Dashboard Studio dashboards that may not work with Splunk versions prior to 9.4.

### :material-circle-box:{ .taiconcolor } Third-party software attributions
