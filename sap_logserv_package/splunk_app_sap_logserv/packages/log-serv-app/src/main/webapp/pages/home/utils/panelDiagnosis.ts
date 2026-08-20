/**
 * panelDiagnosis — the FREE checks and the cascade's first gates (session 093,
 * Phase 1 of the Missing-Data Diagnostic).
 *
 * Pure and React-free so it stays unit-testable, exactly like
 * `hybridRouting.ts`.
 *
 * WHAT "FREE" MEANS
 * -----------------
 * These checks dispatch NOTHING. They are pure functions of state the panel
 * already has: the SPL it ran (classified by `splProbe`), the window it ran
 * over, whether it was dispatched at all, its error, its row count, and the
 * global filter selections. That is what makes it safe to run them
 * automatically on every empty panel render — the cost is a memoised regex
 * parse, not a search.
 *
 * THE GUARD THAT SHAPES THIS WHOLE MODULE
 * ---------------------------------------
 * A free check may only produce an **Expected-class** verdict — "this is
 * working correctly and here is why you see nothing" — or a verbatim quote of
 * an error Splunk itself returned. It may NEVER assert a system fault
 * (a rollup that was never backfilled, an ingest gap, a broken extraction),
 * because every such claim needs dispatched evidence the free path does not
 * have. A panel must not be able to accuse the platform on a hunch.
 *
 * So when nothing honest can be said, `explainEmptyPanel` returns `null` and
 * the panel keeps the message it has always shown. Saying nothing is a valid,
 * and frequently correct, answer.
 *
 * GATE 0 — "nothing is wrong"
 * ---------------------------
 * The cascade's first gate is not a fault at all: the index has events, but
 * this panel's sourcetype/host genuinely has none in this window. Session
 * 012's 49-host scan found EVERY empty panel was of that class. A diagnostic
 * that cannot reach that verdict cries wolf on the most common case and gets
 * switched off (design doc, Risk 8).
 *
 * Gate 0 needs dispatched evidence (is there anything in the index at all? is
 * this sourcetype present anywhere?), so on the free path it evaluates to
 * `not-evaluated`. It is implemented here as a pure function over check
 * outputs so that the moment Phase 2 supplies that evidence, the gate is live
 * with no restructuring — and so the ordering is reviewable now.
 */

import { probeSpl, SplProbe } from './splProbe';
import { estimateWindowSeconds } from './timechartSpan';

/** How strongly the evidence supports a verdict. */
export type Confidence =
    /** A direct contradiction or an unambiguous error string was observed. */
    | 'confirmed'
    /** A necessary condition is present and no competing cause is. */
    | 'likely'
    /** A correlated signal only — the report states what would confirm it. */
    | 'possible'
    /** Correct, documented behaviour. Not a fault. */
    | 'expected'
    /** Could not be assessed; the verdict says why, and who can. */
    | 'not-evaluated';

/** Who can actually act on the finding. */
export type Owner = 'user' | 'splunk-admin' | 'ingest' | 'vendor' | 'nobody';

export interface Verdict {
    /** Stable identifier for the rule that produced this. */
    id: string;
    /** One plain-language sentence, written for a non-Splunk reader. */
    headline: string;
    /** A 2-5 word form for cramped surfaces (KPI cards). The full `headline`
     *  moves to the tooltip there. KPI cards sit in a height-equalising grid,
     *  so a wrapped 3-line sentence on ONE card lifts the whole row. */
    short: string;
    /** Optional second sentence with the technical specifics. */
    detail?: string;
    confidence: Confidence;
    owner: Owner;
    /** The observations the rule fired on, for the "show technical detail"
     *  disclosure and the report's evidence table. */
    evidence: string[];
}

/** Everything the free checks are allowed to look at. */
export interface PanelFacts {
    /** The dispatched SPL, verbatim. */
    spl: string;
    /** The window the search actually ran over. */
    earliest: string;
    latest: string;
    /** False when the hook deliberately dispatched nothing. */
    dispatched: boolean;
    loading: boolean;
    /** Splunk's error message, if the search failed. */
    errorMessage?: string | null;
    /** Rows returned; null when nothing has arrived. */
    rowCount: number | null;
    /** The global cloud-provider picker value ('all' when unfiltered). */
    cloudProvider?: string;
    /** §17.1 — the byte-equal raw twin of a cached panel's query, resolved at
     *  drawer-request build time via `rawTwinFor(spl)`. Feeds check 21. */
    rawAlternate?: string | null;
    /** §18.8a-7 — set ONLY by the KPI Diagnose entry point, and only when the
     *  card's own displayed value was genuinely zero/absent (formatted zeros
     *  like "0 ms" count; an empty string does NOT — `Number('') === 0`).
     *  Routes the diagnosis into the effective-empty branch. Never derived
     *  from the SPL shape alone (`emptySafeKpi` alone must not route —
     *  invariant §18.8a-7). */
    zeroValued?: boolean;
}

/** §18.8a-5 — the TOTAL diagnosis-mode derivation. `unknown` (a still-loading
 *  or never-classified panel) REFUSES diagnosis rather than defaulting to
 *  empty: a null rowCount cannot distinguish "no rows" from "no answer yet"
 *  (the useSearch contract), and diagnosing an unknown panel as empty was the
 *  review's blocker W-2(3). */
export type PanelMode = 'empty' | 'partial' | 'unknown';

export const diagnosisMode = (facts: PanelFacts): PanelMode => {
    if (facts.rowCount === 0) return 'empty';
    if (facts.rowCount === null || facts.rowCount === undefined) return 'unknown';
    // rowCount > 0 with a zero displayed value = the §18.4 effective-empty
    // request; the KPI entry point is the only setter of `zeroValued`.
    if (facts.zeroValued === true) return 'empty';
    return 'partial';
};

const SECONDS_PER_HOUR = 3600;
const SECONDS_PER_DAY = 86400;

const listSourcetypes = (probe: SplProbe): string =>
    probe.sourcetypes.length === 1
        ? `\`${probe.sourcetypes[0]}\``
        : probe.sourcetypes.map((s) => `\`${s}\``).join(', ');

/**
 * CHECK 20 — time-grain / routing compatibility.
 *
 * A KV-Store rollup stores hour-aligned (`bucket_ts`) or midnight-aligned
 * (`day_ts`) buckets. A window narrower than the grain cannot address a whole
 * bucket, so the panel reads EMPTY when the window falls inside one bucket, or
 * the WHOLE bucket when it straddles a boundary (the ~4x overcount documented
 * in the session-054 scale report).
 *
 * `useHybridSearch` already routes sub-90-minute windows to a raw arm for the
 * panels that have one, so this fires exactly on the residual: panels that are
 * cached-only. In practice that is the `span=1d` sparklines (never
 * hybridised — the sibling KPI can route to raw while its sparkline does not)
 * and the daily beaconing-detection reads.
 *
 * Returns null unless the panel structurally cannot answer the window.
 */
const checkTimeGrain = (facts: PanelFacts, probe: SplProbe, mode: PanelMode = 'empty'): Verdict | null => {
    // The tier/range guard is belt-and-braces: `grain` is only ever set by the
    // rollup range-filter regex, so a raw or tstats query already has
    // `grain: 'none'` and falls through below. Kept explicit so the rule stays
    // correct if a future query composes a raw arm with an appended rollup
    // subsearch (which would carry a bucket_ts filter without being a rollup
    // read). Mutation-testing confirms it is redundant TODAY, not in principle.
    if (probe.tier !== 'cached' || !probe.hasRangeFilter) return null;
    const span = estimateWindowSeconds(facts.earliest, facts.latest);
    // §18.8a-19 — a POPULATED panel on a too-narrow window is the documented
    // ~4x boundary overcount, not emptiness; the check stays live in partial
    // mode with the numbers-may-be-wrong phrasing.
    const partial = mode === 'partial';

    if (probe.grain === 'hourly' && span < SECONDS_PER_HOUR) {
        return {
            id: 'time-grain-hourly',
            short: 'Range under 1 hour',
            headline: partial
                ? 'Your time range is shorter than an hour, and this panel reads hourly summarised data — it may be showing a whole hour rather than exactly your range.'
                : 'Your time range is shorter than an hour, and this panel reads hourly summarised data.',
            detail: partial
                ? 'A sub-hour range that crosses an hourly bucket boundary returns the WHOLE bucket, so the numbers can overcount your range. Widen the range to an hour or more for exact figures.'
                : 'A sub-hour range either falls inside one hourly bucket (showing nothing) or crosses a boundary (showing the whole hour). Widen the range to an hour or more.',
            confidence: 'expected',
            owner: 'user',
            evidence: [
                `Read tier: cached rollup (${probe.collection ?? 'unknown collection'}), hourly bucket_ts grain`,
                `Window: ${facts.earliest} → ${facts.latest} (~${Math.round(span / 60)} min)`,
            ],
        };
    }

    if (probe.grain === 'daily' && span < SECONDS_PER_DAY) {
        return {
            id: 'time-grain-daily',
            short: 'Range under 1 day',
            headline:
                'Your time range is shorter than a day, and this panel reads once-a-day summarised data.',
            detail:
                'This detection runs daily, so a range narrower than one day usually contains no daily bucket at all. Widen the range to a day or more.',
            confidence: 'expected',
            owner: 'user',
            evidence: [
                `Read tier: cached rollup (${probe.collection ?? 'unknown collection'}), daily day_ts grain`,
                `Window: ${facts.earliest} → ${facts.latest} (~${Math.round(span / 3600)} h)`,
            ],
        };
    }

    return null;
};

/**
 * CHECKS 1-2 — active global filters.
 *
 * Both the cloud-provider filter and the host filter are STICKY: the cloud
 * picker persists per user in localStorage and applies to every dashboard, so
 * a selection made weeks ago silently narrows every panel in the app. That
 * makes "you have a filter on" one of the most valuable free statements
 * available — and it is purely Expected-class.
 */
const checkActiveFilters = (facts: PanelFacts, probe: SplProbe): Verdict | null => {
    const parts: string[] = [];
    const evidence: string[] = [];

    /* Session 094 — attribute a provider constraint to the GLOBAL picker only
     * when the picker is actually set.
     *
     * The previous form preferred the SPL-derived provider over the picker's
     * value. That is wrong for Multi-Cloud Overview, whose Azure and GCP KPI
     * queries carry `cloud_provider="azure"` / `"gcp"` BY DESIGN — that
     * dashboard is deliberately exempt from the global filter. With the picker
     * on "All" those two cards told the user *"once the Cloud filter is set to
     * AZURE"*, i.e. to go and change a filter they had never set. Observed live
     * on build 306 while writing the visual-validation plan.
     *
     * A provider seen only in the SPL is INTRINSIC to the panel. Saying so is
     * true whatever the picker holds; blaming the picker is not.
     *
     * The test is deliberately a CONJUNCTION — picker set AND the query's own
     * provider equal to it — because that agreement is the only thing that
     * actually proves `withCloudProvider` did the splicing. Two cases break a
     * looser test, and both are live:
     *   - The picker is sticky app-wide, so a provider chosen on Linux is still
     *     set while the user is on Multi-Cloud Overview, whose Azure card pins
     *     `cloud_provider="azure"` itself. "Picker is set" alone would then
     *     credit the picker for a constraint it did not apply.
     *   - Multi-Cloud Overview, Environment Topology and Settings are EXEMPT
     *     from the filter, so their queries carry no provider term at all. With
     *     the picker set, "picker is set" alone would blame it for an empty
     *     panel it cannot possibly have narrowed. */
    const picker =
        facts.cloudProvider && facts.cloudProvider !== 'all' ? facts.cloudProvider : undefined;
    const splProvider = probe.cloudFilter?.provider;
    const globalProvider = picker && splProvider === picker ? picker : undefined;
    const intrinsicProvider = !globalProvider ? splProvider : undefined;

    if (globalProvider) {
        parts.push(`the Cloud filter is set to ${globalProvider.toUpperCase()}`);
        evidence.push(`Cloud-provider filter spliced into the query: cloud_provider="${globalProvider}"`);
    } else if (intrinsicProvider) {
        // Mentioned alongside any other filter so it is not silently dropped;
        // when it is the ONLY constraint it becomes its own verdict below.
        parts.push(`this panel only counts ${intrinsicProvider.toUpperCase()} events`);
        evidence.push(
            `The panel's own query constrains cloud_provider="${intrinsicProvider}" (not the global filter).`,
        );
    }

    const hf = probe.hostFilter;
    if (hf) {
        if (hf.form === 'topn') {
            parts.push(`only the top ${hf.topN ?? 'N'} hosts are included`);
            evidence.push(`Host filter: top ${hf.topN ?? 'N'} hosts by volume`);
        } else if (hf.hosts.length === 1) {
            parts.push(`the host filter is set to ${hf.hosts[0]}`);
            evidence.push(`Host filter: host="${hf.hosts[0]}"`);
        } else if (hf.hosts.length > 1) {
            parts.push(`the host filter is limited to ${hf.hosts.length} hosts`);
            evidence.push(`Host filter: ${hf.hosts.length} hosts (${hf.hosts.slice(0, 3).join(', ')}${hf.hosts.length > 3 ? ', …' : ''})`);
        }
    }

    const what =
        probe.sourcetypes.length > 0
            ? `no ${listSourcetypes(probe)} events`
            : 'no matching events';

    if (parts.length === 0) return null;

    /* The panel's own provider constraint, with nothing the user set alongside
     * it, gets its own verdict: the combined sentence below is written around
     * "a filter you can change", and this is not one. Owner is `nobody` — there
     * is no setting to adjust. */
    if (intrinsicProvider && parts.length === 1) {
        const P = intrinsicProvider.toUpperCase();
        return {
            id: 'intrinsic-provider',
            short: `No ${P} events`,
            headline: `This panel only counts ${P} events, and there are none in this time range.`,
            detail: 'It is not affected by the Cloud filter — the provider is part of the panel itself.',
            confidence: 'expected',
            owner: 'nobody',
            evidence,
        };
    }

    const shortBits: string[] = [];
    if (globalProvider) shortBits.push(`Cloud=${globalProvider.toUpperCase()}`);
    else if (intrinsicProvider) shortBits.push(`${intrinsicProvider.toUpperCase()} only`);
    if (hf) {
        shortBits.push(
            hf.form === 'topn'
                ? `Top ${hf.topN ?? 'N'} hosts`
                : hf.hosts.length === 1
                  ? '1 host'
                  : `${hf.hosts.length} hosts`,
        );
    }

    return {
        id: 'active-filters',
        short: `Filtered: ${shortBits.join(', ')}`,
        headline: `There are ${what} for this view once ${parts.join(' and ')}.`,
        detail: 'Clearing or widening that filter is the quickest way to check.',
        confidence: 'expected',
        owner: 'user',
        evidence,
    };
};

/** The search failed. Quote Splunk verbatim — the message IS the diagnosis. */
const checkSearchError = (facts: PanelFacts): Verdict | null => {
    if (!facts.errorMessage) return null;
    return {
        id: 'search-error',
        short: 'Search failed',
        headline: 'This panel’s search did not complete.',
        detail: facts.errorMessage,
        confidence: 'confirmed',
        owner: 'splunk-admin',
        evidence: [`Splunk returned: ${facts.errorMessage}`],
    };
};

/** The hook mounted but deliberately dispatched nothing. §18.8a-4: fires ONLY
 *  on an explicit `false` — an entry point that could not establish the flag
 *  passes `undefined`, and headlining "did not run a search" on a panel that
 *  visibly rendered data was the review's blocker H-F1(a). */
const checkNotDispatched = (facts: PanelFacts): Verdict | null => {
    if (facts.dispatched !== false) return null;
    return {
        id: 'not-dispatched',
        short: 'Not run',
        headline: 'This panel did not run a search.',
        detail: 'It is waiting on a selection above — pick a value and it will populate.',
        confidence: 'expected',
        owner: 'user',
        evidence: ['The search was mounted with enabled=false or an empty query.'],
    };
};

/**
 * A rollup read with no `info_min_time`/`info_max_time` range filter ignores
 * the time picker entirely, so an empty result says nothing about the window.
 * Worth stating because the panel's own message ("in this time range") is then
 * actively misleading.
 */
const checkNoRangeFilter = (probe: SplProbe): Verdict | null => {
    if (probe.tier !== 'cached' || probe.hasRangeFilter) return null;
    return {
        id: 'no-range-filter',
        short: 'Not time-filtered',
        headline: 'This panel reads stored data that is not filtered by the time picker.',
        detail: 'Changing the time range will not change what it shows.',
        confidence: 'expected',
        owner: 'user',
        evidence: [`Rollup read of ${probe.collection ?? 'a KV Store collection'} with no time-range filter.`],
    };
};

/**
 * Static predicate lint. These ARE fault-class, but they are the one exception
 * the guard permits: the defect is visible in the dispatched string itself, so
 * the evidence is complete and local — nothing needs to be dispatched to prove
 * that `icm_is_error=1` can never match a field that holds "true"/"false".
 *
 * Owner is the vendor, because every instance of this class has been a bug in
 * OUR shipped SPL, not in the customer's data.
 */
const checkLint = (probe: SplProbe): Verdict | null => {
    if (probe.lint.length === 0) return null;
    const first = probe.lint[0];
    return {
        id: `lint-${first.code}`,
        short: 'Query defect',
        headline: 'This panel’s query contains a clause that cannot match anything.',
        detail: first.explanation,
        confidence: 'confirmed',
        owner: 'vendor',
        evidence: probe.lint.map((l) => `${l.code}: ${l.fragment}`),
    };
};

/**
 * GATE 0 — "nothing is wrong."
 *
 * Requires dispatched evidence (does the index hold events in this window at
 * all, and does this sourcetype exist anywhere?). On the free path both are
 * unknown, so the gate reports `not-evaluated` and names what would settle it
 * — never "healthy".
 *
 * @param indexHasEventsInWindow  undefined = not checked
 * @param sourcetypePresentInWindow  undefined = not checked
 */
export const evaluateGate0 = (
    probe: SplProbe,
    indexHasEventsInWindow?: boolean,
    sourcetypePresentInWindow?: boolean,
): Verdict => {
    if (indexHasEventsInWindow === undefined || sourcetypePresentInWindow === undefined) {
        return {
            id: 'gate0',
            short: 'Not checked',
            headline: 'Whether this data simply does not exist has not been checked yet.',
            confidence: 'not-evaluated',
            owner: 'nobody',
            evidence: [
                'Needs two counting searches: events in the index for this window, and events of this panel’s sourcetype.',
            ],
        };
    }
    if (indexHasEventsInWindow && !sourcetypePresentInWindow) {
        const what = probe.sourcetypes.length > 0 ? listSourcetypes(probe) : 'this panel’s data';
        return {
            id: 'gate0',
            short: 'No such data',
            headline: `There genuinely are no ${what} events in this time range — nothing is broken.`,
            detail:
                'The index is receiving data; this particular kind of event just did not occur in the window you selected.',
            confidence: 'expected',
            owner: 'nobody',
            evidence: [
                'The index has events in this window.',
                'This panel’s sourcetype has none.',
            ],
        };
    }
    return {
        id: 'gate0',
        short: 'Inconclusive',
        headline: 'The panel’s emptiness is not explained by an absence of this event type.',
        confidence: 'not-evaluated',
        owner: 'nobody',
        evidence: [
            `Index has events in window: ${String(indexHasEventsInWindow)}`,
            `Sourcetype present in window: ${String(sourcetypePresentInWindow)}`,
        ],
    };
};

/**
 * Run the free checks in cascade order and return the single most explanatory
 * verdict, or null when nothing honest can be said.
 *
 * Order is deliberate and is the cascade, not a score: an error supersedes
 * everything (the search never produced an answer); a query that cannot match
 * supersedes any statement about the data; structural incompatibility with the
 * time range supersedes a filter hint (both may be true, but the range is the
 * thing to change first).
 */
export const explainEmptyPanel = (facts: PanelFacts, mode: PanelMode = 'empty'): Verdict | null => {
    if (facts.loading) return null;
    const probe = probeSpl(facts.spl);

    return (
        checkSearchError(facts) ??
        checkNotDispatched(facts) ??
        checkLint(probe) ??
        checkNoRangeFilter(probe) ??
        checkTimeGrain(facts, probe, mode) ??
        // §18.8a-19 — in partial mode the active-filter facts demote to a
        // context evidence line (`activeFilterContextLines`); the "There are
        // no … events" sentence is emptiness-specific.
        (mode === 'partial' ? null : checkActiveFilters(facts, probe)) ??
        null
    );
};

/** All free verdicts, in cascade order — for the Phase-2 drawer and the
 *  report's evidence table, which show every check rather than just the top
 *  one. `mode` defaults 'empty' so every existing caller (KpiCard's zero-value
 *  hint, EmptyStateHint, the dashboard sweep) keeps today's behaviour BY
 *  CONSTRUCTION (§18.8a-18, review findings W-6/W-12). */
export const allFreeVerdicts = (facts: PanelFacts, mode: PanelMode = 'empty'): Verdict[] => {
    const probe = probeSpl(facts.spl);
    return [
        checkSearchError(facts),
        checkNotDispatched(facts),
        checkLint(probe),
        checkNoRangeFilter(probe),
        checkTimeGrain(facts, probe, mode),
        mode === 'partial' ? null : checkActiveFilters(facts, probe),
    ].filter((v): v is Verdict => v !== null);
};

/** §18.8a-19 — the active-filter FACTS as context lines for the partial-mode
 *  floor/fallback (the check's verdict form is emptiness-phrased). */
export const activeFilterContextLines = (facts: PanelFacts): string[] => {
    const v = checkActiveFilters(facts, probeSpl(facts.spl));
    return v ? v.evidence.slice() : [];
};
