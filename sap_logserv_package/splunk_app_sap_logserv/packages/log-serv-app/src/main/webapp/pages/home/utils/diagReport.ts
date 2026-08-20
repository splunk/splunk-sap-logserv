/**
 * diagReport — the "LogServ Data Doctor Report" MODEL (session 095, design §7).
 *
 * Pure functions that assemble a report from evidence the diagnostic already
 * gathered, at three scopes:
 *
 *   - PANEL       — one panel's full diagnosis (the drawer's Download PDF)
 *   - DASHBOARD   — every registered search on the current page, with the full
 *                   cascade run on the empty ones (Actions -> Diagnose)
 *   - ENVIRONMENT — index / sourcetype / rollup / platform health with no
 *                   panel scope at all (Actions -> Environment report)
 *
 * THE MODEL IS THE TESTABLE ARTIFACT. Rendering lives in `diagReportPdf.ts`
 * (jsPDF, browser-only); everything here is plain data so the build gate can
 * assert the properties that matter — the banner is present, the dispatched
 * SPL is verbatim, a skipped check always carries its reason, the JSON
 * appendix is schema-tagged — without a DOM.
 *
 * Two §7 rules enforced by construction:
 *   - Branded as a **Splunk support artifact** with a data-exposure banner:
 *     the report embeds SPL (index names, hosts, SIDs), so the cover states
 *     that plainly (design Risk 6). No raw events are ever included.
 *   - **A skipped check must say why** — the evidence table rows come from
 *     `ProbeNote.detail` verbatim, where the reason already lives.
 */

import { Verdict, PanelFacts } from './panelDiagnosis';
import { Diagnosis } from './diagCascade';
import {
    PanelEvidence,
    ProbeNote,
    RawSampleSet,
    ProducerSplEntry,
    RAW_SAMPLE_EVENT_MAX_CHARS,
    formatCount,
} from './diagEvidence';
import { SplProbe } from './splProbe';
import { SweepResult, describeSearch } from './diagSweep';
import {
    IngestFacts,
    ingestFactsSummary,
    isDefaultsShape,
    provenanceLine,
    factsAreStale,
    staleCaveatLine,
    scrubbedExcerpt,
    isPassAllInclude,
    factsUsableForBoundary,
    knownStamp,
} from './diagIngestFacts';
import { EnvironmentEvidence, RollupHealthRow, COMPANION_APPS } from './diagEnvironment';
import {
    PlatformSnapshot,
    NOT_CHECKED_SNAPSHOT,
    SNAPSHOT_AGGREGATE,
    buildAsciiBarChart,
    DAILY_SERIES_MAX_ROWS,
} from './diagPlatform';

export const REPORT_TITLE = 'LogServ Data Doctor Report';
export const REPORT_SCHEMA = 'logserv.diag/1';

/** Cover banner — required on every report (design Risk 6).
 *
 *  STATE-AWARE from build 315 (SS16.8a-26): the banner is DERIVED from the
 *  same object that carries the raw samples (`json.rawSamples != null`), never
 *  passed as a free flag, so the inventory and the contents cannot disagree.
 *  The inventory also names the scheduler content the SS16 platform section
 *  added (SS16.8a-6): the environment report now carries scheduled-search
 *  names and scheduler messages from EVERY app on the instance. */
export const dataBanner = (includesRawSamples: boolean): string =>
    'This report contains data from your Splunk instance: search strings, index and host names, ' +
    'sourcetypes and SAP system identifiers, scheduled-search names and scheduler messages from ' +
    'apps on this instance, the full text of the saved searches that populate this ' +
    // ASCII apostrophe: the diagPlatform banner pin enforces Latin-1 only.
    "app's summary collections, and any ingest-filter configuration supplied to the " +
    'diagnostic by your administrator. ' +
    (includesRawSamples
        ? 'It INCLUDES up to 5 redacted, full-length raw log events - explicitly enabled by the ' +
          'person who generated it (credential patterns and email addresses are redacted; ' +
          'hostnames, IP addresses and other values inside the events are NOT removed). ' +
          'The PDF renders these events in a Latin-1 font - characters outside that range may ' +
          'not display correctly; the accompanying .json file carries the exact text. '
        : 'It contains no raw log events. ') +
    'It was generated ' +
    'entirely in your browser; nothing was sent anywhere. Review before sharing outside your ' +
    'organisation. Intended recipient: Splunk support.';

/** The samples-absent form — the value every model without raw samples must
 *  carry (the consistency tests compare against this constant). */
export const DATA_BANNER = dataBanner(false);

/** §20.8a-4 — the EXACT samples-free banners of PRIOR builds. `looksLikeReportModel`
 *  pins the stored banner to `dataBanner(false)`; without this list, changing the
 *  banner's inventory sentence would silently make EVERY report stored by an
 *  earlier build fail the shape check — the Diagnostics page's saved-report
 *  re-download would return null for the whole existing history. Append-only. */
export const LEGACY_DATA_BANNERS: readonly string[] = [
    // Builds 310–319 (pre-§20: no saved-search-body class in the inventory).
    'This report contains data from your Splunk instance: search strings, index and host names, ' +
        'sourcetypes and SAP system identifiers, scheduled-search names and scheduler messages from ' +
        'apps on this instance, and any ingest-filter configuration supplied to the ' +
        'diagnostic by your administrator. ' +
        'It contains no raw log events. ' +
        'It was generated ' +
        'entirely in your browser; nothing was sent anywhere. Review before sharing outside your ' +
        'organisation. Intended recipient: Splunk support.',
];

/** Static §9 section — what a search head simply cannot see (design §7.9).
 *  Line [0] is the ingest-filter boundary that checks 27–29 (design §15)
 *  dissolve when the operator supplies the configuration — see
 *  `cannotCheckLines`. This constant stays as the facts-ABSENT form so
 *  existing pins keep meaning. */
export const CANNOT_CHECK_LINES: string[] = [
    'The Data TA’s ingest filters run on the Heavy Forwarder tier and cannot be read from this ' +
        'search head. If data is missing entirely, have a Splunk administrator check ' +
        'Settings -> Configuration in the Data TA (splunk_ta_sap_logserv) on the deployment server: ' +
        'an include/exclude rule or the days-in-past cutoff silently discards events before they are indexed.',
    'Whether the log source itself is emitting (SAP LogServ -> cloud storage -> queue) is owned by ' +
        'whoever operates the feed; the "last seen" timestamps in this report tell you WHEN it stopped ' +
        'arriving, not why.',
    'Forwarder-tier health (splunkd.log on the HFs, queue backlogs) needs an administrator: ' +
        'index=_internal is not readable from a standard user role.',
];

/**
 * §15.5 — the boundary lines with the operator-supplied swap. When usable
 * facts exist, line [0] is REPLACED by the supplied summary; when the facts
 * do NOT answer the boundary question the ask is KEPT and the (hedged)
 * summary is added alongside it. §19.8a-18: the "usable" notion is the
 * SHARED `factsUsableForBoundary` predicate — the same one that drives the
 * drawer's pointer — covering the defaults-shape (§15.8a-12: an HF's
 * endpoint reports those defaults regardless of the pushed config) AND a
 * parse that could not determine whether filtering is enabled (M7: dropping
 * the ask on that state left the reader with a summary that answers
 * nothing). A fully-unparsed paste keeps the plain static lines.
 */
export const cannotCheckLines = (facts?: IngestFacts | null): string[] => {
    if (!facts || facts.parseStatus === 'unparsed') return CANNOT_CHECK_LINES;
    const summary =
        `The Data TA’s ingest filters were supplied by ${facts.suppliedBy || 'an unknown user'} ` +
        `(see the “Ingest-tier filters (supplied by operator)” section): ${ingestFactsSummary(facts)} ` +
        'They are operator-supplied, not observed from this search head.';
    if (!factsUsableForBoundary(facts)) {
        return [CANNOT_CHECK_LINES[0], summary].concat(CANNOT_CHECK_LINES.slice(1));
    }
    return [summary].concat(CANNOT_CHECK_LINES.slice(1));
};

// ---------------------------------------------------------------------------
// Model types
// ---------------------------------------------------------------------------

export interface ReportKeyValue {
    label: string;
    value: string;
}
export interface ReportTable {
    columns: string[];
    rows: string[][];
    /** Column index that receives the remaining width and wraps. */
    wrapColumn?: number;
}
export type ReportBlock =
    | { kind: 'keyValues'; items: ReportKeyValue[] }
    | { kind: 'paragraphs'; text: string[] }
    | { kind: 'table'; table: ReportTable }
    | { kind: 'mono'; text: string };

export interface ReportSection {
    heading: string;
    blocks: ReportBlock[];
}

/** Assembled by the CALLER (a .tsx that can import buildFlags + splunk-utils);
 *  this module stays importable by the node build gate. */
export interface ReportMeta {
    appVersion: string;
    appBuild: string;
    appBuildDate: string;
    templatesOnly: boolean;
    username: string;
}

export interface DiagReportModel {
    title: string;
    scopeLine: string;
    reportId: string;
    generatedAtLocal: string;
    generatedAtUtc: string;
    banner: string;
    meta: ReportMeta;
    sections: ReportSection[];
    /** Machine-readable appendix (schema-tagged). Also rendered into the PDF. */
    json: Record<string, unknown>;
    filenameBase: string;
}

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

export const makeReportId = (): string =>
    `LSV-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;

const pad2 = (n: number): string => String(n).padStart(2, '0');

export const timestampParts = (
    d: Date,
): { local: string; utc: string; fileStamp: string } => ({
    local:
        `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ` +
        `${pad2(d.getHours())}:${pad2(d.getMinutes())} (local)`,
    utc: `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`,
    fileStamp:
        `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}-` +
        `${pad2(d.getHours())}${pad2(d.getMinutes())}`,
});

const CONFIDENCE_LABEL: Record<string, string> = {
    confirmed: 'Confirmed',
    likely: 'Likely',
    possible: 'Possible',
    expected: 'Working as intended',
    'not-evaluated': 'Not checked',
};
const OWNER_LABEL: Record<string, string> = {
    user: 'You can change this',
    'splunk-admin': 'Needs a Splunk administrator',
    ingest: 'Needs whoever sends the logs',
    vendor: 'A defect in this app',
    nobody: 'No action needed',
};
export const confidenceLabel = (c: string): string => CONFIDENCE_LABEL[c] || c;
export const ownerLabel = (o: string): string => OWNER_LABEL[o] || o;

const verdictRow = (v: Verdict): string[] => [
    confidenceLabel(v.confidence),
    v.id,
    v.headline + (v.detail ? ` ${v.detail}` : ''),
];

const notesTable = (notes: ProbeNote[]): ReportTable => ({
    columns: ['Status', 'Check', 'Detail'],
    rows: notes.map((n) => [
        n.status.toUpperCase(),
        n.check,
        n.detail + (typeof n.durationMs === 'number' ? ` (${n.durationMs} ms)` : ''),
    ]),
    wrapColumn: 2,
});

const fingerprintItems = (meta: ReportMeta, ev?: PanelEvidence | null): ReportKeyValue[] => {
    const items: ReportKeyValue[] = [
        { label: 'App', value: `Splunk for SAP LogServ ${meta.appVersion} (build ${meta.appBuild}, ${meta.appBuildDate})` },
        { label: 'Build variant', value: meta.templatesOnly ? 'templates-only' : 'full' },
        { label: 'Generated by', value: meta.username || '(unknown user)' },
    ];
    if (ev) {
        if (ev.macroIndexes && ev.macroIndexes.length > 0) {
            items.push({ label: 'Index (macro definition)', value: ev.macroIndexes.join(', ') });
        }
        if (ev.resolvedIndexes && ev.resolvedIndexes.length > 0) {
            items.push({ label: 'Index (matched in window)', value: ev.resolvedIndexes.join(', ') });
        }
        if (ev.canaryMs !== null) {
            items.push({ label: 'Search-head canary', value: `${ev.canaryMs} ms round-trip` });
        }
    }
    return items;
};

const cannotCheckSection = (facts?: IngestFacts | null): ReportSection => ({
    heading: 'What cannot be checked from here',
    blocks: [{ kind: 'paragraphs', text: cannotCheckLines(facts) }],
});

/** §15.5 — the operator-supplied facts section, rendered immediately BEFORE
 *  `cannotCheckSection()` in every report kind when facts exist. Uses only
 *  the generic block kinds, so the PDF renderer needs no changes. The
 *  scrubbed-paste excerpt is bounded (`fetchIngestFacts` truncates on read;
 *  §15.8a-23) and is absent entirely for a fully parsed paste (§15.8a-22). */
export const ingestFactsSection = (
    facts: IngestFacts,
    nowSec: number,
): ReportSection => {
    const items: ReportKeyValue[] = [
        { label: 'Recorded as supplied by', value: facts.suppliedBy || '(unknown user)' },
        {
            label: 'Supplied at',
            value:
                new Date(facts.suppliedAt * 1000).toISOString().slice(0, 16).replace('T', ' ') +
                ' UTC' +
                (factsAreStale(facts, nowSec) ? '  (more than 7 days old)' : ''),
        },
    ];
    if (facts.sourceHost) items.push({ label: 'Host in the paste', value: facts.sourceHost });
    items.push({ label: 'Parse result', value: `${facts.parseStatus} (${facts.inputShape})` });
    if (facts.parseNote) items.push({ label: 'Parser note', value: facts.parseNote });

    const rows: string[][] = [
        [
            'Filtering enabled',
            facts.filterEnabled === null ? 'unknown' : facts.filterEnabled ? 'yes' : 'no',
        ],
        ['Days in past', facts.daysInPast === null ? '—' : String(facts.daysInPast)],
        [
            'Ingest cutoff',
            facts.cutoffEpoch === null
                ? '—'
                : new Date(facts.cutoffEpoch * 1000).toISOString().slice(0, 16).replace('T', ' ') +
                  ' UTC',
        ],
        [
            'Include',
            isPassAllInclude(facts.includeFilters)
                ? 'all log types' +
                  (facts.includeFilters.length > 0 ? ` (${facts.includeFilters.join(', ')})` : '')
                : facts.includeFilters.join(', ') || '—',
        ],
        ['Exclude', facts.excludeFilters.join(', ') || '(none)'],
    ];
    // §19.8a-9 — the stamp row, only when known (never a fabricated "not set").
    const stampR = knownStamp(facts);
    if (stampR !== null) {
        rows.push(['Cloud-provider stamp', stampR === 'not_set' ? 'not set' : stampR]);
    }
    if (facts.filtersApproximate) {
        rows.push(['Fidelity', 'reconstructed from the generated filter — approximate']);
    }

    const blocks: ReportBlock[] = [
        { kind: 'keyValues', items },
        { kind: 'paragraphs', text: [ingestFactsSummary(facts)].concat(staleCaveatLine(facts, nowSec) || []) },
        { kind: 'table', table: { columns: ['Setting', 'Supplied value'], rows, wrapColumn: 1 } },
    ];
    const excerpt = scrubbedExcerpt(facts);
    if (excerpt) blocks.push({ kind: 'mono', text: excerpt });
    return { heading: 'Ingest-tier filters (supplied by operator)', blocks };
};

/** The JSON-twin projection of the facts (additive `json.ingestFacts`;
 *  no schema bump — §15.5). */
export const ingestFactsJson = (facts: IngestFacts | null | undefined): Record<string, unknown> | null =>
    facts
        ? {
              recordedAsSuppliedBy: facts.suppliedBy,
              suppliedAt: facts.suppliedAt,
              sourceHost: facts.sourceHost,
              inputShape: facts.inputShape,
              parseStatus: facts.parseStatus,
              parseNote: facts.parseNote,
              filterEnabled: facts.filterEnabled,
              daysInPast: facts.daysInPast,
              cutoffEpoch: facts.cutoffEpoch,
              includeFilters: facts.includeFilters,
              excludeFilters: facts.excludeFilters,
              filtersApproximate: facts.filtersApproximate,
              cloudProviderStamp: knownStamp(facts),
              defaultsShape: isDefaultsShape(facts),
              scrubbedExcerpt: scrubbedExcerpt(facts),
          }
        : null;

/** Exported (session 096) so diagPersistence can strip the appendix section
 *  before storage (it duplicates `model.json` byte-for-byte) and re-append an
 *  IDENTICAL one on fetch — single source for the heading + formatting. */
export const jsonAppendixSection = (json: Record<string, unknown>): ReportSection => ({
    heading: `Machine-readable appendix (${REPORT_SCHEMA})`,
    blocks: [{ kind: 'mono', text: JSON.stringify(json, null, 1) }],
});

// ---------------------------------------------------------------------------
// §20 — the rollup-populating saved-searches section (panel + dashboard)
// ---------------------------------------------------------------------------

/** §20.8a-7 — the not-executed / current-definition intro, pinned on all
 *  three surfaces (drawer technical detail, panel PDF, dashboard PDF). */
export const PRODUCER_SPL_INTRO =
    'This is each saved search’s definition as currently configured on this instance, read at ' +
    'diagnosis time (it includes any local/ override). It was NOT run by this diagnosis — it is ' +
    'shown as configuration. Rows already stored in the summary may have been produced by an ' +
    'earlier version of this search.';

/** §20.8a-2 — the as-shipped identity hedge, per aggregate, naming only ITS
 *  sibling stanza. Never asserts a runtime fact: the diagnostic did not read
 *  the backfill, and a local override could differ. */
export const backfillHedge = (backfill: string): string =>
    `As shipped, the backfill stanza ${backfill} carries the same search text as this ` +
    'aggregate; this diagnostic did not read it, so a local override could differ.';

/** §20.8a-8 — the explicit completeness line. null when every entry carries
 *  its SPL. */
export const producerSplCompleteness = (entries: readonly ProducerSplEntry[]): string | null => {
    const unreadable = entries.filter((e) => !e.spl).length;
    return unreadable > 0
        ? `${unreadable} of ${entries.length} populating searches could not be read — the list below is incomplete.`
        : null;
};

export const ROLLUP_SEARCHES_HEADING = 'Rollup-populating saved searches';

/** Session 113 — the producer definition, prepared for the drawer's
 *  interactive "Open in Search" action: the terminal `| outputlookup` WRITE
 *  is removed first. Opened verbatim, one Enter press in the Search app over
 *  a window that is not hour-aligned-and-complete would compute partial
 *  bucket rows and `append=true`-upsert them over correct summary rows
 *  (every `logserv_*` collection is `write: [*]`, so the write succeeds for
 *  any user). The drawer is a no-destructive-controls surface, so the write
 *  never reaches the URL. The clipboard copy is unaffected — it stays the
 *  verbatim definition, because a copy is inert.
 *
 *  Returns null when the write cannot be removed with certainty — an
 *  `outputlookup` that is not the terminal command, or one closing inside a
 *  subsearch (no shipped aggregate has either shape; the build gate proves
 *  the strip against every registry aggregate's shipped `search=`). The
 *  caller hides the button: fail closed, never hand out an armed search. */
export const producerSplForOpenInSearch = (spl: string): string | null => {
    const trimmed = (spl || '').trim();
    if (trimmed === '') return null;
    // Terminal clause only: nothing but the write's own args (never a `|`,
    // never a subsearch-closing `]`) may follow the last `| outputlookup`.
    const stripped = trimmed.replace(/\|\s*outputlookup\b[^|\]]*$/i, '').trim();
    if (stripped === '' || /\boutputlookup\b/i.test(stripped)) return null;
    return stripped;
};

/** The shared §20 section builder (panel + dashboard forms are identical —
 *  only the entry list differs). Cadence renders VERBATIM from the fetched
 *  cron (§20.8a-6: no hourly/daily adjective anywhere in this builder). */
export const rollupSearchesSection = (entries: readonly ProducerSplEntry[]): ReportSection => {
    const completeness = producerSplCompleteness(entries);
    const blocks: ReportBlock[] = [
        {
            kind: 'paragraphs',
            text: [PRODUCER_SPL_INTRO].concat(completeness ? [completeness] : []),
        },
    ];
    entries.forEach((e) => {
        const items: ReportKeyValue[] = [{ label: 'Saved search', value: e.name }];
        items.push(
            e.collection
                ? { label: 'Currently configured to populate', value: e.collection }
                : {
                      label: 'Registered for',
                      value: `this rollup (populates one of: ${e.rollupCollections.join(', ')})`,
                  },
        );
        if (e.cron) items.push({ label: 'Schedule (cron)', value: e.cron });
        if (e.updated) items.push({ label: 'Definition last modified', value: e.updated });
        blocks.push({ kind: 'keyValues', items });
        if (e.spl) {
            blocks.push({ kind: 'mono', text: e.spl });
            if (e.backfill) {
                blocks.push({ kind: 'paragraphs', text: [backfillHedge(e.backfill)] });
            }
        } else {
            blocks.push({ kind: 'paragraphs', text: [`Could not be read — ${e.error}`] });
        }
    });
    return { heading: ROLLUP_SEARCHES_HEADING, blocks };
};

/** The json-twin projection — each entry once (§20.8a-5: exactly one json
 *  copy; the section mono is the other). */
export const rollupSearchesJson = (
    entries: readonly ProducerSplEntry[] | null | undefined,
): ProducerSplEntry[] | null =>
    Array.isArray(entries) && entries.length > 0 ? entries.slice() : null;

// ---------------------------------------------------------------------------
// PANEL report
// ---------------------------------------------------------------------------

/** SS16.6/SS7.10 — the opt-in raw sample set the DRAWER collects at download
 *  time (already redacted + truncated in `collectRawSamples`). Declared in
 *  diagEvidence (this module imports it) to avoid a cycle; re-exported for
 *  the renderer/persistence side. A REQUESTED-but-failed collection still
 *  produces a section carrying the reason (SS16.8a-27). */
export type { RawSampleSet } from './diagEvidence';

export interface PanelReportInput {
    panelTitle: string;
    dashboardLabel: string;
    facts: PanelFacts;
    probe: SplProbe;
    diag: Diagnosis;
    evidence: PanelEvidence;
    meta: ReportMeta;
    /** Present ONLY when the person generating the report ticked the opt-in
     *  checkbox. Sample-bearing models are never persisted (SS16.8a-25). */
    rawSamples?: RawSampleSet | null;
    now?: Date;
}

export const buildPanelReportModel = (input: PanelReportInput): DiagReportModel => {
    const now = input.now || new Date();
    const ts = timestampParts(now);
    const reportId = makeReportId();
    const { diag, evidence, facts, probe } = input;

    const others = diag.all.filter((v) => v !== diag.top);

    const verdictItems: ReportKeyValue[] = [
        { label: 'Finding', value: diag.top.headline },
        { label: 'Confidence', value: confidenceLabel(diag.top.confidence) },
        { label: 'Who fixes it', value: ownerLabel(diag.top.owner) },
    ];
    if (diag.top.detail) verdictItems.push({ label: 'Detail', value: diag.top.detail });
    const verdictBlocks: ReportBlock[] = [{ kind: 'keyValues', items: verdictItems }];
    if (diag.incomplete) {
        verdictBlocks.push({
            kind: 'paragraphs',
            text: [
                'Some checks did not run — the evidence table below says which, and why. ' +
                    'The verdict above may be under-informed.',
            ],
        });
    }

    const sections: ReportSection[] = [
        { heading: 'Verdict', blocks: verdictBlocks },
        {
            heading: 'The panel',
            blocks: [
                {
                    kind: 'keyValues',
                    items: [
                        { label: 'Dashboard', value: input.dashboardLabel || '(unknown)' },
                        { label: 'Panel', value: input.panelTitle || '(untitled)' },
                        { label: 'What it reads', value: describeSearch(probe, facts.spl) },
                        { label: 'Window', value: `${facts.earliest} -> ${facts.latest}` },
                        {
                            label: 'Rows returned',
                            value: facts.rowCount === null ? '(none arrived)' : String(facts.rowCount),
                        },
                    ].concat(
                        facts.errorMessage
                            ? [{ label: 'Search error', value: facts.errorMessage }]
                            : [],
                    ),
                },
                { kind: 'mono', text: facts.spl },
            ],
        },
    ];

    /* §20.2 — what populates what the panel reads, right after 'The panel'
     * (whose mono is the DISPATCHED SPL; the §20 intro states this one was
     * NOT run). Absent for non-rollup panels and when nothing was captured
     * (Array.isArray guard — older fixtures leave the field undefined). */
    const producerEntries = Array.isArray(evidence.producerSpl) ? evidence.producerSpl : [];
    if (producerEntries.length > 0) {
        sections.push(rollupSearchesSection(producerEntries));
    }

    sections.push({
        heading: 'Checks and evidence',
        blocks: [{ kind: 'table', table: notesTable(evidence.notes) }],
    });

    if (others.length > 0) {
        sections.push({
            heading: 'All findings',
            blocks: [
                {
                    kind: 'table',
                    table: {
                        columns: ['Confidence', 'Check', 'Finding'],
                        rows: others.map(verdictRow),
                        wrapColumn: 2,
                    },
                },
            ],
        });
    }

    sections.push({
        heading: 'Environment fingerprint',
        blocks: [{ kind: 'keyValues', items: fingerprintItems(input.meta, evidence) }],
    });
    // §15.8a-28 single-source rule: the panel report derives the operator
    // facts from the evidence it already embeds — no separate input.
    const panelFacts = (evidence as { ingestFacts?: IngestFacts | null }).ingestFacts || null;
    if (panelFacts) sections.push(ingestFactsSection(panelFacts, Math.floor(now.getTime() / 1000)));

    /* SS16.6 — the opt-in raw samples, AFTER ingest facts and BEFORE
     * cannot-check (the appendix stays last). A requested-but-failed
     * collection still renders, carrying the reason (SS16.8a-27). */
    const samples = input.rawSamples || null;
    if (samples) {
        const blocks: ReportBlock[] = [
            {
                kind: 'paragraphs',
                text: [
                    'This section contains customer log content, explicitly enabled by the person ' +
                        'who generated this report. Credential patterns and email addresses are ' +
                        'redacted; hostnames, IP addresses and other values are NOT removed. Each ' +
                        'event is included in full, up to a ' +
                        `${formatCount(RAW_SAMPLE_EVENT_MAX_CHARS)}-character safety ceiling ` +
                        '(disclosed on the event if reached). The PDF renders these events in a ' +
                        'Latin-1 font - characters outside that range may not display correctly; ' +
                        'the accompanying .json file carries the exact text.',
                    samples.error
                        ? `Samples were requested, but could not be collected - ${samples.error}`
                        : `These are recent events of the sourcetype(s) this view reads, taken from the ` +
                          `index WITHOUT this panel's own filters` +
                          (samples.excludedFilters.length > 0
                              ? ` (not applied: ${samples.excludedFilters.join(', ')})`
                              : '') +
                          ` - they show what the raw data looks like, not what this panel would have matched.` +
                          (samples.fromWindow
                              ? ''
                              : ' The selected window has none, so these are the most recent events on record.'),
                ],
            },
        ];
        samples.events.forEach((e: RawSampleSet['events'][number]) => {
            blocks.push({
                kind: 'mono',
                text: `${e.time} · ${e.sourcetype} · ${e.host}\n${e.raw}`,
            });
        });
        sections.push({ heading: 'Raw event samples (opt-in)', blocks });
    }

    sections.push(cannotCheckSection(panelFacts));

    const json: Record<string, unknown> = {
        schema: REPORT_SCHEMA,
        kind: 'panel',
        ingestFacts: ingestFactsJson(panelFacts),
        rawSamples: samples,
        /* §20.8a-5 — the ONE canonical json copy of the producer SPL… */
        rollupSearches: rollupSearchesJson(producerEntries),
        reportId,
        generatedAtUtc: ts.utc,
        meta: input.meta,
        dashboard: input.dashboardLabel,
        panel: input.panelTitle,
        facts,
        diagnosis: diag,
        /* …and the evidence copy STRIPPED of it, so a stored model carries the
         * SPL exactly twice (section mono + json.rollupSearches) — the gate
         * pins the count. JSON.stringify drops the undefined key. */
        evidence: { ...evidence, producerSpl: undefined },
    };
    sections.push(jsonAppendixSection(json));

    return {
        title: REPORT_TITLE,
        scopeLine: `Panel diagnosis — ${input.panelTitle || '(untitled)'} · ${input.dashboardLabel}`,
        reportId,
        generatedAtLocal: ts.local,
        generatedAtUtc: ts.utc,
        /* SS16.8a-26 — DERIVED from the same object that carries the samples,
         * so banner and contents cannot disagree. */
        banner: dataBanner(json.rawSamples != null),
        meta: input.meta,
        sections,
        json,
        filenameBase: `logserv-diagnostic-panel-${slugify(input.dashboardLabel)}-${ts.fileStamp}`,
    };
};

// ---------------------------------------------------------------------------
// DASHBOARD report
// ---------------------------------------------------------------------------

export interface DashboardReportInput {
    dashboardLabel: string;
    sweep: SweepResult;
    meta: ReportMeta;
    /** §15.8a-28 — the dashboard report is the ONE builder that takes the
     *  operator facts explicitly (a sweep over a healthy dashboard diagnoses
     *  zero panels, so there may be no evidence object to derive them from).
     *  The caller fetches the row once at sweep start via `runner.kv(...)`. */
    ingestFacts?: IngestFacts | null;
    /** §20.3/§20.8a-5 — the whole dashboard's rollup-populating searches,
     *  collected by `collectDashboardRollupSpl` ALONGSIDE the sweep (never on
     *  `SweepResult`, which `json.sweep` serialises wholesale — the SPL must
     *  appear exactly twice in a stored model). Covers healthy panels too: a
     *  sweep over a healthy dashboard diagnoses zero panels but its rollup
     *  surface is still the point of this section. */
    rollupSearches?: ProducerSplEntry[] | null;
    now?: Date;
}

const CLASSIFICATION_LABEL: Record<string, string> = {
    ok: 'Has data',
    empty: 'Empty',
    error: 'Search failed',
    loading: 'Still loading',
    'not-dispatched': 'Not run (waiting on a selection)',
    'no-query': 'No query',
};

export const buildDashboardReportModel = (input: DashboardReportInput): DiagReportModel => {
    const now = input.now || new Date();
    const ts = timestampParts(now);
    const reportId = makeReportId();
    const { entries } = input.sweep;

    const count = (c: string): number => entries.filter((e) => e.classification === c).length;

    const summaryRows: string[][] = entries.map((e, i) => [
        String(i + 1),
        e.descriptor,
        CLASSIFICATION_LABEL[e.classification] || e.classification,
        e.diag
            ? e.diag.top.headline
            : e.freeVerdict
              ? e.freeVerdict.headline
              : e.classification === 'ok'
                ? `${e.rowCount === null ? '' : e.rowCount} row(s)`
                : '',
    ]);

    const sections: ReportSection[] = [
        {
            heading: 'Summary',
            blocks: [
                {
                    kind: 'keyValues',
                    items: [
                        { label: 'Dashboard', value: input.dashboardLabel },
                        { label: 'Searches registered', value: String(entries.length) },
                        {
                            label: 'Outcome',
                            value:
                                `${count('ok')} with data · ${count('empty')} empty · ` +
                                `${count('error')} failed · ${count('not-dispatched') + count('no-query')} not run · ` +
                                `${count('loading')} still loading`,
                        },
                        {
                            label: 'Diagnosed in depth',
                            value: String(input.sweep.diagnosedCount),
                        },
                    ].concat(
                        input.sweep.budgetExhausted
                            ? [
                                  {
                                      label: 'Note',
                                      value:
                                          'The time budget ran out before every empty panel was diagnosed — ' +
                                          'undiagnosed panels are marked in the table.',
                                  },
                              ]
                            : [],
                    ),
                },
                {
                    kind: 'table',
                    table: {
                        columns: ['#', 'Search', 'Outcome', 'Finding'],
                        rows: summaryRows,
                        wrapColumn: 3,
                    },
                },
            ],
        },
    ];

    // One section per deep-diagnosed panel — verdict, checks, verbatim SPL.
    entries.forEach((e, i) => {
        if (!e.diag || !e.evidence) return;
        sections.push({
            heading: `#${i + 1} — ${e.descriptor}`,
            blocks: [
                {
                    kind: 'keyValues',
                    items: [
                        { label: 'Finding', value: e.diag.top.headline },
                        { label: 'Confidence', value: confidenceLabel(e.diag.top.confidence) },
                        { label: 'Who fixes it', value: ownerLabel(e.diag.top.owner) },
                        { label: 'Window', value: `${e.earliest} -> ${e.latest}` },
                    ].concat(
                        e.diag.top.detail ? [{ label: 'Detail', value: e.diag.top.detail }] : [],
                    ),
                },
                { kind: 'table', table: notesTable(e.evidence.notes) },
                { kind: 'mono', text: e.spl },
            ],
        });
    });

    /* §20.3 — ONE deduplicated section for the whole dashboard's rollup
     * surface, after the per-panel sections and before the fingerprint.
     * Array.isArray guard: existing callers/fixtures omit the field. */
    const dashProducerEntries = Array.isArray(input.rollupSearches) ? input.rollupSearches : [];
    if (dashProducerEntries.length > 0) {
        sections.push(rollupSearchesSection(dashProducerEntries));
    }

    sections.push({
        heading: 'Environment fingerprint',
        blocks: [{ kind: 'keyValues', items: fingerprintItems(input.meta) }],
    });
    const dashFacts = input.ingestFacts || null;
    if (dashFacts) sections.push(ingestFactsSection(dashFacts, Math.floor(now.getTime() / 1000)));
    sections.push(cannotCheckSection(dashFacts));

    const json: Record<string, unknown> = {
        schema: REPORT_SCHEMA,
        kind: 'dashboard',
        ingestFacts: ingestFactsJson(dashFacts),
        rawSamples: null,
        /* §20.8a-5 — the one canonical json copy; `json.sweep` stays clean
         * because `rollupSearches` never lands on `SweepResult` and sweep
         * evidence is never deep-gathered (no `producerSpl`). */
        rollupSearches: rollupSearchesJson(dashProducerEntries),
        reportId,
        generatedAtUtc: ts.utc,
        meta: input.meta,
        dashboard: input.dashboardLabel,
        sweep: input.sweep,
    };
    sections.push(jsonAppendixSection(json));

    return {
        title: REPORT_TITLE,
        scopeLine: `Dashboard diagnosis — ${input.dashboardLabel}`,
        reportId,
        generatedAtLocal: ts.local,
        generatedAtUtc: ts.utc,
        banner: dataBanner(json.rawSamples != null),
        meta: input.meta,
        sections,
        json,
        filenameBase: `logserv-diagnostic-${slugify(input.dashboardLabel)}-${ts.fileStamp}`,
    };
};

// ---------------------------------------------------------------------------
// ENVIRONMENT report
// ---------------------------------------------------------------------------

export interface EnvironmentReportInput {
    env: EnvironmentEvidence;
    windowLabel: string;
    meta: ReportMeta;
    now?: Date;
}

const fmtEpoch = (n: number | null): string =>
    n === null ? '—' : `${new Date(n * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC`;

const ROLLUP_STATUS_LABEL: Record<string, string> = {
    ok: 'OK',
    stale: 'STALE',
    empty: 'NEVER BUILT',
    'not-checked': 'NOT CHECKED',
};

/* ------------------------------------------------------------------------- */
/* SS16 — the platform-health and data-coverage section builders (build 315). */
/* ------------------------------------------------------------------------- */

const num = (v: number | null): string => (v === null ? '-' : v.toLocaleString());
const rt = (v: number | null): string => (v === null ? '-' : `${Math.round(v * 10) / 10}s`);

const nonSentinel = (p: PlatformSnapshot, metric: string) =>
    p.rows.filter((r) => r.metric === metric && r.scope !== '(all)');

/** SS16.4 — the Platform-health blocks. THE RULE (SS3.2(a)/SS16.8a-17): a
 *  stale/empty/unchecked snapshot renders ONE honest NOT-AVAILABLE line with
 *  the VERIFIED reason and NO derived numbers — never "healthy". Everything
 *  here is SS12.6 context: never a cause, never ranked, never alarm-styled. */
const platformSectionBlocks = (env: EnvironmentEvidence): ReportBlock[] => {
    const out: ReportBlock[] = [];
    if (env.ownJobs) {
        out.push({
            kind: 'paragraphs',
            text: [
                `Search-job artifacts visible to you: ${env.ownJobs.returned}` +
                    `${env.ownJobs.capped ? '+ (listing capped)' : ''}, of which ` +
                    `${env.ownJobs.queued} queued and ${env.ownJobs.running} running. This includes ` +
                    `this diagnostic's own probes and the panels of the page it ran from, and admin ` +
                    `roles see every user's jobs - context, not a cause.`,
            ],
        });
    }
    /* SS14.8a undefined-safe rule: older fixtures carry no `platform` at
     * all - degrade to NOT-CHECKED, never throw. */
    const p: PlatformSnapshot = env.platform || NOT_CHECKED_SNAPSHOT;
    if (p.status !== 'live') {
        let why: string;
        if (p.status === 'not-checked') why = 'it could not be read';
        else if (p.status === 'empty') {
            why =
                env.platformProducerDisabled === true
                    ? `the hourly ${SNAPSHOT_AGGREGATE} search is DISABLED - a Splunk administrator re-enables it`
                    : env.platformProducerHasRun === false
                      ? `the hourly ${SNAPSHOT_AGGREGATE} search has not run yet (it runs at two minutes past each hour)`
                      : env.platformProducerHasRun === true
                        ? `the hourly ${SNAPSHOT_AGGREGATE} search has run but written nothing - most often because ` +
                          `index=_internal is not searchable for nobody-owned scheduled searches on this instance`
                        : `the snapshot collection is empty and the producer's state could not be read`;
        } else {
            why =
                `its newest snapshot is ${p.ageSeconds !== null ? Math.round(p.ageSeconds / 3600) : '?'} hour(s) old (stale). ` +
                `A stale snapshot is itself scheduler evidence: only ${p.bucketsPresent} of the last ` +
                `${p.bucketsExpected} hourly snapshots are present, so the snapshot search is being skipped, ` +
                `deferred or failing - a scheduler symptom in its own right`;
        }
        out.push({
            kind: 'paragraphs',
            text: [
                `Platform snapshot NOT AVAILABLE - ${why}. Scheduler, concurrency, throughput and ` +
                    `queue figures are therefore omitted rather than guessed.`,
            ],
        });
        return out;
    }
    out.push({
        kind: 'paragraphs',
        text: [
            `Platform snapshot: live (newest hourly bucket ` +
                `${p.ageSeconds !== null ? Math.round(p.ageSeconds / 60) : '?'} min old); ` +
                `${p.bucketsPresent} of the last ${p.bucketsExpected} hourly snapshots present` +
                (p.truncated
                    ? '; the 24h read was TRUNCATED at its row limit, so the tables below cover a partial window'
                    : '') +
                (p.futureDropped > 0
                    ? `; ${p.futureDropped} future-dated row(s) ignored (relative to this browser's clock)`
                    : '') +
                `. All figures below are context, never a cause; the scheduler tables include this app's ` +
                `own hourly summarisation jobs (scheduled between :02 and :28 past each hour).`,
        ],
    });
    const missing = ['sched', 'sched_top', 'sched_skip', 'quota', 'thruput', 'queues', 'pcre'].filter(
        (m) => p.metricsCollected.indexOf(m) === -1,
    );
    if (missing.length > 0) {
        out.push({
            kind: 'paragraphs',
            text: [
                `Not collected in the newest snapshot hour (no completion sentinel): ${missing.join(', ')} - ` +
                    `those figures are absent, not zero.`,
            ],
        });
    }
    const sched = nonSentinel(p, 'sched').slice(0, 20);
    if (sched.length > 0) {
        out.push({
            kind: 'table',
            table: {
                columns: ['App', 'Outcome', 'Runs (24h)', 'Total runtime'],
                rows: sched
                    .slice()
                    .sort((a, b) => (b.n ?? 0) - (a.n ?? 0))
                    .map((r) => [r.scope, r.scope2, num(r.n), rt(r.sumRt)]),
                wrapColumn: 0,
            },
        });
    }
    const top = nonSentinel(p, 'sched_top')
        .slice()
        .sort((a, b) => (b.sumRt ?? 0) - (a.sumRt ?? 0))
        .slice(0, 20);
    if (top.length > 0) {
        out.push({
            kind: 'paragraphs',
            text: ['Top scheduled searches by total runtime (24h, top 20 per hour summed):'],
        });
        out.push({
            kind: 'table',
            table: {
                columns: ['Search', 'App', 'Runs', 'Total', 'Max'],
                rows: top.map((r) => [r.scope, r.scope2, num(r.n), rt(r.sumRt), rt(r.maxRt)]),
                wrapColumn: 0,
            },
        });
    }
    if (p.skips.length > 0) {
        out.push({
            kind: 'table',
            table: {
                columns: ['Skipped/deferred search', 'App', 'Status', 'Times', 'Reason'],
                rows: p.skips
                    .slice()
                    .sort((a, b) => b.n - a.n)
                    .slice(0, 20)
                    .map((s) => [s.search, s.app, s.status, String(s.n), s.reason]),
                wrapColumn: 4,
            },
        });
    } else {
        out.push({
            kind: 'paragraphs',
            text: ['No scheduler skips or deferrals recorded in the snapshot window.'],
        });
    }
    const quota = nonSentinel(p, 'quota');
    const quotaTotal = quota.reduce((a, r) => a + (r.n ?? 0), 0);
    out.push({
        kind: 'paragraphs',
        text: [
            quotaTotal > 0
                ? `Search-concurrency warnings (24h): ${quotaTotal.toLocaleString()}. Latest: ` +
                  `"${quota.map((r) => r.detail).filter((d) => d)[0] || '(no message stored)'}"`
                : 'No search-concurrency warnings recorded in the snapshot window.',
        ],
    });
    const thr = nonSentinel(p, 'thruput');
    if (thr.length > 0) {
        const hosts: string[] = [];
        thr.forEach((r) => {
            if (hosts.indexOf(r.scope) === -1) hosts.push(r.scope);
        });
        out.push({
            kind: 'paragraphs',
            text: [
                `Per-index throughput covers the ${hosts.length} host(s) that forward their internal ` +
                    `logs to this search head (${hosts.join(', ')}); a host's absence here is a ` +
                    `forwarding configuration, not an ingest fault.`,
            ],
        });
        out.push({
            kind: 'table',
            table: {
                columns: ['Host', 'Index', 'KB (24h)', 'Events (24h)'],
                rows: thr
                    .slice()
                    .sort((a, b) => (b.kb ?? 0) - (a.kb ?? 0))
                    .slice(0, 20)
                    .map((r) => [r.scope, r.scope2, num(r.kb === null ? null : Math.round(r.kb)), num(r.ev)]),
                wrapColumn: 1,
            },
        });
    }
    const q = nonSentinel(p, 'queues');
    if (q.length > 0) {
        out.push({
            kind: 'paragraphs',
            text: [
                'Pipeline queue depth is a SAMPLED GAUGE. The nullQueue row does NOT measure how many ' +
                    'events the ingest filters dropped - filtered events pass through it without ' +
                    'accumulating, so its depth is ~0 whether or not events are being discarded. The ' +
                    'operator-supplied ingest-filter configuration (above) is the drop evidence.',
            ],
        });
        out.push({
            kind: 'table',
            table: {
                columns: ['Host', 'Queue', 'Max depth (24h)', 'Max KB', 'Capacity KB'],
                rows: q
                    .slice()
                    .sort((a, b) => (b.kb ?? 0) - (a.kb ?? 0))
                    .slice(0, 20)
                    .map((r) => [r.scope, r.scope2, num(r.n), num(r.kb), num(r.ev)]),
                wrapColumn: 1,
            },
        });
    }
    const pcre = nonSentinel(p, 'pcre').reduce((a, r) => a + (r.n ?? 0), 0);
    out.push({
        kind: 'paragraphs',
        text: [
            pcre > 0
                ? `PCRE limit events (24h): ${pcre.toLocaleString()} - regex extraction is being cut short on this instance.`
                : 'No PCRE limit events recorded in the snapshot window.',
        ],
    });
    return out;
};

/** SS16.5 — the Data-coverage blocks (SS7.6): ASCII daily series (source-
 *  capped), clz distribution WITH its denominator (SS16.8a-22), host counts. */
const coverageSectionBlocks = (env: EnvironmentEvidence): ReportBlock[] => {
    const out: ReportBlock[] = [];
    if (env.dailyCounts) {
        out.push({
            kind: 'paragraphs',
            text: [
                `Daily event volume (${env.dailyCounts.length} day(s)` +
                    (env.dailyCounts.length >= DAILY_SERIES_MAX_ROWS
                        ? ` - showing the most recent ${DAILY_SERIES_MAX_ROWS}`
                        : '') +
                    '):',
            ],
        });
        out.push({ kind: 'mono', text: buildAsciiBarChart(env.dailyCounts) });
    }
    if (env.clzCounts) {
        const covered = env.clzCounts.reduce((a, r) => a + r.count, 0);
        const total = env.indexCounts
            ? Object.keys(env.indexCounts).reduce(
                  (a, k) => a + (env.indexCounts as Record<string, number>)[k],
                  0,
              )
            : null;
        const semantics =
            total === null
                ? ''
                : covered === 0 && total > 0
                  ? ' The index-time routing metadata is not present on these events at all. Events ' +
                    'loaded outside the Data TA pipeline (HEC, direct oneshot) legitimately lack it; if ' +
                    'ALL ingest flows through the Data TA, cross-reference the routing findings.'
                  : total > 0 && covered < total * 0.9
                    ? ' Events without the fields predate the Data TA or arrive through a path that does not apply it.'
                    : ' Normal - the ingest pipeline is stamping the routing metadata.';
        out.push({
            kind: 'paragraphs',
            text: [
                `clz_dir/clz_subdir present on ${covered.toLocaleString()}` +
                    (total !== null ? ` of ${total.toLocaleString()}` : '') +
                    ` events in this window.${semantics}`,
            ],
        });
        if (env.clzCounts.length > 0) {
            out.push({
                kind: 'table',
                table: {
                    columns: ['clz_dir', 'clz_subdir', 'Events'],
                    rows: env.clzCounts.map((r) => [r.dir, r.sub, r.count.toLocaleString()]),
                    wrapColumn: 1,
                },
            });
        }
    }
    if (env.hostCounts) {
        const names = Object.keys(env.hostCounts);
        out.push({
            kind: 'paragraphs',
            text: [
                (env.hostTotal !== null ? `${env.hostTotal.toLocaleString()} distinct host(s) in the window; ` : '') +
                    `showing the top ${names.length} by event count:`,
            ],
        });
        out.push({
            kind: 'table',
            table: {
                columns: ['Host', 'Events in window'],
                rows: names
                    .slice()
                    .sort(
                        (a, b) =>
                            (env.hostCounts as Record<string, number>)[b] -
                            (env.hostCounts as Record<string, number>)[a],
                    )
                    .map((h) => [h, (env.hostCounts as Record<string, number>)[h].toLocaleString()]),
                wrapColumn: 0,
            },
        });
    }
    return out;
};

/** Bounded machine-readable twins (SS16.8a-23): summaries only, never the raw
 *  row arrays, and the embedded `environment` object is STRIPPED of the bulk
 *  fields so nothing lands in the appendix twice. */
const platformJson = (env: EnvironmentEvidence): Record<string, unknown> => {
    const p: PlatformSnapshot = env.platform || NOT_CHECKED_SNAPSHOT;
    return {
        status: p.status,
        ageSeconds: p.ageSeconds,
        newestBucket: p.newestBucket,
        bucketsPresent: p.bucketsPresent,
        bucketsExpected: p.bucketsExpected,
        truncated: p.truncated,
        futureDropped: p.futureDropped,
        metricsCollected: p.metricsCollected,
        producerDisabled: env.platformProducerDisabled,
        producerHasRun: env.platformProducerHasRun,
        ownJobs: env.ownJobs,
        skips: p.skips.slice(0, 50),
        quotaTotal: nonSentinel(p, 'quota').reduce((a, r) => a + (r.n ?? 0), 0),
        pcreTotal: nonSentinel(p, 'pcre').reduce((a, r) => a + (r.n ?? 0), 0),
    };
};

const coverageJson = (env: EnvironmentEvidence): Record<string, unknown> => ({
    daily: env.dailyCounts ? env.dailyCounts.slice(-DAILY_SERIES_MAX_ROWS) : null,
    clz: env.clzCounts ? env.clzCounts.slice(0, 30) : null,
    hosts: env.hostCounts,
    hostTotal: env.hostTotal,
});

/** The embedded environment object minus the bulk fields `json.platform` /
 *  `json.coverage` already carry — the appendix must never hold them twice
 *  (SS16.8a-23: the 60k mono cap and the 200k storage cap both bite). */
const envForJson = (env: EnvironmentEvidence): Record<string, unknown> => {
    const out: Record<string, unknown> = { ...(env as unknown as Record<string, unknown>) };
    delete out.platform;
    delete out.dailyCounts;
    delete out.clzCounts;
    delete out.hostCounts;
    return out;
};

export const buildEnvironmentReportModel = (input: EnvironmentReportInput): DiagReportModel => {
    const now = input.now || new Date();
    const ts = timestampParts(now);
    const reportId = makeReportId();
    const { env } = input;

    const rollupCount = (s: RollupHealthRow['status']): number =>
        env.rollups.filter((r) => r.status === s).length;

    const indexEvents = env.indexCounts
        ? Object.keys(env.indexCounts).reduce((a, k) => a + (env.indexCounts as Record<string, number>)[k], 0)
        : null;

    const stPresent = env.sourcetypeWindowCounts
        ? Object.keys(env.sourcetypeWindowCounts).length
        : null;
    const stKnown = env.sourcetypeLastSeen ? Object.keys(env.sourcetypeLastSeen).length : null;

    const sections: ReportSection[] = [
        {
            heading: 'Summary',
            blocks: [
                {
                    kind: 'keyValues',
                    items: [
                        { label: 'Window', value: input.windowLabel },
                        {
                            label: 'Events in window',
                            value: indexEvents === null ? 'not checked' : indexEvents.toLocaleString(),
                        },
                        {
                            label: 'Sourcetypes',
                            value:
                                stPresent === null || stKnown === null
                                    ? 'not checked'
                                    : `${stPresent} with events in the window · ${stKnown} known all-time`,
                        },
                        {
                            label: 'Summarised data',
                            value:
                                `${rollupCount('ok')} collections current · ${rollupCount('stale')} stale · ` +
                                `${rollupCount('empty')} never built · ${rollupCount('not-checked')} not checked`,
                        },
                    ],
                },
            ],
        },
        {
            heading: 'Platform',
            blocks: [
                {
                    kind: 'keyValues',
                    items: ([] as ReportKeyValue[])
                        .concat(
                            env.canaryMs !== null
                                ? [{ label: 'Search-head canary', value: `${env.canaryMs} ms round-trip` }]
                                : [{ label: 'Search-head canary', value: 'not checked' }],
                        )
                        .concat(
                            env.serverVersion
                                ? [{ label: 'Splunk', value: `${env.serverVersion} on ${env.serverName || '(unknown host)'}` }]
                                : [],
                        )
                        .concat(
                            env.serverTimeLabel
                                ? [{ label: 'Search-head time', value: env.serverTimeLabel }]
                                : [],
                        )
                        .concat(
                            env.appsPresent
                                ? [
                                      {
                                          label: 'Companion apps',
                                          /* §14.3b — driven by the registry so the Data
                                           * TA's tier note reaches the support artifact,
                                           * not just the page. */
                                          value: COMPANION_APPS.filter((a) =>
                                              Object.prototype.hasOwnProperty.call(
                                                  env.appsPresent as Record<string, boolean>,
                                                  a.id,
                                              ),
                                          )
                                              .map(
                                                  (a) =>
                                                      `${a.id}: ${(env.appsPresent as Record<string, boolean>)[a.id] ? 'present' : 'absent'}${a.note ? ` (${a.note})` : ''}`,
                                              )
                                              .join(' · '),
                                      },
                                  ]
                                : [],
                        ),
                } as ReportBlock,
            ].concat(platformSectionBlocks(env)),
        },
        {
            heading: 'Index',
            blocks: [
                {
                    kind: 'keyValues',
                    items: ([] as ReportKeyValue[])
                        .concat(
                            env.macroIndexes
                                ? [{ label: 'Index (macro definition)', value: env.macroIndexes.join(', ') || '(none)' }]
                                : [{ label: 'Index (macro definition)', value: 'not checked' }],
                        )
                        .concat(
                            env.indexCounts
                                ? Object.keys(env.indexCounts).map((k) => ({
                                      label: k,
                                      value: `${(env.indexCounts as Record<string, number>)[k].toLocaleString()} events in window`,
                                  }))
                                : [],
                        )
                        .concat(
                            env.visibleIndexCount !== null
                                ? [{ label: 'Indexes visible to this role', value: String(env.visibleIndexCount) }]
                                : [],
                        ),
                },
            ],
        },
    ];

    /* SS16.5 — Data coverage sits between Index and Sourcetypes (SS7.6). */
    const cov = coverageSectionBlocks(env);
    if (cov.length > 0) {
        sections.push({ heading: 'Data coverage', blocks: cov });
    }

    if (env.sourcetypeWindowCounts || env.sourcetypeLastSeen) {
        const names: string[] = [];
        const push = (n: string): void => {
            if (names.indexOf(n) === -1) names.push(n);
        };
        if (env.sourcetypeLastSeen) Object.keys(env.sourcetypeLastSeen).forEach(push);
        if (env.sourcetypeWindowCounts) Object.keys(env.sourcetypeWindowCounts).forEach(push);
        names.sort();
        sections.push({
            heading: 'Sourcetypes',
            blocks: [
                {
                    kind: 'table',
                    table: {
                        columns: ['Sourcetype', 'Events in window', 'Last seen (all time)'],
                        rows: names.map((n) => [
                            n,
                            env.sourcetypeWindowCounts &&
                            Object.prototype.hasOwnProperty.call(env.sourcetypeWindowCounts, n)
                                ? (env.sourcetypeWindowCounts as Record<string, number>)[n].toLocaleString()
                                : '0',
                            env.sourcetypeLastSeen &&
                            Object.prototype.hasOwnProperty.call(env.sourcetypeLastSeen, n)
                                ? fmtEpoch((env.sourcetypeLastSeen as Record<string, number>)[n])
                                : '—',
                        ]),
                        wrapColumn: 0,
                    },
                },
            ],
        });
    }

    // §17.6 check 18 — a bucket-continuity column, present only when the report
    // path gathered it. CONTEXT, never a verdict (a missing bucket is
    // indistinguishable from a quiet hour); cross-references the scheduler.
    const hasContinuity = env.rollups.some((r) => r.bucketContinuity !== null);
    const rollupColumns = hasContinuity
        ? ['Rollup', 'Collection', 'Oldest', 'Newest', 'Status', 'Recent buckets']
        : ['Rollup', 'Collection', 'Oldest', 'Newest', 'Status'];
    sections.push({
        heading: 'Summarised data (rollup collections)',
        blocks: [
            {
                kind: 'table',
                table: {
                    columns: rollupColumns,
                    rows: env.rollups.map((r) => {
                        const base = [
                            r.label,
                            r.collection,
                            fmtEpoch(r.oldest),
                            fmtEpoch(r.newest),
                            ROLLUP_STATUS_LABEL[r.status] +
                                (r.status === 'stale' && r.lagSeconds !== null
                                    ? ` (${Math.round(r.lagSeconds / 3600)} h behind)`
                                    : ''),
                        ];
                        if (hasContinuity) {
                            base.push(
                                r.bucketContinuity !== null
                                    ? `${r.bucketContinuity.present} of ${r.bucketContinuity.expected}`
                                    : '-',
                            );
                        }
                        return base;
                    }),
                    wrapColumn: 1,
                },
            },
            {
                kind: 'paragraphs',
                text: [
                    'A healthy hourly collection lags up to ~2.5 hours; a healthy daily collection lags up to ' +
                        '~48.5 hours (yesterday’s bucket is written shortly after midnight UTC). ' +
                        '"Never built" means the one-time backfill in Settings -> Dashboard Data has not been run.',
                    ...(hasContinuity
                        ? [
                              '"Recent buckets" counts distinct summary buckets present over the last ~72 hours ' +
                                  '(hourly) or ~3 days (daily). A shortfall can mean the scheduler missed runs — cross-' +
                                  'reference the platform-health section — OR simply that those hours had no events; ' +
                                  'the two are indistinguishable from here, so this is context, not a fault.',
                          ]
                        : []),
                ],
            },
        ],
    });

    sections.push({
        heading: 'Environment fingerprint',
        blocks: [{ kind: 'keyValues', items: fingerprintItems(input.meta) }],
    });
    const envFacts = (env as { ingestFacts?: IngestFacts | null }).ingestFacts || null;
    if (envFacts) sections.push(ingestFactsSection(envFacts, Math.floor(now.getTime() / 1000)));
    sections.push(cannotCheckSection(envFacts));

    const json: Record<string, unknown> = {
        schema: REPORT_SCHEMA,
        kind: 'environment',
        ingestFacts: ingestFactsJson(envFacts),
        /* SS16 — bounded summaries; rawSamples is present-as-null on every
         * scope so the banner invariant is uniformly checkable (SS16.8a-26). */
        platform: platformJson(env),
        coverage: coverageJson(env),
        rawSamples: null,
        reportId,
        generatedAtUtc: ts.utc,
        meta: input.meta,
        windowLabel: input.windowLabel,
        environment: envForJson(env),
    };
    sections.push(jsonAppendixSection(json));

    return {
        title: REPORT_TITLE,
        scopeLine: `Environment diagnosis — ${input.windowLabel}`,
        reportId,
        generatedAtLocal: ts.local,
        generatedAtUtc: ts.utc,
        banner: dataBanner(json.rawSamples != null),
        meta: input.meta,
        sections,
        json,
        filenameBase: `logserv-diagnostic-environment-${ts.fileStamp}`,
    };
};

// ---------------------------------------------------------------------------

export const slugify = (s: string): string =>
    (s || 'dashboard')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 48) || 'dashboard';
