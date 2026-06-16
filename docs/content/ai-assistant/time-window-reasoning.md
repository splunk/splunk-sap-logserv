# Time-Window Reasoning

!!! warning "Current release: these primer rules are not exercised — LLM dispatch is disabled"
    The time-window reasoning rules are baked into the system primer and ship with every current build, but they only take effect when the LLM-driven path runs — which is **disabled at compile time** in the current release pending internal review. Predefined-prompt dispatches in the current release still respect the saved-search SPL's own time window (which is what the rules are about), but there is no AI synthesis layer applying these rules in the current release. This page is preserved as the design reference for the future release that re-enables the LLM path.

Time-window reasoning is a set of primer rules baked into the AI Assistant's system primer (Tier 1 + Tier 2 variants) that teach the LLM to **identify the dispatch window, normalize cumulative count to per-hour or per-day rate, and run a verify-query before declaring high-severity findings**. The rules ship as a dedicated `=== TIME-WINDOW REASONING — APPLY BEFORE EVERY SEVERITY CLAIM ===` block in the primer, inserted right after the data-boundary block and before the saved-search catalog.

This page exists primarily for **SOC analysts** who use the AI Assistant for top-N investigations: knowing how the AI reasons about windows + rates + verification helps you read its replies critically, validate its severity claims, and recognize its self-correction behavior.

## :material-circle-box:{ .taiconcolor } The Bug This Fixes

Before the time-window rules shipped, the AI sometimes cited cumulative aggregates as if they were active rates. A real example reproduced during the test cycle:

User prompt: *"find the top 10 issues I need to attend to in priority / severity"*.

The AI's first response cited:

> A. [severity:high] Likely brute-force on a Windows service account.
> One user/stack pair accumulated 4,799 failed authentications.
> Service-style accounts (sapadm, SYSTEM, svc_monitor, SAPServiceXCP, svc_backup) dominate.
> **Lock/rotate the affected accounts today**, confirm source host...

The 4,799 number was a **cumulative count over the saved search's wider rolling window** (~30 days for that prompt), NOT an active rate. Drilling into the same data with a `-24h` window returned **only 18 events across 5 service accounts on 1 host** — baseline noise, not an active brute-force. The AI's "Lock/rotate today" recommendation was wrong; the user almost took action on a false alarm.

The bug wasn't a data-access problem (the AI had the right number). The bug was a **reasoning problem**: the AI didn't know whether 4,799 was a 30-day baseline (~160/day = noise) or a 24-hour burst (= active threat). Aggregate value alone CANNOT distinguish.

## :material-circle-box:{ .taiconcolor } The Four Rules

The primer block teaches the AI to apply these four rules **before** declaring a finding's severity:

### Rule 1 — Identify the Window

Saved-search counts are CUMULATIVE over each search's own rolling window (typically -24h to -30d, baked into the saved-search SPL). The user's TimeRange picker in the UI does NOT necessarily align with that window.

**Tier 1:** the summary the AI receives is `Returned N rows in M ms.` — no window data at all. The AI must hedge: *"X rows over the search's rolling window, exact span unknown"* OR infer from the saved-search NAME (e.g., `*_24h`, `*_after_hours`) when the name carries a window hint.

**Tier 2:** the summary includes a `Time range:` line ONLY when the result has a `_time` column (timecharts, time-series). For aggregate searches like `stats by user`, no `_time` column → no time-range line → AI must hedge as in Tier 1.

### Rule 2 — Normalize Count → Rate

Convert sum / max from the aggregates to events/hour or events/day before assigning severity. Rough thresholds documented in the primer:

| Signal | High threshold |
|---|---|
| Auth failures | >10/hour |
| Warn-level errors | >100/hour |
| Ingest volume | >1000/hour |

A 4,799 cumulative count over 30 days = ~160/day = ~6.6/hour. For auth failures, that's below the >10/hour high threshold → severity should be medium or low, not high.

### Rule 3 — Verify Before Recommending Action

For any finding ranked `[severity:high]` or `[severity:critical]`, the AI MUST dispatch ONE additional `splunk_run_query` call with `earliest=-24h latest=now` BEFORE writing the narrative response. The verify either confirms the cumulative total is also a current rate, or reveals it's baseline noise.

If the verify returns dramatically smaller numbers than the cumulative headline, the AI must **re-rank the finding to medium or low and SAY SO in the body**. Active-tense claims ("Lock/rotate accounts today", "active brute-force", "data exfiltration in progress") MUST be backed by a verify query, never by a cumulative count alone.

### Rule 4 — State the Window in Narrative

Precise phrases:
- *"X events in the last 24 hours"* — for verify-confirmed claims
- *"X cumulative over the search's rolling window"* — for un-verified cumulative aggregates
- *"~Y/hour active rate, verify-confirmed"* — for normalized-to-rate severity claims

Active-tense phrases ("active brute-force", "happening today", "current attack") MUST be backed by a narrow-window verify query — not by cumulative counts or top-N aggregates alone.

## :material-circle-box:{ .taiconcolor } What "Verify-Confirmed Severity" Looks Like in Replies

After the rules shipped, the same prompt (re-run on the same data) produced a self-corrected response that explicitly downgrades the finding:

> G. [severity:medium] Cross-stack auth failures show high cumulative count but no current activity.
> [→ logserv_cross_stack_auth_failures] ↗ Cross-Stack Authentication ↗ Run SPL
> Top row showed 4,799 attempts but my -24h verify returned **only 19 auth failures** across all stacks combined — this is a **stale long-window aggregate, not an active brute-force**. No immediate action needed; review baselines.

The AI:

1. Cited the cumulative number (4,799) — appropriate context.
2. Ran the verify query (`-24h`) — required by Rule 3.
3. Reported the verify result (only 19) — required by Rule 4.
4. Re-ranked to medium — required by Rule 3.
5. Used precise window-aware language ("stale long-window aggregate, not an active brute-force") — required by Rule 4.
6. Recommended a non-urgent next step ("review baselines") instead of "Lock/rotate today".

This is the correct shape. When you read a top-N response, look for these markers:

- ✓ Findings ranked high or critical reference both a cumulative number AND a verify-query result
- ✓ Active-tense recommendations come ONLY from verified high-rate findings
- ✓ Findings that were going to be high but verified down to noise are explicitly downgraded with framing like "stale aggregate, not active"

## :material-circle-box:{ .taiconcolor } Edge Cases

### When the verify query also returns high counts

If a finding cites 4,799 cumulative AND the verify query returns 412 in the last 24h (~17/hour, above the >10/hour threshold), the AI keeps the finding at high severity and says: *"412 of those 4,799 landed today, ~17/hr — an active rate."* Now the active-tense "Lock/rotate today" recommendation is justified.

### When the saved-search name implies the window

Some prompts have window hints in their names: `logserv_dns_beaconing_24h`, `logserv_hana_after_hours_admin`. For these, the AI uses the name-implied window for Rule 1 and skips Rule 3's verify step (the saved search itself IS the narrow-window query).

### When no `splunk_run_query` is available (Templates-only)

In the [Templates-only build](templates-only-build.md), free-form prompts are disabled — there's no LLM-driven verify path. The time-window rules don't apply because the AI doesn't run. Predefined prompts have explicit windows in their SPL and produce static interpretation cards (no AI synthesis), so no rate-reasoning step is needed.

### When Tier 1 is active

Tier 1 gives the AI count + timing only — it cannot see the actual values, so it cannot do Rule 2's normalization. The AI hedges harder: *"the search returned N rows for the rolling window, suggesting non-trivial activity"* without making rate claims. Tier 1 narrative is intentionally less concrete; users read the rendered tile for the actual numbers.

## :material-circle-box:{ .taiconcolor } Power Mode Compounds With Time-Window Reasoning

When [Power Mode](power-mode.md) is on AND a free-form prompt asks for top-N issues:

1. Power Mode forces a saved-search dispatch (Rule out: AI never replies from prior knowledge).
2. Each high/critical finding in the AI's reply forces an additional verify query (per Rule 3).
3. Result: a 5-finding top-N response can dispatch 5 saved searches + up to 5 verify queries = 10 total Splunk dispatches.

This is the correct behavior for compliance investigations and high-stakes triage — every claim is data-grounded AND verify-confirmed. The cost is higher per-turn latency + tool budget, but for the customer's most important investigations, the cost is the right trade.
