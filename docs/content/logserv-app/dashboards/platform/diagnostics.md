# Data Doctor (Diagnostics)

The **LogServ Data Doctor** is the app's built-in missing-data diagnostic. When a panel is empty
and you don't know why, it answers the question a support ticket would otherwise ask — *"is
something broken, or is there genuinely no data?"* — in plain language, with the evidence, and
without needing a Splunk administrator to run it. Every check it performs is readable by a
normal, non-admin user.

It has four surfaces, from smallest to widest scope:

```
 empty panel hint  ->  panel diagnosis drawer  ->  dashboard sweep  ->  Diagnostics page
 (automatic, free)     ("Run full diagnosis")     (Actions menu)       (#/diagnostics)
```

## :material-circle-box:{ .taiconcolor } Empty-panel hints (automatic)

Every chart, table and KPI card that comes back empty explains itself. Without running any
extra search, the app checks the facts it already has — did the search actually run, did it
error, is a global filter narrowing it (the Cloud picker, a host selection), is the selected
range shorter than the panel's data granularity, does the query contain a clause that can never
match — and corrects the panel's own empty message when one of those is the reason. On KPI
cards, which sit in a height-equalised row, the hint renders in a compact 2–5-word form with
the full sentence in the tooltip.

These free checks are deliberately forbidden from claiming a system fault: without dispatched
evidence, the most they assert is what the panel itself proves. When they can't explain the
emptiness, a chart or table panel offers **"Why is this empty?"** instead. (A KPI card has no
room for that link — its entry point is the small corner diagnose affordance, revealed on
hover or keyboard focus.)

## :material-circle-box:{ .taiconcolor } The panel diagnosis drawer

Clicking **Why is this empty? / Run full diagnosis** opens a side drawer that dispatches a
short, budgeted series of probes (90-second wall-clock budget, at most two concurrent, every
probe carries server-side `max_time`/`auto_cancel` bounds) and walks a gated cascade of
verdicts — the panel's own error first, then index visibility and presence, the ingest-cutoff
boundary, sourcetype presence/staleness, and finally the summarised-data (rollup) layer. The result is one plain-language headline
("Most likely: …") with a confidence level, **who can act on it** (you / a Splunk administrator /
whoever sends the logs), and a *"What was checked"* ledger showing every probe's outcome —
including the ones that were skipped, and why.

Three properties matter more than the checks themselves:

- **It can say "nothing is broken."** If the data genuinely does not exist for the selected
  range, that is the verdict — stated as working-as-intended, not as a fault.
- **It never concludes from unknown.** A probe that failed or ran out of budget renders NOT
  CHECKED, never OK and never a fault.
- **Panels that read summarised data are traced back to their source events.** A rollup-backed
  panel names no sourcetype, so the diagnostic reads the aggregation search that populates its
  collection, extracts what that search consumes, and probes those sourcetypes — distinguishing
  "the events exist but were never summarised (run the backfill)" from "there genuinely are no
  such events".

The drawer's footer offers **Copy technical summary** and **Download PDF**.

For a rollup-backed panel, the drawer's *Show technical detail* section (and the technical
summary, and both the panel and dashboard PDFs) also prints the **full SPL of the saved
search(es) currently configured to populate the panel's summary collection** — each labelled
with its parsed `outputlookup` target, its cron schedule verbatim, and its last-modified
timestamp. The section states explicitly that this SPL is *configuration read at diagnosis
time* (including any `local/` override), was **not** run by the diagnosis, and that rows
already stored in the summary may predate it. Each aggregate is accompanied by a note naming
its install-backfill stanza, which as shipped carries the identical search text (a build-time
check derives that identity from the shipped configuration on every release). The dashboard
PDF carries one de-duplicated section covering every rollup the dashboard's panels read —
healthy panels included.

In the drawer, each printed definition carries two corner actions: **copy to clipboard**
(copies the definition verbatim) and **open in the Search app** in a new browser tab, scoped
to the diagnosed time window. The opened search has the terminal `| outputlookup` write
removed first, so running it cannot modify the summary collection — the drawer never offers
a control that can change data.

### :material-circle-box:{ .taiconcolor } Deep evidence (drawer-only)

Several further checks run **only** in the drawer — they are the only probes permitted to scan raw
events, so a dashboard-wide sweep never fires them:

- **Summarised-vs-raw reconciliation.** An empty summarised panel is re-run as its exact
  raw-query equivalent over the already-summarised period. Raw rows the summary lacks produce
  the confirmed *"the summary appears to be missing data it should have"* (a Splunk
  administrator re-runs the backfill from Settings → Dashboard Data); agreement produces the
  health-certifying *"the raw equivalent returns nothing for this range either — there is
  genuinely nothing to show."* Panels whose raw equivalent is a scalar count carry no
  row-count signal and are skipped with an honest ledger note.
- **Field presence probe.** A raw panel filtering on a field is checked against a sample of its
  sourcetype's own events (up to 2,000, without the panel's host/provider/breakdown filters):
  a field present on zero sampled events reads as a search-time-extraction gap — graded *likely*
  when the whole available sample was examined, *possible* when the 2,000-event sample cap was
  reached; a
  populated field whose expected value never appears reads as possible vocabulary or casing
  drift. The ledger row is *"Field presence probe (sampled)"*.
- **Clause relaxation.** For an empty raw panel, a control probe first confirms the emptiness
  comes from the base search; each filter clause is then removed in turn, and the verdict names
  **which clause excludes every event** and how many events removing it would match. The ledger
  row is *"Clause relaxation"*.
- **Lookup registration.** A panel that uses a non-summarised lookup verifies the lookup is
  registered on this search head (a CSV placed under `default/lookups/` does not register —
  Splunk auto-registers only the app-root `lookups/` directory).

Two smaller additions ride along: a summarised verdict under a Cloud Provider filter states
whether **any** summarised rows carry that provider in the range, and the environment
**report**'s rollup table gains a "Recent buckets" continuity column (context only — the live
Diagnostics page deliberately omits it, since it re-gathers on every picker change).

## :material-circle-box:{ .taiconcolor } Diagnosing a panel that HAS data (partial-data diagnosis)

Missing data is not always an empty panel: a table can have rows with one column blank, and a
KPI can display a zero you believe should not be zero. The Data Doctor covers both, with two
entry points that work on **populated** panels:

- **The Diagnose toolbar icon.** Every chart and table panel's toolbar gained a fifth icon,
  **Diagnose this panel** — it sits first, ahead of Open-in-Search / Download CSV / Inspect /
  Refresh. On a populated
  panel it opens the drawer under the header **"Panel diagnosis"** (rather than *"Why is this
  empty?"*) and runs the partial-data checks below.
- **The KPI corner affordance.** Each KPI card carries a small diagnose control in its corner,
  revealed on hover or keyboard focus. On a card showing a zero (including formatted zeros like
  "0 ms" or "0%") it routes the diagnosis into the zero-value resolution.

What a partial-data diagnosis does:

- **Column coverage.** The table itself reports which displayed columns are blank — as counts
  only, never values (nothing from your rows leaves the panel). Each fully-blank column is
  traced to the raw-event field it displays (through any renames in the query) and corroborated
  against a sample of the source events, yielding one of three findings: the field is **not
  populated on the source events at all** (a search-time-extraction gap), the source events
  carry it but **the summarised rows do not** (a summarisation gap — the backfill settles it),
  or the aggregation **provably does not store that column** — in which case the diagnosis says
  plainly that *a backfill cannot add it*. Columns computed inside the query, or drawn by a
  custom renderer, are honestly set aside rather than probed.
- **Zero-value resolution.** A zero KPI is reconciled against the summarised layer and — when
  the panel's raw-equivalent query emits a single comparable value — against a live raw
  computation. Summarised rows that genuinely sum to zero, or a raw equivalent that also
  computes zero, certify *"the value genuinely is zero"* (never a backfill prescription); a raw
  equivalent that disagrees is reported as a **possible** summarisation gap, never a confirmed
  fault (the two computations are independent implementations).
- **The honest floor.** When every displayed column is populated and accounted for, the
  diagnosis says so: *"This panel has data, and the columns it displays are populated — no
  defect found."* The floor is unreachable while any column could not be checked — those are
  named instead.

A populated panel's rows are living proof the index, sourcetype and summary read path work, so
the emptiness battery is skipped (each check listed in the ledger as *"Not applicable — this
panel returned data"*), and a panel that has not finished loading is refused with a plain
explanation rather than diagnosed on unknown facts.

## :material-circle-box:{ .taiconcolor } Data Doctor reports (PDF + JSON)

Reports exist at all three scopes, each downloading a branded **LogServ Data Doctor Report**
PDF plus a machine-readable `.json` twin (schema `logserv.diag/1` — greppable, and diffable
against a report from a week earlier):

| Scope | Where | What it contains |
|---|---|---|
| Panel | the diagnosis drawer → **Download PDF** | the verdicts, the exact dispatched SPL + window, the evidence ledger |
| Dashboard | Actions menu → **Diagnose dashboard (PDF)** | every panel on the open dashboard classified, with the full cascade run on the empty ones |
| Environment | Actions menu → **Environment report (PDF)**, or the Diagnostics page | index, sourcetype and rollup health for the whole install |

Every report carries a data-exposure banner: it contains search strings, index/host names,
sourcetypes and SAP system identifiers, scheduled-search names and scheduler messages from
apps on this instance, the full text of the saved searches that populate this app's summary
collections, and any ingest-filter configuration supplied to the diagnostic by your
administrator — but **no raw log events** — and it is generated entirely in your browser;
nothing is sent outside your Splunk instance. Note that every report you download (except one
carrying raw samples) is also saved to the app's KV Store, where all app users can read it —
see Saved reports below. It is designed to be attached to a Splunk support ticket.

## :material-circle-box:{ .taiconcolor } The Diagnostics page (`#/diagnostics`)

![Data Doctor (Diagnostics)](../../../../images/dashboard-diagnostics.png)

**Platform → Diagnostics** is the environment-wide surface, visible to every user (it is
deliberately *not* admin-gated). On open — and on every time-range change, or the nav-bar
Refresh button — it runs the environment checks (120-second budget) and renders them live:

- **Summary** — events in the selected window, sourcetypes present, the index the app macro
  resolves to, a search-head canary round-trip, Splunk version + search-head clock, and
  whether the companion apps (`Splunk_SA_CIM`, `Splunk_TA_windows`, `Splunk_TA_nix`, `splunk_ta_sap_logserv` — whose absence is expected on a dedicated search head, as the row itself notes —
  `Splunk_MCP_Server`) are installed.
- **Summarised data (rollup collections)** — one row per rollup collection, grouped by the
  dashboard it powers, with TWO independent verdicts: **Freshness** (how recently the hourly or
  daily aggregation last wrote — a healthy hourly collection lags 1–2.5 h and is flagged STALE only above 3 h; daily collections are flagged above 50 h) and
  **History** (whether ~30 days of backfilled history exists — the same completeness convention
  Settings → Dashboard Data uses, computed from the same threshold). When rollups lack history
  the page says so and names the fix — *a Splunk administrator can run the backfill in
  Settings → Dashboard Data* — as text, not a button: the page intentionally carries **no
  destructive or admin controls**.
- **Sourcetypes** — per-sourcetype events in the window plus all-time last-seen.
- **What was checked** — the same honest ledger as the drawer, including anything skipped.
- **What cannot be checked from here** — the explicit list of things a browser session on the
  search head can never see for itself (the Data TA's ingest filters on the Heavy Forwarders —
  unless an operator supplies them, see below — the upstream
  LogServ feed, `index=_internal` for a restricted role), each with who to ask.
- **Saved Data Doctor reports** — see below.

The page's evidence is always labeled with the window it was **gathered** under ("Evidence as
of …"), the checks can be cancelled mid-run (partial results stay visible and say they are
partial), and **Download report (PDF)** produces the environment report from exactly the
evidence on screen.

!!! tip "Why the page has no auto-refresh picker"
    The per-dashboard auto-refresh interval picker is suppressed here: the page dispatches
    roughly one probe per rollup collection plus a set of environment checks — dozens per run — which should happen when *you* ask (open, time-range change, Re-run,
    or the nav-bar Refresh), not on a 30-second timer.

## :material-circle-box:{ .taiconcolor } Platform health (snapshot)

An hourly scheduled search (`logserv_diag_platform_aggregate`, two minutes past each hour) copies platform signals from `index=_internal` — scheduler outcomes and skip/deferral reasons, search-concurrency warnings, per-index throughput, pipeline-queue depth and PCRE-limit events — into a world-readable collection, so this page (and the environment report) can show platform health to **any** role, not just admins.

- When the snapshot is **stale, empty or unreadable**, the panel says *NOT AVAILABLE* with the verified reason (the producing search is disabled / has not run yet / has run but written nothing) — it never renders stale numbers as current facts.
- All snapshot figures are **context, never a cause**: the scheduler tables include this app's own hourly summarisation jobs, and the queue-depth gauge does not measure ingest-filter drops (the operator-supplied ingest-filter configuration below is the drop evidence).
- A stale dashboard summary's diagnosis can cite matching scheduler skips from the snapshot as an evidence line — always badged as *recorded by the hourly platform snapshot, a collection any authenticated Splunk user can write*, and never able to raise a verdict's confidence.

The snapshot keeps 30 days (daily retention at 01:58). It needs no backfill — it warms within the hour of install.

## :material-circle-box:{ .taiconcolor } Raw event samples (opt-in)

The panel diagnosis drawer's **Download PDF** offers an *Include raw event samples* checkbox (default off, reset every time the drawer opens). When ticked, the report appends up to **5 recent events** of the sourcetype(s) the panel reads — credential-scrubbed, email- and username-redacted, each included **in full** (a 20,000-character safety ceiling applies, disclosed on the event if ever reached — twice Splunk's default per-event truncation, so real events are never cut), and clearly labelled as **not** filtered by the panel's own host/provider selections (they show what the raw data looks like, not what the panel would have matched). The PDF renders events in a Latin-1 font, so characters outside that range may not display correctly there — the `.json` twin that downloads alongside every report carries the exact text. The report's cover banner states the samples' presence, and a sample-bearing report is **download-only**: it is never saved to the Saved-reports list, because storing raw events in a world-readable collection would bypass index access controls.

## :material-circle-box:{ .taiconcolor } Supplying the ingest-filter configuration

The one thing the Data Doctor cannot see for itself is the Data TA's ingest-tier filtering —
the include/exclude rules and the days-in-past cutoff run on the Heavy Forwarder / indexer
tier and silently discard events **before they are indexed**. Historically this is the single
most common cause of "I see zero events".

The Diagnostics page closes that gap with the **Ingest-tier filters (operator-supplied)**
panel: it prints the exact command to run, an operator pastes the output, and the diagnosis
gains two more checks that can turn that class of emptiness into a named, plain-language
verdict:

- *"Events this old are discarded at ingest by design — your selected range ends before the
  configured cutoff"* (the days-in-past reconciliation), and
- *"`<log type>` events are excluded by the configured filter rule `<rule>` — they are dropped
  before they reach the index"* — or, when an include list is the cause, *"not covered by the
  configured include list `<list>`"* (the include/exclude reconciliation), with the reminder
  that an intentional exclusion means nothing is broken.

Four paste formats are accepted: the REST response as JSON or XML, the generated
`local/transforms.conf`, and the settings conf. Practical notes:

- **Where to run the command matters.** On a distributed install the deployment server's
  REST endpoint is authoritative; on a single instance, this host's. On a **Heavy
  Forwarder** the REST endpoint reports shipped defaults regardless of the pushed
  configuration — paste the HF's `local/transforms.conf` file instead. If a paste exactly
  matches the shipped defaults, the diagnosis says so and keeps asking rather than treating
  filtering as ruled out.
- **The paste is credential-scrubbed before it is stored** (curl `-u` credentials,
  Authorization headers, passwords, tokens, session cookies), and for a fully parsed paste
  the raw text is not retained at all — only the parsed settings.
- **Everything derived from a paste is labelled** — *"Recorded as supplied by \<user\>,
  \<date\>"* — in the drawer's evidence, on this page, and in every report; it is never
  presented as something the app observed. After seven days the page asks for a re-supply,
  and verdicts built on older facts are hedged accordingly. If newer events contradict a
  supplied configuration (for example, events of a supposedly excluded type keep arriving),
  the diagnosis says the configuration appears out of date instead of trusting it.
- Saving re-runs the checks, so the page, the boundary text and any report you download move
  together. Re-pasting overwrites the previous supply; there is no delete.

Several refinements sharpen how the supplied configuration is used as evidence:

- **Replayed or backdated arrivals no longer evade the out-of-date check.** The diagnosis
  compares the supply time against both the newest *event timestamp* and the newest *index
  time* (from bucket metadata) of a supposedly excluded type. Events *recorded as indexed*
  after the supply — even when their event timestamps are old — soften the exclusion verdict
  and add a note asking for a re-supply, with a five-minute grace so ordinary clock skew
  cannot manufacture a contradiction.
- **The days-in-past verdict corroborates against the index's own oldest event** where that
  was probed: either *"events older than the cutoff do exist"* (indexed while they were still
  within the then-current cutoff) or an explicitly non-committal *"an always-active ingest
  filter, a young index, and ordinary retention all look identical here"*. Context only —
  it never changes the verdict's confidence.
- **A window that ends before the cutoff gets a context line even when the index is not
  empty** — when one log type has nothing in such a window, the *"events of this age arriving
  now would be dropped at ingest; the cutoff slides forward daily"* aside is attached to the
  verdict, so the sliding cutoff is considered without over-claiming it as the cause.
- **The Data TA's Cloud Provider stamp rides the paste.** A `local/transforms.conf` paste (or
  a settings-conf paste, which can also carry the explicit *Not set*) now records the
  configured `cloud_provider` stamp; on provider-filtered panels the diagnosis explains how
  the stamp interacts with the panel's filter — including that an `aws` filter also matches
  events with no provider at all, so a stamp mismatch never by itself explains an empty AWS
  panel. Absence of the stamp block in a paste is never read as "Not set" (the paste may be
  truncated).
- **The drawer points back here.** When a panel diagnosis lands on an ingest-ambiguous
  verdict and no usable configuration has been supplied, the "Why is this empty?" drawer (and
  its *Copy technical summary* text) adds: *"If a Splunk administrator supplies the Data TA's
  ingest-filter configuration on the Diagnostics page, this diagnosis can take those filters
  into account."* The pointer is suppressed when the stored supply merely could not be read.

Like every `logserv_*` collection, the stored configuration is world-writable by
authenticated users and is validated on read; treat it as a shared, unauthenticated-integrity
artifact. The supplied values steer *wording and attribution*, but the strong verdicts still
require the diagnostic's own first-hand observations (an actually-empty window, an
actually-absent sourcetype) to fire.

## :material-circle-box:{ .taiconcolor } Saved reports

Every downloaded Data Doctor report — panel, dashboard or environment, from any surface — is
also saved automatically into the app's KV Store (`logserv_diag_reports`), and the Diagnostics
page lists them: when it was generated, its scope, a one-line verdict summary, who generated
it, and the app build it came from. Any listed report can be re-downloaded as the identical
PDF or its JSON twin — useful for comparing a report from before and after a fix, or for
retrieving a report a colleague generated.

Housekeeping and integrity:

- Reports are kept for **365 days**, capped at the **newest 100** (a nightly retention search
  at 01:56 search-head local time enforces both).
- Very large reports (over ~200 KB of model data) are listed but not stored for re-download —
  the row says so; the copy downloaded at generation time is the complete one.
- Saved reports are visible to **all** users of the app and, like every app KV collection,
  writable by them. Treat them as shared, unauthenticated-integrity artifacts — the
  authoritative copy of any report is the one downloaded when it was generated. Stored rows
  are validated before re-rendering; anything malformed is skipped.

## :material-lightning-bolt:{ .taiconcolor } What to Look For

- **"NEVER BUILT" in the History column on a fresh install** — expected until the one-time
  backfill is run (Settings → Dashboard Data → Run backfill). Dashboards show only the last
  hour or two of data until then.
- **"STALE" Freshness on one collection while its neighbours are OK** — that rollup's hourly
  aggregation has stopped writing. An administrator should check its saved search (Settings →
  Dashboard Data shows the per-rollup schedule and enable state).
- **A sourcetype with recent "Last seen" but zero events in your window** — the feed is alive;
  your window simply predates or postdates its activity. The panel-level diagnosis states this
  explicitly ("the most recent one is from <date>, after this range … Nothing is stopped").
- **A sourcetype whose "Last seen" is days old** — the upstream feed for that log type may have
  stopped. That is an ingest-side question (Heavy Forwarder inputs, the LogServ feed itself) —
  the "What cannot be checked from here" section names the exact owner to ask — and once an
  operator supplies the ingest-filter configuration, the days-in-past / include-exclude class
  of emptiness gets a named verdict instead of a boundary note.
- **NOT CHECKED rows after a run** — the budget ran out or the run was cancelled/superseded.
  Re-run checks; the page never guesses about what it did not probe.
