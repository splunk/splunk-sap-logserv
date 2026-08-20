/**
 * diagCascade — the ordered gates that turn evidence into a verdict
 * (session 094/095, Phase 2 of the Missing-Data Diagnostic).
 *
 * Written against §12 of `missing_data_diagnostic_design_v0.1_20260807.md`,
 * which is the pre-implementation review's correction of the original design.
 * Two of three review lenses returned `do-not-ship` against that first version;
 * the five things they found are load-bearing here and each is called out at
 * the gate it constrains.
 *
 * NOT A SCORE. Scoring soup produces confident nonsense. These causes are
 * hierarchical — if the search never ran, rollup freshness is irrelevant — so
 * this is an ordered cascade of pure functions over check outputs. Same
 * evidence, same verdict, explainable line by line.
 *
 * THE FREE CHECKS COME FIRST, AND THEY ARE THE SAME OBJECTS
 * --------------------------------------------------------
 * The drawer must never contradict the inline hint on the same panel, so the
 * free cascade is not re-implemented here — `allFreeVerdicts` is imported and
 * runs first, in its own order. A panel whose own search FAILED must say so
 * before any dispatched probe gets a word in; otherwise an independent probe
 * could short-circuit with a health verdict while the panel itself is broken
 * (design §12.5).
 *
 * UNKNOWN IS NOT FALSE
 * --------------------
 * Every field of `PanelEvidence` is `null` when its probe did not run or
 * failed. A gate that read `null` as a negative would turn "we ran out of
 * time" into "there is genuinely none of it" — the exact class of wrong verdict
 * the design calls a support liability. Every gate below returns a
 * `not-evaluated` verdict naming the reason instead (design §12.3).
 */

import {
    Verdict,
    PanelFacts,
    PanelMode,
    allFreeVerdicts,
    activeFilterContextLines,
    diagnosisMode,
    evaluateGate0,
} from './panelDiagnosis';
import { probeSpl, SplProbe } from './splProbe';
import { PanelEvidence, FALLBACK_SOURCETYPE, INGEST_FACTS_CHECK_NAME } from './diagEvidence';
import { SNAPSHOT_PROVENANCE } from './diagPlatform';
import {
    IngestFacts,
    SOURCETYPE_CLZ_MAP,
    TAG_CLZ_MAP,
    INGEST_CUTOFF_MIN_MARGIN_SECONDS,
    INGEST_RECENT_SKEW_SECONDS,
    pathsDropStatus,
    namedRuleFor,
    provenanceLine,
    staleCaveatLine,
    suppliedConfidenceCap,
    minConfidence,
    SuppliedConfidence,
    ingestCutoffApplicable,
    factsUsableForBoundary,
    knownStamp,
} from './diagIngestFacts';

export interface Diagnosis {
    /** The single most explanatory verdict. Never null — when nothing can be
     *  concluded it is an explicit "we could not determine the cause", because
     *  a diagnostic that goes quiet is indistinguishable from one that crashed. */
    top: Verdict;
    /** Every gate that had something to say, in cascade order, INCLUDING the
     *  not-evaluated ones — the drawer shows what was not checked and why. */
    all: Verdict[];
    /** At least one probe was skipped, so `top` may be under-informed. */
    incomplete: boolean;
}

/** Three hours. The lag threshold is NOT two.
 *
 *  Each hourly aggregate runs at its own staggered minute (`:03` stmap through
 *  `:28` webdisp_slowtrace) over `-1h@h..@h`, and writes a bucket stamped at
 *  the START of the previous hour. So a perfectly healthy collection sits at
 *  `1h + M` of lag immediately after its run and `2h + M` just before the next
 *  one — a >2h rule would flag every collection with M > 0, every hour
 *  (design §12.8). */
export const STALE_LAG_SECONDS = 3 * 3600;

/** Fifty hours — the DAILY-grain twin of the rule above (session 095,
 *  finding 3). A `day_ts` bucket is stamped at the START of its day and
 *  written by the 00:30 aggregate the NEXT day, so a perfectly healthy daily
 *  collection sits at 24.5h of lag right after the write and ~48.5h just
 *  before the next one. Applying the 3h hourly rule here flagged every
 *  beaconing diagnosis as "stale" on an untouched box, every day. */
export const STALE_LAG_DAILY_SECONDS = 50 * 3600;

/** §14.2 thresholds — exported + gate-pinned so an edit must consciously touch
 *  the boundary fixtures (the STALE_LAG convention).
 *
 *  The PRIMARY discriminator for `routing-not-applied` is
 *  `routedRowsInWindow === 0`: transforms route every kind on the same tier,
 *  so a SINGLE routed event in the window disproves "routing is not applied"
 *  outright — this is what keeps the verdict away from legitimately
 *  fallback-heavy estates (the live Azure Cribl `undefined/undefined` state
 *  ran at 66–74% fallback share on real days WITH routing working, and the
 *  documented Secondary log types land under the fallback BY DESIGN).
 *
 *  The share is a SECONDARY sanity guard (computed against the whole-index
 *  in-window count when known): on a healthy primary-types install the
 *  fallback share is near zero; with routing absent it is ~1.0; 0.5 is the
 *  majority split. The floor keeps the verdict out of near-empty windows,
 *  where a handful of events makes any share statistical noise. */
export const ROUTING_FALLBACK_MIN_SHARE = 0.5;
export const ROUTING_FALLBACK_MIN_EVENTS = 50;

/** §14.5 — future-timestamp guard. Fifteen minutes clears legitimate clock
 *  drift and `approxEpoch` snap imprecision; note `nowSec` is the BROWSER
 *  clock, which the verdict wording hedges. */
export const FUTURE_TS_GUARD_SECONDS = 900;

/**
 * Best-effort ABSOLUTE epoch for one bound of a dispatched window. Same
 * parser family as `estimateWindowSeconds` (timechartSpan.ts): epoch strings,
 * "now", ISO dates, and Splunk relative `[+-]N{unit}` with the `@snap`
 * suffix IGNORED — so a snapped bound can be off by up to one snap unit.
 * Every consumer therefore treats the result as approximate and only draws
 * Expected-class or hedged conclusions from it, never a confirmed fault on a
 * near-boundary comparison. Null = unparseable, and the caller must skip the
 * comparison entirely rather than guess.
 */
const approxEpoch = (s: string, nowSec: number): number | null => {
    if (!s) return null;
    const t = s.trim();
    if (t === 'now' || t === 'rt') return nowSec;
    if (/^\d{9,}(\.\d+)?$/.test(t)) {
        const n = Number(t);
        return Number.isFinite(n) ? Math.floor(n) : null;
    }
    if (/^\d{4}-\d{2}-\d{2}/.test(t)) {
        const p = Date.parse(t);
        return Number.isFinite(p) ? Math.floor(p / 1000) : null;
    }
    const stripped = t.replace(/^rt/, '').replace(/@.*$/, '');
    if (stripped === '0') return 0;
    const m = stripped.match(/^([+-]?)(\d+)(mon|[smhdwy])$/);
    if (!m) return null;
    const sign = m[1] === '-' ? -1 : 1;
    const n = parseInt(m[2], 10);
    const mult: Record<string, number> = {
        s: 1,
        m: 60,
        h: 3600,
        d: 86400,
        w: 7 * 86400,
        mon: 30 * 86400,
        y: 365 * 86400,
    };
    return nowSec + sign * n * (mult[m[3]] ?? 0);
};

const fmtDate = (epochSeconds: number): string =>
    new Date(epochSeconds * 1000).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';

const agoDays = (epochSeconds: number): number =>
    Math.max(0, Math.floor(Date.now() / 1000 - epochSeconds) / 86400);

const fmtAgo = (epochSeconds: number): string => {
    const d = agoDays(epochSeconds);
    if (d < 1) return 'less than a day ago';
    if (d < 2) return 'about a day ago';
    return `about ${Math.round(d)} days ago`;
};

const notEvaluated = (id: string, headline: string, why: string): Verdict => ({
    id,
    short: 'Not checked',
    headline,
    confidence: 'not-evaluated',
    owner: 'nobody',
    evidence: [why],
});

/* ---------------------------------------------------------------------------
 * §18.8a-20 — the partial-mode verdict-id classification, DERIVED-checkable.
 *
 * A partial-mode diagnosis (the panel HAS rows) may never emit an emptiness-
 * family verdict: the rows are living proof the read path works. The build
 * gate asserts every `id:` literal in this file + panelDiagnosis.ts appears in
 * exactly one of these two sets (or is a `lint-` dynamic / a notEvaluated
 * placeholder, which are mode-neutral by construction) — a new unclassified
 * id FAILS THE BUILD rather than silently escaping the invariant.
 * ------------------------------------------------------------------------- */

/** Verdicts that assert or explain EMPTINESS — forbidden in partial mode. */
export const EMPTINESS_VERDICT_IDS: readonly string[] = [
    'index-empty-in-window',
    'index-not-visible',
    'ingest-type-excluded',
    'ingest-window-before-cutoff',
    'kvstore-not-ready',
    'rollup-gap',
    'rollup-has-rows',
    'rollup-leading-edge',
    'rollup-metric-empty',
    'rollup-never-built',
    'rollup-source-never-seen',
    'rollup-stale',
    'rollup-window-uncovered',
    'routing-not-applied',
    'source-absent',
    'sourcetype-never-seen',
    'sourcetype-outside-window',
    'sourcetype-stale',
    'cache-contradicted',
    'cached-raw-agree-empty',
    'clause-excludes-all',
    'field-never-populated',
    'field-value-mismatch',
    'lookup-not-registered',
    'undetermined',
    'gate0',
    'active-filters',
    'intrinsic-provider',
    // The §18.4 zero-resolution pair reasons from the effective-EMPTY branch.
    'panel-zero-confirmed',
    'zero-value-mismatch',
] as const;

/** Verdicts a partial-mode diagnosis may emit. */
export const PARTIAL_ALLOWED_VERDICT_IDS: readonly string[] = [
    'search-error',
    'not-dispatched',
    'no-range-filter',
    'time-grain-hourly',
    'time-grain-daily',
    'extraction-app-missing',
    'ingest-facts-contradicted',
    'sourcetype-future-timestamps',
    'column-never-populated',
    'column-not-summarised',
    'column-not-stored',
    'panel-data-present',
    'partial-undetermined',
] as const;

/* --------------------------------------------------------------------------
 * §18 partial-mode verdict builders.
 * ------------------------------------------------------------------------ */

const PARTIAL_FALLBACK: Verdict = {
    id: 'partial-undetermined',
    short: 'No defect found',
    headline: 'We could not identify a problem with this panel’s data.',
    detail:
        'The panel returned data, and the checks that could run found no defect. ' +
        'The technical detail below is what to send to Splunk support if something still looks wrong.',
    confidence: 'not-evaluated',
    owner: 'nobody',
    evidence: ['The partial-data checks completed without identifying a defect.'],
};

/** §18.8a-15 — the shipped check-22 scope-honesty sentence, restated for the
 *  column tier (the cached-population caveat rides separately). */
const columnSampleNote = (sampled: number | null, scope: string): string =>
    sampled !== null && sampled >= 2000
        ? `Checked against the ${sampled} most recent ${scope} events (a sample; the panel's own host / cloud / breakdown filters were NOT applied).`
        : `Checked against all ${sampled ?? 0} ${scope} events in this window (the panel's own host / cloud / breakdown filters were NOT applied).`;

/** GATE COL — the §18.3/§18.8a column tier. Returns fault verdicts, the honest
 *  floor, or the not-evaluated degradation — never null when a columnProbe
 *  exists. Null only when the tier did not run at all. */
const gateColumns = (probe: SplProbe, ev: PanelEvidence, facts: PanelFacts): Verdict | null => {
    const cp = ev.columnProbe;
    if (!cp) return null;
    const scope =
        ev.sourceScope && ev.sourceScope.sourcetypes.length > 0
            ? ev.sourceScope.sourcetypes.map((s) => `\`${s}\``).join(', ')
            : probe.sourcetypes.length > 0
              ? probe.sourcetypes.map((s) => `\`${s}\``).join(', ')
              : 'this panel’s source';
    const capNote = cp.capped
        ? ` (examined over the first ${cp.totalRows} rows this panel returned, in its own sort order)`
        : '';
    const cachedCaveat =
        probe.tier === 'cached'
            ? ' The summarised rows this panel reads may span a different period than this recent-events sample.'
            : '';

    // §18.8a-13 — a column the aggregate provably does not store beats every
    // other cached-branch story, and a backfill cannot help it.
    const notStored = cp.blanks.find((b) => b.storedByAggregate === false);
    if (notStored) {
        return {
            id: 'column-not-stored',
            short: 'Column not stored',
            headline: `The summarisation that builds this view does not store \`${notStored.column}\` — a backfill cannot add it.`,
            detail:
                'The aggregation search’s stored field list does not include this column, so every summarised row lacks it by construction. Report this to your Splunk team / the app vendor.',
            confidence: 'likely',
            owner: 'vendor',
            evidence: [
                `\`${notStored.column}\` is blank on all ${cp.totalRows} returned rows${capNote}.`,
                'The traced aggregation’s terminal field list does not carry it.',
            ],
        };
    }

    for (const b of cp.blanks) {
        if (b.present === null) continue; // probe did not complete — handled below
        const probedAs = b.probeName !== b.column ? ` (probed as its source field \`${b.probeName}\`)` : '';
        if (b.present === 0) {
            // §18.8a-2/12/15: the extraction-gap shape; a capped reduction or a
            // capped sample degrades to possible.
            const capped = cp.capped || (cp.sampled !== null && cp.sampled >= 2000);
            return {
                id: 'column-never-populated',
                short: 'Column not populated',
                headline: `This panel displays \`${b.column}\`${probedAs}, but that field is not populated on ${scope}.`,
                detail:
                    (probe.tier === 'cached'
                        ? 'The underlying source events do not carry it either, so the gap is upstream of the summarisation — '
                        : '') +
                    'this is usually a search-time extraction issue: a missing add-on, a broken props extraction chain, or a field that only exists on a different sourcetype. A Splunk administrator can confirm the extraction.',
                confidence: capped ? 'possible' : 'likely',
                owner: 'splunk-admin',
                evidence: [
                    `\`${b.column}\` is blank (${b.blankKind}) on all ${cp.totalRows} returned rows${capNote}.`,
                    `\`${b.probeName}\` present on 0 of ${cp.sampled ?? 0} sampled events.`,
                    columnSampleNote(cp.sampled, scope) + cachedCaveat,
                ],
            };
        }
        if (probe.tier === 'cached' && b.present > 0) {
            return {
                id: 'column-not-summarised',
                short: 'Column lost in summary',
                headline: `The summarised rows this panel reads do not carry \`${b.column}\`, though the underlying events do.`,
                detail:
                    'The aggregation that builds this view appears to drop or not populate it. Re-running the backfill from Settings -> Dashboard Data is safe; if the column stays blank afterwards, report it.',
                confidence: 'possible',
                owner: 'splunk-admin',
                evidence: [
                    `\`${b.column}\` is blank (${b.blankKind}) on all ${cp.totalRows} returned rows${capNote}.`,
                    `\`${b.probeName}\` present on ${b.present} of ${cp.sampled ?? 0} sampled source events.`,
                    columnSampleNote(cp.sampled, scope) + cachedCaveat,
                ],
            };
        }
        // Raw panel, field present on the sample but blank in this panel's own
        // rows: the panel's pipeline/filters drop it — routinely legitimate.
        // Accounted-for; surfaces as evidence on the floor.
    }

    // §18.8a-17 — the floor is unreachable while ANY column went unexamined.
    const unprobed = cp.blanks.filter((b) => b.present === null).map((b) => b.column);
    const unaccounted = cp.dropped.map((d) => d.column).concat(unprobed);
    if (unaccounted.length > 0) {
        return notEvaluated(
            'column-tier-incomplete',
            `Whether ${unaccounted.map((c) => `\`${c}\``).join(', ')} should have data could not be checked.`,
            cp.dropped.length > 0
                ? cp.dropped.map((d) => `${d.column}: ${d.reason}`).join('; ')
                : 'The corroboration sample did not complete.',
        );
    }

    // The honest floor (§18.3(4)) — every displayed column accounted for.
    const evidence: string[] = [
        `${cp.populated.length} displayed column(s) populated over ${cp.totalRows} returned row(s)${capNote}.`,
    ];
    cp.blanks.forEach((b) => {
        evidence.push(
            `\`${b.column}\` is blank in this panel's rows, but \`${b.probeName}\` extracts fine on ${scope} (${b.present} of ${cp.sampled ?? 0} sampled) — the panel's own pipeline or filters account for it.`,
        );
    });
    cp.derivedOrComputed.forEach((d) => {
        evidence.push(`\`${d.column}\`: ${d.why} — not probeable against raw events.`);
    });
    activeFilterContextLines(facts).forEach((l) => evidence.push(l));
    return {
        id: 'panel-data-present',
        short: 'No defect found',
        headline: 'This panel has data, and the columns it displays are populated — no defect found.',
        detail: 'Every displayed column was either populated or explained; nothing points at a fault.',
        confidence: 'expected',
        owner: 'nobody',
        evidence,
    };
};

/** §18.8a-9 — the zero-resolution pair for a zeroValued (effective-empty)
 *  cached request. */
const panelZeroConfirmed = (via: 'rows' | 'twin', twin?: { field: string; value: number }): Verdict => ({
    id: 'panel-zero-confirmed',
    short: 'Genuinely zero',
    headline:
        via === 'rows'
            ? 'The summarised data covers this range, and the value genuinely is zero.'
            : 'The raw equivalent of this panel’s query also computes zero — the value genuinely is zero.',
    detail: 'Nothing is missing; there were no qualifying events in this period.',
    confidence: 'expected',
    owner: 'nobody',
    evidence:
        via === 'rows'
            ? ['The summary holds rows for this window; they sum to zero.']
            : [`Raw equivalent computes ${twin?.field ?? 'the value'} = ${twin?.value ?? 0} over the summarised period.`],
});

const zeroValueMismatch = (twin: { field: string; value: number }): Verdict => ({
    id: 'zero-value-mismatch',
    short: 'Raw disagrees with zero',
    headline: `The raw equivalent of this panel’s query computes ${twin.field} = ${twin.value.toLocaleString()} over the summarised period, while the panel shows zero.`,
    detail:
        'The summary may be missing data it should have. Re-running the backfill from Settings -> Dashboard Data is safe and settles it. ' +
        '(The two computations are independent implementations and can differ legitimately at rounding boundaries, so this is a lead, not a confirmation.)',
    confidence: 'possible',
    owner: 'splunk-admin',
    evidence: [
        `Raw-equivalent ${twin.field}: ${twin.value.toLocaleString()}`,
        'Panel value: 0',
    ],
});

/** One index name for wording that scopes a claim to what was actually
 *  probed (§14.8a): `| metadata` reads exactly one index, so "never arrived"
 *  may only ever be said about THAT index — never "this Splunk instance"
 *  (the wrong-index/HEC-default-index state makes the wider claim false;
 *  sessions 049/069). */
const singleIndex = (ev: PanelEvidence): string =>
    ev.resolvedIndexes && ev.resolvedIndexes.length === 1
        ? ev.resolvedIndexes[0]
        : ev.macroIndexes && ev.macroIndexes.length === 1
          ? ev.macroIndexes[0]
          : '';

/** §14.8a-1.3 — the partial-routing-break hedge: when a confirmed
 *  never-seen/never-arrived claim is made while unparsed fallback events sit
 *  in the same window, say so — a log type whose format changed may be among
 *  them, and the confirmed claim must not paper over that possibility. */
const fallbackCaveat = (ev: PanelEvidence): string =>
    typeof ev.fallbackRowsInWindow === 'number' && ev.fallbackRowsInWindow > 0
        ? ` Note: ${ev.fallbackRowsInWindow.toLocaleString()} event(s) in this window carry the unparsed fallback sourcetype; if this log type recently changed format, its events may be among them.`
        : '';

/**
 * §14.2 — the routing near-miss (design check 11), shared by the raw and
 * cached gates so both produce identical wording.
 *
 * Fires ONLY when the evidence PROVES no routed kind has in-window events
 * (`routedRowsInWindow === 0` — the primary discriminator) while a
 * substantial unparsed fallback population exists. Any routed event
 * suppresses it entirely: transforms route every kind on the same tier, so
 * routing being applied for ONE kind is routing being applied. Confidence is
 * capped at `likely` — an estate that ships ONLY unroutable kinds trips the
 * numbers legitimately, and the detail's last sentence owns that.
 */
const routingNearMiss = (
    names: string,
    ev: PanelEvidence,
    history: 'never' | 'stopped' | 'unknown',
    stoppedSince: number | null,
): Verdict | null => {
    // typeof checks, not `=== null`: evidence objects from older callers or
    // test fixtures may carry `undefined` here, and undefined must read as
    // unknown exactly like null (SS12.3).
    if (typeof ev.fallbackRowsInWindow !== 'number' || typeof ev.routedRowsInWindow !== 'number') {
        return null;
    }
    if (ev.routedRowsInWindow !== 0) return null;
    const fb = ev.fallbackRowsInWindow;
    if (fb < ROUTING_FALLBACK_MIN_EVENTS) return null;
    // Secondary sanity guard: against the whole-index count when known (the
    // two probes cover the same universe; a large disagreement means the
    // evidence is unstable and the verdict must not fire on it).
    const denom =
        ev.indexRowsInWindow !== null && ev.indexRowsInWindow > 0
            ? ev.indexRowsInWindow
            : fb + ev.routedRowsInWindow;
    if (denom <= 0 || fb / denom < ROUTING_FALLBACK_MIN_SHARE) return null;

    const historyDetail =
        history === 'never'
            ? 'The Data TA’s routing appears never to have been applied on this instance’s indexing path. '
            : history === 'stopped'
              ? `The Data TA’s routing appears to have stopped being applied${stoppedSince !== null ? ` around ${fmtDate(stoppedSince)}` : ''} — events continue to arrive, but none are parsed. `
              : '';
    const historyEvidence =
        history === 'never'
            ? `Searching all time found none of ${names} ever parsed.`
            : history === 'stopped' && stoppedSince !== null
              ? `The most recent parsed ${names} event is from ${fmtDate(stoppedSince)}.`
              : 'Whether these log types were ever parsed before could not be established.';
    return {
        id: 'routing-not-applied',
        short: 'Data not parsed',
        headline:
            'Events are arriving, but none are being parsed into the log types this solution routes.',
        detail:
            historyDetail +
            'A Splunk administrator checks that the Splunk TA for SAP LogServ is installed on the ' +
            'forwarder/indexer tier (and pushed to the heavy forwarders). If only unrecognised log ' +
            'kinds are being sent, the Environment report’s sourcetype table shows what is arriving.',
        confidence: 'likely',
        owner: 'splunk-admin',
        evidence: [
            `Events in this window still carrying the unparsed input sourcetype (\`${FALLBACK_SOURCETYPE}\`): ${fb.toLocaleString()}`,
            'Events parsed into ANY routed log type in this window: 0',
            historyEvidence,
        ],
    };
};

/** §14.5 — the KV Store is not up; summarised-data conclusions must wait. */
const kvstoreNotReady = (status: string): Verdict => ({
    id: 'kvstore-not-ready',
    short: 'KV Store not ready',
    headline: `Splunk’s KV Store is not ready (status: ${status}), so this view’s summarised data cannot be read right now.`,
    detail:
        status === 'starting'
            ? 'This is normal for a few minutes after a Splunk restart and clears itself. Try again shortly.'
            : 'This state does not clear itself — a Splunk administrator checks the KV Store on the search head.',
    confidence: 'likely',
    owner: 'splunk-admin',
    evidence: [`server/info kvStoreStatus: ${status}`],
});

/** §14.8a-1 / §14.2 shared: the traced-scope history classification for the
 *  cached gates. `never` only on a KNOWN empty last-seen record; a null
 *  record (probe failed / not run) is `unknown`, never a claim. */
const cachedHistory = (
    ev: PanelEvidence,
): { history: 'never' | 'stopped' | 'unknown'; newest: number | null } => {
    if (ev.sourceScope === null || ev.sourceScope.sourcetypes.length === 0) {
        return { history: 'unknown', newest: null };
    }
    if (ev.sourcetypeLastSeen === null) return { history: 'unknown', newest: null };
    const seen = ev.sourceScope.sourcetypes.filter((s) =>
        Object.prototype.hasOwnProperty.call(ev.sourcetypeLastSeen as Record<string, number>, s),
    );
    if (seen.length === 0) return { history: 'never', newest: null };
    const newest = seen.reduce(
        (a, s) => Math.max(a, (ev.sourcetypeLastSeen as Record<string, number>)[s]),
        0,
    );
    return { history: 'stopped', newest };
};

/* -------------------------------------------------------------------------
 * §15 — operator-supplied ingest evidence (checks 28/29, design §15 + §15.8a).
 *
 * Both gates read `ev.ingestFacts` — a tri-state field populated from a
 * WORLD-WRITABLE collection (sanitized + domain-clamped on read). Every
 * verdict they produce carries the provenance line and is capped by
 * `suppliedConfidenceCap` (§15.8a-8): stale or approximate facts can never
 * yield a confirmed claim, and a partial parse caps at possible.
 * ---------------------------------------------------------------------- */

/** undefined-safe facts accessor: older fixtures/callers carry undefined,
 *  and undefined must read as unknown exactly like null (§12.3). */
const ingestFactsOf = (ev: PanelEvidence): IngestFacts | null => {
    const f = (ev as { ingestFacts?: IngestFacts | null }).ingestFacts;
    if (!f || typeof f !== 'object') return null;
    return f;
};

/**
 * CHECK 28 — `ingest-window-before-cutoff` (§15.3). Explains an OBSERVED
 * empty index window (indexRowsInWindow === 0, visibility clear) whose end
 * lies before the supplied days-in-past cutoff: events that old are dropped
 * at ingest BY DESIGN. When it fires, `index-empty-in-window` AND the whole
 * cached gate stand down (§15.8a-9) — "extend the history" / "run the
 * backfill" are impossible prescriptions for a window the ingest tier
 * discards.
 */
const gateIngestCutoff = (ev: PanelEvidence, facts: PanelFacts): Verdict | null => {
    if (ev.indexRowsInWindow !== 0) return null;
    const fx = ingestFactsOf(ev);
    if (!fx) return null;
    const nowSec = Math.floor(Date.now() / 1000);
    const winEnd = approxEpoch(facts.latest, nowSec);
    /* §19.8a-4 — the facts+window half lives in the shared
     * `ingestCutoffApplicable` (unparsed/disabled/no-cutoff/unparseable-
     * bound/straddle all decline there, plus the H10 daysInPast-consistency
     * belt for the world-writable row); the observed-zero condition above
     * stays explicit here (H18). */
    if (!ingestCutoffApplicable(fx, winEnd, nowSec)) return null;
    const cutoffEpoch = fx.cutoffEpoch as number;
    const margin = cutoffEpoch - (winEnd as number);
    const cap = suppliedConfidenceCap(fx, nowSec);
    const grade: SuppliedConfidence =
        margin >= INGEST_CUTOFF_MIN_MARGIN_SECONDS
            ? minConfidence(cap, 'confirmed')
            : minConfidence(cap, 'likely');
    const stale = staleCaveatLine(fx, nowSec);
    /* §19.2/§19.8a-3 — the pre-cutoff corroboration, EVIDENCE LINES ONLY
     * (confidence unchanged in both directions). `preCutoffOldest` rides the
     * `| metadata` probe when it ran (cached panels — zero extra dispatch);
     * tri-state, so a raw panel or a failed probe simply carries no line.
     * The zero case uses the H3 non-discriminator wording: filter, young
     * index and retention are indistinguishable here. */
    const preOldest = (ev as { preCutoffOldest?: number | null }).preCutoffOldest;
    const preCutoffLines: string[] =
        typeof preOldest === 'number'
            ? [
                  preOldest >= cutoffEpoch
                      ? `No events older than the cutoff exist in this index (oldest event: ${fmtDate(preOldest)}). ` +
                        'An always-active ingest filter, an index younger than the cutoff, and ordinary index ' +
                        'retention all look identical here — this does not discriminate.'
                      : `Events older than the cutoff do exist (oldest: ${fmtDate(preOldest)}) — indexed while they ` +
                        'were within the then-current cutoff, or before the filter was enabled; the absence for ' +
                        'your window is still consistent with the current cutoff.',
              ]
            : [];
    return {
        id: 'ingest-window-before-cutoff',
        short: 'Dropped by design',
        headline:
            `Events this old are discarded at ingest by design — your selected range ends before ` +
            `the configured cutoff (${fmtDate(cutoffEpoch)}), so nothing can be indexed for it.`,
        detail:
            `The Data TA’s days-in-past filter${fx.daysInPast !== null ? ` (currently ${fx.daysInPast} days)` : ''} drops events older than ` +
            `${fmtDate(cutoffEpoch)} before they are indexed. Pick a more recent range, or have a Splunk ` +
            'administrator raise the setting in the Data TA’s Configuration -> Filters. Note that the ' +
            'index’s own retention may also limit how far back data exists — raising the ingest setting ' +
            'cannot restore events retention has already removed. Based on the filter configuration ' +
            `recorded as supplied by ${fx.suppliedBy || 'an unknown user'}.`,
        confidence: grade,
        owner: 'user',
        evidence: [
            'Events in this window, all sourcetypes: 0',
            `Configured ingest cutoff: ${fmtDate(cutoffEpoch)}${fx.inputShape === 'transforms-conf' ? ' (recovered from the generated filter expression)' : ''}`,
            provenanceLine(fx),
        ]
            .concat(preCutoffLines)
            .concat(stale ? [stale] : []),
    };
};

/** One evaluation unit for check 29: a display name + the clz paths behind
 *  it + the sourcetypes whose in-window counts prove/disprove absence. */
interface ExclusionUnit {
    name: string;
    paths: string[];
    countTypes: string[];
}

const typesForPaths = (paths: string[]): string[] => {
    const out: string[] = [];
    for (const st of Object.keys(SOURCETYPE_CLZ_MAP)) {
        const stPaths = SOURCETYPE_CLZ_MAP[st];
        if (stPaths.some((p) => paths.indexOf(p) !== -1) && out.indexOf(st) === -1) out.push(st);
    }
    return out;
};

/**
 * CHECK 29 — `ingest-type-excluded` (§15.4 + §15.8a-1/2/4/5/6). Shared by the
 * raw and cached tiers so both produce identical wording. Returns the
 * verdict, or a CONTRADICTION reason (the supplied config is disproven by
 * observed events — §15.8a-1's second trigger + the stale-paste guard), or
 * nothing.
 *
 * FIRES ONLY when (all undefined-safe):
 *  - facts present, parse not 'unparsed', filtering enabled;
 *  - at least one required type/tag resolves in the clz maps;
 *  - `ev.sourcetypeCounts` is NON-NULL and every mapped type has ZERO
 *    in-window count (review blocker B1 — a present type contradicts);
 *  - the supplied filters actually DROP something for this panel.
 * CONFIRMED additionally requires (§15.8a-2/4): every unit fully dropped, no
 * unmapped required type, the contradiction guard EVALUABLE
 * (`sourcetypeLastSeen !== null`) and negative, the proof-of-life question
 * answerable (`guardEvaluable`), and the supplied-confidence cap at
 * confirmed. Anything less is `possible` (or `likely` via the cap).
 */
const ingestExclusion = (
    requiredTypes: string[],
    tags: string[],
    ev: PanelEvidence,
    guardEvaluable: boolean,
): { verdict: Verdict | null; contradiction: string | null } => {
    const none = { verdict: null, contradiction: null };
    const fx = ingestFactsOf(ev);
    if (!fx) return none;
    if (fx.parseStatus === 'unparsed') return none;
    if (fx.filterEnabled !== true) return none;

    const units: ExclusionUnit[] = [];
    const unmapped: string[] = [];
    for (const st of requiredTypes) {
        const paths = SOURCETYPE_CLZ_MAP[st];
        if (paths && paths.length > 0) units.push({ name: st, paths, countTypes: [st] });
        else unmapped.push(st);
    }
    for (const tag of tags) {
        const paths = TAG_CLZ_MAP[tag];
        if (paths && paths.length > 0) {
            units.push({ name: `tag=${tag}`, paths, countTypes: typesForPaths(paths) });
        }
    }
    if (units.length === 0) return none;

    // B1: observed in-window absence is a PRECONDITION on both tiers. A
    // present type the config claims FULLY dropped is the second
    // contradiction trigger; a present type the config KEEPS simply stands
    // this gate down (its story belongs to the other gates, e.g. rollup-gap).
    if (ev.sourcetypeCounts === null) return none;
    const counts = ev.sourcetypeCounts as Record<string, number>;
    let anyPresent = false;
    for (const u of units) {
        const present = u.countTypes.filter((st) => counts[st] > 0);
        if (present.length === 0) continue;
        anyPresent = true;
        if (pathsDropStatus(u.paths, fx) === 'dropped') {
            return {
                verdict: null,
                contradiction:
                    `The supplied filter configuration would drop ${present.map((s) => '\`' + s + '\`').join(', ')}, ` +
                    'but events of that kind exist in this window — the configuration may be from the wrong ' +
                    'instance, or may have changed since it was supplied; re-supply it.',
            };
        }
    }
    if (anyPresent) return none;

    const statuses = units.map((u) => ({ u, status: pathsDropStatus(u.paths, fx) }));
    const droppedUnits = statuses.filter((s) => s.status === 'dropped');
    const partialUnits = statuses.filter((s) => s.status === 'partial');
    if (droppedUnits.length === 0 && partialUnits.length === 0) return none; // filters keep everything here

    // Stale-paste contradiction guard (§15.4): events of a "dropped" type
    // arriving AFTER the paste disprove the supplied config. Comparator is
    // event-time lastSeen; it keeps its FULL stand-down.
    const ls = ev.sourcetypeLastSeen;
    if (ls !== null && typeof ls === 'object') {
        for (const s of droppedUnits.concat(partialUnits)) {
            for (const st of s.u.countTypes) {
                const seen = (ls as Record<string, number>)[st];
                if (typeof seen === 'number' && seen > fx.suppliedAt) {
                    return {
                        verdict: null,
                        contradiction:
                            `The supplied filter configuration says \`${st}\` is dropped at ingest, but newer ` +
                            `events (by event timestamp) arrived after it was supplied — the configuration may ` +
                            'have changed since; re-supply it.',
                    };
                }
            }
        }
    }

    /* §19.1/§19.8a-12 — the INDEX-TIME comparator closes the replay/backdate
     * evasion (old event timestamps, new index times — L1-10): `| metadata`
     * recentTime moving past `suppliedAt` means events of a "dropped" kind
     * were RECORDED AS INDEXED after the configuration was supplied. Unlike
     * the event-time guard this NEVER stands the gate down — recentTime can
     * move without new events of that kind arriving (bucket-summary
     * coarseness), so it caps the verdict at `possible` and appends the
     * recorded-not-observed line. The skew grace covers browser-vs-indexer
     * clocks plus an in-flight DS-push write. Undefined-safe: older
     * fixtures/callers carry no field at all. */
    const rs = (ev as { sourcetypeRecentSeen?: Record<string, number> | null }).sourcetypeRecentSeen;
    let recentContradictionLine: string | null = null;
    if (rs && typeof rs === 'object') {
        for (const s of droppedUnits.concat(partialUnits)) {
            for (const st of s.u.countTypes) {
                const rseen = (rs as Record<string, number>)[st];
                if (
                    recentContradictionLine === null &&
                    typeof rseen === 'number' &&
                    rseen > fx.suppliedAt + INGEST_RECENT_SKEW_SECONDS
                ) {
                    recentContradictionLine =
                        `\`${st}\` events of that kind were recorded as indexed after the configuration was ` +
                        'supplied (index time, from bucket metadata) — if the configuration changed since, ' +
                        're-supply it.';
                }
            }
        }
    }

    const nowSec = Math.floor(Date.now() / 1000);
    const cap = suppliedConfidenceCap(fx, nowSec);
    const guardOk = ls !== null && guardEvaluable;
    const fullDrop =
        droppedUnits.length === statuses.length && unmapped.length === 0 && partialUnits.length === 0;
    const grade: SuppliedConfidence =
        recentContradictionLine !== null
            ? 'possible'
            : fullDrop && guardOk
              ? minConfidence(cap, 'confirmed')
              : 'possible';

    const stale = staleCaveatLine(fx, nowSec);
    const approxLabel = fx.filtersApproximate
        ? ' (reconstructed from the generated filter — approximate)'
        : '';
    const droppedPathsAll: string[] = [];
    for (const s of droppedUnits.concat(partialUnits)) {
        for (const path of s.u.paths) {
            if (droppedPathsAll.indexOf(path) === -1 && !clzSurvivesForVerdict(path, fx)) {
                droppedPathsAll.push(path);
            }
        }
    }
    const names = statuses.map((s) => '`' + s.u.name + '`').join(', ');
    const evidence = [
        `Dropped at ingest by the supplied filters: ${droppedPathsAll.join(', ') || '(none fully)'}${approxLabel}`,
        `Events of the affected kind(s) in this window: 0`,
        provenanceLine(fx),
    ]
        .concat(guardOk ? [] : ['Arrival history for the affected kind(s) could not be established.'])
        .concat(recentContradictionLine !== null ? [recentContradictionLine] : [])
        .concat(stale ? [stale] : []);

    if (fullDrop) {
        return {
            verdict: {
                id: 'ingest-type-excluded',
                short: 'Excluded at ingest',
                headline: `${names} events are ${namedRuleFor(droppedUnits[0].u.paths, fx)}${approxLabel} — they are dropped before they reach the index.`,
                detail:
                    'If this exclusion is intentional, nothing is broken; otherwise a Splunk administrator ' +
                    'changes the include/exclude rules in the Data TA’s Configuration -> Filters — on the ' +
                    'deployment server for a distributed install. Based on the filter configuration ' +
                    `recorded as supplied by ${fx.suppliedBy || 'an unknown user'}.`,
                confidence: grade,
                owner: 'splunk-admin',
                evidence,
            },
            contradiction: null,
        };
    }
    return {
        verdict: {
            id: 'ingest-type-excluded',
            short: 'Partly excluded?',
            headline:
                `Some of the sources that feed this view are excluded at ingest by the supplied filter ` +
                `configuration: ${droppedPathsAll.join(', ')}${approxLabel}.`,
            detail:
                'The other sources may simply have no events in this range. If the exclusion is intentional, ' +
                'nothing is broken; otherwise a Splunk administrator changes the include/exclude rules in the ' +
                'Data TA’s Configuration -> Filters. Based on the filter configuration recorded as supplied ' +
                `by ${fx.suppliedBy || 'an unknown user'}.`,
            confidence: 'possible',
            owner: 'splunk-admin',
            evidence,
        },
        contradiction: null,
    };
};

/** Wrapper so the evidence-line builder above can reuse the module's
 *  survive logic without importing it twice. */
const clzSurvivesForVerdict = (path: string, fx: IngestFacts): boolean =>
    pathsDropStatus([path], fx) === 'kept';

/** The §15.8a-1 contradiction surfaces as a not-evaluated entry in `all` —
 *  visible in the drawer, never `top`. */
const contradictionEntry = (reason: string): Verdict => ({
    id: 'ingest-facts-contradicted',
    short: 'Config contradicted',
    headline: 'The operator-supplied filter configuration is contradicted by observed events.',
    confidence: 'not-evaluated',
    owner: 'nobody',
    evidence: [reason],
});

/**
 * §19.3/§19.8a-14..16 — the sourcetype-level cutoff CONTEXT lines. The
 * non-empty sibling of check 28: the INDEX has events in the window but THIS
 * panel's type has none, and the window ends before the supplied cutoff. The
 * sliding-cutoff arithmetic makes any verdict-grade claim dishonest here, so
 * this is context only — appended to whichever of the RAW-tier zero-in-window
 * verdicts fires (never-seen / outside-window / stale; the cached-tier
 * extension is recorded future work, and `sourcetype-future-timestamps` is
 * EXCLUDED by design — a clock-skew verdict must not be diluted by a cutoff
 * aside). The `indexRowsInWindow > 0` conjunct is the section's own premise,
 * explicit and gate-pinned BOTH directions: with an empty index this is check
 * 28's territory and the cutoff must never be narrated twice.
 */
const cutoffContextLines = (
    ev: PanelEvidence,
    winEnd: number | null,
    nowSec: number,
): string[] => {
    const fx = ingestFactsOf(ev);
    if (!fx) return [];
    if (!(typeof ev.indexRowsInWindow === 'number' && ev.indexRowsInWindow > 0)) return [];
    if (!ingestCutoffApplicable(fx, winEnd, nowSec)) return [];
    const lines = [
        `Your range also ends before the ingest cutoff recorded as supplied by ` +
            `${fx.suppliedBy || 'an unknown user'} (${fmtDate(fx.cutoffEpoch as number)}) — events of ` +
            'this age arriving now would be dropped at ingest; the cutoff slides forward daily.',
    ];
    const stale = staleCaveatLine(fx, nowSec);
    if (stale) lines.push(stale);
    return lines;
};

/* -------------------------------------------------------------------------
 * GATE V — can this user see the data at all?
 *
 * An index the role cannot search returns zero rows and NO error, so it is
 * indistinguishable from an empty window on the count alone. It is only worth
 * asking when the count IS zero, which is why `diagEvidence` probes visibility
 * conditionally.
 * ---------------------------------------------------------------------- */
const gateVisibility = (ev: PanelEvidence): Verdict | null => {
    if (ev.indexRowsInWindow === null) return null; // handled by gateIndex
    if (ev.indexRowsInWindow > 0) return null; // it returned events; it is visible
    if (ev.visibleIndexes === null) return null;
    /* The comparison needs the index names the view READS. The windowed tstats
     * (`resolvedIndexes`) is useless here — it resolves to an EMPTY list
     * whenever the window has zero events, which is precisely the state this
     * gate is evaluated in, so relying on it made the gate structurally dead
     * code and the authorization case fell through to a false "no events of
     * any kind" (session 095, finding 1). The macro DEFINITION is
     * window-independent; `resolvedIndexes` is kept only as a fallback for the
     * impossible-today case where it is non-empty while the count is zero. */
    const named =
        ev.macroIndexes && ev.macroIndexes.length > 0 ? ev.macroIndexes : ev.resolvedIndexes;
    if (named === null || named.length === 0) return null;
    const unseen = named.filter((i) => ev.visibleIndexes!.indexOf(i) === -1);
    if (unseen.length === 0) return null;
    return {
        id: 'index-not-visible',
        short: 'No access to index',
        headline: `Your account cannot search the index this view reads (${unseen.join(', ')}).`,
        /* §14.8a-3 — the evidence cannot separate the causes, so the detail
         * names them ALL (the headline asserts only the shared observable,
         * which is true under every one). Verified empirically 2026-08-09:
         * `| eventcount summarize=false index=*` DOES list an existing index
         * with zero events, so the clean-room empty-index install does NOT
         * trip this gate — but a nonexistent, macro-misnamed or disabled
         * index does, and each has a different fix. */
        detail:
            'Splunk returns no rows and no error in this situation, so the view looks empty rather than forbidden. ' +
            'Causes this evidence cannot separate: the index is not in your role’s srchIndexesAllowed; ' +
            'the index has never been created — the Splunk TA for SAP LogServ, which defines it, is not installed ' +
            '(on the indexer tier, or on this instance for a single-instance install); ' +
            'the app’s index macro has been overridden to name an index that does not exist; ' +
            'or the index is disabled. A Splunk administrator resolves which.',
        confidence: 'confirmed',
        owner: 'splunk-admin',
        evidence: [
            `The view reads: ${named.join(', ')}`,
            `Your account can search: ${ev.visibleIndexes.join(', ') || '(none)'}`,
        ],
    };
};

/* -------------------------------------------------------------------------
 * GATE I — is there anything in the index at all for this window?
 *
 * This supersedes everything below it: if the whole index is empty for the
 * window, no statement about one sourcetype or one rollup adds anything.
 * ---------------------------------------------------------------------- */
const gateIndexEmpty = (ev: PanelEvidence): Verdict | null => {
    if (ev.indexRowsInWindow === null) {
        return notEvaluated(
            'index-presence',
            'Whether any data exists for this time range was not checked.',
            ev.budgetExhausted
                ? 'The diagnostic ran out of time before this check.'
                : 'The counting search did not complete.',
        );
    }
    if (ev.indexRowsInWindow > 0) return null;
    return {
        id: 'index-empty-in-window',
        short: 'No data in range',
        headline: 'There are no events of any kind in the time range you selected.',
        detail:
            'This is not specific to this view — nothing was indexed for this period. ' +
            'Either the range predates your data, or collection stopped. Widening the range is the quickest check.',
        confidence: 'confirmed',
        owner: 'user',
        evidence: [
            `Index searched: ${(ev.resolvedIndexes || []).join(', ') || 'resolved by macro'}`,
            'Events in this window, all sourcetypes: 0',
        ],
    };
};

/* -------------------------------------------------------------------------
 * GATE S — the sourcetype question, and GATE 0 inside it.
 *
 * TWO CORRECTIONS FROM THE REVIEW LIVE HERE.
 *
 * §12.2 — this gate is unevaluable for far more panels than the cached tier.
 * `probe.sourcetypes` is empty for whole-index tstats panels
 * (`| tstats count WHERE <macro>` — Data Pipeline Overview's totals) and for
 * tag-scoped panels (DNS Analytics scopes by `tag=dns`, never by sourcetype).
 * Reading an empty list as "not present" would certify health with no evidence.
 *
 * §12.1 — a cached read carries no sourcetype AT ALL, and the rollup-rows probe
 * must never be substituted for one: zero rollup rows is identical for "no such
 * events occurred" and "the rollup was never backfilled", so feeding it here
 * would declare a fresh install healthy on the single most important failure
 * this tool exists to catch. Cached panels fall through to gateCached.
 * ---------------------------------------------------------------------- */
const gateSourcetype = (
    probe: SplProbe,
    ev: PanelEvidence,
    facts: PanelFacts,
    extras: Verdict[],
): Verdict | null => {
    if (probe.tier === 'cached') return null;
    const nowSecG = Math.floor(Date.now() / 1000);
    const winEndG = approxEpoch(facts.latest, nowSecG);
    if (probe.sourcetypes.length === 0) {
        if (probe.tags.length > 0) {
            /* §15.8a-5 — tag-scoped panels reach check 29 through TAG_CLZ_MAP
             * (an `exclude = dns/binddns` blanks three dashboards and must be
             * nameable). The placeholder below remains the fallback. */
            const exT = ingestExclusion([], probe.tags, ev, winEndG !== null);
            if (exT.contradiction) extras.push(contradictionEntry(exT.contradiction));
            else if (exT.verdict) return exT.verdict;
            return notEvaluated(
                'sourcetype-presence',
                'This view is selected by tag rather than by sourcetype, so a missing sourcetype cannot explain it.',
                `Scoped by ${probe.tags.map((t) => `tag=${t}`).join(', ')}.`,
            );
        }
        return notEvaluated(
            'sourcetype-presence',
            'This view is not limited to one kind of event, so the absence of one cannot explain it.',
            'The query carries no sourcetype and no tag constraint.',
        );
    }
    if (ev.sourcetypeCounts === null) {
        return notEvaluated(
            'sourcetype-presence',
            'Whether this kind of event exists in the range was not checked.',
            ev.budgetExhausted
                ? 'The diagnostic ran out of time before this check.'
                : 'The counting search did not complete.',
        );
    }

    // `| tstats … BY sourcetype` emits NO ROW for a sourcetype with no events —
    // not a row carrying 0 — so "missing from the record" IS the zero (§12.3).
    const present = probe.sourcetypes.filter(
        (s) => (ev.sourcetypeCounts as Record<string, number>)[s] > 0,
    );
    if (present.length > 0) {
        // §15.8a-1's second trigger, raw tier: events of this type exist, so
        // if the supplied config claims it is dropped at ingest, the config
        // is contradicted — surface that (never a verdict) and stand aside.
        const exP = ingestExclusion(probe.sourcetypes, [], ev, false);
        if (exP.contradiction) extras.push(contradictionEntry(exP.contradiction));
        return null; // the events are there; something else is wrong
    }

    const names = probe.sourcetypes.map((s) => `\`${s}\``).join(', ');

    // Before concluding "nothing is wrong", find out whether it ever arrived.
    // A sourcetype that stopped three days ago is an ingest gap, not health.
    if (ev.sourcetypeLastSeen !== null) {
        const seen = probe.sourcetypes.filter((s) =>
            Object.prototype.hasOwnProperty.call(ev.sourcetypeLastSeen as Record<string, number>, s),
        );
        const newest = seen.reduce(
            (a, s) => Math.max(a, (ev.sourcetypeLastSeen as Record<string, number>)[s]),
            0,
        );
        const nowSec = Math.floor(Date.now() / 1000);
        const winEnd = approxEpoch(facts.latest, nowSec);

        /* ORDER IS LOAD-BEARING (§14.8a-2.1, the review's blocker): the
         * outside-window comparison runs BEFORE the routing question, because
         * a newest-after-window last-seen PROVES routing currently applies —
         * the newer parsed events can only exist because routing wrote them —
         * and a "stopped being applied since <date>" claim would name a date
         * AFTER the window end. */
        if (seen.length > 0 && winEnd !== null && newest > winEnd) {
            /* §14.5 — the future-dated variant: a "most recent" event ahead
             * of the clock is a clock/timezone question, not reassurance. */
            if (newest > nowSec + FUTURE_TS_GUARD_SECONDS) {
                return {
                    id: 'sourcetype-future-timestamps',
                    short: 'Future timestamps',
                    headline: `The most recent ${names} event carries a timestamp in the future (${fmtDate(newest)}).`,
                    detail:
                        'Events dated ahead of the clock usually mean a timezone or clock misconfiguration at the ' +
                        'source or forwarder — or a clock difference on the machine viewing this page. ' +
                        '“Last X” time ranges can look empty while events sit ahead of them.',
                    confidence: 'possible',
                    owner: 'ingest',
                    evidence: [
                        'Events in the selected range: 0',
                        `Most recent event, searching all time: ${fmtDate(newest)} — ahead of the current clock`,
                    ],
                };
            }
            return {
                id: 'sourcetype-outside-window',
                short: 'Newer data exists',
                headline: `There are no ${names} events inside the range you selected — the most recent one is from ${fmtDate(newest)}, after this range.`,
                detail:
                    'Data for this log type is still arriving; the selected period just has none. Nothing is stopped.',
                confidence: 'expected',
                owner: 'nobody',
                evidence: [
                    'Events in the selected range: 0',
                    `Most recent event, searching all time: ${fmtDate(newest)} (after the selected range)`,
                ].concat(cutoffContextLines(ev, winEnd, nowSec)),
            };
        }

        /* §15.4 — check 29 BEFORE the routing question and the confirmed
         * owner-ingest verdicts: an excluded type never reaches routing (the
         * filter chain nullQueues it first), and the feed owner cannot fix
         * the Data TA's exclude rule. Outside-window/future above already
         * proved arrivals when they fired (§14.8a-2.1 preserved). */
        const exS = ingestExclusion(probe.sourcetypes, [], ev, winEnd !== null);
        if (exS.contradiction) extras.push(contradictionEntry(exS.contradiction));
        else if (exS.verdict) return exS.verdict;

        /* §14.2 — the routing question, AFTER outside-window has had its say:
         * events arriving unparsed beat both "never arrived" (misdirects to
         * the feed owner) and the graded quiet-stretch verdicts. */
        const routing = routingNearMiss(
            names,
            ev,
            seen.length === 0 ? 'never' : 'stopped',
            seen.length > 0 ? newest : null,
        );
        if (routing) return routing;

        if (seen.length === 0) {
            const idx = singleIndex(ev);
            return {
                id: 'sourcetype-never-seen',
                short: 'Never received',
                /* §14.8a-1.2 — scoped to what `| metadata` actually read: ONE
                 * index. "This Splunk instance" would be false in the
                 * wrong-index/HEC-default state (sessions 049/069). */
                headline: `No ${names} events have ever arrived in the index this app reads${idx ? ` (\`${idx}\`)` : ''}.`,
                detail:
                    'The view is working; the data it needs has never arrived. This is a collection question for ' +
                    'whoever owns the feed. If the feed is believed active, a Splunk administrator should check ' +
                    'whether its events are being written to a different index.' +
                    fallbackCaveat(ev),
                confidence: 'confirmed',
                owner: 'ingest',
                evidence: [
                    `Searched all time${idx ? ` in \`${idx}\`` : ''} for ${names}: nothing found.`,
                ].concat(cutoffContextLines(ev, winEnd, nowSec)),
            };
        }

        /* newest BEFORE the window -> silence since then. Whether that is an
         * ingest stop or natural sparseness is not decidable from here, so
         * the verdict is graded by the LENGTH of the silence and never
         * "confirmed" (session 095, finding 5). */
        const silenceDays = agoDays(newest);
        return {
            id: 'sourcetype-stale',
            short: silenceDays >= 7 ? 'May have stopped' : 'None in this range',
            headline: `The most recent ${names} event is from ${fmtDate(newest)} — ${fmtAgo(newest)}.`,
            detail:
                'There are none inside the range you selected. If data was expected since then, collection for this ' +
                'log type may have stopped; if this log type is naturally infrequent, a quiet stretch can be normal.',
            confidence: silenceDays >= 7 ? 'likely' : 'possible',
            owner: 'ingest',
            evidence: [
                `Events in the selected range: 0`,
                `Most recent event, searching all time: ${fmtDate(newest)}`,
            ].concat(cutoffContextLines(ev, winEnd, nowSec)),
        };
    }

    /* No last-seen evidence — the exclusion and routing questions may still
     * be answerable, with the history left explicitly unestablished
     * (§14.8a-2.3). The exclusion's contradiction guard is UNEVALUABLE here,
     * so its grade is capped at possible inside the helper (§15.8a-2). */
    const exU = ingestExclusion(probe.sourcetypes, [], ev, false);
    if (exU.contradiction) extras.push(contradictionEntry(exU.contradiction));
    else if (exU.verdict) return exU.verdict;

    const routingU = routingNearMiss(names, ev, 'unknown', null);
    if (routingU) return routingU;

    // No last-seen evidence: fall back to Gate 0's honest, narrower claim.
    // `evaluateGate0` never returns null, so it is called only here — at the
    // point where its premise is established. The index half of that premise
    // is passed AS OBSERVED, not hardcoded: when the index probe failed, Gate
    // 0 must say "not checked" rather than assert "the index has events"
    // (session 095, finding 8b — the report is forwardable evidence).
    return evaluateGate0(
        probe,
        ev.indexRowsInWindow === null ? undefined : ev.indexRowsInWindow > 0,
        false,
    );
};

/* Check 21 (§17.2/§17.8a-1..4) — is the raw-arm evidence usable? A number ONLY
 * when the probe ran clean over a grouped arm; the diagEvidence gate already
 * enforced grouped-shape + the settled-window clamp, so a clean `rawArmRows`
 * here is a settled-window row count. */
const rawArmUsable = (ev: PanelEvidence): boolean =>
    ev.rawArmRan && ev.rawArmError === '' && typeof ev.rawArmRows === 'number';

/** The confirmed cache-contradiction verdict (§17.2). Only ever built when the
 *  raw arm returned rows over the SETTLED window while the cache holds none. */
const cacheContradicted = (ev: PanelEvidence): Verdict => ({
    id: 'cache-contradicted',
    short: 'Cache missing data',
    headline:
        'The raw equivalent of this panel’s query returns data for this range, but the summarised layer holds none — the summary appears to be missing data it should have.',
    detail:
        `The raw query returns ${(ev.rawArmRows ?? 0).toLocaleString()} row(s) over the summarised period, and the summary has none for this panel. ` +
        'A Splunk administrator can re-run the backfill for this view from Settings -> Dashboard Data.',
    confidence: 'confirmed',
    owner: 'splunk-admin',
    evidence: [
        `Raw-equivalent rows over the settled window: ${(ev.rawArmRows ?? 0).toLocaleString()}`,
        'Summarised rows for this panel in the same range: 0',
    ],
});

/** The health-certifying agreement verdict (§17.2 rule 1a). Only ever built on
 *  the armAmbiguous branch, and only when the raw arm ran clean and returned 0. */
const cachedRawAgreeEmpty = (ev: PanelEvidence): Verdict => ({
    id: 'cached-raw-agree-empty',
    short: 'No data (raw agrees)',
    headline:
        'The raw equivalent of this panel’s query returns nothing for this range either — the summary is not missing anything; there is genuinely nothing to show.',
    detail: 'Both the summarised data and a direct raw query agree this range has no matching events.',
    confidence: 'expected',
    owner: 'nobody',
    evidence: [
        'Raw-equivalent rows over the settled window: 0',
        'Summarised rows for this panel in the same range: 0',
    ],
});

/* -------------------------------------------------------------------------
 * GATE C — the summarised (rollup) layer.
 *
 * Only reached for a cached read, and it is where the never-backfilled case
 * belongs — NOT in Gate 0.
 * ---------------------------------------------------------------------- */
const gateCached = (
    probe: SplProbe,
    ev: PanelEvidence,
    facts: PanelFacts,
    extras: Verdict[],
): Verdict | null => {
    if (probe.tier !== 'cached') return null;
    const where = probe.collection ? `\`${probe.collection}\`` : 'this view’s summarised data';

    if (ev.collectionRowsInWindow === null) {
        /* §14.5 — a KNOWN non-ready KV Store NAMES the failure instead of the
         * bare placeholder (mongod warm-up after a restart is routine on a
         * fresh install). A null status keeps the honest placeholder. */
        if (typeof ev.kvStoreStatus === 'string' && ev.kvStoreStatus !== 'ready') {
            return kvstoreNotReady(ev.kvStoreStatus);
        }
        return notEvaluated(
            'rollup-window',
            'The health of this view’s summarised data was not checked.',
            ev.budgetExhausted
                ? 'The diagnostic ran out of time before this check.'
                : 'The summarised-data search did not complete.',
        );
    }

    /* §18.8a-9 — the zeroValued (effective-empty) resolution. A KPI showing a
     * legitimate zero must never be told to run a backfill: metric rows that
     * merely SUM to zero, or a scalar raw twin that also computes zero,
     * certify the expected-class "genuinely zero"; a twin that disagrees is a
     * possible-grade lead (never confirmed — §18.8a-10). With no twin, the
     * standard hedged cached verdicts below apply unchanged. */
    if (facts.zeroValued === true) {
        if (ev.collectionRowsInWindow > 0) return panelZeroConfirmed('rows');
        if (ev.scalarTwin && Math.abs(ev.scalarTwin.value) < 0.5) {
            return panelZeroConfirmed('twin', ev.scalarTwin);
        }
        if (ev.scalarTwin && Math.abs(ev.scalarTwin.value) >= 0.5) {
            return zeroValueMismatch(ev.scalarTwin);
        }
    }

    if (ev.collectionRowsInWindow > 0) {
        // §17.2 rule 2 — the summary HAS rows but this panel is empty, so the
        // byte-equal raw arm should agree. If it instead returns rows, the
        // cached read is genuinely contradicted (a confirmed vendor-side defect).
        if (rawArmUsable(ev) && (ev.rawArmRows as number) > 0) {
            return cacheContradicted(ev);
        }
        // The summary has rows for this window, so the emptiness comes from the
        // panel's own narrower conditions inside it. Deliberately modest: this
        // gate did not test those conditions.
        const evidence = [`Summarised rows in the selected range: ${ev.collectionRowsInWindow}`];
        if (rawArmUsable(ev) && (ev.rawArmRows as number) === 0) {
            evidence.push('The raw equivalent of this panel’s query also returns nothing for this range.');
        }
        // §17.7 check 17b — a provider-scoped coverage note (never a verdict).
        if (probe.cloudFilter && ev.providerRowsPresent != null) {
            evidence.push(
                ev.providerRowsPresent
                    ? `Rows for cloud_provider="${probe.cloudFilter.provider}" do exist in this range.`
                    : `None of those rows carry cloud_provider="${probe.cloudFilter.provider}".`,
            );
        }
        return {
            id: 'rollup-has-rows',
            short: 'Summary has data',
            headline:
                'This view’s summarised data does cover your time range, so the gap is in what this particular panel asks for.',
            detail:
                'The stored summary has rows for this period; none of them match this panel’s specific breakdown.',
            confidence: 'expected',
            owner: 'nobody',
            evidence,
        };
    }

    // Zero rows in window. The extent decides which of several very different
    // causes it is — but ONLY an extent that was actually read. A failed
    // extent probe leaves the same nulls as an empty collection, and reading
    // failure as emptiness turned a KV hiccup into a confirmed "never built"
    // (session 095, finding 2).
    if (!ev.collectionExtentProbed) {
        if (typeof ev.kvStoreStatus === 'string' && ev.kvStoreStatus !== 'ready') {
            return kvstoreNotReady(ev.kvStoreStatus);
        }
        return notEvaluated(
            'rollup-extent',
            'The stored history of this view’s summarised data could not be read.',
            ev.budgetExhausted
                ? 'The diagnostic ran out of time before this check.'
                : 'The KV Store extent read failed — see the check list.',
        );
    }
    if (ev.collectionOldest === null && ev.collectionNewest === null) {
        /* §14.5 belt — an EMPTY extent during mongod warm-up (KV reads can
         * silently return empty while starting; session-087 sticky) is
         * indistinguishable from never-built. A KNOWN non-ready status says
         * so instead; a null status (probe failed / not run) proceeds — the
         * documented residual. */
        if (typeof ev.kvStoreStatus === 'string' && ev.kvStoreStatus !== 'ready') {
            return kvstoreNotReady(ev.kvStoreStatus);
        }

        /* §15.8a precedence for the empty collection:
         *   ingest-type-excluded > routing-not-applied >
         *   rollup-source-never-seen > rollup-never-built
         * — a named ingest-filter rule is the most specific story (an
         * excluded type never even reaches routing); events arriving
         * unparsed beats "never arrived"; and the plain never-built keeps
         * its unchanged wording as the residual. */
        const hist = cachedHistory(ev);
        const scopeNames =
            ev.sourceScope !== null && ev.sourceScope.sourcetypes.length > 0
                ? ev.sourceScope.sourcetypes.map((s) => `\`${s}\``).join(', ')
                : '';
        if (ev.sourceScope !== null) {
            const exC = ingestExclusion(
                ev.sourceScope.sourcetypes,
                ev.sourceScope.tags || [],
                ev,
                true,
            );
            if (exC.contradiction) extras.push(contradictionEntry(exC.contradiction));
            else if (exC.verdict) return exC.verdict;
        }
        if (scopeNames) {
            const routing = routingNearMiss(scopeNames, ev, hist.history, hist.newest);
            if (routing) return routing;
        }
        if (scopeNames && hist.history === 'never' && ev.sourceScope !== null) {
            const idx = singleIndex(ev);
            return {
                id: 'rollup-source-never-seen',
                short: 'Feed not started',
                headline: `This view’s summary has never been built — and the events it summarises (${scopeNames}) have never arrived in the index this app reads${idx ? ` (\`${idx}\`)` : ''}.`,
                detail:
                    'Running the backfill cannot help yet: there is nothing to summarise. This is a collection ' +
                    'question for whoever owns the feed. Once events arrive, a Splunk administrator runs the ' +
                    'backfill in Settings -> Dashboard Data to build the history. If the feed is believed active, ' +
                    'a Splunk administrator should check whether its events are being written to a different index.' +
                    fallbackCaveat(ev),
                confidence: 'confirmed',
                owner: 'ingest',
                evidence: [
                    `${where} contains no rows at all.`,
                    `Searched all time${idx ? ` in \`${idx}\`` : ''} for ${scopeNames}: nothing found.`,
                    `Traced via ${ev.sourceScope.via}`,
                ],
            };
        }

        // Empty collection, verified by a successful read. The strongest, most
        // actionable verdict this tool produces — the one §12.1 protects.
        const kpiHint =
            probe.emptySafeKpi === false && facts.rowCount === 0
                ? ' (this panel shows a dash rather than a zero, which is what an empty summary looks like)'
                : '';
        return {
            id: 'rollup-never-built',
            short: 'Summary not built',
            headline: `This view reads pre-summarised data that has never been built${kpiHint}.`,
            detail:
                'A Splunk administrator runs the one-time backfill in Settings -> Dashboard Data. ' +
                'Until then this view stays empty no matter which time range you pick.',
            confidence: 'confirmed',
            owner: 'splunk-admin',
            evidence: [`${where} contains no rows at all.`],
        };
    }

    const nowSec = Math.floor(Date.now() / 1000);
    const daily = probe.grain === 'daily';
    // The lag a HEALTHY collection carries is set by its write cadence, so the
    // threshold must be per-grain: a daily summary is 24.5–48.5h behind by
    // design, and judging it by the hourly rule flagged every healthy
    // beaconing diagnosis (session 095, finding 3).
    const staleLag = daily ? STALE_LAG_DAILY_SECONDS : STALE_LAG_SECONDS;

    if (ev.collectionNewest !== null) {
        const lagSeconds = nowSec - ev.collectionNewest;
        if (lagSeconds > staleLag) {
            /* §15.8a-3 — the stale-chain order is pinned:
             *   allDisabled-confirmed (OBSERVED) > ingest-type-excluded >
             *   routingNearMiss > plain rollup-stale (likely).
             * Observed first-party evidence outranks supplied evidence: a
             * disabled aggregate fully explains the staleness on its own,
             * and the re-enable action must reach the top. */
            const allDisabled =
                Array.isArray(ev.producerDisabled) &&
                typeof ev.producerTracedCount === 'number' &&
                ev.producerTracedCount > 0 &&
                ev.producerDisabled.length === ev.producerTracedCount;
            const someDisabled = Array.isArray(ev.producerDisabled) && ev.producerDisabled.length > 0;
            const histS = cachedHistory(ev);
            const scopeNamesS =
                ev.sourceScope !== null && ev.sourceScope.sourcetypes.length > 0
                    ? ev.sourceScope.sourcetypes.map((s) => `\`${s}\``).join(', ')
                    : '';
            if (!allDisabled && ev.sourceScope !== null) {
                const exStale = ingestExclusion(
                    ev.sourceScope.sourcetypes,
                    ev.sourceScope.tags || [],
                    ev,
                    true,
                );
                if (exStale.contradiction) extras.push(contradictionEntry(exStale.contradiction));
                else if (exStale.verdict) return exStale.verdict;
            }
            if (!allDisabled && scopeNamesS) {
                const routingS = routingNearMiss(scopeNamesS, ev, histS.history, histS.newest);
                if (routingS) return routingS;
            }
            const disabledNames = someDisabled ? (ev.producerDisabled as string[]).join(', ') : '';
            return {
                id: 'rollup-stale',
                short: 'Summary is stale',
                headline: `This view’s summarised data stops at ${fmtDate(ev.collectionNewest)} — ${fmtAgo(ev.collectionNewest)}.`,
                detail: allDisabled
                    ? `Its scheduled summarisation ${(ev.producerDisabled as string[]).length > 1 ? 'jobs are' : 'job is'} DISABLED (${disabledNames}) — ` +
                      'a Splunk administrator re-enables it in Settings -> Dashboard Data (the per-rollup toggle).'
                    : `The ${daily ? 'daily' : 'hourly'} summarisation that feeds it appears to have stopped. A Splunk administrator can check ` +
                      'Settings -> Dashboard Data, where each summary shows whether its scheduled job is enabled.' +
                      (someDisabled
                          ? ` One of the jobs that feeds it is disabled: ${disabledNames} — a candidate cause.`
                          : ''),
                confidence: allDisabled ? 'confirmed' : 'likely',
                owner: 'splunk-admin',
                evidence: [
                    `Newest stored bucket: ${fmtDate(ev.collectionNewest)}`,
                    `Expected lag for a healthy ${daily ? 'daily' : 'hourly'} summary is under ${staleLag / 3600} hours.`,
                ]
                    .concat(
                        someDisabled
                            ? [
                                  `Summarisation job(s) currently disabled: ${disabledNames}${allDisabled ? ' (every job this summary depends on)' : ''}`,
                              ]
                            : [],
                    )
                    .concat(
                        /* SS16.8a-1/2 — the platform snapshot may only ever ADD
                         * this provenance-badged line. It NEVER changes the
                         * confidence above: the snapshot collection is
                         * world-writable, so a forged skip row must not be able
                         * to raise a grade (the SS15.8a doctrine). The matches
                         * were already restricted upstream to status=skipped,
                         * exact producer-name equality, buckets inside the
                         * staleness gap, and a LIVE snapshot. An empty match
                         * list is never negative evidence, so it adds nothing. */
                        Array.isArray(ev.platformSkips) && ev.platformSkips.length > 0
                            ? ev.platformSkips.map(
                                  (s) =>
                                      `The scheduler skipped ${s.search} ${s.n} time(s) across ${s.buckets} recent hour(s)` +
                                      (s.reason ? ` (reason: ${s.reason})` : '') +
                                      ` - ${SNAPSHOT_PROVENANCE}.`,
                              )
                            : [],
                    ),
            };
        }

        /* LEADING EDGE — the summary is FRESH, and the selected range begins
         * AFTER the newest written bucket, so no written bucket can satisfy
         * the read's `>= info_min_time` filter. Healthy behaviour, not a gap:
         * "Last 2 hours" dispatched before this collection's staggered minute,
         * or any sub-day recent range on a daily summary (the exact shape of
         * findings 4b and 3's residual). The window bound is approximate
         * (snap suffixes ignored), which is acceptable because the verdict is
         * Expected-class — over-firing names a freshness fact that is true
         * anyway, and under-firing falls through to the hedged verdicts. */
        const winStart = approxEpoch(facts.earliest, nowSec);
        if (winStart !== null && winStart > ev.collectionNewest) {
            return {
                id: 'rollup-leading-edge',
                short: 'Not yet summarised',
                headline: `This view’s summarised data is written once ${daily ? 'a day' : 'an hour'}, and your range only covers the period since the last write.`,
                detail: daily
                    ? 'Each day is summarised shortly after it ends (just past midnight UTC), so a range inside today has nothing to read yet. Widen the range to include earlier days.'
                    : 'The most recent hour has not been summarised yet. Widen the range, or try again a few minutes past the top of the hour.',
                confidence: 'expected',
                owner: 'user',
                evidence: [
                    `Newest stored bucket: ${fmtDate(ev.collectionNewest)}`,
                    `Selected range starts at ~${fmtDate(winStart)} — after that bucket.`,
                ],
            };
        }
    }

    /* HORIZON — the whole selected range predates the stored history. The
     * extent was IN HAND before session 095 but unconsulted, so this state
     * fell through to the source trace and came back as a confirmed
     * "never summarised — re-run the backfill", prescribing a 30-day backfill
     * that cannot reach the window (finding 4a). */
    if (ev.collectionOldest !== null) {
        const winEnd = approxEpoch(facts.latest, nowSec);
        if (winEnd !== null && winEnd <= ev.collectionOldest) {
            const from = fmtDate(ev.collectionOldest);
            const to = ev.collectionNewest !== null ? fmtDate(ev.collectionNewest) : 'now';
            return {
                id: 'rollup-window-uncovered',
                short: 'Range not summarised',
                headline: `This view’s stored history begins at ${from}, and your selected range ends before that.`,
                detail:
                    'Pick a range inside the stored period, or ask a Splunk administrator whether the history can be ' +
                    'extended from Settings -> Dashboard Data.',
                confidence: 'likely',
                owner: 'user',
                evidence: [
                    'Summarised rows in the selected range: 0',
                    `Stored history: ${from} -> ${to}`,
                ],
            };
        }
    }

    /* THE SUMMARY IS MAINTAINED BUT HAS NOTHING FOR THIS WINDOW.
     *
     * Two opposite causes, and until session 095 the diagnostic could not tell
     * them apart because a rollup read names no sourcetype. It now traces the
     * collection back to the aggregate that populates it and asks whether the
     * SOURCE events exist:
     *   - source events present  -> the summary is missing data it should have.
     *                               That is OUR fault, and actionable.
     *   - source events absent   -> nothing happened. Nothing is broken.
     * This is the one place a cached panel may reach an "expected" verdict, and
     * it does so on SOURCE-EVENT evidence — never on the rollup row count,
     * which is identical for both causes (design §12.1). */
    if (ev.sourceScope !== null && ev.sourcetypeCounts !== null) {
        const src = ev.sourceScope.sourcetypes;
        const found = src.filter((st) => (ev.sourcetypeCounts as Record<string, number>)[st] > 0);
        const names = src.map((st) => `\`${st}\``).join(', ');
        if (found.length > 0) {
            const total = found.reduce(
                (a, st) => a + (ev.sourcetypeCounts as Record<string, number>)[st],
                0,
            );
            /* METRIC-ARM AMBIGUITY (session 095, finding 4c). The trace is
             * sourcetype-level and deliberately over-collected, while many
             * panels read one METRIC ARM whose predicate is far narrower (ICM
             * errors = status>=400; HANA password ops = a regex). Sibling-
             * metric rows in the window prove the aggregate RAN and only this
             * arm wrote nothing — which is ambiguous between "no qualifying
             * events occurred" (healthy; the live icmerr case) and "this arm
             * is broken" (session-093's D3/D4 were exactly that). Neither can
             * be confirmed without re-running the arm's predicate, which this
             * module deliberately never does — so the verdict HEDGES and
             * names the safe, decisive action. `confirmed` remains only for
             * the un-ambiguous shape: the whole collection has nothing for a
             * window whose source events exist. */
            const armAmbiguous =
                !!probe.metric &&
                (ev.collectionRowsAllMetrics === null || ev.collectionRowsAllMetrics > 0);
            if (armAmbiguous) {
                /* §17.2 rule 1 — panel-exact raw evidence OUTRANKS the
                 * over-collected sourcetype trace here. Raw rows > 0 confirms
                 * the arm is genuinely missing data (cache-contradicted);
                 * raw rows === 0 certifies health (cached-raw-agree-empty) —
                 * the stronger §12.1 form, allowed ONLY on this ambiguous
                 * branch (§17.8a-3). */
                if (rawArmUsable(ev) && (ev.rawArmRows as number) > 0) return cacheContradicted(ev);
                if (rawArmUsable(ev) && (ev.rawArmRows as number) === 0) return cachedRawAgreeEmpty(ev);
                return {
                    id: 'rollup-metric-empty',
                    short: 'No qualifying events?',
                    headline:
                        'The summary covers this period, but holds nothing for the specific measure this panel reads.',
                    detail:
                        'Either no qualifying events occurred (this measure counts a narrow subset), or its part of the ' +
                        'summarisation missed them. Re-running the backfill from Settings -> Dashboard Data is safe and ' +
                        'settles it: if the panel stays empty afterwards, there were genuinely none.',
                    confidence: 'possible',
                    owner: 'splunk-admin',
                    evidence: [
                        `Source events in the selected range: ${total.toLocaleString()} (${found.join(', ')}) — but this panel's measure filters far narrower.`,
                        `Summarised rows for this panel's measure ("${probe.metric}"): 0`,
                        ev.collectionRowsAllMetrics !== null
                            ? `Summarised rows for the collection's other measures: ${ev.collectionRowsAllMetrics.toLocaleString()} — the summarisation did run for this period.`
                            : 'Whether the collection holds rows for other measures could not be checked.',
                        `Traced via ${ev.sourceScope.via}`,
                    ],
                };
            }
            /* §17.2 rule 1c / §17.8a-3 — the whole collection has nothing for a
             * window whose SOURCE events exist. Panel-exact raw agreement
             * (rawArmRows === 0) means the over-collected trace counted events
             * this panel would not match: downgrade to `possible` with a note —
             * NEVER certify health here (agreement is the weaker observation and
             * must not override first-hand source-event evidence). Raw rows > 0
             * only strengthens the confirmed gap (an added evidence line). */
            const gapEvidence = [
                `Source events in the selected range: ${total.toLocaleString()} (${found.join(', ')})`,
                'Summarised rows in the selected range: 0',
                `Traced via ${ev.sourceScope.via}`,
            ];
            if (rawArmUsable(ev) && (ev.rawArmRows as number) === 0) {
                return {
                    id: 'rollup-gap',
                    short: 'Summary may be missing data',
                    headline:
                        'The sourcetype has events in this period but the summary has none — though the raw equivalent of this exact panel also returns nothing.',
                    detail:
                        'The sourcetype-level count may include events this panel would not match. Re-running the ' +
                        'backfill from Settings -> Dashboard Data is safe and settles it.',
                    confidence: 'possible',
                    owner: 'splunk-admin',
                    evidence: gapEvidence.concat(
                        'The raw equivalent of this panel’s query also returns nothing for this range.',
                    ),
                };
            }
            if (rawArmUsable(ev) && (ev.rawArmRows as number) > 0) {
                gapEvidence.push(
                    `Raw-equivalent rows over the settled window: ${(ev.rawArmRows as number).toLocaleString()}.`,
                );
            }
            return {
                id: 'rollup-gap',
                short: 'Summary missing data',
                headline:
                    'The underlying events for this period exist, but they were never summarised — so this view cannot show them.',
                detail:
                    `There are ${total.toLocaleString()} matching events in the range, and no summarised rows. ` +
                    'A Splunk administrator can re-run the backfill for this view from Settings -> Dashboard Data.',
                confidence: 'confirmed',
                owner: 'splunk-admin',
                evidence: gapEvidence,
            };
        }
        if (src.length > 0) {
            return {
                id: 'source-absent',
                short: 'No such data',
                headline: `There are genuinely no ${names} events in this time range — nothing is broken.`,
                detail:
                    'This view summarises those events, and none occurred in the period you selected.',
                confidence: 'expected',
                owner: 'nobody',
                evidence: [
                    `The events this view summarises (${src.join(', ')}) have none in the selected range.`,
                    `Traced via ${ev.sourceScope.via}`,
                ],
            };
        }
    }

    // Source unknown — fall back to describing what the summary does hold.
    // Wording is careful NOT to claim the range is outside the history: with
    // the horizon and leading-edge cases already handled above, this branch
    // can also be a mid-history quiet stretch on a tag-scoped rollup, where
    // "falls outside it" would be visibly false (session 095, finding 9).
    const from = ev.collectionOldest !== null ? fmtDate(ev.collectionOldest) : 'unknown';
    const to = ev.collectionNewest !== null ? fmtDate(ev.collectionNewest) : 'unknown';
    return {
        id: 'rollup-window-uncovered',
        short: 'Range not summarised',
        headline: `This view’s stored history covers ${from} to ${to}, and there are no summarised rows for the range you selected.`,
        detail:
            'Pick a different range inside that period, or ask a Splunk administrator whether the history should be ' +
            'extended from Settings -> Dashboard Data.',
        confidence: 'likely',
        owner: 'user',
        evidence: [
            'Summarised rows in the selected range: 0',
            `Stored history: ${from} -> ${to}`,
        ],
    };
};

/* -------------------------------------------------------------------------
 * GATE X — the Windows-extraction question (§14.4).
 *
 * The LogServ App ships NO XmlWinEventLog search-time extraction of its own
 * (severity/EventCode come from Splunk_TA_windows on the SEARCH tier —
 * session 069), so a Windows panel that is empty WHILE its events exist is a
 * strong hint the add-on is missing. WINDOWS-FAMILY ONLY: the App itself
 * ships the Linux/SAP extractions, so no equivalent rule may fire for those.
 *
 * Evaluated BEFORE gateCached (§14.8a-4.2): with the add-on absent the
 * Windows aggregate still writes rows with severity "(none)", so cached
 * panels would otherwise land on Expected-class rollup verdicts that read
 * false-health-adjacent.
 * ---------------------------------------------------------------------- */
const WIN_FAMILY = /^(Xml)?WinEventLog/i;
const WINDOWS_TA = 'Splunk_TA_windows';

const gateExtractionApp = (
    probe: SplProbe,
    ev: PanelEvidence,
    facts?: PanelFacts,
): Verdict | null => {
    if (!Array.isArray(ev.installedApps)) return null; // unknown is not absent (§12.3)
    if (ev.installedApps.indexOf(WINDOWS_TA) !== -1) return null;
    const own = probe.sourcetypes.filter((s) => WIN_FAMILY.test(s));
    const traced =
        ev.sourceScope !== null
            ? ev.sourceScope.sourcetypes.filter(
                  (s) => WIN_FAMILY.test(s) && own.indexOf(s) === -1,
              )
            : [];
    const family = own.concat(traced);
    if (family.length === 0) return null;
    /* §18.8a-21 — events-present premise. In EMPTY mode it comes from the
     * windowed sourcetype counts; in PARTIAL mode the panel's own rows ARE the
     * proof (the partial gather skips the count probe), and the gate stays
     * eligible because a missing extraction add-on is precisely the right
     * diagnosis for a blank Windows column. */
    const partial = facts !== undefined && diagnosisMode(facts) === 'partial';
    let evidenceLine: string;
    if (partial) {
        if (!facts || facts.rowCount === null || facts.rowCount <= 0) return null;
        evidenceLine = `This panel itself returned ${facts.rowCount.toLocaleString()} row(s) of Windows data (${family.join(', ')}).`;
    } else {
        if (ev.sourcetypeCounts === null) return null;
        const present = family.filter(
            (s) => (ev.sourcetypeCounts as Record<string, number>)[s] > 0,
        );
        if (present.length === 0) return null; // events absent — the other gates own that story
        const total = present.reduce(
            (a, s) => a + (ev.sourcetypeCounts as Record<string, number>)[s],
            0,
        );
        evidenceLine = `Windows events in the selected range: ${total.toLocaleString()} (${present.join(', ')})`;
    }
    return {
        id: 'extraction-app-missing',
        short: 'Add-on missing',
        headline:
            `The Windows events exist, but the add-on that extracts their fields on the search tier (${WINDOWS_TA}) ` +
            'is not installed (or is not visible to your account).',
        detail:
            'Panels reading Windows events depend on fields that add-on extracts (severity, EventCode, …). ' +
            'Install the Splunk Add-on for Microsoft Windows on the search head.' +
            (probe.tier === 'cached'
                ? ' After installing it, re-run the backfill in Settings -> Dashboard Data so the summarised history is rebuilt with the extracted fields.'
                : ''),
        confidence: 'possible',
        owner: 'splunk-admin',
        evidence: [
            evidenceLine,
            `${WINDOWS_TA}: not present in the apps visible to this role.`,
        ],
    };
};

/* -------------------------------------------------------------------------
 * GATE F — field existence / value (check 22, §17.3) — raw tier.
 *
 * Appended AFTER gateCached so a confirmed cached-layer verdict always outranks
 * these likely/possible ones (§17.8a-14). Scope-honest wording (§17.8a-12):
 * every claim states it is about the most recent sample of the panel's
 * sourcetype(s), without the panel's own host/cloud/breakdown filters.
 * ---------------------------------------------------------------------- */
const gateFieldProbe = (probe: SplProbe, ev: PanelEvidence): Verdict | null => {
    if (probe.tier !== 'raw' || !ev.fieldProbe) return null;
    const fp = ev.fieldProbe;
    const scope = probe.sourcetypes.length > 0 ? probe.sourcetypes.map((s) => `\`${s}\``).join(', ') : 'this panel’s data';
    const sampleNote =
        fp.sampled >= 2000
            ? `the ${fp.sampled} most recent ${scope} events (a sample; the panel's own host / cloud / breakdown filters were NOT applied)`
            : `all ${fp.sampled} ${scope} events in this window (the panel's own host / cloud / breakdown filters were NOT applied)`;
    // 1) A field present on 0 of N sampled events — likely an extraction gap.
    const absent = fp.filters.find((f) => f.present === 0);
    if (absent) {
        return {
            id: 'field-never-populated',
            short: 'Field not populated',
            headline: `This panel filters on \`${absent.field}\`, but that field is not populated on ${scope}.`,
            detail:
                'This is usually a search-time extraction issue — a missing add-on, a broken props extraction chain, ' +
                'or a field that only exists on a different sourcetype. A Splunk administrator can confirm the extraction.',
            // §17.8a-12: capped at possible when the sample was capped at 2000.
            confidence: fp.sampled >= 2000 ? 'possible' : 'likely',
            owner: 'splunk-admin',
            evidence: [
                `\`${absent.field}\` present on 0 of ${fp.sampled} sampled events.`,
                `Checked against ${sampleNote}.`,
            ],
        };
    }
    // 2) A field populated, but the panel's literal value never appears.
    const mismatch = fp.filters.find((f) => f.matches !== null && f.matches === 0 && f.present > 0);
    if (mismatch) {
        return {
            id: 'field-value-mismatch',
            short: 'Value never matches',
            headline: `\`${mismatch.field}\` is populated, but none of this panel’s expected value(s) (${mismatch.values.map((v) => `"${v}"`).join(', ')}) appear on ${scope}.`,
            detail:
                'The value vocabulary or casing may differ from what this panel expects (for example a renamed status ' +
                'value). A Splunk administrator can compare the panel’s filter against the field’s actual values.',
            confidence: 'possible',
            owner: 'splunk-admin',
            evidence: [
                `\`${mismatch.field}\` present on ${mismatch.present} of ${fp.sampled}, but 0 carry the expected value(s).`,
                `Checked against ${sampleNote}.`,
            ],
        };
    }
    return null;
};

/* GATE L — lookup registration (check 24, §17.4). Dormant for the current
 * panel set. Grade possible: a 404 is also what an ACL-hidden object returns. */
const gateLookup = (ev: PanelEvidence): Verdict | null => {
    if (!ev.lookupsMissing || ev.lookupsMissing.length === 0) return null;
    const names = ev.lookupsMissing.join(', ');
    return {
        id: 'lookup-not-registered',
        short: 'Lookup missing',
        headline: `A lookup this panel uses (${names}) is not registered on this search head, or is not visible to your account.`,
        detail:
            'A CSV placed under `default/lookups/` does not register — Splunk auto-registers only the app-root ' +
            '`lookups/` directory — or the app that defines it is missing. A Splunk administrator can confirm.',
        confidence: 'possible',
        owner: 'splunk-admin',
        evidence: [`Not found via the lookup registry: ${names}.`],
    };
};

/* GATE B — predicate relaxation bisect (check 25, §17.5). Names WHICH clause
 * excludes every event. Possible only: the bisect cannot tell "genuinely none"
 * from vocabulary drift (§17.8a-6). Skipped entirely when the control probe
 * showed the emptiness is downstream of the base search. */
const gateBisect = (ev: PanelEvidence): Verdict | null => {
    if (!ev.bisect) return null;
    // Control > 0 → emptiness is after the base search; the bisect concluded
    // nothing (diagEvidence left `clauses` empty and noted it).
    if (ev.bisect.controlRows !== 0) return null;
    const killers = ev.bisect.clauses.filter((c) => (c.removedRows ?? 0) > 0);
    if (killers.length === 0) return null;
    const one = killers.length === 1;
    const list = killers
        .map((c) => `\`${c.fragment}\` (removing it matches ${(c.removedRows ?? 0).toLocaleString()} event(s))`)
        .join('; ');
    return {
        id: 'clause-excludes-all',
        short: 'One clause excludes all',
        headline: one
            ? `Every event in this range is excluded by a single clause: ${list}.`
            : `Several clauses each exclude all matches: ${list}.`,
        detail:
            'Either no such events occurred in this period, or the value vocabulary differs from what the panel ' +
            'expects. This names the clause; it cannot decide which of the two it is.',
        confidence: 'possible',
        owner: 'nobody',
        evidence: killers.map(
            (c) => `Removing \`${c.fragment}\` changes the result from 0 to ${(c.removedRows ?? 0).toLocaleString()} event(s).`,
        ),
    };
};

/* -------------------------------------------------------------------------
 * §19.4 — the cloud-provider stamp consumption: EVIDENCE LINES ONLY (the
 * world-writable-supplied discipline — supplied facts may explain, never
 * certify). Added by THIS drawer-tier cascade, never by `explainEmptyPanel`
 * (the free tier must not grow an evidence dependency), via CLONE-AND-APPEND
 * so the free-verdict objects are never mutated (§19.8a-10).
 * ---------------------------------------------------------------------- */

/** The ids the stamp lines attach to: the two provider-filter free verdicts
 *  plus the cached 17b coverage path. */
export const STAMP_LINE_VERDICT_IDS: readonly string[] = [
    'active-filters',
    'intrinsic-provider',
    'rollup-has-rows',
] as const;

/** §19.8a-10 wording. Lines only when the stamp is KNOWN and DIFFERENT from
 *  the panel's provider (a matching stamp explains nothing about emptiness).
 *  Every line carries the fleet-scoping clause (one pasted tier must not be
 *  generalised) and M9's tense (the stamp is a present-tense setting applied
 *  to a window that may predate it). For an `aws`-scoped panel the shipped
 *  filter form is `(cloud_provider="aws" OR NOT cloud_provider=*)`, so the
 *  aws clause is added on BOTH branches. */
export const providerStampLines = (probe: SplProbe, ev: PanelEvidence): string[] => {
    const fx = ingestFactsOf(ev);
    const stamp = knownStamp(fx);
    if (stamp === null) return [];
    const panelProvider = probe.cloudFilter ? probe.cloudFilter.provider : null;
    if (!panelProvider) return [];
    if (stamp === panelProvider) return [];
    const scopeClause = `as supplied from ${fx && fx.sourceHost ? fx.sourceHost : 'the pasted instance'}; other forwarders may be configured differently`;
    const awsClause =
        panelProvider === 'aws'
            ? ' And `aws` additionally matches every event that carries no provider at all, so this stamp does not by itself explain an empty `aws` panel.'
            : '';
    if (stamp === 'not_set') {
        return [
            `The Data TA stamps no provider (Not set; ${scopeClause}). On a mixed AWS/Azure/GCP fleet this is ` +
                'the recommended configuration — attribution comes from each input’s own `_meta` setting; a ' +
                `\`${panelProvider}\` filter only matches events attributed that way.` +
                awsClause,
        ];
    }
    return [
        `The Data TA’s ingest stamp is \`${stamp}\` (${scopeClause}) — events routed by the Data TA since ` +
            `that setting was applied carry that provider, so a \`${panelProvider}\` filter only matches events ` +
            'attributed by a per-input setting; events indexed earlier carry whatever was configured then, or none.' +
            awsClause,
    ];
};

/* -------------------------------------------------------------------------
 * §19.5 — the drawer-side POINTER to the Diagnostics-page paste (not a paste
 * box; one write path). Exported from HERE (gate-safe) so the id set and the
 * trigger predicate are pinnable; the drawer and its Copy-technical-summary
 * both render the same sentence (§19.8a-19).
 * ---------------------------------------------------------------------- */

/** The ingest-ambiguous family the pointer appears under.
 *  `sourcetype-outside-window` is EXCLUDED by design (§19.8a-17 / H20): that
 *  verdict PROVES the data exists and arrived — ingest filtering is already
 *  ruled out, and the pointer would promise a sharpening that cannot come.
 *  The exclusion is gate-pinned explicitly (all six are EMPTINESS members,
 *  so membership alone would not catch a widening). */
export const INGEST_POINTER_VERDICT_IDS: readonly string[] = [
    'index-empty-in-window',
    'sourcetype-never-seen',
    'rollup-source-never-seen',
    'sourcetype-stale',
    'routing-not-applied',
] as const;

/** A capability, not a guarantee (§19.8a-19 / H8). */
export const INGEST_POINTER_SENTENCE =
    'If a Splunk administrator supplies the Data TA’s ingest-filter configuration on the ' +
    'Diagnostics page, this diagnosis can take those filters into account.';

/**
 * §19.8a-18 — the pointer trigger. Shows only when: the top verdict is in
 * the ingest-ambiguous family; the facts are NOT usable for the boundary
 * (nothing supplied, an unparsed paste, enabled-undeterminable, or the
 * defaults-shape — the same predicate the report's `cannotCheckLines` keys
 * on, so the two surfaces cannot drift); AND the gather did not record an
 * ingest-facts fetch error/skip — that state is "could not be read", not
 * "not supplied", and asking for a re-supply would mislead.
 */
export const shouldShowIngestPointer = (topId: string, ev: PanelEvidence): boolean => {
    if (INGEST_POINTER_VERDICT_IDS.indexOf(topId) === -1) return false;
    if (factsUsableForBoundary(ingestFactsOf(ev))) return false;
    const notes = Array.isArray(ev.notes) ? ev.notes : [];
    const fetchFailed = notes.some(
        (n) =>
            n.check === INGEST_FACTS_CHECK_NAME &&
            (n.status === 'error' || n.status === 'skipped'),
    );
    return !fetchFailed;
};

const FALLBACK: Verdict = {
    id: 'undetermined',
    short: 'Cause unknown',
    headline: 'We could not determine why this view is empty.',
    detail:
        'The checks that ran did not find a problem, and did not find an explanation either. ' +
        'The technical detail below is what to send to Splunk support.',
    confidence: 'not-evaluated',
    owner: 'nobody',
    evidence: ['All available checks completed without identifying a cause.'],
};

/**
 * Run the whole cascade for one panel.
 *
 * `facts` is what the panel already knows (its dispatched SPL, window, outcome);
 * `evidence` is what `gatherPanelEvidence` found. Pure — no dispatch, no clock
 * dependency beyond `Date.now()` for lag arithmetic.
 */
export const diagnosePanel = (facts: PanelFacts, evidence: PanelEvidence): Diagnosis => {
    const probe = probeSpl(facts.spl);
    const mode: PanelMode = diagnosisMode(facts);

    /* §18.8a-5 — UNKNOWN refuses to classify: a null rowCount cannot
     * distinguish "no rows" from "no answer yet", and diagnosing an unknown
     * panel as empty was the review's blocker W-2(3). The drawer additionally
     * refuses to dispatch the gather at all in this state. */
    if (mode === 'unknown') {
        const free0 = allFreeVerdicts(facts, 'partial');
        const top0 = free0.find((v) => v.confidence !== 'not-evaluated');
        const all0 = free0.concat([
            notEvaluated(
                'mode-unknown',
                'This panel’s search state is unknown — nothing was diagnosed.',
                'The panel has not reported a row count (still loading, or never classified), so neither the empty nor the partial checks can honestly run.',
            ),
        ]);
        return { top: top0 ?? all0[all0.length - 1], all: all0, incomplete: true };
    }

    /* §18.8a-18..22 — PARTIAL mode: the panel HAS rows, which are living proof
     * the index/sourcetype/rollup read path works. Only the mode-appropriate
     * free checks, the extraction-app gate (column-aware premise) and the
     * column tier run; every emptiness verdict is structurally unreachable
     * (the EMPTINESS_VERDICT_IDS classification, gate-enforced). */
    if (mode === 'partial') {
        const freeP = allFreeVerdicts(facts, 'partial');
        const dispatchedP: Array<Verdict | null> = [
            gateExtractionApp(probe, evidence, facts),
            gateColumns(probe, evidence, facts),
        ];
        const allP = freeP.concat(dispatchedP.filter((v): v is Verdict => v !== null));
        const concludedP = allP.filter((v) => v.confidence !== 'not-evaluated');
        return {
            top: concludedP.length > 0 ? concludedP[0] : PARTIAL_FALLBACK,
            all: concludedP.length > 0 ? allP : allP.concat([PARTIAL_FALLBACK]),
            incomplete:
                evidence.budgetExhausted || allP.some((v) => v.confidence === 'not-evaluated'),
        };
    }

    // The free checks, in their own order, unchanged — so the drawer and the
    // inline hint can never disagree about the same panel (§12.5).
    const free = allFreeVerdicts(facts);

    // When the visibility gate fires, the index-empty gate must stand down:
    // "you cannot see the index" and "there are no events of any kind" are
    // contradictory explanations of the same zero, and the second is false in
    // exactly that case (session 095, finding 1).
    //
    // §15.8a-9 slotting: visibility > ingest-cutoff > index-empty, each
    // superseding the next (compute-once null-out); and when check 28 fires,
    // gateCached stands down ENTIRELY — its horizon/never-built prescriptions
    // ("extend the history", "run the backfill") are impossible for a window
    // the ingest tier discards. The extent facts stay in the check ledger.
    const extras: Verdict[] = [];
    const visibility = gateVisibility(evidence);
    const cutoff = visibility ? null : gateIngestCutoff(evidence, facts);
    const dispatched: Array<Verdict | null> = [
        visibility,
        cutoff,
        visibility || cutoff ? null : gateIndexEmpty(evidence),
        gateSourcetype(probe, evidence, facts, extras),
        // §14.4 — before gateCached, so a missing extraction add-on outranks
        // the Expected-class rollup verdicts its absence produces.
        gateExtractionApp(probe, evidence, facts),
        cutoff ? null : gateCached(probe, evidence, facts, extras),
        // §17.8a-14 — the deep field/lookup/bisect checks are appended AFTER
        // gateCached so a confirmed cached-layer verdict always outranks their
        // likely/possible conclusions.
        gateFieldProbe(probe, evidence),
        gateLookup(evidence),
        gateBisect(evidence),
    ];

    let all: Verdict[] = free.concat(
        dispatched.filter((v): v is Verdict => v !== null),
        extras,
    );

    /* §19.4/§19.8a-10 — the cloud-provider stamp lines, CLONE-AND-APPEND on
     * the provider-scoped surfaces only. The map replaces matching entries
     * with `{...v, evidence: v.evidence.concat(...)}` — the free-verdict
     * objects from `allFreeVerdicts` are never mutated (gate-pinned: a
     * repeat diagnosis without facts carries no residue). Evidence only;
     * confidence never moves. */
    const stampLines = providerStampLines(probe, evidence);
    if (stampLines.length > 0) {
        all = all.map((v) =>
            STAMP_LINE_VERDICT_IDS.indexOf(v.id) !== -1
                ? { ...v, evidence: v.evidence.concat(stampLines) }
                : v,
        );
    }

    /* §14.8a-5.3 — a kvstore-not-ready conclusion must not ERASE the fact
     * that the rollup's health itself went unchecked: without this companion,
     * replacing the not-evaluated placeholders with one concluded verdict
     * would flip `incomplete` to false on exactly a degraded instance. */
    if (all.some((v) => v.id === 'kvstore-not-ready')) {
        all.push(
            notEvaluated(
                'rollup-health-unchecked',
                'Rollup health itself remains unchecked while the KV Store is unavailable.',
                'The summarised-data probes could not run against a non-ready KV Store.',
            ),
        );
    }

    // `top` is the first verdict that actually concludes something. A
    // not-evaluated entry is kept in `all` (so the drawer shows what was
    // skipped and why) but can never become the headline while a real
    // conclusion exists further down.
    const concluded = all.filter((v) => v.confidence !== 'not-evaluated');
    return {
        top: concluded.length > 0 ? concluded[0] : FALLBACK,
        all,
        incomplete: evidence.budgetExhausted || all.some((v) => v.confidence === 'not-evaluated'),
    };
};
