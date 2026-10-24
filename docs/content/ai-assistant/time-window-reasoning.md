# Time-Window Reasoning

!!! info "Applies once an LLM provider credential is configured"
    The rules on this page shape what an LLM writes, so they apply only where free-form dispatch is live. The published v0.1.2 App package is the **full-LLM build variant**, but no LLM writes a narrative until an admin configures an [LLM provider credential](settings.md#provider-credentials-tab) — and none does where **Templates-only mode** is on or a compile-time templates-only build is installed ([Restricting the LLM Path](templates-only-build.md)). Predefined prompts are unaffected either way: they run over the window picked in the prompt browser's **Time range** list, and their guidance cards are static.

Time-window reasoning is a set of primer rules baked into the AI Assistant's system primer (present in both the Tier 1 and Tier 2 primer variants, in tier-appropriate forms — see below) that teach the LLM to **identify the dispatch window, normalize cumulative count to per-hour or per-day rate, and run a verify-query before declaring high-severity findings**. The rules ship as a dedicated `=== TIME-WINDOW REASONING — APPLY BEFORE EVERY SEVERITY CLAIM ===` block in the primer, inserted right after the data-boundary block and before the saved-search catalog.

This page exists primarily for **SOC analysts** who use the AI Assistant for top-N investigations: knowing how the AI reasons about windows + rates + verification helps you read its replies critically, validate its severity claims, and recognize its self-correction behavior.

## :material-circle-box:{ .taiconcolor } Why the Rules Exist

Without these rules, an AI can cite a cumulative count as if it were an active rate. In testing, the prompt *"find the top 10 issues I need to attend to in priority / severity"* produced a high-severity brute-force finding from 4,799 failed authentications for one user/stack pair, with advice to lock and rotate the accounts that day. The 4,799 was a count over the saved search's roughly 30-day window; the same data over the last 24 hours held 18 events on one host, which is baseline noise. A count alone cannot tell a 30-day baseline (about 160 a day) from a 24-hour burst, so the four rules below make the AI establish the window before it rates severity.

## :material-circle-box:{ .taiconcolor } The Four Rules

The primer block teaches the AI to apply these rules **before** declaring a finding's severity. The **Tier 2** primer carries all four; the **Tier 1** primer carries three (hedge the window / verify / state the window) — Rule 2's rate normalization needs aggregate numbers a Tier 1 summary never contains:

### Rule 1 — Identify the Window

Saved-search counts are CUMULATIVE over the window the search ran with: the `earliest_time` / `latest_time` the AI passed with the call (the primer tells it to pass one), or, when it passed none, the saved search's own configured time range. The global time-range picker in the header does not set that window, so it does NOT necessarily match it.

**Tier 1:** the summary the AI receives is `Returned N rows in Mms.` (inside the `<TOOL_RESULT_DATA>` wrapper) — no window data at all. The AI must hedge: *"X rows over the search's rolling window, exact span unknown"* OR infer from the saved-search NAME (e.g., `*_24h`, `*_after_hours`) when the name carries a window hint.

**Tier 2:** the summary includes a `Time range:` line ONLY when the result has a `_time` column (timecharts, time-series). When every `_time` value is a timestamp, both ends are ISO-8601 UTC timestamps the App writes and the line ends `(UTC).`; otherwise it reads `Time range: not shown (the _time values are not all timestamps).`. For aggregate searches like `stats by user`, no `_time` column → no time-range line → AI must hedge as in Tier 1.

### Rule 2 — Normalize Count → Rate

Convert sum / max from the aggregates to events/hour or events/day before assigning severity *(Tier 2 primer only — the Tier 1 primer has no normalization rule and no threshold table, since the AI never receives the numbers to normalize)*. Rough thresholds documented in the Tier 2 primer:

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

With **Templates-only mode** on, or in a templates-only build ([Restricting the LLM Path](templates-only-build.md)), free-form prompts are disabled — there's no LLM-driven verify path. The time-window rules don't apply because the AI doesn't run. Predefined prompts run over the window picked in the prompt browser and produce static interpretation cards (no AI synthesis), so no rate-reasoning step is needed.

### When Tier 1 is active

Tier 1 gives the AI count + timing only — it cannot see the actual values, so it cannot do Rule 2's normalization. The AI hedges harder: *"the search returned N rows for the rolling window, suggesting non-trivial activity"* without making rate claims. Tier 1 narrative is intentionally less concrete; users read the rendered tile for the actual numbers.

## :material-circle-box:{ .taiconcolor } Power Mode Compounds With Time-Window Reasoning

When [Power Mode](power-mode.md) is on AND a free-form prompt asks for top-N issues:

1. Power Mode forces a saved-search dispatch (Rule out: AI never replies from prior knowledge).
2. Each high/critical finding in the AI's reply forces an additional verify query (per Rule 3).
3. Result: a 5-finding top-N response can dispatch 5 saved searches + up to 5 verify queries = 10 total Splunk dispatches.

This is the correct behavior for compliance investigations and high-stakes triage — every claim is data-grounded AND verify-confirmed. The cost is higher per-turn latency + tool budget, but for the customer's most important investigations, the cost is the right trade.
